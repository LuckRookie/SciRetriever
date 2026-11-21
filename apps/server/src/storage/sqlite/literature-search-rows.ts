import type { DatabaseSync } from "node:sqlite";

export const INSERT_LITERATURE_SEARCH_ROW =
  "INSERT INTO literature_search_fts(literature_id,title,abstract,authors,affiliations,identifiers,keywords,venue,publisher,volume,issue,pages,content_body) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)";

export function literatureSearchRowIds(db: DatabaseSync, literatureId: string) {
  const statement = db.prepare(
    "SELECT id FROM literature_search_fts_content WHERE c0=? ORDER BY id",
  );
  statement.setReadBigInts(true);
  return statement.all(literatureId).map((row) => row.id as bigint);
}

export function deleteLiteratureSearchRows(
  db: DatabaseSync,
  rowIds: readonly bigint[],
): void {
  if (!rowIds.length) return;
  const statement = db.prepare(
    "DELETE FROM literature_search_fts WHERE rowid=?",
  );
  for (const rowId of rowIds) statement.run(rowId);
}
