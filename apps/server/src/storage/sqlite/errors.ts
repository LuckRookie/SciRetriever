const DOCUMENT_COMMIT_CODES = [
  "document-source-stale",
  "document-version-invalid",
  "document-proofread-stale",
  "document-manual-stale",
  "document-raw-stale",
  "document-markdown-unregistered",
  "document-resources-mismatch",
  "document-artifact-unregistered",
  "document-version-conflict",
  "document-publication-failed",
] as const;
export type DocumentCommitFailureCode = (typeof DOCUMENT_COMMIT_CODES)[number];
export function isDocumentCommitFailureCode(
  value: unknown,
): value is DocumentCommitFailureCode {
  return (
    typeof value === "string" &&
    (DOCUMENT_COMMIT_CODES as readonly string[]).includes(value)
  );
}
/** Stable publication diagnostics; raw SQLite messages and paths stay private. */
export class DocumentCommitError extends Error {
  readonly code: DocumentCommitFailureCode;
  constructor(code: DocumentCommitFailureCode) {
    super("Document publication rejected");
    this.code = code;
  }
}

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

/** SQLITE_FULL, including extended codes, means SQLite could not allocate space. */
export function sqliteStorageFull(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "errcode" in error &&
    typeof error.errcode === "number" &&
    (error.errcode & 255) === 13
  );
}
