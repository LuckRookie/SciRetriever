const {
  visibleLiteratureSql,
  visibleObjectSql,
  visibleCitationSql,
}: typeof import("./intake-visibility.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./intake-visibility.ts"
      : "./intake-visibility.js",
    import.meta.url,
  ).href
);
import type * as Tags from "./tag-engine.js";
const { resolveLibraryTagIds, tagBackfillPending }: typeof Tags = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./tag-engine.ts" : "./tag-engine.js",
    import.meta.url,
  ).href
);
import {
  LITERATURE_STATUSES,
  normalizedTagName,
  draftSortFields,
  globalLibraryCountScope,
  LIBRARY_COUNT_LIMIT,
  LIBRARY_SORT_SCOPE_LIMIT,
  parseIntakeBatchId,
  RELEVANCE_RESULT_LIMIT,
} from "@sciretriever/contracts";
import type * as DraftFacts from "./draft-facts.js";
const { PRIMARY_TEXT_LEVEL_SQL, primaryDraftFactSql }: typeof DraftFacts =
  await import(
    new URL(
      import.meta.url.endsWith(".ts") ? "./draft-facts.ts" : "./draft-facts.js",
      import.meta.url,
    ).href
  );
import type {
  DiscoveryOrigin,
  LibraryCounts,
  LibraryFacets,
  LibraryQuery,
  LibrarySearchTotal,
} from "@sciretriever/contracts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import type {
  LibraryCollectRequest,
  LibraryPageQuery,
  Position,
} from "../../literature/query.js";
import type { LibraryCollectionTargets } from "./library-state.js";
import type { WorksetKind } from "./library-paging-schema.js";
const suffix = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const { libraryPagingReady }: typeof import("./library-paging-state.js") =
  await import(
    new URL("./library-paging-state" + suffix, import.meta.url).href
  );
const { historicalCollectionTimeSql }: typeof import("./schema.js") =
  await import(new URL("./schema" + suffix, import.meta.url).href);
const {
  fullTextCountsFromRow,
  fullTextCountsProjection,
}: typeof import("./full-text-counts.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./full-text-counts.ts"
      : "./full-text-counts.js",
    import.meta.url,
  ).href
);
const {
  historicalCollectionSql,
  storedLibraryState,
}: typeof import("./library-state.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./library-state.ts"
      : "./library-state.js",
    import.meta.url,
  ).href
);

const {
  HAS_PRIMARY_PDF_SQL,
  HAS_EXHAUSTION_SQL,
}: typeof import("./library-count-store.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./library-count-store.ts"
      : "./library-count-store.js",
    import.meta.url,
  ).href
);
export const OPENED_SQL =
  "(SELECT last_opened_at FROM reading_history h WHERE h.literature_id=l.literature_id)";
const recentCutoffAt = (at: number) =>
  new Date(at - 30 * 86_400_000).toISOString();
/** Earliest known observation, not publication date or the last metadata refresh. */
export const INTAKE_SQL =
  "(SELECT intake_at FROM literature_intake WHERE literature_id=l.literature_id)";
function collectionTimeSql(id: string, ready: boolean) {
  const stored = `(SELECT collected_at FROM library_collection_times WHERE literature_id=${id})`;
  return ready
    ? stored
    : `CASE WHEN EXISTS(SELECT 1 FROM library_collection_times WHERE literature_id=${id})
    THEN ${stored} ELSE ${historicalCollectionTimeSql(id)} END`;
}
export function collectedAt(db: DatabaseSync, id: string, ready: boolean) {
  return (
    db
      .prepare(
        `SELECT ${collectionTimeSql("l.literature_id", ready)} AS collected_at FROM literatures l WHERE l.literature_id=?`,
      )
      .get(id)?.collected_at ?? null
  );
}
export function libraryDiscoveryOrigins(
  db: DatabaseSync,
  ids: readonly string[],
): ReadonlyMap<string, DiscoveryOrigin> {
  const origins = new Map<string, DiscoveryOrigin>();
  if (!ids.length) return origins;
  const candidates = (kind: "topic" | "citation") => `
    SELECT p.literature_id,b.kind,b.batch_id,b.created_at
    FROM page p CROSS JOIN ${kind}_discovery_causes c INDEXED BY ${kind}_discovery_cause_actual_lookup
      ON c.actual_literature_id=p.literature_id
    CROSS JOIN discovery_results r
      ON r.discovery_run_id=c.discovery_run_id AND r.meta_literature_id=c.meta_literature_id
    CROSS JOIN intake_batches b ON b.discovery_run_id=c.discovery_run_id AND b.kind='${kind}'
    CROSS JOIN intake_batch_members m ON m.batch_id=b.batch_id AND m.literature_id=p.literature_id
    WHERE sr_query_continue() ${kind === "citation" ? `AND ${visibleCitationSql("c")}` : ""}
  `;
  const rows = db
    .prepare(
      `WITH page(literature_id) AS MATERIALIZED (SELECT value FROM json_each(?)),
      candidates AS (${candidates("topic")} UNION ALL ${candidates("citation")}),
      ranked AS (
        SELECT literature_id,kind,batch_id,
          row_number() OVER (PARTITION BY literature_id ORDER BY created_at DESC,batch_id DESC) AS position
        FROM candidates
      )
      SELECT literature_id,kind,batch_id FROM ranked WHERE position=1`,
    )
    .all(JSON.stringify(ids));
  for (const row of rows) {
    if (row.kind !== "topic" && row.kind !== "citation")
      throw new Error("invalid discovery origin");
    origins.set(String(row.literature_id), {
      kind: row.kind,
      intake_batch_id: parseIntakeBatchId(row.batch_id),
    });
  }
  return origins;
}
export function intakeAt(db: DatabaseSync, id: string): string | null {
  return (db
    .prepare(
      `SELECT ${INTAKE_SQL} AS intake_at FROM literatures l WHERE l.literature_id=?`,
    )
    .get(id)?.intake_at ?? null) as string | null;
}

type Workset = { kind: WorksetKind; ids: readonly string[] };
function orderedWorkset(q: LibraryQuery): Workset | undefined {
  if (q.folder)
    return {
      kind: q.folder.include_descendants ? "folder-tree" : "folder",
      ids: [q.folder.id],
    };
  if (q.intake_batch_ids.length)
    return { kind: "intake", ids: q.intake_batch_ids };
  if (q.discovery_run_ids.length)
    return { kind: "discovery", ids: q.discovery_run_ids };
  return undefined;
}

