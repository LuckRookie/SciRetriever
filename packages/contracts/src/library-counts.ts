import {
  ContractValidationError,
  LITERATURE_STATUSES,
  parseLibrarySearchRequest,
  parseUtcTimestamp,
  type LibraryQuery,
  type LiteratureStatus,
} from "./index.js";
import {
  parseLibraryFacets,
  parseLibraryFacetsRequest,
  type LibraryFacets,
} from "./intake.js";

export const LIBRARY_COUNT_LIMIT = 10_000;
export const LIBRARY_COUNT_FLAGS = [
  "count_truncated",
  "counts_backfill_pending",
  "status_updating",
  "scan_incomplete",
] as const;

export function globalLibraryCountScope(
  query: LibraryQuery,
  ignoreQuickFilters = false,
) {
  const unfiltered = Object.entries(query).every(
    ([key, value]) =>
      key === "collection_scope" ||
      value === null ||
      value === undefined ||
      (Array.isArray(value) && !value.length) ||
      (key === "recently_opened" && value === false) ||
      (key === "tags" && !query.tags?.ids.length) ||
      (ignoreQuickFilters &&
        (key === "statuses" || key === "needs_manual_pdf")),
  );
  return unfiltered ? (query.collection_scope ?? "all") : null;
}

export interface LibraryCountFlags {
  /** The population was limited to LIBRARY_COUNT_LIMIT matching versions. */
  readonly count_truncated?: true;
  readonly counts_backfill_pending?: true;
  readonly status_updating?: true;
  /** There are earlier entries on the scan side outside the current window. */
  readonly scan_incomplete?: true;
}

export interface LibrarySearchTotal extends LibraryCountFlags {
  readonly total_count: number;
}

const fail = (): never => {
  throw new ContractValidationError();
};
const count = (v: unknown): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fail();

function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const r = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(r, key)) ||
    Object.keys(r).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    fail();
  return r;
}

export function parseLibraryCountFlags(
  r: Record<string, unknown>,
  total: number,
): LibraryCountFlags {
  const result: Partial<Record<(typeof LIBRARY_COUNT_FLAGS)[number], true>> =
    {};
  for (const key of LIBRARY_COUNT_FLAGS) {
    if (!Object.hasOwn(r, key)) continue;
    if (
      r[key] !== true ||
      (key === "count_truncated" && total !== LIBRARY_COUNT_LIMIT)
    )
      fail();
    result[key] = true;
  }
  return result;
}

export function parseLibrarySearchTotal(value: unknown): LibrarySearchTotal {
  const r = record(value, ["total_count"], LIBRARY_COUNT_FLAGS);
  const total_count = count(r.total_count);
  return { total_count, ...parseLibraryCountFlags(r, total_count) };
}

export interface FullTextCounts {
  readonly total: number;
  readonly obtained: number;
  readonly missing: number;
  readonly exhausted: number;
}
export function parseFullTextCounts(value: unknown): FullTextCounts {
  const r = record(value, ["exhausted", "missing", "obtained", "total"]);
  const result = {
    total: count(r.total),
    obtained: count(r.obtained),
    missing: count(r.missing),
    exhausted: count(r.exhausted),
  };
  if (
    result.total !== result.obtained + result.missing ||
    result.exhausted > result.missing
  )
    fail();
  return Object.freeze(result);
}

