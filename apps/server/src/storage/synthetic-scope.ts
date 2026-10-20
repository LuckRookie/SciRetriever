import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
export const SYNTHETIC_CATALOG_MARKER_FILE = "synthetic-catalog.json";
const SYNTHETIC_CATALOG_PRODUCT = "sciretriever";
const SYNTHETIC_CATALOG_KIND = "synthetic-catalog";
const SYNTHETIC_CATALOG_MARKER_VERSION = 1;
export type SyntheticCatalogBasis = "isolated-temp" | "marker";
export interface SyntheticCatalogScope {
  readonly user_home?: string;
  readonly isolated_root?: string;
}
export type SyntheticScopeCode =
  | "synthetic-target-production"
  | "synthetic-marker-invalid"
  | "synthetic-target-unverified";
export class SyntheticScopeError extends Error {
  constructor(readonly code: SyntheticScopeCode) {
    super("synthetic workspace refused");
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
  | { readonly refusal: SyntheticScopeCode };

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
    return { refusal: "synthetic-target-production" };
  // A declared-but-invalid synthetic identity is never silently ignored.
  const marker = await readSyntheticMarker(directory);
  if (marker === "invalid") return { refusal: "synthetic-marker-invalid" };
  if (marker === "valid") return { basis: "marker" };
  const isolatedRoot = await canonical(scope.isolated_root ?? tmpdir());
  if (contained(isolatedRoot, directory)) return { basis: "isolated-temp" };
  return { refusal: "synthetic-target-unverified" };
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

export async function authorizeSyntheticCatalog(
  catalogPath: string,
  scope: SyntheticCatalogScope = {},
): Promise<SyntheticCatalogBasis> {
  const verdict = await classifyTarget(catalogPath, scope);
  if ("refusal" in verdict) throw new SyntheticScopeError(verdict.refusal);
  return verdict.basis;
}
