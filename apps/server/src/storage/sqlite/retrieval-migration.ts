import {
  authorizeScopedMigration,
  scopedBackupPath,
  scopedCatalogLock,
  scopedCatalogPath,
  type CatalogMigrationScope,
} from "./migration-scope.js";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  authorizeExecutionSchema,
  probeCatalogIdentity,
} from "../execution/migration-gate.js";
import { acquireCatalogWriteLock } from "../write-admission.js";
import { inspectV4, prepareRetrievalVocab } from "./retrieval-engine.js";
import {
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_SCHEMA_VERSION,
} from "./execution-schema.js";
import {
  inspectDocumentCatalog,
  publishRecoverableBackup,
  syntheticPath,
} from "./document-migration.js";
import {
  RETRIEVAL_SCHEMA,
  SCHEMA_IDENTITY_V4,
  SCHEMA_V4_FINGERPRINT,
  SCHEMA_V4_MANIFEST,
} from "./schema-v4.js";

const RETRIEVAL_SCHEMA_CONFIG = {
  schema_fingerprint: SCHEMA_V4_FINGERPRINT,
  schema_manifest: SCHEMA_V4_MANIFEST,
  execution_schema_version: EXECUTION_SCHEMA_VERSION,
  execution_schema_fingerprint: EXECUTION_SCHEMA_FINGERPRINT,
  execution_runtime_schema_version: EXECUTION_RUNTIME_SCHEMA_VERSION,
  execution_runtime_schema_fingerprint: EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
} as const;

export class RetrievalMigrationError extends Error {
  readonly code = "retrieval-migration" as const;
  constructor() {
    super("retrieval migration refused");
  }
}
export interface RetrievalCatalogInspection {
  readonly schema_version: 3 | 4;
  readonly schema_fingerprint: string;
  readonly integrity: "ok";
  readonly foreign_keys: "ok";
  readonly source_revision: number | null;
  readonly active_generation: string | null;
}
function fail(): never {
  throw new RetrievalMigrationError();
}
export async function inspectRetrievalCatalog(
  path: string,
): Promise<RetrievalCatalogInspection> {
  const state = (await probeCatalogIdentity(path)).state;
  if (state === "v3") {
    const result = await inspectDocumentCatalog(path);
    return {
      schema_version: 3,
      schema_fingerprint: result.schema_fingerprint,
      integrity: "ok",
      foreign_keys: "ok",
      source_revision: null,
      active_generation: null,
    };
  }
  if (state !== "v4") fail();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    prepareRetrievalVocab(db);
    db.exec("PRAGMA query_only=ON");
    return inspectV4(db, RETRIEVAL_SCHEMA_CONFIG);
  } catch {
    return fail();
  } finally {
    db.close();
  }
}
export async function migrateRetrievalCatalog(input: {
  readonly catalog_path: string;
  readonly backup_path?: string;
  readonly dry_run?: boolean;
  /** Internal scope issued by the explicit catalog schema operator. */
  readonly migration_scope?: CatalogMigrationScope;
  readonly checkpoint?: (
    stage: "before-backup-publish" | "backed-up" | "before-commit",
  ) => void | Promise<void>;
}): Promise<{
  readonly action: "dry-run" | "migrated" | "already-v4";
  readonly from_version: 3 | 4;
  readonly to_version: 4;
  readonly manifest_fingerprint: string;
  readonly backup_path: string | null;
  readonly inspection: RetrievalCatalogInspection;
}> {
  const catalog = input.migration_scope
    ? await scopedCatalogPath(input.migration_scope, input.catalog_path)
    : await syntheticPath(input.catalog_path);
  if (input.dry_run) {
    const inspection = await inspectRetrievalCatalog(catalog);
    return {
      action: "dry-run",
      from_version: inspection.schema_version,
      to_version: 4,
      manifest_fingerprint: SCHEMA_V4_FINGERPRINT,
      backup_path: null,
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
    const before = await inspectRetrievalCatalog(catalog);
    if (before.schema_version === 4)
      return {
        action: "already-v4",
        from_version: 4,
        to_version: 4,
        manifest_fingerprint: SCHEMA_V4_FINGERPRINT,
        backup_path: null,
        inspection: before,
      };
    if (!input.backup_path?.startsWith("/")) fail();
    const backup = input.migration_scope
      ? await scopedBackupPath(input.migration_scope, input.backup_path)
      : await syntheticPath(input.backup_path);
    if (
      backup === catalog ||
      backup.slice(0, backup.lastIndexOf("/")) !==
        catalog.slice(0, catalog.lastIndexOf("/"))
    )
      fail();
    const documentInspection = await inspectDocumentCatalog(catalog);
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
        documentInspection,
        inspectDocumentCatalog,
        input.checkpoint,
        input.migration_scope,
      );
      await input.checkpoint?.("backed-up");
      if (dataVersion() !== initial) fail();
      db.exec("BEGIN IMMEDIATE");
      try {
        if (
          dataVersion() !== initial ||
          (await probeCatalogIdentity(catalog)).state !== "v3"
        )
          fail();
        for (const sql of RETRIEVAL_SCHEMA) db.exec(sql);
        db.prepare(
          "INSERT INTO retrieval_source_revision(singleton,revision) VALUES(1,0)",
        ).run();
        const created = (
          db
            .prepare("SELECT created_at FROM schema_identity WHERE singleton=1")
            .get() as { created_at?: unknown } | undefined
        )?.created_at;
        if (typeof created !== "string") fail();
        db.exec("DROP TABLE schema_identity");
        db.exec(SCHEMA_IDENTITY_V4);
        db.prepare(
          "INSERT INTO schema_identity(singleton,product,schema_version,schema_fingerprint,created_at) VALUES(1,'sciretriever',4,?,?)",
        ).run(SCHEMA_V4_FINGERPRINT, created);
        db.prepare(
          "INSERT INTO retrieval_schema_migrations(migration_id,from_version,to_version,manifest_fingerprint,applied_at) VALUES(?,3,4,?,?)",
        ).run(
          `catalog-v4-${randomUUID()}`,
          SCHEMA_V4_FINGERPRINT,
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
    const inspection = await inspectRetrievalCatalog(catalog);
    return {
      action: "migrated",
      from_version: 3,
      to_version: 4,
      manifest_fingerprint: SCHEMA_V4_FINGERPRINT,
      backup_path: backup,
      inspection,
    };
  } finally {
    await lock.release();
  }
}
