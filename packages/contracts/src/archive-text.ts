import {
  ContractValidationError,
  parseAssetId,
  parsePageRegion,
  parseRawResourceReference,
  RAW_BLOCK_TYPES,
  type PageRegion,
  type RawBlockType,
} from "./index.js";

export const ARCHIVE_SECTION_ROLES = [
  "title",
  "authors",
  "abstract",
  "keywords",
  "introduction",
  "methods",
  "results-discussion",
  "conclusion",
  "end-matter",
  "references",
  "additional",
] as const;
export type ArchiveSectionRole = (typeof ARCHIVE_SECTION_ROLES)[number];
export const ARCHIVE_DROP_REASONS = [
  "header",
  "footer",
  "interface",
  "bibliography",
  "copyright",
  "decoration",
] as const;
export type ArchiveDropReason = (typeof ARCHIVE_DROP_REASONS)[number];
export type SourceLocator =
  | {
      readonly kind: "raw-block";
      readonly page_index: number;
      readonly block_index: number;
      readonly field: "text" | "html";
    }
  | {
      readonly kind: "raw-markdown";
      readonly start_utf8: number;
      readonly end_utf8: number;
    };
export interface ArrangementSourceBlock {
  readonly root_block_id: string;
  readonly locator: SourceLocator;
  readonly raw_parse_id: string;
  readonly result_sha256: string;
  readonly source_sha256: string;
  readonly type: RawBlockType;
  readonly text: string;
  readonly page_hint: number;
  readonly region_hint: PageRegion | null;
  readonly image_ref: string | null;
  readonly title_level: number | null;
}
export interface SourceSpan {
  readonly root_block_id: string;
  readonly source_sha256: string;
  readonly start: number;
  readonly end: number;
}
export interface ArrangementLeaf {
  readonly leaf_id: string;
  readonly source: SourceSpan;
  readonly type: RawBlockType;
  readonly original_text: string;
  readonly page_index: number;
  readonly region: PageRegion | null;
  readonly image_ref: string | null;
}
export type SectionTarget =
  | { readonly role: Exclude<ArchiveSectionRole, "additional"> }
  | {
      readonly role: "additional";
      readonly original_heading_leaf_id: string | null;
    };
export type LeafPresentation =
  | { readonly kind: "content" | "section-heading" }
  | { readonly kind: "subheading"; readonly level: 2 | 3 | 4 | 5 | 6 };
export type LeafDestination =
  | {
      readonly kind: "assigned";
      readonly target: SectionTarget;
      readonly presentation: LeafPresentation;
    }
  | { readonly kind: "dropped"; readonly reason: ArchiveDropReason };
export type ArrangementOperation =
  | {
      readonly kind: "assign";
      readonly leaf_id: string;
      readonly target: SectionTarget;
      readonly presentation: LeafPresentation;
    }
  | {
      readonly kind: "drop";
      readonly leaf_id: string;
      readonly reason: ArchiveDropReason;
    }
  | {
      readonly kind: "split";
      readonly root_block_id: string;
      readonly cuts: readonly number[];
    }
  | { readonly kind: "merge"; readonly leaf_ids: readonly string[] }
  | {
      readonly kind: "caption";
      readonly object_leaf_id: string;
      readonly caption_leaf_ids: readonly string[];
      readonly object_kind: "figure" | "table" | "scheme";
    }
  | {
      readonly kind: "assign-page";
      readonly leaf_id: string;
      readonly page_index: number;
      readonly basis_page_index: number;
      readonly reason: string;
    };
export interface ParagraphBreakCandidate {
  readonly candidate_id: string;
  readonly left_leaf_id: string;
  readonly right_leaf_id: string;
  readonly skipped_leaf_ids: readonly string[];
  readonly input_sha256: string;
  readonly rule_version: string;
  readonly left_ends_with_hyphen: boolean;
}
export type ParagraphBreakDecision =
  | { readonly candidate_id: string; readonly decision: "merge" }
  | {
      readonly candidate_id: string;
      readonly decision: "keep";
      readonly reason: string;
    };
