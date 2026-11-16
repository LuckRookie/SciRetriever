import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  parseIndexRefreshStatus,
  parseRetrievalGenerationReceipt,
} from "@sciretriever/contracts";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import { RetrievalStorageClient } from "../src/storage/sqlite/retrieval-client.js";
import { RetrievalIndexService } from "../src/retrieval/index.js";
import { archiveFixture } from "./archive-fixture.js";
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("reads missing/ready/corrupt state through all transports and authenticates detached refresh/rebuild", async () => {
  const e = await coreProcessingFixture(),
    q = await createQueryApplication(e.home);
  let web: Awaited<ReturnType<typeof startQueryOnlyHttp>> | undefined;
  const release = gate(),
    entered = gate();
  let restore: (() => void) | undefined;
  const mcp = createMcpServer({ home: e.home }),
    client = new Client({ name: "index-state", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  const store = new RetrievalStorageClient(e.app.database);
  async function serve() {
    web = await startQueryOnlyHttp({
      application: q,
      maintenance: e.app.maintenance!,
    });
    const root = await fetch(web.origin),
      cookie = root.headers.get("set-cookie")!.split(";")[0]!;
    const session = await fetch(`${web.origin}/api/v1/maintenance/session`, {
      headers: { Cookie: cookie },
    });
    const { csrf } = (await session.json()) as { csrf: string };
    return async (
      path: string,
      request: unknown,
      extra: Record<string, string> = {},
    ) =>
      fetch(`${web!.origin}/api/v1/maintenance/${path}`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: web!.origin,
          "Content-Type": "application/json",
          "X-SciRetriever-Csrf": csrf,
          "X-SciRetriever-Protocol-Version": "1",
          ...extra,
        },
        body: JSON.stringify({ protocol_version: 1, request }),
      });
  }
  try {
    expect(await q.indexRefreshStatus!()).toMatchObject({
      index_state: "missing",
      operation: null,
      progress: null,
    });
    const cli = await runCli(["maintenance", "index-status"], {
      home: e.home,
      json: true,
    });
    expect(cli.value).toMatchObject({ result: { index_state: "missing" } });
    await mcp.connect(a);
    await client.connect(b);
    expect(
      await client.callTool({ name: "index_status", arguments: {} }),
    ).toMatchObject({
      structuredContent: { result: { index_state: "missing" } },
    });
    const post = await serve();
    expect(
      (
        await post(
          "index-refresh",
          { kind: "refresh" },
          { "X-SciRetriever-Csrf": "wrong" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await post("index-refresh", { kind: "refresh", background: true }))
        .status,
    ).toBe(400);
    expect(
      (await post("rebuild-index", { kind: "rebuild", background: "yes" }))
        .status,
    ).toBe(400);
    const original = RetrievalIndexService.prototype.refresh;
    const pending = vi
      .spyOn(RetrievalIndexService.prototype, "refresh")
      .mockImplementationOnce(async function (
        this: RetrievalIndexService,
        ...args
      ) {
        entered.resolve();
        await release.promise;
        return original.apply(this, args);
      });
    restore = () => pending.mockRestore();
    const refreshed = await post("index-refresh", { kind: "refresh" });
    expect(refreshed.status).toBe(200);
    const accepted = parseIndexRefreshStatus(
      ((await refreshed.json()) as { result: unknown }).result,
    );
    expect(["scheduled", "running"]).toContain(accepted.status);
    await entered.promise;
    await web!.close();
    web = undefined;
    release.resolve();
    await vi.waitFor(
      async () =>
        expect(await q.indexRefreshStatus!()).toMatchObject({
          status: "updated",
          index_state: "ready",
          operation: "refresh",
          progress: null,
        }),
      { timeout: 20_000 },
    );
    restore();
    restore = undefined;
    const active = (await store.active())!;
    await store.markCorrupt(active.generation_id, await store.revision());
    expect(await q.indexRefreshStatus!()).toMatchObject({
      index_state: "corrupt",
    });
    expect(
      (await runCli(["maintenance", "index-status"], { home: e.home })).value,
    ).toMatchObject({ result: { index_state: "corrupt" } });
    expect(
      await client.callTool({ name: "index_status", arguments: {} }),
    ).toMatchObject({
      structuredContent: { result: { index_state: "corrupt" } },
    });
    const postBuild = await serve(),
      readEntered = gate(),
      allowRead = gate();
    const read = RetrievalStorageClient.prototype.metadataPage;
    const hold = vi
      .spyOn(RetrievalStorageClient.prototype, "metadataPage")
      .mockImplementationOnce(async function (
        this: RetrievalStorageClient,
        ...args
      ) {
        const value = await read.apply(this, args);
        readEntered.resolve();
        await allowRead.promise;
        return value;
      });
    try {
      const rebuilt = await postBuild("rebuild-index", {
        kind: "rebuild",
        background: true,
      });
      expect(rebuilt.status).toBe(200);
      const receipt = ((await rebuilt.json()) as { result: unknown }).result;
      parseIndexRefreshStatus(receipt);
      expect(JSON.stringify(receipt)).not.toContain("rebuild_requested");
      await readEntered.promise;
      expect(await q.indexRefreshStatus!()).toMatchObject({
        status: "running",
        operation: "rebuild",
        progress: { done: 0, total: 1 },
        index_state: "corrupt",
      });
      // The transport is gone; the Application-owned build still advances.
      await web!.close();
      web = undefined;
      allowRead.resolve();
      await vi.waitFor(
        async () =>
          expect(await q.indexRefreshStatus!()).toMatchObject({
            status: "updated",
            operation: "rebuild",
            progress: { done: 1, total: 1 },
            index_state: "ready",
          }),
        { timeout: 20_000 },
      );
    } finally {
      allowRead.resolve();
      hold.mockRestore();
    }
    const synchronous = await e.app.maintenance!.rebuildIndex();
    parseRetrievalGenerationReceipt(synchronous);
    const cliRefresh = await runCli(["maintenance", "refresh-index"], {
      home: e.home,
      json: true,
    });
    expect(cliRefresh.code).toBe(0);
    expect(parseIndexRefreshStatus(cliRefresh.value)).toMatchObject({
      status: "updated",
      operation: "refresh",
      progress: null,
      index_state: "ready",
    });
    const failedRefresh = vi
      .spyOn(RetrievalIndexService.prototype, "refresh")
      .mockRejectedValueOnce(
        Object.assign(Error("synthetic"), { code: "index-source-invalid" }),
      );
    try {
      const failed = await runCli(["maintenance", "refresh-index"], {
        home: e.home,
        json: true,
      });
      expect(failed.code).toBe(3);
      expect(parseIndexRefreshStatus(failed.value)).toMatchObject({
        status: "failed",
        operation: "refresh",
        technical_details: { code: "index-source-invalid" },
      });
    } finally {
      failedRefresh.mockRestore();
    }
  } finally {
    release.resolve();
    restore?.();
    await client.close();
    await mcp.close();
    await web?.close();
    await q.close();
    await e.close();
  }
}, 30000);

it("counts metadata and fixed document versions as rebuild sources rather than text chunks", async () => {
  const e = await archiveFixture();
  try {
    const parsed = await e.app.documentProcessing.parseDocuments(
      e.rawParseRequest,
    );
    expect(parsed.draft.status).toBe("formed");
    expect((await e.submit("source-progress")).failures).toEqual([]);
    const sources = await new RetrievalStorageClient(
      e.app.database,
    ).literatureSources(e.id);
    expect(sources.metadata?.literature_id).toBe(e.id);
    expect(sources.documents).toHaveLength(2);
    const levels = [];
    for (const source of sources.documents)
      levels.push(
        (
          await e.app.documentRead.describe({
            document_version_id: source.document_version_id!,
          })
        ).text_level,
      );
    expect(levels.sort()).toEqual(["draft", "proofread"]);
    const receipt = await e.app.maintenance!.rebuildIndex();
    // One metadata source and both accepted fixed text levels, not the chunks.
    expect(receipt.source_count).toBe(3);
    expect(receipt.entry_count).toBeGreaterThan(receipt.source_count);
    expect(await e.app.indexRefreshStatus!()).toMatchObject({
      status: "updated",
      operation: "rebuild",
      progress: { done: 3, total: 3 },
    });
  } finally {
    await e.close();
  }
}, 30000);

it("exposes refresh_index and optional background rebuild in the maintenance MCP session", async () => {
  const e = await coreProcessingFixture(),
    q = await createQueryApplication(e.home);
  const server = createMcpServer({ home: e.home, maintenance: true }),
    client = new Client({ name: "background-index", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await e.app.maintenance!.rebuildIndex();
    await server.connect(a);
    await client.connect(b);
    const result = await client.callTool({
      name: "refresh_index",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    parseIndexRefreshStatus(
      (result.structuredContent as { result: unknown }).result,
    );
    await vi.waitFor(
      async () =>
        expect(await q.indexRefreshStatus!()).toMatchObject({
          status: "updated",
          operation: "refresh",
        }),
      { timeout: 20_000 },
    );
    const built = await client.callTool({
      name: "rebuild_index",
      arguments: { background: true },
    });
    expect(built.isError).not.toBe(true);
    parseIndexRefreshStatus(
      (built.structuredContent as { result: unknown }).result,
    );
    await vi.waitFor(
      async () =>
        expect(await q.indexRefreshStatus!()).toMatchObject({
          status: "updated",
          operation: "rebuild",
          progress: { done: 1, total: 1 },
        }),
      { timeout: 20_000 },
    );
  } finally {
    await client.close();
    await server.close();
    await q.close();
    await e.close();
  }
}, 30000);
