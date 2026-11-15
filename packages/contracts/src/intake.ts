import {
  ContractValidationError,
  parseAssetId,
  parseLibrarySearchRequest,
  parseLiteratureId,
  parseUtcTimestamp,
  parseLiteratureMetadata,
  type LiteratureMetadata,
  type LibraryQuery,
  type LibrarySort,
  type LiteratureId,
} from "./index.js";
import { tagInteger } from "./tags.js";
import { parseFullTextCounts, type FullTextCounts } from "./library-counts.js";
import { parseFormDraftsCounts } from "./form-drafts.js";
function tagRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const r = value as Record<string, unknown>;
  if (
    required.some((k) => !Object.hasOwn(r, k)) ||
    Object.keys(r).some((k) => !required.includes(k) && !optional.includes(k))
  )
    fail();
  return r;
}

export type IntakeBatchId = string & { readonly __brand: "IntakeBatchId" };
export const parseIntakeBatchId = (value: unknown): IntakeBatchId =>
  parseAssetId(value) as string as IntakeBatchId;
export const INTAKE_BATCH_STATES = [
  "collecting",
  "awaiting-confirmation",
  "running",
  "finished",
  "cancelled",
  "withdrawn",
] as const;
export type IntakeBatchState = (typeof INTAKE_BATCH_STATES)[number];
export type IntakeBatchResult =
  | "completed"
  | "partial"
  | "failed"
  | "interrupted";
export interface IntakeSource {
  readonly system: string;
  readonly library_id: string;
  readonly identity: "global" | "local" | "adhoc";
  readonly name: string;
}
export interface IntakeProgress {
  readonly phase: "metadata" | "files" | "closing";
  readonly processed_items: number;
  readonly total_items: number;
  readonly files: {
    readonly uploaded: number;
    readonly existing: number;
    readonly conflicts: number;
    readonly pending: number;
  };
}
export interface IntakeBatch {
  readonly batch_id: IntakeBatchId;
  readonly kind: "topic" | "citation" | "import" | "legacy";
  readonly label: string;
  readonly default_label: string;
  readonly renamed: boolean;
  readonly origin: "web" | "cli" | "mcp" | "migration";
  readonly created_at: string;
  readonly finished_at: string | null;
  readonly state: IntakeBatchState;
  readonly result: IntakeBatchResult | null;
  readonly confirmation: "batch" | "per-item" | null;
  readonly confirmed_at: string | null;
  readonly initiated_by: string;
  readonly source: IntakeSource | null;
  readonly progress: IntakeProgress | null;
  readonly full_text: FullTextCounts;
  readonly estimates: { readonly acquire_pdf: number; readonly parse: number };
  readonly request: {
    readonly query?: string;
    readonly year_from?: number | null;
    readonly year_to?: number | null;
    readonly seed_literature_id?: string;
    readonly direction?: "references" | "cited-by";
    readonly format?: string;
    readonly file_name?: string | null;
    readonly metadata_only?: boolean;
    readonly providers?: readonly string[];
  };
  readonly counts: {
    readonly hits: number;
    readonly created: number;
    readonly enriched: number;
    readonly matched: number;
    readonly rejected: number;
    readonly restored: number;
    readonly conflicts: number;
    readonly possible_duplicates: number;
    readonly pending_decision: number;
    readonly needs_metadata: number;
  };
  readonly pdf: {
    readonly has_pdf: number;
    readonly unavailable: number;
    readonly pending: number;
  };
  readonly discovery_run_id: string | null;
  readonly source_failures: number;
}
export type IntakeBatchQuery =
  | {
      readonly operation: "list";
      readonly request: {
        readonly limit: number;
        readonly cursor: string | null;
      };
    }
  | {
      readonly operation: "get";
      readonly request: { readonly batch_id: IntakeBatchId };
    };
export interface IntakeBatchPage {
  readonly items: readonly IntakeBatch[];
  readonly next_cursor: string | null;
}
export interface LibraryFacets {
  readonly total: number;
  readonly coverage: {
    readonly tags: number;
    readonly keywords: number;
    readonly subject_terms: number;
  };
  readonly tags: readonly {
    readonly tag_id: string;
    readonly value: string;
    readonly count: number;
  }[];
  readonly keywords: readonly {
    readonly value: string;
    readonly count: number;
    readonly tag: { readonly tag_id: string; readonly name: string } | null;
  }[];
  readonly subject_terms: readonly {
    readonly value: string;
    readonly count: number;
  }[];
}
/** Query scopes skip existing PDFs/exhaustion; explicit Literature IDs retain all targets. */
export type AcquirePdfSelector =
  | {
      readonly kind: "query";
      readonly query: LibraryQuery;
      readonly sort: LibrarySort;
      readonly limit: number | null;
    }
  | {
      readonly kind: "literatures";
      readonly literature_ids: readonly LiteratureId[];
    };
