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
import { inspectExtractionCatalog } from "./extraction-migration.js";
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
  SCHEMA_V6_FINGERPRINT,
  SCHEMA_V6_MANIFEST,
  SCHEMA_IDENTITY_V6,
  KNOWLEDGE_SCHEMA,
} from "./schema-v6.js";
import { KnowledgeMigrationError } from "./knowledge-migration-error.js";

export { KnowledgeMigrationError } from "./knowledge-migration-error.js";
function fail(): never {
  throw new KnowledgeMigrationError();
}
const config = {
  schema_version: 6 as const,
  schema_fingerprint: SCHEMA_V6_FINGERPRINT,
  schema_manifest: SCHEMA_V6_MANIFEST,
  execution_schema_version: EXECUTION_SCHEMA_VERSION,
  execution_schema_fingerprint: EXECUTION_SCHEMA_FINGERPRINT,
  execution_runtime_schema_version: EXECUTION_RUNTIME_SCHEMA_VERSION,
  execution_runtime_schema_fingerprint: EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
};
export async function inspectKnowledgeCatalog(path: string) {
  const state = (await probeCatalogIdentity(path)).state;
  if (state === "v5") return inspectExtractionCatalog(path);
  if (state !== "v6") fail();
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
export async function migrateKnowledgeCatalog(input: {
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
    const inspection = await inspectKnowledgeCatalog(catalog);
    return {
      action: "dry-run" as const,
      from_version: inspection.schema_version,
      to_version: 6 as const,
      backup_path: null,
      manifest_fingerprint: SCHEMA_V6_FINGERPRINT,
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
    const before = await inspectKnowledgeCatalog(catalog);
    if (before.schema_version === 6)
      return {
        action: "already-v6" as const,
        from_version: 6 as const,
        to_version: 6 as const,
        backup_path: null,
        manifest_fingerprint: SCHEMA_V6_FINGERPRINT,
        inspection: before,
      };
    if (before.schema_version !== 5 || !input.backup_path?.startsWith("/"))
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
        inspectExtractionCatalog,
        input.checkpoint,
        input.migration_scope,
      );
      await input.checkpoint?.("backed-up");
      if (dataVersion() !== initial) fail();
      db.exec("BEGIN IMMEDIATE");
      try {
        if (
          dataVersion() !== initial ||
          (await probeCatalogIdentity(catalog)).state !== "v5"
        )
          fail();
        for (const sql of KNOWLEDGE_SCHEMA) db.exec(sql);
        const created = (
          db
            .prepare("SELECT created_at FROM schema_identity WHERE singleton=1")
            .get() as { created_at?: unknown } | undefined
        )?.created_at;
        if (typeof created !== "string") fail();
        db.exec("DROP TABLE schema_identity");
        db.exec(SCHEMA_IDENTITY_V6);
        db.prepare(
          "INSERT INTO schema_identity(singleton,product,schema_version,schema_fingerprint,created_at) VALUES(1,'sciretriever',6,?,?)",
        ).run(SCHEMA_V6_FINGERPRINT, created);
        db.prepare(
          "INSERT INTO knowledge_schema_migrations(migration_id,from_version,to_version,manifest_fingerprint,applied_at) VALUES(?,5,6,?,?)",
        ).run(
          `catalog-v6-${randomUUID()}`,
          SCHEMA_V6_FINGERPRINT,
          new Date().toISOString(),
        );
        await input.checkpoint?.("before-commit");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
    const inspection = await inspectKnowledgeCatalog(catalog);
    if (inspection.schema_version !== 6) fail();
    return {
      action: "migrated" as const,
      from_version: 5 as const,
      to_version: 6 as const,
      backup_path: backupPath,
      manifest_fingerprint: SCHEMA_V6_FINGERPRINT,
      inspection,
    };
  } finally {
    await lock.release();
  }
}
