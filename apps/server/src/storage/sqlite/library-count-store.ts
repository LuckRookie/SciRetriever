import { LITERATURE_STATUSES } from "@sciretriever/contracts";
import type { DatabaseSync, StatementSync } from "node:sqlite";

const suffix = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const { LIBRARY_COUNT_COLUMNS: columns }: typeof import("./schema.js") =
  await import(new URL("./schema" + suffix, import.meta.url).href);
const {
  visibleLiteratureSql,
  visibleObjectSql,
}: typeof import("./intake-visibility.js") = await import(
  new URL("./intake-visibility" + suffix, import.meta.url).href
);

export type LibraryCountScope = "all" | "collected";
const scopes = ["all", "collected"] as const;
type CountColumns = Record<(typeof columns)[number], number>;
type Contribution = CountColumns & {
  meta_literature_id: string;
  scope: LibraryCountScope;
};
const selected = "status IS NOT NULL AND (scope='all' OR collected)";
const countInScope = (condition: string) => `sum(${selected} AND ${condition})`;

export const HAS_PRIMARY_PDF_SQL = `EXISTS(SELECT 1 FROM literature_assets pdf WHERE pdf.literature_id=l.literature_id AND pdf.role='primary-pdf' AND ${visibleObjectSql("literature-asset", "pdf.literature_asset_id")})`;
export const HAS_EXHAUSTION_SQL =
  "EXISTS(SELECT 1 FROM automatic_pdf_acquisition_exhaustions ex WHERE ex.literature_id=l.literature_id)";

// Paper outcomes use every visible sibling, including versions without
// metadata or outside the collected scope. Only the scope membership and
// version counts depend on which versions are selected.
const contributionsSql = `WITH facts AS MATERIALIZED (
  SELECT l.meta_literature_id,s.status,${HAS_PRIMARY_PDF_SQL} AS pdf,
    ${HAS_EXHAUSTION_SQL} AS exhausted,
    EXISTS(SELECT 1 FROM library_collected c WHERE c.literature_id=l.literature_id) AS collected
  FROM json_each(?) ids CROSS JOIN literatures l ON l.meta_literature_id=ids.value
  LEFT JOIN library_literature_states s USING(literature_id)
  WHERE ${visibleLiteratureSql("l.literature_id")}
)
SELECT meta_literature_id,scope,sum(${selected}) AS versions,
  ${countInScope("pdf")} AS with_primary_pdf,
  coalesce(${countInScope("status='UNREVIEWED' AND exhausted")},0) AS unavailable_pdf,
  ${LITERATURE_STATUSES.map((s) => `coalesce(${countInScope(`status='${s}'`)},0) AS ${s.toLowerCase()}`).join(",")},
  1 AS papers,max(pdf) AS obtained,(max(pdf)=0 AND min(exhausted)=1) AS exhausted
FROM facts CROSS JOIN (SELECT 'all' AS scope UNION ALL SELECT 'collected')
GROUP BY meta_literature_id,scope HAVING versions>0`;

