import {
  SCHEMA_V10_VERSION,
  SCHEMA_V10_FINGERPRINT,
} from "../sqlite/schema-v10.js";
import {
  SCHEMA_V9_FINGERPRINT,
  SCHEMA_V9_VERSION,
} from "../sqlite/schema-v9.js";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SCHEMA_FINGERPRINT } from "../sqlite/schema.js";
import {
  SCHEMA_V2_FINGERPRINT,
  SCHEMA_V2_VERSION,
} from "../sqlite/schema-v2.js";
import {
  SCHEMA_V3_FINGERPRINT,
  SCHEMA_V3_VERSION,
} from "../sqlite/schema-v3.js";
import {
  SCHEMA_V4_FINGERPRINT,
  SCHEMA_V4_VERSION,
} from "../sqlite/schema-v4.js";
import {
  SCHEMA_V5_FINGERPRINT,
  SCHEMA_V5_VERSION,
} from "../sqlite/schema-v5.js";
import {
  SCHEMA_V6_FINGERPRINT,
  SCHEMA_V6_VERSION,
} from "../sqlite/schema-v6.js";
import {
  SCHEMA_V7_FINGERPRINT,
  SCHEMA_V7_VERSION,
} from "../sqlite/schema-v7.js";
import {
  SCHEMA_V8_FINGERPRINT,
  SCHEMA_V8_VERSION,
} from "../sqlite/schema-v8.js";

/**
 * Fail-closed gate for the explicit v1 -> v2 catalog upgrade.
 *
 * ADR 0024 §4 only authorizes the execution schema upgrade on a stopped,
 * synthetic copy of the catalog; the production catalog is out of scope. The
 * command name and the `upgrade-synthetic` option are therefore treated as a
 * declaration, never as proof: the gate independently verifies that the target
 * is a synthetic copy before the catalog is opened for writing.
 */

/** Explicit operator declaration required in addition to target verification. */
export const SYNTHETIC_COPY_DECLARATION_FLAG = "--synthetic-copy";

/** Marker file that declares a directory as an isolated synthetic catalog copy. */
export const SYNTHETIC_CATALOG_MARKER_FILE = "synthetic-catalog.json";

export const SYNTHETIC_CATALOG_PRODUCT = "sciretriever";
export const SYNTHETIC_CATALOG_KIND = "synthetic-catalog";
export const SYNTHETIC_CATALOG_MARKER_VERSION = 1;

export type ExecutionSchemaGateMode =
  | "upgrade-synthetic"
  | "require-v2"
  | "inspect";

export type MigrationSafetyCode =
  | "synthetic-copy-declaration-required"
  | "migration-target-production"
  | "migration-target-unverified"
  | "migration-marker-invalid"
  | "migration-target-missing"
  | "migration-target-v1"
  | "migration-target-unknown"
  | "migration-target-drifted";

/** Stable, path-free refusal raised by the migration safety gate. */
export class MigrationSafetyError extends Error {
  readonly code: MigrationSafetyCode;
  constructor(code: MigrationSafetyCode) {
    super(`migration safety gate refused the target: ${code}`);
    this.name = "MigrationSafetyError";
    this.code = code;
  }
}

export type SyntheticCatalogBasis = "isolated-temp" | "marker";

export interface SyntheticCatalogScope {
  /** Root of the fixed production home; defaults to the real user home. */
  readonly user_home?: string;
  /** Root of the isolated synthetic copies; defaults to the system temp dir. */
  readonly isolated_root?: string;
}

export type CatalogIdentityState =
  | "absent"
  | "v1"
  | "v2"
  | "v3"
  | "v4"
  | "v5"
  | "v6"
  | "v7"
  | "v8"
  | "v10"
  | "v9"
  | "unknown"
  | "drifted";

export interface CatalogIdentityProbe {
  readonly state: CatalogIdentityState;
  readonly product: string | null;
  readonly schema_version: number | null;
  readonly schema_fingerprint: string | null;
  readonly execution_tables: readonly string[];
  readonly migration_receipts: number;
}

export interface ExecutionSchemaAuthorization {
  readonly mode: ExecutionSchemaGateMode;
  /** How the target proved itself to be a synthetic copy; null for read-only modes. */
  readonly basis: SyntheticCatalogBasis | null;
  readonly identity: CatalogIdentityProbe;
}

const ABSENT: CatalogIdentityProbe = Object.freeze({
  state: "absent",
  product: null,
  schema_version: null,
  schema_fingerprint: null,
  execution_tables: Object.freeze([]),
  migration_receipts: 0,
});

