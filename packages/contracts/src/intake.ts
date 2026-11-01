import {
  ContractValidationError,
  parseAssetId,
  parseLibrarySearchRequest,
  parseLiteratureId,
  parseUtcTimestamp,
  type LibraryQuery,
  type LibrarySort,
  type LiteratureId,
} from "./index.js";
import { tagInteger } from "./tags.js";
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
export interface IntakeBatch {
  readonly batch_id: IntakeBatchId;
  readonly kind: "topic" | "citation" | "import" | "legacy";
  readonly label: string;
  readonly default_label: string;
  readonly renamed: boolean;
  readonly origin: "web" | "cli" | "mcp" | "migration";
  readonly created_at: string;
  readonly finished_at: string | null;
  readonly status:
    | "running"
    | "completed"
    | "partial"
    | "failed"
    | "interrupted";
  readonly request: {
    readonly query?: string;
    readonly year_from?: number | null;
    readonly year_to?: number | null;
    readonly seed_literature_id?: string;
    readonly direction?: "references" | "cited-by";
    readonly format?: string;
    readonly file_name?: string | null;
    readonly providers?: readonly string[];
  };
  readonly counts: {
    readonly hits: number;
    readonly created: number;
    readonly enriched: number;
    readonly matched: number;
    readonly rejected: number;
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
  readonly keywords: readonly {
    readonly value: string;
    readonly count: number;
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
    "status",
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
  const c = tagRecord(r.counts, [
    "hits",
    "created",
    "enriched",
    "matched",
    "rejected",
  ]);
  const counts = {
    hits: tagInteger(c.hits),
    created: tagInteger(c.created),
    enriched: tagInteger(c.enriched),
    matched: tagInteger(c.matched),
    rejected: tagInteger(c.rejected),
  };
  if (
    kind === "legacy"
      ? counts.created + counts.enriched + counts.matched + counts.rejected !==
        0
      : counts.hits !== counts.created + counts.enriched + counts.matched
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
          ? ["format", "file_name"]
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
    batch_id: parseIntakeBatchId(r.batch_id),
    kind,
    label,
    default_label,
    renamed: r.renamed,
    origin: member(r.origin, ["web", "cli", "mcp", "migration"] as const),
    created_at: parseUtcTimestamp(r.created_at),
    finished_at:
      r.finished_at === null ? null : parseUtcTimestamp(r.finished_at),
    status: member(r.status, [
      "running",
      "completed",
      "partial",
      "failed",
      "interrupted",
    ] as const),
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
  const r = tagRecord(value, ["total", "keywords", "subject_terms"]),
    total = tagInteger(r.total);
  const terms = (v: unknown) => {
    if (!Array.isArray(v) || v.length > 30) fail();
    return v.map((x) => {
      const row = tagRecord(x, ["value", "count"]);
      const count = tagInteger(row.count, 1);
      if (count > total) fail();
      return { value: text(row.value), count };
    });
  };
  return {
    total,
    keywords: terms(r.keywords),
    subject_terms: terms(r.subject_terms),
  };
}
