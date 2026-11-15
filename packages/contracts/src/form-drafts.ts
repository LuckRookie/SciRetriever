import {
  ContractValidationError,
  parseAssetId,
  type AcquirePdfSelector,
} from "./index.js";
import {
  DRAFT_FAILURE_CODES,
  type DraftFailureCode,
} from "./draft-document.js";
import { tagInteger, tagRecord } from "./tags.js";

export interface FormDraftsPreviewRequest {
  readonly selector: AcquirePdfSelector;
  readonly include_older_method: boolean;
}
export interface FormDraftsRequest extends FormDraftsPreviewRequest {
  readonly idempotency_key: string;
}
export interface FormDraftsCounts {
  readonly matched: number;
  readonly process: number;
  readonly process_parts: number;
  readonly skipped_has_draft: number;
  readonly skipped_no_raw_parse: number;
  readonly over_limit: number;
}
export interface FormDraftsScope {
  readonly selector: AcquirePdfSelector;
  readonly counts: FormDraftsCounts;
}
export interface FormDraftsPartResult {
  readonly asset_id: string;
  readonly part: "main" | "supplementary";
  readonly status: "formed" | "reused" | "failed" | "skipped";
  readonly document_version_id: string | null;
  readonly failure_code: DraftFailureCode | null;
  readonly default_changed: boolean;
}
function invalid(): never {
  throw new ContractValidationError(["form-drafts"]);
}
export function parseFormDraftsCounts(value: unknown): FormDraftsCounts {
  const r = tagRecord(value, [
    "matched",
    "process",
    "process_parts",
    "skipped_has_draft",
    "skipped_no_raw_parse",
    "over_limit",
  ]);
  const counts: FormDraftsCounts = {
    matched: tagInteger(r.matched),
    process: tagInteger(r.process),
    process_parts: tagInteger(r.process_parts),
    skipped_has_draft: tagInteger(r.skipped_has_draft),
    skipped_no_raw_parse: tagInteger(r.skipped_no_raw_parse),
    over_limit: tagInteger(r.over_limit),
  };
  if (
    counts.matched !==
      counts.process +
        counts.skipped_has_draft +
        counts.skipped_no_raw_parse +
        counts.over_limit ||
    counts.process_parts < counts.process ||
    (counts.process === 0 && counts.process_parts !== 0)
  )
    invalid();
  return counts;
}
export function parseFormDraftsPartResult(
  value: unknown,
): FormDraftsPartResult {
  const r = tagRecord(value, [
    "asset_id",
    "part",
    "status",
    "document_version_id",
    "failure_code",
    "default_changed",
  ]);
  if (
    (r.part !== "main" && r.part !== "supplementary") ||
    typeof r.status !== "string" ||
    !["formed", "reused", "failed", "skipped"].includes(String(r.status)) ||
    typeof r.default_changed !== "boolean"
  )
    invalid();
  const failed = r.status === "failed";
  const accepted = r.status === "formed" || r.status === "reused";
  if (
    (failed
      ? !DRAFT_FAILURE_CODES.some((code) => code === r.failure_code)
      : r.failure_code !== null) ||
    (!accepted &&
      (r.document_version_id !== null || r.default_changed !== false))
  )
    invalid();
  return {
    asset_id: parseAssetId(r.asset_id),
    part: r.part,
    status: r.status as FormDraftsPartResult["status"],
    document_version_id: accepted ? parseAssetId(r.document_version_id) : null,
    failure_code: r.failure_code as DraftFailureCode | null,
    default_changed: r.default_changed,
  };
}
