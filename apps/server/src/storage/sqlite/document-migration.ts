import {
  authorizeScopedMigration,
  scopedBackupPath,
  scopedCatalogLock,
  scopedCatalogPath,
  verifyScopedBackup,
  type CatalogMigrationScope,
} from "./migration-scope.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  authorizeExecutionSchema,
  probeCatalogIdentity,
} from "../execution/migration-gate.js";
import { SCHEMA_FINGERPRINT, SCHEMA_MANIFEST } from "./schema.js";
import {
  SCHEMA_IDENTITY_V2,
  SCHEMA_V2_FINGERPRINT,
  SCHEMA_V2_MANIFEST,
} from "./schema-v2.js";
import {
  DOCUMENT_SCHEMA,
  SCHEMA_IDENTITY_V3,
  SCHEMA_V3_FINGERPRINT,
  SCHEMA_V3_MANIFEST,
} from "./schema-v3.js";
import {
  EXECUTION_RUNTIME_SCHEMA,
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
  EXECUTION_SCHEMA,
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_SCHEMA_VERSION,
} from "./execution-schema.js";
import { acquireCatalogWriteLock } from "../write-admission.js";

export class DocumentMigrationError extends Error {
  readonly code = "document-migration" as const;
  constructor(reason: string) {
    super(`document migration refused: ${reason}`);
    this.name = "DocumentMigrationError";
  }
}
export interface DocumentCatalogInspection {
  readonly schema_version: 1 | 2 | 3;
  readonly schema_fingerprint: string;
  readonly integrity: "ok";
  readonly foreign_keys: "ok";
  readonly document_versions: number;
  readonly migration_receipts: number;
}
export interface DocumentMigrationResult {
  readonly action: "dry-run" | "migrated" | "already-v3";
  readonly from_version: 1 | 2 | 3;
  readonly to_version: 3;
  readonly manifest_fingerprint: string;
  readonly backup_path: string | null;
  readonly inspection: DocumentCatalogInspection;
}

