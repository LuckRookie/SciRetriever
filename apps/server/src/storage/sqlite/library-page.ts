import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { LibraryPageQuery } from "../../literature/query.js";

/** SQL read projection of LibraryQuery; full domain rows are read only for this page. */
export function libraryPageIds(db: DatabaseSync, request: LibraryPageQuery) {
  const { query: q, sort, after, limit, ftsQuery } = request;
  const terms: string[] = [],
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
  any("m.document_type", q.document_types);
  any("m.language", q.languages);
  any("l.version_role", q.version_roles);
  for (const keyword of q.keywords)
    add(
      "EXISTS(SELECT 1 FROM literature_metadata_keywords k WHERE k.literature_id=l.literature_id AND k.keyword=?)",
      keyword,
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
  if (ftsQuery !== null) add("literature_search_fts MATCH ?", ftsQuery);
  const from = `FROM literatures l JOIN literature_metadata m ON m.literature_id=l.literature_id${ftsQuery === null ? "" : " JOIN literature_search_fts ON literature_search_fts.literature_id=l.literature_id"}`;
  const where = terms.length ? `WHERE ${terms.join(" AND ")}` : "";
  const counts = db
    .prepare(
      `SELECT count(*) AS total, count(DISTINCT l.literature_id) AS unique_count ${from} ${where}`,
    )
    .get(...args)!;
  if (counts.total !== counts.unique_count)
    throw new Error("duplicate library search rows");
  const relevance = ftsQuery === null ? "NULL" : "bm25(literature_search_fts)";
  const value = sort.startsWith("title")
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
  // Materialization keeps bm25 in its FTS context and computes each title key once.
  const rows = db
    .prepare(
      `WITH matches AS MATERIALIZED (SELECT l.literature_id, ${value} AS sort_value, ${relevance} AS relevance ${from} ${where}) SELECT literature_id,relevance FROM matches ${cursor} ORDER BY sort_value IS NULL, sort_value ${sort.endsWith("desc") ? "DESC" : "ASC"}, literature_id ASC LIMIT ?`,
    )
    .all(...pageArgs, limit + 1);
  return { rows, total_count: Number(counts.total) };
}
