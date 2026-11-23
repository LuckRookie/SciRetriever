import type { DatabaseSync } from "node:sqlite";

/** Snapshot manifest tables, retaining virtual rowids and excluding FTS shadow tables. */
export function catalogRows(db: DatabaseSync, manifest: readonly string[]) {
  const withoutRowid = new Set(
    db
      .prepare(
        "SELECT name FROM pragma_table_list WHERE schema='main' AND wr=1",
      )
      .all()
      .map(({ name }) => name),
  );
  const primaryKey = db.prepare(
    "SELECT name FROM pragma_table_info(?) WHERE pk>0 ORDER BY pk",
  );
  return Object.fromEntries(
    manifest.flatMap((sql) => {
      const table = /^CREATE (?:VIRTUAL )?TABLE ([a-z_][a-z0-9_]*)/u.exec(
        sql,
      )?.[1];
      if (!table) return [];
      const columns = sql.startsWith("CREATE VIRTUAL TABLE ") ? "rowid,*" : "*";
      const order = withoutRowid.has(table)
        ? primaryKey
            .all(table)
            .map(({ name }) => '"' + String(name).replaceAll('"', '""') + '"')
            .join(",")
        : "rowid";
      return [
        [
          table,
          db.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${order}`).all(),
        ],
      ];
    }),
  );
}
