import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it, vi, type MockInstance } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseLiterature } from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { RetrievalIndexService } from "../src/retrieval/index.js";
import { RetrievalStorageClient } from "../src/storage/sqlite/retrieval-client.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { archiveFixture } from "./archive-fixture.js";
import { runCli } from "../src/cli/main.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { createMcpServer } from "../src/mcp/server.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const paper = (n: number, title: string) =>
  parseLiterature({
    ...FIXTURE_LITERATURE,
    literature_id: id(n),
    meta_literature_id: id(n + 1),
    metadata: { ...FIXTURE_LITERATURE.metadata, title },
  });
const request = (limit = 20) => ({
  query: "synthetic",
  scope: { kind: "library" },
  kinds: ["metadata"],
  versions: { kind: "default" },
  budget: { max_items: limit, max_bytes: 65536, token_limit: null },
  continuation: null,
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("serves the same verified hits after a no-op source write and advances only the watermark", async () => {
  const e = await coreProcessingFixture();
  let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    await e.app.maintenance!.rebuildIndex();
    q = await createQueryApplication(e.home);
    const before = await q.context!.search(request());
    const db = new DatabaseSync(join(e.home, "catalog.sqlite"));
    db.exec("UPDATE literature_metadata SET title=title");
    db.close();
    const stale = await q.context!.search(request());
    expect(stale).toMatchObject({
      coverage: "index-stale",
      items: before.items,
      indexed_revision: before.source_revision,
    });
    expect(stale.source_revision!).toBeGreaterThan(stale.indexed_revision!);
    const cliInput = async function* () {
      yield Buffer.from(JSON.stringify(request()));
    };
    let output = "";
    const cli = await runCli(["context", "search", "--request", "-"], {
      home: e.home,
      stdin: cliInput(),
      stdout: (text) => {
        output += text;
      },
    });
    expect(cli.code).toBe(0);
    expect(output).toContain("索引正在追赶");
    expect(cli.value).toMatchObject({
      result: {
        coverage: "index-stale",
        indexed_revision: stale.indexed_revision,
        items: stale.items,
      },
    });
    const web = await startQueryOnlyHttp({ application: q });
    try {
      const response = await fetch(`${web.origin}/api/v1/query/context`, {
        method: "POST",
        headers: {
          Origin: web.origin,
          "Content-Type": "application/json",
          "X-SciRetriever-Protocol-Version": "1",
        },
        body: JSON.stringify({ protocol_version: 1, request: request() }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: {
          coverage: "index-stale",
          indexed_revision: stale.indexed_revision,
          items: stale.items,
        },
      });
    } finally {
      await web.close();
    }
    const server = createMcpServer({ home: e.home }),
      client = new Client({ name: "stale-context", version: "1" }),
      [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const result = await client.callTool({
        name: "search_context",
        arguments: { kind: "material", request: request() },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain("index-stale");
      expect(JSON.stringify(result)).toContain("indexed_revision");
    } finally {
      await client.close();
      await server.close();
    }
    const read = vi.spyOn(e.app.library, "detail");
    const store = new RetrievalStorageClient(e.app.database),
      index = new RetrievalIndexService(
        store,
        e.app.documentRead,
        e.app.library,
        e.app.writes,
      );
    try {
      await index.refresh();
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      await index.close();
    }
    const after = await q.context!.search(request());
    expect(after.coverage).toBe(before.coverage);
    expect(after.items).toEqual(before.items);
    expect(after.indexed_revision).toBe(after.source_revision);
  } finally {
    await q?.close();
    await e.close();
  }
}, 30000);

it("skips changed metadata, fills the page from the next valid hit and invalidates stale cursors on refresh", async () => {
  const e = await coreProcessingFixture();
  let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  const store = new RetrievalStorageClient(e.app.database),
    index = new RetrievalIndexService(
      store,
      e.app.documentRead,
      e.app.library,
      e.app.writes,
    );
  try {
    await e.app.database.putLiterature(
      paper(30, "synthetic synthetic synthetic"),
    );
    await e.app.database.putLiterature(paper(40, "synthetic surviving"));
    await index.build();
    q = await createQueryApplication(e.home);
    await e.app.database.putLiterature(paper(30, "newmarker changed title"));
    const stale = await q.context!.search(request(1));
    expect(stale.coverage).toBe("index-stale");
    expect(stale.items).toHaveLength(1);
    expect(stale.items[0]!.literature_id).not.toBe(id(30));
    expect(stale.gaps).toContainEqual({
      code: "index-stale",
      literature_id: id(30),
    });
    expect(stale.continuation).not.toBeNull();
    await index.refresh();
    await expect(
      q.context!.search({ ...request(1), continuation: stale.continuation }),
    ).rejects.toMatchObject({ code: "context-cursor-invalid" });
    expect(
      (await q.context!.search({ ...request(), query: "newmarker" })).items[0]!
        .literature_id,
    ).toBe(id(30));
  } finally {
    await q?.close();
    await index.close();
    await e.close();
  }
}, 30000);

it("invalidates a cursor as soon as one paper is accepted, before the final source watermark advances", async () => {
  const e = await coreProcessingFixture(),
    entered = gate(),
    release = gate();
  let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined,
    pending: Promise<unknown> | undefined;
  const store = new RetrievalStorageClient(e.app.database),
    index = new RetrievalIndexService(
      store,
      e.app.documentRead,
      e.app.library,
      e.app.writes,
    );
  try {
    await e.app.database.putLiterature(paper(30, "synthetic first"));
    await e.app.database.putLiterature(paper(40, "synthetic second"));
    await e.app.database.putLiterature(paper(50, "synthetic unchanged"));
    await index.build();
    q = await createQueryApplication(e.home);
    await e.app.database.putLiterature(paper(30, "synthetic first changed"));
    await e.app.database.putLiterature(paper(40, "synthetic second changed"));
    const stale = await q.context!.search(request(1)),
      before = await store.active();
    expect(stale.continuation).not.toBeNull();
    const commit = store.commitLiteratureUpdate.bind(store);
    vi.spyOn(store, "commitLiteratureUpdate").mockImplementationOnce(
      async (...args) => {
        const value = await commit(...args);
        entered.resolve();
        await release.promise;
        return value;
      },
    );
    pending = index.refresh();
    await entered.promise;
    expect((await store.active())!.source_revision).toBe(
      before!.source_revision,
    );
    await expect(
      q.context!.search({ ...request(1), continuation: stale.continuation }),
    ).rejects.toMatchObject({ code: "context-cursor-invalid" });
    const interim = await q.context!.search(request(1));
    expect(interim.coverage).toBe("index-stale");
    release.resolve();
    await pending;
  } finally {
    release.resolve();
    await pending;
    await q?.close();
    await index.close();
    await e.close();
  }
}, 30000);

it("starts an owning Application with a stale existing index and catches up without a publication", async () => {
  const e = await coreProcessingFixture();
  let app: Awaited<ReturnType<typeof createApplication>> | undefined,
    q: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    await e.app.maintenance!.rebuildIndex();
    await e.app.close();
    const db = new DatabaseSync(join(e.home, "catalog.sqlite"));
    db.exec("UPDATE literature_metadata SET title=title");
    db.close();
    q = await createQueryApplication(e.home);
    expect((await q.context!.search(request())).coverage).toBe("index-stale");
    app = await createApplication(e.home, {
      metadata: {},
      browserHost: () => null,
      indexRefreshIntervalMs: 25,
    });
    await vi.waitFor(
      async () => {
        const result = await q!.context!.search(request());
        expect(result.indexed_revision).toBe(result.source_revision);
      },
      { timeout: 5000 },
    );
  } finally {
    await q?.close();
    await app?.close();
    await e.close();
  }
}, 30000);

it("bounds many skipped-source gaps while continuing to the next valid source", async () => {
  const e = await coreProcessingFixture();
  let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  try {
    for (let n = 100; n < 168; n += 2)
      await e.app.database.putLiterature(
        paper(n, "synthetic synthetic synthetic synthetic"),
      );
    await e.app.maintenance!.rebuildIndex();
    for (let n = 100; n < 168; n += 2)
      await e.app.database.putLiterature(paper(n, "changed metadata"));
    q = await createQueryApplication(e.home);
    const value = await q.context!.search(request(1));
    expect(value.coverage).toBe("index-stale");
    expect(value.items).toHaveLength(1);
    expect(value.items[0]!.literature_id).toBe(
      FIXTURE_LITERATURE.literature_id,
    );
    expect(value.gaps.length).toBeLessThanOrEqual(32);
    expect(value.gaps).toContainEqual({
      code: "index-stale",
      literature_id: null,
    });
  } finally {
    await q?.close();
    await e.close();
  }
}, 30000);

it("detects idle runtime writes automatically and returns a fully archived scope to complete", async () => {
  const e = await archiveFixture({ autoIndexRefresh: true });
  const release = gate();
  let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  let spy: MockInstance<RetrievalIndexService["refresh"]> | undefined;
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const task = await e.submit("automatic-stale-serving");
    expect(task.failures).toEqual([]);
    expect((await e.app.archive.status(e.id)).status).toBe("READY");
    await e.app.maintenance!.rebuildIndex();
    q = await createQueryApplication(e.home);
    const input = {
      ...request(),
      scope: { kind: "literatures", literature_ids: [e.id] },
    };
    const before = await q.context!.search(input);
    expect(before.coverage).toBe("complete");
    const refresh = RetrievalIndexService.prototype.refresh;
    spy = vi
      .spyOn(RetrievalIndexService.prototype, "refresh")
      .mockImplementation(async function (
        this: RetrievalIndexService,
        ...args
      ) {
        await release.promise;
        return refresh.apply(this, args);
      });
    const db = new DatabaseSync(join(e.home, "catalog.sqlite"));
    db.exec("UPDATE literature_metadata SET title=title");
    db.close();
    const started = performance.now();
    const stale = await q.context!.search(input);
    expect(stale.coverage).toBe("index-stale");
    expect(stale.items).toEqual(before.items);
    release.resolve();
    // QueryApplication reads do not schedule: only the owning runtime's monitor does.
    await vi.waitFor(
      async () =>
        expect((await q!.context!.search(input)).coverage).toBe("complete"),
      { timeout: 5000 },
    );
    expect(performance.now() - started).toBeLessThan(5000);
  } finally {
    release.resolve();
    spy?.mockRestore();
    await q?.close();
    await e.close();
  }
}, 30000);
