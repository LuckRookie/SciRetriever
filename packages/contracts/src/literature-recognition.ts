import { ContractValidationError, parseLiteratureId } from "./index.js";
import type { LiteratureId } from "./index.js";
import {
  INTAKE_CLUES_UNREAD_REASONS,
  type IntakeCluesUnread,
  type IntakeCluesUnreadReason,
} from "./intake.js";

/** Explicit literatures accepted by one `literature-recognize` request. */
export const LITERATURE_RECOGNIZE_LIMITS = {
  literatures: 1000,
  needs_metadata: 10000,
} as const;

export type LiteratureRecognizeSelector =
  | {
      readonly kind: "literatures";
      readonly literature_ids: readonly LiteratureId[];
    }
  | { readonly kind: "needs-metadata" };
export interface LiteratureRecognizeRequest {
  readonly selector: LiteratureRecognizeSelector;
}

function exactRecord(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    throw new ContractValidationError(["literature-recognize"]);
  return value as Record<string, unknown>;
}

export function parseLiteratureRecognizeRequest(
  value: unknown,
): LiteratureRecognizeRequest {
  const r = exactRecord(value, ["selector"]);
  const kind =
    r.selector && typeof r.selector === "object"
      ? (r.selector as { kind?: unknown }).kind
      : undefined;
  if (kind === "needs-metadata") {
    exactRecord(r.selector, ["kind"]);
    return { selector: { kind } };
  }
  if (kind !== "literatures")
    throw new ContractValidationError(["literature-recognize"]);
  const ids = exactRecord(r.selector, [
    "kind",
    "literature_ids",
  ]).literature_ids;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > LITERATURE_RECOGNIZE_LIMITS.literatures
  )
    throw new ContractValidationError(["literature-recognize"]);
  const literature_ids = ids.map(parseLiteratureId);
  if (new Set(literature_ids).size !== literature_ids.length)
    throw new ContractValidationError(["literature-recognize"]);
  return { selector: { kind, literature_ids } };
}

/** One queued target of a recognition task. */
export interface LiteratureRecognizeOperationRequest {
  readonly literature_id: LiteratureId;
}
export function parseLiteratureRecognizeOperationRequest(
  value: unknown,
): LiteratureRecognizeOperationRequest {
  const r = exactRecord(value, ["literature_id"]);
  return { literature_id: parseLiteratureId(r.literature_id) };
}

export const LITERATURE_RECOGNIZE_SKIP_REASONS = [
  "not-marked",
  "no-pdf",
  "trashed",
  "withdrawn",
  "missing",
] as const;
export type LiteratureRecognizeSkipReason =
  (typeof LITERATURE_RECOGNIZE_SKIP_REASONS)[number];

/**
 * The per-literature result recorded by the task.
 * - `recognized`: identified; bibliography adopted and the mark cleared.
 * - `conflict`: identified, but the identity belongs to another literature
 *   already in the library; nothing changed and the mark stays.
 * - `candidates`: only title-similar candidates; none adopted, the mark stays.
 * - `title-replaced`: not identified; the PDF's own title replaced the
 *   temporary title, the mark stays.
 * - `unrecognized`: not identified and no title was replaced.
 * - `unread`: the PDF yielded no usable clue (`reason` is a clue reason).
 * - `skipped`: not processed (`reason` is a skip reason).
 */
export type LiteratureRecognizeOutcome =
  | "recognized"
  | "conflict"
  | "candidates"
  | "title-replaced"
  | "unrecognized"
  | "unread"
  | "skipped";
export interface LiteratureRecognizeResult {
  readonly literature_id: LiteratureId;
  readonly outcome: LiteratureRecognizeOutcome;
  readonly reason:
    | IntakeCluesUnreadReason
    | LiteratureRecognizeSkipReason
    | string
    | null;
  /** The PDF's title replaced the stored title (also possible with `candidates`). */
  readonly title_replaced: boolean;
}

/** Task-level counts; `total` is the number of fixed members. */
export interface LiteratureRecognizeReport {
  readonly total: number;
  readonly processed: number;
  readonly recognized: number;
  readonly conflicts: number;
  readonly candidates: number;
  readonly title_replaced: number;
  readonly unrecognized: number;
  readonly unread: IntakeCluesUnread;
  readonly skipped: {
    readonly total: number;
    readonly by_reason: Readonly<Record<LiteratureRecognizeSkipReason, number>>;
  };
}

export function summarizeLiteratureRecognition(
  total: number,
  results: readonly LiteratureRecognizeResult[],
): LiteratureRecognizeReport {
  const unread = Object.fromEntries(
    INTAKE_CLUES_UNREAD_REASONS.map((reason) => [reason, 0]),
  ) as Record<IntakeCluesUnreadReason, number>;
  const skipped = Object.fromEntries(
    LITERATURE_RECOGNIZE_SKIP_REASONS.map((reason) => [reason, 0]),
  ) as Record<LiteratureRecognizeSkipReason, number>;
  const counts = {
    recognized: 0,
    conflicts: 0,
    candidates: 0,
    title_replaced: 0,
    unrecognized: 0,
  };
  let unreadTotal = 0,
    skippedTotal = 0;
  for (const result of results)
    if (result.outcome === "recognized") counts.recognized++;
    else if (result.outcome === "conflict") counts.conflicts++;
    else if (result.outcome === "candidates") counts.candidates++;
    else if (result.outcome === "title-replaced") counts.title_replaced++;
    else if (result.outcome === "unrecognized") counts.unrecognized++;
    else if (result.outcome === "unread") {
      unreadTotal++;
      if (Object.hasOwn(unread, String(result.reason)))
        unread[result.reason as IntakeCluesUnreadReason]++;
      else unread["reader-failed"]++;
    } else {
      skippedTotal++;
      if (Object.hasOwn(skipped, String(result.reason)))
        skipped[result.reason as LiteratureRecognizeSkipReason]++;
      else skipped.missing++;
    }
  return {
    total,
    processed: results.length,
    ...counts,
    unread: { total: unreadTotal, by_reason: unread },
    skipped: { total: skippedTotal, by_reason: skipped },
  };
}