export interface LibraryCounts extends LibraryCountFlags {
  readonly total: number;
  readonly recently_opened: number;
  readonly statuses: Readonly<Record<LiteratureStatus, number>>;
  readonly unavailable_pdf: number;
  readonly with_primary_pdf: number;
  readonly full_text: FullTextCounts;
  /** Version counts for the unfiltered entire library. */
  readonly collection_counts?: {
    readonly collected: number;
    readonly discovered_only: number;
  };
}
export function parseLibraryCounts(value: unknown): LibraryCounts {
  const r = record(
    value,
    [
      "full_text",
      "recently_opened",
      "statuses",
      "total",
      "unavailable_pdf",
      "with_primary_pdf",
    ],
    [...LIBRARY_COUNT_FLAGS, "collection_counts"],
  );
  const states = record(r.statuses, LITERATURE_STATUSES);
  const total = count(r.total),
    unavailable = count(r.unavailable_pdf);
  const statuses = Object.fromEntries(
    LITERATURE_STATUSES.map((s) => [s, count(states[s])]),
  ) as Record<LiteratureStatus, number>;
  if (
    Object.values(statuses).reduce((a, b) => a + b, 0) !== total ||
    unavailable > statuses.UNREVIEWED
  )
    fail();
  const recently_opened = count(r.recently_opened);
  if (recently_opened > Math.min(100, total)) fail();
  const with_primary_pdf = count(r.with_primary_pdf),
    full_text = parseFullTextCounts(r.full_text);
  if (with_primary_pdf > total || full_text.total > total) fail();
  const flags = parseLibraryCountFlags(r, total);
  return Object.freeze({
    ...flags,
    ...(Object.hasOwn(r, "collection_counts")
      ? {
          collection_counts: (() => {
            const scope = record(r.collection_counts, [
              "collected",
              "discovered_only",
            ]);
            const collected = count(scope.collected),
              discovered_only = count(scope.discovered_only);
            if (
              flags.count_truncated ||
              flags.scan_incomplete ||
              collected + discovered_only !== total
            )
              fail();
            return Object.freeze({ collected, discovered_only });
          })(),
        }
      : {}),
    recently_opened,
    total,
    statuses: Object.freeze(statuses),
    unavailable_pdf: unavailable,
    with_primary_pdf,
    full_text,
  });
}

export type LibraryExactCountRequest =
  | { readonly kind: "counts" | "search-total"; readonly query: LibraryQuery }
  | {
      readonly kind: "facets";
      readonly query: LibraryQuery;
      readonly limit: number;
    };

export function parseLibraryExactCountRequest(
  value: unknown,
): LibraryExactCountRequest {
  const r = record(value, ["kind", "query"], ["limit"]);
  if (r.kind === "facets")
    return {
      kind: r.kind,
      ...parseLibraryFacetsRequest({ query: r.query, limit: r.limit }),
    };
  if (
    (r.kind !== "counts" && r.kind !== "search-total") ||
    Object.hasOwn(r, "limit")
  )
    return fail();
  return {
    kind: r.kind,
    query: parseLibrarySearchRequest({ query: r.query }).query,
  };
}

export type LibraryExactCount = { readonly snapshot_at: string } & (
  | { readonly kind: "counts"; readonly counts: LibraryCounts }
  | { readonly kind: "facets"; readonly facets: LibraryFacets }
  | { readonly kind: "search-total"; readonly total_count: number }
);

export function parseLibraryExactCount(value: unknown): LibraryExactCount {
  const r = record(
    value,
    ["kind", "snapshot_at"],
    ["counts", "facets", "total_count"],
  );
  const snapshot_at = parseUtcTimestamp(r.snapshot_at);
  switch (r.kind) {
    case "counts": {
      record(r, ["kind", "snapshot_at", "counts"]);
      const counts = parseLibraryCounts(r.counts);
      if (counts.count_truncated || counts.scan_incomplete) fail();
      return { kind: r.kind, snapshot_at, counts };
    }
    case "facets": {
      record(r, ["kind", "snapshot_at", "facets"]);
      const facets = parseLibraryFacets(r.facets);
      if (
        facets.count_truncated ||
        facets.facets_truncated ||
        facets.scan_incomplete
      )
        fail();
      return { kind: r.kind, snapshot_at, facets };
    }
    case "search-total":
      record(r, ["kind", "snapshot_at", "total_count"]);
      return { kind: r.kind, snapshot_at, total_count: count(r.total_count) };
    default:
      return fail();
  }
}