export class LibraryCountStore {
  private readonly statements = new Map<string, StatementSync>();
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private statement(sql: string) {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  configure() {
    this.statement(
      "INSERT INTO library_count_progress(singleton,after_id,ready) SELECT 1,'',NOT EXISTS(SELECT 1 FROM literature_metadata) ON CONFLICT(singleton) DO NOTHING",
    ).run();
    for (const scope of scopes)
      this.statement(
        `INSERT INTO library_count_totals(scope,versions,with_primary_pdf,unavailable_pdf,unreviewed,asset_ready,archiving,archive_failed,ready,excluded,papers,obtained,exhausted) VALUES(?,${columns.map(() => "0")}) ON CONFLICT(scope) DO NOTHING`,
      ).run(scope);
  }

  get backfillPending() {
    return (
      this.statement(
        "SELECT ready FROM library_count_progress WHERE singleton=1",
      ).get()?.ready !== 1
    );
  }

  configured() {
    return !!this.statement(
      "SELECT 1 FROM library_count_progress WHERE singleton=1",
    ).get();
  }

  position(): number {
    return Number(
      this.statement(
        "SELECT coalesce(max(position),0) AS position FROM library_count_dirty",
      ).get()!.position,
    );
  }

  read(scope: LibraryCountScope) {
    const row = this.statement(
      "SELECT scope,versions,with_primary_pdf,unavailable_pdf,unreviewed,asset_ready,archiving,archive_failed,ready,excluded,papers,obtained,exhausted FROM library_count_totals WHERE scope=?",
    ).get(scope);
    if (!row) throw new Error("missing library count totals");
    return row as unknown as CountColumns;
  }

  /** Apply state changes and independently queued count facts once per paper. */
  update(literatures: readonly string[], after: number, limit: number) {
    const dirty = this.statement(
      "SELECT position,meta_literature_id FROM library_count_dirty WHERE position>? ORDER BY position LIMIT ?",
    ).all(after, limit);
    const metaIds = new Set(dirty.map((r) => String(r.meta_literature_id)));
    if (literatures.length) {
      const owners = this.statement(
        "SELECT DISTINCT l.meta_literature_id FROM json_each(?) ids CROSS JOIN literatures l ON l.literature_id=ids.value",
      ).all(JSON.stringify(literatures));
      for (const row of owners) metaIds.add(String(row.meta_literature_id));
    }
    if (metaIds.size) this.replace([...metaIds]);
    if (dirty.length)
      this.statement(
        "DELETE FROM library_count_dirty WHERE position IN (SELECT value FROM json_each(?))",
      ).run(JSON.stringify(dirty.map((r) => r.position)));
    return dirty.length;
  }

  backfill(limit: number) {
    const progress = this.statement(
      "SELECT after_id,ready FROM library_count_progress WHERE singleton=1",
    ).get()!;
    if (progress.ready === 1) return 0;
    const ids = this.statement(
      "SELECT meta_literature_id FROM meta_literatures WHERE meta_literature_id>? ORDER BY meta_literature_id LIMIT ?",
    )
      .all(progress.after_id!, limit)
      .map((r) => String(r.meta_literature_id));
    if (ids.length) this.replace(ids);
    this.statement(
      "UPDATE library_count_progress SET after_id=?,ready=? WHERE singleton=1",
    ).run(ids.at(-1) ?? progress.after_id!, Number(ids.length < limit));
    return ids.length;
  }

  private replace(ids: readonly string[]) {
    const input = JSON.stringify(ids);
    const previous = this.statement(
      "SELECT c.meta_literature_id,c.scope,c.versions,c.with_primary_pdf,c.unavailable_pdf,c.unreviewed,c.asset_ready,c.archiving,c.archive_failed,c.ready,c.excluded,c.papers,c.obtained,c.exhausted FROM json_each(?) ids CROSS JOIN library_count_contributions c ON c.meta_literature_id=ids.value",
    ).all(input) as unknown as Contribution[];
    const updated = this.statement(contributionsSql).all(
      input,
    ) as unknown as Contribution[];
    const upsert = this.statement(
      `INSERT INTO library_count_contributions(meta_literature_id,scope,versions,with_primary_pdf,unavailable_pdf,unreviewed,asset_ready,archiving,archive_failed,ready,excluded,papers,obtained,exhausted) VALUES(?,?,${columns.map(() => "?")})
      ON CONFLICT(meta_literature_id,scope) DO UPDATE SET ${columns.map((c) => `${c}=excluded.${c}`)}`,
    );
    const remove = this.statement(
      "DELETE FROM library_count_contributions WHERE meta_literature_id=? AND scope=?",
    );
    const increment = this.statement(
      `UPDATE library_count_totals SET ${columns.map((c) => `${c}=${c}+?`)} WHERE scope=?`,
    );
    for (const scope of scopes) {
      const remaining = new Map(
        previous
          .filter((r) => r.scope === scope)
          .map((r) => [r.meta_literature_id, r]),
      );
      const delta = columns.map(() => 0);
      for (const row of updated) {
        if (row.scope !== scope) continue;
        const old = remaining.get(row.meta_literature_id);
        remaining.delete(row.meta_literature_id);
        if (old && columns.every((c) => row[c] === old[c])) continue;
        columns.forEach((c, i) => {
          delta[i]! += row[c] - (old?.[c] ?? 0);
        });
        upsert.run(
          row.meta_literature_id,
          scope,
          ...columns.map((c) => row[c]),
        );
      }
      for (const [id, old] of remaining) {
        columns.forEach((c, i) => {
          delta[i]! -= old[c];
        });
        remove.run(id, scope);
      }
      if (delta.some((value) => value !== 0)) increment.run(...delta, scope);
    }
  }
}