export interface ArrangementSubmission {
  readonly schema_version: 1;
  readonly source_input_sha256: string;
  readonly reviewed_candidates_sha256: string;
  readonly operations: readonly ArrangementOperation[];
  readonly break_decisions: readonly ParagraphBreakDecision[];
}
export interface ArrangementSnapshot {
  readonly schema_version: 1;
  readonly arrangement_id: string;
  readonly source_input_sha256: string;
  readonly method_sha256: string;
  readonly leaves: readonly ArrangementLeaf[];
  readonly operations: readonly ArrangementOperation[];
  readonly destinations: readonly {
    readonly leaf_id: string;
    readonly destination: LeafDestination;
    readonly decision_id: string | null;
    readonly locked: boolean;
  }[];
  readonly break_candidates: readonly ParagraphBreakCandidate[];
  readonly break_decisions: readonly ParagraphBreakDecision[];
  readonly manual_revision: number;
}
export type ManualArrangementChange = {
  readonly kind: "restore" | "assign";
  readonly leaf_id: string;
  readonly target: SectionTarget;
  readonly presentation: LeafPresentation;
};
export interface CorrectOperation {
  readonly kind: "correct";
  readonly leaf_id: string;
  readonly start: number;
  readonly end: number;
  readonly original: string;
  readonly replacement: string;
  readonly basis_page_index: number;
  readonly reason: string;
}
export interface CorrectRecord {
  readonly correction_id: string;
  readonly operation: CorrectOperation;
  readonly source_span: SourceSpan;
  readonly source: "agent" | "manual";
  readonly decision_id: string | null;
}
export type RetainedSuspectKind = "missing" | "extra" | "token-mismatch";
export interface RetainedPageSuspect {
  readonly suspect_id: string;
  readonly page_index: number;
  readonly kind: RetainedSuspectKind;
  readonly leaf_ids: readonly string[];
  readonly tokens: readonly string[];
}
export type SuspectDisposition =
  | {
      readonly suspect_id: string;
      readonly status: "fixed";
      readonly correction_ids: readonly string[];
    }
  | {
      readonly suspect_id: string;
      readonly status: "draft-correct" | "uncertain";
      readonly reason: string;
    };
export interface PageProofreadSubmission {
  readonly schema_version: 2;
  readonly page_index: number;
  readonly page_input_sha256: string;
  readonly corrections: readonly CorrectOperation[];
  readonly no_change: boolean;
  readonly dispositions: readonly SuspectDisposition[];
}
export interface ArchiveModelUsage {
  readonly calls: number;
  readonly compaction_calls: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly usage_complete: boolean;
  readonly elapsed_ms: number;
}
export const ARCHIVE_TEXT_STOP_CODES = [
  "validation-repeated",
  "no-progress",
  "cancelled",
  "interrupted",
  "input-missing",
  "input-stale",
  "manual-conflict",
  "page-content-missing",
  "page-tools-unavailable",
  "model-unavailable",
  "model-failed",
  "request-too-large",
  "response-too-large",
  "source-integrity",
  "publication-conflict",
  "render-failed",
  "other",
] as const;
export interface ArchiveTextStop {
  readonly code: (typeof ARCHIVE_TEXT_STOP_CODES)[number];
  readonly step:
    | "arrange"
    | "proofread"
    | "render"
    | "metadata"
    | "references"
    | "tags";
  readonly scope: "part" | "page";
  readonly page_index: number | null;
  readonly retryable: boolean;
  readonly cause_code: string | null;
  readonly validation: {
    readonly fingerprint: string;
    readonly issue_codes: readonly string[];
    readonly consecutive: number;
    readonly threshold: number;
  } | null;
  readonly progress: {
    readonly consecutive_calls: number;
    readonly threshold: number;
  } | null;
}
export interface PageReviewEvidence {
  readonly read_leaf_ids: readonly string[];
  readonly viewed_full_page: boolean;
  readonly viewed_regions: readonly PageRegion[];
}
export interface PageProofreadRecord {
  readonly schema_version: 2;
  readonly page_index: number;
  readonly page_kind: "text-layer" | "image-only" | "blank";
  readonly page_input_sha256: string;
  readonly retained_leaf_ids: readonly string[];
  readonly evidence: PageReviewEvidence;
  readonly suspects: readonly RetainedPageSuspect[];
  readonly dispositions: readonly SuspectDisposition[];
  readonly corrections: readonly CorrectRecord[];
  readonly usage: ArchiveModelUsage;
  readonly status: "accepted" | "not-required" | "pending" | "failed";
  readonly no_change: boolean;
  readonly not_required_reason:
    | "blank"
    | "all-content-classified"
    | "no-retained-content"
    | null;
  readonly classified_leaf_ids: readonly string[];
  readonly stop: ArchiveTextStop | null;
}
export interface ArchiveTextIssue {
  readonly code: "page-content-missing";
  readonly page_index: number;
  readonly affects_readiness: false;
}

