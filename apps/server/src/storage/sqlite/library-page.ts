import type * as Tags from "./tag-engine.js";
const { resolveLibraryTagIds, tagBackfillPending }: typeof Tags = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./tag-engine.ts" : "./tag-engine.js",
    import.meta.url,
  ).href
);
import { LITERATURE_STATUSES } from "@sciretriever/contracts";
import type { LibraryQuery } from "@sciretriever/contracts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { LibraryPageQuery } from "../../literature/query.js";

export const OPENED_SQL =
  "(SELECT last_opened_at FROM reading_history h WHERE h.literature_id=l.literature_id)";
const RECENT_SQL = `${OPENED_SQL} >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')`;
/** Earliest known observation, not publication date or the last metadata refresh. */
export const INTAKE_SQL =
  "(SELECT intake_at FROM literature_intake WHERE literature_id=l.literature_id)";
export function intakeAt(db: DatabaseSync, id: string): string | null {
  return (db
    .prepare(
      `SELECT ${INTAKE_SQL} AS intake_at FROM literatures l WHERE l.literature_id=?`,
    )
    .get(id)?.intake_at ?? null) as string | null;
}

/** SQL read projection of LibraryQuery; full domain rows are read only for this page. */
function libraryFilter(
  db: DatabaseSync,
  q: LibraryQuery,
  ftsQuery: string | null,
  intakeOrder = false,
) {
  const terms: string[] = ["sr_query_continue()"],
    args: SQLInputValue[] = [];
  const add = (sql: string, ...values: SQLInputValue[]) => {
    terms.push(sql);
    args.push(...values);
  };
  const any = (field: string, values: readonly string[]) => {
    if (values.length)
      add(
        `${field} IN (SELECT value FROM json_each(?))`,
        JSON.stringify(values),
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
  if (q.intake_batch_ids?.length)
    add(
      "EXISTS(SELECT 1 FROM intake_batch_members b WHERE b.literature_id=l.literature_id AND b.batch_id IN (SELECT value FROM json_each(?)))",
      JSON.stringify(q.intake_batch_ids),
    );
  any("sr_status(l.literature_id)", q.statuses);
  any("sr_missing(l.literature_id)", q.missing_steps);
  const exhaustion =
    "EXISTS(SELECT 1 FROM automatic_pdf_acquisition_exhaustions ex WHERE ex.literature_id=l.literature_id)";
  if (q.needs_manual_pdf === true)
    add(`(${exhaustion} AND sr_status(l.literature_id)='UNREVIEWED')`);
  if (q.needs_manual_pdf === false) add(`NOT ${exhaustion}`);
  if (q.discovery_run_ids.length) {
    const ids = JSON.stringify(q.discovery_run_ids);
    add(
      "l.literature_id IN (SELECT actual_literature_id FROM topic_discovery_causes WHERE discovery_run_id IN (SELECT value FROM json_each(?)) UNION SELECT actual_literature_id FROM citation_discovery_causes WHERE discovery_run_id IN (SELECT value FROM json_each(?)))",
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
  if (q.folder) {
    const ids = q.folder.include_descendants
      ? "WITH RECURSIVE descendants(id) AS (SELECT folder_id FROM folders WHERE folder_id=? UNION SELECT f.folder_id FROM folders f JOIN descendants d ON f.parent_id=d.id) SELECT id FROM descendants"
      : "SELECT folder_id FROM folders WHERE folder_id=?";
    add(
      `EXISTS(SELECT 1 FROM folder_members fm WHERE fm.literature_id=l.literature_id AND fm.folder_id IN (${ids}))`,
      q.folder.id,
    );
  }
  if (q.recently_opened) add(RECENT_SQL);
  if (ftsQuery !== null) add("literature_search_fts MATCH ?", ftsQuery);
  const base = intakeOrder
    ? "literature_intake li INDEXED BY literature_intake_order CROSS JOIN literatures l ON l.literature_id=li.literature_id"
    : "literatures l";
  const from = `FROM ${base} JOIN literature_metadata m ON m.literature_id=l.literature_id${ftsQuery === null ? "" : " JOIN literature_search_fts ON literature_search_fts.literature_id=l.literature_id"}`;
  let where = terms.length ? `WHERE ${terms.join(" AND ")}` : "";
  if (q.recently_opened)
    where = `WHERE l.literature_id IN (SELECT l.literature_id ${from} ${where} ORDER BY ${OPENED_SQL} DESC,l.literature_id LIMIT 100)`;
  // An outer FTS join still needs a MATCH term for bm25 and must use the same query.
  if (q.recently_opened && ftsQuery !== null) {
    where += " AND literature_search_fts MATCH ?";
    args.push(ftsQuery);
  }
  return { from, where, args, tagIds };
}
export function libraryCounts(
  db: DatabaseSync,
  query: LibraryQuery,
  ftsQuery: string | null,
) {
  // Quick-filter counts ignore both quick selections, but retain all other facets.
  const { from, where, args } = libraryFilter(
    db,
    { ...query, statuses: [], needs_manual_pdf: null },
    ftsQuery,
  );
  // Status is a per-row function; materialize it so each row computes it once.
  const rows = db
    .prepare(
      `WITH s AS MATERIALIZED (SELECT sr_status(l.literature_id) AS status, EXISTS(SELECT 1 FROM automatic_pdf_acquisition_exhaustions ex WHERE ex.literature_id=l.literature_id) AS exhausted ${from} ${where}) SELECT status, count(*) AS count, sum(status='UNREVIEWED' AND exhausted) AS unavailable FROM s GROUP BY status`,
    )
    .all(...args);
  const statuses = Object.fromEntries(LITERATURE_STATUSES.map((s) => [s, 0]));
  let total = 0,
    unavailable_pdf = 0;
  for (const row of rows) {
    if (!Object.hasOwn(statuses, String(row.status)))
      throw new Error("invalid library status");
    statuses[String(row.status)] = Number(row.count);
    total += Number(row.count);
    unavailable_pdf += Number(row.unavailable);
  }
  const recent = db
    .prepare(
      `SELECT count(*) AS n ${from} ${where ? where + " AND " : "WHERE "} ${RECENT_SQL}`,
    )
    .get(...args)!;
  return {
    total,
    statuses,
    unavailable_pdf,
    recently_opened: Math.min(100, Number(recent.n)),
  };
}
export function libraryPageIds(db: DatabaseSync, request: LibraryPageQuery) {
  const { query: q, sort, after, limit, ftsQuery } = request;
  const { from, where, args, tagIds } = libraryFilter(
    db,
    q,
    ftsQuery,
    sort === "intake-desc" && ftsQuery === null,
  );
  const counts = db
    .prepare(
      `SELECT count(*) AS total, count(DISTINCT l.literature_id) AS unique_count ${from} ${where}`,
    )
    .get(...args)!;
  if (counts.total !== counts.unique_count)
    throw new Error("duplicate library search rows");
  const relevance = ftsQuery === null ? "NULL" : "bm25(literature_search_fts)";
  const value =
    sort === "opened-desc"
      ? OPENED_SQL
      : sort === "intake-desc"
        ? INTAKE_SQL
        : sort.startsWith("title")
          ? "sr_normalize(m.title)"
          : sort.startsWith("publication-year")
            ? "m.publication_year"
            : relevance;
  if (sort === "intake-desc" && ftsQuery === null) {
    const pageArgs = [...args];
    let cursor = "";
    if (after) {
      cursor =
        after.value === null
          ? " AND li.intake_at IS NULL AND l.literature_id > ?"
          : " AND (li.intake_at IS NULL OR li.intake_at < ? OR (li.intake_at = ? AND l.literature_id > ?))";
      pageArgs.push(
        ...(after.value === null
          ? [after.literature_id]
          : [after.value, after.value, after.literature_id]),
      );
    }
    const rows = db
      .prepare(
        `SELECT l.literature_id,${relevance} AS relevance ${from} ${where} ${cursor} ORDER BY li.intake_at DESC,li.literature_id ASC LIMIT ?`,
      )
      .all(...pageArgs, limit + 1);
    return {
      rows,
      total_count: Number(counts.total),
      ...(tagIds.length
        ? { tag_backfill_pending: tagBackfillPending(db, tagIds, q.tags!.mode) }
        : {}),
    };
  }
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
    rows,
    total_count: Number(counts.total),
    ...(tagIds.length
      ? { tag_backfill_pending: tagBackfillPending(db, tagIds, q.tags!.mode) }
      : {}),
  };
}

export function libraryFacets(
  db: DatabaseSync,
  query: LibraryQuery,
  ftsQuery: string | null,
  limit: number,
) {
  const unfiltered =
    ftsQuery === null &&
    !query.folder &&
    !query.recently_opened &&
    !query.tags?.ids.length &&
    Object.entries(query).every(
      ([key, value]) =>
        ["folder", "recently_opened", "tags"].includes(key) ||
        value === null ||
        value === undefined ||
        (Array.isArray(value) && value.length === 0),
    );
  const wholeCount = () =>
    Number(
      db.prepare("SELECT count(*) AS n FROM literature_metadata").get()!.n,
    );
  const aggregateWhole = (total: number) => {
    const keywords = db
      .prepare(
        "SELECT min(keyword) AS value,count(DISTINCT literature_id) AS count FROM literature_metadata_keywords GROUP BY sr_normalize(keyword) ORDER BY count DESC,value COLLATE BINARY ASC LIMIT ?",
      )
      .all(limit) as { value: string; count: number }[];
    // A normalized subject term is unique within one paper. Its covering
    // index permits a single ordered aggregate without materializing all IDs.
    const subject_terms = db
      .prepare(
        "SELECT min(term) AS value,count(*) AS count FROM literature_metadata_subject_terms INDEXED BY literature_subject_terms_normalized GROUP BY normalized_term ORDER BY count DESC,value COLLATE BINARY ASC LIMIT ?",
      )
      .all(limit) as { value: string; count: number }[];
    return { total, keywords, subject_terms };
  };
  if (unfiltered) return aggregateWhole(wholeCount());
  const { from, where, args } = libraryFilter(db, query, ftsQuery);
  const match = `SELECT l.literature_id ${from} ${where}`;
  const total = Number(
    db.prepare(`SELECT count(*) AS n FROM (${match})`).get(...args)!.n,
  );
  if (total === wholeCount()) return aggregateWhole(total);
  const aggregate = (table: string, value: string, normalized: string) =>
    db
      .prepare(
        `WITH matches AS MATERIALIZED (${match}) SELECT min(t.${value}) AS value,count(DISTINCT t.literature_id) AS count FROM ${table} t JOIN matches m ON m.literature_id=t.literature_id GROUP BY ${normalized} ORDER BY count DESC,value COLLATE BINARY ASC LIMIT ?`,
      )
      .all(...args, limit) as { value: string; count: number }[];
  return {
    total,
    keywords: aggregate(
      "literature_metadata_keywords",
      "keyword",
      "sr_normalize(t.keyword)",
    ),
    subject_terms: aggregate(
      "literature_metadata_subject_terms",
      "term",
      "t.normalized_term",
    ),
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
  const ids =
    selector.kind === "query"
      ? libraryPageIds(db, {
          query: selector.query,
          sort: selector.sort,
          after: null,
          limit: Number.MAX_SAFE_INTEGER,
          ftsQuery: request.ftsQuery,
        }).rows.map((row) => String(row.literature_id))
      : [...selector.literature_ids];
  const facts = db
    .prepare(
      "SELECT l.literature_id,l.version_role,EXISTS(SELECT 1 FROM literature_assets a WHERE a.literature_id=l.literature_id AND a.role='primary-pdf') AS has_pdf,EXISTS(SELECT 1 FROM automatic_pdf_acquisition_exhaustions ex WHERE ex.literature_id=l.literature_id) AND sr_status(l.literature_id)='UNREVIEWED' AS unavailable FROM literatures l WHERE l.literature_id IN (SELECT value FROM json_each(?))",
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
    if (row.has_pdf) counts.skipped_has_pdf++;
    else if (row.unavailable) counts.skipped_unavailable++;
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
