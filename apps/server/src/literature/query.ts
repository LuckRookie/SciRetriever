import {
  parseLibraryFacetsRequest,
  parseAcquirePdfSelector,
  parseIntakeBatchQuery,
  parseIntakeBatchSummaryQuery,
  type IntakeBatchSummaryPage,
  type IntakeBatchSummaryQuery,
  type LibraryFacets,
} from "@sciretriever/contracts";
import {
  canonicalJsonBytes,
  parseLiteratureBibliographySummary,
  type LiteratureBibliographySummary,
  LITERATURE_STATUSES,
  LIBRARY_SORT_SCOPE_LIMIT,
  RELEVANCE_RESULT_LIMIT,
  type LibraryCounts,
  type LibraryExactCount,
  type LibraryExactCountRequest,
  type LibrarySearchTotal,
  parseLibraryExactCountRequest,
  parseLibrarySearchTotal,
  parseLibraryQuery,
  parseLibrarySearchRequest,
  parseLiteratureDetail,
  parseLiteratureId,
  parseLiteratureReferenceRequest,
  parseReferenceId,
  parseUtcTimestamp,
  sha256,
  type LibraryQuery,
  type LibrarySearchPage,
  type LibrarySort,
  type LiteratureDetail,
  type LiteratureId,
  type LiteratureReferencePage,
  type LiteratureReferenceRequest,
  type LiteratureSearchItem,
  type MetaLiteratureId,
  draftSortFields,
  type ReferenceDetail,
} from "@sciretriever/contracts";
import { createHash } from "node:crypto";
import {
  compareLibraryMemberPositions,
  libraryWorksetTimeSort,
  type LibraryMemberPosition,
} from "./library-workset-order.js";
import { ftsIndexText, normalizeQueryText } from "./unicode-casefold.js";

export interface SearchSnapshotRow {
  readonly item: LiteratureSearchItem;
  readonly relevance: number | null;
  readonly workset_at?: string | null;
  readonly discovery_run_ids: readonly string[];
  readonly has_pdf_exhaustion: boolean;
  readonly tag_match?: boolean;
  readonly scope_match?: boolean;
}
export interface PdfSelectionRequest {
  readonly selector: import("@sciretriever/contracts").AcquirePdfSelector;
  readonly ftsQuery: string | null;
}
export interface PdfSelection {
  readonly counts: import("@sciretriever/contracts").AcquirePdfCounts;
  readonly items: readonly {
    readonly literature_id: import("@sciretriever/contracts").LiteratureId;
    readonly version_role: import("@sciretriever/contracts").VersionRole;
  }[];
}
export interface ParseDocumentSelection {
  readonly counts: import("@sciretriever/contracts").ParseDocumentCounts;
  readonly items: PdfSelection["items"];
}
export interface LibraryQueryRepository {
  literatureBibliographies?(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly unknown[]>;
  intakeBatches?(
    value: unknown,
  ): Promise<
    | import("@sciretriever/contracts").IntakeBatch
    | import("@sciretriever/contracts").IntakeBatchPage
  >;
  intakeBatchSummaries?(
    request: IntakeBatchSummaryQuery["request"],
    signal?: AbortSignal,
  ): Promise<IntakeBatchSummaryPage>;
  libraryFacets?(
    query: LibraryQuery,
    limit: number,
    ftsQuery: string | null,
    signal?: AbortSignal,
    windowStart?: LibraryWindowStart,
  ): Promise<LibraryFacets>;
  acquirePdfSelection?(
    request: PdfSelectionRequest,
    signal?: AbortSignal,
  ): Promise<PdfSelection>;
  parseDocumentSelection?(
    request: PdfSelectionRequest,
    signal?: AbortSignal,
  ): Promise<ParseDocumentSelection>;
  libraryCounts(
    query: LibraryQuery,
    ftsQuery: string | null,
    signal?: AbortSignal,
    windowStart?: LibraryWindowStart,
  ): Promise<LibraryCounts>;
  libraryExactCount?(
    request: LibraryExactCountRequest,
    ftsQuery: string | null,
    signal?: AbortSignal,
  ): Promise<LibraryExactCount>;
  librarySearchPage(
    request: LibraryPageQuery,
    signal?: AbortSignal,
  ): Promise<
    LibrarySearchTotal & {
      readonly rows: readonly SearchSnapshotRow[];
      readonly tag_backfill_pending?: number;
      readonly ranking_id?: string;
      readonly relevance_scored_count?: number;
      readonly search_window?: LibrarySearchWindow;
    }
  >;
  literatureDetailSnapshot(literatureId: string): Promise<{
    readonly detail: unknown;
  } | null>;
  librarySnapshot(
    ftsQuery: string | null,
    discoveryRunIds?: readonly string[],
    includeOtherVersions?: boolean,
    literatureIds?: readonly string[],
    metaLiteratureIds?: readonly string[],
    tags?: LibraryQuery["tags"],
    scope?: LibraryQuery,
  ): Promise<readonly SearchSnapshotRow[]>;
  referenceQuerySnapshot(
    selection:
      | {
          readonly literature_id: string;
          readonly direction: "references" | "cited-by";
        }
      | { readonly reference_id: string },
  ): Promise<readonly ReferenceDetail[] | null>;
}
export interface LiteratureArtifactReader {
  read(reference: string, maxBytes: number): Promise<Uint8Array>;
}
/** Matching versions and their complete Meta membership from one read snapshot. */
export interface LiteratureSelectionSnapshot {
  readonly matches: readonly LiteratureSearchItem[];
  readonly members: readonly LiteratureSearchItem[];
}
export class LiteratureNotFoundError extends Error {
  readonly code = "literature-not-found";
  constructor() {
    super("requested literature or reference was not found");
  }
}
export class LiteratureQueryError extends Error {
  readonly code = "literature-query";
  constructor() {
    super("literature query failed");
  }
}
export class LibrarySortScopeLimitError extends Error {
  readonly code = LIBRARY_SORT_SCOPE_LIMIT;
  constructor() {
    super("narrow the library query or choose a supported sort");
  }
}
function fail(): never {
  throw new LiteratureQueryError();
}
function compareText(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0)!);
  const right = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++)
    if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  return left.length - right.length;
}
const unique = (values: readonly string[]) =>
  [...new Set(values)].sort(compareText);
