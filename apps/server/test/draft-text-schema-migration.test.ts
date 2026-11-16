import { DatabaseSync } from "node:sqlite";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import {
  SCHEMA_MANIFEST,
  SCHEMA_MANIFEST_V16,
  SCHEMA_FINGERPRINT_V16,
} from "../src/storage/sqlite/schema.js";
import { verifyOfflineLayout } from "../src/storage/sqlite/archive-schema-migration.js";
import { migrateDraftTextSchema } from "../src/storage/sqlite/draft-text-schema-migration.js";
import { CURRENT_CATALOG_CONFIG } from "../src/storage/sqlite/catalog-layout.js";
import { inspectCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import { draftMigrationFixture } from "./draft-text-schema-fixture.js";

it("prepares a synthetic frozen-v16 input with long corrected text, processing, marks and full-text rows", async () => {
  const f = await draftMigrationFixture(SCHEMA_MANIFEST_V16);
  try {
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      verifyOfflineLayout(db, SCHEMA_MANIFEST_V16);
      expect(
        db.prepare("SELECT schema_version FROM schema_identity").get()!
          .schema_version,
      ).toBe(16);
      for (const table of [
        "document_versions",
        "proofread_versions",
        "proofread_resources",
        "document_version_resources",
        "structure_annotations",
        "processor_results",
        "processor_result_freshness",
        "reading_marks",
      ])
        expect(f.counts[table], table).toBeGreaterThan(0);
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM archive_content_heads WHERE source_json IS NOT NULL",
          )
          .get()!.n,
      ).toBeGreaterThan(0);
      expect(f.longDocument).toMatchObject({ pages: 51, reasons: ["pages"] });
      expect(
        db
          .prepare(
            "SELECT schema_version,builder_version FROM document_versions",
          )
          .all(),
      ).toEqual([
        { schema_version: 2, builder_version: "source-order-leaves-v4" },
      ]);
      for (const table of ["retrieval_fts", "processor_result_fts"])
        expect(
          db
            .prepare(
              `SELECT count(*) n FROM ${table} WHERE ${table} MATCH 'finding'`,
            )
            .get()!.n,
          table,
        ).toBeGreaterThan(0);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
}, 120_000);

function oldCatalog(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON;BEGIN");
  for (const sql of SCHEMA_MANIFEST_V16) db.exec(sql);
  db.prepare(
    "INSERT INTO schema_identity VALUES(1,'sciretriever',16,?,'2026-11-15T00:00:00Z')",
  ).run(SCHEMA_FINGERPRINT_V16);
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
it("runs the built standalone offline migration script against an explicit synthetic path", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "sciretriever-draft-migration-script-"),
  );
  const path = join(root, "catalog.sqlite");
  try {
    oldCatalog(path).close();
    const result = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../../scripts/migrate-draft-text-v17.mjs",
            import.meta.url,
          ),
        ),
        path,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      from_version: 16,
      to_version: 17,
      foreign_key_violations: 0,
    });
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      verifyOfflineLayout(db, SCHEMA_MANIFEST);
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
function facts(db: DatabaseSync) {
  return Object.fromEntries(
    [
      "document_versions",
      "proofread_versions",
      "proofread_resources",
      "document_version_resources",
      "document_defaults",
      "archive_current_parts",
      "archive_content_heads",
      "archive_version_events",
      "processor_result_freshness",
      "processor_result_freshness_reasons",
      "structure_annotations",
      "reading_marks",
      "retrieval_fts",
    ].map((name) => [
      name,
      db.prepare("SELECT * FROM " + name + " ORDER BY 1").all(),
    ]),
  );
}
it("migrates a populated exact 16 without rewriting corrected documents, content versions, freshness or FTS", async () => {
  const f = await draftMigrationFixture(SCHEMA_MANIFEST_V16);
  try {
    const input = new DatabaseSync(f.path, { readOnly: true });
    const before = facts(input);
    const oldVersionColumns = input
      .prepare("PRAGMA table_info(document_versions)")
      .all()
      .map((r) => String(r.name));
    input.close();
    const result = await migrateDraftTextSchema(f.path);
    expect(result).toMatchObject({
      from_version: 16,
      to_version: 17,
      foreign_key_violations: 0,
      preserved_document_rows: true,
      preserved_content_heads: true,
      preserved_version_events: true,
      preserved_result_freshness: true,
    });
    for (const [table, count] of Object.entries(result.before))
      expect(result.after[table], table).toBe(count);
    for (const table of [
      "draft_current",
      "draft_version_facts",
      "processor_unfound_citations",
    ])
      expect(result.after[table], table).toBe(0);
    const output = new DatabaseSync(f.path, { readOnly: true });
    try {
      verifyOfflineLayout(output, SCHEMA_MANIFEST);
      const after = facts(output);
      // Only the eight new nullable columns may differ from an old v2 row.
      after.document_versions = output
        .prepare(
          "SELECT " +
            oldVersionColumns.join(",") +
            " FROM document_versions ORDER BY 1",
        )
        .all();
      expect(after).toEqual(before);
      expect(output.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        output.prepare("PRAGMA integrity_check").get()!.integrity_check,
      ).toBe("ok");
      expect(
        output
          .prepare(
            "SELECT count(*) n FROM retrieval_fts WHERE retrieval_fts MATCH 'finding'",
          )
          .get()!.n,
      ).toBeGreaterThan(0);
    } finally {
      output.close();
    }
    await copyFile(f.path, join(f.env.home, "catalog.sqlite"));
    await f.env.reopen();
    expect(
      (
        await f.env.app.documentRead.describe({
          document_version_id: f.document.document_version_id,
        })
      ).document,
    ).toEqual(f.document);
    expect((await inspectCatalogSchema(f.path)).schema_version).toBe(17);
    await expect(migrateDraftTextSchema(f.path)).rejects.toMatchObject({
      code: "draft-text-schema-migration-refused",
    });
    console.info("Synthetic 16 -> 17 migration", JSON.stringify(result));
  } finally {
    await f.close();
  }
}, 120_000);

