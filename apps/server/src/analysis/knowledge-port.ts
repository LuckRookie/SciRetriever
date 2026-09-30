import type {
  KnowledgeArtifact,
  KnowledgePurpose,
} from "@sciretriever/contracts";

export interface KnowledgeStoragePort {
  byId(id: string, signal?: AbortSignal): Promise<KnowledgeArtifact | null>;
  byComparison(
    hash: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeArtifact | null>;
  publish(
    artifact: KnowledgeArtifact,
    signal?: AbortSignal,
  ): Promise<{
    readonly artifact: KnowledgeArtifact;
    readonly published: boolean;
  }>;
  updateDefault(
    input: {
      readonly literature_id: string;
      readonly purpose: Exclude<KnowledgePurpose, "synthesis">;
      readonly question_sha256: string;
      readonly artifact_id: string;
      readonly expected_revision: number | null;
    },
    signal?: AbortSignal,
  ): Promise<{ readonly updated: boolean; readonly revision: number | null }>;
}