export function queryTerms(value: string): readonly string[] {
  return [...new Set(ftsIndexText(value).split(" ").filter(Boolean))];
}
function libraryFtsMatch(text: string | null): string | null {
  return text === null
    ? null
    : queryTerms(text)
        .map((term) => `"${term}"`)
        .join(" AND ");
}
function browseQuery(q: LibraryQuery): LibraryQuery {
  const listing =
    q.text === null &&
    q.title === null &&
    q.author === null &&
    q.venue === null &&
    q.publisher === null &&
    !q.identifiers.length &&
    !q.author_orcids.length &&
    !q.discovery_run_ids.length &&
    !q.intake_batch_ids.length;
  // Recent reading includes candidates that were opened.
  return listing && !q.recently_opened && q.collection_scope === undefined
    ? { ...q, collection_scope: "collected" }
    : q;
}
function floatJson(value: number): string {
  if (!Number.isFinite(value)) fail();
  if (Object.is(value, -0)) return "-0.0";
  if (value !== 0 && (Math.abs(value) < 0.0001 || Math.abs(value) >= 1e16))
    return value
      .toExponential()
      .replace(
        /e([+-])(\d+)$/u,
        (_all, sign: string, exponent: string) =>
          `e${sign}${exponent.padStart(2, "0")}`,
      );
  return Number.isInteger(value) ? `${value}.0` : String(value);
}
/** Python query cursors have their own JSON contract, including finite bm25 float spelling. */
function canonical(value: unknown, key = ""): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return key === "bm25" ? floatJson(value) : JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null)
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => compareText(a, b))
      .map(([name, item]) => `${JSON.stringify(name)}:${canonical(item, name)}`)
      .join(",")}}`;
  return fail();
}
const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function queryFingerprint(query: LibraryQuery): string {
  const contains = (value: string | null) =>
    value === null ? null : normalizeQueryText(value);
  const identifiers = [
    ...new Map(
      query.identifiers.map((item) => [
        `${item.namespace}\u0000${item.value}`,
        item,
      ]),
    ).values(),
  ].sort(
    (a, b) =>
      compareText(a.namespace, b.namespace) || compareText(a.value, b.value),
  );
  return digest({
    author: contains(query.author),
    author_orcids: unique(query.author_orcids),
    discovery_run_ids: unique(query.discovery_run_ids),
    ...(query.collection_scope === "collected" ||
    query.collection_scope === "candidates"
      ? { collection_scope: query.collection_scope }
      : {}),
    ...(query.intake_batch_ids?.length
      ? { intake_batch_ids: unique(query.intake_batch_ids) }
      : {}),
    ...(query.subject_terms?.length
      ? { subject_terms: unique(query.subject_terms.map(normalizeQueryText)) }
      : {}),
    ...(query.tags?.ids.length
      ? { tags: { ids: unique(query.tags.ids), mode: query.tags.mode } }
      : {}),
    publication_forms: unique(query.publication_forms),
    article_kinds: unique(query.article_kinds),
    identifiers,
    keywords: unique(query.keywords),
    languages: unique(query.languages),
    missing_steps: unique(query.missing_steps),
    needs_manual_pdf: query.needs_manual_pdf,
    publication_year_from: query.publication_year_from,
    publication_year_to: query.publication_year_to,
    publisher: contains(query.publisher),
    schema: "sciretriever-library-query-v1",
    ...(query.folder ? { folder: query.folder } : {}),
    ...(query.recently_opened ? { recently_opened: true } : {}),
    statuses: unique(query.statuses),
    text_terms: query.text === null ? null : unique(queryTerms(query.text)),
    title: contains(query.title),
    venue: contains(query.venue),
    version_roles: unique(query.version_roles),
    ...(query.text_levels?.length
      ? { text_levels: unique(query.text_levels) }
      : {}),
    ...Object.fromEntries(
      (
        [
          "has_primary_pdf",
          "needs_metadata",
          "has_draft_differences",
          "has_image_only_pages",
          "cited_by_results",
          "has_unfound_citations",
        ] as const
      )
        .filter((key) => typeof query[key] === "boolean")
        .map((key) => [key, query[key]]),
    ),
  });
}
export interface Position {
  readonly literature_id: string;
  readonly value: string | number | null;
  readonly secondary?: number | null;
  readonly total?: Pick<LibrarySearchTotal, "total_count" | "count_truncated">;
  readonly ranking_id?: string;
  readonly workset_at?: string | null;
  readonly search_window?: LibrarySearchWindow;
  readonly legacy_newest_rowid?: string;
}
export interface LibraryHitWindow {
  readonly oldest_rowid: string;
  readonly newest_rowid: string;
  readonly limit: number;
  readonly scan_incomplete?: true;
}
export interface LibraryMemberWindow {
  readonly side: "members";
  readonly newest: LibraryMemberPosition;
  readonly oldest: LibraryMemberPosition;
  readonly limit: number;
  readonly scan_incomplete?: true;
}
export type LibrarySearchWindow = LibraryHitWindow | LibraryMemberWindow;
/** A hit continuation is its exclusive rowid. Member continuations carry a workset key. */
export type LibraryWindowStart = string | LibraryMemberPosition;
export interface LibraryPageQuery {
  readonly query: LibraryQuery;
  readonly ftsQuery: string | null;
  readonly sort: LibrarySort;
  readonly after: Position | null;
  readonly limit: number;
  readonly windowStart?: LibraryWindowStart;
  readonly fullRelevance?: true;
  readonly relevanceForLargeScope?: true;
  readonly rankingKey?: string;
}
export interface LibraryCollectRequest {
  readonly selector: import("@sciretriever/contracts").CollectLiteraturesRequest["selector"];
  readonly ftsQuery: string | null;
}
function position(row: SearchSnapshotRow, sort: LibrarySort): Position {
  const l = row.item.literature;
  const fields = draftSortFields(sort),
    facts = row.item.draft_facts;
  if (fields)
    return {
      literature_id: l.literature_id,
      value: facts?.[fields[0]!] ?? null,
      ...(fields.length === 2
        ? { secondary: facts?.[fields[1]!] ?? null }
        : {}),
    };
  if (sort === "relevance" && row.workset_at !== undefined)
    return {
      literature_id: l.literature_id,
      value: null,
      workset_at: row.workset_at,
    };
  return {
    literature_id: l.literature_id,
    value:
      sort === "opened-desc"
        ? (row.item.last_opened_at ?? null)
        : sort === "intake-desc"
          ? (row.item.intake_at ?? null)
          : sort === "collected-desc"
            ? (row.item.collected_at ?? null)
            : sort.startsWith("publication-year")
              ? l.metadata.publication_year
              : sort.startsWith("title")
                ? l.metadata.title === null
                  ? null
                  : normalizeQueryText(l.metadata.title)
                : row.relevance,
  };
}
function compare(a: Position, b: Position, sort: LibrarySort): number {
  if (a.value === null && b.value !== null) return 1;
  if (b.value === null && a.value !== null) return -1;
  let result = 0;
  if (a.value !== null && b.value !== null)
    result =
      typeof a.value === "string" && typeof b.value === "string"
        ? compareText(a.value, b.value)
        : a.value < b.value
          ? -1
          : a.value > b.value
            ? 1
            : 0;
  if (sort.endsWith("desc")) result = -result;
  if (
    !result &&
    draftSortFields(sort)?.length === 2 &&
    a.value !== null &&
    b.value !== null
  )
    result = b.secondary! - a.secondary!;
  return result || compareText(a.literature_id, b.literature_id);
}
function positionPayload(p: Position, sort: LibrarySort): object {
  const fields = draftSortFields(sort);
  if (fields)
    return {
      literature_id: p.literature_id,
      value: p.value,
      ...(fields.length === 2 ? { secondary: p.secondary } : {}),
      facts_is_null: p.value === null,
    };
  if (sort === "opened-desc")
    return {
      literature_id: p.literature_id,
      last_opened_at: p.value,
      opened_is_null: p.value === null,
    };
  if (sort === "intake-desc")
    return {
      literature_id: p.literature_id,
      intake_at: p.value,
      intake_is_null: p.value === null,
    };
  if (sort === "collected-desc")
    return {
      literature_id: p.literature_id,
      collected_at: p.value,
      collected_is_null: p.value === null,
    };
  if (sort.startsWith("publication-year"))
    return {
      literature_id: p.literature_id,
      publication_year: p.value,
      year_is_null: p.value === null,
    };
  if (sort.startsWith("title"))
    return {
      literature_id: p.literature_id,
      normalized_title: p.value,
      title_is_null: p.value === null,
    };
  return p.workset_at !== undefined
    ? { literature_id: p.literature_id, workset_at: p.workset_at }
    : { literature_id: p.literature_id, bm25: p.value };
}
function encodePosition(
  p: Position,
  query: LibraryQuery,
  sort: LibrarySort,
  total: NonNullable<Position["total"]>,
  rankingId?: string,
  window?: LibrarySearchWindow,
): string {
  const unscored = p.workset_at !== undefined;
  const typedWindow = window && ("side" in window || unscored);
  const core = {
    kind: "library-search",
    payload: {
      position: positionPayload(p, sort),
      query_fingerprint: queryFingerprint(query),
      sort,
      total,
      ...(window
        ? { ranking_id: rankingId ?? null, search_window: window }
        : unscored
          ? { ranking_id: rankingId ?? null }
          : rankingId
            ? { ranking_id: rankingId }
            : {}),
    },
    version: typedWindow ? 7 : unscored ? 6 : window ? 5 : rankingId ? 3 : 2,
  };
  return Buffer.from(canonical({ checksum: digest(core), ...core })).toString(
    "base64url",
  );
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    fail();
  return value as Record<string, unknown>;
}

function validRowid(id: unknown): id is string {
  return (
    typeof id === "string" &&
    /^(?:0|-?[1-9]\d{0,18})$/u.test(id) &&
    BigInt.asIntN(64, BigInt(id)) === BigInt(id)
  );
}
function parseMemberPosition(value: unknown): LibraryMemberPosition {
  const { workset_at, literature_id } = object(value, [
    "workset_at",
    "literature_id",
  ]);
  return {
    workset_at: workset_at === null ? null : parseUtcTimestamp(workset_at),
    literature_id: parseLiteratureId(literature_id),
  };
}

function parseHitWindow(value: unknown): LibraryHitWindow {
  const incomplete =
    !!value &&
    typeof value === "object" &&
    Object.hasOwn(value, "scan_incomplete");
  const { oldest_rowid, newest_rowid, limit, scan_incomplete } = object(value, [
    "oldest_rowid",
    "newest_rowid",
    "limit",
    ...(incomplete ? ["scan_incomplete"] : []),
  ]);
  if (
    !validRowid(oldest_rowid) ||
    !validRowid(newest_rowid) ||
    BigInt(oldest_rowid) > BigInt(newest_rowid) ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    (incomplete && scan_incomplete !== true)
  )
    return fail();
  return {
    oldest_rowid,
    newest_rowid,
    limit,
    ...(incomplete ? { scan_incomplete: true as const } : {}),
  };
}

export function parseLibrarySearchWindow(value: unknown): LibrarySearchWindow {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, "side"))
    return parseHitWindow(value);
  const incomplete = Object.hasOwn(value, "scan_incomplete");
  const r = object(value, [
    "side",
    "newest",
    "oldest",
    "limit",
    ...(incomplete ? ["scan_incomplete"] : []),
  ]);
  const newest = parseMemberPosition(r.newest);
  const oldest = parseMemberPosition(r.oldest);
  if (
    r.side !== "members" ||
    typeof r.limit !== "number" ||
    !Number.isSafeInteger(r.limit) ||
    r.limit < 1 ||
    compareLibraryMemberPositions(newest, oldest) > 0 ||
    (incomplete && r.scan_incomplete !== true)
  )
    fail();
  return {
    side: "members",
    newest,
    oldest,
    limit: r.limit as number,
    ...(incomplete ? { scan_incomplete: true as const } : {}),
  };
}

function memberScopeFingerprint(query: LibraryQuery) {
  if (query.recently_opened) return digest({ recently_opened: true });
  if (query.folder) return digest(query.folder);
  if (query.intake_batch_ids.length)
    return digest({ intake_batch_ids: unique(query.intake_batch_ids) });
  if (query.discovery_run_ids.length)
    return digest({ discovery_run_ids: unique(query.discovery_run_ids) });
  if (query.collection_scope === "collected")
    return digest({ collection_scope: "collected" });
  return fail();
}

function encodeWindowCursor(
  query: LibraryQuery,
  ftsQuery: string,
  window: LibrarySearchWindow,
) {
  const fts_fingerprint = digest(ftsQuery);
  const scoped = libraryWorksetTimeSort(query) !== undefined;
  const core = {
    kind: "library-search-window",
    payload: scoped
      ? {
          fts_fingerprint,
          scope_fingerprint: memberScopeFingerprint(query),
          ...("side" in window
            ? { side: "members", after: window.oldest }
            : { side: "hits", after: window.oldest_rowid }),
        }
      : {
          fts_fingerprint,
          before_rowid: "oldest_rowid" in window ? window.oldest_rowid : fail(),
        },
    version: scoped ? 3 : 2,
  };
  return Buffer.from(canonical({ checksum: digest(core), ...core })).toString(
    "base64url",
  );
}

function decodeWindowCursor(
  cursor: string,
  query: LibraryQuery,
  ftsQuery: string | null,
): LibraryWindowStart {
  if (!ftsQuery) return fail();
  try {
    const raw = Buffer.from(cursor, "base64url");
    if (raw.toString("base64url") !== cursor) fail();
    const e = object(JSON.parse(raw.toString("utf8")), [
      "checksum",
      "kind",
      "payload",
      "version",
    ]);
    if (
      canonical(e) !== raw.toString("utf8") ||
      e.kind !== "library-search-window" ||
      (e.version !== 2 && e.version !== 3) ||
      digest({ kind: e.kind, payload: e.payload, version: e.version }) !==
        e.checksum
    )
      fail();
    if (e.version === 3) {
      const r = object(e.payload, [
        "fts_fingerprint",
        "scope_fingerprint",
        "side",
        "after",
      ]);
      if (
        r.fts_fingerprint !== digest(ftsQuery) ||
        r.scope_fingerprint !== memberScopeFingerprint(query)
      )
        fail();
      if (r.side === "members") return parseMemberPosition(r.after);
      if (r.side === "hits" && validRowid(r.after)) return r.after;
      return fail();
    }
    const { fts_fingerprint, before_rowid } = object(e.payload, [
      "fts_fingerprint",
      "before_rowid",
    ]);
    if (
      libraryWorksetTimeSort(query) ||
      fts_fingerprint !== digest(ftsQuery) ||
      !validRowid(before_rowid)
    )
      return fail();
    return before_rowid;
  } catch {
    return fail();
  }
}

function decodePosition(
  cursor: string,
  query: LibraryQuery,
  sort: LibrarySort,
): Position {
  try {
    if (cursor.length > 65536 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) fail();
    const raw = Buffer.from(cursor, "base64url");
    if (raw.toString("base64url") !== cursor) fail();
    const e = object(JSON.parse(raw.toString("utf8")), [
      "checksum",
      "kind",
      "payload",
      "version",
    ]);
    if (
      canonical(e) !== raw.toString("utf8") ||
      (e.version !== 1 &&
        e.version !== 2 &&
        e.version !== 3 &&
        e.version !== 4 &&
        e.version !== 5 &&
        e.version !== 6 &&
        e.version !== 7) ||
      e.kind !== "library-search" ||
      digest({ kind: e.kind, payload: e.payload, version: e.version }) !==
        e.checksum
    )
      fail();
    const payload = object(e.payload, [
      "position",
      "query_fingerprint",
      "sort",
      ...(e.version !== 1 ? ["total"] : []),
      ...(Number(e.version) >= 3 ? ["ranking_id"] : []),
      ...(e.version === 4 ? ["candidate_window"] : []),
      ...(e.version === 5 || e.version === 7 ? ["search_window"] : []),
    ]);
    if (
      payload.query_fingerprint !== queryFingerprint(query) ||
      payload.sort !== sort
    )
      fail();
    const total =
      e.version !== 1 ? parseLibrarySearchTotal(payload.total) : undefined;
    const rankingId = payload.ranking_id;
    const unscored =
      e.version === 6 ||
      (e.version === 7 &&
        !!payload.position &&
        typeof payload.position === "object" &&
        Object.hasOwn(payload.position, "workset_at"));
    if (
      ((e.version === 3 || e.version === 4 || unscored) &&
        sort !== "relevance") ||
      (unscored && query.text === null)
    )
      fail();
    if (
      (e.version === 3 ||
        ((e.version === 4 || e.version === 5 || e.version === 7 || unscored) &&
          rankingId !== null)) &&
      (sort !== "relevance" ||
        typeof rankingId !== "string" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(rankingId))
    )
      fail();
    const searchWindow =
      e.version === 5 || e.version === 7
        ? parseLibrarySearchWindow(payload.search_window)
        : undefined;
    // V4 measured its limit after filtering. Rebase it to a raw window at
    // the old upper edge and recalculate its total with the new semantics.
    const legacy =
      e.version === 4
        ? parseHitWindow(
            object(payload.candidate_window, [
              "oldest_rowid",
              "newest_rowid",
              "limit",
            ]),
          )
        : undefined;
    const memberWindow = searchWindow && "side" in searchWindow;
    const timeSort = libraryWorksetTimeSort(query);
    if (
      (e.version === 5 && memberWindow) ||
      (e.version === 7 && (!timeSort || (!memberWindow && !unscored))) ||
      ((searchWindow || legacy) && query.text === null) ||
      (searchWindow?.scan_incomplete &&
        sort !== "relevance" &&
        !(memberWindow && sort === timeSort)) ||
      (total &&
        (total.status_updating ||
          total.counts_backfill_pending ||
          total.scan_incomplete))
    )
      fail();
    const metrics = draftSortFields(sort);
    if (metrics) {
      const p = object(payload.position, [
        "literature_id",
        "value",
        "facts_is_null",
        ...(metrics.length === 2 ? ["secondary"] : []),
      ]);
      if (
        typeof p.literature_id !== "string" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(
          p.literature_id,
        ) ||
        p.facts_is_null !== (p.value === null) ||
        (p.value !== null &&
          (!Number.isSafeInteger(p.value) || Number(p.value) < 0))
      )
        fail();
      if (
        metrics.length === 2 &&
        (p.value === null
          ? p.secondary !== null
          : !Number.isSafeInteger(p.secondary) || Number(p.secondary) < 0)
      )
        fail();
      return {
        literature_id: p.literature_id,
        value: p.value as number | null,
        ...(total ? { total } : {}),
        ...(searchWindow ? { search_window: searchWindow } : {}),
        ...(metrics.length === 2
          ? { secondary: p.secondary as number | null }
          : {}),
      };
    }
    const field =
      sort === "opened-desc"
        ? "last_opened_at"
        : sort === "intake-desc"
          ? "intake_at"
          : sort === "collected-desc"
            ? "collected_at"
            : sort.startsWith("publication-year")
              ? "publication_year"
              : sort.startsWith("title")
                ? "normalized_title"
                : unscored
                  ? "workset_at"
                  : "bm25";
    const flag =
      field === "last_opened_at"
        ? "opened_is_null"
        : field === "intake_at"
          ? "intake_is_null"
          : field === "collected_at"
            ? "collected_is_null"
            : field === "publication_year"
              ? "year_is_null"
              : "title_is_null";
    const p = object(
      payload.position,
      field === "bm25" || field === "workset_at"
        ? ["literature_id", field]
        : ["literature_id", field, flag],
    );
    if (
      typeof p.literature_id !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(p.literature_id)
    )
      fail();
    const value = p[field];
    if (
      ["intake_at", "collected_at", "last_opened_at"].includes(field) &&
      value !== null &&
      (typeof value !== "string" ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value)
    )
      fail();
    if (field === "workset_at" && value !== null) parseUtcTimestamp(value);
    if (
      field !== "bm25" &&
      field !== "workset_at" &&
      p[flag] !== (value === null)
    )
      fail();
    if (
      field === "publication_year" &&
      value !== null &&
      (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > 9999)
    )
      fail();
    if (
      field === "normalized_title" &&
      value !== null &&
      (typeof value !== "string" ||
        !value ||
        normalizeQueryText(value) !== value)
    )
      fail();
    if (
      field === "bm25" &&
      (typeof value !== "number" || !Number.isFinite(value))
    )
      fail();
    return {
      literature_id: p.literature_id,
      value: unscored ? null : (value as Position["value"]),
      ...(unscored ? { workset_at: value as string | null } : {}),
      ...(total && !legacy ? { total } : {}),
      ...(typeof rankingId === "string" && !legacy
        ? { ranking_id: rankingId }
        : {}),
      ...(searchWindow ? { search_window: searchWindow } : {}),
      ...(legacy ? { legacy_newest_rowid: legacy.newest_rowid } : {}),
    };
  } catch {
    return fail();
  }
}
function matches(row: SearchSnapshotRow, q: LibraryQuery): boolean {
  const l = row.item.literature,
    m = l.metadata;
  const contains = (actual: string | null, wanted: string | null) =>
    wanted === null ||
    (actual !== null &&
      normalizeQueryText(actual).includes(normalizeQueryText(wanted)));
  const any = (wanted: readonly unknown[], actual: readonly unknown[]) =>
    !wanted.length || wanted.some((value) => actual.includes(value));
  return (
    (q.needs_metadata === undefined ||
      row.item.needs_metadata === q.needs_metadata) &&
    (!q.text_levels?.length ||
      (row.item.text_level !== null &&
        row.item.text_level !== undefined &&
        q.text_levels.includes(row.item.text_level))) &&
    (
      [
        ["has_draft_differences", "differs_segments"],
        ["has_image_only_pages", "image_only_pages"],
        ["cited_by_results", "citing_results"],
        ["has_unfound_citations", "unfound_citations"],
      ] as const
    ).every(
      ([key, field]) =>
        typeof q[key] !== "boolean" ||
        (row.item.draft_facts != null &&
          row.item.draft_facts[field] > 0 === q[key]),
    ) &&
    contains(m.title, q.title) &&
    contains(m.venue, q.venue) &&
    contains(m.publisher, q.publisher) &&
    (q.author === null ||
      m.authors.some((a) =>
        [a.display_name, a.given_name, a.family_name].some((name) =>
          contains(name, q.author),
        ),
      )) &&
    any(
      q.author_orcids,
      m.authors.map((a) => a.orcid),
    ) &&
    (!q.identifiers.length ||
      q.identifiers.some((wanted) =>
        m.identifiers.some(
          (actual) =>
            wanted.namespace === actual.namespace &&
            wanted.value === actual.value,
        ),
      )) &&
    (q.publication_year_from === null ||
      (m.publication_year !== null &&
        m.publication_year >= q.publication_year_from)) &&
    (q.publication_year_to === null ||
      (m.publication_year !== null &&
        m.publication_year <= q.publication_year_to)) &&
    any(q.publication_forms, [m.publication_form]) &&
    any(q.article_kinds, [m.article_kind]) &&
    any(q.languages, [m.language]) &&
    q.keywords.every((value) =>
      m.keywords.some(
        (k) => normalizeQueryText(k) === normalizeQueryText(value),
      ),
    ) &&
    (q.subject_terms ?? []).every((value) =>
      m.subject_terms.some(
        (k) => normalizeQueryText(k) === normalizeQueryText(value),
      ),
    ) &&
    any(q.version_roles, [l.version_role]) &&
    any(q.statuses, [l.status]) &&
    any(q.missing_steps, [row.item.missing_step]) &&
    (q.needs_manual_pdf === null ||
      (q.needs_manual_pdf
        ? row.item.needs_manual_pdf
        : !row.has_pdf_exhaustion)) &&
    any(q.discovery_run_ids, row.discovery_run_ids) &&
    (!q.tags?.ids.length || row.tag_match !== false)
  );
}
export type LiteratureDetailSnapshot = {
  readonly detail: unknown;
};
export async function verifyLiteratureDetailSnapshot(
  id: string,
  snapshot: LiteratureDetailSnapshot | null,
): Promise<LiteratureDetail> {
  if (snapshot === null) throw new LiteratureNotFoundError();
  const detail = await parseLiteratureDetail(snapshot.detail);
  if (
    detail.literature.literature_id !== id ||
    detail.meta_literature.meta_literature_id !==
      detail.literature.meta_literature_id ||
    (await sha256(canonicalJsonBytes(detail.literature.metadata))) !==
      detail.metadata_sha256
  )
    fail();
  if (
    detail.other_versions.some(
      (v) =>
        v.literature.literature_id === id ||
        v.literature.meta_literature_id !==
          detail.literature.meta_literature_id,
    )
  )
    fail();
  for (const asset of [
    ...detail.additional_assets,
    ...(detail.primary_pdf ? [detail.primary_pdf] : []),
  ])
    if (asset.literature_asset.literature_id !== id) fail();
  if (
    detail.primary_pdf &&
    (detail.primary_pdf.literature_asset.role !== "primary-pdf" ||
      detail.primary_pdf.asset.media_type !== "application/pdf")
  )
    fail();
  if (
    detail.additional_assets.some(
      (a) => a.literature_asset.role === "primary-pdf",
    )
  )
    fail();

  const metadata_observations = [...detail.metadata_observations].sort(
    (a, b) =>
      Date.parse(b.provenance.observed_at) -
        Date.parse(a.provenance.observed_at) ||
      compareText(a.observation_id, b.observation_id),
  );
  return Object.freeze({
    ...detail,
    metadata_observations: Object.freeze(metadata_observations),
  });
}
export class LiteratureQueryService {
  constructor(private readonly repository: LibraryQueryRepository) {}
  /** Public current identifiers/title/year read, sharing the repository's snapshot. */
  async bibliographies(
    values: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<readonly LiteratureBibliographySummary[]> {
    if (!this.repository.literatureBibliographies || values.length > 1000)
      fail();
    const ids = [...new Set(values.map((value) => parseLiteratureId(value)))];
    const rows = (
      await this.repository.literatureBibliographies(ids, signal)
    ).map(parseLiteratureBibliographySummary);
    if (
      rows.length !== ids.length ||
      new Set(rows.map((row) => row.literature_id)).size !== ids.length ||
      rows.some((row) => !ids.includes(row.literature_id))
    )
      throw new LiteratureNotFoundError();
    return rows;
  }
  intakeBatches(value: unknown) {
    if (!this.repository.intakeBatches) throw new LiteratureQueryError();
    return this.repository.intakeBatches(parseIntakeBatchQuery(value));
  }
  intakeBatchSummaries(value: unknown, signal?: AbortSignal) {
    if (!this.repository.intakeBatchSummaries) throw new LiteratureQueryError();
    return this.repository.intakeBatchSummaries(
      parseIntakeBatchSummaryQuery(value).request,
      signal,
    );
  }
  facets(value: unknown, signal?: AbortSignal) {
    if (!this.repository.libraryFacets) throw new LiteratureQueryError();
    const r = parseLibraryFacetsRequest(value);
    const ftsQuery = libraryFtsMatch(r.query.text);
    const windowStart = r.window_cursor
      ? decodeWindowCursor(r.window_cursor, r.query, ftsQuery)
      : undefined;
    if (ftsQuery === "")
      return Promise.resolve<LibraryFacets>({
        total: 0,
        coverage: { tags: 0, keywords: 0, subject_terms: 0 },
        tags: [],
        keywords: [],
        subject_terms: [],
      });
    return this.repository.libraryFacets(
      r.query,
      r.limit,
      ftsQuery,
      signal,
      windowStart,
    );
  }
  pdfSelection(value: unknown, signal?: AbortSignal) {
    if (!this.repository.acquirePdfSelection) throw new LiteratureQueryError();
    const selector = parseAcquirePdfSelector(value);
    if (
      selector.kind === "query" &&
      selector.query.text !== null &&
      queryTerms(selector.query.text).length === 0
    )
      return Promise.resolve({
        counts: {
          matched: 0,
          process: 0,
          skipped_has_pdf: 0,
          skipped_unavailable: 0,
          over_limit: 0,
        },
        items: [],
      });
    const ftsQuery =
      selector.kind !== "query" || selector.query.text === null
        ? null
        : queryTerms(selector.query.text)
            .map((t) => `"${t}"`)
            .join(" AND ");
    return this.repository.acquirePdfSelection({ selector, ftsQuery }, signal);
  }
  parseSelection(value: unknown, signal?: AbortSignal) {
    if (!this.repository.parseDocumentSelection)
      throw new LiteratureQueryError();
    const selector = parseAcquirePdfSelector(value);
    const terms =
      selector.kind === "query" && selector.query.text !== null
        ? queryTerms(selector.query.text)
        : null;
    if (terms !== null && terms.length === 0)
      return Promise.resolve<ParseDocumentSelection>({
        counts: {
          matched: 0,
          process: 0,
          skipped_no_pdf: 0,
          skipped_parsed: 0,
          over_limit: 0,
        },
        items: [],
      });
    return this.repository.parseDocumentSelection(
      {
        selector,
        ftsQuery:
          terms === null ? null : terms.map((t) => `"${t}"`).join(" AND "),
      },
      signal,
    );
  }
  async detail(value: unknown): Promise<LiteratureDetail> {
    const id = parseLiteratureId(value);
    const snapshot = await this.repository.literatureDetailSnapshot(id);
    return verifyLiteratureDetailSnapshot(id, snapshot);
  }
  async referenceDetail(value: unknown): Promise<ReferenceDetail> {
    const reference_id = parseReferenceId(value);
    const rows = await this.repository.referenceQuerySnapshot({ reference_id });
    if (!rows?.length) throw new LiteratureNotFoundError();

    if (rows.length !== 1 || rows[0]!.reference.reference_id !== reference_id)
      fail();
    return rows[0]!;
  }
  /** One targeted, consistent snapshot for explicit Entry/Jobs selection. */
  async targetedSnapshot(
    selection:
      | { readonly literature_ids: readonly LiteratureId[] }
      | { readonly meta_literature_ids: readonly MetaLiteratureId[] },
  ): Promise<LibrarySearchPage> {
    const literatureIds =
      "literature_ids" in selection ? selection.literature_ids : [];
    const metaLiteratureIds =
      "meta_literature_ids" in selection ? selection.meta_literature_ids : [];
    const rows = await this.repository.librarySnapshot(
      null,
      [],
      false,
      literatureIds,
      metaLiteratureIds,
    );
    const items = Object.freeze(rows.map((row) => row.item));
    return Object.freeze({
      items,
      total_count: items.length,
      next_cursor: null,
    });
  }
  async references(value: unknown): Promise<LiteratureReferencePage> {
    const request = parseLiteratureReferenceRequest(value);
    const after =
      request.cursor === null
        ? null
        : decodeReferencePosition(request.cursor, request);
    const snapshot = await this.repository.referenceQuerySnapshot({
      literature_id: request.literature_id,
      direction: request.direction,
    });
    if (snapshot === null) throw new LiteratureNotFoundError();
    const rows = snapshot.map((row) => {
      const endpoint =
        request.direction === "references" ? row.source : row.target;
      if (endpoint.literature.literature_id !== request.literature_id) fail();
      return Object.freeze({
        reference: row.reference,
        related_literature:
          request.direction === "references" ? row.target : row.source,
        support_count: row.supports.length,
      });
    });
    if (
      new Set(
        rows.map((row) => row.related_literature.literature.literature_id),
      ).size !== rows.length
    )
      fail();
    rows.sort((a, b) =>
      compareReferencePosition(
        referencePosition(a.related_literature),
        referencePosition(b.related_literature),
      ),
    );
    const remaining =
      after === null
        ? rows
        : rows.filter(
            (row) =>
              compareReferencePosition(
                referencePosition(row.related_literature),
                after,
              ) > 0,
          );
    const page = remaining.slice(0, request.limit);
    return Object.freeze({
      items: Object.freeze(page),
      total_count: rows.length,
      next_cursor:
        remaining.length > request.limit
          ? encodeReferencePosition(
              referencePosition(page.at(-1)!.related_literature),
              request,
            )
          : null,
    });
  }
  async counts(
    value: unknown,
    signal?: AbortSignal,
    windowCursor?: unknown,
  ): Promise<LibraryCounts> {
    signal?.throwIfAborted();
    const request = parseLibrarySearchRequest({
      query: value,
      ...(windowCursor === undefined ? {} : { window_cursor: windowCursor }),
    });
    const query = request.query;
    const ftsQuery = libraryFtsMatch(query.text);
    const windowStart = request.window_cursor
      ? decodeWindowCursor(request.window_cursor, query, ftsQuery)
      : undefined;
    if (ftsQuery === "")
      return {
        total: 0,
        recently_opened: 0,
        unavailable_pdf: 0,
        with_primary_pdf: 0,
        full_text: { total: 0, obtained: 0, missing: 0, exhausted: 0 },
        statuses: Object.fromEntries(
          LITERATURE_STATUSES.map((s) => [s, 0]),
        ) as Record<(typeof LITERATURE_STATUSES)[number], number>,
      };
    return this.repository.libraryCounts(query, ftsQuery, signal, windowStart);
  }
  async exactCount(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<LibraryExactCount> {
    signal?.throwIfAborted();
    if (!this.repository.libraryExactCount) fail();
    const request = parseLibraryExactCountRequest(value);
    const query =
      request.kind === "search-total"
        ? browseQuery(request.query)
        : request.query;
    const ftsQuery =
      query.text === null
        ? null
        : queryTerms(query.text)
            .map((term) => `"${term}"`)
            .join(" AND ");
    return this.repository.libraryExactCount(
      { ...request, query },
      ftsQuery,
      signal,
    );
  }
  async search(
    value: unknown,
    signal?: AbortSignal,
    mode: "page" | "browse" | "selection" = "page",
  ): Promise<LibrarySearchPage> {
    signal?.throwIfAborted();
    const request = parseLibrarySearchRequest(value);
    const query =
      mode === "browse" ? browseQuery(request.query) : request.query;
    const ftsQuery = libraryFtsMatch(query.text);
    if (request.window_cursor && mode === "selection") fail();
    const windowStart = request.window_cursor
      ? decodeWindowCursor(request.window_cursor, query, ftsQuery)
      : undefined;
    const defaultSort =
      !Object.hasOwn(value as object, "sort") && mode !== "selection";
    const relevanceForLargeScope = defaultSort && query.text !== null;
    let sort =
      defaultSort &&
      query.text === null &&
      libraryWorksetTimeSort(query) === "collected-desc"
        ? "collected-desc"
        : request.sort;
    let after: Position | null = null;
    if (request.cursor !== null) {
      try {
        after = decodePosition(request.cursor, query, sort);
      } catch (error) {
        // An omitted sort can resume an older intake cursor or a ranked
        // cursor from a large text query with an implicit sort.
        if (
          !defaultSort ||
          (sort !== "collected-desc" && !relevanceForLargeScope)
        )
          throw error;
        sort = sort === "collected-desc" ? "intake-desc" : "relevance";
        after = decodePosition(request.cursor, query, sort);
      }
    }
    if (ftsQuery === "")
      return Object.freeze({ items: [], total_count: 0, next_cursor: null });
    const result = await this.repository.librarySearchPage(
      {
        query,
        ftsQuery,
        sort,
        after,
        limit: request.limit,
        ...(windowStart === undefined ? {} : { windowStart }),
        ...(relevanceForLargeScope
          ? { relevanceForLargeScope: true as const }
          : {}),
        ...(sort === "relevance" || relevanceForLargeScope
          ? { rankingKey: queryFingerprint(query) }
          : {}),
        ...(mode === "selection" ? { fullRelevance: true as const } : {}),
      },
      signal,
    );
    signal?.throwIfAborted();
    const window = result.search_window;
    const memberTime =
      window && "side" in window && sort === libraryWorksetTimeSort(query);
    if (
      result.ranking_id ||
      (relevanceForLargeScope &&
        !after &&
        (window?.scan_incomplete || result.count_truncated) &&
        !memberTime)
    )
      sort = "relevance";
    const page = result.rows.slice(0, request.limit);
    const total = {
      total_count: result.total_count,
      ...(result.count_truncated ? { count_truncated: true as const } : {}),
    };
    return Object.freeze({
      items: Object.freeze(page.map((row) => row.item)),
      ...total,
      ...(mode !== "selection" &&
      sort === "relevance" &&
      (result.total_count > RELEVANCE_RESULT_LIMIT ||
        result.search_window?.scan_incomplete)
        ? { relevance_limit: RELEVANCE_RESULT_LIMIT }
        : {}),
      ...(result.relevance_scored_count === undefined
        ? {}
        : { relevance_scored_count: result.relevance_scored_count }),
      ...(ftsQuery && window?.scan_incomplete
        ? {
            scan_incomplete: true as const,
            scan_side: ("side" in window ? "members" : "hits") as
              | "members"
              | "hits",
            scan_limit: window.limit,
            next_window_cursor: encodeWindowCursor(query, ftsQuery, window),
          }
        : {}),
      ...(result.tag_backfill_pending === undefined
        ? {}
        : { tag_backfill_pending: result.tag_backfill_pending }),
      ...(result.status_updating ? { status_updating: true as const } : {}),
      ...(result.counts_backfill_pending
        ? { counts_backfill_pending: true as const }
        : {}),
      next_cursor:
        result.rows.length > request.limit && page.length
          ? encodePosition(
              position(page.at(-1)!, sort),
              query,
              sort,
              total,
              result.ranking_id,
              result.search_window,
            )
          : null,
    });
  }

  /** Entry decides target eligibility; this read only supplies the complete version view. */
  async selectionSnapshot(
    value: unknown,
  ): Promise<LiteratureSelectionSnapshot> {
    const query = parseLibraryQuery(value);
    const terms = query.text === null ? null : queryTerms(query.text);
    if (terms?.length === 0)
      return Object.freeze({
        matches: Object.freeze([]),
        members: Object.freeze([]),
      });
    const rows = await this.repository.librarySnapshot(
      terms === null ? null : terms.map((term) => `"${term}"`).join(" AND "),
      query.discovery_run_ids,
      true,
      [],
      [],
      query.tags,
      query.folder ||
        query.collection_scope === "collected" ||
        query.collection_scope === "candidates" ||
        query.recently_opened ||
        query.intake_batch_ids?.length ||
        typeof query.has_primary_pdf === "boolean"
        ? query
        : undefined,
    );
    // A sibling included for completeness may not match FTS or the other query
    // fields. It must not become a new seed for the selected scope.
    const selected = rows.filter(
      (row) =>
        (terms === null || row.relevance !== null) &&
        row.scope_match !== false &&
        matches(row, query),
    );
    const sort = query.text === null ? "publication-year-desc" : "relevance";
    selected.sort((a, b) =>
      compare(position(a, sort), position(b, sort), sort),
    );
    const metas = new Set(
      selected.map((row) => row.item.literature.meta_literature_id),
    );
    return Object.freeze({
      matches: Object.freeze(selected.map((row) => row.item)),
      members: Object.freeze(
        rows
          .filter((row) => metas.has(row.item.literature.meta_literature_id))
          .map((row) => row.item),
      ),
    });
  }
}

interface ReferencePosition {
  readonly related_literature_id: string;
  readonly publication_year: number | null;
  readonly normalized_title: string | null;
}
function referencePosition(item: LiteratureSearchItem): ReferencePosition {
  return {
    related_literature_id: item.literature.literature_id,
    publication_year: item.literature.metadata.publication_year,
    normalized_title:
      item.literature.metadata.title === null
        ? null
        : normalizeQueryText(item.literature.metadata.title),
  };
}
function compareReferencePosition(
  a: ReferencePosition,
  b: ReferencePosition,
): number {
  const nullable = <T>(
    x: T | null,
    y: T | null,
    comparator: (x: T, y: T) => number,
  ) => (x === null ? (y === null ? 0 : 1) : y === null ? -1 : comparator(x, y));
  return (
    nullable(a.publication_year, b.publication_year, (x, y) => y - x) ||
    nullable(a.normalized_title, b.normalized_title, compareText) ||
    compareText(a.related_literature_id, b.related_literature_id)
  );
}
function encodeReferencePosition(
  position: ReferencePosition,
  request: LiteratureReferenceRequest,
): string {
  const core = {
    kind: "literature-references",
    version: 1,
    payload: {
      literature_id: request.literature_id,
      direction: request.direction,
      position: {
        ...position,
        year_is_null: position.publication_year === null,
        title_is_null: position.normalized_title === null,
      },
    },
  };
  return Buffer.from(canonical({ checksum: digest(core), ...core })).toString(
    "base64url",
  );
}
function decodeReferencePosition(
  cursor: string,
  request: LiteratureReferenceRequest,
): ReferencePosition {
  try {
    if (cursor.length > 65536 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) fail();
    const raw = Buffer.from(cursor, "base64url");
    if (raw.toString("base64url") !== cursor) fail();
    const e = object(JSON.parse(raw.toString("utf8")), [
      "checksum",
      "kind",
      "payload",
      "version",
    ]);
    if (
      canonical(e) !== raw.toString("utf8") ||
      e.version !== 1 ||
      e.kind !== "literature-references" ||
      digest({ kind: e.kind, payload: e.payload, version: e.version }) !==
        e.checksum
    )
      fail();
    const payload = object(e.payload, [
      "literature_id",
      "direction",
      "position",
    ]);
    if (
      payload.literature_id !== request.literature_id ||
      payload.direction !== request.direction
    )
      fail();
    const p = object(payload.position, [
      "related_literature_id",
      "publication_year",
      "normalized_title",
      "year_is_null",
      "title_is_null",
    ]);
    if (
      typeof p.related_literature_id !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(
        p.related_literature_id,
      ) ||
      p.year_is_null !== (p.publication_year === null) ||
      p.title_is_null !== (p.normalized_title === null)
    )
      fail();
    if (
      p.publication_year !== null &&
      (typeof p.publication_year !== "number" ||
        !Number.isSafeInteger(p.publication_year) ||
        p.publication_year < 1 ||
        p.publication_year > 9999)
    )
      fail();
    if (
      p.normalized_title !== null &&
      (typeof p.normalized_title !== "string" ||
        !p.normalized_title ||
        normalizeQueryText(p.normalized_title) !== p.normalized_title)
    )
      fail();
    return {
      related_literature_id: p.related_literature_id,
      publication_year: p.publication_year as number | null,
      normalized_title: p.normalized_title as string | null,
    };
  } catch {
    return fail();
  }
}
