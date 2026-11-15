import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  SCHEMA_MANIFEST_V15,
  SCHEMA_FINGERPRINT_V15,
  SCHEMA_VERSION,
  SCHEMA_FINGERPRINT_V16,
} from "../src/storage/sqlite/schema.js";
import { CURRENT_CATALOG_CONFIG } from "../src/storage/sqlite/catalog-layout.js";
import { migrateImportSchema } from "../src/storage/sqlite/import-schema-migration.js";
import { migrateDraftTextSchema } from "../src/storage/sqlite/draft-text-schema-migration.js";
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
    const oldStatuses = [
      "running",
      "completed",
      "partial",
      "failed",
      "interrupted",
    ] as const;
    const oldIds = oldStatuses.map((status, index) => {
      const id = randomUUID(),
        origin = index % 2 ? "web" : "cli";
      db.prepare(
        "INSERT INTO intake_batches(batch_id,kind,default_label,origin,created_at,status,request_json) VALUES(?,'import','Old import',?,'2026-11-10T00:00:00Z',?,'{\"format\":\"bibtex\",\"file_name\":null}')",
      ).run(id, origin, status);
      db.prepare(
        "INSERT INTO intake_batch_members VALUES(?,'paper','matched')",
      ).run(id);
      return { id, status, origin };
    });
    const legacyId = randomUUID();
    db.prepare(
      "INSERT INTO intake_batches(batch_id,kind,default_label,origin,created_at,status,request_json) VALUES(?,'legacy','Legacy','migration','2026-11-10T00:00:00Z','completed','{}')",
    ).run(legacyId);
    db.prepare(
      "INSERT INTO intake_batch_members VALUES(?,'paper','legacy')",
    ).run(legacyId);
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
    const migrated = new DatabaseSync(path);
    try {
      expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        migrated
          .prepare("PRAGMA table_info(intake_batches)")
          .all()
          .map((r) => r.name),
      ).not.toContain("status");
      expect(
        migrated
          .prepare("PRAGMA table_info(import_sessions)")
          .all()
          .map((r) => r.name),
      ).not.toContain("state");
      for (const old of oldIds)
        expect(
          migrated
            .prepare(
              "SELECT state,result,initiated_by FROM intake_batches WHERE batch_id=?",
            )
            .get(old.id),
        ).toEqual({
          state: old.status === "running" ? "running" : "finished",
          result: old.status === "running" ? null : old.status,
          initiated_by: `local:${old.origin}`,
        });
      expect(
        migrated
          .prepare("SELECT initiated_by FROM intake_batches WHERE batch_id=?")
          .get(legacyId)?.initiated_by,
      ).toBe("migration");
      expect(
        migrated
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('capture_items','capture_daily_batches')",
          )
          .all(),
      ).toEqual([]);
      expect(() =>
        migrated
          .prepare(
            "UPDATE intake_batches SET result='completed' WHERE batch_id=?",
          )
          .run(oldIds[0]!.id),
      ).toThrow();
      expect(() =>
        migrated
          .prepare(
            "UPDATE intake_batches SET state='collecting' WHERE batch_id=?",
          )
          .run(oldIds[1]!.id),
      ).toThrow();
      expect(
        migrated.prepare("SELECT count(*) n FROM intake_batch_members").get()!
          .n,
      ).toBe(6);
    } finally {
      migrated.close();
    }
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
      "intake_items",
      "intake_page_requests",
      "intake_open_batches",
      "literature_needs_metadata",
      "intake_batch_objects",
      "intake_withdrawals",
      "intake_withdrawn_objects",
    ])
      expect(result.after[table], table).toBe(0);
    const v16 = new DatabaseSync(path, { readOnly: true });
    expect(
      v16
        .prepare(
          "SELECT schema_version,schema_fingerprint FROM schema_identity",
        )
        .get(),
    ).toEqual({
      schema_version: 16,
      schema_fingerprint: SCHEMA_FINGERPRINT_V16,
    });
    v16.close();
    await expect(migrateImportSchema(path)).rejects.toMatchObject({
      code: "import-schema-migration-refused",
    });
    await expect(inspectCatalogSchema(path)).rejects.toMatchObject({
      reason: "catalog-layout-not-current",
    });
    await migrateDraftTextSchema(path);
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

