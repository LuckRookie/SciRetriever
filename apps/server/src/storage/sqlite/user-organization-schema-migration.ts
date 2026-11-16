import { DatabaseSync } from "node:sqlite";
import { createLogger } from "../../logging/index.js";
import { acquireCatalogWriteLock } from "../write-admission.js";
import { schemaTargetFile, schemaTargetPath } from "./schema-path.js";
import {
  offlineTableCounts,
  verifyOfflineLayout,
} from "./archive-schema-migration.js";
import {
  SCHEMA_MANIFEST_V17,
  SCHEMA_FINGERPRINT_V17,
  SCHEMA_MANIFEST,
  SCHEMA_FINGERPRINT,
  USER_ORGANIZATION_SCHEMA_V18,
  DEVICE_KIND_COLUMN_V18,
} from "./schema.js";
import {
  EXECUTION_SCHEMA_VERSION,
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
} from "./execution-schema.js";

function refuse(): never {
  throw Object.assign(new Error("user organization schema migration refused"), {
    code: "user-organization-schema-migration-refused",
  });
}
/** Explicit offline 17 -> 18, including a nullable display kind for existing devices. */
export async function migrateUserOrganizationSchema(path: string) {
  await schemaTargetPath(path);
  if (!(await schemaTargetFile(path))) refuse();
  const lock = await acquireCatalogWriteLock(path);
  const started = performance.now();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec(
      "PRAGMA foreign_keys=ON;PRAGMA busy_timeout=0;PRAGMA synchronous=FULL",
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      // Verify the complete frozen layout before reading identity columns.
      verifyOfflineLayout(db, SCHEMA_MANIFEST_V17, refuse);
      const identity = db.prepare("SELECT * FROM schema_identity").get();
      const execution = db
        .prepare("SELECT * FROM execution_schema_identity")
        .get();
      const runtime = db
        .prepare("SELECT * FROM execution_runtime_schema_identity")
        .get();
      if (
        identity?.schema_version !== 17 ||
        identity.schema_fingerprint !== SCHEMA_FINGERPRINT_V17 ||
        execution?.version !== EXECUTION_SCHEMA_VERSION ||
        execution.fingerprint !== EXECUTION_SCHEMA_FINGERPRINT ||
        runtime?.version !== EXECUTION_RUNTIME_SCHEMA_VERSION ||
        runtime.fingerprint !== EXECUTION_RUNTIME_SCHEMA_FINGERPRINT ||
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
      for (const sql of USER_ORGANIZATION_SCHEMA_V18) db.exec(sql);
      db.exec(
        `ALTER TABLE device_connections ADD COLUMN ${DEVICE_KIND_COLUMN_V18}`,
      );
      db.exec(
        "CREATE TEMP TABLE organization_identity AS SELECT * FROM schema_identity;DROP TABLE schema_identity",
      );
      db.exec(
        SCHEMA_MANIFEST.find((sql) =>
          sql.startsWith("CREATE TABLE schema_identity("),
        )!,
      );
      db.prepare(
        "INSERT INTO schema_identity SELECT singleton,product,18,?,created_at FROM organization_identity",
      ).run(SCHEMA_FINGERPRINT);
      db.exec("DROP TABLE organization_identity");
      const after = offlineTableCounts(db, refuse);
      for (const [table, count] of Object.entries(before))
        if (after[table] !== count) refuse();
      if (after.saved_filters !== 0 || after.reading_mark_places !== 0)
        refuse();
      verifyOfflineLayout(db, SCHEMA_MANIFEST, refuse);
      if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
        refuse();
      db.exec("COMMIT");
      return {
        from_version: 17,
        to_version: 18,
        before,
        after,
        foreign_key_violations: 0,
        integrity_check: "ok",
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
    db?.close();
    await lock.release();
  }
}
