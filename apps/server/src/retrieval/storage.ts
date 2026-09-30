import {
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_SCHEMA_VERSION,
} from "../storage/sqlite/execution-schema.js";
import {
  SCHEMA_V4_FINGERPRINT,
  SCHEMA_V4_MANIFEST,
} from "../storage/sqlite/schema-v4.js";
import { RetrievalStorageEngine } from "../storage/sqlite/retrieval-engine.js";

export {
  type RetrievalEntry,
  type RetrievalGeneration,
  type RetrievalHit,
  type RetrievalSource,
  type KnowledgeRetrievalEntry,
  type KnowledgeRetrievalGeneration,
  type KnowledgeRetrievalHit,
} from "../storage/sqlite/retrieval-engine.js";
export { RETRIEVAL_SCORE_RULE, RetrievalStorageError } from "./model.js";

const schema = {
  schema_fingerprint: SCHEMA_V4_FINGERPRINT,
  schema_manifest: SCHEMA_V4_MANIFEST,
  execution_schema_version: EXECUTION_SCHEMA_VERSION,
  execution_schema_fingerprint: EXECUTION_SCHEMA_FINGERPRINT,
  execution_runtime_schema_version: EXECUTION_RUNTIME_SCHEMA_VERSION,
  execution_runtime_schema_fingerprint: EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
} as const;

/** Synchronous adapter for offline maintenance and direct storage tests. */
export class RetrievalStorage extends RetrievalStorageEngine {
  constructor(path: string, readOnly: boolean) {
    super(path, readOnly, schema);
  }
}
