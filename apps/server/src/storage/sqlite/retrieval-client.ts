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
  constructor(private readonly worker: SqliteWorker) {}
  close(): void {
    // The application owns the shared worker lifetime.
  }
  revision(): Promise<number> {
    return this.worker.retrieval("revision");
  }
  sourceCount(): Promise<number> {
    return this.worker.retrieval("sourceCount");
  }
  metadataPage(
    after: string | null,
    limit: number,
  ): Promise<readonly RetrievalSource[]> {
    return this.worker.retrieval("metadataPage", [after, limit]);
  }
  documentPage(
    after: string | null,
    limit: number,
  ): Promise<readonly RetrievalSource[]> {
    return this.worker.retrieval("documentPage", [after, limit]);
  }
  beginGeneration(revision: number, signal?: AbortSignal): Promise<string> {
    return this.worker.retrieval("beginGeneration", [revision], signal);
  }
  insertEntries(
    generation: string,
    entries: readonly RetrievalEntry[],
    sourceCount: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.worker.retrieval(
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
    return this.worker.retrieval("publish", [generation, revision], signal);
  }
  active(): Promise<RetrievalGeneration | null> {
    return this.worker.retrieval("active");
  }
  state(): Promise<import("./retrieval-engine.js").RetrievalIndexState> {
    return this.worker.retrieval("state");
  }
  verifyCatalog(
    signal?: AbortSignal,
  ): Promise<import("./retrieval-engine.js").RetrievalCatalogInspection> {
    return this.worker.retrieval("verifyCatalog", [], signal);
  }
  markCorrupt(generation: string, revision: number): Promise<void> {
    return this.worker.retrieval("markCorrupt", [generation, revision]);
  }
  scanChanges(): Promise<RetrievalChangeScan> {
    return this.worker.retrieval("scanChanges");
  }
  changesSnapshot(): Promise<RetrievalChangeSnapshot> {
    return this.worker.retrieval("changesSnapshot");
  }
  changePage(
    after: number,
    tail: number,
    limit: number,
  ): Promise<RetrievalChange[]> {
    return this.worker.retrieval("changePage", [after, tail, limit]);
  }
  pruneChangeBatch(signal?: AbortSignal): Promise<boolean> {
    return this.worker.retrieval("pruneChangeBatch", [], signal);
  }
  pruneGenerationBatch(
    target: string | null = null,
    signal?: AbortSignal,
  ): Promise<{
    entries_deleted: number;
    generations_deleted: number;
    done: boolean;
  }> {
    return this.worker.retrieval("pruneGenerationBatch", [target], signal);
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
    return this.worker.retrieval("literatureSources", [id, generation]);
  }
  ensureActive(signal?: AbortSignal): Promise<RetrievalGeneration> {
    return this.worker.retrieval("ensureActive", [], signal);
  }
  beginLiteratureUpdate(signal?: AbortSignal): Promise<string> {
    return this.worker.retrieval("beginLiteratureUpdate", [], signal);
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
    return this.worker.retrieval(
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
    return this.worker.retrieval(
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
    return this.worker.retrieval("finishIncremental", [id, checkpoint], signal);
  }
  verificationEntries(
    generation: string,
    id: string,
  ): Promise<readonly RetrievalEntry[]> {
    return this.worker.retrieval("verificationEntries", [generation, id]);
  }
  verify(): Promise<{
    inspection: import("./retrieval-engine.js").RetrievalCatalogInspection;
    proof: string;
  }> {
    return this.worker.retrieval("verify");
  }
  recordVerification(
    generation: string,
    revision: number,
    proof: string,
    signal?: AbortSignal,
  ): Promise<RetrievalGeneration> {
    return this.worker.retrieval(
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
    return this.worker.retrieval("search", [
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
    return this.worker.retrieval("documentCoverage", [
      scope,
      explicit,
      includeGaps,
    ]);
  }
  hasDefault(literatureId: string, assetId: string): Promise<boolean> {
    return this.worker.retrieval("hasDefault", [literatureId, assetId]);
  }
}
