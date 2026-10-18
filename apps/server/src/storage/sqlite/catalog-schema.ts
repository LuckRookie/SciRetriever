import {
  inspectProcessorCatalog,
  migrateProcessorCatalog,
} from "./processor-migration.js";
import {
  inspectArticleIdentityCatalog,
  migrateArticleIdentityCatalog,
} from "./article-identity-migration.js";
import { constants } from "node:fs";
import { link, mkdtemp, open, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { probeCatalogIdentity } from "../execution/migration-gate.js";
import { acquireCatalogWriteLock } from "../write-admission.js";
import {
  CatalogSchemaError,
  registerScopedBackup,
  schemaTargetFile,
  schemaTargetPath,
  verifyScopedBackup,
  withCatalogMigrationScope,
} from "./migration-scope.js";
import {
  inspectDocumentCatalog,
  migrateDocumentCatalog,
  publishRecoverableBackup,
} from "./document-migration.js";
import {
  inspectRetrievalCatalog,
  migrateRetrievalCatalog,
} from "./retrieval-migration.js";
import {
  inspectExtractionCatalog,
  migrateExtractionCatalog,
} from "./extraction-migration.js";
import {
  inspectKnowledgeCatalog,
  migrateKnowledgeCatalog,
} from "./knowledge-migration.js";
import {
  inspectSynthesisCatalog,
  migrateSynthesisCatalog,
} from "./synthesis-migration.js";
import {
  inspectKnowledgeRetrievalCatalog,
  migrateKnowledgeRetrievalCatalog,
} from "./knowledge-retrieval-migration.js";
import { SCHEMA_V10_FINGERPRINT, SCHEMA_V10_MANIFEST } from "./schema-v10.js";
import {
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_SCHEMA_VERSION,
} from "./execution-schema.js";

export { CatalogSchemaError } from "./migration-scope.js";
export type CatalogSchemaInspection = {
  readonly target_version: 10;
  readonly target_fingerprint: string;
} & (
  | {
      readonly status: "ready";
      readonly schema_version: number;
      readonly schema_fingerprint: string;
    }
  | {
      readonly status: "not-initialized";
      readonly schema_version: null;
      readonly schema_fingerprint: null;
    }
);
export interface CatalogSchemaResult {
  readonly action: "initialized" | "upgraded" | "already-v10" | "dry-run";
  readonly from_version: number | null;
  readonly to_version: 10;
  readonly completed_versions: readonly number[];
  readonly backup_path: string | null;
  readonly inspection: CatalogSchemaInspection;
}

/** Read-only operator inspection; it never initializes a worker or writes a lock. */
export async function inspectCatalogSchema(
  catalog: string,
): Promise<CatalogSchemaInspection> {
  await schemaTargetPath(catalog);
  const metadata = await schemaTargetFile(catalog);
  const target = {
    target_version: 10 as const,
    target_fingerprint: SCHEMA_V10_FINGERPRINT,
  };
  if (!metadata)
    return {
      ...target,
      status: "not-initialized",
      schema_version: null,
      schema_fingerprint: null,
    };
  try {
    const db = new DatabaseSync(catalog, { readOnly: true });
    try {
      db.exec("PRAGMA query_only=ON");
      if (
        db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" ||
        db.prepare("PRAGMA foreign_key_check").all().length
      )
        throw new CatalogSchemaError("catalog-integrity-failed");
    } finally {
      db.close();
    }
    const state = (await probeCatalogIdentity(catalog)).state;
    const inspection =
      state === "v1" || state === "v2" || state === "v3"
        ? await inspectDocumentCatalog(catalog)
        : state === "v4"
          ? await inspectRetrievalCatalog(catalog)
          : state === "v5"
            ? await inspectExtractionCatalog(catalog)
            : state === "v6"
              ? await inspectKnowledgeCatalog(catalog)
              : state === "v7"
                ? await inspectSynthesisCatalog(catalog)
                : state === "v8"
                  ? await inspectKnowledgeRetrievalCatalog(catalog)
                  : state === "v9"
                    ? await inspectArticleIdentityCatalog(catalog)
                    : state === "v10"
                      ? await inspectProcessorCatalog(catalog)
                      : null;
    if (!inspection) throw new CatalogSchemaError("catalog-unsupported");
    return {
      ...target,
      status: "ready",
      schema_version: inspection.schema_version,
      schema_fingerprint: inspection.schema_fingerprint,
    };
  } catch (error) {
    if (error instanceof CatalogSchemaError) throw error;
    throw new CatalogSchemaError("catalog-validation-failed", null, {
      cause: error,
    });
  }
}

async function inspectInitializedCatalog(catalog: string) {
  const inspection = await inspectCatalogSchema(catalog);
  if (inspection.status !== "ready")
    throw new CatalogSchemaError("catalog-missing");
  return inspection;
}

async function syncPath(path: string, directory = false): Promise<void> {
  const file = await open(
    path,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      (directory ? constants.O_DIRECTORY : 0),
  );
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Explicit creation only; the ordinary Application and Query behavior is unchanged. */
export async function initializeCatalogSchema(
  catalog: string,
  checkpoint?: (stage: "before-publish" | "published") => void | Promise<void>,
) {
  await schemaTargetPath(catalog);
  if (await schemaTargetFile(catalog))
    throw new CatalogSchemaError("catalog-already-exists");
  const lock = await acquireCatalogWriteLock(catalog);
  let staging: string | undefined;
  try {
    if (await schemaTargetFile(catalog))
      throw new CatalogSchemaError("catalog-already-exists");
    staging = await mkdtemp(join(dirname(catalog), ".sciretriever-init-"));
    const staged = join(staging, "catalog.sqlite");
    const reserved = await open(
      staged,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await reserved.close();
    const db = new DatabaseSync(staged);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.exec("PRAGMA synchronous=FULL");
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const sql of SCHEMA_V10_MANIFEST) db.exec(sql);
        db.prepare(
          "INSERT INTO schema_identity(singleton,product,schema_version,schema_fingerprint,created_at) VALUES(1,'sciretriever',10,?,?)",
        ).run(SCHEMA_V10_FINGERPRINT, new Date().toISOString());
        db.prepare(
          "INSERT INTO execution_schema_identity(singleton,version,fingerprint) VALUES(1,?,?)",
        ).run(EXECUTION_SCHEMA_VERSION, EXECUTION_SCHEMA_FINGERPRINT);
        db.prepare(
          "INSERT INTO execution_runtime_schema_identity(singleton,version,fingerprint) VALUES(1,?,?)",
        ).run(
          EXECUTION_RUNTIME_SCHEMA_VERSION,
          EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
        );
        db.exec(
          "INSERT INTO retrieval_source_revision(singleton,revision) VALUES(1,0)",
        );
        db.exec(
          "INSERT INTO knowledge_retrieval_source_revision(singleton,revision) VALUES(1,0)",
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
    const inspection = await inspectCatalogSchema(staged);
    await syncPath(staged);
    await syncPath(staging, true);
    await schemaTargetPath(catalog);
    await checkpoint?.("before-publish");
    // An occupied path is never opened or replaced, even if it raced the precheck.
    await link(staged, catalog);
    await syncPath(dirname(catalog), true);
    await unlink(staged);
    await syncPath(staging, true);
    const published = await inspectCatalogSchema(catalog);
    if (JSON.stringify(published) !== JSON.stringify(inspection))
      throw new CatalogSchemaError("catalog-publication-validation-failed");
    await checkpoint?.("published");
    return {
      action: "initialized" as const,
      from_version: null,
      to_version: 10 as const,
      completed_versions: [10],
      backup_path: null,
      inspection: published,
    } satisfies CatalogSchemaResult;
  } catch (error) {
    const current = await probeCatalogIdentity(catalog);
    throw new CatalogSchemaError(
      error instanceof CatalogSchemaError
        ? error.reason
        : "catalog-initialization-failed",
      {
        from_version: null,
        current_version: current.state === "v10" ? 10 : null,
        completed_versions: current.state === "v10" ? [10] : [],
        failed_step: 10,
        backup_path: null,
      },
      { cause: error },
    );
  } finally {
    try {
      if (staging) await rm(staging, { recursive: true, force: true });
    } finally {
      await lock.release();
    }
  }
}

/** Checkpoints are internal fault seams; CLI never accepts callbacks or scope tokens. */
export async function upgradeCatalogSchema(input: {
  readonly catalog_path: string;
  readonly backup_path?: string;
  readonly dry_run?: boolean;
  readonly checkpoint?: (
    version: number,
    stage:
      | "before-backup-publish"
      | "backed-up"
      | "before-commit"
      | "completed",
  ) => void | Promise<void>;
}): Promise<CatalogSchemaResult> {
  const catalog = await schemaTargetPath(input.catalog_path);
  const preliminary = await inspectCatalogSchema(catalog);
  if (preliminary.schema_version === null)
    throw new CatalogSchemaError("catalog-missing");
  if (input.dry_run)
    return {
      action: "dry-run",
      from_version: preliminary.schema_version,
      to_version: 10,
      completed_versions: [],
      backup_path: null,
      inspection: preliminary,
    };
  if (!input.backup_path) throw new CatalogSchemaError("backup-required");
  const backup = await schemaTargetPath(input.backup_path);
  return withCatalogMigrationScope(catalog, backup, async (scope) => {
    const before = await inspectInitializedCatalog(catalog);
    const from = before.schema_version;
    if (from === null) throw new CatalogSchemaError("catalog-missing");
    if (from === 10)
      return {
        action: "already-v10",
        from_version: 10,
        to_version: 10,
        completed_versions: [],
        backup_path: null,
        inspection: before,
      };
    const completed: number[] = [];
    let failedStep: number | null = null;
    let backupPublished = false;
    try {
      const db = new DatabaseSync(catalog);
      try {
        const dataVersion = () =>
          db.prepare("PRAGMA data_version").get()?.data_version;
        const initial = dataVersion();
        await publishRecoverableBackup(
          db,
          backup,
          before,
          inspectInitializedCatalog,
          (stage) => input.checkpoint?.(from, stage),
        );
        backupPublished = true;
        await registerScopedBackup(scope);
        if (dataVersion() !== initial)
          throw new CatalogSchemaError("catalog-changed-during-backup");
      } finally {
        db.close();
      }
      for (const [version, migrate] of [
        [3, migrateDocumentCatalog],
        [4, migrateRetrievalCatalog],
        [5, migrateExtractionCatalog],
        [6, migrateKnowledgeCatalog],
        [7, migrateSynthesisCatalog],
        [8, migrateKnowledgeRetrievalCatalog],
        [9, migrateArticleIdentityCatalog],
        [10, migrateProcessorCatalog],
      ] as const) {
        if (version <= from) continue;
        failedStep = version;
        await migrate({
          catalog_path: catalog,
          backup_path: backup,
          migration_scope: scope,
          checkpoint: (stage) => input.checkpoint?.(version, stage),
        });
        const inspection = await inspectCatalogSchema(catalog);
        if (inspection.schema_version !== version)
          throw new CatalogSchemaError("unexpected-migration-version");
        completed.push(version);
        await input.checkpoint?.(version, "completed");
      }
      await verifyScopedBackup(scope, backup);
      return {
        action: "upgraded",
        from_version: from,
        to_version: 10,
        completed_versions: completed,
        backup_path: backup,
        inspection: await inspectCatalogSchema(catalog),
      };
    } catch (error) {
      // Completed steps stay committed. No filesystem restore can safely erase
      // later facts; the operator receives the actually identifiable version.
      const current = await probeCatalogIdentity(catalog);
      throw new CatalogSchemaError(
        error instanceof CatalogSchemaError
          ? error.reason
          : "migration-step-failed",
        {
          from_version: from,
          current_version: /^v(?:[1-9]|10)$/.test(current.state)
            ? current.schema_version
            : null,
          completed_versions: [...completed],
          failed_step: failedStep,
          backup_path: backupPublished ? backup : null,
        },
        { cause: error },
      );
    }
  });
}
