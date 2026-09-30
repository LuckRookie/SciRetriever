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
import { inspectRetrievalCatalog } from "./retrieval-migration.js";
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
  SCHEMA_V5_FINGERPRINT,
  SCHEMA_V5_MANIFEST,
  SCHEMA_IDENTITY_V5,
  EXTRACTION_SCHEMA,
} from "./schema-v5.js";
import { ExtractionMigrationError } from "./extraction-migration-error.js";

export { ExtractionMigrationError } from "./extraction-migration-error.js";
function fail(): never {
  throw new ExtractionMigrationError();
}
const config = {
  schema_version: 5 as const,
  schema_fingerprint: SCHEMA_V5_FINGERPRINT,
  schema_manifest: SCHEMA_V5_MANIFEST,
  execution_schema_version: EXECUTION_SCHEMA_VERSION,
  execution_schema_fingerprint: EXECUTION_SCHEMA_FINGERPRINT,
  execution_runtime_schema_version: EXECUTION_RUNTIME_SCHEMA_VERSION,
  execution_runtime_schema_fingerprint: EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
};
export async function inspectExtractionCatalog(path: string) {
  const state = (await probeCatalogIdentity(path)).state;
  if (state === "v4") return inspectRetrievalCatalog(path);
  if (state !== "v5") fail();
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
export async function migrateExtractionCatalog(input: {
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
    const inspection = await inspectExtractionCatalog(catalog);
    return {
      action: "dry-run" as const,
      from_version: inspection.schema_version,
      to_version: 5 as const,
      backup_path: null,
      manifest_fingerprint: SCHEMA_V5_FINGERPRINT,
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
    const before = await inspectExtractionCatalog(catalog);
    if (before.schema_version === 5)
      return {
        action: "already-v5" as const,
        from_version: 5 as const,
        to_version: 5 as const,
        backup_path: null,
        manifest_fingerprint: SCHEMA_V5_FINGERPRINT,
        inspection: before,
      };
    if (before.schema_version !== 4 || !input.backup_path?.startsWith("/"))
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
        inspectRetrievalCatalog,
        input.checkpoint,
        input.migration_scope,
      );
      await input.checkpoint?.("backed-up");
      if (dataVersion() !== initial) fail();
      db.exec("BEGIN IMMEDIATE");
      try {
        if (
          dataVersion() !== initial ||
          (await probeCatalogIdentity(catalog)).state !== "v4"
        )
          fail();
        for (const sql of EXTRACTION_SCHEMA) db.exec(sql);
        const created = (
          db
            .prepare("SELECT created_at FROM schema_identity WHERE singleton=1")
            .get() as { created_at?: unknown } | undefined
        )?.created_at;
        if (typeof created !== "string") fail();
        db.exec("DROP TABLE schema_identity");
        db.exec(SCHEMA_IDENTITY_V5);
        db.prepare(
          "INSERT INTO schema_identity(singleton,product,schema_version,schema_fingerprint,created_at) VALUES(1,'sciretriever',5,?,?)",
        ).run(SCHEMA_V5_FINGERPRINT, created);
        db.prepare(
          "INSERT INTO extraction_schema_migrations(migration_id,from_version,to_version,manifest_fingerprint,applied_at) VALUES(?,4,5,?,?)",
        ).run(
          `catalog-v5-${randomUUID()}`,
          SCHEMA_V5_FINGERPRINT,
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
    const inspection = await inspectExtractionCatalog(catalog);
    if (inspection.schema_version !== 5) fail();
    return {
      action: "migrated" as const,
      from_version: 4 as const,
      to_version: 5 as const,
      backup_path: backupPath,
      manifest_fingerprint: SCHEMA_V5_FINGERPRINT,
      inspection,
    };
  } finally {
    await lock.release();
  }
}
