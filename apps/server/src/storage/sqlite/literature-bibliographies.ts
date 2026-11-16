const { visibleLiteratureSql }: typeof import("./intake-visibility.js") =
  await import(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./intake-visibility.ts"
        : "./intake-visibility.js",
      import.meta.url,
    ).href
  );
import type { DatabaseSync } from "node:sqlite";
/** Storage adapter for LiteratureQueryService's public, bounded bibliography read. */
export function readLiteratureBibliographies(
  db: DatabaseSync,
  ids: readonly string[],
) {
  const own = !db.isTransaction;
  if (own) db.exec("BEGIN");
  try {
    const json = JSON.stringify(ids);
    const rows = db
      .prepare(
        `SELECT l.literature_id,m.title,m.publication_year AS year FROM literatures l JOIN literature_metadata m USING(literature_id) WHERE ${visibleLiteratureSql("l.literature_id")} AND l.literature_id IN (SELECT value FROM json_each(?)) ORDER BY l.literature_id`,
      )
      .all(json);
    const identifiers = db
      .prepare(
        "SELECT literature_id,namespace,value FROM literature_metadata_identifiers WHERE literature_id IN (SELECT value FROM json_each(?)) ORDER BY literature_id,ordinal",
      )
      .all(json);
    const grouped = new Map<string, { namespace: unknown; value: unknown }[]>();
    for (const row of identifiers) {
      const id = String(row.literature_id),
        items = grouped.get(id) ?? [];
      items.push({ namespace: row.namespace, value: row.value });
      grouped.set(id, items);
    }
    const result = rows.map((row) => ({
      ...row,
      identifiers: grouped.get(String(row.literature_id)) ?? [],
    }));
    if (own) db.exec("COMMIT");
    return result;
  } catch (error) {
    if (own && db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
