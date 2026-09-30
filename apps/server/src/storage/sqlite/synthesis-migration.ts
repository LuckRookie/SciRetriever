import {
  authorizeScopedMigration,
  scopedBackupPath,
  scopedCatalogLock,
  scopedCatalogPath,
  type CatalogMigrationScope,
} from "./migration-scope.js";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  authorizeExecutionSchema,
  probeCatalogIdentity,
} from "../execution/migration-gate.js";
import { acquireCatalogWriteLock } from "../write-admission.js";
import {
  publishRecoverableBackup,
  syntheticPath,
} from "./document-migration.js";
import { inspectKnowledgeCatalog } from "./knowledge-migration.js";
import {
  inspectCatalogWithRetrieval,
  prepareRetrievalVocab,
} from "./retrieval-engine.js";
import {
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_SCHEMA_VERSION,
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
} from "./execution-schema.js";
import {
  KNOWLEDGE_ARTIFACT_V7,
  KNOWLEDGE_V7_MIGRATIONS,
  SCHEMA_IDENTITY_V7,
  SCHEMA_V7_FINGERPRINT,
  SCHEMA_V7_MANIFEST,
} from "./schema-v7.js";

export class SynthesisMigrationError extends Error {
  constructor() {
    super("synthesis catalog migration refused");
  }
}
function fail(): never {
  throw new SynthesisMigrationError();
}
const config = {
  schema_version: 7 as const,
  schema_fingerprint: SCHEMA_V7_FINGERPRINT,
  schema_manifest: SCHEMA_V7_MANIFEST,
  execution_schema_version: EXECUTION_SCHEMA_VERSION,
  execution_schema_fingerprint: EXECUTION_SCHEMA_FINGERPRINT,
  execution_runtime_schema_version: EXECUTION_RUNTIME_SCHEMA_VERSION,
  execution_runtime_schema_fingerprint: EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
};
export async function inspectSynthesisCatalog(path: string) {
  const state = (await probeCatalogIdentity(path)).state;
  if (state === "v6") return inspectKnowledgeCatalog(path);
  if (state !== "v7") fail();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    prepareRetrievalVocab(db);
    db.exec("PRAGMA query_only=ON");
    return inspectCatalogWithRetrieval(db, config);
  } catch {
    return fail();
  } finally {
    db.close();
  }
}