export interface AcquirePdfCounts {
  readonly matched: number;
  readonly process: number;
  readonly skipped_has_pdf: number;
  readonly skipped_unavailable: number;
  readonly over_limit: number;
}
export interface AcquirePdfScope {
  readonly selector: AcquirePdfSelector;
  readonly counts: AcquirePdfCounts;
}
export interface ParseDocumentCounts {
  readonly matched: number;
  readonly process: number;
  readonly skipped_no_pdf: number;
  readonly skipped_parsed: number;
  readonly over_limit: number;
}
export interface ParseDocumentScope {
  readonly selector: AcquirePdfSelector;
  readonly counts: ParseDocumentCounts;
}
export type IntakeTaskScope =
  | AcquirePdfScope
  | ParseDocumentScope
  | import("./form-drafts.js").FormDraftsScope;
export function parseIntakeTaskScope(value: unknown): IntakeTaskScope {
  const r = tagRecord(value, ["selector", "counts"]);
  if (
    r.counts &&
    typeof r.counts === "object" &&
    "skipped_no_raw_parse" in r.counts
  )
    return {
      selector: parseAcquirePdfSelector(r.selector),
      counts: parseFormDraftsCounts(r.counts),
    };
  if (
    r.counts &&
    typeof r.counts === "object" &&
    "skipped_no_pdf" in r.counts
  ) {
    const c = tagRecord(r.counts, [
      "matched",
      "process",
      "skipped_no_pdf",
      "skipped_parsed",
      "over_limit",
    ]);
    const counts = {
      matched: tagInteger(c.matched),
      process: tagInteger(c.process),
      skipped_no_pdf: tagInteger(c.skipped_no_pdf),
      skipped_parsed: tagInteger(c.skipped_parsed),
      over_limit: tagInteger(c.over_limit),
    };
    if (
      counts.matched !==
      counts.process +
        counts.skipped_no_pdf +
        counts.skipped_parsed +
        counts.over_limit
    )
      fail();
    return { selector: parseAcquirePdfSelector(r.selector), counts };
  }
  return parseAcquirePdfScope(value);
}
function fail(): never {
  throw new ContractValidationError(["intake"]);
}
function text(value: unknown, max = 8192, multiline = false): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > max ||
    /[\p{Cc}\p{Cf}]/u.test(multiline ? value.replace(/[\r\n\t]/gu, "") : value)
  )
    fail();
  return value.trim().normalize("NFC");
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function member<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) fail();
  return value as T;
}
export function parseIntakeBatchQuery(value: unknown): IntakeBatchQuery {
  const e = tagRecord(value, ["operation", "request"]);
  if (e.operation === "get") {
    const r = tagRecord(e.request, ["batch_id"]);
    return {
      operation: "get",
      request: { batch_id: parseIntakeBatchId(r.batch_id) },
    };
  }
  if (e.operation !== "list") fail();
  const r = tagRecord(
    {
      limit: 50,
      cursor: null,
      ...tagRecord(e.request, [], ["limit", "cursor"]),
    },
    ["limit", "cursor"],
  );
  const limit = tagInteger(r.limit, 1);
  if (limit > 100) fail();
  const cursor = r.cursor === null ? null : text(r.cursor, 512);
  if (cursor !== null && !/^[A-Za-z0-9_-]+$/u.test(cursor)) fail();
  return { operation: "list", request: { limit, cursor } };
}
export function parseIntakeBatchRename(value: unknown) {
  const r = tagRecord(value, ["batch_id", "label"]);
  return {
    batch_id: parseIntakeBatchId(r.batch_id),
    label: r.label === null ? null : text(r.label, 120),
  };
}
export function parseLibraryFacetsRequest(value: unknown) {
  const r = tagRecord(value, ["query", "limit"]);
  const limit = tagInteger(r.limit, 1);
  if (limit > 30) fail();
  return { query: parseLibrarySearchRequest({ query: r.query }).query, limit };
}
export function parseAcquirePdfSelector(value: unknown): AcquirePdfSelector {
  const r = tagRecord(
    value,
    ["kind"],
    ["query", "sort", "limit", "literature_ids"],
  );
  if (r.kind === "literatures") {
    tagRecord(value, ["kind", "literature_ids"]);
    if (
      !Array.isArray(r.literature_ids) ||
      !r.literature_ids.length ||
      r.literature_ids.length > 10000
    )
      fail();
    return {
      kind: "literatures",
      literature_ids: [...new Set(r.literature_ids.map(parseLiteratureId))],
    };
  }
  if (r.kind !== "query") fail();
  tagRecord(value, ["kind", "query", "sort", "limit"]);
  const parsed = parseLibrarySearchRequest({ query: r.query, sort: r.sort });
  return {
    kind: "query",
    query: parsed.query,
    sort: parsed.sort,
    limit: r.limit === null ? null : tagInteger(r.limit, 1),
  };
}
export function parseAcquirePdfCounts(value: unknown): AcquirePdfCounts {
  const r = tagRecord(value, [
    "matched",
    "process",
    "skipped_has_pdf",
    "skipped_unavailable",
    "over_limit",
  ]);
  const counts = {
    matched: tagInteger(r.matched),
    process: tagInteger(r.process),
    skipped_has_pdf: tagInteger(r.skipped_has_pdf),
    skipped_unavailable: tagInteger(r.skipped_unavailable),
    over_limit: tagInteger(r.over_limit),
  };
  if (
    counts.matched !==
    counts.process +
      counts.skipped_has_pdf +
      counts.skipped_unavailable +
      counts.over_limit
  )
    fail();
  return counts;
}
export function parseAcquirePdfScope(value: unknown): AcquirePdfScope {
  const r = tagRecord(value, ["selector", "counts"]);
  return {
    selector: parseAcquirePdfSelector(r.selector),
    counts: parseAcquirePdfCounts(r.counts),
  };
}
export function parseIntakeBatch(value: unknown): IntakeBatch {
  const r = tagRecord(value, [
    "batch_id",
    "kind",
    "label",
    "default_label",
    "renamed",
    "origin",
    "created_at",
    "finished_at",
    "state",
    "result",
    "confirmation",
    "confirmed_at",
    "initiated_by",
    "source",
    "progress",
    "full_text",
    "estimates",
    "request",
    "counts",
    "pdf",
    "discovery_run_id",
    "source_failures",
  ]);
  const kind = member(r.kind, [
    "topic",
    "citation",
    "import",
    "legacy",
  ] as const);
  const state = member(r.state, INTAKE_BATCH_STATES);
  const result =
    r.result === null
      ? null
      : member(r.result, [
          "completed",
          "partial",
          "failed",
          "interrupted",
        ] as const);
  if (
    (state === "finished" && result === null) ||
    (state !== "finished" && state !== "withdrawn" && result !== null)
  )
    fail();
  const confirmation =
    r.confirmation === null
      ? null
      : member(r.confirmation, ["batch", "per-item"] as const);
  if (kind !== "import" && confirmation !== null) fail();
  let source: IntakeSource | null = null;
  if (r.source !== null) {
    const s = tagRecord(r.source, ["system", "library_id", "identity", "name"]);
    const identity = member(s.identity, ["global", "local", "adhoc"] as const);
    source = {
      system: text(s.system, 64),
      library_id:
        identity === "adhoc" && s.library_id === ""
          ? ""
          : text(s.library_id, 1024),
      identity,
      name: identity === "adhoc" && s.name === "" ? "" : text(s.name, 1024),
    };
  }
  if (kind !== "import" && source !== null) fail();
  let progress: IntakeProgress | null = null;
  if (r.progress !== null) {
    if (kind !== "import" || state !== "running") fail();
    const p = tagRecord(r.progress, [
      "phase",
      "processed_items",
      "total_items",
      "files",
    ]);
    const f = tagRecord(p.files, [
      "uploaded",
      "existing",
      "conflicts",
      "pending",
    ]);
    progress = {
      phase: member(p.phase, ["metadata", "files", "closing"] as const),
      processed_items: tagInteger(p.processed_items),
      total_items: tagInteger(p.total_items),
      files: {
        uploaded: tagInteger(f.uploaded),
        existing: tagInteger(f.existing),
        conflicts: tagInteger(f.conflicts),
        pending: tagInteger(f.pending),
      },
    };
    if (progress.processed_items > progress.total_items) fail();
  }
  const initiated_by = text(r.initiated_by, 128);
  if (
    !/^(?:local:(?:web|cli|mcp)|migration|device:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/u.test(
      initiated_by,
    )
  )
    fail();
  const c = tagRecord(r.counts, [
    "hits",
    "created",
    "enriched",
    "matched",
    "rejected",
    "restored",
    "conflicts",
    "possible_duplicates",
    "pending_decision",
    "needs_metadata",
  ]);
  const counts = {
    hits: tagInteger(c.hits),
    created: tagInteger(c.created),
    enriched: tagInteger(c.enriched),
    matched: tagInteger(c.matched),
    rejected: tagInteger(c.rejected),
    restored: tagInteger(c.restored),
    conflicts: tagInteger(c.conflicts),
    possible_duplicates: tagInteger(c.possible_duplicates),
    pending_decision: tagInteger(c.pending_decision),
    needs_metadata: tagInteger(c.needs_metadata),
  };
  if (
    kind === "legacy"
      ? counts.created + counts.enriched + counts.matched + counts.rejected !==
        0
      : counts.hits !==
        counts.created + counts.enriched + counts.matched + counts.restored
  )
    fail();
  if (kind !== "import" && counts.rejected !== 0) fail();
  const p = tagRecord(r.pdf, ["has_pdf", "unavailable", "pending"]);
  const pdf = {
    has_pdf: tagInteger(p.has_pdf),
    unavailable: tagInteger(p.unavailable),
    pending: tagInteger(p.pending),
  };
  if (
    pdf.has_pdf + pdf.unavailable + pdf.pending !== counts.hits ||
    typeof r.renamed !== "boolean"
  )
    fail();
  const q = tagRecord(
    r.request,
    [],
    kind === "topic"
      ? ["query", "year_from", "year_to", "providers"]
      : kind === "citation"
        ? ["seed_literature_id", "direction", "providers"]
        : kind === "import"
          ? ["format", "file_name", "metadata_only"]
          : [],
  );
  const request: IntakeBatch["request"] = {
    ...(q.query === undefined ? {} : { query: text(q.query, 8192, true) }),
    ...(q.seed_literature_id === undefined
      ? {}
      : { seed_literature_id: parseLiteratureId(q.seed_literature_id) }),
    ...(q.direction === undefined
      ? {}
      : {
          direction: member(q.direction, ["references", "cited-by"] as const),
        }),
    ...(q.format === undefined ? {} : { format: text(q.format) }),
    ...(q.metadata_only === undefined
      ? {}
      : {
          metadata_only:
            typeof q.metadata_only === "boolean" ? q.metadata_only : fail(),
        }),
    ...(q.file_name === undefined
      ? {}
      : { file_name: nullableText(q.file_name) }),
    ...(q.providers === undefined
      ? {}
      : {
          providers: (() => {
            if (!Array.isArray(q.providers)) fail();
            return q.providers.map((v) => text(v, 128));
          })(),
        }),
    ...Object.fromEntries(
      ["year_from", "year_to"]
        .filter((k) => q[k] !== undefined)
        .map((k) => {
          const year = q[k] === null ? null : tagInteger(q[k], 1);
          if (year !== null && year > 9999) fail();
          return [k, year];
        }),
    ),
  };
  if (
    request.year_from != null &&
    request.year_to != null &&
    request.year_from > request.year_to
  )
    fail();
  const label = text(r.label, 8192, !r.renamed),
    default_label = text(r.default_label, 8192, true);
  if (
    (!r.renamed && label !== default_label) ||
    (r.renamed && label.length > 120)
  )
    fail();
  return {
    full_text: parseFullTextCounts(r.full_text),
    estimates: (() => {
      const estimates = tagRecord(r.estimates, ["acquire_pdf", "parse"]);
      return {
        acquire_pdf: tagInteger(estimates.acquire_pdf),
        parse: tagInteger(estimates.parse),
      };
    })(),
    batch_id: parseIntakeBatchId(r.batch_id),
    kind,
    label,
    default_label,
    renamed: r.renamed,
    origin: member(r.origin, ["web", "cli", "mcp", "migration"] as const),
    created_at: parseUtcTimestamp(r.created_at),
    finished_at:
      r.finished_at === null ? null : parseUtcTimestamp(r.finished_at),
    state,
    result,
    confirmation,
    source,
    progress,
    initiated_by,
    confirmed_at:
      r.confirmed_at === null ? null : parseUtcTimestamp(r.confirmed_at),
    request,
    counts,
    pdf,
    discovery_run_id:
      r.discovery_run_id === null ? null : parseAssetId(r.discovery_run_id),
    source_failures: tagInteger(r.source_failures),
  };
}
export function parseIntakeBatchPage(value: unknown): IntakeBatchPage {
  const r = tagRecord(value, ["items", "next_cursor"]);
  if (!Array.isArray(r.items) || r.items.length > 100) fail();
  return {
    items: r.items.map(parseIntakeBatch),
    next_cursor: r.next_cursor === null ? null : text(r.next_cursor, 512),
  };
}
export function parseLibraryFacets(value: unknown): LibraryFacets {
  const r = tagRecord(value, [
      "total",
      "coverage",
      "tags",
      "keywords",
      "subject_terms",
    ]),
    total = tagInteger(r.total),
    c = tagRecord(r.coverage, ["tags", "keywords", "subject_terms"]),
    coverage = {
      tags: tagInteger(c.tags),
      keywords: tagInteger(c.keywords),
      subject_terms: tagInteger(c.subject_terms),
    };
  if (Object.values(coverage).some((count) => count > total)) fail();
  const terms = (
    v: unknown,
    covered: number,
    extra: readonly string[] = [],
  ) => {
    if (!Array.isArray(v) || v.length > 30) fail();
    return v.map((x) => {
      const row = tagRecord(x, ["value", "count", ...extra]);
      const count = tagInteger(row.count, 1);
      if (count > covered) fail();
      return { row, value: text(row.value), count };
    });
  };
  return {
    total,
    coverage,
    tags: terms(r.tags, coverage.tags, ["tag_id"]).map(({ row, ...term }) => ({
      ...term,
      tag_id: parseAssetId(row.tag_id),
    })),
    keywords: terms(r.keywords, coverage.keywords, ["tag"]).map(
      ({ row, ...term }) => {
        const tag =
          row.tag === null ? null : tagRecord(row.tag, ["tag_id", "name"]);
        return {
          ...term,
          tag:
            tag === null
              ? null
              : { tag_id: parseAssetId(tag.tag_id), name: text(tag.name) },
        };
      },
    ),
    subject_terms: terms(r.subject_terms, coverage.subject_terms).map(
      ({ value, count }) => ({ value, count }),
    ),
  };
}

export const INTAKE_LIMITS = {
  request_bytes: 8 * 1024 * 1024,
  json_request_bytes: 64 * 1024,
  page_request_bytes: 640 * 1024,
  batch_bytes: 256 * 1024 * 1024,
  records: 50_000,
  parts: 1024,
  groups: 10_000,
  page_items: 200,
  disk_reserve_bytes: 256 * 1024 * 1024,
  expiry_ms: 7 * 24 * 60 * 60 * 1000,
} as const;
export interface IntakeGroup {
  readonly external_id: string;
  readonly parent_external_id: string | null;
  readonly name: string;
}
export interface IntakeFile {
  readonly external_id: string;
  readonly file_name: string;
  readonly media_type: string;
  readonly preferred: boolean;
  readonly size_bytes: number | null;
  readonly sha256: string | null;
}
export interface IntakeAnnotation {
  readonly external_id: string;
  readonly file_external_id: string;
  readonly kind: "highlight" | "underline" | "region" | "note" | "text" | "ink";
  readonly quote: string;
  readonly note: string;
  readonly color: string | null;
  readonly page_index: number | null;
  readonly coordinate_space: "pdf-bottom-left" | "normalized-top-left";
  readonly rects: readonly (readonly [number, number, number, number])[];
}
export interface IntakeItem {
  readonly external_id: string;
  readonly metadata: LiteratureMetadata;
  readonly source_type: string | null;
  readonly groups: readonly string[];
  readonly user_tags: readonly string[];
  readonly files: readonly IntakeFile[];
  readonly annotations: readonly IntakeAnnotation[];
}
export interface IntakeExcluded {
  readonly kind: string;
  readonly count: number;
}
export interface IntakeData {
  readonly records: readonly IntakeItem[];
  readonly groups: readonly IntakeGroup[];
  readonly excluded: readonly IntakeExcluded[];
}
export interface IntakeAdapterItem {
  readonly external_id?: string;
  readonly record_index: number;
  readonly record: IntakeItem | null;
  readonly reason: string | null;
}
export interface IntakeAdapterResult {
  readonly items: readonly IntakeAdapterItem[];
  readonly groups: readonly IntakeGroup[];
  readonly excluded: readonly IntakeExcluded[];
}
/** Pure conversion only. No I/O, randomness, clock, database or network. */
export interface IntakeAdapter {
  readonly format: string;
  decode(data: unknown, sequence: number): IntakeAdapterResult;
}
export interface IntakeItemResult {
  readonly sequence: number;
  readonly record_index: number;
  readonly external_id: string;
  readonly disposition:
    | "created"
    | "enriched"
    | "matched"
    | "conflict"
    | "rejected"
    | "restored"
    | "pending-decision"
    | "excluded";
  readonly literature_id: string | null;
  readonly meta_literature_id: string | null;
  readonly reason: string | null;
}
export interface IntakeFileStatus {
  readonly file_id: string;
  readonly external_id: string;
  readonly record_external_id: string;
  readonly literature_id: string;
  readonly file_name: string;
  readonly size_bytes: number | null;
  readonly expected_sha256: string | null;
  readonly action: "upload" | "hash";
  readonly status: "pending" | "uploaded" | "existing" | "conflict";
  readonly sha256: string | null;
  readonly reason: string | null;
}
export interface IntakeSummary {
  readonly full_text: FullTextCounts;
  readonly records: {
    readonly created: number;
    readonly enriched: number;
    readonly matched: number;
    readonly conflicts: number;
    readonly rejected: number;
    readonly restored: number;
    readonly possible_duplicates: number;
    readonly pending_decision: number;
    readonly needs_metadata: number;
  };
  readonly files: {
    readonly upload: number;
    readonly hash: number;
    readonly uploaded: number;
    readonly existing: number;
    readonly conflicts: number;
    readonly missing: number;
    readonly unpaired: number;
  };
  readonly annotations: {
    readonly supported: number;
    readonly unsupported: number;
    readonly imported: 0;
    readonly deferred: number;
  };
  readonly excluded: readonly IntakeExcluded[];
}
export interface IntakePreview {
  readonly batch: IntakeBatch;
  readonly estimated: true;
  readonly summary: IntakeSummary;
}
export interface IntakeReport {
  readonly batch: IntakeBatch;
  readonly estimated: false;
  readonly summary: IntakeSummary;
  readonly items: readonly IntakeItemResult[];
  readonly next_cursor: string | null;
}
export interface ExternalObjectMapping {
  readonly library_key: string;
  readonly object_kind: "record" | "group" | "file" | "annotation";
  readonly external_id: string;
  readonly internal_id: string;
  readonly state: "pending" | "settled";
  readonly content_sha256: string | null;
  readonly observation_id: string | null;
}
export function importObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractValidationError();
  const r = value as Record<string, unknown>;
  if (
    required.some((k) => !Object.hasOwn(r, k)) ||
    Object.keys(r).some((k) => !required.includes(k) && !optional.includes(k))
  )
    throw new ContractValidationError();
  return r;
}
export function importString(value: unknown, max = 1024): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  )
    throw new ContractValidationError();
  return value.trim();
}
export function importHash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
    throw new ContractValidationError();
  return value;
}
export function importInteger(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    throw new ContractValidationError();
  return value;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new ContractValidationError();
  return value;
}
function fileReference(value: unknown) {
  const reference = importString(value);
  if (
    /^(?:[/\\]|[a-zA-Z]:[/\\])/u.test(reference) ||
    reference.split(/[/\\]/u).some((v) => v === "." || v === "..")
  )
    throw new ContractValidationError();
  return reference;
}
export function parseIntakeCreate(value: unknown) {
  const r = importObject(
    value,
    ["format", "source", "scope"],
    ["import_user_tags", "file_name", "metadata_only"],
  );
  if (
    r.import_user_tags !== undefined &&
    typeof r.import_user_tags !== "boolean"
  )
    throw new ContractValidationError();
  if (r.metadata_only !== undefined && typeof r.metadata_only !== "boolean")
    throw new ContractValidationError();
  let source: {
    system: string;
    library_id: string;
    identity: "global" | "local";
    name: string;
  } | null = null;
  if (r.source !== null) {
    const l = importObject(r.source, [
      "system",
      "library_id",
      "identity",
      "name",
    ]);
    if (!["global", "local"].includes(String(l.identity)))
      throw new ContractValidationError();
    const system = importString(l.system, 64);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(system))
      throw new ContractValidationError();
    source = {
      system,
      library_id: importString(l.library_id),
      identity: l.identity as "global" | "local",
      name: importString(l.name, 1024),
    };
  }
  return {
    format: importString(r.format, 64),
    source,
    scope: importString(r.scope, 8192),
    file_name:
      r.file_name === undefined || r.file_name === null
        ? null
        : importString(r.file_name, 1024),
    import_user_tags: r.import_user_tags !== false,
    metadata_only: r.metadata_only === true,
  };
}
export function parseIntakeData(value: unknown): IntakeData {
  const r = importObject(value, ["records"], ["groups", "excluded"]);
  const groups = array(r.groups ?? [], INTAKE_LIMITS.groups).map((value) => {
    const g = importObject(value, [
      "external_id",
      "parent_external_id",
      "name",
    ]);
    return {
      external_id: importString(g.external_id),
      parent_external_id:
        g.parent_external_id === null
          ? null
          : importString(g.parent_external_id),
      name: importString(g.name, 4096),
    };
  });
  const excluded = array(r.excluded ?? [], 128).map((value) => {
    const e = importObject(value, ["kind", "count"]);
    const kind = importString(e.kind, 64);
    if (!/^[a-z][a-z0-9-]*$/u.test(kind)) throw new ContractValidationError();
    return { kind, count: importInteger(e.count) };
  });
  const records = array(r.records, INTAKE_LIMITS.records).map((value) => {
    const v = importObject(
      value,
      ["external_id", "metadata"],
      ["source_type", "groups", "user_tags", "files", "annotations"],
    );
    const files = array(v.files ?? [], 100).map((value) => {
      const f = importObject(
        value,
        ["external_id", "file_name", "media_type", "preferred"],
        ["size_bytes", "sha256"],
      );
      if (typeof f.preferred !== "boolean") throw new ContractValidationError();
      const file_name = importString(f.file_name);
      if (/[/\\]/u.test(file_name) || file_name === "." || file_name === "..")
        throw new ContractValidationError();
      return {
        external_id: fileReference(f.external_id),
        file_name,
        media_type: importString(f.media_type, 128),
        preferred: f.preferred,
        size_bytes:
          f.size_bytes === null || f.size_bytes === undefined
            ? null
            : importInteger(f.size_bytes),
        sha256:
          f.sha256 === null || f.sha256 === undefined
            ? null
            : importHash(f.sha256),
      };
    });
    if (files.filter((f) => f.preferred).length > 1)
      throw new ContractValidationError();
    const annotations = array(v.annotations ?? [], 10000).map((value) => {
      const a = importObject(
        value,
        ["external_id", "file_external_id", "kind"],
        ["quote", "note", "color", "page_index", "coordinate_space", "rects"],
      );
      if (
        !["highlight", "underline", "region", "note", "text", "ink"].includes(
          String(a.kind),
        ) ||
        (a.quote !== undefined && typeof a.quote !== "string") ||
        (a.note !== undefined && typeof a.note !== "string") ||
        (a.coordinate_space !== undefined &&
          !["pdf-bottom-left", "normalized-top-left"].includes(
            String(a.coordinate_space),
          ))
      )
        throw new ContractValidationError();
      const rects = array(a.rects ?? [], 128).map((rect) => {
        const v = array(rect, 4);
        if (
          v.length !== 4 ||
          v.some((n) => typeof n !== "number" || !Number.isFinite(n))
        )
          throw new ContractValidationError();
        return v as [number, number, number, number];
      });
      return {
        external_id: importString(a.external_id),
        file_external_id: importString(a.file_external_id),
        kind: a.kind as IntakeAnnotation["kind"],
        quote: (a.quote ?? "") as string,
        note: (a.note ?? "") as string,
        color:
          a.color === null || a.color === undefined
            ? null
            : importString(a.color, 64),
        page_index:
          a.page_index === null || a.page_index === undefined
            ? null
            : importInteger(a.page_index),
        coordinate_space: (a.coordinate_space ??
          "pdf-bottom-left") as IntakeAnnotation["coordinate_space"],
        rects,
      };
    });
    return {
      external_id: importString(v.external_id),
      metadata: parseLiteratureMetadata(v.metadata),
      source_type:
        v.source_type === null || v.source_type === undefined
          ? null
          : importString(v.source_type, 128),
      groups: array(v.groups ?? [], 1000).map((v) => importString(v)),
      user_tags: array(v.user_tags ?? [], 1000).map((v) =>
        importString(v, 4096),
      ),
      files,
      annotations,
    };
  });
  return { records, groups, excluded };
}

