import type {
  RetrievalEntry,
  RetrievalGeneration,
  RetrievalHit,
  RetrievalSource,
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
  reusableGeneration(): Promise<RetrievalGeneration | null> {
    return this.worker.retrieval("reusableGeneration");
  }
  reusePage(
    generation: string,
    kind: "metadata" | "document",
    source: RetrievalSource,
    after: number,
    limit: number,
  ): Promise<readonly (RetrievalEntry & { entry_id: number })[]> {
    return this.worker.retrieval("reusePage", [
      generation,
      kind,
      source,
      after,
      limit,
    ]);
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
