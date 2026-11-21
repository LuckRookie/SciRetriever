import { DatabaseSync } from "node:sqlite";
import { createLogger } from "../../logging/index.js";
import { acquireCatalogWriteLock } from "../write-admission.js";
import { schemaTargetFile, schemaTargetPath } from "./schema-path.js";
import {
  offlineTableCounts,
  verifyOfflineLayout,
} from "./archive-schema-migration.js";
import {
  SCHEMA_MANIFEST_V18,
  SCHEMA_FINGERPRINT_V18,
  SCHEMA_MANIFEST_V19,
  SCHEMA_FINGERPRINT_V19,
} from "./schema.js";
import {
  EXECUTION_SCHEMA_VERSION,
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
} from "./execution-schema.js";

function refuse(): never {
  throw Object.assign(new Error("citation limits schema migration refused"), {
    code: "citation-limits-schema-migration-refused",
  });
}

/** Explicit offline 18 -> 19; catalog open never invokes this migration. */
export async function migrateCitationLimitsSchema(path: string) {
  await schemaTargetPath(path);
  if (!(await schemaTargetFile(path))) refuse();
  const lock = await acquireCatalogWriteLock(path);
  const started = performance.now();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    // Both tables have incoming FKs. SQLite's table rebuild protocol disables
    // enforcement before BEGIN, then validates all FKs before the atomic commit.
    db.exec(
      "PRAGMA foreign_keys=OFF;PRAGMA busy_timeout=0;PRAGMA synchronous=FULL",
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      verifyOfflineLayout(db, SCHEMA_MANIFEST_V18, refuse);
      const identity = db.prepare("SELECT * FROM schema_identity").get();
      const execution = db
        .prepare("SELECT * FROM execution_schema_identity")
        .get();
      const runtime = db
        .prepare("SELECT * FROM execution_runtime_schema_identity")
        .get();
      if (
        identity?.schema_version !== 18 ||
        identity.schema_fingerprint !== SCHEMA_FINGERPRINT_V18 ||
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
      db.exec(
        "CREATE TEMP TABLE citation_limits_inputs AS SELECT * FROM citation_discovery_inputs",
      );
      db.exec(
        "CREATE TEMP TABLE citation_limits_providers AS SELECT * FROM discovery_run_providers",
      );
      for (const table of [
        "citation_discovery_inputs",
        "discovery_run_providers",
      ]) {
        db.exec(`DROP TABLE ${table}`);
        db.exec(
          SCHEMA_MANIFEST_V19.find((sql) =>
            sql.startsWith(`CREATE TABLE ${table}(`),
          )!,
        );
      }
      db.exec(
        "INSERT INTO citation_discovery_inputs SELECT * FROM citation_limits_inputs",
      );
      db.exec(
        "INSERT INTO discovery_run_providers(discovery_run_id,provider_ordinal,provider_name,scan_limit,kind) SELECT p.discovery_run_id,p.provider_ordinal,p.provider_name,p.scan_limit,r.kind FROM citation_limits_providers p JOIN discovery_runs r ON r.discovery_run_id=p.discovery_run_id",
      );
      for (const [saved, current] of [
        ["citation_limits_inputs", "SELECT * FROM citation_discovery_inputs"],
        [
          "citation_limits_providers",
          "SELECT discovery_run_id,provider_ordinal,provider_name,scan_limit FROM discovery_run_providers",
        ],
      ]) {
        if (
          db.prepare(`SELECT * FROM ${saved} EXCEPT ${current}`).get() ||
          db.prepare(`${current} EXCEPT SELECT * FROM ${saved}`).get()
        )
          refuse();
        db.exec(`DROP TABLE ${saved}`);
      }
      db.exec(
        "CREATE TEMP TABLE citation_limits_identity AS SELECT * FROM schema_identity;DROP TABLE schema_identity",
      );
      db.exec(
        SCHEMA_MANIFEST_V19.find((sql) =>
          sql.startsWith("CREATE TABLE schema_identity("),
        )!,
      );
      db.prepare(
        "INSERT INTO schema_identity SELECT singleton,product,19,?,created_at FROM citation_limits_identity",
      ).run(SCHEMA_FINGERPRINT_V19);
      db.exec("DROP TABLE citation_limits_identity");
      const after = offlineTableCounts(db, refuse);
      for (const [table, count] of Object.entries(before))
        if (after[table] !== count) refuse();
      verifyOfflineLayout(db, SCHEMA_MANIFEST_V19, refuse);
      if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
        refuse();
      db.exec("COMMIT;PRAGMA foreign_keys=ON");
      return {
        from_version: 18,
        to_version: 19,
        schema_fingerprint: SCHEMA_FINGERPRINT_V19,
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
