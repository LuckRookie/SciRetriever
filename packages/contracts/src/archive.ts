import type { TextLevel } from "./draft-document.js";
import type { LongDocumentInfo } from "./long-document.js";
import {
  canonicalJsonBytes,
  ContractValidationError,
  parseLiteratureId,
  sha256,
  tagInteger,
  tagRecord,
} from "./index.js";
import {
  TRANSLATION_LANGUAGES,
  isTranslationLanguage,
  type TranslationLanguage,
} from "./translation.js";

/**
 * The archive steps in the order they run (ADR 0074 section 5): the steps
 * before `translate` read only the original; `translate` comes last, after
 * the original-language reading layers it also translates.
 */
export const ARCHIVE_STEPS = [
  "arrange",
  "proofread",
  "render",
  "layers",
  "metadata",
  "references",
  "tags",
  "translate",
] as const;
export type ArchiveStep = (typeof ARCHIVE_STEPS)[number];
/**
 * The step record of an on-request translation into a language other than
 * the library default (ADR 0072, spec 9.6.1): `translate-` and the language
 * code in lower case (`translate-ja`, `translate-zh-hant`), since a step name
 * holds only lower-case letters and hyphens. The library default's
 * translation stays in `translate`.
 */
export type ArchiveTranslationStep = `translate-${string}`;
/** The step record for a translation into `language`. */
export function archiveTranslationStep(
  language: TranslationLanguage,
  libraryDefault: TranslationLanguage,
): "translate" | ArchiveTranslationStep {
  return language === libraryDefault
    ? "translate"
    : `translate-${language.toLowerCase()}`;
}
/** The language of a `translate-<code>` step record, or null. */
export function archiveTranslationStepLanguage(
  step: unknown,
): TranslationLanguage | null {
  return (
    TRANSLATION_LANGUAGES.find(
      (l) => step === `translate-${l.code.toLowerCase()}`,
    )?.code ?? null
  );
}
export function isArchiveTranslationStep(
  step: unknown,
): step is ArchiveTranslationStep {
  return archiveTranslationStepLanguage(step) !== null;
}
export type ArchiveMode = "full" | "legacy-vlm-markdown";
export type ArchiveStepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "unavailable";
export interface ArchiveBuildRequest {
  readonly schema_version: 2;
  readonly retry_page_indexes: readonly number[] | null;
  readonly literature_id: string;
  readonly mode: ArchiveMode;
  readonly from_step: ArchiveStep | null;
  /**
   * Run only the `translate` step, into this language (ADR 0072, document
   * spec 9.6.1): the on-request translation of one paper. Absent for a
   * normal build.
   */
  readonly translate_only?: TranslationLanguage;
}
export interface ArchiveStepReceipt {
  readonly schema_version?: 2;
  readonly run_id?: string;
  readonly attempt_id?: string;
  readonly usage?: import("./archive-text.js").ArchiveModelUsage;
  readonly stop?: import("./archive-text.js").ArchiveTextStop | null;
  readonly output_ids?: {
    readonly arrangement_id: string | null;
    readonly proofread_id: string | null;
    readonly document_version_id: string | null;
    readonly annotation_id: string | null;
  };
  readonly pages?: {
    readonly unreviewed?: number;
    readonly required: number;
    readonly accepted: number;
    readonly reused: number;
    readonly pending: number;
    readonly failed: number;
  } | null;
  readonly literature_id: string;
  readonly asset_id: string;
  readonly step:
    | ArchiveStep
    | ArchiveTranslationStep
    | "document"
    | "structure";
  readonly status: ArchiveStepStatus;
  readonly input_sha256: string;
  readonly output: Readonly<Record<string, unknown>>;
  readonly reason: string | null;
  readonly elapsed_ms: number;
  readonly calls: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
}
export interface ArchivePart {
  readonly draft_facts?: import("./draft-facts.js").DraftFacts | null;
  readonly text_level?: TextLevel | null;
  readonly long_document?: LongDocumentInfo | null;
  readonly format?: "arranged-v2" | "legacy-v1" | "not-built";
  readonly legacy_steps?: readonly ArchiveStepReceipt[];
  readonly asset_id: string;
  readonly asset_sha256: string;
  readonly part: "main" | "supplementary";
  readonly raw_profiles: readonly string[];
  readonly proofread_id: string | null;
  readonly proofread_complete: boolean;
  readonly document_version_id: string | null;
  readonly structure_annotation_id: string | null;
  readonly structure_satisfied: boolean;
  readonly content_version: string | null;
  readonly steps: readonly ArchiveStepReceipt[];
}
export interface ArchiveIssue {
  readonly issue_id: string;
  readonly literature_id: string;
  readonly asset_id: string;
  readonly part: "main" | "supplementary";
  readonly step:
    | ArchiveStep
    | ArchiveTranslationStep
    | "document"
    | "structure";
  readonly reason: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly affects_readiness: boolean;
  readonly resolution: "continue" | "skip" | "cancel" | null;
}
export interface ArchiveIssueCount {
  readonly total_count: number;
}

