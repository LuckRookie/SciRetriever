import { CURRENT_CATALOG_CONFIG } from "../storage/sqlite/catalog-layout.js";
import { RetrievalStorageEngine } from "../storage/sqlite/retrieval-engine.js";

export {
  type RetrievalEntry,
  type RetrievalGeneration,
  type RetrievalHit,
  type RetrievalSource,
} from "../storage/sqlite/retrieval-engine.js";
export { RETRIEVAL_SCORE_RULE, RetrievalStorageError } from "./model.js";

/** Synchronous adapter for offline maintenance and direct storage tests. */
export class RetrievalStorage extends RetrievalStorageEngine {
  constructor(path: string, readOnly: boolean) {
    super(path, readOnly, CURRENT_CATALOG_CONFIG);
  }
}