function unknownIdentity(
  base: CatalogIdentityProbe = ABSENT,
): CatalogIdentityProbe {
  return { ...base, state: "unknown" };
}

/**
 * Read-only identity probe. It never opens the catalog through the writing
 * worker, so a refused target keeps its bytes, schema and manifest unchanged.
 */
export async function probeCatalogIdentity(
  catalogPath: string,
): Promise<CatalogIdentityProbe> {
  let isFile = false;
  try {
    isFile = (await lstat(catalogPath)).isFile();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? ABSENT
      : unknownIdentity();
  }
  if (!isFile) return unknownIdentity();
  let database: import("node:sqlite").DatabaseSync | undefined;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(catalogPath, { readOnly: true });
    const identity = database
      .prepare(
        "SELECT product,schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1",
      )
      .get() as
      | {
          readonly product?: unknown;
          readonly schema_version?: unknown;
          readonly schema_fingerprint?: unknown;
        }
      | undefined;
    const execution_tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'execution_%' ORDER BY name",
      )
      .all()
      .map((row) => String((row as { readonly name?: unknown }).name));
    let migration_receipts = 0;
    if (execution_tables.includes("execution_schema_migrations"))
      migration_receipts = Number(
        (
          database
            .prepare(
              "SELECT count(*) AS count FROM execution_schema_migrations",
            )
            .get() as { readonly count?: unknown }
        ).count,
      );
    if (
      !identity ||
      identity.product !== SYNTHETIC_CATALOG_PRODUCT ||
      typeof identity.schema_version !== "number" ||
      typeof identity.schema_fingerprint !== "string"
    )
      return unknownIdentity({ ...ABSENT, execution_tables });
    const base: CatalogIdentityProbe = {
      state: "unknown",
      product: identity.product,
      schema_version: identity.schema_version,
      schema_fingerprint: identity.schema_fingerprint,
      execution_tables,
      migration_receipts,
    };
    if (
      identity.schema_version === SCHEMA_V10_VERSION &&
      identity.schema_fingerprint === SCHEMA_V10_FINGERPRINT
    )
      return { ...base, state: "v10" };
    if (
      identity.schema_version === SCHEMA_V9_VERSION &&
      identity.schema_fingerprint === SCHEMA_V9_FINGERPRINT
    )
      return { ...base, state: "v9" };
    if (
      identity.schema_version === SCHEMA_V8_VERSION &&
      identity.schema_fingerprint === SCHEMA_V8_FINGERPRINT
    )
      return { ...base, state: "v8" };
    if (
      identity.schema_version === SCHEMA_V7_VERSION &&
      identity.schema_fingerprint === SCHEMA_V7_FINGERPRINT
    )
      return { ...base, state: "v7" };
    if (
      identity.schema_version === SCHEMA_V6_VERSION &&
      identity.schema_fingerprint === SCHEMA_V6_FINGERPRINT
    )
      return { ...base, state: "v6" };
    if (
      identity.schema_version === SCHEMA_V5_VERSION &&
      identity.schema_fingerprint === SCHEMA_V5_FINGERPRINT
    )
      return { ...base, state: "v5" };
    if (
      identity.schema_version === SCHEMA_V4_VERSION &&
      identity.schema_fingerprint === SCHEMA_V4_FINGERPRINT
    )
      return { ...base, state: "v4" };
    if (
      identity.schema_version === SCHEMA_V3_VERSION &&
      identity.schema_fingerprint === SCHEMA_V3_FINGERPRINT
    )
      return { ...base, state: "v3" };
    if (
      identity.schema_version === SCHEMA_V2_VERSION &&
      identity.schema_fingerprint === SCHEMA_V2_FINGERPRINT
    )
      return { ...base, state: "v2" };
    if (
      identity.schema_version === 1 &&
      identity.schema_fingerprint === SCHEMA_FINGERPRINT
    )
      return { ...base, state: "v1" };
    return { ...base, state: "drifted" };
  } catch {
    return unknownIdentity();
  } finally {
    try {
      database?.close();
    } catch {
      // A failed close must not mask the probe result.
    }
  }
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function contained(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation === "" ||
    (relation !== ".." &&
      !relation.startsWith(`..${sep}`) &&
      !isAbsolute(relation))
  );
}

type LocationVerdict =
  | { readonly basis: SyntheticCatalogBasis }
  | { readonly refusal: MigrationSafetyCode };

