import {
  LAYERS_FILE_SCHEMA_VERSION,
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
  /** `layers`: sha256 of the current content version's translation file, or null. */
  translation: string | null = null,
) {
  // Reading layers depend on the content version, the language and the
  // translation file only (spec 10.3); prompt and model changes do not redo them.
  if (step === "layers")
    return sha256(
      canonicalJsonBytes({
        step,
        asset: part.asset_id,
        content: part.content_version,
        language,
        translation,
        // A new file layout (spec 10.2.1) redoes layers written by an
        // earlier one; prompt or model changes alone still do not.
        layout: LAYERS_FILE_SCHEMA_VERSION,
      }),
    );
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