/** SQL read projection of LibraryQuery; full domain rows are read only for this page. */
function libraryFilter(
  db: DatabaseSync,
  q: LibraryQuery,
  ftsQuery: string | null,
  {
    intakeOrder = false,
    countStatuses = false,
    recentCutoff = recentCutoffAt(Date.now()),
  } = {},
) {
  const state = storedLibraryState(db).readPlan();
  const pagingReady = libraryPagingReady(db);
  const workset = pagingReady ? orderedWorkset(q) : undefined;
  const singleScope =
    workset &&
    new Set(workset.ids).size === 1 &&
    ftsQuery === null &&
    !q.recently_opened;
  const statusNeeded =
    countStatuses ||
    !!q.statuses.length ||
    !!q.missing_steps.length ||
    q.needs_manual_pdf === true;
  const fallback = (column: "status" | "missing_step", fn: string) =>
    `CASE WHEN ls.generation=${state.generation} AND sd.literature_id IS NULL THEN ls.${column}
      ELSE ${fn}(l.literature_id) END`;
  const status = state.indexed
    ? "ls.status"
    : fallback("status", "sr_derive_status");
  const missing = state.indexed
    ? "ls.missing_step"
    : fallback("missing_step", "sr_derive_missing");
  const collecting = q.collection_scope === "collected";
  const collectedJoin = collecting && state.collectionReady;
  const terms: string[] = [
      "sr_query_continue()",
      visibleLiteratureSql("l.literature_id"),
    ],
    args: SQLInputValue[] = [];
  const add = (sql: string, ...values: SQLInputValue[]) => {
    terms.push(sql);
    args.push(...values);
  };
  const any = (field: string, values: readonly string[]) => {
    if (values.length === 1) add(`${field} = ?`, values[0]!);
    else if (values.length)
      add(
        `${field} IN (SELECT value FROM json_each(?))`,
        JSON.stringify(values),
      );
  };
  const membership = (kind: WorksetKind, ids: readonly string[]) => {
    if (
      workset?.kind === kind &&
      new Set(workset.ids).size === 1 &&
      ftsQuery === null &&
      !q.recently_opened
    )
      return;
    add(
      `EXISTS(SELECT 1 FROM library_ordered_members p WHERE p.kind='${kind}' AND
        p.scope_id IN (SELECT value FROM json_each(?)) AND p.literature_id=l.literature_id)`,
      JSON.stringify(ids),
    );
  };
  for (const field of ["title", "venue", "publisher"] as const)
    if (q[field] !== null)
      add(`instr(sr_normalize(m.${field}), sr_normalize(?)) > 0`, q[field]);
  if (q.author !== null)
    add(
      "EXISTS(SELECT 1 FROM literature_metadata_authors au WHERE au.literature_id=l.literature_id AND (instr(sr_normalize(au.display_name),sr_normalize(?))>0 OR instr(sr_normalize(au.given_name),sr_normalize(?))>0 OR instr(sr_normalize(au.family_name),sr_normalize(?))>0))",
      q.author,
      q.author,
      q.author,
    );
  if (q.author_orcids.length)
    add(
      "EXISTS(SELECT 1 FROM literature_metadata_authors au WHERE au.literature_id=l.literature_id AND au.orcid IN (SELECT value FROM json_each(?)))",
      JSON.stringify(q.author_orcids),
    );
  if (q.identifiers.length)
    add(
      "EXISTS(SELECT 1 FROM literature_metadata_identifiers i JOIN json_each(?) wanted ON i.namespace=json_extract(wanted.value,'$.namespace') AND i.value=json_extract(wanted.value,'$.value') WHERE i.literature_id=l.literature_id)",
      JSON.stringify(q.identifiers),
    );
  if (q.publication_year_from !== null)
    add("m.publication_year >= ?", q.publication_year_from);
  if (q.publication_year_to !== null)
    add("m.publication_year <= ?", q.publication_year_to);
  any("m.publication_form", q.publication_forms);
  any("m.article_kind", q.article_kinds);
  any("m.language", q.languages);
  any("l.version_role", q.version_roles);
  for (const keyword of q.keywords)
    add(
      "EXISTS(SELECT 1 FROM literature_metadata_keywords k WHERE k.literature_id=l.literature_id AND sr_normalize(k.keyword)=sr_normalize(?))",
      keyword,
    );
  for (const term of q.subject_terms ?? [])
    add(
      "EXISTS(SELECT 1 FROM literature_metadata_subject_terms s WHERE s.literature_id=l.literature_id AND s.normalized_term=sr_normalize(?))",
      term,
    );
  if (q.intake_batch_ids.length && pagingReady)
    membership("intake", q.intake_batch_ids);
  else if (q.intake_batch_ids.length)
    add(
      "EXISTS(SELECT 1 FROM intake_batch_members b WHERE b.literature_id=l.literature_id AND b.batch_id IN (SELECT value FROM json_each(?)))",
      JSON.stringify(q.intake_batch_ids),
    );
  if (collecting && !collectedJoin)
    add(
      `(EXISTS(SELECT 1 FROM library_collected WHERE literature_id=l.literature_id) OR ${historicalCollectionSql("l.literature_id")})`,
    );
  any(status, q.statuses);
  any(missing, q.missing_steps);
  if (q.needs_manual_pdf === true)
    add(`(${HAS_EXHAUSTION_SQL} AND ${status}='UNREVIEWED')`);
  if (q.needs_manual_pdf === false) add(`NOT ${HAS_EXHAUSTION_SQL}`);
  if (typeof q.has_primary_pdf === "boolean")
    add(`${HAS_PRIMARY_PDF_SQL} = ?`, Number(q.has_primary_pdf));
  if (q.discovery_run_ids.length && pagingReady)
    membership("discovery", q.discovery_run_ids);
  else if (q.discovery_run_ids.length) {
    const ids = JSON.stringify(q.discovery_run_ids);
    add(
      `l.literature_id IN (SELECT actual_literature_id FROM topic_discovery_causes WHERE discovery_run_id IN (SELECT value FROM json_each(?)) UNION SELECT actual_literature_id FROM citation_discovery_causes WHERE ${visibleCitationSql()} AND discovery_run_id IN (SELECT value FROM json_each(?)))`,
      ids,
      ids,
    );
  }
  const tagIds = q.tags?.ids.length ? resolveLibraryTagIds(db, q.tags.ids) : [];
  if (tagIds.length)
    add(
      `EXISTS(SELECT 1 FROM literature_tag_items i WHERE i.literature_id=l.literature_id AND i.tag_id IN (SELECT value FROM json_each(?)) ${q.tags?.mode === "primary" ? "AND i.rank=1" : ""})`,
      JSON.stringify(tagIds),
    );
  if (q.folder && pagingReady)
    membership(q.folder.include_descendants ? "folder-tree" : "folder", [
      q.folder.id,
    ]);
  else if (q.folder) {
    const ids = q.folder.include_descendants
      ? "WITH RECURSIVE descendants(id) AS (SELECT folder_id FROM folders WHERE folder_id=? UNION SELECT f.folder_id FROM folders f JOIN descendants d ON f.parent_id=d.id) SELECT id FROM descendants"
      : "SELECT folder_id FROM folders WHERE folder_id=?";
    add(
      `EXISTS(SELECT 1 FROM folder_members fm WHERE fm.literature_id=l.literature_id AND ${visibleObjectSql("folder-member", "json_array(fm.folder_id,fm.literature_id)")} AND ${visibleObjectSql("folder", "fm.folder_id")} AND fm.folder_id IN (${ids}))`,
      q.folder.id,
    );
  }
  if (q.recently_opened) add(`${OPENED_SQL} >= ?`, recentCutoff);
  if (typeof q.needs_metadata === "boolean")
    add(
      `EXISTS(SELECT 1 FROM literature_needs_metadata n WHERE n.literature_id=${singleScope ? "om" : "l"}.literature_id) = ?`,
      Number(q.needs_metadata),
    );
  if (q.text_levels?.length) any(PRIMARY_TEXT_LEVEL_SQL, q.text_levels);
  for (const [key, field] of [
    ["has_draft_differences", "differs_segments"],
    ["has_image_only_pages", "image_only_pages"],
    ["cited_by_results", "citing_results"],
    ["has_unfound_citations", "unfound_citations"],
  ] as const) {
    if (typeof q[key] === "boolean")
      add(`${primaryDraftFactSql(field)} ${q[key] ? ">" : "="} 0`);
  }
  if (ftsQuery === "") {
    add("0");
    ftsQuery = null;
  } else if (ftsQuery !== null) add("literature_search_fts MATCH ?", ftsQuery);
  const metadata =
    "JOIN literature_metadata m ON m.literature_id=l.literature_id";
  const stored =
    "JOIN library_literature_states ls ON ls.literature_id=l.literature_id";
  const stateJoins = !statusNeeded
    ? ""
    : state.indexed
      ? stored
      : `LEFT ${stored} LEFT JOIN library_state_dirty sd ON sd.literature_id=l.literature_id`;
  const collectionJoin = collectedJoin
    ? "JOIN library_collected lc ON lc.literature_id=l.literature_id"
    : "";
  const orderedCollection = collectedJoin ? "CROSS " + collectionJoin : "";
  const orderedState =
    statusNeeded && state.indexed ? "CROSS " + stateJoins : stateJoins;
  // Counting uses the same joins and duplicate check. Let SQLite walk the
  // covering ID indexes instead of forcing a lookup per row in intake order.
  const intakeJoin =
    "JOIN literature_intake li ON l.literature_id=li.literature_id";
  const from = `FROM literatures l ${metadata} ${stateJoins} ${collectionJoin} ${
    intakeOrder
      ? intakeJoin
      : ftsQuery === null
        ? ""
        : " JOIN literature_search_fts ON literature_search_fts.literature_id=l.literature_id"
  }`;
  const memberFrom = `FROM library_ordered_members om INDEXED BY library_ordered_members_order
    CROSS JOIN literatures l ON l.literature_id=om.literature_id
    CROSS ${metadata} ${intakeOrder ? "CROSS " + intakeJoin : ""} ${orderedState} ${orderedCollection}`;
  const stateOrder =
    state.indexed &&
    (q.statuses.length === 1
      ? "library_literature_states_status"
      : q.missing_steps.length === 1
        ? "library_literature_states_missing"
        : null);
  const intakeSource = collectedJoin ? "lc" : stateOrder ? "ls" : "li";
  const orderedFrom = intakeOrder
    ? intakeSource === "lc"
      ? `FROM library_collected lc INDEXED BY library_collected_order CROSS JOIN literatures l ON l.literature_id=lc.literature_id CROSS ${metadata} CROSS ${intakeJoin} ${orderedState}`
      : intakeSource === "ls"
        ? `FROM library_literature_states ls INDEXED BY ${stateOrder} CROSS JOIN literatures l ON l.literature_id=ls.literature_id CROSS ${metadata} CROSS ${intakeJoin}`
        : `FROM literature_intake li INDEXED BY literature_intake_order CROSS JOIN literatures l ON l.literature_id=li.literature_id CROSS ${metadata} ${orderedState}`
    : from;
  let where = terms.length ? `WHERE ${terms.join(" AND ")}` : "";
  if (q.recently_opened) {
    const recentFrom = from.replace(
      "FROM literatures l",
      "FROM reading_history h INDEXED BY reading_history_opened CROSS JOIN literatures l ON l.literature_id=h.literature_id",
    );
    where = `WHERE l.literature_id IN (SELECT l.literature_id ${recentFrom}
      ${where.replace(`${OPENED_SQL} >= ?`, "h.last_opened_at >= ?")}
      ORDER BY h.last_opened_at DESC,h.literature_id LIMIT 100)`;
  }
  // An outer FTS join still needs a MATCH term for bm25 and must use the same query.
  if (q.recently_opened && ftsQuery !== null) {
    where += " AND literature_search_fts MATCH ?";
    args.push(ftsQuery);
  }
  return {
    from: singleScope ? memberFrom : from,
    orderedFrom,
    where: singleScope ? `${where} AND om.kind=? AND om.scope_id=?` : where,
    args: singleScope ? [...args, workset.kind, workset.ids[0]!] : args,
    memberFrom,
    memberWhere: where,
    memberArgs: args,
    singleScope,
    workset,
    orderedState,
    orderedCollection,
    tagIds,
    status,
    intakeSource,
    updating: state.updating,
    collectionReady: state.collectionReady,
    pagingReady,
  };
}
/** Full QuerySelector scope with the same predicates as paging. */
export function libraryCollectionTargets(
  db: DatabaseSync,
  { selector, ftsQuery }: LibraryCollectRequest,
): LibraryCollectionTargets {
  if (selector.kind === "literatures")
    return {
      sql: `SELECT l.literature_id FROM json_each(?) i
        CROSS JOIN literatures l ON l.literature_id=i.value
        CROSS JOIN literature_metadata m ON m.literature_id=l.literature_id
        WHERE sr_query_continue() AND ${visibleLiteratureSql("l.literature_id")}`,
      parameters: [JSON.stringify(selector.literature_ids)],
    };
  const { from, where, args } = libraryFilter(db, selector.query, ftsQuery);
  return { sql: `SELECT l.literature_id ${from} ${where}`, parameters: args };
}

