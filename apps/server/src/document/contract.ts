import {
  canonicalJsonBytes,
  parseDocumentRepresentationInput,
  sha256,
  type ArtifactRef,
  type DocumentRef,
  type DocumentRepresentationInput,
  type Sha256,
} from "@sciretriever/contracts";

export type {
  DocumentMaterialRef,
  DocumentResource,
  DocumentStructureV1,
  DocumentRepresentationInput,
  DocumentRef,
  EvidenceRef,
} from "@sciretriever/contracts";

/** Identity, provenance row ID, time and physical paths are outside this content hash. */
export async function documentRepresentationHash(
  input: unknown,
): Promise<Sha256> {
  const normalized = parseDocumentRepresentationInput(input);
  return sha256(canonicalJsonBytes({ schema_version: 1, ...normalized }));
}

/** Document owner operations over v3 immutable publication and fixed-version reads. */
export interface DocumentStoragePort {
  /** Create-if-absent; a different existing byte sequence is a conflict. */
  publishImmutableArtifact(
    reference: string,
    bytes: Uint8Array,
    expected: ArtifactRef,
  ): Promise<{ readonly reference: string; readonly created: boolean }>;
  inspectExactInput(
    input: DocumentRepresentationInput,
  ): Promise<"available" | "stale" | "missing" | "integrity-failure">;
  /** Transactionally recheck exact source, provenance and published artifact FKs. */
  commitVersion(
    input: {
      readonly version: DocumentRef;
      readonly source_artifact_path: string;
      readonly markdown_artifact_path: string;
      readonly structure_artifact_path: string;
      readonly resource_artifact_paths: Readonly<Record<string, string>>;
      readonly expected_default_revision: number | null;
    },
    signal?: AbortSignal,
  ): Promise<{
    readonly published: boolean;
    readonly default_updated: boolean;
    readonly default_revision: number | null;
  }>;
  /** Pin a fixed version and its artifact closure for the full read scope. */
  withPinnedVersion<T>(
    documentVersionId: string,
    consume: (version: DocumentRef) => Promise<T>,
    signal?: AbortSignal,
    reserveVerifiedBytes?: (bytes: number) => void,
  ): Promise<T>;
  withVerifiedArtifact<T>(
    reference: string,
    expected: ArtifactRef,
    consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
  ): Promise<T>;
}
