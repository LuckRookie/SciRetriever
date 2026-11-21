/** Stable score identity for Context bundles and cursors. */
export const RETRIEVAL_SCORE_RULE = "weighted-term-frequency-v1" as const;

export class RetrievalStorageError extends Error {
  readonly code:
    | "index-unavailable"
    | "index-corrupt"
    | "index-stale"
    | "index-storage-full";
  constructor(code: RetrievalStorageError["code"]) {
    super(code);
    this.code = code;
  }
}