export async function migrateSynthesisCatalog(input: {
  readonly catalog_path: string;
  readonly backup_path?: string;
  readonly dry_run?: boolean;
  /** Internal scope issued by the explicit catalog schema operator. */
  readonly migration_scope?: CatalogMigrationScope;
  readonly checkpoint?: (
    stage: "before-backup-publish" | "backed-up" | "before-commit",
  ) => void | Promise<void>;
}) {
  const catalog = input.migration_scope
    ? await scopedCatalogPath(input.migration_scope, input.catalog_path)
    : await syntheticPath(input.catalog_path);
  if (input.dry_run) {
    const inspection = await inspectSynthesisCatalog(catalog);
    return {
      action: "dry-run" as const,
      from_version: inspection.schema_version,
      to_version: 7 as const,
      backup_path: null,
      manifest_fingerprint: SCHEMA_V7_FINGERPRINT,
      inspection,
    };
  }
  const lock = input.migration_scope
    ? await scopedCatalogLock(input.migration_scope, catalog)
    : await acquireCatalogWriteLock(catalog);
  try {
    const authorization = input.migration_scope
      ? await authorizeScopedMigration(input.migration_scope, catalog)
      : await authorizeExecutionSchema("upgrade-synthetic", {
          catalog_path: catalog,
        });
    if (!authorization.basis) fail();
    const before = await inspectSynthesisCatalog(catalog);
    if (before.schema_version === 7)
      return {
        action: "already-v7" as const,
        from_version: 7 as const,
        to_version: 7 as const,
        backup_path: null,
        manifest_fingerprint: SCHEMA_V7_FINGERPRINT,
        inspection: before,
      };
    if (before.schema_version !== 6 || !input.backup_path?.startsWith("/"))
      fail();
    const backupPath = input.migration_scope
      ? await scopedBackupPath(input.migration_scope, input.backup_path)
      : await syntheticPath(input.backup_path);
    if (backupPath === catalog || dirname(backupPath) !== dirname(catalog))
      fail();
    const db = new DatabaseSync(catalog);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.exec("PRAGMA busy_timeout=5000");
      const dataVersion = () =>
        Number(
          (db.prepare("PRAGMA data_version").get() as { data_version: number })
            .data_version,
        );
      const initial = dataVersion();
      await publishRecoverableBackup(
        db,
        backupPath,
        before,
        inspectKnowledgeCatalog,
        input.checkpoint,
        input.migration_scope,
      );
      await input.checkpoint?.("backed-up");
      if (dataVersion() !== initial) fail();
      // SQLite cannot ALTER a CHECK. Disable FKs on this connection only, then
      // rebuild the parent table in one transaction and verify every child FK.
      db.exec("PRAGMA foreign_keys=OFF");
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          if (
            dataVersion() !== initial ||
            (await probeCatalogIdentity(catalog)).state !== "v6"
          )
            fail();
          db.exec(
            "CREATE TEMP TABLE knowledge_artifacts_shadow AS SELECT * FROM knowledge_artifacts",
          );
          db.exec("DROP TABLE knowledge_artifacts");
          db.exec(KNOWLEDGE_ARTIFACT_V7);
          db.exec(
            "INSERT INTO knowledge_artifacts SELECT * FROM temp.knowledge_artifacts_shadow",
          );
          db.exec(
            "CREATE UNIQUE INDEX knowledge_artifacts_id_content ON knowledge_artifacts(artifact_id,content_sha256)",
          );
          const difference = db
            .prepare(
              "SELECT * FROM knowledge_artifacts EXCEPT SELECT * FROM temp.knowledge_artifacts_shadow",
            )
            .get();
          const missing = db
            .prepare(
              "SELECT * FROM temp.knowledge_artifacts_shadow EXCEPT SELECT * FROM knowledge_artifacts",
            )
            .get();
          if (difference || missing) fail();
          db.exec("DROP TABLE temp.knowledge_artifacts_shadow");
          const created = (
            db
              .prepare(
                "SELECT created_at FROM schema_identity WHERE singleton=1",
              )
              .get() as { created_at?: unknown } | undefined
          )?.created_at;
          if (typeof created !== "string") fail();
          db.exec("DROP TABLE schema_identity");
          db.exec(SCHEMA_IDENTITY_V7);
          db.prepare(
            "INSERT INTO schema_identity(singleton,product,schema_version,schema_fingerprint,created_at) VALUES(1,'sciretriever',7,?,?)",
          ).run(SCHEMA_V7_FINGERPRINT, created);
          db.exec(KNOWLEDGE_V7_MIGRATIONS);
          db.prepare(
            "INSERT INTO knowledge_v7_migrations(migration_id,from_version,to_version,manifest_fingerprint,applied_at) VALUES(?,6,7,?,?)",
          ).run(
            `catalog-v7-${randomUUID()}`,
            SCHEMA_V7_FINGERPRINT,
            new Date().toISOString(),
          );
          if (
            db.prepare("PRAGMA foreign_key_check").all().length ||
            (
              db.prepare("PRAGMA integrity_check").get() as
                | { integrity_check?: unknown }
                | undefined
            )?.integrity_check !== "ok"
          )
            fail();
          await input.checkpoint?.("before-commit");
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } finally {
        db.exec("PRAGMA foreign_keys=ON");
      }
    } finally {
      db.close();
    }
    const inspection = await inspectSynthesisCatalog(catalog);
    if (inspection.schema_version !== 7) fail();
    return {
      action: "migrated" as const,
      from_version: 6 as const,
      to_version: 7 as const,
      backup_path: backupPath,
      manifest_fingerprint: SCHEMA_V7_FINGERPRINT,
      inspection,
    };
  } finally {
    await lock.release();
  }
}
