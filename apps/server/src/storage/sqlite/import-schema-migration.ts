import { DatabaseSync } from "node:sqlite";
import { createLogger } from "../../logging/index.js";
import { acquireCatalogWriteLock } from "../write-admission.js";
import { schemaTargetFile, schemaTargetPath } from "./schema-path.js";
import {
  offlineTableCounts,
  verifyOfflineLayout,
} from "./archive-schema-migration.js";
import {
  SCHEMA_MANIFEST_V15,
  SCHEMA_FINGERPRINT_V15,
  SCHEMA_MANIFEST_V16 as SCHEMA_MANIFEST,
  SCHEMA_FINGERPRINT_V16 as SCHEMA_FINGERPRINT,
  IMPORT_SCHEMA_V16,
} from "./schema.js";
const SCHEMA_VERSION = 16;
function refuse(): never {
  throw Object.assign(new Error("import schema migration refused"), {
    code: "import-schema-migration-refused",
  });
}
/** Explicit offline 15 -> 16. Further M1 additions extend IMPORT_SCHEMA_V16. */
export async function migrateImportSchema(path: string) {
  await schemaTargetPath(path);
  if (!(await schemaTargetFile(path))) refuse();
  const lock = await acquireCatalogWriteLock(path);
  let db: DatabaseSync | undefined;
  const started = performance.now();
  try {
    db = new DatabaseSync(path);
    db.exec(
      "PRAGMA foreign_keys=ON;PRAGMA busy_timeout=0;PRAGMA synchronous=FULL",
    );
    const identity = db.prepare("SELECT * FROM schema_identity").get();
    if (
      identity?.schema_version !== 15 ||
      identity.schema_fingerprint !== SCHEMA_FINGERPRINT_V15
    )
      refuse();
    verifyOfflineLayout(db, SCHEMA_MANIFEST_V15, refuse);
    db.exec("BEGIN IMMEDIATE");
    try {
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
      // Back up both sides before rebuilding the parent: DROP with foreign_keys
      // enabled must not cascade away the schema-15 membership facts.
      db.exec(
        "CREATE TEMP TABLE import_old_batches AS SELECT * FROM intake_batches;CREATE TEMP TABLE import_old_members AS SELECT * FROM intake_batch_members;DROP TABLE intake_batch_members;DROP TABLE intake_batches",
      );
      for (const sql of IMPORT_SCHEMA_V16) db.exec(sql);
      db.exec(
        "INSERT INTO intake_batches(batch_id,kind,default_label,label,origin,created_at,finished_at,state,result,confirmation,confirmed_at,initiated_by,request_json,discovery_run_id,rejected,source_failures,owner_pid) SELECT batch_id,kind,default_label,label,origin,created_at,finished_at,CASE WHEN status='running' THEN 'running' ELSE 'finished' END,CASE WHEN status='running' THEN NULL ELSE status END,NULL,NULL,CASE WHEN origin='migration' THEN 'migration' ELSE 'local:'||origin END,request_json,discovery_run_id,rejected,source_failures,owner_pid FROM import_old_batches;INSERT INTO intake_batch_members SELECT * FROM import_old_members;DROP TABLE import_old_members;DROP TABLE import_old_batches",
      );
      // Additional M1 backfills belong here, in the same atomic migration.
      db.exec(
        "CREATE TEMP TABLE import_identity AS SELECT * FROM schema_identity;DROP TABLE schema_identity",
      );
      db.exec(
        SCHEMA_MANIFEST.find((sql) =>
          sql.startsWith("CREATE TABLE schema_identity("),
        )!,
      );
      db.prepare(
        "INSERT INTO schema_identity SELECT singleton,product,?,?,created_at FROM import_identity",
      ).run(SCHEMA_VERSION, SCHEMA_FINGERPRINT);
      db.exec("DROP TABLE import_identity");
      const after = offlineTableCounts(db, refuse);
      for (const [table, count] of Object.entries(before))
        if (after[table] !== count) refuse();
      verifyOfflineLayout(db, SCHEMA_MANIFEST, refuse);
      if (db.prepare("PRAGMA foreign_key_check").all().length) refuse();
      db.exec("COMMIT");
      return {
        from_version: 15,
        to_version: SCHEMA_VERSION,
        before,
        after,
        foreign_key_violations: 0,
        elapsed_ms: performance.now() - started,
      };
    } catch (error) {
      if (db.isTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Record the cleanup failure without replacing the original error.
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