function countsFromTotals(
  db: DatabaseSync,
  scope: "all" | "collected",
  cutoff: string,
): LibraryCounts {
  const store = storedLibraryState(db).counts;
  const row = store.read(scope);
  const recentlyOpened = db
    .prepare(
      `SELECT count(*) AS n FROM (
      SELECT 1 FROM reading_history h
      WHERE h.last_opened_at>=? AND sr_query_continue()
      AND ${visibleLiteratureSql("h.literature_id")}
      AND EXISTS(SELECT 1 FROM literature_metadata m WHERE m.literature_id=h.literature_id)
      ${scope === "collected" ? "AND EXISTS(SELECT 1 FROM library_collected c WHERE c.literature_id=h.literature_id)" : ""}
      ORDER BY h.last_opened_at DESC LIMIT 100
    )`,
    )
    .get(cutoff)!;
  const total = row.versions;
  const collected = scope === "all" ? store.read("collected").versions : total;
  return {
    total,
    ...(scope === "all"
      ? { collection_counts: { collected, discovered_only: total - collected } }
      : {}),
    recently_opened: Number(recentlyOpened.n),
    statuses: Object.fromEntries(
      LITERATURE_STATUSES.map((s) => [
        s,
        row[s.toLowerCase() as Lowercase<typeof s>],
      ]),
    ) as LibraryCounts["statuses"],
    unavailable_pdf: row.unavailable_pdf,
    with_primary_pdf: row.with_primary_pdf,
    full_text: fullTextCountsFromRow({
      total: row.papers,
      obtained: row.obtained,
      exhausted: row.exhausted,
    }),
  };
}

