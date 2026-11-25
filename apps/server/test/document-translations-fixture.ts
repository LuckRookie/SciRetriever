import type { DatabaseSync } from "node:sqlite";
import {
  CATALOG_BASE_SCHEMA,
  DOCUMENT_TRANSLATIONS_ADDITION,
} from "../src/storage/sqlite/schema.js";

/**
 * Turn a current catalog back into the layout before the
 * `document-translations` addition: archive_steps with its old step check
 * (rows of the new step left out), no translation table, no registration.
 */
export function withoutDocumentTranslations(db: DatabaseSync) {
  const base = CATALOG_BASE_SCHEMA.find((sql) =>
    sql.startsWith("CREATE TABLE archive_steps("),
  )!;
  const dependents = db
    .prepare(
      "SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='archive_steps' AND type IN ('index','trigger') AND sql IS NOT NULL",
    )
    .all() as { type: string; name: string; sql: string }[];
  for (const object of dependents)
    db.exec(`DROP ${object.type.toUpperCase()} ${object.name}`);
  db.exec(
    "CREATE TEMP TABLE older_steps AS SELECT * FROM archive_steps WHERE step<>'translate'",
  );
  db.exec("DROP TABLE archive_steps");
  db.exec(base);
  db.exec("INSERT INTO archive_steps SELECT * FROM temp.older_steps");
  db.exec("DROP TABLE temp.older_steps");
  for (const object of dependents) db.exec(object.sql);
  db.exec("DROP TABLE document_translations");
  db.prepare("DELETE FROM catalog_schema_additions WHERE name=?").run(
    DOCUMENT_TRANSLATIONS_ADDITION.name,
  );
}
