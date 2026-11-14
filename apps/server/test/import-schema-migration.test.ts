import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  SCHEMA_MANIFEST_V15,
  SCHEMA_FINGERPRINT_V15,
  SCHEMA_VERSION,
} from "../src/storage/sqlite/schema.js";
import { CURRENT_CATALOG_CONFIG } from "../src/storage/sqlite/catalog-layout.js";
import { migrateImportSchema } from "../src/storage/sqlite/import-schema-migration.js";
import { inspectCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";

function oldCatalog(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON;BEGIN");
  for (const sql of SCHEMA_MANIFEST_V15) db.exec(sql);
  db.prepare(
    "INSERT INTO schema_identity VALUES(1,'sciretriever',15,?,'2026-11-10T00:00:00Z')",
  ).run(SCHEMA_FINGERPRINT_V15);
  db.prepare("INSERT INTO execution_schema_identity VALUES(1,?,?)").run(
    CURRENT_CATALOG_CONFIG.execution_schema_version,
    CURRENT_CATALOG_CONFIG.execution_schema_fingerprint,
  );
  db.prepare("INSERT INTO execution_runtime_schema_identity VALUES(1,?,?)").run(
    CURRENT_CATALOG_CONFIG.execution_runtime_schema_version,
    CURRENT_CATALOG_CONFIG.execution_runtime_schema_fingerprint,
  );
  db.exec(
    "INSERT INTO retrieval_source_revision VALUES(1,0);INSERT INTO vocabulary_state VALUES(1,0,0);COMMIT",
  );
  return db;
}
it.each(["already rolled back", "rollback throws"])(
  "preserves the original migration error when %s",
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-import-rollback-"));
    const path = join(home, "catalog.sqlite");
    try {
      oldCatalog(path).close();
      const before = await readFile(path);
      const original = DatabaseSync.prototype.exec;
      const failure = new Error("Synthetic original migration failure");
      let injected = false;
      const spy = vi
        .spyOn(DatabaseSync.prototype, "exec")
        .mockImplementation(function (this: DatabaseSync, sql: string) {
          if (sql.startsWith("CREATE TABLE device_pairings(")) {
            injected = true;
            if (mode === "already rolled back") original.call(this, "ROLLBACK");
            throw failure;
          }
          original.call(this, sql);
          if (mode === "rollback throws" && sql === "ROLLBACK")
            throw new Error("Synthetic secondary rollback failure");
        });
      await expect(migrateImportSchema(path)).rejects.toBe(failure);
      expect(injected).toBe(true);
      spy.mockRestore();
      expect(await readFile(path)).toEqual(before);
    } finally {
      vi.restoreAllMocks();
      await rm(home, { recursive: true, force: true });
    }
  },
  30000,
);
it("migrates exact schema 15 to 16 atomically, preserves all facts and enables device connections without implicit migration", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-import-migration-")),
    path = join(home, "catalog.sqlite");
  try {
    const db = oldCatalog(path);
    db.exec(
      "BEGIN;INSERT INTO meta_literatures VALUES('meta','paper');INSERT INTO literatures VALUES('paper','meta','published');INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title) VALUES('paper',1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','Synthetic preserved paper');COMMIT",
    );
    db.close();
    const old = await createQueryApplication(home);
    try {
      expect(old.readiness.status).toBe("unavailable");
      expect(old.query).toBeNull();
    } finally {
      await old.close();
    }
    const before = new DatabaseSync(path, { readOnly: true });
    expect(
      before.prepare("SELECT schema_version FROM schema_identity").get()
        ?.schema_version,
    ).toBe(15);
    before.close();
    const result = await migrateImportSchema(path);
    expect(result).toMatchObject({
      from_version: 15,
      to_version: 16,
      foreign_key_violations: 0,
    });
    for (const [table, n] of Object.entries(result.before))
      expect(result.after[table], table).toBe(n);
    expect(result.after.device_connections).toBe(0);
    expect(result.after.device_pairings).toBe(0);
    for (const table of [
      "import_libraries",
      "external_object_mappings",
      "import_sessions",
      "import_parts",
      "import_staged_keys",
      "import_record_results",
      "import_files",
      "capture_daily_batches",
      "capture_items",
    ])
      expect(result.after[table], table).toBe(0);
    expect((await inspectCatalogSchema(path)).schema_version).toBe(
      SCHEMA_VERSION,
    );
    const app = await createApplication(home, { indexRefreshIntervalMs: null });
    try {
      expect(
        (await app.deviceConnections.list({ cursor: null })).items,
      ).toEqual([]);
    } finally {
      await app.close();
    }
    await expect(migrateImportSchema(path)).rejects.toMatchObject({
      code: "import-schema-migration-refused",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
it("refuses queued work, unknown layouts and FK corruption without changing the input", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-import-migration-refusal-"),
  );
  try {
    for (const kind of ["queued", "tampered", "corrupt"]) {
      const path = join(home, kind + ".sqlite"),
        db = oldCatalog(path);
      if (kind === "queued")
        db.exec(
          "INSERT INTO execution_jobs VALUES('job','selector','{}','p','queued','key','2026-11-10T00:00:00Z',NULL)",
        );
      else if (kind === "tampered") db.exec("CREATE TABLE unknown(x TEXT)");
      else {
        db.exec(
          "PRAGMA foreign_keys=OFF;INSERT INTO literature_assets(literature_asset_id,literature_id,asset_id,role,provenance_id) VALUES('invalid','missing','missing','primary-pdf','missing')",
        );
      }
      db.close();
      const digest = async () =>
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        before = await digest();
      await expect(migrateImportSchema(path)).rejects.toMatchObject({
        code: "import-schema-migration-refused",
      });
      expect(await digest()).toBe(before);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