export function libraryCounts(
  db: DatabaseSync,
  query: LibraryQuery,
  ftsQuery: string | null,
  exact = false,
  at = Date.now(),
): LibraryCounts {
  // Quick-filter counts ignore both quick selections, but retain all other facets.
  const q = { ...query, statuses: [], needs_manual_pdf: null };
  const scope = ftsQuery === null ? globalLibraryCountScope(q) : null;
  const state = storedLibraryState(db);
  const recentCutoff = recentCutoffAt(at);
  if (scope && state.countsReady())
    return countsFromTotals(db, scope, recentCutoff);
  const bounded = !exact && scope === null;
  const { from, where, args, status, updating, collectionReady } =
    libraryFilter(db, q, ftsQuery, { countStatuses: true, recentCutoff });
  const matching = `SELECT l.literature_id,${status} AS status ${from} ${where}`;
  const sample = bounded
    ? `window AS MATERIALIZED (${matching} LIMIT ${LIBRARY_COUNT_LIMIT + 1}),
       matches AS MATERIALIZED (SELECT * FROM window LIMIT ${LIBRARY_COUNT_LIMIT})`
    : `matches AS MATERIALIZED (${matching})`;
  const paper = fullTextCountsProjection(
    "SELECT literature_id FROM matches",
    undefined,
    true,
  );
  const collectedSql = `EXISTS(SELECT 1 FROM library_collected c WHERE c.literature_id=l.literature_id)
    ${collectionReady ? "" : `OR ${historicalCollectionSql("l.literature_id")}`}`;
  const row = db
    .prepare(
      `WITH ${sample}, ${paper.cte},
      version_counts AS (
        SELECT count(*) AS versions,
          min(100,coalesce(sum(${OPENED_SQL}>=?),0)) AS recently_opened,
          coalesce(sum(matches.status='UNREVIEWED' AND ${HAS_EXHAUSTION_SQL}),0) AS unavailable_pdf,
          coalesce(sum(${HAS_PRIMARY_PDF_SQL}),0) AS with_primary_pdf,
          ${scope === "all" ? `coalesce(sum(${collectedSql}),0) AS collected,` : ""}
          ${LITERATURE_STATUSES.map((s) => `coalesce(sum(matches.status='${s}'),0) AS ${s.toLowerCase()}`).join(",")}
        FROM matches CROSS JOIN literatures l USING(literature_id) WHERE sr_query_continue()
      ), paper_counts AS (SELECT ${paper.columns})
     SELECT v.*, p.total AS papers, p.obtained, p.exhausted
       ${bounded ? `, (SELECT count(*)>${LIBRARY_COUNT_LIMIT} FROM window) AS truncated` : ""}
     FROM version_counts v CROSS JOIN paper_counts p`,
    )
    .get(...args, recentCutoff)!;
  const total = Number(row.versions);
  return {
    ...countReadFlags(state, updating),
    ...(row.truncated ? { count_truncated: true as const } : {}),
    ...(scope === "all"
      ? {
          collection_counts: {
            collected: Number(row.collected),
            discovered_only: total - Number(row.collected),
          },
        }
      : {}),
    total,
    recently_opened: Number(row.recently_opened),
    statuses: Object.fromEntries(
      LITERATURE_STATUSES.map((s) => [s, Number(row[s.toLowerCase()])]),
    ) as LibraryCounts["statuses"],
    unavailable_pdf: Number(row.unavailable_pdf),
    with_primary_pdf: Number(row.with_primary_pdf),
    full_text: fullTextCountsFromRow({
      total: row.papers,
      obtained: row.obtained,
      exhausted: row.exhausted,
    }),
  };
}