async function classifyTarget(
  catalogPath: string,
  scope: SyntheticCatalogScope,
): Promise<LocationVerdict> {
  const catalog = await canonical(catalogPath);
  const directory = dirname(catalog);
  const userHome = resolve(scope.user_home ?? homedir());
  const configurationHome = join(userHome, ".sciretriever");
  if (
    contained(configurationHome, directory) ||
    contained(configurationHome, catalog) ||
    catalog === join(userHome, "catalog.sqlite")
  )
    return { refusal: "migration-target-production" };
  // A declared-but-invalid synthetic identity is never silently ignored.
  const marker = await readSyntheticMarker(directory);
  if (marker === "invalid") return { refusal: "migration-marker-invalid" };
  if (marker === "valid") return { basis: "marker" };
  const isolatedRoot = await canonical(scope.isolated_root ?? tmpdir());
  if (contained(isolatedRoot, directory)) return { basis: "isolated-temp" };
  return { refusal: "migration-target-unverified" };
}

async function readSyntheticMarker(
  directory: string,
): Promise<"absent" | "valid" | "invalid"> {
  const markerPath = join(directory, SYNTHETIC_CATALOG_MARKER_FILE);
  let text: string;
  try {
    if (!(await lstat(markerPath)).isFile()) return "invalid";
    text = await readFile(markerPath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "absent"
      : "invalid";
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "invalid";
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "invalid";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "kind,marker_version,product") return "invalid";
  if (
    record.product !== SYNTHETIC_CATALOG_PRODUCT ||
    record.kind !== SYNTHETIC_CATALOG_KIND ||
    record.marker_version !== SYNTHETIC_CATALOG_MARKER_VERSION
  )
    return "invalid";
  return "valid";
}

/**
 * Read-only pre-check for migration inspection commands: the target must
 * already be an identifiable SciRetriever catalog. Nothing is created and no
 * write path is opened, so an absent, foreign or drifted target is refused
 * without leaving a trace.
 */
export async function requireIdentifiableCatalog(
  catalogPath: string,
): Promise<CatalogIdentityProbe> {
  const identity = await probeCatalogIdentity(catalogPath);
  if (identity.state === "absent")
    throw new MigrationSafetyError("migration-target-missing");
  if (identity.state === "drifted")
    throw new MigrationSafetyError("migration-target-drifted");
  if (identity.state === "unknown")
    throw new MigrationSafetyError("migration-target-unknown");
  return identity;
}

/**
 * The single entry through which the v2 execution schema may be reached.
 *
 * `upgrade-synthetic` requires an independently verified synthetic copy and
 * accepts an absent catalog (fresh synthetic target), the frozen v1 catalog and
 * already migrated v2/v3 catalogs. `require-v2` performs no write and therefore
 * needs no synthetic proof; it accepts a v2-or-newer supported catalog.
 * `inspect` is the read-only mode used by migration inspection commands: it
 * only requires an identifiable v1/v2/v3 catalog.
 */
export async function authorizeExecutionSchema(
  mode: ExecutionSchemaGateMode,
  input: {
    readonly catalog_path: string;
    readonly scope?: SyntheticCatalogScope;
  },
): Promise<ExecutionSchemaAuthorization> {
  if (typeof input.catalog_path !== "string" || !input.catalog_path)
    throw new MigrationSafetyError("migration-target-unverified");
  if (mode === "inspect")
    return {
      mode,
      basis: null,
      identity: await requireIdentifiableCatalog(input.catalog_path),
    };
  if (mode === "require-v2") {
    const identity = await probeCatalogIdentity(input.catalog_path);
    if (
      identity.state === "v2" ||
      identity.state === "v3" ||
      identity.state === "v4" ||
      identity.state === "v5" ||
      identity.state === "v6" ||
      identity.state === "v7" ||
      identity.state === "v8" ||
      identity.state === "v9" ||
      identity.state === "v10"
    )
      return { mode, basis: null, identity };
    if (identity.state === "absent")
      throw new MigrationSafetyError("migration-target-missing");
    if (identity.state === "v1")
      throw new MigrationSafetyError("migration-target-v1");
    if (identity.state === "drifted")
      throw new MigrationSafetyError("migration-target-drifted");
    throw new MigrationSafetyError("migration-target-unknown");
  }
  const location = await classifyTarget(input.catalog_path, input.scope ?? {});
  if ("refusal" in location) throw new MigrationSafetyError(location.refusal);
  const identity = await probeCatalogIdentity(input.catalog_path);
  if (identity.state === "drifted")
    throw new MigrationSafetyError("migration-target-drifted");
  if (identity.state === "unknown")
    throw new MigrationSafetyError("migration-target-unknown");
  return { mode, basis: location.basis, identity };
}
