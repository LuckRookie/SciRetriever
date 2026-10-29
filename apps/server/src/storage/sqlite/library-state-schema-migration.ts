import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { acquireCatalogWriteLock } from "../write-admission.js";
import { schemaTargetFile, schemaTargetPath } from "./schema-path.js";
import {
  verifyOfflineLayout,
  offlineTableCounts,
} from "./archive-schema-migration.js";
import {
  LIBRARY_STATE_PREVIOUS_FINGERPRINT,
  libraryStatePreviousManifest,
} from "./library-state-previous-layout.js";
import {
  LIBRARY_STATE_SCHEMA,
  SCHEMA_MANIFEST_V13 as SCHEMA_MANIFEST,
  SCHEMA_FINGERPRINT_V13 as SCHEMA_FINGERPRINT,
} from "./schema.js";

/** This migration always produces the frozen v13 layout; 13 -> 14 is a separate step. */
const SCHEMA_VERSION = 13;

function refuse(): never {
  throw Object.assign(new Error("library state schema migration refused"), {
    code: "library-state-schema-migration-refused",
  });
}
/** Explicit offline 12 -> 13. Opening never invokes this migration. */
export async function migrateLibraryStateSchema(path: string) {
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
      identity.schema_version !== 12 ||
      identity.schema_fingerprint !== LIBRARY_STATE_PREVIOUS_FINGERPRINT ||
      createHash("sha256")
        .update(JSON.stringify(libraryStatePreviousManifest))
        .digest("hex") !== LIBRARY_STATE_PREVIOUS_FINGERPRINT
    )
      refuse();
    verifyOfflineLayout(db, libraryStatePreviousManifest, refuse);
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
      for (const sql of libraryStatePreviousManifest)
        if (sql.startsWith("CREATE TRIGGER library_state_"))
          db.exec(`DROP TRIGGER ${/^CREATE TRIGGER (\w+)/u.exec(sql)![1]}`);
      db.exec(
        "CREATE TEMP TABLE migration_library_revision AS SELECT * FROM library_state_revision; DROP TABLE library_state_revision",
      );
      for (const sql of LIBRARY_STATE_SCHEMA) db.exec(sql);
      db.exec(
        "INSERT INTO library_state_revision SELECT singleton,revision,revision,revision FROM migration_library_revision; DROP TABLE migration_library_revision",
      );
      db.exec(
        "CREATE TEMP TABLE migration_library_identity AS SELECT * FROM schema_identity; DROP TABLE schema_identity",
      );
      db.exec(
        SCHEMA_MANIFEST.find((sql) =>
          sql.startsWith("CREATE TABLE schema_identity("),
        )!,
      );
      db.prepare(
        "INSERT INTO schema_identity SELECT singleton,product,?,?,created_at FROM migration_library_identity",
      ).run(SCHEMA_VERSION, SCHEMA_FINGERPRINT);
      db.exec("DROP TABLE migration_library_identity");
      verifyOfflineLayout(db, SCHEMA_MANIFEST, refuse);
      const after = offlineTableCounts(db, refuse);
      if (
        Object.keys(before).some((table) => before[table] !== after[table]) ||
        after.library_state_changes !== 0
      )
        refuse();
      db.exec("COMMIT");
      return {
        from_version: 12,
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