function countReadFlags(
  state: ReturnType<typeof storedLibraryState>,
  updating: boolean,
) {
  return {
    ...(updating ? { status_updating: true as const } : {}),
    ...(state.counts.backfillPending
      ? { counts_backfill_pending: true as const }
      : {}),
  };
}

export function librarySearchTotal(
  db: DatabaseSync,
  query: LibraryQuery,
  ftsQuery: string | null,
  exact: boolean,
  filter?: ReturnType<typeof libraryFilter>,
  at = Date.now(),
): LibrarySearchTotal {
  const state = storedLibraryState(db);
  const scope = ftsQuery === null ? globalLibraryCountScope(query) : null;
  const matches =
    filter ??
    libraryFilter(db, query, ftsQuery, { recentCutoff: recentCutoffAt(at) });
  const flags = countReadFlags(state, matches.updating);
  if (scope && state.countsReady())
    return { total_count: state.counts.read(scope).versions, ...flags };
  const bounded = !exact && scope === null;
  const { from, where, args } = matches;
  const counts = db
    .prepare(
      `SELECT count(*) AS total,count(DISTINCT literature_id) AS unique_count
     FROM (SELECT l.literature_id ${from} ${where} ${bounded ? `LIMIT ${LIBRARY_COUNT_LIMIT + 1}` : ""})`,
    )
    .get(...args)!;
  if (counts.total !== counts.unique_count)
    throw new Error("duplicate library search rows");
  const total = Number(counts.total);
  return total > LIBRARY_COUNT_LIMIT && bounded
    ? { ...flags, total_count: LIBRARY_COUNT_LIMIT, count_truncated: true }
    : { ...flags, total_count: total };
}

type PageRow = Record<string, SQLOutputValue>;
type RankingRow = { literature_id: string; relevance: number };
type Filter = ReturnType<typeof libraryFilter>;

/** One worker owns each text page and its continuation. Same-file reconnects keep this cache. */
export class LibraryRelevanceCache {
  private readonly windows = new Map<
    string,
    { key: string; rows: RankingRow[] }
  >();

  get(id: string, key: string) {
    const window = this.windows.get(id);
    if (!window || window.key !== key) return undefined;
    this.windows.delete(id);
    this.windows.set(id, window);
    return window.rows;
  }

  put(key: string, rows: RankingRow[]) {
    const id = randomUUID();
    this.windows.set(id, { key, rows });
    if (this.windows.size > 16)
      this.windows.delete(this.windows.keys().next().value!);
    return id;
  }

  clear() {
    this.windows.clear();
  }
}

function relevancePage(
  db: DatabaseSync,
  filter: Filter,
  after: Position | null,
  limit: number,
  relevance: string,
  cache: LibraryRelevanceCache | undefined,
  key: string | undefined,
) {
  const previousId = after?.ranking_id;
  const cached = previousId && key ? cache?.get(previousId, key) : undefined;
  const ranked: RankingRow[] =
    cached ??
    (db
      .prepare(
        `SELECT l.literature_id,${relevance} AS relevance ${filter.from} ${filter.where}
     ORDER BY relevance ASC,l.literature_id ASC LIMIT ${RELEVANCE_RESULT_LIMIT}`,
      )
      .all(...filter.args) as RankingRow[]);
  if (
    !cached &&
    new Set(ranked.map((row) => row.literature_id)).size !== ranked.length
  )
    throw new Error("duplicate library search rows");
  const rankingId = cached
    ? previousId
    : key
      ? cache?.put(key, ranked)
      : undefined;
  let start = 0;
  if (after) {
    const anchor = ranked.findIndex(
      (row) => row.literature_id === after.literature_id,
    );
    if (anchor >= 0) start = anchor + 1;
    else {
      const value = Number(after.value);
      const next = ranked.findIndex(
        (row) =>
          row.relevance > value ||
          (row.relevance === value && row.literature_id > after.literature_id),
      );
      start = next < 0 ? ranked.length : next;
    }
  }
  const visible = cached
    ? db.prepare(
        `SELECT 1 FROM literatures l JOIN literature_metadata m USING(literature_id)
      WHERE l.literature_id=? AND sr_query_continue() AND ${visibleLiteratureSql("l.literature_id")}`,
      )
    : undefined;
  const rows: RankingRow[] = [];
  for (let i = start; i < ranked.length && rows.length <= limit; i++) {
    const row = ranked[i]!;
    if (!visible || visible.get(row.literature_id)) rows.push(row);
  }
  return { rows, ...(rankingId ? { ranking_id: rankingId } : {}) };
}

/** Seek in the timestamp partition, then at an earlier timestamp, then through the null tail. */
function indexPage(
  db: DatabaseSync,
  from: string,
  where: string,
  args: SQLInputValue[],
  at: string,
  id: string,
  after: Position | null,
  limit: number,
) {
  const rows: PageRow[] = [];
  const read = (seek: string, ...values: SQLInputValue[]) => {
    if (rows.length > limit) return;
    for (const row of db
      .prepare(
        `SELECT l.literature_id,NULL AS relevance,${at} AS sort_value ${from} ${where} ${seek}
       ORDER BY ${at} DESC,${id} ASC LIMIT ?`,
      )
      .all(...args, ...values, limit + 1 - rows.length))
      rows.push(row);
  };
  if (!after) read("");
  else if (after.value === null)
    read(`AND ${at} IS NULL AND ${id}>?`, after.literature_id);
  else {
    read(`AND ${at}=? AND ${id}>?`, after.value, after.literature_id);
    read(`AND ${at}<?`, after.value);
    read(`AND ${at} IS NULL`);
  }
  return rows;
}

function worksetPage(
  db: DatabaseSync,
  filter: Filter,
  after: Position | null,
  limit: number,
) {
  const workset = filter.workset!;
  let page: PageRow[] = [];
  for (const scope of new Set(workset.ids)) {
    const rows = indexPage(
      db,
      filter.memberFrom,
      `${filter.memberWhere} AND om.kind=? AND om.scope_id=?`,
      [...filter.memberArgs, workset.kind, scope],
      "om.intake_at",
      "om.literature_id",
      after,
      limit,
    );
    if (workset.ids.length === 1) return rows;
    // The first limit+1 distinct IDs of a union are in these prefixes.
    page = Array.from(
      new Map(
        [...page, ...rows].map((row) => [row.literature_id, row]),
      ).values(),
    )
      .sort((a, b) => {
        if (a.sort_value !== b.sort_value) {
          if (a.sort_value === null) return 1;
          if (b.sort_value === null) return -1;
          return String(a.sort_value) > String(b.sort_value) ? -1 : 1;
        }
        return String(a.literature_id) < String(b.literature_id) ? -1 : 1;
      })
      .slice(0, limit + 1);
  }
  return page;
}

