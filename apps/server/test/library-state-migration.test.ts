import { migrateCitationLimitsSchema } from "../src/storage/sqlite/citation-limits-schema-migration.js";
import { migrateImportSchema } from "../src/storage/sqlite/import-schema-migration.js";
import { migrateDraftTextSchema } from "../src/storage/sqlite/draft-text-schema-migration.js";
import { migrateUserOrganizationSchema } from "../src/storage/sqlite/user-organization-schema-migration.js";
import { migrateIntakeSchema } from "../src/storage/sqlite/intake-schema-migration.js";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  libraryStatePreviousManifest,
  LIBRARY_STATE_PREVIOUS_FINGERPRINT,
} from "../src/storage/sqlite/library-state-previous-layout.js";
import { migrateLibraryStateSchema } from "../src/storage/sqlite/library-state-schema-migration.js";
import { migrateReadingMarksSchema } from "../src/storage/sqlite/reading-marks-schema-migration.js";
import { inspectCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import { CURRENT_CATALOG_CONFIG } from "../src/storage/sqlite/catalog-layout.js";
import { LibraryStateCache } from "../src/storage/sqlite/library-state-cache.js";

function previous(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; BEGIN");
  for (const sql of libraryStatePreviousManifest) db.exec(sql);
  db.prepare(
    "INSERT INTO schema_identity VALUES(1,'sciretriever',12,?,'2026-10-29T00:00:00Z')",
  ).run(LIBRARY_STATE_PREVIOUS_FINGERPRINT);
  db.prepare("INSERT INTO execution_schema_identity VALUES(1,?,?)").run(
    CURRENT_CATALOG_CONFIG.execution_schema_version,
    CURRENT_CATALOG_CONFIG.execution_schema_fingerprint,
  );
  db.prepare("INSERT INTO execution_runtime_schema_identity VALUES(1,?,?)").run(
    CURRENT_CATALOG_CONFIG.execution_runtime_schema_version,
    CURRENT_CATALOG_CONFIG.execution_runtime_schema_fingerprint,
  );
  db.exec(
    "INSERT INTO retrieval_source_revision VALUES(1,0); INSERT INTO vocabulary_state VALUES(1,0,0); INSERT INTO meta_literatures VALUES('meta','paper'); INSERT INTO literatures VALUES('paper','meta','published')",
  );
  db.prepare(
    "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256) VALUES('paper',1,?)",
  ).run("a".repeat(64));
  db.exec("COMMIT");
  return db;
}

it("migrates the exact 12 layout to 13 offline, preserves every old table count and refuses automatic or repeated migration", async () => {
  const root = await mkdtemp(
      join(tmpdir(), "sciretriever-library-state-migration-"),
    ),
    path = join(root, "catalog.sqlite");
  try {
    expect(
      createHash("sha256")
        .update(JSON.stringify(libraryStatePreviousManifest))
        .digest("hex"),
    ).toBe(LIBRARY_STATE_PREVIOUS_FINGERPRINT);
    previous(path).close();
    const before = await readFile(path);
    await expect(inspectCatalogSchema(path)).rejects.toMatchObject({
      reason: "catalog-layout-not-current",
    });
    expect(await readFile(path)).toEqual(before);
    const result = await migrateLibraryStateSchema(path);
    expect(result).toMatchObject({
      from_version: 12,
      to_version: 13,
      foreign_key_violations: 0,
    });
    for (const [table, count] of Object.entries(result.before))
      expect(result.after[table]).toBe(count);
    expect(result.after.library_state_changes).toBe(0);
    // Historical tools retain their targets; every later step is explicit.
    await expect(inspectCatalogSchema(path)).rejects.toMatchObject({
      reason: "catalog-layout-not-current",
    });
    const marks = await migrateReadingMarksSchema(path);
    expect(marks).toMatchObject({
      from_version: 13,
      to_version: 14,
      foreign_key_violations: 0,
    });
    for (const [table, count] of Object.entries(marks.before))
      expect(marks.after[table]).toBe(count);
    expect(marks.after.reading_marks).toBe(0);
    await migrateIntakeSchema(path);
    await migrateImportSchema(path);
    await migrateDraftTextSchema(path);
    await migrateUserOrganizationSchema(path);
    const frozen18 = await readFile(path);
    await expect(inspectCatalogSchema(path)).rejects.toMatchObject({
      reason: "catalog-layout-not-current",
    });
    expect(await readFile(path)).toEqual(frozen18);
    expect(await migrateCitationLimitsSchema(path)).toMatchObject({
      from_version: 18,
      to_version: 19,
      foreign_key_violations: 0,
    });
    expect(await inspectCatalogSchema(path)).toMatchObject({
      status: "ready",
      schema_version: 19,
    });
    await expect(migrateReadingMarksSchema(path)).rejects.toMatchObject({
      code: "reading-marks-schema-migration-refused",
    });
    const db = new DatabaseSync(path);
    try {
      const state = db.prepare("SELECT * FROM library_state_revision").get()!;
      expect(state.full_revision).toBe(state.revision);
      const cache = new LibraryStateCache();
      expect(
        cache.read(db, "migrated", 6, "vlm-engine", () => {}).get("paper"),
      ).toEqual({ status: "UNREVIEWED", missing_step: "primary-pdf" });
      db.exec("UPDATE literature_metadata SET title='Changed'");
      expect(
        db.prepare("SELECT literature_id FROM library_state_changes").all(),
      ).toEqual([{ literature_id: "paper" }]);
    } finally {
      db.close();
    }
    await expect(migrateLibraryStateSchema(path)).rejects.toMatchObject({
      code: "library-state-schema-migration-refused",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it("refuses running work and unknown layout without changing database bytes", async () => {
  const root = await mkdtemp(
      join(tmpdir(), "sciretriever-library-state-refused-"),
    ),
    path = join(root, "catalog.sqlite");
  try {
    const db = previous(path);
    db.exec(
      "INSERT INTO execution_jobs VALUES('job','literature','{}','fixture','queued','fixture','2026-10-29T00:00:00Z',NULL)",
    );
    db.close();
    let before = await readFile(path);
    await expect(migrateLibraryStateSchema(path)).rejects.toMatchObject({
      code: "library-state-schema-migration-refused",
    });
    expect(await readFile(path)).toEqual(before);
    const changed = new DatabaseSync(path);
    changed.exec(
      "UPDATE execution_jobs SET status='completed'; CREATE INDEX unexpected_library_state ON literature_metadata(title)",
    );
    changed.close();
    before = await readFile(path);
    await expect(migrateLibraryStateSchema(path)).rejects.toMatchObject({
      code: "library-state-schema-migration-refused",
    });
    expect(await readFile(path)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
