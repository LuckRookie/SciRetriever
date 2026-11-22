const {
  visibleLiteratureSql,
  visibleObjectSql,
}: typeof import("./intake-visibility.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./intake-visibility.ts"
      : "./intake-visibility.js",
    import.meta.url,
  ).href
);
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { parseFullTextCounts } from "@sciretriever/contracts";

/** Compose with other scope aggregates without scanning the same members again. */
export function fullTextCountsProjection(
  matchingSql: string,
  totalSql = "(SELECT count(*) FROM selected)",
  cancellable = false,
) {
  // Empty fact sets prove zero immediately; otherwise check all sibling versions.
  // The proof and the counts belong to this read snapshot, never to a cache.
  const checkpoint = cancellable ? "sr_query_continue() AND " : "";
  return {
    cte: `selected AS MATERIALIZED (
      SELECT DISTINCT l.meta_literature_id FROM (${matchingSql}) matching
      JOIN literatures l USING(literature_id) WHERE ${checkpoint}${visibleLiteratureSql("l.literature_id")}
    )`,
    columns: `${totalSql} AS total,
      CASE WHEN EXISTS(SELECT 1 FROM literature_assets WHERE role='primary-pdf') THEN
        (SELECT count(*) FROM selected s WHERE ${checkpoint}EXISTS(
          SELECT 1 FROM literatures l JOIN literature_assets a USING(literature_id)
          WHERE ${visibleLiteratureSql("l.literature_id")} AND ${visibleObjectSql("literature-asset", "a.literature_asset_id")} AND l.meta_literature_id=s.meta_literature_id AND a.role='primary-pdf'))
        ELSE 0 END AS obtained,
      CASE WHEN EXISTS(SELECT 1 FROM automatic_pdf_acquisition_exhaustions) THEN
        (SELECT count(*) FROM selected s WHERE ${checkpoint}
          NOT EXISTS(SELECT 1 FROM literatures l JOIN literature_assets a USING(literature_id)
            WHERE ${visibleLiteratureSql("l.literature_id")} AND ${visibleObjectSql("literature-asset", "a.literature_asset_id")} AND l.meta_literature_id=s.meta_literature_id AND a.role='primary-pdf')
          AND NOT EXISTS(SELECT 1 FROM literatures l WHERE ${visibleLiteratureSql("l.literature_id")} AND l.meta_literature_id=s.meta_literature_id
            AND NOT EXISTS(SELECT 1 FROM automatic_pdf_acquisition_exhaustions e WHERE e.literature_id=l.literature_id)))
        ELSE 0 END AS exhausted`,
  };
}

export function fullTextCountsFromRow(
  counts: Readonly<Record<string, SQLOutputValue | undefined>>,
) {
  return parseFullTextCounts({
    total: counts.total,
    obtained: counts.obtained,
    exhausted: counts.exhausted,
    missing: Number(counts.total) - Number(counts.obtained),
  });
}

/** The scope names matching Literature IDs. All current sibling versions decide each paper's outcome. */
export function fullTextCounts(
  db: DatabaseSync,
  matching: { sql: string; parameters: readonly SQLInputValue[] },
) {
  const projection = fullTextCountsProjection(matching.sql);
  return fullTextCountsFromRow(
    db
      .prepare(`WITH ${projection.cte} SELECT ${projection.columns}`)
      .get(...matching.parameters)!,
  );
}