/** The bounded count and the initial page share one ordered scan. */
function firstOrderedWorksetPage(
  db: DatabaseSync,
  filter: Filter,
  limit: number,
) {
  const countLimit = LIBRARY_COUNT_LIMIT + 1;
  const counted = new Set<SQLOutputValue>();
  const rows: PageRow[] = [];
  const ordered = db.prepare(
    `SELECT l.literature_id,NULL AS relevance,om.intake_at AS sort_value
     ${filter.from} ${filter.where}
     ORDER BY om.intake_at DESC,om.literature_id LIMIT ?`,
  );
  for (const row of ordered.iterate(
    ...filter.args,
    Math.max(countLimit, limit + 1),
  )) {
    if (counted.size < countLimit) {
      if (counted.has(row.literature_id!))
        throw new Error("duplicate library search rows");
      counted.add(row.literature_id!);
    }
    if (rows.length <= limit) rows.push(row);
  }
  return {
    rows,
    total_count: Math.min(counted.size, LIBRARY_COUNT_LIMIT),
    ...(counted.size > LIBRARY_COUNT_LIMIT
      ? { count_truncated: true as const }
      : {}),
  };
}

export function libraryPageIds(
  db: DatabaseSync,
  request: LibraryPageQuery,
  cache?: LibraryRelevanceCache,
) {
  const { query: q, after, limit, ftsQuery } = request;
  let { sort } = request;
  const filter = libraryFilter(db, q, ftsQuery, {
    intakeOrder: sort === "intake-desc" && ftsQuery === null,
  });
  const { from, orderedFrom, where, args, tagIds, intakeSource, updating } =
    filter;
  const flags = countReadFlags(storedLibraryState(db), updating);
  const tags = tagIds.length
    ? { tag_backfill_pending: tagBackfillPending(db, tagIds, q.tags!.mode) }
    : {};
  if (
    !after &&
    !request.fullRelevance &&
    sort === "intake-desc" &&
    q.text === null &&
    filter.singleScope
  )
    return { ...firstOrderedWorksetPage(db, filter, limit), ...flags, ...tags };
  const summary = {
    ...(after?.total && !request.fullRelevance
      ? { ...after.total, ...flags }
      : librarySearchTotal(
          db,
          q,
          ftsQuery,
          request.fullRelevance === true,
          filter,
        )),
    ...tags,
  };
  if (
    !request.fullRelevance &&
    (summary.count_truncated || summary.total_count > LIBRARY_COUNT_LIMIT)
  ) {
    const allowed =
      q.text !== null
        ? "relevance"
        : q.recently_opened
          ? "opened-desc"
          : q.collection_scope === "collected" && !orderedWorkset(q)
            ? "collected-desc"
            : "intake-desc";
    if (allowed === "relevance" && request.relevanceForLargeScope && !after)
      sort = allowed;
    if (sort !== allowed)
      throw Object.assign(new Error("library sort requires a smaller scope"), {
        code: LIBRARY_SORT_SCOPE_LIMIT,
      });
  }
  const ensureUnique = (rows: PageRow[]) => {
    if (
      !request.fullRelevance &&
      ftsQuery !== null &&
      new Set(rows.map((row) => row.literature_id)).size !== rows.length
    )
      throw new Error("duplicate library search rows");
    return rows;
  };
  const relevance = ftsQuery === null ? "NULL" : "bm25(literature_search_fts)";
  if (sort === "relevance" && !request.fullRelevance) {
    return {
      ...relevancePage(
        db,
        filter,
        after,
        limit,
        relevance,
        cache,
        request.rankingKey,
      ),
      ...summary,
    };
  }
  if (
    sort === "intake-desc" &&
    ftsQuery === null &&
    filter.workset &&
    !q.recently_opened
  )
    return { rows: worksetPage(db, filter, after, limit), ...summary };
  if (sort === "intake-desc" && ftsQuery === null && !q.recently_opened)
    return {
      rows: indexPage(
        db,
        orderedFrom,
        where,
        args,
        `${intakeSource}.intake_at`,
        `${intakeSource}.literature_id`,
        after,
        limit,
      ),
      ...summary,
    };
  if (
    sort === "collected-desc" &&
    q.collection_scope === "collected" &&
    filter.collectionReady &&
    filter.pagingReady &&
    !filter.workset &&
    ftsQuery === null &&
    !q.recently_opened
  )
    return {
      rows: indexPage(
        db,
        `FROM library_collection_times ct INDEXED BY library_collection_time_order
          CROSS JOIN literatures l ON l.literature_id=ct.literature_id
          CROSS JOIN literature_metadata m ON m.literature_id=l.literature_id
          ${filter.orderedState} ${filter.orderedCollection}`,
        where,
        args,
        "ct.collected_at",
        "ct.literature_id",
        after,
        limit,
      ),
      ...summary,
    };
  const metrics = draftSortFields(sort);
  if (metrics) {
    const pageArgs = [...args],
      second = metrics.length === 2;
    let cursor = "";
    if (after) {
      if (after.value === null) {
        cursor = "WHERE sort_value IS NULL AND literature_id>?";
        pageArgs.push(after.literature_id);
      } else if (second) {
        cursor =
          "WHERE sort_value IS NULL OR sort_value<? OR (sort_value=? AND (sort_secondary<? OR (sort_secondary=? AND literature_id>?)))";
        pageArgs.push(
          after.value,
          after.value,
          after.secondary!,
          after.secondary!,
          after.literature_id,
        );
      } else {
        cursor =
          "WHERE sort_value IS NULL OR sort_value<? OR (sort_value=? AND literature_id>?)";
        pageArgs.push(after.value, after.value, after.literature_id);
      }
    }
    const rows = db
      .prepare(
        `WITH matches AS MATERIALIZED (SELECT l.literature_id,${primaryDraftFactSql(metrics[0]!)} AS sort_value${second ? `,${primaryDraftFactSql(metrics[1]!)} AS sort_secondary` : ""},${relevance} AS relevance ${from} ${where}) SELECT literature_id,relevance FROM matches ${cursor} ORDER BY sort_value IS NULL,sort_value DESC,${second ? "sort_secondary DESC," : ""}literature_id ASC LIMIT ?`,
      )
      .all(...pageArgs, limit + 1);
    return {
      rows: ensureUnique(rows),
      ...summary,
    };
  }
  const value =
    sort === "opened-desc"
      ? OPENED_SQL
      : sort === "intake-desc"
        ? INTAKE_SQL
        : sort === "collected-desc"
          ? collectionTimeSql("l.literature_id", filter.pagingReady)
          : sort.startsWith("title")
            ? "sr_normalize(m.title)"
            : sort.startsWith("publication-year")
              ? "m.publication_year"
              : relevance;
  const pageArgs = [...args];
  let cursor = "";
  if (after) {
    if (after.value === null) {
      cursor = "WHERE sort_value IS NULL AND literature_id > ?";
      pageArgs.push(after.literature_id);
    } else {
      cursor = `WHERE sort_value IS NULL OR sort_value ${sort.endsWith("desc") ? "<" : ">"} ? OR (sort_value = ? AND literature_id > ?)`;
      pageArgs.push(after.value, after.value, after.literature_id);
    }
  }
  // FTS candidates keep their own join order; forcing the intake index there
  // would scan the whole catalog for every matching term. Materialization also
  // keeps bm25 in its FTS context and computes each title key once.
  const rows = db
    .prepare(
      `WITH matches AS MATERIALIZED (SELECT l.literature_id, ${value} AS sort_value, ${relevance} AS relevance ${from} ${where}) SELECT literature_id,relevance FROM matches ${cursor} ORDER BY sort_value IS NULL, sort_value ${sort.endsWith("desc") ? "DESC" : "ASC"}, literature_id ASC LIMIT ?`,
    )
    .all(...pageArgs, limit + 1);
  return {
    rows: ensureUnique(rows),
    ...summary,
  };
}

