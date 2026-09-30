import type { SqliteWorker } from "./worker.js";
import type {
  RetrievalEntry,
  RetrievalGeneration,
  RetrievalHit,
  RetrievalSource,
  KnowledgeRetrievalEntry,
  KnowledgeRetrievalGeneration,
  KnowledgeRetrievalHit,
} from "./retrieval-engine.js";

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
  knowledgeRevision(): Promise<number> {
    return this.worker.retrieval("knowledgeRevision");
  }
  knowledgeSourcePage(
    after: string | null,
    limit: number,
  ): Promise<
    readonly {
      artifact_id: string;
      content_sha256: string;
      manifest_sha256: string;
      scope_kind: "literature" | "manifest";
      scope_key: string;
      purpose: KnowledgeRetrievalEntry["purpose"];
      question_sha256: string;
      default_artifact_id: string | null;
    }[]
  > {
    return this.worker.retrieval("knowledgeSourcePage", [after, limit]);
  }
  knowledgeBegin(revision: number, signal?: AbortSignal): Promise<string> {
    return this.worker.retrieval("knowledgeBegin", [revision], signal);
  }
  knowledgeInsert(
    id: string,
    entries: readonly KnowledgeRetrievalEntry[],
    sourceCount: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.worker.retrieval(
      "knowledgeInsert",
      [id, entries, sourceCount],
      signal,
    );
  }
  knowledgePublish(
    id: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<KnowledgeRetrievalGeneration> {
    return this.worker.retrieval("knowledgePublish", [id, revision], signal);
  }
  knowledgeActive(): Promise<KnowledgeRetrievalGeneration | null> {
    return this.worker.retrieval("knowledgeActive");
  }
  knowledgeCoverage(
    generationId: string,
    scope: readonly string[],
    artifactIds: readonly string[] | null,
    purposes: readonly string[],
    questionSha: string | null,
    selection: "all" | "defaults" | "explicit",
  ): Promise<{
    any: boolean;
    missing_literature_ids: readonly string[];
    missing_artifact_ids: readonly string[];
  }> {
    return this.worker.retrieval("knowledgeCoverage", [
      generationId,
      scope,
      artifactIds,
      purposes,
      questionSha,
      selection,
    ]);
  }
  knowledgeSearch(
    fts: string,
    terms: readonly string[],
    generationId: string,
    scope: readonly string[],
    artifactIds: readonly string[] | null,
    purposes: readonly string[],
    questionSha: string | null,
    selection: "all" | "defaults" | "explicit",
    limit: number,
  ): Promise<{
    hits: readonly KnowledgeRetrievalHit[];
    candidateLimit: boolean;
  }> {
    return this.worker.retrieval("knowledgeSearch", [
      fts,
      terms,
      generationId,
      scope,
      artifactIds,
      purposes,
      questionSha,
      selection,
      limit,
    ]);
  }
}