export function parseArchiveIssueCount(value: unknown): ArchiveIssueCount {
  const r = tagRecord(value, ["total_count"]);
  return { total_count: tagInteger(r.total_count) };
}

export interface ArchiveState {
  readonly draft_facts?: import("./draft-facts.js").DraftFacts | null;
  readonly text_level?: TextLevel | null;
  readonly long_document?: LongDocumentInfo | null;
  readonly literature_id: string;
  readonly mode: ArchiveMode;
  readonly started: boolean;
  readonly running: boolean;
  readonly parts: readonly ArchivePart[];
  readonly issues: readonly ArchiveIssue[];
  readonly article_kind: string | null;
  readonly metadata_missing: readonly string[];
  readonly tag_count: number;
  readonly description_version: string | null;
}
export interface ArchiveVersionEvent {
  readonly sequence: number;
  readonly kind: "content-version-changed" | "description-version-changed";
  readonly literature_id: string;
  readonly asset_id: string | null;
  readonly old_part: "main" | "supplementary" | null;
  readonly new_part: "main" | "supplementary" | null;
  readonly old_version: string | null;
  readonly new_version: string | null;
  readonly created_at: string;
}
export class ArchiveContractObsoleteError extends Error {
  readonly code = "archive-contract-obsolete";
  constructor() {
    super("archive contract obsolete");
  }
}
export type ArchiveBuildRequestV2 = ArchiveBuildRequest;
export function parseArchiveBuildRequest(value: unknown): ArchiveBuildRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractValidationError();
  const r = value as Record<string, unknown>;
  if (
    r.schema_version !== 2 ||
    ["document", "structure"].includes(String(r.from_step))
  )
    throw new ArchiveContractObsoleteError();
  if (
    Object.keys(r).some(
      (k) =>
        ![
          "schema_version",
          "literature_id",
          "mode",
          "from_step",
          "retry_page_indexes",
          "translate_only",
        ].includes(k),
    ) ||
    (r.translate_only !== undefined &&
      (!isTranslationLanguage(r.translate_only) ||
        (r.from_step ?? null) !== null ||
        (r.retry_page_indexes ?? null) !== null)) ||
    (r.mode !== undefined &&
      !["full", "legacy-vlm-markdown"].includes(String(r.mode))) ||
    (r.from_step !== undefined &&
      r.from_step !== null &&
      !ARCHIVE_STEPS.includes(r.from_step as ArchiveStep))
  )
    throw new ContractValidationError();
  const retry = r.retry_page_indexes ?? null;
  if (
    retry !== null &&
    (!Array.isArray(retry) ||
      retry.length > 10000 ||
      retry.some((n) => !Number.isSafeInteger(n) || n < 0 || n > 9999) ||
      new Set(retry).size !== retry.length ||
      r.from_step !== "proofread")
  )
    throw new ContractValidationError();
  return Object.freeze({
    schema_version: 2,
    retry_page_indexes: retry,
    literature_id: parseLiteratureId(r.literature_id),
    mode: (r.mode ?? "full") as ArchiveMode,
    from_step: (r.from_step ?? null) as ArchiveStep | null,
    ...(r.translate_only !== undefined
      ? { translate_only: r.translate_only as TranslationLanguage }
      : {}),
  });
}
export const archiveContentVersion = (
  document_version_id: string,
  structure_annotation_id: string,
) =>
  sha256(canonicalJsonBytes({ document_version_id, structure_annotation_id }));
export const archiveDescriptionVersion = (
  metadata_revision: number,
  metadata_sha256: string,
  assignment_sha256: string | null,
) =>
  sha256(
    canonicalJsonBytes({
      metadata_revision,
      metadata_sha256,
      assignment_sha256,
    }),
  );
