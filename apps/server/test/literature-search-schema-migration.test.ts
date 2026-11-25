import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { canonicalJsonBytes, sha256 } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { runCli } from "../src/cli/main.js";
import { RetrievalIndexService } from "../src/retrieval/index.js";
import { verifyOfflineLayout } from "../src/storage/sqlite/archive-schema-migration.js";
import { inspectCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import {
  manifestObject,
  nameCatalogInsertColumns,
  objectKey,
} from "../src/storage/sqlite/catalog-ddl.js";
import {
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_SCHEMA_VERSION,
} from "../src/storage/sqlite/execution-schema.js";
import {
  migrateLiteratureSearchSchema,
  reconcileLiteratureSearchSchema,
} from "../src/storage/sqlite/literature-search-schema-migration.js";
import { RetrievalStorageClient } from "../src/storage/sqlite/retrieval-client.js";
import {
  ARCHIVE_ISSUES_ADDITION,
  LIBRARY_SCALE_ADDITION,
  SCHEMA_FINGERPRINT,
  SCHEMA_FINGERPRINT_V19,
  SCHEMA_FINGERPRINT_V19_COUNTS,
  SCHEMA_FINGERPRINT_V19_COMBINED,
  SCHEMA_FINGERPRINT_V19_INTAKE_LOOKUPS,
  SCHEMA_FINGERPRINT_V19_RETRIEVAL_CHANGES,
  SCHEMA_FINGERPRINT_V19_STORED_STATES,
  SCHEMA_MANIFEST,
  SCHEMA_MANIFEST_V19,
  SCHEMA_MANIFEST_V19_COUNTS,
  SCHEMA_MANIFEST_V19_COMBINED,
  SCHEMA_MANIFEST_V19_INTAKE_LOOKUPS,
  SCHEMA_MANIFEST_V19_RETRIEVAL_CHANGES,
  SCHEMA_MANIFEST_V19_STORED_STATES,
} from "../src/storage/sqlite/schema.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";

function restoreLegacyLayout(
  db: DatabaseSync,
  manifest: readonly string[],
  fingerprint: string,
) {
  const legacy = new Map(
    manifest.map((sql) => [objectKey(manifestObject(sql)), sql]),
  );
  for (const sql of [...SCHEMA_MANIFEST].reverse()) {
    const object = manifestObject(sql);
    const expected = legacy.get(objectKey(object));
    if (expected === sql) continue;
    db.exec(`DROP ${object.type} ${object.name}`);
    if (expected) db.exec(expected);
  }
  db.prepare("UPDATE schema_identity SET schema_fingerprint=?").run(
    fingerprint,
  );
}

it.each([
  [SCHEMA_MANIFEST_V19, SCHEMA_FINGERPRINT_V19],
  [SCHEMA_MANIFEST_V19_INTAKE_LOOKUPS, SCHEMA_FINGERPRINT_V19_INTAKE_LOOKUPS],
  [
    SCHEMA_MANIFEST_V19_RETRIEVAL_CHANGES,
    SCHEMA_FINGERPRINT_V19_RETRIEVAL_CHANGES,
  ],
  [SCHEMA_MANIFEST_V19_STORED_STATES, SCHEMA_FINGERPRINT_V19_STORED_STATES],
  [SCHEMA_MANIFEST_V19_COUNTS, SCHEMA_FINGERPRINT_V19_COUNTS],
] as const)(
  "installs the agreed search objects and archive view while preserving FTS rows and maintenance",
  async (manifest, previous) => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-fts-migration-"));
    const path = join(home, "catalog.sqlite");
    const db = new DatabaseSync(path);
    const schema = () =>
      db
        .prepare(
          "SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
        )
        .all();
    const match = () =>
      db
        .prepare(
          "SELECT rowid,literature_id,title,bm25(literature_search_fts) AS score FROM literature_search_fts WHERE literature_search_fts MATCH 'same' ORDER BY score,rowid",
        )
        .all();
    const archivePlan = () =>
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM archive_current_parts WHERE literature_id=?",
        )
        .all("a")
        .map((row) => row.detail)
        .join("\n");
    try {
      for (const sql of manifest) db.exec(sql);
      db.prepare(
        "INSERT INTO schema_identity VALUES(1,'sciretriever',19,?,'2026-11-22T00:00:00Z')",
      ).run(previous);
      db.prepare("INSERT INTO execution_schema_identity VALUES(1,?,?)").run(
        EXECUTION_SCHEMA_VERSION,
        EXECUTION_SCHEMA_FINGERPRINT,
      );
      db.prepare(
        "INSERT INTO execution_runtime_schema_identity VALUES(1,?,?)",
      ).run(
        EXECUTION_RUNTIME_SCHEMA_VERSION,
        EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
      );
      db.exec(`
      INSERT INTO retrieval_source_revision VALUES(1,0);
      INSERT INTO vocabulary_state VALUES(1,0,0);
      INSERT INTO literature_search_fts(literature_id,title) VALUES
        ('a','same word'),('b','same word with same again'),('c','other phrase');
    `);
      const hasPosition =
        previous === SCHEMA_FINGERPRINT_V19_RETRIEVAL_CHANGES ||
        previous === SCHEMA_FINGERPRINT_V19_STORED_STATES ||
        previous === SCHEMA_FINGERPRINT_V19_COUNTS;
      if (hasPosition)
        db.exec("INSERT INTO retrieval_change_state VALUES(1,42)");
      const before = schema(),
        found = match(),
        rows = db
          .prepare("SELECT rowid,* FROM literature_search_fts ORDER BY rowid")
          .all();
      expect(found).toHaveLength(2);
      expect(archivePlan()).toContain("SCAN dd");
      await expect(inspectCatalogSchema(path)).rejects.toMatchObject({
        reason: "catalog-layout-not-current",
      });
      expect(schema()).toEqual(before);
      await expect(migrateLiteratureSearchSchema(path)).resolves.toMatchObject({
        from_version: 19,
        to_version: 19,
        from_fingerprint: previous,
        schema_fingerprint: SCHEMA_FINGERPRINT,
      });
      const oldNames = new Set(before.map((row) => row.name));
      const after = schema();
      expect(after.filter((row) => oldNames.has(row.name))).toEqual(
        before.map((row) => {
          if (row.type === "trigger")
            return { ...row, sql: nameCatalogInsertColumns(String(row.sql)) };
          if (row.name === "archive_current_parts")
            return {
              ...row,
              sql: SCHEMA_MANIFEST.find((sql) =>
                sql.startsWith("CREATE VIEW archive_current_parts "),
              ),
            };
          return row;
        }),
      );
      expect(archivePlan()).toContain("archive_document_material_lookup");
      expect(archivePlan()).not.toContain("SCAN dd");
      const added = after.filter((row) => !oldNames.has(row.name));
      expect(added.map((row) => row.sql).sort()).toEqual(
        SCHEMA_MANIFEST.filter(
          (sql) => !oldNames.has(manifestObject(sql).name),
        ).sort(),
      );
      expect(db.prepare("SELECT * FROM library_state_progress").all()).toEqual(
        [],
      );
      expect(
        db.prepare("SELECT * FROM library_literature_states").all(),
      ).toEqual([]);
      expect(db.prepare("SELECT * FROM retrieval_changes").all()).toEqual([]);
      expect(db.prepare("SELECT * FROM library_count_progress").all()).toEqual(
        [],
      );
      expect(
        db.prepare("SELECT * FROM library_count_contributions").all(),
      ).toEqual([]);
      expect(db.prepare("SELECT * FROM library_paging_progress").all()).toEqual(
        [],
      );
      expect(
        db
          .prepare("SELECT processed_position FROM retrieval_change_state")
          .get(),
      ).toEqual({
        processed_position: hasPosition ? 42 : null,
      });
      expect(
        db
          .prepare("SELECT rowid,* FROM literature_search_fts ORDER BY rowid")
          .all(),
      ).toEqual(rows);
      expect(match()).toEqual(found);
      const maintenance = db.prepare(
        "INSERT INTO literature_search_fts(literature_search_fts) VALUES(?)",
      );
      for (const command of ["rebuild", "optimize", "integrity-check"])
        maintenance.run(command);
      const lookup =
        "SELECT id FROM literature_search_fts_content WHERE c0=? ORDER BY id";
      expect(db.prepare(lookup).all("a")).toEqual([{ id: 1 }]);
      expect(
        db
          .prepare(`EXPLAIN QUERY PLAN ${lookup}`)
          .all("a")
          .map((row) => row.detail),
      ).toEqual([
        "SEARCH literature_search_fts_content USING COVERING INDEX literature_search_fts_content_owner (c0=?)",
      ]);
      expect(db.prepare("PRAGMA integrity_check").all()).toEqual([
        { integrity_check: "ok" },
      ]);
      expect(match()).toEqual(found);
      verifyOfflineLayout(db, SCHEMA_MANIFEST);
      await expect(inspectCatalogSchema(path)).resolves.toMatchObject({
        status: "ready",
        schema_fingerprint: SCHEMA_FINGERPRINT,
        additions: [
          {
            name: ARCHIVE_ISSUES_ADDITION.name,
            ddl_fingerprint: ARCHIVE_ISSUES_ADDITION.ddl_fingerprint,
            backfill_step: 0,
            backfill_cursor: null,
          },
          {
            name: LIBRARY_SCALE_ADDITION.name,
            ddl_fingerprint: LIBRARY_SCALE_ADDITION.ddl_fingerprint,
            backfill_step: 0,
            backfill_cursor: null,
          },
        ],
      });
      await expect(migrateLiteratureSearchSchema(path)).rejects.toMatchObject({
        code: "literature-search-schema-migration-refused",
      });
      expect(schema()).toEqual(after);
    } finally {
      db.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

it("registers a completed legacy combined catalog through schema-apply without replaying its backfill", async () => {
  const f = await coreProcessingFixture({ offline: true });
  try {
    const id = FIXTURE_LITERATURE.literature_id;
    await f.app.folders.opened({ literature_id: id });
    while ((await f.app.database.refreshLibraryState()).more) {
      /* finish all projections */
    }
    await f.app.close();
    const path = join(f.home, "catalog.sqlite");
    const db = new DatabaseSync(path);
    try {
      restoreLegacyLayout(
        db,
        SCHEMA_MANIFEST_V19_COMBINED,
        SCHEMA_FINGERPRINT_V19_COMBINED,
      );
      const snapshot = () =>
        Object.fromEntries(
          [
            "literature_metadata",
            "library_collected",
            "library_collection_times",
            "library_literature_states",
            "library_count_totals",
            "library_ordered_members",
            "library_state_progress",
            "library_count_progress",
            "library_paging_progress",
            "retrieval_change_state",
            "retrieval_changes",
          ].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
        );
      const before = snapshot();
      expect(before.library_collected).toEqual([
        { literature_id: id, intake_at: null },
      ]);
      const migrated = await runCli(
        [
          "storage",
          "schema-apply",
          "--catalog",
          path,
          "--addition",
          LIBRARY_SCALE_ADDITION.name,
        ],
        {
          home: f.home,
          stdout: () => {},
          stderr: () => {},
        },
      );
      expect(migrated).toMatchObject({
        code: 0,
        value: {
          from_fingerprint: SCHEMA_FINGERPRINT_V19_COMBINED,
          schema_fingerprint: SCHEMA_FINGERPRINT,
        },
      });
      expect(snapshot()).toEqual(before);
      await expect(inspectCatalogSchema(path)).resolves.toMatchObject({
        additions: [
          { name: ARCHIVE_ISSUES_ADDITION.name, backfill_step: 0 },
          {
            name: LIBRARY_SCALE_ADDITION.name,
            backfill_step: LIBRARY_SCALE_ADDITION.backfill_steps.length,
            backfill_cursor: null,
          },
        ],
      });
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

it("reconciles unlogged legacy writes explicitly and retains post-migration SQL writes", async () => {
  const f = await coreProcessingFixture();
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  let index: RetrievalIndexService | undefined;
  const path = join(f.home, "catalog.sqlite");
  const id = FIXTURE_LITERATURE.literature_id;
  try {
    await f.app.maintenance!.rebuildIndex();
    await f.app.close();
    const raw = new DatabaseSync(path);
    try {
      restoreLegacyLayout(
        raw,
        SCHEMA_MANIFEST_V19_INTAKE_LOOKUPS,
        SCHEMA_FINGERPRINT_V19_INTAKE_LOOKUPS,
      );
      const oldEdit = {
        ...FIXTURE_LITERATURE.metadata,
        title: "Legacy offline edit",
      };
      raw
        .prepare(
          "UPDATE literature_metadata SET title=?,metadata_sha256=?,metadata_revision=metadata_revision+1 WHERE literature_id=?",
        )
        .run(oldEdit.title, await sha256(canonicalJsonBytes(oldEdit)), id);
    } finally {
      raw.close();
    }

    await migrateLiteratureSearchSchema(path);
    app = await createApplication(f.home, {
      indexRefreshIntervalMs: null,
      metadata: {},
    });
    const store = new RetrievalStorageClient(app.database);
    index = new RetrievalIndexService(
      store,
      app.documentRead,
      app.library,
      app.writes,
    );
    await expect(index.refresh()).rejects.toMatchObject({
      code: "index-reconcile-required",
    });
    const sqlWriter = new DatabaseSync(path);
    try {
      // This committed journal row must survive reconciliation's legacy scan.
      sqlWriter
        .prepare(
          "UPDATE literatures SET version_role=version_role WHERE literature_id=?",
        )
        .run(id);
      expect(
        sqlWriter.prepare("SELECT literature_id FROM retrieval_changes").all(),
      ).toEqual([{ literature_id: id }]);
    } finally {
      sqlWriter.close();
    }
    // Let unrelated background catalog maintenance release admission before
    // invoking the explicit migration step, which uses nonblocking admission.
    await vi.waitFor(
      async () => expect(await app!.database.libraryStatePending()).toBe(false),
      { timeout: 20_000 },
    );
    await expect(reconcileLiteratureSearchSchema(path)).resolves.toMatchObject({
      reconciled: true,
      differences: 1,
    });
    await expect(reconcileLiteratureSearchSchema(path)).resolves.toMatchObject({
      reconciled: false,
      differences: 0,
    });
    const settled = await index.refresh();
    expect(settled.source_revision).toBe(await store.revision());
    expect(
      (await store.verificationEntries(settled.generation_id, id))[0]!.title,
    ).toBe("legacy offline edit");
    expect((await store.changesSnapshot()).pending).toBe(0);
    await expect(index.verify()).resolves.toMatchObject({ status: "verified" });
  } finally {
    await index?.close();
    await app?.close();
    await f.close();
  }
}, 30_000);
