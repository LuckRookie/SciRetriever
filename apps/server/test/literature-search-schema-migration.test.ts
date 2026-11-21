import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { canonicalJsonBytes, sha256 } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { RetrievalIndexService } from "../src/retrieval/index.js";
import { verifyOfflineLayout } from "../src/storage/sqlite/archive-schema-migration.js";
import { inspectCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
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
  INTAKE_LOOKUP_INDEXES,
  RETRIEVAL_CHANGE_SCHEMA,
  SCHEMA_FINGERPRINT,
  SCHEMA_FINGERPRINT_V19,
  SCHEMA_FINGERPRINT_V19_INTAKE_LOOKUPS,
  SCHEMA_MANIFEST,
  SCHEMA_MANIFEST_V19,
  SCHEMA_MANIFEST_V19_INTAKE_LOOKUPS,
} from "../src/storage/sqlite/schema.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";

it.each([
  [SCHEMA_MANIFEST_V19, SCHEMA_FINGERPRINT_V19, INTAKE_LOOKUP_INDEXES],
  [
    SCHEMA_MANIFEST_V19_INTAKE_LOOKUPS,
    SCHEMA_FINGERPRINT_V19_INTAKE_LOOKUPS,
    [],
  ],
] as const)(
  "adds only the agreed search objects and preserves existing FTS rows and maintenance",
  async (manifest, previous, indexes) => {
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
      const before = schema(),
        found = match(),
        rows = db
          .prepare("SELECT rowid,* FROM literature_search_fts ORDER BY rowid")
          .all();
      expect(found).toHaveLength(2);
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
      expect(after.filter((row) => oldNames.has(row.name))).toEqual(before);
      const added = after.filter((row) => !oldNames.has(row.name));
      expect(added.map((row) => row.sql).sort()).toEqual(
        [...indexes, ...RETRIEVAL_CHANGE_SCHEMA].sort(),
      );
      expect(db.prepare("SELECT * FROM retrieval_changes").all()).toEqual([]);
      expect(
        db
          .prepare("SELECT processed_position FROM retrieval_change_state")
          .get(),
      ).toEqual({ processed_position: null });
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
      for (const sql of [...RETRIEVAL_CHANGE_SCHEMA].reverse()) {
        const [, object, name] = /^CREATE (TABLE|TRIGGER) ([a-z_]+)/u.exec(
          sql,
        )!;
        raw.exec(`DROP ${object} ${name}`);
      }
      raw
        .prepare("UPDATE schema_identity SET schema_fingerprint=?")
        .run(SCHEMA_FINGERPRINT_V19_INTAKE_LOOKUPS);
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