function fail(): never {
  throw new ContractValidationError();
}
function record(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).sort().join() !== [...keys].sort().join()
  )
    fail();
  return v as Record<string, unknown>;
}
function list<T>(
  v: unknown,
  parse: (v: unknown) => T,
  max = 100000,
): readonly T[] {
  if (!Array.isArray(v) || v.length > max) fail();
  return Object.freeze(v.map(parse));
}
function number(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(v) || Number(v) < 0 || Number(v) > max) fail();
  return Number(v);
}
function text(v: unknown, max = 4 * 1024 * 1024): string {
  if (typeof v !== "string" || v.length > max || v.includes("\0")) fail();
  return v;
}
function word(v: unknown): string {
  const s = text(v, 80);
  if (!/^\S{1,40}$/u.test(s)) fail();
  return s;
}
function hash(v: unknown): string {
  const s = text(v, 64);
  if (!/^[a-f0-9]{64}$/u.test(s)) fail();
  return s;
}
function bool(v: unknown): boolean {
  if (typeof v !== "boolean") fail();
  return v;
}
function choice<T extends string>(v: unknown, values: readonly T[]): T {
  if (typeof v !== "string" || !values.includes(v as T)) fail();
  return v as T;
}
function ids(v: unknown): readonly string[] {
  const a = list(v, parseAssetId);
  if (new Set(a).size !== a.length) fail();
  return a;
}
export function parseArchiveSectionTarget(v: unknown): SectionTarget {
  const role = choice(
    v && typeof v === "object" && "role" in v ? v.role : undefined,
    ARCHIVE_SECTION_ROLES,
  );
  if (role === "additional") {
    const r = record(v, ["role", "original_heading_leaf_id"]);
    return {
      role,
      original_heading_leaf_id:
        r.original_heading_leaf_id === null
          ? null
          : parseAssetId(r.original_heading_leaf_id),
    };
  }
  record(v, ["role"]);
  return { role };
}
export function parseLeafPresentation(v: unknown): LeafPresentation {
  const kind = choice(
    v && typeof v === "object" && "kind" in v ? v.kind : undefined,
    ["content", "section-heading", "subheading"] as const,
  );
  if (kind === "subheading") {
    const r = record(v, ["kind", "level"]);
    const level = number(r.level, 6);
    if (level < 2) fail();
    return { kind, level: level as 2 | 3 | 4 | 5 | 6 };
  }
  record(v, ["kind"]);
  return { kind };
}
export function parseLeafDestination(v: unknown): LeafDestination {
  const kind = choice(
    v && typeof v === "object" && "kind" in v ? v.kind : undefined,
    ["assigned", "dropped"] as const,
  );
  if (kind === "dropped") {
    const r = record(v, ["kind", "reason"]);
    return { kind, reason: choice(r.reason, ARCHIVE_DROP_REASONS) };
  }
  const r = record(v, ["kind", "target", "presentation"]);
  return {
    kind,
    target: parseArchiveSectionTarget(r.target),
    presentation: parseLeafPresentation(r.presentation),
  };
}
export function parseSourceSpan(v: unknown): SourceSpan {
  const r = record(v, ["root_block_id", "source_sha256", "start", "end"]);
  const start = number(r.start),
    end = number(r.end);
  if (end < start) fail();
  return {
    root_block_id: parseAssetId(r.root_block_id),
    source_sha256: hash(r.source_sha256),
    start,
    end,
  };
}
export function parseArrangementSourceBlock(
  v: unknown,
  pageCount: number,
): ArrangementSourceBlock {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 10000)
    fail();
  const r = record(v, [
    "root_block_id",
    "locator",
    "raw_parse_id",
    "result_sha256",
    "source_sha256",
    "type",
    "text",
    "page_hint",
    "region_hint",
    "image_ref",
    "title_level",
  ]);
  const raw = r.locator;
  const kind = choice(
    raw && typeof raw === "object" && "kind" in raw ? raw.kind : undefined,
    ["raw-block", "raw-markdown"] as const,
  );
  let locator: SourceLocator;
  if (kind === "raw-block") {
    const q = record(raw, ["kind", "page_index", "block_index", "field"]);
    locator = {
      kind,
      page_index: number(q.page_index, pageCount - 1),
      block_index: number(q.block_index),
      field: choice(q.field, ["text", "html"] as const),
    };
  } else {
    const q = record(raw, ["kind", "start_utf8", "end_utf8"]);
    const start = number(q.start_utf8),
      end = number(q.end_utf8);
    if (end <= start) fail();
    locator = { kind, start_utf8: start, end_utf8: end };
  }
  const title = r.title_level === null ? null : number(r.title_level, 6);
  if (title === 0) fail();
  return {
    root_block_id: parseAssetId(r.root_block_id),
    locator,
    raw_parse_id: parseAssetId(r.raw_parse_id),
    result_sha256: hash(r.result_sha256),
    source_sha256: hash(r.source_sha256),
    type: choice(r.type, RAW_BLOCK_TYPES),
    text: text(r.text),
    page_hint: number(r.page_hint, pageCount - 1),
    region_hint: r.region_hint === null ? null : parsePageRegion(r.region_hint),
    image_ref:
      r.image_ref === null ? null : parseRawResourceReference(r.image_ref),
    title_level: title,
  };
}
export function parseArrangementLeaf(
  v: unknown,
  pageCount: number,
): ArrangementLeaf {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 10000)
    fail();
  const r = record(v, [
    "leaf_id",
    "source",
    "type",
    "original_text",
    "page_index",
    "region",
    "image_ref",
  ]);
  const source = parseSourceSpan(r.source),
    original_text = text(r.original_text);
  if ([...original_text].length !== source.end - source.start) fail();
  return {
    leaf_id: parseAssetId(r.leaf_id),
    source,
    type: choice(r.type, RAW_BLOCK_TYPES),
    original_text,
    page_index: number(r.page_index, pageCount - 1),
    region: r.region === null ? null : parsePageRegion(r.region),
    image_ref:
      r.image_ref === null ? null : parseRawResourceReference(r.image_ref),
  };
}
export function parseArrangementOperation(v: unknown): ArrangementOperation {
  const kind = choice(
    v && typeof v === "object" && "kind" in v ? v.kind : undefined,
    ["assign", "drop", "split", "merge", "caption", "assign-page"] as const,
  );
  if (kind === "split") {
    const r = record(v, ["kind", "root_block_id", "cuts"]),
      cuts = list(r.cuts, (x) => number(x));
    if (
      !cuts.length ||
      cuts.some((x, i) => x === 0 || (i > 0 && x <= cuts[i - 1]!))
    )
      fail();
    return { kind, root_block_id: parseAssetId(r.root_block_id), cuts };
  }
  if (kind === "merge") {
    const r = record(v, ["kind", "leaf_ids"]),
      leaf_ids = ids(r.leaf_ids);
    if (leaf_ids.length < 2) fail();
    return { kind, leaf_ids };
  }
  if (kind === "caption") {
    const r = record(v, [
      "kind",
      "object_leaf_id",
      "caption_leaf_ids",
      "object_kind",
    ]);
    const caption_leaf_ids = ids(r.caption_leaf_ids);
    if (!caption_leaf_ids.length) fail();
    return {
      kind,
      object_leaf_id: parseAssetId(r.object_leaf_id),
      caption_leaf_ids,
      object_kind: choice(r.object_kind, [
        "figure",
        "table",
        "scheme",
      ] as const),
    };
  }
  if (kind === "assign-page") {
    const r = record(v, [
      "kind",
      "leaf_id",
      "page_index",
      "basis_page_index",
      "reason",
    ]);
    return {
      kind,
      leaf_id: parseAssetId(r.leaf_id),
      page_index: number(r.page_index, 9999),
      basis_page_index: number(r.basis_page_index, 9999),
      reason: word(r.reason),
    };
  }
  if (kind === "drop") {
    const r = record(v, ["kind", "leaf_id", "reason"]);
    return {
      kind,
      leaf_id: parseAssetId(r.leaf_id),
      reason: choice(r.reason, ARCHIVE_DROP_REASONS),
    };
  }
  const r = record(v, ["kind", "leaf_id", "target", "presentation"]);
  return {
    kind,
    leaf_id: parseAssetId(r.leaf_id),
    target: parseArchiveSectionTarget(r.target),
    presentation: parseLeafPresentation(r.presentation),
  };
}
export function parseParagraphBreakDecision(
  v: unknown,
): ParagraphBreakDecision {
  const decision = choice(
    v && typeof v === "object" && "decision" in v ? v.decision : undefined,
    ["merge", "keep"] as const,
  );
  const r = record(
    v,
    decision === "keep"
      ? ["candidate_id", "decision", "reason"]
      : ["candidate_id", "decision"],
  );
  const candidate_id = hash(r.candidate_id);
  return decision === "keep"
    ? { candidate_id, decision, reason: word(r.reason) }
    : { candidate_id, decision };
}
export function parseArrangementSubmission(v: unknown): ArrangementSubmission {
  const r = record(v, [
    "schema_version",
    "source_input_sha256",
    "reviewed_candidates_sha256",
    "operations",
    "break_decisions",
  ]);
  if (r.schema_version !== 1) fail();
  return {
    schema_version: 1,
    source_input_sha256: hash(r.source_input_sha256),
    reviewed_candidates_sha256: hash(r.reviewed_candidates_sha256),
    operations: list(r.operations, parseArrangementOperation),
    break_decisions: list(r.break_decisions, parseParagraphBreakDecision),
  };
}
export function parseArrangementSnapshot(
  v: unknown,
  pageCount: number,
): ArrangementSnapshot {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 10000)
    fail();
  const r = record(v, [
    "schema_version",
    "arrangement_id",
    "source_input_sha256",
    "method_sha256",
    "leaves",
    "operations",
    "destinations",
    "break_candidates",
    "break_decisions",
    "manual_revision",
  ]);
  if (r.schema_version !== 1) fail();
  const leaves = list(r.leaves, (x) => parseArrangementLeaf(x, pageCount));
  const leafIds = new Set(leaves.map((x) => x.leaf_id));
  if (leafIds.size !== leaves.length) fail();
  const destinations = list(r.destinations, (x) => {
    const d = record(x, ["leaf_id", "destination", "decision_id", "locked"]);
    const locked = bool(d.locked),
      decision_id = d.decision_id === null ? null : parseAssetId(d.decision_id);
    if (locked !== !!decision_id) fail();
    return {
      leaf_id: parseAssetId(d.leaf_id),
      destination: parseLeafDestination(d.destination),
      decision_id,
      locked,
    };
  });
  if (
    destinations.length !== leaves.length ||
    new Set(destinations.map((x) => x.leaf_id)).size !== leaves.length ||
    destinations.some((d) => !leafIds.has(d.leaf_id))
  )
    fail();
  const break_candidates = list(r.break_candidates, (x) => {
    const c = record(x, [
      "candidate_id",
      "left_leaf_id",
      "right_leaf_id",
      "skipped_leaf_ids",
      "input_sha256",
      "rule_version",
      "left_ends_with_hyphen",
    ]);
    return {
      candidate_id: hash(c.candidate_id),
      left_leaf_id: parseAssetId(c.left_leaf_id),
      right_leaf_id: parseAssetId(c.right_leaf_id),
      skipped_leaf_ids: ids(c.skipped_leaf_ids),
      input_sha256: hash(c.input_sha256),
      rule_version: word(c.rule_version),
      left_ends_with_hyphen: bool(c.left_ends_with_hyphen),
    };
  });
  const candidateIds = new Set(break_candidates.map((c) => c.candidate_id));
  const break_decisions = list(r.break_decisions, parseParagraphBreakDecision);
  if (
    candidateIds.size !== break_candidates.length ||
    break_candidates.some(
      (c) =>
        c.left_leaf_id === c.right_leaf_id ||
        !leafIds.has(c.left_leaf_id) ||
        !leafIds.has(c.right_leaf_id) ||
        c.skipped_leaf_ids.some(
          (id) =>
            !leafIds.has(id) || id === c.left_leaf_id || id === c.right_leaf_id,
        ),
    ) ||
    break_decisions.length !== candidateIds.size ||
    new Set(break_decisions.map((d) => d.candidate_id)).size !==
      candidateIds.size ||
    break_decisions.some((d) => !candidateIds.has(d.candidate_id))
  )
    fail();
  return {
    schema_version: 1,
    arrangement_id: hash(r.arrangement_id),
    source_input_sha256: hash(r.source_input_sha256),
    method_sha256: hash(r.method_sha256),
    leaves,
    operations: list(r.operations, parseArrangementOperation),
    destinations,
    break_candidates,
    break_decisions,
    manual_revision: number(r.manual_revision),
  };
}
export function parseCorrectOperation(v: unknown): CorrectOperation {
  const r = record(v, [
    "kind",
    "leaf_id",
    "start",
    "end",
    "original",
    "replacement",
    "basis_page_index",
    "reason",
  ]);
  if (r.kind !== "correct") fail();
  const start = number(r.start),
    end = number(r.end),
    original = text(r.original),
    replacement = text(r.replacement);
  if (
    end < start ||
    [...original].length !== end - start ||
    original === replacement
  )
    fail();
  return {
    kind: "correct",
    leaf_id: parseAssetId(r.leaf_id),
    start,
    end,
    original,
    replacement,
    basis_page_index: number(r.basis_page_index, 9999),
    reason: word(r.reason),
  };
}
export function parseSuspectDisposition(v: unknown): SuspectDisposition {
  const status = choice(
    v && typeof v === "object" && "status" in v ? v.status : undefined,
    ["fixed", "draft-correct", "uncertain"] as const,
  );
  if (status === "fixed") {
    const r = record(v, ["suspect_id", "status", "correction_ids"]),
      correction_ids = ids(r.correction_ids);
    if (!correction_ids.length) fail();
    return { suspect_id: parseAssetId(r.suspect_id), status, correction_ids };
  }
  const r = record(v, ["suspect_id", "status", "reason"]);
  return {
    suspect_id: parseAssetId(r.suspect_id),
    status,
    reason: word(r.reason),
  };
}
export function parsePageProofreadSubmission(
  v: unknown,
): PageProofreadSubmission {
  const r = record(v, [
    "schema_version",
    "page_index",
    "page_input_sha256",
    "corrections",
    "no_change",
    "dispositions",
  ]);
  if (r.schema_version !== 2) fail();
  const corrections = list(r.corrections, parseCorrectOperation),
    no_change = bool(r.no_change);
  if (no_change !== (corrections.length === 0)) fail();
  return {
    schema_version: 2,
    page_index: number(r.page_index, 9999),
    page_input_sha256: hash(r.page_input_sha256),
    corrections,
    no_change,
    dispositions: list(r.dispositions, parseSuspectDisposition),
  };
}
export function parseArchiveModelUsage(v: unknown): ArchiveModelUsage {
  const r = record(v, [
    "calls",
    "compaction_calls",
    "input_tokens",
    "output_tokens",
    "usage_complete",
    "elapsed_ms",
  ]);
  const calls = number(r.calls),
    compaction_calls = number(r.compaction_calls),
    usage_complete = bool(r.usage_complete);
  const input_tokens = r.input_tokens === null ? null : number(r.input_tokens),
    output_tokens = r.output_tokens === null ? null : number(r.output_tokens);
  if (
    compaction_calls > calls ||
    (usage_complete && (input_tokens === null || output_tokens === null))
  )
    fail();
  return {
    calls,
    compaction_calls,
    input_tokens,
    output_tokens,
    usage_complete,
    elapsed_ms: number(r.elapsed_ms),
  };
}
export function parseArchiveTextStop(v: unknown): ArchiveTextStop {
  const r = record(v, [
    "code",
    "step",
    "scope",
    "page_index",
    "retryable",
    "cause_code",
    "validation",
    "progress",
  ]);
  const code = choice(r.code, ARCHIVE_TEXT_STOP_CODES),
    scope = choice(r.scope, ["part", "page"] as const),
    page_index = r.page_index === null ? null : number(r.page_index, 9999);
  if ((scope === "part") !== (page_index === null)) fail();
  const cause_code = r.cause_code === null ? null : text(r.cause_code, 81);
  if (cause_code !== null && !/^[a-z][a-z0-9-]{0,80}$/u.test(cause_code))
    fail();
  let validation: ArchiveTextStop["validation"] = null,
    progress: ArchiveTextStop["progress"] = null;
  if (r.validation !== null) {
    const q = record(r.validation, [
      "fingerprint",
      "issue_codes",
      "consecutive",
      "threshold",
    ]);
    validation = {
      fingerprint: hash(q.fingerprint),
      issue_codes: list(q.issue_codes, word),
      consecutive: number(q.consecutive),
      threshold: number(q.threshold),
    };
    if (
      !validation.issue_codes.length ||
      validation.threshold < 1 ||
      validation.consecutive < validation.threshold
    )
      fail();
  }
  if (r.progress !== null) {
    const q = record(r.progress, ["consecutive_calls", "threshold"]);
    progress = {
      consecutive_calls: number(q.consecutive_calls),
      threshold: number(q.threshold),
    };
    if (
      progress.threshold < 1 ||
      progress.consecutive_calls < progress.threshold
    )
      fail();
  }
  if (
    (code === "validation-repeated") !== (validation !== null) ||
    (code === "no-progress") !== (progress !== null) ||
    (code === "other" && cause_code === null)
  )
    fail();
  return {
    code,
    step: choice(r.step, [
      "arrange",
      "proofread",
      "render",
      "metadata",
      "references",
      "tags",
    ] as const),
    scope,
    page_index,
    retryable: bool(r.retryable),
    cause_code,
    validation,
    progress,
  };
}
export function parsePageProofreadRecord(
  v: unknown,
  pageCount: number,
): PageProofreadRecord {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 10000)
    fail();
  const r = record(v, [
    "schema_version",
    "page_index",
    "page_kind",
    "page_input_sha256",
    "retained_leaf_ids",
    "evidence",
    "suspects",
    "dispositions",
    "corrections",
    "usage",
    "status",
    "no_change",
    "not_required_reason",
    "classified_leaf_ids",
    "stop",
  ]);
  if (r.schema_version !== 2) fail();
  const page_index = number(r.page_index, pageCount - 1),
    e = record(r.evidence, [
      "read_leaf_ids",
      "viewed_full_page",
      "viewed_regions",
    ]);
  const corrections = list(r.corrections, (x) => {
    const c = record(x, [
      "correction_id",
      "operation",
      "source_span",
      "source",
      "decision_id",
    ]);
    const source = choice(c.source, ["agent", "manual"] as const),
      decision_id = c.decision_id === null ? null : parseAssetId(c.decision_id);
    const operation = parseCorrectOperation(c.operation),
      source_span = parseSourceSpan(c.source_span);
    if (
      (source === "manual") !== (decision_id !== null) ||
      source_span.end - source_span.start !== operation.end - operation.start
    )
      fail();
    return {
      correction_id: parseAssetId(c.correction_id),
      operation,
      source_span,
      source,
      decision_id,
    };
  });
  const suspects = list(r.suspects, (x) => {
    const q = record(x, [
      "suspect_id",
      "page_index",
      "kind",
      "leaf_ids",
      "tokens",
    ]);
    return {
      suspect_id: parseAssetId(q.suspect_id),
      page_index: number(q.page_index, pageCount - 1),
      kind: choice(q.kind, ["missing", "extra", "token-mismatch"] as const),
      leaf_ids: ids(q.leaf_ids),
      tokens: list(q.tokens, (x) => text(x, 65536)),
    };
  });
  const status = choice(r.status, [
      "accepted",
      "not-required",
      "pending",
      "failed",
    ] as const),
    no_change = bool(r.no_change),
    retained_leaf_ids = ids(r.retained_leaf_ids),
    stop = r.stop === null ? null : parseArchiveTextStop(r.stop);
  const not_required_reason =
    r.not_required_reason === null
      ? null
      : choice(r.not_required_reason, [
          "blank",
          "all-content-classified",
          "no-retained-content",
        ] as const);
  const evidence = {
    read_leaf_ids: ids(e.read_leaf_ids),
    viewed_full_page: bool(e.viewed_full_page),
    viewed_regions: list(e.viewed_regions, parsePageRegion),
  };
  const dispositions = list(r.dispositions, parseSuspectDisposition),
    classified_leaf_ids = ids(r.classified_leaf_ids);
  const retainedIds = new Set(retained_leaf_ids),
    suspectIds = new Set<string>(suspects.map((s) => s.suspect_id)),
    correctionIds = new Set<string>(corrections.map((c) => c.correction_id));
  if (
    suspectIds.size !== suspects.length ||
    correctionIds.size !== corrections.length ||
    new Set(dispositions.map((d) => d.suspect_id)).size !==
      dispositions.length ||
    evidence.read_leaf_ids.some((id) => !retainedIds.has(id)) ||
    classified_leaf_ids.some((id) => retainedIds.has(id)) ||
    suspects.some(
      (s) => !s.tokens.length || s.leaf_ids.some((id) => !retainedIds.has(id)),
    ) ||
    dispositions.some(
      (d) =>
        !suspectIds.has(d.suspect_id) ||
        (d.status === "fixed" &&
          d.correction_ids.some((id) => !correctionIds.has(id))),
    ) ||
    (status === "accepted" && dispositions.length !== suspects.length) ||
    (status !== "not-required" && not_required_reason !== null) ||
    (stop !== null &&
      (stop.scope !== "page" ||
        stop.step !== "proofread" ||
        stop.page_index !== page_index))
  )
    fail();
  if (
    (status === "accepted" &&
      (stop !== null ||
        !retained_leaf_ids.length ||
        !evidence.viewed_full_page ||
        retained_leaf_ids.some((id) => !evidence.read_leaf_ids.includes(id)) ||
        no_change !== (corrections.length === 0))) ||
    (status === "not-required" &&
      (stop !== null ||
        retained_leaf_ids.length ||
        !not_required_reason ||
        corrections.length ||
        suspects.length ||
        dispositions.length ||
        !no_change)) ||
    (["failed", "pending"].includes(status) && stop === null)
  )
    fail();
  if (
    corrections.some(
      (c) =>
        c.operation.basis_page_index !== page_index ||
        !retained_leaf_ids.includes(c.operation.leaf_id),
    ) ||
    suspects.some((s) => s.page_index !== page_index)
  )
    fail();
  return {
    schema_version: 2,
    page_index,
    page_kind: choice(r.page_kind, [
      "text-layer",
      "image-only",
      "blank",
    ] as const),
    page_input_sha256: hash(r.page_input_sha256),
    retained_leaf_ids,
    evidence,
    suspects,
    dispositions,
    corrections,
    usage: parseArchiveModelUsage(r.usage),
    status,
    no_change,
    not_required_reason,
    classified_leaf_ids,
    stop,
  };
}
