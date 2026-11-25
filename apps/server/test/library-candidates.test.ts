import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  parseFolderNode,
  parseLiterature,
  parseMetadataObservation,
} from "@sciretriever/contracts";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApplication } from "../src/bootstrap/application.js";
import { startMaintenanceWorkbench } from "../src/bootstrap/workbench.js";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { finishIntake, startIntake } from "../src/literature/intake.js";
import { IntakeWithdrawalService } from "../src/literature/intake-withdrawal.js";
import type { RawItemSession } from "../src/metadata/ports.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { tagFixture } from "./tag-fixture.js";

type App = Awaited<ReturnType<typeof createApplication>>;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const selected = (...ids: string[]) => ({
  selector: { kind: "literatures", literature_ids: ids },
});
const paper = (n: number) =>
  parseLiterature({
    ...FIXTURE_LITERATURE,
    literature_id: id(n),
    meta_literature_id: id(100 + n),
    metadata: {
      ...FIXTURE_LITERATURE.metadata,
      title: `Candidate paper ${n}`,
      identifiers: [],
    },
  });

const doi = "10.5555/library-candidates-topic";
const observation = parseMetadataObservation({
  source_type: null,
  source_type_mapping_version: null,
  observation_id: "00000000-0000-4000-8f00-0000000c0001",
  provenance: {
    provenance_id: "00000000-0000-4000-8f00-0000000c0002",
    source_kind: "metadata-provider",
    source_name: "fixture",
    source_record_id: "candidate-1",
    observed_at: "2026-11-25T00:00:00Z",
    input_sha256: "c".repeat(64),
    parameters_sha256: null,
  },
  metadata: {
    title: "Candidate discovery fixture",
    authors: [],
    abstract: null,
    publication_date: "2026-01-01",
    publication_year: 2026,
    publication_form: "journal-article" as const,
    article_kind: null,
    language: "en",
    venue: "Fixture Journal",
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    identifiers: [{ namespace: "doi", value: doi }],
    keywords: [],
  },
  version_role: "published",
  version_links: [],
  declared_keywords: [],
  reference_texts: [],
  reference_count: null,
  cited_by_count: null,
  asset_hints: [],
});

