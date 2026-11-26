import type { DatabaseSync } from "node:sqlite";
import { DOCUMENT_LAYERS_ADDITION } from "../src/storage/sqlite/schema.js";

/**
 * Turn a current catalog back into the layout before the `document-layers`
 * addition: no layers table, no registration. Rows of the `layers` step stay;
 * archive_steps checks only the form of a step name.
 */
export function withoutDocumentLayers(db: DatabaseSync) {
  db.exec("DROP TABLE IF EXISTS document_layers");
  db.prepare("DELETE FROM catalog_schema_additions WHERE name=?").run(
    DOCUMENT_LAYERS_ADDITION.name,
  );
}
