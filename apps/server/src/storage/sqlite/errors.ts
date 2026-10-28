export class CatalogCorruptionError extends Error {
  readonly code = "catalog-corrupt";
  readonly maintenance_hint = "verify-catalog";
  readonly sqlite_code: "SQLITE_CORRUPT" | "SQLITE_NOTADB" | null;
  constructor(
    sqlite_code: "SQLITE_CORRUPT" | "SQLITE_NOTADB" | null,
    options?: ErrorOptions,
  ) {
    super("Catalog is corrupt; run maintenance verify-catalog", options);
    this.sqlite_code = sqlite_code;
  }
}
/** Node exposes SQLite primary/extended result codes as errcode. */
export function catalogCorruption(
  error: unknown,
): CatalogCorruptionError | null {
  let current = error;
  for (let n = 0; n < 8 && current && typeof current === "object"; n++) {
    if (current instanceof CatalogCorruptionError) return current;
    const r = current as { code?: unknown; errcode?: unknown; cause?: unknown };
    const primary = typeof r.errcode === "number" ? r.errcode & 255 : null;
    if (primary === 11 || r.code === "SQLITE_CORRUPT")
      return new CatalogCorruptionError("SQLITE_CORRUPT", { cause: error });
    if (primary === 26 || r.code === "SQLITE_NOTADB")
      return new CatalogCorruptionError("SQLITE_NOTADB", { cause: error });
    current = r.cause;
  }
  return null;
}
export function throwCatalogCorruption(error: unknown): void {
  const failure = catalogCorruption(error);
  if (failure) throw failure;
}
