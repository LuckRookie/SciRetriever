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
  language: string | null = null,
) {
  // Translation depends on the content version and the language only (spec
  // 9.3): a prompt or model change does not translate a paper again.
  if (step === "translate")
    return sha256(
      canonicalJsonBytes({
        step,
        asset: part.asset_id,
        content: part.content_version,
        language,
      }),
    );
  return sha256(
    canonicalJsonBytes({
      method,
      step,
      mode,
      asset: part.asset_id,
      proofread: part.proofread_id,
      document:
        step === "arrange" || step === "proofread" || step === "render"
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
