import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { acquireCatalogWriteLock } from "../write-admission.js";
import { probeCatalogIdentity } from "../execution/migration-gate.js";

export class CatalogSchemaError extends Error {
  readonly code = "catalog-schema-refused" as const;
  constructor(
    readonly reason: string,
    readonly progress: {
      readonly from_version: number | null;
      readonly current_version: number | null;
      readonly completed_versions: readonly number[];
      readonly failed_step: number | null;
      readonly backup_path: string | null;
    } | null = null,
    options?: ErrorOptions,
  ) {
    super("catalog schema operation refused", options);
  }
}

/** Internal only: a live scope belongs to the owner holding the catalog flock. */
export interface CatalogMigrationScope {
  readonly catalog_path: string;
}
interface ScopeState {
  readonly catalog: Stats;
  readonly backup_path: string;
  backup_sha256: string | null;
  active: boolean;
}
const scopes = new WeakMap<CatalogMigrationScope, ScopeState>();

export async function schemaTargetPath(path: string): Promise<string> {
  if (!path.startsWith("/") || resolve(path) !== path || dirname(path) === path)
    throw new CatalogSchemaError("target-path-unsafe");
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const metadata = await lstat(parent);
    if (!metadata.isDirectory())
      throw new CatalogSchemaError("target-path-unsafe");
    if (parent === "/") break;
  }
  return path;
}

export async function schemaTargetFile(path: string): Promise<Stats | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.nlink !== 1)
      throw new CatalogSchemaError("target-file-unsafe");
    return metadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertScope(
  scope: CatalogMigrationScope,
  catalog: string,
): Promise<ScopeState> {
  const state = scopes.get(scope);
  if (!state?.active || scope.catalog_path !== catalog)
    throw new CatalogSchemaError("migration-scope-expired");
  await schemaTargetPath(catalog);
  const current = await schemaTargetFile(catalog);
  if (
    !current ||
    state.catalog.dev !== current.dev ||
    state.catalog.ino !== current.ino
  )
    throw new CatalogSchemaError("catalog-target-changed");
  return state;
}

export async function scopedCatalogPath(
  scope: CatalogMigrationScope,
  path: string,
): Promise<string> {
  await assertScope(scope, path);
  return path;
}

export async function scopedCatalogLock(
  scope: CatalogMigrationScope,
  path: string,
): Promise<{ release(): Promise<void> }> {
  await assertScope(scope, path);
  // Only the chain owner releases the real lock, after every step has ended.
  return { release: async () => undefined };
}

export async function authorizeScopedMigration(
  scope: CatalogMigrationScope,
  path: string,
) {
  await assertScope(scope, path);
  return {
    basis: "operator" as const,
    identity: await probeCatalogIdentity(path),
  };
}

export async function scopedBackupPath(
  scope: CatalogMigrationScope,
  path: string,
): Promise<string> {
  const state = await assertScope(scope, scope.catalog_path);
  if (state.backup_path !== path)
    throw new CatalogSchemaError("backup-target-changed");
  await schemaTargetPath(path);
  return path;
}

async function backupHash(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1)
      throw new CatalogSchemaError("backup-target-unsafe");
    const digest = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false }))
      digest.update(chunk);
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new CatalogSchemaError("backup-target-changed");
    return digest.digest("hex");
  } finally {
    await file.close();
  }
}

export async function registerScopedBackup(
  scope: CatalogMigrationScope,
): Promise<void> {
  const state = await assertScope(scope, scope.catalog_path);
  if (state.backup_sha256 !== null)
    throw new CatalogSchemaError("backup-already-registered");
  state.backup_sha256 = await backupHash(state.backup_path);
}

export async function verifyScopedBackup(
  scope: CatalogMigrationScope,
  path: string,
): Promise<void> {
  const state = await assertScope(scope, scope.catalog_path);
  await scopedBackupPath(scope, path);
  if (!state.backup_sha256 || (await backupHash(path)) !== state.backup_sha256)
    throw new CatalogSchemaError("backup-target-changed");
}

export async function withCatalogMigrationScope<T>(
  catalog: string,
  backup: string,
  operation: (scope: CatalogMigrationScope) => Promise<T>,
): Promise<T> {
  await schemaTargetPath(catalog);
  await schemaTargetPath(backup);
  if (backup === catalog || dirname(backup) !== dirname(catalog))
    throw new CatalogSchemaError("backup-must-be-distinct-and-beside-catalog");
  const lock = await acquireCatalogWriteLock(catalog);
  let state: ScopeState | undefined;
  try {
    const metadata = await schemaTargetFile(catalog);
    if (!metadata) throw new CatalogSchemaError("catalog-missing");
    state = {
      catalog: metadata,
      backup_path: backup,
      backup_sha256: null,
      active: true,
    };
    const scope = Object.freeze({ catalog_path: catalog });
    scopes.set(scope, state);
    return await operation(scope);
  } finally {
    if (state) state.active = false;
    await lock.release();
  }
}