const TAG_DISPLAY_NAME =
  "coalesce(nullif(json_extract(t.row_json,'$.name_zh'),''),json_extract(t.row_json,'$.name_en'))";
type FacetWord = { value: string; count: number };

/** Resolve only the returned keyword window through the indexed alias key. */
function keywordTags(
  db: DatabaseSync,
  words: readonly FacetWord[],
): LibraryFacets["keywords"] {
  const names = [
    ...new Set(words.map((word) => normalizedTagName(word.value))),
  ];
  const links = new Map<string, { tag_id: string; name: string }>();
  if (names.length)
    for (const row of db
      .prepare(
        `SELECT a.normalized_name,t.tag_id,${TAG_DISPLAY_NAME} AS name FROM tag_aliases a JOIN tags t ON t.tag_id=a.tag_id WHERE a.normalized_name IN (SELECT value FROM json_each(?)) AND t.status='active'`,
      )
      .all(JSON.stringify(names)))
      links.set(String(row.normalized_name), {
        tag_id: String(row.tag_id),
        name: String(row.name),
      });
  return words.map((word) => ({
    ...word,
    tag: links.get(normalizedTagName(word.value)) ?? null,
  }));
}

export function libraryFacets(
  db: DatabaseSync,
  query: LibraryQuery,
  ftsQuery: string | null,
  limit: number,
  exact = false,
  at = Date.now(),
): LibraryFacets {
  const state = storedLibraryState(db);
  const scope = ftsQuery === null ? globalLibraryCountScope(query) : null;
  const filter = libraryFilter(db, query, ftsQuery, {
    recentCutoff: recentCutoffAt(at),
  });
  const { from, where, args, updating } = filter;
  const matching = `SELECT l.literature_id ${from} ${where}`;
  const sample = exact
    ? `matches AS MATERIALIZED (${matching})`
    : `window AS MATERIALIZED (${matching} LIMIT ${LIBRARY_COUNT_LIMIT + 1}),
       matches AS MATERIALIZED (SELECT * FROM window LIMIT ${LIBRARY_COUNT_LIMIT})`;
  // Share the filtered membership and layer rows between coverage and top terms.
  // All fields are read in the caller's one SQLite snapshot, without loading details.
  const result = db
    .prepare(
      `WITH ${sample},
      scope_tags AS MATERIALIZED (SELECT i.literature_id,i.tag_id FROM matches m CROSS JOIN literature_tag_items i USING(literature_id) WHERE sr_query_continue()),
      scope_keywords AS MATERIALIZED (SELECT k.literature_id,k.keyword FROM matches m CROSS JOIN literature_metadata_keywords k USING(literature_id) WHERE sr_query_continue()),
      scope_subjects AS MATERIALIZED (SELECT s.literature_id,s.term,s.normalized_term FROM matches m CROSS JOIN literature_metadata_subject_terms s USING(literature_id) WHERE sr_query_continue())
    SELECT
      (SELECT count(*) FROM ${exact ? "matches" : "window"}) AS window_total,
      (SELECT count(DISTINCT literature_id) FROM scope_tags) AS tags_coverage,
      (SELECT count(DISTINCT literature_id) FROM scope_keywords) AS keywords_coverage,
      (SELECT count(DISTINCT literature_id) FROM scope_subjects) AS subjects_coverage,
      (SELECT json_group_array(json_object('tag_id',tag_id,'value',value,'count',count)) FROM (
        SELECT c.tag_id,${TAG_DISPLAY_NAME} AS value,c.count FROM (SELECT tag_id,count(DISTINCT literature_id) AS count FROM scope_tags GROUP BY tag_id) c JOIN tags t ON t.tag_id=c.tag_id WHERE t.status='active' ORDER BY c.count DESC,value COLLATE BINARY ASC,c.tag_id LIMIT ?
      )) AS tags_json,
      (SELECT json_group_array(json_object('value',value,'count',count)) FROM (
        SELECT min(keyword) AS value,count(DISTINCT literature_id) AS count FROM scope_keywords GROUP BY sr_normalize(keyword) ORDER BY count DESC,value COLLATE BINARY ASC LIMIT ?
      )) AS keywords_json,
      (SELECT json_group_array(json_object('value',value,'count',count)) FROM (
        SELECT min(term) AS value,count(DISTINCT literature_id) AS count FROM scope_subjects GROUP BY normalized_term ORDER BY count DESC,value COLLATE BINARY ASC LIMIT ?
      )) AS subjects_json`,
    )
    .get(...args, limit, limit, limit)!;
  const windowTotal = Number(result.window_total);
  const truncated = !exact && windowTotal > LIBRARY_COUNT_LIMIT;
  let total = truncated ? LIBRARY_COUNT_LIMIT : windowTotal;
  if (scope && state.countsReady()) total = state.counts.read(scope).versions;
  else if (scope && truncated)
    total = librarySearchTotal(db, query, ftsQuery, true, filter).total_count;
  return {
    ...countReadFlags(state, updating),
    ...(truncated ? { facets_truncated: true as const } : {}),
    ...(truncated && !scope ? { count_truncated: true as const } : {}),
    total,
    coverage: {
      tags: Number(result.tags_coverage),
      keywords: Number(result.keywords_coverage),
      subject_terms: Number(result.subjects_coverage),
    },
    tags: JSON.parse(String(result.tags_json)) as LibraryFacets["tags"],
    keywords: keywordTags(
      db,
      JSON.parse(String(result.keywords_json)) as FacetWord[],
    ),
    subject_terms: JSON.parse(
      String(result.subjects_json),
    ) as LibraryFacets["subject_terms"],
  };
}
import type {
  PdfSelectionRequest,
  PdfSelection,
} from "../../literature/query.js";
export function acquirePdfSelection(
  db: DatabaseSync,
  request: PdfSelectionRequest,
): PdfSelection {
  const selector = request.selector;
  const ids = selectionIds(db, request);
  const facts = db
    .prepare(
      `SELECT l.literature_id,l.version_role,EXISTS(SELECT 1 FROM literature_assets a WHERE a.literature_id=l.literature_id AND a.role='primary-pdf') AS has_pdf,CASE WHEN EXISTS(SELECT 1 FROM automatic_pdf_acquisition_exhaustions ex WHERE ex.literature_id=l.literature_id) THEN sr_status(l.literature_id)='UNREVIEWED' ELSE 0 END AS unavailable FROM literatures l WHERE ${visibleLiteratureSql("l.literature_id")} AND l.literature_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids));
  if (facts.length !== ids.length)
    throw Object.assign(new Error("literature not found"), {
      code: "literature-not-found",
    });
  const byId = new Map(facts.map((r) => [r.literature_id, r]));
  const counts = {
    matched: ids.length,
    process: 0,
    skipped_has_pdf: 0,
    skipped_unavailable: 0,
    over_limit: 0,
  };
  const items: Array<PdfSelection["items"][number]> = [];
  for (const id of ids) {
    const row = byId.get(id)!;
    if (selector.kind === "query" && row.has_pdf) counts.skipped_has_pdf++;
    else if (selector.kind === "query" && row.unavailable)
      counts.skipped_unavailable++;
    else if (
      selector.kind === "query" &&
      selector.limit !== null &&
      items.length >= selector.limit
    )
      counts.over_limit++;
    else {
      items.push({
        literature_id: id as PdfSelection["items"][number]["literature_id"],
        version_role:
          row.version_role as PdfSelection["items"][number]["version_role"],
      });
      counts.process++;
    }
  }
  return { counts, items };
}
function selectionIds(
  db: DatabaseSync,
  request: PdfSelectionRequest,
): string[] {
  const selector = request.selector;
  return selector.kind === "query"
    ? libraryPageIds(db, {
        query: selector.query,
        sort: selector.sort,
        after: null,
        limit: Number.MAX_SAFE_INTEGER,
        ftsQuery: request.ftsQuery,
        fullRelevance: true,
      }).rows.map((row) => String(row.literature_id))
    : [...selector.literature_ids];
}

const CURRENT_PARSE_SQL =
  "EXISTS(SELECT 1 FROM raw_parse_current c WHERE c.source_asset_id=a.asset_id AND c.source_sha256=a.sha256 AND c.profile=? AND c.raw_parse_id IS NOT NULL)";

/** Count the same eligible primary PDFs without ordering or allocating task targets. */
export function parseDocumentCount(
  db: DatabaseSync,
  matching: { sql: string; parameters: readonly SQLInputValue[] },
  profile: string,
): number {
  return Number(
    db
      .prepare(
        `SELECT count(*) AS n FROM literature_assets la JOIN assets a ON a.asset_id=la.asset_id WHERE la.role='primary-pdf' AND la.literature_id IN (${matching.sql}) AND NOT ${CURRENT_PARSE_SQL}`,
      )
      .get(...matching.parameters, profile)!.n,
  );
}

export function parseDocumentSelection(
  db: DatabaseSync,
  request: PdfSelectionRequest,
  profile: string,
): import("../../literature/query.js").ParseDocumentSelection {
  const selector = request.selector,
    ids = selectionIds(db, request);
  const facts = db
    .prepare(
      `SELECT l.literature_id,l.version_role,a.asset_id AS asset_id,${CURRENT_PARSE_SQL} AS parsed FROM literatures l LEFT JOIN literature_assets la ON la.literature_id=l.literature_id AND la.role='primary-pdf' LEFT JOIN assets a ON a.asset_id=la.asset_id WHERE ${visibleLiteratureSql("l.literature_id")} AND l.literature_id IN (SELECT value FROM json_each(?))`,
    )
    .all(profile, JSON.stringify(ids));
  if (facts.length !== ids.length)
    throw Object.assign(new Error("literature not found"), {
      code: "literature-not-found",
    });
  const byId = new Map(facts.map((r) => [r.literature_id, r]));
  const counts = {
    matched: ids.length,
    process: 0,
    skipped_no_pdf: 0,
    skipped_parsed: 0,
    over_limit: 0,
  };
  const items: Array<PdfSelection["items"][number]> = [];
  for (const id of ids) {
    const row = byId.get(id)!;
    if (!row.asset_id) counts.skipped_no_pdf++;
    else if (row.parsed) counts.skipped_parsed++;
    else if (
      selector.kind === "query" &&
      selector.limit !== null &&
      items.length >= selector.limit
    )
      counts.over_limit++;
    else {
      items.push({
        literature_id: id as PdfSelection["items"][number]["literature_id"],
        version_role:
          row.version_role as PdfSelection["items"][number]["version_role"],
      });
      counts.process++;
    }
  }
  return { counts, items };
}
