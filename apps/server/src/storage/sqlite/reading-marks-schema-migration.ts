import { DatabaseSync } from "node:sqlite";
import { acquireCatalogWriteLock } from "../write-admission.js";
import { schemaTargetFile, schemaTargetPath } from "./schema-path.js";
import {
  verifyOfflineLayout,
  offlineTableCounts,
} from "./archive-schema-migration.js";
import {
  READING_MARKS_SCHEMA,
  SCHEMA_FINGERPRINT,
  SCHEMA_FINGERPRINT_V13,
  SCHEMA_MANIFEST,
  SCHEMA_MANIFEST_V13,
  SCHEMA_VERSION,
} from "./schema.js";

function refuse(): never {
  throw Object.assign(new Error("reading marks schema migration refused"), {
    code: "reading-marks-schema-migration-refused",
  });
}
/**
 * Explicit offline 13 -> 14: adds the empty reading-marks table. Every
 * existing row is kept; opening a catalog never invokes this.
 */
export async function migrateReadingMarksSchema(path: string) {
  await schemaTargetPath(path);
  if (!(await schemaTargetFile(path))) refuse();
  const lock = await acquireCatalogWriteLock(path);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec(
      "PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL",
    );
    const identity = db
      .prepare("SELECT * FROM schema_identity WHERE singleton=1")
      .get();
    if (
      identity?.product !== "sciretriever" ||
      identity.schema_version !== 13 ||
      identity.schema_fingerprint !== SCHEMA_FINGERPRINT_V13
    )
      refuse();
    verifyOfflineLayout(db, SCHEMA_MANIFEST_V13, refuse);
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
      for (const sql of READING_MARKS_SCHEMA) db.exec(sql);
      // The identity table's CHECK names the version, so it is rebuilt.
      db.exec(
        "CREATE TEMP TABLE migration_marks_identity AS SELECT * FROM schema_identity; DROP TABLE schema_identity",
      );
      db.exec(
        SCHEMA_MANIFEST.find((sql) =>
          sql.startsWith("CREATE TABLE schema_identity("),
        )!,
      );
      db.prepare(
        "INSERT INTO schema_identity SELECT singleton,product,?,?,created_at FROM migration_marks_identity",
      ).run(SCHEMA_VERSION, SCHEMA_FINGERPRINT);
      db.exec("DROP TABLE migration_marks_identity");
      verifyOfflineLayout(db, SCHEMA_MANIFEST, refuse);
      const after = offlineTableCounts(db, refuse);
      if (
        Object.keys(before).some((table) => before[table] !== after[table]) ||
        after.reading_marks !== 0
      )
        refuse();
      if (db.prepare("PRAGMA foreign_key_check").all().length) refuse();
      db.exec("COMMIT");
      return {
        from_version: 13,
        to_version: SCHEMA_VERSION,
        before,
        after,
        foreign_key_violations: 0,
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
