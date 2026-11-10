import { DatabaseSync } from "node:sqlite";
import { acquireCatalogWriteLock } from "../write-admission.js";
import { schemaTargetFile, schemaTargetPath } from "./schema-path.js";
import {
  offlineTableCounts,
  verifyOfflineLayout,
} from "./archive-schema-migration.js";
import {
  SCHEMA_MANIFEST_V15,
  SCHEMA_FINGERPRINT_V15,
  SCHEMA_MANIFEST,
  SCHEMA_FINGERPRINT,
  SCHEMA_VERSION,
  IMPORT_SCHEMA_V16,
} from "./schema.js";
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
      for (const sql of IMPORT_SCHEMA_V16) db.exec(sql);
      // Future 03/08 data backfills belong here, in the same atomic migration.
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
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db?.close();
    await lock.release();
  }
}