const session = (): RawItemSession => {
  let delivered = false;
  return {
    pull_raw_item: () => {
      if (delivered) return null;
      delivered = true;
      return { raw_item: observation, source_exhausted_after: true };
    },
    convert_raw_item: () => ({ observations: [observation], relations: [] }),
  };
};

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-candidates-"));
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    metadata: {
      lookup_ports: [],
      topic_search_ports: [
        { provider_name: "fixture", open_topic_search: () => session() },
      ],
      reference_query_ports: [],
    },
  });
  const db = new DatabaseSync(join(home, "catalog.sqlite"));
  return {
    app,
    db,
    home,
    discover: () =>
      app.discovery.run({
        origin: "cli",
        query: "candidates",
        providers: [{ provider_name: "fixture", scan_limit: 5 }],
      }),
    trash: (operation: "delete" | "restore", ids: string[]) =>
      executeMaintenance(app, "library-trash", {
        operation,
        selector: { kind: "literatures", literature_ids: ids },
      }),
    trashed: (literature: string) =>
      !!db
        .prepare("SELECT 1 FROM library_trash WHERE literature_id=?")
        .get(literature),
    async close() {
      db.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function member(
  app: App,
  kind: "topic" | "import",
  literature_id: string,
  disposition: "created" | "matched",
) {
  const batch = await startIntake(app.database, kind, "Fixture", {}, "cli");
  await app.database.writeIntake({
    operation: "member",
    member: { batch_id: batch, literature_id, disposition },
  });
  await finishIntake(app.database, batch, "completed");
  return batch;
}

const drain = async (app: App) => {
  while ((await app.database.refreshLibraryState()).more) {
    /* finish the fixture backfill */
  }
};
const collectedAt = (db: DatabaseSync, literature: string) =>
  db
    .prepare(
      "SELECT collected_at FROM library_collection_times WHERE literature_id=?",
    )
    .get(literature)?.collected_at;

it("removes a paper from the library and every folder, and keeps the rest", async () => {
  const e = await tagFixture();
  const db = new DatabaseSync(join(e.home, "catalog.sqlite"));
  const uncollect = (request: unknown) =>
    executeMaintenance(e.app, "library-uncollect", request);
  try {
    const tag = await e.create("Kept topic");
    await e.assign([tag]);
    const folders: string[] = [];
    for (const name of ["First", "Second"]) {
      const folder = parseFolderNode(
        await e.app.folders.manage({
          operation: "create",
          request: { name, parent_id: null },
        }),
      ).folder_id;
      await e.app.folders.manage({
        operation: "add",
        request: { folder_id: folder, literature_ids: [e.id] },
      });
      folders.push(folder);
    }
    await executeMaintenance(e.app, "reading-open", { literature_id: e.id });
    await drain(e.app);
    const counts = await e.app.library.counts({});
    expect(counts.collection_counts?.collected).toBe(1);
    const firstTime = collectedAt(db, e.id);
    expect(firstTime).toEqual(expect.any(String));
    const kept = () =>
      db
        .prepare(
          `SELECT (SELECT count(*) FROM literature_tag_items WHERE literature_id=?) AS tags,
            (SELECT open_count FROM reading_history WHERE literature_id=?) AS opened,
            (SELECT count(*) FROM literature_assets WHERE literature_id=?) AS assets,
            (SELECT count(*) FROM document_versions WHERE literature_id=?) AS documents`,
        )
        .get(e.id, e.id, e.id, e.id);
    const before = kept();
    expect(before).toMatchObject({ tags: 1, opened: 1 });

    expect(await uncollect(selected(e.id))).toEqual({
      target_count: 1,
      removed: 1,
      folder_members_removed: 2,
    });
    expect((await e.app.library.detail(e.id)).collected).toBe(false);
    expect(kept()).toEqual(before);
    expect((await e.tags.assignment(e.id))?.items).toHaveLength(1);
    for (const folder of folders)
      expect(
        (
          await e.app.library.search({
            query: { folder: { id: folder, include_descendants: true } },
          })
        ).total_count,
      ).toBe(0);
    const listed = (
      (await e.app.folders.query({ operation: "list", request: {} })) as {
        items: unknown[];
      }
    ).items.map(parseFolderNode);
    expect(listed.map((f) => f.own_count)).toEqual([0, 0]);
    expect((await e.app.library.counts({})).collection_counts).toEqual({
      collected: 0,
      discovered_only: 1,
    });
    const found = await e.app.library.search({
      query: { collection_scope: "all" },
    });
    expect(found.items).toMatchObject([
      { literature: { literature_id: e.id }, collected: false },
    ]);
    expect(
      (await e.app.library.search({ query: {} }, undefined, "browse"))
        .total_count,
    ).toBe(0);
    // Already a candidate: nothing more to remove.
    expect(await uncollect(selected(e.id))).toEqual({
      target_count: 1,
      removed: 0,
      folder_members_removed: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      await executeMaintenance(e.app, "library-collect", selected(e.id)),
    ).toEqual({ target_count: 1, newly_collected: 1 });
    expect((await e.app.library.detail(e.id)).collected).toBe(true);
    const secondTime = collectedAt(db, e.id);
    expect(String(secondTime) > String(firstTime)).toBe(true);
    expect(
      Number(
        db
          .prepare(
            "SELECT count(*) AS n FROM folder_members WHERE literature_id=?",
          )
          .get(e.id)!.n,
      ),
    ).toBe(0);
    expect((await e.app.library.counts({})).collection_counts?.collected).toBe(
      1,
    );
  } finally {
    db.close();
    await e.close();
  }
}, 30_000);

it("takes a QuerySelector, skips deleted papers and refuses while membership is derived", async () => {
  const f = await fixture();
  const uncollect = (request: unknown) =>
    executeMaintenance(f.app, "library-uncollect", request);
  try {
    for (const n of [1, 2, 3, 4]) await f.app.database.putLiterature(paper(n));
    await drain(f.app);
    expect(
      await executeMaintenance(
        f.app,
        "library-collect",
        selected(id(1), id(2), id(3)),
      ),
    ).toMatchObject({ newly_collected: 3 });
    expect(await f.trash("delete", [id(3)])).toMatchObject({ changed: 1 });
    // Same validation as collecting: a deleted or unknown ID is not found.
    for (const invalid of [selected(id(1), id(3)), selected(id(1), id(99))])
      await expect(uncollect(invalid)).rejects.toMatchObject({
        code: "literature-not-found",
      });
    await expect(
      uncollect({ selector: { kind: "query", query: {}, limit: 1 } }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    // The query covers 1, 2 and the candidate 4; the deleted 3 is outside it.
    expect(
      await uncollect({
        selector: { kind: "query", query: { title: "Candidate paper" } },
      }),
    ).toEqual({ target_count: 3, removed: 2, folder_members_removed: 0 });
    expect((await f.app.library.counts({})).collection_counts).toEqual({
      collected: 0,
      discovered_only: 3,
    });
    // Restoring the deleted paper returns it to the side it was on.
    await f.trash("restore", [id(3)]);
    expect((await f.app.library.detail(id(3))).collected).toBe(true);

    f.db.prepare("UPDATE library_state_progress SET collection_ready=0").run();
    await expect(uncollect(selected(id(3)))).rejects.toMatchObject({
      code: "library-collection-pending",
    });
    f.db.prepare("UPDATE library_state_progress SET collection_ready=1").run();
    expect(await uncollect(selected(id(3)))).toMatchObject({ removed: 1 });
  } finally {
    await f.close();
  }
}, 30_000);

it("records opening a candidate without adding it to the library", async () => {
  const f = await fixture();
  try {
    for (const n of [1, 2]) await f.app.database.putLiterature(paper(n));
    await drain(f.app);
    await executeMaintenance(f.app, "library-collect", selected(id(2)));
    for (const n of [1, 2])
      expect(
        await executeMaintenance(f.app, "reading-open", {
          literature_id: id(n),
        }),
      ).toMatchObject({ literature_id: id(n), open_count: 1 });
    expect((await f.app.library.detail(id(1))).collected).toBe(false);
    expect(collectedAt(f.db, id(1))).toBeUndefined();
    expect((await f.app.library.counts({})).collection_counts).toEqual({
      collected: 1,
      discovered_only: 1,
    });
    const recent = await f.app.library.search(
      { query: { recently_opened: true } },
      undefined,
      "browse",
    );
    expect(
      recent.items.map((item) => [
        item.literature.literature_id,
        item.collected,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [id(1), false],
        [id(2), true],
      ]),
    );
    expect(recent.total_count).toBe(2);
    const scoped = await f.app.library.search(
      { query: { recently_opened: true, collection_scope: "collected" } },
      undefined,
      "browse",
    );
    expect(scoped.items.map((item) => item.literature.literature_id)).toEqual([
      id(2),
    ]);
    expect((await f.app.library.counts({})).recently_opened).toBe(2);
  } finally {
    await f.close();
  }
}, 30_000);

it("keeps a deleted paper deleted when discovery finds it again, and restores it on import", async () => {
  const f = await fixture();
  try {
    expect((await f.discover()).status).toBe("COMPLETED");
    const found = String(
      f.db.prepare("SELECT literature_id FROM literatures").get()!
        .literature_id,
    );
    expect(await f.trash("delete", [found])).toMatchObject({ changed: 1 });
    const again = await f.discover();
    expect(again).toMatchObject({ status: "COMPLETED", matched_count: 1 });
    expect(f.trashed(found)).toBe(true);
    expect(
      (await f.app.library.search({ query: { text: "Candidate discovery" } }))
        .total_count,
    ).toBe(0);
    expect(
      await f.app.trash.query({ operation: "count", request: {} }),
    ).toEqual({ total_count: 1 });
    // The batch still records it, so a later restore shows it there.
    expect(
      Number(
        f.db
          .prepare(
            "SELECT count(*) AS n FROM intake_batch_members m JOIN intake_batches b USING(batch_id) WHERE m.literature_id=? AND b.kind='topic'",
          )
          .get(found)!.n,
      ),
    ).toBe(2);
    const latest = await member(f.app, "topic", found, "matched");
    expect(f.trashed(found)).toBe(true);
    expect(
      Number(
        f.db
          .prepare(
            "SELECT count(*) AS n FROM topic_discovery_causes WHERE actual_literature_id=?",
          )
          .get(found)!.n,
      ),
    ).toBe(2);
    // Restored by the user, it is back as a candidate in the batches that found it.
    await f.trash("restore", [found]);
    expect(
      (
        await f.app.library.search({
          query: { intake_batch_ids: [latest] },
        })
      ).items,
    ).toMatchObject([
      { literature: { literature_id: found }, collected: false },
    ]);
    expect(
      (
        await f.app.library.search({
          query: { discovery_run_ids: [again.discovery_run_id] },
        })
      ).total_count,
    ).toBe(1);
    await f.trash("delete", [found]);

    await member(f.app, "import", found, "matched");
    expect(f.trashed(found)).toBe(false);
    expect((await f.app.library.detail(found)).collected).toBe(true);
  } finally {
    await f.close();
  }
}, 30_000);

it("still restores a withdrawn paper for discovery, unless it is also deleted", async () => {
  const f = await fixture();
  const withdrawnIds = () =>
    f.db
      .prepare(
        "SELECT object_id FROM intake_withdrawn_objects WHERE object_kind='literature' ORDER BY object_id",
      )
      .all()
      .map((row) => row.object_id);
  try {
    for (const n of [1, 2]) await f.app.database.putLiterature(paper(n));
    const batch = await startIntake(
      f.app.database,
      "topic",
      "Withdrawn",
      {},
      "cli",
    );
    for (const n of [1, 2])
      await f.app.database.writeIntake({
        operation: "member",
        member: {
          batch_id: batch,
          literature_id: id(n),
          disposition: "created",
        },
      });
    await finishIntake(f.app.database, batch, "completed");
    await drain(f.app);
    expect(await f.trash("delete", [id(2)])).toMatchObject({ changed: 1 });
    await new IntakeWithdrawalService(f.app.database).withdraw(batch);
    expect(withdrawnIds()).toEqual([id(1), id(2)]);

    await member(f.app, "topic", id(1), "matched");
    await member(f.app, "topic", id(2), "matched");
    expect(withdrawnIds()).toEqual([id(2)]);
    expect((await f.app.library.detail(id(1))).collected).toBe(false);
    expect(f.trashed(id(2))).toBe(true);
    await expect(f.app.library.detail(id(2))).rejects.toMatchObject({
      code: "literature-not-found",
    });
  } finally {
    await f.close();
  }
}, 30_000);

it("shares the removal across CLI, MCP and HTTP, with a 409 while membership is derived", async () => {
  const f = await fixture();
  const { home } = f;
  const mcp = createMcpServer({ home, maintenance: true });
  const [host, transport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "uncollect", version: "1" });
  let server: Awaited<ReturnType<typeof startMaintenanceWorkbench>> | undefined;
  async function* stdin(request: unknown) {
    yield Buffer.from(JSON.stringify(request));
  }
  const cli = (request: unknown, stderr?: string[], signal?: AbortSignal) =>
    runCli(["literature", "uncollect", "--request", "-", "--json"], {
      home,
      stdin: stdin(request),
      stderr: (line) => stderr?.push(line),
      ...(signal ? { signal } : {}),
    });
  try {
    for (const n of [1, 2, 3]) await f.app.database.putLiterature(paper(n));
    await drain(f.app);
    await executeMaintenance(
      f.app,
      "library-collect",
      selected(id(1), id(2), id(3)),
    );
    server = await startMaintenanceWorkbench({
      home,
      assets: new Map(),
      port: 0,
    });
    await mcp.connect(host);
    await client.connect(transport);
    expect(
      (await client.listTools()).tools.find(
        (tool) => tool.name === "uncollect_literatures",
      )?.annotations?.readOnlyHint,
    ).toBe(false);
    const origin = server.origin;
    const cookie = (await fetch(origin)).headers
      .getSetCookie()[0]!
      .split(";")[0]!;
    const { csrf } = (await (
      await fetch(`${origin}/api/v1/maintenance/session`, {
        headers: { Cookie: cookie },
      })
    ).json()) as { csrf: string };
    const post = (request: unknown, auth = true) =>
      fetch(`${origin}/api/v1/maintenance/library-uncollect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sciretriever-Protocol-Version": "1",
          ...(auth
            ? { Origin: origin, Cookie: cookie, "X-Sciretriever-Csrf": csrf }
            : {}),
        },
        body: JSON.stringify({ protocol_version: 1, request }),
      });
    const removed = (n: number) => ({
      target_count: 1,
      removed: n,
      folder_members_removed: 0,
    });
    expect((await post(selected(id(1)), false)).status).toBe(403);
    expect(await cli(selected(id(1)))).toEqual({
      code: 0,
      value: { protocol_version: 1, result: removed(1) },
    });
    const viaMcp = await client.callTool({
      name: "uncollect_literatures",
      arguments: selected(id(2)),
    });
    expect(viaMcp.structuredContent).toEqual({
      protocol_version: 1,
      result: removed(1),
    });
    const viaHttp = await post(selected(id(3)));
    expect(viaHttp.status).toBe(200);
    expect(await viaHttp.json()).toEqual({
      protocol_version: 1,
      result: removed(1),
    });
    const missing = await post(selected(id(99)));
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(await missing.json()).toEqual({
      protocol_version: 1,
      code: "literature-not-found",
    });
    const malformed = await post({ selector: { kind: "query" } });
    expect(malformed.status).toBe(400);
    await executeMaintenance(f.app, "library-collect", selected(id(1)));
    const cancelled: string[] = [];
    expect(
      (await cli(selected(id(1)), cancelled, AbortSignal.abort())).code,
    ).toBe(130);
    expect(JSON.parse(cancelled.join(""))).toMatchObject({
      code: "operation-cancelled",
    });
    expect((await f.app.library.detail(id(1))).collected).toBe(true);

    f.db.prepare("UPDATE library_state_progress SET collection_ready=0").run();
    const pending = await post(selected(id(1)));
    expect(pending.status).toBe(409);
    expect(await pending.json()).toEqual({
      protocol_version: 1,
      code: "library-collection-pending",
    });
    const stderr: string[] = [];
    expect((await cli(selected(id(1)), stderr)).code).not.toBe(0);
    expect(JSON.parse(stderr.join(""))).toMatchObject({
      code: "library-collection-pending",
    });
    const mcpPending = await client.callTool({
      name: "uncollect_literatures",
      arguments: selected(id(1)),
    });
    expect(mcpPending.isError).toBe(true);
    expect(mcpPending.structuredContent).toMatchObject({
      result: { failure: { code: "library-collection-pending" } },
    });
  } finally {
    await client.close();
    await mcp.close();
    await server?.close();
    await f.close();
  }
}, 30_000);
