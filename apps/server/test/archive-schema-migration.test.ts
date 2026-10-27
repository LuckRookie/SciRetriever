import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  archivePreviousManifest,
  ARCHIVE_PREVIOUS_FINGERPRINT,
  migrateArchiveSchema,
} from "../src/storage/sqlite/archive-schema-migration.js";
import { inspectCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import {
  EXECUTION_SCHEMA_VERSION,
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
} from "../src/storage/sqlite/execution-schema.js";
import { SCHEMA_FINGERPRINT } from "../src/storage/sqlite/schema.js";

export function oldArchiveCatalog(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
  for (const sql of archivePreviousManifest) db.exec(sql);
  db.prepare(
    "INSERT INTO schema_identity VALUES(1,'sciretriever',11,?,'2026-10-28T00:00:00Z')",
  ).run(ARCHIVE_PREVIOUS_FINGERPRINT);
  db.prepare("INSERT INTO execution_schema_identity VALUES(1,?,?)").run(
    EXECUTION_SCHEMA_VERSION,
    EXECUTION_SCHEMA_FINGERPRINT,
  );
  db.prepare("INSERT INTO execution_runtime_schema_identity VALUES(1,?,?)").run(
    EXECUTION_RUNTIME_SCHEMA_VERSION,
    EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
  );
  db.exec(
    "INSERT INTO retrieval_source_revision VALUES(1,0);INSERT INTO vocabulary_state VALUES(1,0,0);COMMIT",
  );
  db.exec("BEGIN");
  db.exec(
    "INSERT INTO meta_literatures VALUES('meta-fixture','paper-fixture');INSERT INTO literatures VALUES('paper-fixture','meta-fixture','published')",
  );
  db.prepare(
    "INSERT INTO artifact_objects VALUES('artifact-fixture',?,1,'application/pdf','assets/fixture.pdf')",
  ).run("a".repeat(64));
  db.prepare(
    "INSERT INTO assets VALUES('asset-fixture',?,1,'application/pdf','assets/fixture.pdf')",
  ).run("a".repeat(64));
  db.exec(
    "INSERT INTO archive_runs VALUES('paper-fixture','asset-fixture','full','run-fixture',NULL,'finished','2026-10-28T00:00:00Z','2026-10-28T00:01:00Z')",
  );
  for (const step of ["document", "structure"])
    db.prepare(
      "INSERT INTO archive_steps VALUES('paper-fixture','asset-fixture',?,'done',?,'{\"historical\":true}',NULL,42,7,700,350,'2026-10-28T00:00:00Z')",
    ).run(step, "b".repeat(64));
  db.exec("COMMIT");
  return db;
}
it("explicitly migrates 11 to 12 without changing row counts, keys or historical steps; opening never migrates", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-archive-migration-")),
    path = join(root, "catalog.sqlite");
  try {
    const db = oldArchiveCatalog(path);
    db.close();
    const before = await readFile(path);
    await expect(inspectCatalogSchema(path)).rejects.toMatchObject({
      reason: "catalog-layout-not-current",
    });
    expect(await readFile(path)).toEqual(before);
    const result = await migrateArchiveSchema(path);
    expect(result.before).toEqual(result.after);
    expect(result.after.archive_steps).toBe(2);
    expect(result.foreign_key_violations).toBe(0);
    expect(await inspectCatalogSchema(path)).toMatchObject({
      status: "ready",
      schema_version: 12,
      schema_fingerprint: SCHEMA_FINGERPRINT,
    });
    const next = new DatabaseSync(path, { readOnly: true });
    expect(
      next
        .prepare("SELECT sql FROM sqlite_master WHERE name='archive_steps'")
        .get()!.sql,
    ).toContain("'arrange','proofread','render'");
    expect(
      next
        .prepare(
          "SELECT step,output_json,calls FROM archive_steps ORDER BY step",
        )
        .all(),
    ).toEqual(
      ["document", "structure"].map((step) => ({
        step,
        output_json: '{"historical":true}',
        calls: 7,
      })),
    );
    next.close();
    await expect(migrateArchiveSchema(path)).rejects.toMatchObject({
      code: "archive-schema-migration-refused",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
it("refuses running work or unknown schema objects without migrating", async () => {
  const root = await mkdtemp(
      join(tmpdir(), "sciretriever-archive-migration-busy-"),
    ),
    path = join(root, "catalog.sqlite");
  try {
    const db = oldArchiveCatalog(path);
    db.exec("UPDATE archive_runs SET state='running'");
    db.close();
    const before = await readFile(path);
    await expect(migrateArchiveSchema(path)).rejects.toMatchObject({
      code: "archive-schema-migration-refused",
    });
    expect(await readFile(path)).toEqual(before);
    const changed = new DatabaseSync(path);
    changed.exec(
      "UPDATE archive_runs SET state='finished';CREATE INDEX unexpected_fixture_index ON archive_runs(state)",
    );
    changed.close();
    const changedBytes = await readFile(path);
    await expect(migrateArchiveSchema(path)).rejects.toMatchObject({
      code: "archive-schema-migration-refused",
    });
    expect(await readFile(path)).toEqual(changedBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
it("refuses a tampered previous layout without changing its bytes", async () => {
  const root = await mkdtemp(
      join(tmpdir(), "sciretriever-archive-migration-refused-"),
    ),
    path = join(root, "catalog.sqlite");
  try {
    const db = oldArchiveCatalog(path);
    db.exec("ALTER TABLE archive_steps ADD COLUMN extra TEXT");
    db.close();
    const before = await readFile(path);
    await expect(migrateArchiveSchema(path)).rejects.toMatchObject({
      code: "archive-schema-migration-refused",
    });
    expect(await readFile(path)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
