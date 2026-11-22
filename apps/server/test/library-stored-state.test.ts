import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseLiteratureId } from "@sciretriever/contracts";
import { expect, it } from "vitest";
import { archiveStates } from "../src/storage/sqlite/archive-engine.js";
import { initializeCurrentCatalog } from "../src/storage/sqlite/catalog-layout.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { LiteratureQueryService } from "../src/literature/query.js";
import { deriveCurrentState } from "../src/literature/state.js";
import { startIntake } from "../src/literature/intake.js";
import { executeQuery } from "../src/entry/query-operations.js";
import { runCli } from "../src/cli/main.js";
import {
  fullTextId as id,
  libraryFullTextFixture,
} from "./library-fulltext-fixture.js";

it("resumes a bounded backfill, serves the current snapshot, and repairs writes made by another connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-stored-state-"));
  const path = join(root, "catalog.sqlite");
  const raw = new DatabaseSync(path);
  let worker = new SqliteWorker(path);
  try {
    initializeCurrentCatalog(raw);
    raw.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE",
    );
    const meta = raw.prepare("INSERT INTO meta_literatures VALUES(?,?)");
    const literature = raw.prepare(
      "INSERT INTO literatures VALUES(?,?,'published')",
    );
    const metadata =
      raw.prepare(`INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title)
      VALUES(?,1,?,'Historical paper')`);
    for (let n = 1; n <= 270; n++) {
      meta.run(id(n + 1000), id(n));
      literature.run(id(n), id(n + 1000));
      metadata.run(id(n), "a".repeat(64));
    }
    raw
      .prepare("INSERT INTO reading_history VALUES(?,'2026-11-22T00:00:00Z',1)")
      .run(id(267));
    raw.exec("DELETE FROM library_state_dirty; COMMIT");
    await worker.configureLibraryState(6, "vlm-engine");
    expect(await worker.refreshLibraryState()).toMatchObject({
      rebuilt: 256,
      more: true,
    });
    expect(
      raw.prepare("SELECT after_id FROM library_state_progress").get(),
    ).toEqual({ after_id: id(256) });
    let query = new LiteratureQueryService(worker);
    expect(
      await query.search({
        query: { statuses: ["UNREVIEWED"], collection_scope: "collected" },
      }),
    ).toMatchObject({
      status_updating: true,
      total_count: 1,
      items: [{ literature: { literature_id: id(267) }, collected: true }],
    });
    expect((await query.counts({})).statuses.UNREVIEWED).toBe(270);
    await worker.close();
    worker = new SqliteWorker(path);
    raw
      .prepare(
        "UPDATE literature_metadata SET title='Edited externally' WHERE literature_id=?",
      )
      .run(id(1));
    expect(await worker.refreshLibraryState()).toMatchObject({
      rebuilt: 14,
      repaired: 1,
      more: false,
    });
    expect(await worker.libraryStatePending()).toBe(false);
    query = new LiteratureQueryService(worker);
    expect(await query.counts({})).not.toHaveProperty("status_updating");
    const stored = raw
      .prepare(
        "SELECT literature_id,status,missing_step FROM library_literature_states ORDER BY literature_id",
      )
      .all();
    expect(stored).toEqual(
      [...archiveStates(raw)]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([literature_id, facts]) => ({
          literature_id,
          ...deriveCurrentState(facts),
        })),
    );

    await worker.configureLibraryState(4, "pipeline");
    expect(await query.counts({})).toMatchObject({
      status_updating: true,
      statuses: { UNREVIEWED: 270 },
    });
    while ((await worker.refreshLibraryState()).more) {
      expect(
        raw
          .prepare(
            "SELECT max(generation) generation FROM library_literature_states",
          )
          .get(),
      ).toEqual({ generation: 2 });
    }
    expect(await query.counts({})).not.toHaveProperty("status_updating");
    expect(
      raw
        .prepare("SELECT DISTINCT generation FROM library_literature_states")
        .all(),
    ).toEqual([{ generation: 2 }]);
    expect(
      raw.prepare("SELECT literature_id FROM library_collected").all(),
    ).toEqual([{ literature_id: id(267) }]);
  } finally {
    await worker.close();
    raw.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps folder and reading selections, records import and satisfied acquisition, and keeps discovery searchable", async () => {
  const f = await libraryFullTextFixture();
  try {
    const query = { query: {}, limit: 30 };
    const list = () => f.app.library.search(query, undefined, "browse");
    const listIds = async () =>
      (await list()).items.map((item) => item.literature.literature_id);
    expect(new Set(await listIds())).toEqual(new Set([1, 3, 5, 7].map(id)));
    expect(
      await f.app.library.search(
        { ...query, query: { collection_scope: "all" } },
        undefined,
        "browse",
      ),
    ).toMatchObject({ total_count: 10 });
    const search = await f.app.library.search(
      { ...query, query: { text: "Other" } },
      undefined,
      "browse",
    );
    expect(
      search.items.find((item) => item.literature.literature_id === id(6))
        ?.collected,
    ).toBe(false);

    await f.app.folders.manage({
      operation: "remove",
      request: { folder_id: f.child, literature_ids: [id(1)] },
    });
    await f.app.folders.opened({ literature_id: id(6) });
    const imported = await startIntake(
      f.app.database,
      "import",
      "Explicit import",
      {},
      "cli",
    );
    await f.app.database.writeIntake({
      operation: "member",
      member: {
        batch_id: imported,
        literature_id: id(8),
        disposition: "matched",
      },
    });
    await f.app.databaseCompletion!.run({
      selector: {
        kind: "literatures",
        literature_ids: [parseLiteratureId(id(2))],
      },
      goal: "ASSET_READY",
    });
    expect(new Set(await listIds())).toEqual(
      new Set([1, 2, 3, 5, 6, 7, 8].map(id)),
    );
    expect(await executeQuery(f.reader, "library-search", query)).toMatchObject(
      { total_count: 7 },
    );
    const readCli = (args: string[]) =>
      runCli(["literature", "search", "--json", ...args], {
        home: f.home,
        stdout: () => {},
      });
    expect(await readCli([])).toMatchObject({
      code: 0,
      value: { total_count: 7 },
    });
    expect(await readCli(["--collection-scope", "all"])).toMatchObject({
      code: 0,
      value: { total_count: 10 },
    });
    const saved = await f.app.processingTasks!.submit({
      schema_version: 1,
      idempotency_key: "collected-on-task-start",
      operations: [
        {
          operation: "parse-documents",
          request: {
            literature_id: id(12),
            asset_id: id(7000),
            asset_sha256: "a".repeat(64),
          },
        },
      ],
    });
    expect(await listIds()).not.toContain(id(12));
    await f.app.jobs!.requestStart(saved.job_id);
    expect(await listIds()).toContain(id(12));
    expect(await listIds()).not.toContain(id(10));
    await expect(
      f.app.archiveReferences.build(
        {
          literature_id: id(10),
          document_version_id: id(999),
          annotation_id: "a".repeat(64),
        },
        undefined,
        true,
      ),
    ).rejects.toMatchObject({ code: "archive-reference-default-required" });
    expect(await listIds()).toContain(id(10));
  } finally {
    await f.close();
  }
});