/** Implemented intake routes. Later recognition/decision/withdrawal routes register when connected. */
export const INTAKE_HTTP_ENDPOINTS = [
  [
    "POST",
    "/api/v1/intake/batches/:batch_id/file-items",
    "file-items",
    "raw PDF; X-Sciretriever-File-Name; optional X-Sciretriever-Relative-Path",
    "{item:IntakeBatchItem}",
  ],
  [
    "POST",
    "/api/v1/intake/batches/:batch_id/preview/cancel",
    "preview-cancel",
    "{}",
    "{batch,recognition}",
  ],
  [
    "POST",
    "/api/v1/intake/batches/:batch_id/items",
    "items",
    "{cursor?:UUID|null,limit?:1..200,needs?:decision|unpaired|null}",
    "{items:IntakeBatchItem[],next_cursor:string|null}",
  ],
  [
    "POST",
    "/api/v1/intake/batches/:batch_id/items/:item_id/status",
    "item-status",
    "{}",
    "{item:IntakeBatchItem}",
  ],
  [
    "POST",
    "/api/v1/intake/batches/:batch_id/items/:item_id/decide",
    "item-decide",
    "{decision:IntakeDecision}",
    "{item:IntakeBatchItem}",
  ],
  ["POST", "/api/v1/intake/folders", "folders", "{}", "{folders:Folder[]}"],
  [
    "POST",
    "/api/v1/intake/literatures/:literature_id/pdf",
    "supplement",
    "raw PDF; X-Sciretriever-File-Name: percent-encoded UTF-8",
    "{batch_id,file:IntakeFileStatus}",
  ],
  [
    "GET",
    "/api/v1/intake/instructions",
    "instructions",
    "",
    "Interface reference",
  ],
  [
    "GET",
    "/api/v1/intake/agent-guide",
    "agent-guide",
    "",
    "Markdown attachment",
  ],
  ["GET", "/api/v1/intake/skill", "skill", "", "ZIP attachment"],
  ["GET", "/api/v1/intake/extension", "extension", "", "ZIP attachment"],
  [
    "POST",
    "/api/v1/intake/batches",
    "create",
    "{format,source:null|{system,library_id,identity:global|local,name},scope,import_user_tags?:boolean,file_name?:string|null,metadata_only?:boolean}",
    "{batch:IntakeBatch}",
  ],
  [
    "POST",
    "/api/v1/intake/batches/list",
    "list",
    "{cursor?:batch_id|null,limit?:1..200}",
    "{items:IntakeBatch[],next_cursor:string|null}",
  ],
  [
    "POST",
    "/api/v1/intake/batches/:batch_id/status",
    "status",
    "{}",
    "{batch:IntakeBatch}",
  ],
  [
    "POST",
    "/api/v1/intake/batches/:batch_id/data",
    "data",
    "{sequence:0..1023,data:IntakeData|string}",
    "{batch:IntakeBatch}",
  ],
  [
    "POST",
    "/api/v1/intake/batches/:batch_id/preview",
    "preview",
    "{}",
    "{batch:IntakeBatch,estimated:true,summary:IntakeSummary}",
  ],
  [
    "POST",
    "/api/v1/intake/batches/:batch_id/confirm",
    "confirm",
    "{}",
    "{batch:IntakeBatch}",
  ],
  [
    "POST",
    "/api/v1/intake/batches/:batch_id/files",
    "files",
    "{cursor?:file_id|null,limit?:1..200,pending?:boolean}",
    "{items:IntakeFileStatus[],next_cursor:string|null}",
  ],
  [
    "POST",
    "/api/v1/intake/batches/:batch_id/files/:file_id/hash",
    "hash",
    "{sha256}",
    "{file:IntakeFileStatus}",
  ],
  [
    "POST",
    "/api/v1/intake/batches/:batch_id/files/:file_id/bytes",
    "bytes",
    "raw application/pdf or application/octet-stream",
    "{file:IntakeFileStatus}",
  ],
  [
    "POST",
    "/api/v1/intake/batches/:batch_id/finish",
    "finish",
    "{}",
    "{batch:IntakeBatch}",
  ],
  [
    "POST",
    "/api/v1/intake/batches/:batch_id/cancel",
    "cancel",
    "{}",
    "{batch:IntakeBatch}",
  ],
  [
    "POST",
    "/api/v1/intake/batches/:batch_id/report",
    "report",
    "{cursor?:sequence:record_index|null,limit?:1..200}",
    "{batch:IntakeBatch,estimated:false,summary:IntakeSummary,items:IntakeItemResult[],next_cursor:string|null}",
  ],
  [
    "POST",
    "/api/v1/intake/pages/preview",
    "page-preview",
    "{page:WebPageData}",
    "IntakePagePreview",
  ],
  [
    "POST",
    "/api/v1/intake/pages/save",
    "page-save",
    "{request_id,page:WebPageData,folder_ids?:UUID[],file?:IntakePageFile|null,duplicate_decision?:{kind:merge,literature_id}|{kind:new}}",
    "IntakePageResult",
  ],
] as const;
export const INTAKE_ERROR_STATUSES = {
  "intake-input-invalid": 400,
  "intake-item-empty": 400,
  "intake-format-unsupported": 400,
  "intake-local-identity-required": 400,
  "intake-data-conflict": 400,
  "intake-group-missing": 400,
  "intake-group-cycle": 400,
  "intake-group-depth": 400,
  "intake-folder-target-missing": 400,
  "intake-file-hash-mismatch": 400,
  "intake-file-size-mismatch": 400,
  "intake-upload-cancelled": 400,
  "intake-decision-invalid": 400,
  "intake-device-required": 403,
  "intake-batch-missing": 404,
  "intake-item-missing": 404,
  "intake-file-missing": 404,
  "intake-literature-missing": 404,
  "intake-source-busy": 409,
  "intake-batch-state": 409,
  "intake-data-changed": 409,
  "intake-recognition-pending": 409,
  "intake-metadata-pending": 409,
  "intake-file-hash-required": 409,
  "intake-file-upload-required": 409,
  "intake-file-conflict": 409,
  "intake-source-stale": 409,
  "intake-request-conflict": 409,
  "intake-identity-conflict": 409,
  "intake-decision-required": 409,
  "intake-batch-busy": 409,
  "intake-request-too-large": 413,
  "intake-batch-limit": 413,
  "intake-pdf-invalid": 422,
  "intake-disk-space": 507,
  "intake-disk-unavailable": 503,
  "intake-unavailable": 503,
  "intake-closed": 503,
} as const;
export type IntakeErrorCode = keyof typeof INTAKE_ERROR_STATUSES;
export type IntakeDisposition = IntakeItemResult["disposition"];
export type IntakeDecision =
  | { readonly kind: "merge"; readonly literature_id: LiteratureId }
  | { readonly kind: "new" }
  | { readonly kind: "candidate"; readonly candidate_id: string }
  | { readonly kind: "unrecognized" | "include" | "exclude" };
