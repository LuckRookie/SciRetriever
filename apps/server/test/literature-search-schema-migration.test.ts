import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { verifyOfflineLayout } from "../src/storage/sqlite/archive-schema-migration.js";
import { inspectCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import {
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_SCHEMA_VERSION,
} from "../src/storage/sqlite/execution-schema.js";
import { migrateLiteratureSearchSchema } from "../src/storage/sqlite/literature-search-schema-migration.js";
import {
  INTAKE_LOOKUP_INDEXES,
  SCHEMA_FINGERPRINT,
  SCHEMA_FINGERPRINT_V19,
  SCHEMA_MANIFEST,
  SCHEMA_MANIFEST_V19,
} from "../src/storage/sqlite/schema.js";

it("adds three indexes to frozen layout 19 and keeps FTS rows, search order, and maintenance intact", async () => {
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
    for (const sql of SCHEMA_MANIFEST_V19) db.exec(sql);
    db.prepare(
      "INSERT INTO schema_identity VALUES(1,'sciretriever',19,?,'2026-11-22T00:00:00Z')",
    ).run(SCHEMA_FINGERPRINT_V19);
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
      from_fingerprint: SCHEMA_FINGERPRINT_V19,
      schema_fingerprint: SCHEMA_FINGERPRINT,
    });
    const oldNames = new Set(before.map((row) => row.name));
    const after = schema();
    expect(after.filter((row) => oldNames.has(row.name))).toEqual(before);
    const added = after.filter((row) => !oldNames.has(row.name));
    expect(added.map((row) => row.type)).toEqual(["index", "index", "index"]);
    expect(added.map((row) => row.sql).sort()).toEqual(
      [...INTAKE_LOOKUP_INDEXES].sort(),
    );
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
});
