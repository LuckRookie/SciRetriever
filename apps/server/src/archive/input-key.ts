import {
  ARCHIVE_STEPS,
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
  /**
   * `translate` into the library language: the identity of the current
   * original-language reading layers (`DocumentLayersStore.originalSha256`),
   * or null when there are none.
   */
  layers: string | null = null,
) {
  // Reading layers depend on the content version and the file layout only
  // (spec 10.3): prompt and model changes do not redo them, and the
  // translation is no longer part of them (ADR 0074 section 5).
  if (step === "layers")
    return sha256(
      canonicalJsonBytes({
        step,
        asset: part.asset_id,
        content: part.content_version,
        // A new file layout (spec 10.2.1) redoes layers written by an
        // earlier one; prompt or model changes alone still do not.
        layout: LAYERS_FILE_SCHEMA_VERSION,
      }),
    );
  // Translation depends on the content version, the language and the
  // original-language reading layers it also translates (spec 9.3): a prompt
  // or model change does not translate a paper again. Without layers the key
  // is the one written before the layers were part of it.
  if (step === "translate")
    return sha256(
      canonicalJsonBytes({
        step,
        asset: part.asset_id,
        content: part.content_version,
        language,
        ...(layers === null ? {} : { layers }),
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

/**
 * The key a `layers` step recorded before ADR 0074 section 5, when the step
 * also wrote the translation part and its key named the language and the
 * translation file. A receipt with this key, for the current content
 * version, file layout, language and translation file, stands for the same
 * original-language layers: it is not redone, and the step records the
 * current key in its place.
 */
export function archiveLayersKeyBeforeTranslateLast(
  part: ArchivePart,
  language: string | null,
  translation: string | null,
) {
  return sha256(
    canonicalJsonBytes({
      step: "layers",
      asset: part.asset_id,
      content: part.content_version,
      language,
      translation,
      layout: LAYERS_FILE_SCHEMA_VERSION,
    }),
  );
}

/**
 * What `from_step` forces in the `translate` step (spec 9.3, 10.3): the
 * full-text translation only for `from_step: translate`; the reading
 * layers' translation part for `translate` and for `layers`, whose new
 * original it translates while the full-text translation is reused.
 */
export function archiveTranslationForced(fromStep: ArchiveStep | null): {
  readonly text: boolean;
  readonly layers: boolean;
} {
  return {
    text: fromStep === "translate",
    layers: fromStep === "translate" || fromStep === "layers",
  };
}

/**
 * Whether `from_step` forces a step to run again although its input is
 * unchanged. Only `from_step: layers` redoes the layers; `translate` runs
 * for `from_step: translate` or `layers`, redoing what
 * `archiveTranslationForced` says. An earlier from_step keeps reusing
 * unchanged units (spec 9.3). The other later steps are forced by what they
 * rest on: metadata, references and tags rest on the text, not on its
 * layers or its translation, so redoing `layers` or `translate` leaves them
 * (and the providers they may ask) alone.
 */
export function archiveStepForced(
  step: ArchiveStep,
  fromStep: ArchiveStep | null,
): boolean {
  if (step === "translate") {
    const forced = archiveTranslationForced(fromStep);
    return forced.text || forced.layers;
  }
  if (step === "layers") return fromStep === "layers";
  return (
    fromStep !== null &&
    fromStep !== "translate" &&
    fromStep !== "layers" &&
    ARCHIVE_STEPS.indexOf(step) >= ARCHIVE_STEPS.indexOf(fromStep)
  );
}
