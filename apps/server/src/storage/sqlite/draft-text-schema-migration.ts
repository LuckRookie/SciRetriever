import { DatabaseSync } from "node:sqlite";
import { createLogger } from "../../logging/index.js";
import { acquireCatalogWriteLock } from "../write-admission.js";
import { schemaTargetFile, schemaTargetPath } from "./schema-path.js";
import {
  offlineTableCounts,
  verifyOfflineLayout,
} from "./archive-schema-migration.js";
import {
  SCHEMA_MANIFEST_V16,
  SCHEMA_FINGERPRINT_V16,
  SCHEMA_MANIFEST_V17 as SCHEMA_MANIFEST,
  SCHEMA_FINGERPRINT_V17 as SCHEMA_FINGERPRINT,
  DRAFT_TEXT_SCHEMA_V17,
} from "./schema.js";
import {
  EXECUTION_SCHEMA_VERSION,
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
} from "./execution-schema.js";

function refuse(): never {
  throw Object.assign(new Error("draft text schema migration refused"), {
    code: "draft-text-schema-migration-refused",
  });
}
const objectName = (sql: string) =>
  /^CREATE (?:UNIQUE )?(TABLE|INDEX|VIEW|TRIGGER) ([a-z_][a-z0-9_]*)/u.exec(
    sql,
  );
const protectedTables = [
  "document_versions",
  "archive_content_heads",
  "archive_version_events",
  "processor_result_freshness",
  "processor_result_freshness_reasons",
] as const;

/** Explicit offline 16 -> 17. No artifact reads, initial drafts or content events. */
export async function migrateDraftTextSchema(path: string) {
  await schemaTargetPath(path);
  if (!(await schemaTargetFile(path))) refuse();
  if (
    SCHEMA_FINGERPRINT_V16 !==
    "8545637a22c2341066427f71195eec5465e4c906f3dabd2c2cbad2a4c512f0f8"
  )
    refuse();
  const lock = await acquireCatalogWriteLock(path);
  const started = performance.now();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec(
      "PRAGMA busy_timeout=0;PRAGMA synchronous=FULL;PRAGMA foreign_keys=OFF",
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      if (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='schema_identity'",
          )
          .get()?.sql !==
        SCHEMA_MANIFEST_V16.find((sql) =>
          sql.startsWith("CREATE TABLE schema_identity("),
        )
      )
        refuse();
      const identity = db
        .prepare("SELECT * FROM schema_identity WHERE singleton=1")
        .get();
      if (
        identity?.product !== "sciretriever" ||
        identity.schema_version !== 16 ||
        identity.schema_fingerprint !== SCHEMA_FINGERPRINT_V16
      )
        refuse();
      verifyOfflineLayout(db, SCHEMA_MANIFEST_V16, refuse);
      for (const [table, version, fingerprint] of [
        [
          "execution_schema_identity",
          EXECUTION_SCHEMA_VERSION,
          EXECUTION_SCHEMA_FINGERPRINT,
        ],
        [
          "execution_runtime_schema_identity",
          EXECUTION_RUNTIME_SCHEMA_VERSION,
          EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
        ],
      ] as const) {
        const row = db
          .prepare("SELECT * FROM " + table + " WHERE singleton=1")
          .get();
        if (row?.version !== version || row.fingerprint !== fingerprint)
          refuse();
      }
      if (
        db
          .prepare(
            "SELECT 1 FROM execution_jobs WHERE status IN ('queued','running') LIMIT 1",
          )
          .get() ||
        db
          .prepare("SELECT 1 FROM archive_runs WHERE state='running' LIMIT 1")
          .get()
      )
        refuse();
      const before = offlineTableCounts(db, refuse);
      const columns = new Map<string, string>();
      for (const table of protectedTables) {
        columns.set(
          table,
          db
            .prepare("PRAGMA table_info(" + table + ")")
            .all()
            .map((row) => '"' + String(row.name) + '"')
            .join(","),
        );
        db.exec(
          "CREATE TEMP TABLE draft_migration_" +
            table +
            " AS SELECT * FROM main." +
            table,
        );
      }
      // Do not RENAME the parent: SQLite would rewrite child FKs to the old name.
      const dependents = SCHEMA_MANIFEST_V16.filter(
        (sql) =>
          /^CREATE (?:UNIQUE )?(?:INDEX|VIEW|TRIGGER) /u.test(sql) &&
          /\b(?:document_versions|archive_current_parts)\b/u.test(sql),
      );
      for (const kind of ["TRIGGER", "VIEW", "INDEX"])
        for (const sql of dependents) {
          const [, type, name] = objectName(sql)!;
          if (type === kind) db.exec("DROP " + type + " " + name);
        }
      db.exec("DROP TABLE document_versions");
      db.exec(
        SCHEMA_MANIFEST.find((sql) =>
          sql.startsWith("CREATE TABLE document_versions("),
        )!,
      );
      const versionColumns = columns.get("document_versions")!;
      db.exec(
        "INSERT INTO document_versions(" +
          versionColumns +
          ") SELECT " +
          versionColumns +
          " FROM draft_migration_document_versions",
      );
      db.exec(
        "CREATE TEMP TABLE draft_migration_identity AS SELECT * FROM schema_identity;DROP TABLE schema_identity",
      );
      db.exec(
        SCHEMA_MANIFEST.find((sql) =>
          sql.startsWith("CREATE TABLE schema_identity("),
        )!,
      );
      db.prepare(
        "INSERT INTO schema_identity SELECT singleton,product,17,?,created_at FROM draft_migration_identity",
      ).run(SCHEMA_FINGERPRINT);
      for (const sql of DRAFT_TEXT_SCHEMA_V17) db.exec(sql);
      for (const sql of dependents) {
        const [, , name] = objectName(sql)!;
        db.exec(
          SCHEMA_MANIFEST.find(
            (candidate) => objectName(candidate)?.[2] === name,
          )!,
        );
      }
      const after = offlineTableCounts(db, refuse);
      for (const [table, count] of Object.entries(before))
        if (after[table] !== count) refuse();
      for (const table of [
        "draft_current",
        "draft_version_facts",
        "processor_unfound_citations",
      ])
        if (after[table] !== 0) refuse();
      for (const table of protectedTables) {
        const list = columns.get(table)!;
        if (
          db
            .prepare(
              "SELECT " +
                list +
                " FROM main." +
                table +
                " EXCEPT SELECT " +
                list +
                " FROM draft_migration_" +
                table +
                " LIMIT 1",
            )
            .get() ||
          db
            .prepare(
              "SELECT " +
                list +
                " FROM draft_migration_" +
                table +
                " EXCEPT SELECT " +
                list +
                " FROM main." +
                table +
                " LIMIT 1",
            )
            .get()
        )
          refuse();
      }
      verifyOfflineLayout(db, SCHEMA_MANIFEST, refuse);
      if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
        refuse();
      db.exec("COMMIT");
      return {
        from_version: 16,
        to_version: 17,
        before,
        after,
        foreign_key_violations: 0,
        preserved_document_rows: true,
        preserved_content_heads: true,
        preserved_version_events: true,
        preserved_result_freshness: true,
        elapsed_ms: performance.now() - started,
      };
    } catch (error) {
      if (db.isTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {
          createLogger("schema-migration").warn(
            "Migration rollback failed; preserving original error",
          );
        }
      }
      throw error;
    }
  } finally {
    try {
      if (db) {
        db.exec("PRAGMA foreign_keys=ON");
        db.close();
      }
    } finally {
      await lock.release();
    }
  }
}