it.each([
  "queued",
  "running",
  "archive",
  "unknown",
  "foreign-key",
  "execution-identity",
  "uninitialized",
  "identity-layout",
] as const)(
  "refuses %s without modifying the synthetic input",
  async (kind) => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-draft-migration-refuse-"),
    );
    const path = join(root, "catalog.sqlite");
    try {
      const db = oldCatalog(path);
      if (kind === "queued" || kind === "running")
        db.prepare(
          "INSERT INTO execution_jobs VALUES('job','selector','{}','p',?,'key','2026-11-15T00:00:00Z',NULL)",
        ).run(kind);
      if (kind === "archive") {
        db.exec("PRAGMA foreign_keys=OFF");
        // A valid archive owner is not needed to prove the explicit running-work guard.
        db.exec(
          "INSERT INTO meta_literatures VALUES('meta','paper');INSERT INTO literatures VALUES('paper','meta','published')",
        );
        db.exec(
          "INSERT INTO provenances VALUES('p','user','fixture',NULL,'2026-11-15T00:00:00Z',NULL,NULL)",
        );
        db.exec(
          "INSERT INTO artifact_objects VALUES('pdf','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,'application/pdf','objects/fake.pdf')",
        );
        db.exec(
          "INSERT INTO assets(asset_id,sha256,size_bytes,media_type,relative_path) VALUES('pdf','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,'application/pdf','objects/fake.pdf')",
        );
        db.exec(
          "INSERT INTO archive_runs VALUES('paper','pdf','full','run',NULL,'running','2026-11-15T00:00:00Z',NULL)",
        );
      }
      if (kind === "unknown") db.exec("CREATE TABLE unexpected(x TEXT)");
      if (kind === "identity-layout")
        db.exec(
          "DROP TABLE schema_identity;CREATE TABLE schema_identity(other TEXT)",
        );
      if (kind === "execution-identity")
        db.exec(
          "UPDATE execution_runtime_schema_identity SET fingerprint=printf('%064d',0)",
        );
      if (kind === "foreign-key")
        db.exec(
          "PRAGMA foreign_keys=OFF;INSERT INTO literature_assets(literature_asset_id,literature_id,asset_id,role,provenance_id) VALUES('broken','absent','absent','primary-pdf','absent')",
        );
      db.close();
      if (kind === "uninitialized") {
        await rm(path);
        new DatabaseSync(path).close();
      }
      const before = await readFile(path);
      await expect(migrateDraftTextSchema(path)).rejects.toMatchObject({
        code: "draft-text-schema-migration-refused",
      });
      expect(await readFile(path)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

it.each([
  "table",
  "identity",
  "already rolled back",
  "rollback throws",
] as const)(
  "preserves the original error and exact 16 input after an injected %s failure, then can rerun",
  async (mode) => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-draft-migration-rollback-"),
    );
    const path = join(root, "catalog.sqlite");
    try {
      oldCatalog(path).close();
      const before = await readFile(path);
      const original = DatabaseSync.prototype.exec;
      const failure = new Error("Synthetic original draft migration failure");
      let injected = false;
      const spy = vi
        .spyOn(DatabaseSync.prototype, "exec")
        .mockImplementation(function (this: DatabaseSync, sql: string) {
          const target =
            mode === "table"
              ? "CREATE TABLE document_versions("
              : "CREATE TABLE draft_current(";
          if (sql.startsWith(target)) {
            injected = true;
            if (mode === "already rolled back") original.call(this, "ROLLBACK");
            throw failure;
          }
          original.call(this, sql);
          if (mode === "rollback throws" && sql === "ROLLBACK")
            throw new Error("Synthetic secondary rollback failure");
        });
      await expect(migrateDraftTextSchema(path)).rejects.toBe(failure);
      expect(injected).toBe(true);
      spy.mockRestore();
      expect(await readFile(path)).toEqual(before);
      const check = new DatabaseSync(path, { readOnly: true });
      try {
        verifyOfflineLayout(check, SCHEMA_MANIFEST_V16);
      } finally {
        check.close();
      }
      expect((await migrateDraftTextSchema(path)).to_version).toBe(17);
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
