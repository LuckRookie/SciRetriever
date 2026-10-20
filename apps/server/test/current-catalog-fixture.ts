import { DatabaseSync } from "node:sqlite";
import { CURRENT_CATALOG_CONFIG } from "../src/storage/sqlite/catalog-layout.js";
import {
  inspectCatalogWithRetrieval,
  prepareRetrievalVocab,
} from "../src/storage/sqlite/retrieval-engine.js";
/** Reads the current catalog and derived material projection without changing source facts. */
export async function inspectFixtureRetrieval(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    prepareRetrievalVocab(db);
    return inspectCatalogWithRetrieval(db, CURRENT_CATALOG_CONFIG);
  } finally {
    db.close();
  }
}