it("queues every owner of a shared asset and reads exact states before the bounded repair", async () => {
  const f = await libraryFullTextFixture();
  const raw = new DatabaseSync(join(f.home, "catalog.sqlite"));
  try {
    const source = raw
      .prepare(
        "SELECT * FROM literature_assets WHERE literature_id=? AND role='primary-pdf'",
      )
      .get(id(2))!;
    const meta = raw.prepare("INSERT INTO meta_literatures VALUES(?,?)");
    const literature = raw.prepare(
      "INSERT INTO literatures VALUES(?,?,'published')",
    );
    const metadata = raw.prepare(
      "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title) VALUES(?,1,?,'Shared PDF')",
    );
    const link = raw.prepare(
      "INSERT INTO literature_assets VALUES(?,?,?,'primary-pdf',?,NULL)",
    );
    raw.exec("BEGIN IMMEDIATE");
    for (let n = 20; n < 60; n++) {
      meta.run(id(n + 1000), id(n));
      literature.run(id(n), id(n + 1000));
      metadata.run(id(n), "a".repeat(64));
      link.run(id(n + 1100), id(n), source.asset_id!, source.provenance_id!);
    }
    raw.exec("COMMIT");
    while ((await f.app.database.refreshLibraryState()).more) {
      /* drain outside the writer */
    }
    expect(
      raw
        .prepare(
          "SELECT status FROM library_literature_states WHERE literature_id=?",
        )
        .get(id(59)),
    ).toEqual({ status: "ASSET_READY" });
    raw
      .prepare("UPDATE assets SET media_type=media_type WHERE asset_id=?")
      .run(source.asset_id!);
    const count = raw
      .prepare("SELECT count(*) n FROM library_state_dirty")
      .get()!.n;
    expect(count).toBeGreaterThan(32);
    raw
      .prepare(
        "UPDATE literature_assets SET role='supplementary-pdf' WHERE literature_id=?",
      )
      .run(id(59));
    expect((await f.app.database.getLiterature(id(59)))?.status).toBe(
      "UNREVIEWED",
    );
    while ((await f.app.database.refreshLibraryState()).more) {
      /* drain outside the writer */
    }
    expect(
      raw
        .prepare(
          "SELECT status,missing_step FROM library_literature_states WHERE literature_id=?",
        )
        .get(id(59)),
    ).toEqual({
      status: "UNREVIEWED",
      missing_step: "primary-pdf",
    });
  } finally {
    raw.close();
    await f.close();
  }
});
