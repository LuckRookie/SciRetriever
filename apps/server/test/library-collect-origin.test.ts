import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type LibrarySearchPage,
  parseLiterature,
  parseLiteratureSearchItem,
} from "@sciretriever/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createApplication } from "../src/bootstrap/application.js";
import {
  startMaintenanceWorkbench,
  startQueryOnlyWorkbench,
} from "../src/bootstrap/workbench.js";
import { runCli } from "../src/cli/main.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { finishIntake, startIntake } from "../src/literature/intake.js";
import { IntakeWithdrawalService } from "../src/literature/intake-withdrawal.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { DiscoveryPublication } from "../src/storage/sqlite/worker.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const day = (n: number) => `2026-01-${String(n).padStart(2, "0")}T00:00:00Z`;
const selected = (...rows: number[]) => ({
  selector: { kind: "literatures", literature_ids: rows.map(id) },
});
const result = (target_count: number, newly_collected: number) => ({
  target_count,
  newly_collected,
});
type App = Awaited<ReturnType<typeof createApplication>>;
const paper = (n: number, meta = id(100 + n), preprint = false) =>
  parseLiterature({
    ...FIXTURE_LITERATURE,
    literature_id: id(n),
    meta_literature_id: meta,
    version_role: preprint ? "preprint" : "published",
    metadata: {
      ...FIXTURE_LITERATURE.metadata,
      title: `Collectable version ${n}`,
      identifiers: [],
    },
  });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-collect-origin-"));
  try {
    const app = await createApplication(home, {
      indexRefreshIntervalMs: null,
      metadata: {
        lookup_ports: [],
        topic_search_ports: [],
        reference_query_ports: [],
      },
    });
    return {
      app,
      home,
      path: join(home, "catalog.sqlite"),
      async close() {
        try {
          await app.close();
        } finally {
          await rm(home, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

async function discoveryFixture(
  app: App,
  run: DiscoveryPublication["run"],
  actual = paper(1),
) {
  const { literature_id, meta_literature_id } = actual;
  const batch = await startIntake(
    app.database,
    run.kind,
    "Discovery fixture",
    {},
    "cli",
  );
  await app.database.putDiscovery({
    run,
    providers: [],
    source_results: [],
    results: [{ meta_literature_id }],
    topic_causes:
      run.kind === "topic"
        ? [
            {
              meta_literature_id,
              metadata_observation_id: id(200),
              actual_literature_id: literature_id,
            },
          ]
        : [],
    citation_causes:
      run.kind === "citation"
        ? [
            {
              meta_literature_id,
              source_literature_id: id(3),
              target_literature_id: literature_id,
              actual_literature_id: literature_id,
              depth: 1,
            },
          ]
        : [],
  });
  await app.database.writeIntake({
    operation: "member",
    member: { batch_id: batch, literature_id, disposition: "matched" },
  });
  await finishIntake(app.database, batch, "completed", run.discovery_run_id);
  return { kind: run.kind, intake_batch_id: batch };
}

it("collects concrete versions transactionally and preserves their first selection time", async () => {
  const f = await fixture();
  const { app } = f;
  const collect = (request: unknown, signal?: AbortSignal) =>
    executeMaintenance(app, "library-collect", request, signal);
  try {
    for (const n of [1, 2, 3, 4]) await app.database.putLiterature(paper(n));
    const withdrawn = await startIntake(
      app.database,
      "topic",
      "Withdrawn",
      {},
      "cli",
    );
    await app.database.writeIntake({
      operation: "member",
      member: {
        batch_id: withdrawn,
        literature_id: id(4),
        disposition: "created",
      },
    });
    await finishIntake(app.database, withdrawn, "completed");
    await new IntakeWithdrawalService(app.database).withdraw(withdrawn);
    while ((await app.database.refreshLibraryState()).more) {
      /* drain the fixture backfill */
    }

    expect(await app.library.counts({})).toMatchObject({
      collection_counts: { collected: 0, discovered_only: 3 },
    });
    expect(await collect(selected(1))).toEqual(result(1, 1));
    const browse = () => app.library.search({ query: {} }, undefined, "browse");
    const first = await browse();
    expect(first.items).toMatchObject([
      {
        literature: { literature_id: id(1) },
        collected: true,
        collected_at: expect.any(String),
      },
    ]);
    expect(await app.library.counts({})).toMatchObject({
      collection_counts: { collected: 1, discovered_only: 2 },
    });
    for (const invalid of [selected(2, 99), selected(2, 4)])
      await expect(collect(invalid)).rejects.toMatchObject({
        code: "literature-not-found",
      });
    await expect(
      collect(selected(2), AbortSignal.abort()),
    ).rejects.toMatchObject({
      code: "operation-cancelled",
    });
    expect(await browse()).toEqual(first);
    expect(await collect(selected(1, 2, 2, 3))).toEqual(result(3, 2));
    const listed = await browse();
    expect(listed.items).toHaveLength(3);
    expect(
      listed.items.find((item) => item.literature.literature_id === id(1)),
    ).toEqual(first.items[0]);
    expect(await collect(selected(1, 2, 3))).toEqual(result(3, 0));
    const counts = await app.library.counts({});
    expect(counts.collection_counts).toEqual({
      collected: 3,
      discovered_only: 0,
    });
    expect(counts).not.toHaveProperty("counts_backfill_pending");
  } finally {
    await f.close();
  }
});

it("uses the complete QuerySelector scope beyond the relevance limit and ignores the browse default", async () => {
  const f = await fixture();
  try {
    await f.app.writes.run(async () => {
      using db = new DatabaseSync(f.path, {
        enableForeignKeyConstraints: true,
      });
      db.exec("BEGIN IMMEDIATE");
      const meta = db.prepare(
        "INSERT INTO meta_literatures(meta_literature_id,representative_literature_id) VALUES(?,?)",
      );
      const version = db.prepare(
        "INSERT INTO literatures(literature_id,meta_literature_id,version_role) VALUES(?,?,'published')",
      );
      const metadata = db.prepare(
        "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title,publication_year) VALUES(?,1,?,'Selectable sample',?)",
      );
      const fts = db.prepare(
        "INSERT INTO literature_search_fts(literature_id,title) VALUES(?,'selectable sample')",
      );
      for (let n = 1; n <= 1002; n++) {
        const key = id(n);
        meta.run(key, key);
        version.run(key, key);
        metadata.run(key, "a".repeat(64), n === 1002 ? 2026 : 2025);
        fts.run(key);
      }
      db.exec("COMMIT");
    });
    const query = { text: "selectable", publication_year_to: 2025 };
    expect(
      await f.app.library.search({ query, sort: "relevance", limit: 1 }),
    ).toMatchObject({
      total_count: 1001,
      relevance_limit: 1000,
    });
    const collect = (query: unknown) =>
      executeMaintenance(f.app, "library-collect", {
        selector: { kind: "query", query },
      });
    expect(await collect(query)).toEqual(result(1001, 1001));
    expect(await collect({ collection_scope: "collected" })).toEqual(
      result(1001, 0),
    );
    expect(await collect({ publication_year_from: 2026 })).toEqual(
      result(1, 1),
    );
    expect(await collect({ text: "!!!" })).toEqual(result(0, 0));
  } finally {
    await f.close();
  }
}, 30_000);

it("returns the newest evidenced batch for the specific version, ordered by creation time then batch ID", async () => {
  const f = await fixture();
  try {
    const { app } = f;
    const version = paper(1);
    for (const row of [
      version,
      paper(2, version.meta_literature_id, true),
      paper(3),
    ])
      await app.database.putLiterature(row);
    await app.observations.publish({
      observation_id: id(200),
      literature_id: version.literature_id,
      source_type: null,
      source_type_mapping_version: null,
      provenance: {
        provenance_id: id(201),
        source_kind: "metadata-provider",
        source_name: "fixture",
        source_record_id: "collect-origin",
        observed_at: day(1),
        input_sha256: "a".repeat(64),
        parameters_sha256: null,
      },
      metadata: version.metadata,
      version_role: version.version_role,
      reference_count: null,
      cited_by_count: null,
      declared_keywords: [],
      reference_texts: [],
    });
    const topic = await discoveryFixture(app, {
      discovery_run_id: id(301),
      kind: "topic",
      status: "COMPLETED",
      started_at: day(5),
      query: "Collectable",
    });
    const citation = await discoveryFixture(app, {
      discovery_run_id: id(302),
      kind: "citation",
      status: "COMPLETED",
      started_at: day(1),
      direction: "references",
      max_depth: 1,
      result_limit: 1,
      seed_literature_ids: [id(3)],
    });
    const retime = (topicDay: number) =>
      app.writes.run(async () => {
        using db = new DatabaseSync(f.path);
        const update = db.prepare(
          "UPDATE intake_batches SET created_at=?,finished_at=? WHERE batch_id=?",
        );
        update.run(day(topicDay), day(10), topic.intake_batch_id);
        update.run(day(4), day(7), citation.intake_batch_id);
      });
    const read = async () =>
      (
        await app.library.search({
          query: { collection_scope: "all" },
          sort: "title-asc",
          limit: 3,
        })
      ).items.map(parseLiteratureSearchItem);
    await retime(2);
    const [actual, sibling, unrelated] = await read();
    expect(actual).toMatchObject({
      literature: { literature_id: id(1) },
      collected: false,
      discovery_origin: citation,
    });
    expect(sibling).toMatchObject({
      literature: { literature_id: id(2) },
      collected: false,
      discovery_origin: null,
    });
    expect(unrelated).toMatchObject({
      literature: { literature_id: id(3) },
      collected: false,
      discovery_origin: null,
    });
    await retime(4);
    expect((await read())[0]?.discovery_origin).toEqual(
      topic.intake_batch_id > citation.intake_batch_id ? topic : citation,
    );
    await retime(6);
    expect((await read())[0]?.discovery_origin).toEqual(topic);
    await executeMaintenance(app, "library-collect", selected(1));
    const [collected] = await read();
    expect(collected?.collected).toBe(true);
    expect(collected).not.toHaveProperty("discovery_origin");
    expect(() =>
      parseLiteratureSearchItem({ ...collected, discovery_origin: null }),
    ).toThrow();
    expect(() =>
      parseLiteratureSearchItem({
        ...sibling,
        discovery_origin: { ...citation, kind: "import" },
      }),
    ).toThrow();
  } finally {
    await f.close();
  }
});

it("shares collection results, business errors and search fields across CLI, MCP and HTTP", async () => {
  const f = await fixture();
  const mcp = createMcpServer({ home: f.home, maintenance: true });
  const [host, transport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "collect-origin", version: "1" });
  let server: Awaited<ReturnType<typeof startMaintenanceWorkbench>> | undefined;
  let reader: Awaited<ReturnType<typeof startQueryOnlyWorkbench>> | undefined;
  async function* stdin(request: unknown) {
    yield Buffer.from(JSON.stringify(request));
  }
  const cli = (
    operation: "collect" | "search",
    request: unknown,
    stderr?: string[],
    signal?: AbortSignal,
  ) =>
    runCli(["literature", operation, "--request", "-", "--json"], {
      home: f.home,
      stdin: stdin(request),
      stderr: (line) => stderr?.push(line),
      ...(signal ? { signal } : {}),
    });
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  try {
    for (const n of [1, 2, 3, 4]) await f.app.database.putLiterature(paper(n));
    const citation = await discoveryFixture(f.app, {
      discovery_run_id: id(302),
      kind: "citation",
      status: "COMPLETED",
      started_at: day(1),
      direction: "references",
      max_depth: 1,
      result_limit: 1,
      seed_literature_ids: [id(3)],
    });
    server = await startMaintenanceWorkbench({
      home: f.home,
      assets: new Map(),
      port: 0,
    });
    reader = await startQueryOnlyWorkbench({
      home: f.home,
      assets: new Map(),
      port: 0,
    });
    await mcp.connect(host);
    await client.connect(transport);
    expect(
      (await client.listTools()).tools.find(
        (tool) => tool.name === "collect_literatures",
      )?.annotations?.readOnlyHint,
    ).toBe(false);

    const origin = server.origin;
    const root = await fetch(origin);
    const cookie = root.headers.getSetCookie()[0]!.split(";")[0]!;
    const { csrf } = (await (
      await fetch(`${origin}/api/v1/maintenance/session`, {
        headers: { Cookie: cookie },
      })
    ).json()) as { csrf: string };
    const headers = {
      "Content-Type": "application/json",
      "X-Sciretriever-Protocol-Version": "1",
    };
    const authorized = {
      ...headers,
      Origin: origin,
      Cookie: cookie,
      "X-Sciretriever-Csrf": csrf,
    };
    const post = (
      path: string,
      request: unknown,
      auth = false,
      base = origin,
    ) =>
      fetch(`${base}/api/v1/${path}`, {
        method: "POST",
        headers: auth ? authorized : headers,
        body: JSON.stringify({ protocol_version: 1, request }),
      });
    const collect = "maintenance/library-collect";
    expect(
      (await post(collect, selected(1), false, reader.origin)).status,
    ).toBe(404);
    expect((await post(collect, selected(1))).status).toBe(403);
    const search = {
      query: { collection_scope: "all" },
      limit: 4,
      sort: "title-asc",
    };
    const checkSearch = async () => {
      const cliPage = await cli("search", search);
      expect(cliPage.code).toBe(0);
      const page = (cliPage.value as { result: LibrarySearchPage }).result;
      const mcpPage = await call("search_library", search);
      expect(mcpPage.isError).not.toBe(true);
      expect(mcpPage.structuredContent).toEqual({
        protocol_version: 1,
        result: page,
      });
      const httpPage = await post("query/search", search);
      expect(httpPage.status).toBe(200);
      expect(await httpPage.json()).toEqual({ protocol_version: 1, page });
      return page.items;
    };
    const initial = await checkSearch();
    expect(initial[0]).toMatchObject({
      collected: false,
      discovery_origin: citation,
    });
    expect(initial[1]).toMatchObject({
      collected: false,
      discovery_origin: null,
    });

    expect(await cli("collect", selected(1))).toEqual({
      code: 0,
      value: { protocol_version: 1, result: result(1, 1) },
    });
    const mcpWrite = await call("collect_literatures", selected(1, 2));
    expect(mcpWrite.isError).not.toBe(true);
    expect(mcpWrite.structuredContent).toEqual({
      protocol_version: 1,
      result: result(2, 1),
    });
    const httpWrite = await post(
      collect,
      {
        selector: { kind: "query", query: { title: "version 3" } },
      },
      true,
    );
    expect(httpWrite.status).toBe(200);
    expect(await httpWrite.json()).toEqual({
      protocol_version: 1,
      result: result(1, 1),
    });
    const items = await checkSearch();
    expect(items).toHaveLength(4);
    for (const item of items.slice(0, 3)) {
      expect(item.collected).toBe(true);
      expect(item).not.toHaveProperty("discovery_origin");
    }
    expect(items[3]).toMatchObject({
      collected: false,
      discovery_origin: null,
    });
    for (const [request, code] of [
      [selected(4, 99), "literature-not-found"],
      [{ selector: { kind: "query", query: {}, limit: 1 } }, "invalid-request"],
    ] as const) {
      const stderr: string[] = [];
      expect((await cli("collect", request, stderr)).code).not.toBe(0);
      expect(JSON.parse(stderr.join(""))).toMatchObject({ code });
      const mcpFailure = await call("collect_literatures", request);
      expect(mcpFailure.isError).toBe(true);
      expect(mcpFailure.structuredContent).toMatchObject({
        protocol_version: 1,
        result: { failure: { code } },
      });
      const failure = await post(collect, request, true);
      expect(failure.status).toBeGreaterThanOrEqual(400);
      expect(await failure.json()).toEqual({ protocol_version: 1, code });
    }
    const malformed = await fetch(`${origin}/api/v1/${collect}`, {
      method: "POST",
      headers: authorized,
      body: '{"request":',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      protocol_version: 1,
      code: "invalid-request",
    });
    const stderr: string[] = [];
    expect(
      (await cli("collect", selected(4), stderr, AbortSignal.abort())).code,
    ).toBe(130);
    expect(JSON.parse(stderr.join(""))).toMatchObject({
      code: "operation-cancelled",
    });
    expect((await f.app.library.counts({})).collection_counts).toEqual({
      collected: 3,
      discovered_only: 1,
    });
  } finally {
    await client.close();
    await mcp.close();
    await reader?.close();
    await server?.close();
    await f.close();
  }
}, 30_000);