export function parseIntakeDecision(value: unknown): IntakeDecision {
  const r = importObject(value, ["kind"], ["literature_id", "candidate_id"]);
  if (r.kind === "merge") {
    importObject(value, ["kind", "literature_id"]);
    return { kind: r.kind, literature_id: parseLiteratureId(r.literature_id) };
  }
  if (r.kind === "candidate") {
    importObject(value, ["kind", "candidate_id"]);
    if (
      typeof r.candidate_id !== "string" ||
      !/^[a-f0-9]{64}$/u.test(r.candidate_id)
    )
      throw new ContractValidationError();
    return { kind: r.kind, candidate_id: r.candidate_id };
  }
  if (["new", "unrecognized", "include", "exclude"].includes(String(r.kind))) {
    importObject(value, ["kind"]);
    return { kind: r.kind as "new" | "unrecognized" | "include" | "exclude" };
  }
  throw new ContractValidationError();
}
export interface IntakeRecognition {
  readonly state:
    | "pending"
    | "recognized"
    | "candidates"
    | "unrecognized"
    | "cancelled";
  readonly step: 1 | 2 | 3 | 4 | null;
  readonly literature_id: LiteratureId | null;
  readonly candidates: readonly {
    readonly candidate_id: string;
    readonly title: string | null;
    readonly authors: LiteratureMetadata["authors"];
    readonly publication_year: number | null;
    readonly identifiers: LiteratureMetadata["identifiers"];
    readonly source_name: string;
    readonly similarity: number;
  }[];
}
export interface IntakeBatchItem {
  readonly item_id: string;
  readonly origin: "data" | "file" | "page";
  readonly sequence: number | null;
  readonly record_index: number | null;
  readonly external_id: string | null;
  readonly title: string | null;
  readonly file_name: string | null;
  readonly recognition: IntakeRecognition | null;
  readonly possible_duplicates: readonly {
    readonly literature_id: LiteratureId;
    readonly title: string | null;
    readonly first_author: string | null;
    readonly publication_year: number | null;
    readonly similarity: number;
  }[];
  readonly unpaired: boolean;
  readonly needs_decision: boolean;
  readonly decision: IntakeDecision | null;
  readonly disposition: IntakeDisposition | null;
  readonly decided_by: string | null;
  readonly decided_at: string | null;
}
