import { constants } from "node:fs";
import { chmod, link, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireCatalogWriteLock } from "../write-admission.js";
import {
  CURRENT_CATALOG_CONFIG,
  initializeCurrentCatalog,
} from "./catalog-layout.js";
import {
  inspectCatalogWithRetrieval,
  prepareRetrievalVocab,
} from "./retrieval-engine.js";
import {
  CatalogSchemaError,
  schemaTargetFile,
  schemaTargetPath,
} from "./schema-path.js";
import { SCHEMA_FINGERPRINT, SCHEMA_VERSION } from "./schema.js";
import { readCatalogIdentity, CatalogLayoutError } from "./catalog-identity.js";
import { throwCatalogCorruption } from "./errors.js";
export { CatalogSchemaError } from "./schema-path.js";

export interface CatalogSchemaInspection {
  readonly target_version: typeof SCHEMA_VERSION;
  readonly target_fingerprint: string;
  readonly status: "ready" | "not-initialized";
  readonly schema_version: number | null;
  readonly schema_fingerprint: string | null;
}
export interface CatalogSchemaResult {
  readonly action: "initialized";
  readonly to_version: typeof SCHEMA_VERSION;
  readonly inspection: CatalogSchemaInspection;
}
/** Startup only asks whether initialization is needed, never whether data is healthy. */
export async function catalogNeedsInitialization(
  path: string,
): Promise<boolean> {
  await schemaTargetPath(path);
  if (!(await schemaTargetFile(path))) return true;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // An existing catalog must already name the current layout: refuse it
    // here, read-only, before anything opens it for writing.
    return !readCatalogIdentity(db, CURRENT_CATALOG_CONFIG);
  } catch (error) {
    throwCatalogCorruption(error);
    if (error instanceof CatalogLayoutError)
      throw new CatalogSchemaError(error.reason, { cause: error });
    throw new CatalogSchemaError("catalog-layout-not-current", {
      cause: error,
    });
  } finally {
    db.close();
  }
}
export async function inspectCatalogSchema(
  path: string,
): Promise<CatalogSchemaInspection> {
  await schemaTargetPath(path);
  const target = {
    target_version: SCHEMA_VERSION,
    target_fingerprint: SCHEMA_FINGERPRINT,
  };
  if (!(await schemaTargetFile(path)))
    return {
      ...target,
      status: "not-initialized",
      schema_version: null,
      schema_fingerprint: null,
    };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const result = readCatalogIdentity(db, CURRENT_CATALOG_CONFIG);
    if (!result)
      return {
        ...target,
        status: "not-initialized",
        schema_version: null,
        schema_fingerprint: null,
      };
    // Explicit inspection retains full health checks. Web startup uses only
    // the empty-target probe and delegates supported-layout checks to Application.
    prepareRetrievalVocab(db);
    db.exec("PRAGMA query_only=ON");
    inspectCatalogWithRetrieval(db, CURRENT_CATALOG_CONFIG);
    return {
      ...target,
      status: "ready",
      schema_version: Number(result.schema_version),
      schema_fingerprint: String(result.schema_fingerprint),
    };
  } catch (error) {
    throwCatalogCorruption(error);
    if (error instanceof CatalogSchemaError) throw error;
    if (error instanceof CatalogLayoutError)
      throw new CatalogSchemaError(error.reason, { cause: error });
    throw new CatalogSchemaError("catalog-integrity-refused", { cause: error });
  } finally {
    db.close();
  }
}

export async function initializeCatalogSchema(
  path: string,
  checkpoint?: (stage: "before-publish" | "published") => void | Promise<void>,
): Promise<CatalogSchemaResult> {
  const catalog = await schemaTargetPath(path);
  const lock = await acquireCatalogWriteLock(catalog);
  let staging: string | undefined;
  try {
    if (await schemaTargetFile(catalog))
      throw new CatalogSchemaError("catalog-target-exists");
    staging = await mkdtemp(join(dirname(catalog), ".sciretriever-init-"));
    const pending = join(staging, "catalog.sqlite");
    const db = new DatabaseSync(pending);
    try {
      db.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL");
      initializeCurrentCatalog(db);
    } finally {
      db.close();
    }
    await chmod(pending, 0o600);
    await inspectCatalogSchema(pending);
    const file = await open(pending, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await checkpoint?.("before-publish");
    await link(pending, catalog);
    // Remove our second hard link before inspecting the public file.
    await rm(pending);
    const directory = await open(
      dirname(catalog),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await checkpoint?.("published");
    return {
      action: "initialized",
      to_version: SCHEMA_VERSION,
      inspection: await inspectCatalogSchema(catalog),
    };
  } finally {
    try {
      if (staging) await rm(staging, { recursive: true, force: true });
    } finally {
      await lock.release();
    }
  }
}

export async function inspectCatalogRetrieval(path: string) {
  await schemaTargetPath(path);
  if (!(await schemaTargetFile(path)))
    throw new CatalogSchemaError("catalog-not-initialized");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    prepareRetrievalVocab(db);
    db.exec("PRAGMA query_only=ON");
    return inspectCatalogWithRetrieval(db, CURRENT_CATALOG_CONFIG);
  } catch (cause) {
    throw new CatalogSchemaError("catalog-integrity-refused", { cause });
  } finally {
    db.close();
  }
}
