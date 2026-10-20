import { lstat, type Stats } from "node:fs";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";

export class CatalogSchemaError extends Error {
  readonly code = "catalog-schema-refused";
  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super("catalog schema operation refused", options);
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
