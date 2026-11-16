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
import type { DatabaseSync } from "node:sqlite";
import {
  parseDraftFacts,
  type DraftFacts,
  type LiteratureDefaultText,
} from "@sciretriever/contracts";

/** All result lookups start at a fixed document version, never at all results. */
export function draftFactSql(
  field: keyof DraftFacts,
  version = "df.document_version_id",
): string {
  if (field === "citing_results")
    return `(SELECT count(DISTINCT rd.result_id) FROM processor_result_documents rd INDEXED BY processor_result_documents_version JOIN processor_result_freshness f ON f.result_id=rd.result_id AND f.state='current' WHERE rd.document_version_id=${version})`;
  if (field === "unfound_citations")
    return `(SELECT count(*) FROM processor_unfound_citations uc INDEXED BY processor_unfound_citations_version JOIN processor_result_freshness f ON f.result_id=uc.result_id AND f.state='current' WHERE uc.document_version_id=${version})`;
  return `df.${field}`;
}
export const PRIMARY_DEFAULT_VERSION_SQL = `(SELECT d.document_version_id FROM literature_assets pla JOIN assets pa ON pa.asset_id=pla.asset_id JOIN (document_defaults dd JOIN document_versions d ON d.document_version_id=dd.document_version_id) ON d.literature_id=pla.literature_id AND d.source_asset_id=pa.asset_id AND d.source_sha256=pa.sha256 WHERE pla.literature_id=l.literature_id AND pla.role='primary-pdf' AND pa.media_type='application/pdf')`;
export const PRIMARY_TEXT_LEVEL_SQL = `(SELECT CASE schema_version WHEN 3 THEN 'draft' WHEN 2 THEN 'proofread' END FROM document_versions WHERE document_version_id=${PRIMARY_DEFAULT_VERSION_SQL})`;
export function primaryDraftFactSql(field: keyof DraftFacts): string {
  return `(SELECT ${draftFactSql(field)} FROM draft_version_facts df WHERE df.document_version_id=${PRIMARY_DEFAULT_VERSION_SQL})`;
}
export interface DefaultTextFactsRow {
  readonly literature_id: string;
  readonly asset_id: string;
  readonly part: "main" | "supplementary";
  readonly default_text: LiteratureDefaultText | null;
}
/** One catalog-only snapshot supplies every requested PDF part. */
export function readDefaultTextFacts(
  db: DatabaseSync,
  ids?: readonly string[],
): readonly DefaultTextFactsRow[] {
  const where = [
    visibleLiteratureSql("la.literature_id"),
    visibleObjectSql("literature-asset", "la.literature_asset_id"),
    "a.media_type='application/pdf'",
    "la.role IN ('primary-pdf','supplementary-pdf')",
  ];
  if (ids) where.push("la.literature_id IN (SELECT value FROM json_each(?))");
  const rows = db
    .prepare(
      `SELECT la.literature_id,a.asset_id,CASE la.role WHEN 'primary-pdf' THEN 'main' ELSE 'supplementary' END AS part,
    d.document_version_id AS document_version_id,d.schema_version AS schema_version,df.differs_segments,df.differences,df.image_only_pages,
    CASE WHEN d.schema_version=3 THEN ${draftFactSql("citing_results")} END AS citing_results,
    CASE WHEN d.schema_version=3 THEN ${draftFactSql("unfound_citations")} END AS unfound_citations
    FROM literature_assets la JOIN assets a ON a.asset_id=la.asset_id
    LEFT JOIN (document_defaults dd JOIN document_versions d ON d.document_version_id=dd.document_version_id)
      ON d.literature_id=la.literature_id AND d.source_asset_id=a.asset_id AND d.source_sha256=a.sha256
    LEFT JOIN draft_version_facts df ON df.document_version_id=d.document_version_id AND d.schema_version=3
    WHERE ${where.join(" AND ")} ORDER BY la.literature_id,part,a.asset_id`,
    )
    .all(...(ids ? [JSON.stringify(ids)] : []));
  return rows.map((r) => ({
    literature_id: String(r.literature_id),
    asset_id: String(r.asset_id),
    part: r.part as DefaultTextFactsRow["part"],
    default_text:
      r.document_version_id === null
        ? null
        : {
            document_version_id: String(r.document_version_id),
            text_level: r.schema_version === 3 ? "draft" : "proofread",
            draft_facts:
              r.schema_version === 3
                ? parseDraftFacts({
                    differs_segments: r.differs_segments,
                    differences: r.differences,
                    image_only_pages: r.image_only_pages,
                    citing_results: r.citing_results,
                    unfound_citations: r.unfound_citations,
                  })
                : null,
          },
  }));
}
/** Only result facts lack existing readiness triggers; immutable draft counts
 * and default changes already have revision hints. Keep this projection separate
 * from public fact validation so internal readiness does not require the counts. */
export function readResultFactStamps(db: DatabaseSync): Map<string, string> {
  const grouped = new Map<string, unknown[]>();
  for (const row of db
    .prepare(
      `SELECT la.literature_id,a.asset_id,d.document_version_id AS document_version_id,
    ${draftFactSql("citing_results", "d.document_version_id")} AS citing_results,
    ${draftFactSql("unfound_citations", "d.document_version_id")} AS unfound_citations
    FROM literature_assets la JOIN assets a ON a.asset_id=la.asset_id
    JOIN document_versions d ON d.literature_id=la.literature_id AND d.source_asset_id=a.asset_id AND d.source_sha256=a.sha256
    JOIN document_defaults dd ON dd.document_version_id=d.document_version_id
    WHERE d.schema_version=3 AND a.media_type='application/pdf' AND la.role IN ('primary-pdf','supplementary-pdf')
    ORDER BY la.literature_id,a.asset_id`,
    )
    .all()) {
    const id = String(row.literature_id),
      values = grouped.get(id) ?? [];
    values.push([
      row.asset_id,
      row.document_version_id,
      row.citing_results,
      row.unfound_citations,
    ]);
    grouped.set(id, values);
  }
  return new Map(
    [...grouped].map(([id, values]) => [id, JSON.stringify(values)]),
  );
}
export function primaryDefaultTexts(rows: readonly DefaultTextFactsRow[]) {
  return new Map(
    rows
      .filter((r) => r.part === "main")
      .map((r) => [r.literature_id, r.default_text]),
  );
}
