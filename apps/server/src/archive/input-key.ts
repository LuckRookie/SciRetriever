import {
  canonicalJsonBytes,
  sha256,
  type ArchivePart,
  type ArchiveStep,
} from "@sciretriever/contracts";
/** The exact same step identity is used by execution and read-only previews. */
export function archiveStepKey(
  method: string,
  mode: string,
  part: ArchivePart,
  step: ArchiveStep,
  metadata: { metadata_revision: number; metadata_sha256: string } | null,
  assignment: string | null,
) {
  return sha256(
    canonicalJsonBytes({
      method,
      step,
      mode,
      asset: part.asset_id,
      proofread: part.proofread_id,
      document:
        step === "proofread" || step === "document"
          ? null
          : part.document_version_id,
      annotation: ["metadata", "references", "tags"].includes(step)
        ? part.structure_annotation_id
        : null,
      metadata: metadata
        ? [metadata.metadata_revision, metadata.metadata_sha256]
        : null,
      assignment,
    }),
  );
}
