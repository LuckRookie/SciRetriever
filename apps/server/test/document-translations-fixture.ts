import type { DatabaseSync } from "node:sqlite";
import {
  CATALOG_BASE_SCHEMA,
  DOCUMENT_TRANSLATIONS_ADDITION,
} from "../src/storage/sqlite/schema.js";
import { withoutDocumentLayers } from "./document-layers-fixture.js";

/**
 * Turn a current catalog back into the layout before the
 * `document-translations` addition: archive_steps with its old step check
 * (rows of the new step left out), no translation table, no registration.
 */
export function withoutDocumentTranslations(db: DatabaseSync) {
  // The later addition goes first.
  withoutDocumentLayers(db);
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
    "CREATE TEMP TABLE older_steps AS SELECT * FROM archive_steps WHERE step NOT IN ('translate','layers')",
  );
  db.exec("DROP TABLE archive_steps");
  db.exec(base);
  db.exec("INSERT INTO archive_steps SELECT * FROM temp.older_steps");
  db.exec("DROP TABLE temp.older_steps");
  for (const object of dependents) db.exec(object.sql);
  for (const trigger of db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='trigger' AND (name GLOB 'retrieval_change_document_translations_*' OR name GLOB 'retrieval_change_structure_annotation_current_*')",
    )
    .all())
    db.exec(`DROP TRIGGER ${String(trigger.name)}`);
  // Dropping the added columns restores the earlier CREATE text exactly.
  for (const [table, column] of [
    ["retrieval_entries", "translation_sha256"],
    ["retrieval_entries", "translation_language"],
    ["retrieval_generations", "translation_language"],
    ["retrieval_generations", "text_rule"],
    ["retrieval_change_state", "library_search_rule"],
  ])
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.exec("DROP TABLE document_translations");
  db.prepare("DELETE FROM catalog_schema_additions WHERE name=?").run(
    DOCUMENT_TRANSLATIONS_ADDITION.name,
  );
}
