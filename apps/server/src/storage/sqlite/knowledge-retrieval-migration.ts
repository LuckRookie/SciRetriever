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
import { inspectSynthesisCatalog } from "./synthesis-migration.js";
import {
  inspectCatalogWithRetrieval,
  inspectKnowledgeProjectionDdl,
  prepareRetrievalVocab,
  RetrievalStorageEngine,
} from "./retrieval-engine.js";
import {
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_SCHEMA_VERSION,
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
} from "./execution-schema.js";
import {
  KNOWLEDGE_RETRIEVAL_SCHEMA,
  SCHEMA_IDENTITY_V8,
  SCHEMA_V8_FINGERPRINT,
  SCHEMA_V8_MANIFEST,
} from "./schema-v8.js";

export class KnowledgeRetrievalMigrationError extends Error {
  constructor() {
    super("knowledge retrieval catalog migration refused");
  }
}
function fail(): never {
  throw new KnowledgeRetrievalMigrationError();
}
const config = {
  schema_version: 8 as const,
  schema_fingerprint: SCHEMA_V8_FINGERPRINT,
  schema_manifest: SCHEMA_V8_MANIFEST,
  execution_schema_version: EXECUTION_SCHEMA_VERSION,
  execution_schema_fingerprint: EXECUTION_SCHEMA_FINGERPRINT,
  execution_runtime_schema_version: EXECUTION_RUNTIME_SCHEMA_VERSION,
  execution_runtime_schema_fingerprint: EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
};
export async function inspectKnowledgeRetrievalCatalog(path: string) {
  const state = (await probeCatalogIdentity(path)).state;
  if (state === "v7") return inspectSynthesisCatalog(path);
  if (state !== "v8") fail();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    prepareRetrievalVocab(db);
    db.exec("PRAGMA query_only=ON");
    const result = inspectCatalogWithRetrieval(db, config);
    inspectKnowledgeProjectionDdl(db, config);
    if (
      (
        db.prepare("PRAGMA integrity_check").get() as
          | { integrity_check?: unknown }
          | undefined
      )?.integrity_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      fail();
    const projection = new RetrievalStorageEngine(path, true, config);
    try {
      projection.knowledgeActive();
    } finally {
      projection.close();
    }
    return result;
  } catch {
    return fail();
  } finally {
    db.close();
  }
}

export async function migrateKnowledgeRetrievalCatalog(input: {
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
    const inspection = await inspectKnowledgeRetrievalCatalog(catalog);
    return {
      action: "dry-run" as const,
      from_version: inspection.schema_version,
      to_version: 8 as const,
      backup_path: null,
      manifest_fingerprint: SCHEMA_V8_FINGERPRINT,
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
    const before = await inspectKnowledgeRetrievalCatalog(catalog);
    if (before.schema_version === 8)
      return {
        action: "already-v8" as const,
        from_version: 8 as const,
        to_version: 8 as const,
        backup_path: null,
        manifest_fingerprint: SCHEMA_V8_FINGERPRINT,
        inspection: before,
      };
    if (before.schema_version !== 7 || !input.backup_path?.startsWith("/"))
      fail();
    const backup = input.migration_scope
      ? await scopedBackupPath(input.migration_scope, input.backup_path)
      : await syntheticPath(input.backup_path);
    if (backup === catalog || dirname(backup) !== dirname(catalog)) fail();
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
        backup,
        before,
        inspectSynthesisCatalog,
        input.checkpoint,
        input.migration_scope,
      );
      await input.checkpoint?.("backed-up");
      if (dataVersion() !== initial) fail();
      db.exec("BEGIN IMMEDIATE");
      try {
        if (
          dataVersion() !== initial ||
          (await probeCatalogIdentity(catalog)).state !== "v7"
        )
          fail();
        for (const sql of KNOWLEDGE_RETRIEVAL_SCHEMA) db.exec(sql);
        db.prepare(
          "INSERT INTO knowledge_retrieval_source_revision(singleton,revision) VALUES(1,0)",
        ).run();
        const created = (
          db
            .prepare("SELECT created_at FROM schema_identity WHERE singleton=1")
            .get() as { created_at?: unknown } | undefined
        )?.created_at;
        if (typeof created !== "string") fail();
        db.exec("DROP TABLE schema_identity");
        db.exec(SCHEMA_IDENTITY_V8);
        db.prepare(
          "INSERT INTO schema_identity(singleton,product,schema_version,schema_fingerprint,created_at) VALUES(1,'sciretriever',8,?,?)",
        ).run(SCHEMA_V8_FINGERPRINT, created);
        db.prepare(
          "INSERT INTO knowledge_retrieval_schema_migrations(migration_id,from_version,to_version,manifest_fingerprint,applied_at) VALUES(?,7,8,?,?)",
        ).run(
          `catalog-v8-${randomUUID()}`,
          SCHEMA_V8_FINGERPRINT,
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
    const inspection = await inspectKnowledgeRetrievalCatalog(catalog);
    if (inspection.schema_version !== 8) fail();
    return {
      action: "migrated" as const,
      from_version: 7 as const,
      to_version: 8 as const,
      backup_path: backup,
      manifest_fingerprint: SCHEMA_V8_FINGERPRINT,
      inspection,
    };
  } finally {
    await lock.release();
  }
}