function fail(reason: string): never {
  throw new DocumentMigrationError(reason);
}
function manifest(version: 1 | 2 | 3): readonly string[] {
  return version === 1
    ? SCHEMA_MANIFEST
    : version === 2
      ? SCHEMA_V2_MANIFEST
      : SCHEMA_V3_MANIFEST;
}
function expectedFingerprint(version: 1 | 2 | 3): string {
  return version === 1
    ? SCHEMA_FINGERPRINT
    : version === 2
      ? SCHEMA_V2_FINGERPRINT
      : SCHEMA_V3_FINGERPRINT;
}
function inspected(db: DatabaseSync): DocumentCatalogInspection {
  const identity = db
    .prepare(
      "SELECT product,schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1",
    )
    .get() as
    | { product: unknown; schema_version: unknown; schema_fingerprint: unknown }
    | undefined;
  if (
    !identity ||
    identity.product !== "sciretriever" ||
    (identity.schema_version !== 1 &&
      identity.schema_version !== 2 &&
      identity.schema_version !== 3)
  )
    fail("unknown catalog identity");
  const version = identity.schema_version;
  if (identity.schema_fingerprint !== expectedFingerprint(version))
    fail("unknown schema fingerprint");
  if (
    (
      db.prepare("PRAGMA integrity_check").get() as
        | { integrity_check?: unknown }
        | undefined
    )?.integrity_check !== "ok"
  )
    fail("catalog integrity check failed");
  if (db.prepare("PRAGMA foreign_key_check").all().length !== 0)
    fail("catalog foreign key check failed");
  const names = new Set<string>();
  for (const sql of manifest(version)) {
    const match =
      /^CREATE (?:UNIQUE )?(?:VIRTUAL )?(?:TABLE|INDEX|TRIGGER) ([a-z_][a-z0-9_]*)/.exec(
        sql,
      );
    const name = match?.[1];
    if (!name) fail("invalid manifest statement");
    names.add(name);
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name=?")
      .get(name) as { sql?: unknown } | undefined;
    if (row?.sql !== sql) fail("catalog DDL differs from manifest");
  }
  for (const suffix of ["data", "idx", "content", "docsize", "config"])
    names.add(`literature_search_fts_${suffix}`);
  const actualNames = db
    .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  if (actualNames.some((row) => !names.has(row.name)))
    fail("catalog contains DDL outside its manifest");
  if (version === 1 || version === 2) {
    const unexpected = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name LIKE 'document_%' LIMIT 1",
      )
      .get();
    if (unexpected) fail("document schema exists outside its manifest");
  }
  if (version >= 2) {
    const execution = db
      .prepare(
        "SELECT version,fingerprint FROM execution_schema_identity WHERE singleton=1",
      )
      .get() as { version?: unknown; fingerprint?: unknown } | undefined;
    const runtime = db
      .prepare(
        "SELECT version,fingerprint FROM execution_runtime_schema_identity WHERE singleton=1",
      )
      .get() as { version?: unknown; fingerprint?: unknown } | undefined;
    if (
      execution?.version !== EXECUTION_SCHEMA_VERSION ||
      execution.fingerprint !== EXECUTION_SCHEMA_FINGERPRINT ||
      runtime?.version !== EXECUTION_RUNTIME_SCHEMA_VERSION ||
      runtime.fingerprint !== EXECUTION_RUNTIME_SCHEMA_FINGERPRINT
    )
      fail("execution sub-schema differs from manifest");
  }
  const counts =
    version === 3
      ? {
          versions: Number(
            (
              db
                .prepare("SELECT count(*) AS n FROM document_versions")
                .get() as { n: number }
            ).n,
          ),
          receipts: Number(
            (
              db
                .prepare("SELECT count(*) AS n FROM document_schema_migrations")
                .get() as { n: number }
            ).n,
          ),
        }
      : { versions: 0, receipts: 0 };
  return {
    schema_version: version,
    schema_fingerprint: expectedFingerprint(version),
    integrity: "ok",
    foreign_keys: "ok",
    document_versions: counts.versions,
    migration_receipts: counts.receipts,
  };
}
function readOnlyInspection(path: string): DocumentCatalogInspection {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON");
    return inspected(db);
  } finally {
    db.close();
  }
}
export async function inspectDocumentCatalog(
  catalogPath: string,
): Promise<DocumentCatalogInspection> {
  const probe = await probeCatalogIdentity(catalogPath);
  if (probe.state !== "v1" && probe.state !== "v2" && probe.state !== "v3")
    fail("catalog identity is unavailable");
  try {
    return readOnlyInspection(catalogPath);
  } catch (error) {
    if (error instanceof DocumentMigrationError) throw error;
    return fail("catalog is damaged");
  }
}
export async function syntheticPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const parent = await realpath(dirname(absolute));
  const temp = await realpath(tmpdir());
  const relation = relative(temp, parent);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    !relation.split(sep).some((part) => part.startsWith("sciretriever-"))
  )
    fail("target is outside a synthetic temporary directory");
  if (!basename(absolute) || basename(absolute) === ".") fail("invalid path");
  return resolve(parent, basename(absolute));
}
function replaceIdentity(
  db: DatabaseSync,
  ddl: string,
  version: number,
  fingerprint: string,
): void {
  const created = db
    .prepare("SELECT created_at FROM schema_identity WHERE singleton=1")
    .get() as { created_at?: unknown } | undefined;
  if (typeof created?.created_at !== "string" || !created.created_at.trim())
    fail("missing catalog creation time");
  db.exec("DROP TABLE schema_identity");
  db.exec(ddl);
  db.prepare(
    "INSERT INTO schema_identity(singleton,product,schema_version,schema_fingerprint,created_at) VALUES(1,'sciretriever',?,?,?)",
  ).run(version, fingerprint, created.created_at);
}
function addExecutionV2(db: DatabaseSync): void {
  for (const sql of EXECUTION_SCHEMA) db.exec(sql);
  db.prepare(
    "INSERT INTO execution_schema_identity(singleton,version,fingerprint) VALUES(1,?,?)",
  ).run(EXECUTION_SCHEMA_VERSION, EXECUTION_SCHEMA_FINGERPRINT);
  for (const sql of EXECUTION_RUNTIME_SCHEMA) db.exec(sql);
  db.prepare(
    "INSERT INTO execution_runtime_schema_identity(singleton,version,fingerprint) VALUES(1,?,?)",
  ).run(EXECUTION_RUNTIME_SCHEMA_VERSION, EXECUTION_RUNTIME_SCHEMA_FINGERPRINT);
  replaceIdentity(db, SCHEMA_IDENTITY_V2, 2, SCHEMA_V2_FINGERPRINT);
  db.prepare(
    "INSERT INTO execution_schema_migrations(migration_id,from_version,to_version,manifest_fingerprint,action,applied_at) VALUES(?,1,2,?,'migrate',?)",
  ).run(
    `catalog-v2-${randomUUID()}`,
    SCHEMA_V2_FINGERPRINT,
    new Date().toISOString(),
  );
}
function addDocumentV3(db: DatabaseSync, from: 1 | 2): void {
  for (const sql of DOCUMENT_SCHEMA) db.exec(sql);
  replaceIdentity(db, SCHEMA_IDENTITY_V3, 3, SCHEMA_V3_FINGERPRINT);
  db.prepare(
    "INSERT INTO document_schema_migrations(migration_id,from_version,to_version,manifest_fingerprint,applied_at) VALUES(?,?,3,?,?)",
  ).run(
    `catalog-v3-${randomUUID()}`,
    from,
    SCHEMA_V3_FINGERPRINT,
    new Date().toISOString(),
  );
}
export async function migrateDocumentCatalog(input: {
  readonly catalog_path: string;
  readonly backup_path?: string;
  readonly dry_run?: boolean;
  /** Internal scope issued by the explicit catalog schema operator. */
  readonly migration_scope?: CatalogMigrationScope;
  /** Fault injection for transactional recovery tests. */
  readonly checkpoint?: (
    stage: "before-backup-publish" | "backed-up" | "before-commit",
  ) => void | Promise<void>;
}): Promise<DocumentMigrationResult> {
  const catalog = input.migration_scope
    ? await scopedCatalogPath(input.migration_scope, input.catalog_path)
    : await syntheticPath(input.catalog_path);
  if (input.dry_run) {
    await authorizeExecutionSchema("upgrade-synthetic", {
      catalog_path: catalog,
    });
    const inspection = await inspectDocumentCatalog(catalog);
    return {
      action: "dry-run",
      from_version: inspection.schema_version,
      to_version: 3,
      manifest_fingerprint: SCHEMA_V3_FINGERPRINT,
      backup_path: null,
      inspection,
    };
  }
  // The same cross-process lock held by Application operations covers every
  // read/backup/write step. Inspect and dry-run never create its sidecar.
  const lock = input.migration_scope
    ? await scopedCatalogLock(input.migration_scope, catalog)
    : await acquireCatalogWriteLock(catalog);
  try {
    const authorization = input.migration_scope
      ? await authorizeScopedMigration(input.migration_scope, catalog)
      : await authorizeExecutionSchema("upgrade-synthetic", {
          catalog_path: catalog,
        });
    const before = await inspectDocumentCatalog(catalog);
    const from = before.schema_version;
    const base = {
      from_version: from,
      to_version: 3 as const,
      manifest_fingerprint: SCHEMA_V3_FINGERPRINT,
    };
    if (from === 3)
      return {
        ...base,
        action: "already-v3",
        backup_path: null,
        inspection: before,
      };
    if (
      !authorization.basis ||
      !input.backup_path ||
      !input.backup_path.startsWith("/")
    )
      fail("verified synthetic target and backup path are required");
    const backup = input.migration_scope
      ? await scopedBackupPath(input.migration_scope, input.backup_path)
      : await syntheticPath(input.backup_path);
    if (backup === catalog || dirname(backup) !== dirname(catalog))
      fail("backup must be a distinct file beside the catalog");
    const db = new DatabaseSync(catalog);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.exec("PRAGMA busy_timeout=5000");
      const dataVersion = () =>
        Number(
          (db.prepare("PRAGMA data_version").get() as { data_version: number })
            .data_version,
        );
      if (inspected(db).schema_version !== from)
        fail("catalog changed before migration");
      const startDataVersion = dataVersion();
      await publishRecoverableBackup(
        db,
        backup,
        before,
        (path) => readOnlyInspection(path),
        input.checkpoint,
        input.migration_scope,
      );
      await input.checkpoint?.("backed-up");
      if (dataVersion() !== startDataVersion)
        fail("catalog changed while backing up");
      db.exec("BEGIN IMMEDIATE");
      try {
        if (dataVersion() !== startDataVersion)
          fail("catalog changed before migration transaction");
        if (inspected(db).schema_version !== from)
          fail("catalog changed during migration");
        if (from === 1) addExecutionV2(db);
        addDocumentV3(db, from);
        await input.checkpoint?.("before-commit");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const after = inspected(db);
      return {
        ...base,
        action: "migrated",
        backup_path: backup,
        inspection: after,
      };
    } finally {
      db.close();
    }
  } finally {
    await lock.release();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function publishRecoverableBackup<
  T extends {
    readonly schema_version: number;
    readonly schema_fingerprint: string;
  },
>(
  db: DatabaseSync,
  backup: string,
  before: T,
  inspect: (path: string) => T | Promise<T>,
  checkpoint?: (
    stage: "before-backup-publish" | "backed-up" | "before-commit",
  ) => void | Promise<void>,
  scope?: CatalogMigrationScope,
): Promise<void> {
  if (scope) {
    await verifyScopedBackup(scope, backup);
    return;
  }
  const stagingDirectory = await mkdtemp(
    resolve(dirname(backup), ".sciretriever-backup-"),
  );
  const staged = resolve(stagingDirectory, "catalog.sqlite");
  try {
    db.prepare("VACUUM INTO ?").run(staged);
    const file = await open(staged, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1) fail("backup staging is unsafe");
      await file.sync();
    } finally {
      await file.close();
    }
    const saved = await inspect(staged);
    if (JSON.stringify(saved) !== JSON.stringify(before))
      fail("backup restore check failed");
    await syncDirectory(stagingDirectory);
    await checkpoint?.("before-backup-publish");
    try {
      // link(2) creates the final name only if it is absent. A racing empty
      // file, symlink or different byte sequence is never opened or replaced.
      await link(staged, backup);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        fail("backup target already exists");
      throw error;
    }
    await syncDirectory(dirname(backup));
    await unlink(staged);
    await syncDirectory(stagingDirectory);
    const published = await lstat(backup);
    if (!published.isFile() || published.nlink !== 1)
      fail("published backup is unsafe");
    const verified = await inspect(backup);
    if (JSON.stringify(verified) !== JSON.stringify(before))
      fail("published backup restore check failed");
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