it("installs all future intake DDL without revision triggers and enforces mapping states and FK cascade/set-null", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-intake-ddl-")),
    path = join(home, "catalog.sqlite");
  try {
    const before = oldCatalog(path);
    before.exec(
      "BEGIN;INSERT INTO meta_literatures VALUES('meta','representative');INSERT INTO literatures VALUES('representative','meta','published');INSERT INTO literatures VALUES('paper','meta','preprint');INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title) VALUES('paper',1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','Synthetic');COMMIT",
    );
    before.close();
    await migrateImportSchema(path);
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=ON");
    try {
      const batch = randomUUID(),
        item = randomUUID();
      db.prepare(
        "INSERT INTO intake_batches(batch_id,kind,default_label,origin,created_at,state,initiated_by,request_json) VALUES(?,'import','DDL','cli','2026-11-15T00:00:00Z','collecting','local:cli','{}')",
      ).run(batch);
      db.exec(
        "INSERT INTO import_libraries VALUES('source','synthetic','library','global','Library','2026-11-15T00:00:00Z')",
      );
      db.exec(
        "INSERT INTO external_object_mappings(library_key,object_kind,external_id,internal_id) VALUES('source','group','group','folder')",
      );
      expect(
        db.prepare("SELECT state FROM external_object_mappings").get()!.state,
      ).toBe("settled");
      expect(() =>
        db.exec("UPDATE external_object_mappings SET state='invalid'"),
      ).toThrow();
      const revision = db.prepare("SELECT * FROM library_state_revision").all(),
        retrieval = db.prepare("SELECT * FROM retrieval_source_revision").all();
      db.prepare(
        "INSERT INTO intake_items(item_id,batch_id,origin,literature_id,created_at) VALUES(?,?,'file','paper','2026-11-15T00:00:00Z')",
      ).run(item, batch);
      db.prepare(
        "INSERT INTO literature_needs_metadata VALUES('paper','2026-11-15T00:00:00Z',?)",
      ).run(batch);
      db.prepare(
        "INSERT INTO intake_batch_objects VALUES('folder','folder',?)",
      ).run(batch);
      db.prepare(
        "INSERT INTO intake_withdrawals VALUES(?,'cancelled','2026-11-15T00:00:00Z','web',NULL,'{}',NULL)",
      ).run(batch);
      db.prepare(
        "INSERT INTO intake_withdrawn_objects VALUES('literature','paper',?,'2026-11-15T00:00:00Z')",
      ).run(batch);
      expect(db.prepare("SELECT * FROM library_state_revision").all()).toEqual(
        revision,
      );
      expect(
        db.prepare("SELECT * FROM retrieval_source_revision").all(),
      ).toEqual(retrieval);
      expect(() =>
        db
          .prepare(
            "INSERT INTO intake_items(item_id,batch_id,origin,created_at) VALUES('invalid','absent','file','2026-11-15T00:00:00Z')",
          )
          .run(),
      ).toThrow();
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      db.exec("DELETE FROM literatures WHERE literature_id='paper'");
      expect(
        db
          .prepare("SELECT literature_id FROM intake_items WHERE item_id=?")
          .get(item)!.literature_id,
      ).toBeNull();
      expect(
        db.prepare("SELECT count(*) n FROM literature_needs_metadata").get()!.n,
      ).toBe(0);
      db.prepare("DELETE FROM intake_batches WHERE batch_id=?").run(batch);
      for (const table of [
        "intake_items",
        "intake_batch_objects",
        "intake_withdrawals",
        "intake_withdrawn_objects",
      ])
        expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
