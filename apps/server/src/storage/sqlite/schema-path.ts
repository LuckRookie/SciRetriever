import { lstat, type Stats } from "node:fs";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { CATALOG_ADDITION_REQUIRED } from "./catalog-ddl.js";

export class CatalogSchemaError extends Error {
  readonly code: "catalog-schema-refused" | typeof CATALOG_ADDITION_REQUIRED;
  constructor(
    readonly reason: string,
    options?: ErrorOptions,
    readonly addition?: string,
  ) {
    super(
      reason === CATALOG_ADDITION_REQUIRED
        ? `required catalog addition is missing: ${addition}`
        : "catalog schema operation refused",
      options,
    );
    this.code =
      reason === CATALOG_ADDITION_REQUIRED
        ? CATALOG_ADDITION_REQUIRED
        : "catalog-schema-refused";
  }
}
const stat = promisify(lstat);
export async function schemaTargetPath(path: string): Promise<string> {
  if (!path.startsWith("/") || resolve(path) !== path || dirname(path) === path)
    throw new CatalogSchemaError("target-path-unsafe");
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (!(await stat(parent)).isDirectory())
      throw new CatalogSchemaError("target-path-unsafe");
    if (parent === "/") break;
  }
  return path;
}
export async function schemaTargetFile(path: string): Promise<Stats | null> {
  try {
    const value = await stat(path);
    if (!value.isFile() || value.nlink !== 1)
      throw new CatalogSchemaError("target-file-unsafe");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
