import type {
  RetrievalEntry,
  RetrievalGeneration,
  RetrievalHit,
  RetrievalSource,
  RetrievalChangeScan,
  RetrievalChangeSnapshot,
  RetrievalCheckpoint,
  RetrievalChange,
  RetrievalLiteratureUpdate,
} from "./retrieval-engine.js";
import type { SqliteWorker } from "./worker.js";

/** Async retrieval port. All SQL and inspection run in the catalog worker. */
export class RetrievalStorageClient {
  constructor(
    private readonly worker: SqliteWorker,
    /** Translations in this language are indexed and current (document spec 9.7). */
    private readonly translationLanguage: string | null = null,
  ) {}
  private call<T>(
    operation: Parameters<SqliteWorker["retrieval"]>[0],
    args: readonly unknown[] = [],
    signal?: AbortSignal,
  ): Promise<T> {
    return this.worker.retrieval<T>(
      operation,
      args,
      signal,
      this.translationLanguage,
    );
  }
  close(): void {
    // The application owns the shared worker lifetime.
  }
  revision(): Promise<number> {
    return this.call("revision");
  }
  sourceCount(): Promise<number> {
    return this.call("sourceCount");
  }
  metadataPage(
    after: string | null,
    limit: number,
  ): Promise<readonly RetrievalSource[]> {
    return this.call("metadataPage", [after, limit]);
  }
  documentPage(
    after: string | null,
    limit: number,
  ): Promise<readonly RetrievalSource[]> {
    return this.call("documentPage", [after, limit]);
  }
  beginGeneration(revision: number, signal?: AbortSignal): Promise<string> {
    return this.call("beginGeneration", [revision], signal);
  }
  insertEntries(
    generation: string,
    entries: readonly RetrievalEntry[],
    sourceCount: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.call(
      "insertEntries",
      [generation, entries, sourceCount],
      signal,
    );
  }
  publish(
    generation: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<RetrievalGeneration> {
    return this.call("publish", [generation, revision], signal);
  }
  active(): Promise<RetrievalGeneration | null> {
    return this.call("active");
  }
  ruleStatus(): Promise<
    ReturnType<
      import("./retrieval-engine.js").RetrievalStorageEngine["ruleStatus"]
    >
  > {
    return this.call("ruleStatus");
  }
  state(): Promise<import("./retrieval-engine.js").RetrievalIndexState> {
    return this.call("state");
  }
  verifyCatalog(
    signal?: AbortSignal,
  ): Promise<import("./retrieval-engine.js").RetrievalCatalogInspection> {
    return this.call("verifyCatalog", [], signal);
  }
  markCorrupt(generation: string, revision: number): Promise<void> {
    return this.call("markCorrupt", [generation, revision]);
  }
  scanChanges(): Promise<RetrievalChangeScan> {
    return this.call("scanChanges");
  }
  changesSnapshot(): Promise<RetrievalChangeSnapshot> {
    return this.call("changesSnapshot");
  }
  changePage(
    after: number,
    tail: number,
    limit: number,
  ): Promise<RetrievalChange[]> {
    return this.call("changePage", [after, tail, limit]);
  }
  pruneChangeBatch(signal?: AbortSignal): Promise<boolean> {
    return this.call("pruneChangeBatch", [], signal);
  }
  pruneGenerationBatch(
    target: string | null = null,
    signal?: AbortSignal,
  ): Promise<{
    entries_deleted: number;
    generations_deleted: number;
    done: boolean;
  }> {
    return this.call("pruneGenerationBatch", [target], signal);
  }
  literatureSources(
    id: string,
    generation?: string,
  ): Promise<{
    fingerprint: string;
    metadata: RetrievalSource | null;
    documents: readonly RetrievalSource[];
    indexed: boolean;
  }> {
    return this.call("literatureSources", [id, generation]);
  }
  ensureActive(signal?: AbortSignal): Promise<RetrievalGeneration> {
    return this.call("ensureActive", [], signal);
  }
  beginLiteratureUpdate(signal?: AbortSignal): Promise<string> {
    return this.call("beginLiteratureUpdate", [], signal);
  }
  async discardLiteratureUpdate(id: string): Promise<void> {
    while (!(await this.pruneGenerationBatch(id)).done) {
      // Each call releases catalog admission; staged discards are bounded too.
    }
  }
  commitLiteratureUpdate(
    active: string,
    staged: string,
    id: string,
    fingerprint: string,
    checkpoint: RetrievalCheckpoint,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.call(
      "commitLiteratureUpdate",
      [active, staged, id, fingerprint, checkpoint],
      signal,
    );
  }
  commitLiteratureBatch(
    id: string,
    updates: readonly RetrievalLiteratureUpdate[],
    checkpoint: RetrievalCheckpoint,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.call(
      "commitLiteratureBatch",
      [id, updates, checkpoint],
      signal,
    );
  }
  finishIncremental(
    id: string,
    checkpoint: RetrievalCheckpoint,
    signal?: AbortSignal,
  ): Promise<RetrievalGeneration> {
    return this.call("finishIncremental", [id, checkpoint], signal);
  }
  verificationEntries(
    generation: string,
    id: string,
  ): Promise<readonly RetrievalEntry[]> {
    return this.call("verificationEntries", [generation, id]);
  }
  verify(): Promise<{
    inspection: import("./retrieval-engine.js").RetrievalCatalogInspection;
    proof: string;
  }> {
    return this.call("verify");
  }
  recordVerification(
    generation: string,
    revision: number,
    proof: string,
    signal?: AbortSignal,
  ): Promise<RetrievalGeneration> {
    return this.call(
      "recordVerification",
      [generation, revision, proof],
      signal,
    );
  }
  search(
    ftsQuery: string,
    terms: readonly string[],
    generationId: string,
    scope: readonly string[],
    kinds: readonly ("metadata" | "document")[],
    explicitVersions: readonly string[] | null,
    limit: number,
    after: {
      readonly score: number;
      readonly kind: string;
      readonly literature_id: string;
      readonly document_version_id: string;
      readonly unit_ordinal: number;
    } | null,
  ): Promise<{
    readonly hits: readonly RetrievalHit[];
    readonly candidateLimit: boolean;
    readonly relevanceLimited: boolean;
  }> {
    return this.call("search", [
      ftsQuery,
      terms,
      generationId,
      scope,
      kinds,
      explicitVersions,
      limit,
      after,
    ]);
  }
  documentCoverage(
    scope: readonly string[],
    explicit:
      | readonly {
          literature_id: string;
          document_version_id: string;
          representation_sha256: string;
        }[]
      | null,
    includeGaps = true,
  ): Promise<
    readonly {
      code: "material-missing" | "representation-missing";
      literature_id: string | null;
    }[]
  > {
    return this.call("documentCoverage", [scope, explicit, includeGaps]);
  }
  hasDefault(literatureId: string, assetId: string): Promise<boolean> {
    return this.call("hasDefault", [literatureId, assetId]);
  }
}
