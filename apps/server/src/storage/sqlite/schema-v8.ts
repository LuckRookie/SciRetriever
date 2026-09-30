import { createHash } from "node:crypto";
import { SCHEMA_V7_MANIFEST } from "./schema-v7.js";

export const SCHEMA_V8_VERSION = 8 as const;
export const SCHEMA_IDENTITY_V8 = SCHEMA_V7_MANIFEST[0]!.replace(
  "schema_version=7",
  "schema_version=8",
);

const sources = [
  "knowledge_artifacts",
  "knowledge_input_materials",
  "knowledge_input_documents",
  "knowledge_input_artifacts",
  "knowledge_defaults",
  "literatures",
  "assets",
  "literature_assets",
  "document_versions",
  "document_defaults",
] as const;
const triggers = sources.flatMap((source) =>
  (["INSERT", "UPDATE", "DELETE"] as const).map(
    (event) =>
      `CREATE TRIGGER knowledge_retrieval_revision_${source}_${event.toLowerCase()} AFTER ${event} ON ${source} BEGIN UPDATE knowledge_retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END`,
  ),
);

/** A disposable projection. No knowledge bytes or evidence authority lives here. */
export const KNOWLEDGE_RETRIEVAL_SCHEMA = [
  "CREATE TABLE knowledge_retrieval_source_revision(singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL CHECK(revision>=0)) STRICT",
  "CREATE TABLE knowledge_retrieval_generations(generation_id TEXT NOT NULL PRIMARY KEY,index_schema_version INTEGER NOT NULL CHECK(index_schema_version=1),source_revision INTEGER NOT NULL CHECK(source_revision>=0),status TEXT NOT NULL CHECK(status IN ('building','ready')),entry_count INTEGER NOT NULL CHECK(entry_count>=0),source_count INTEGER NOT NULL CHECK(source_count>=0),content_sha256 TEXT,posting_sha256 TEXT,created_at TEXT NOT NULL,CHECK(status='building' OR (content_sha256 IS NOT NULL AND posting_sha256 IS NOT NULL))) STRICT",
  "CREATE TABLE knowledge_retrieval_active(singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),generation_id TEXT NOT NULL,FOREIGN KEY(generation_id) REFERENCES knowledge_retrieval_generations(generation_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE knowledge_retrieval_entries(entry_id INTEGER PRIMARY KEY,generation_id TEXT NOT NULL,artifact_id TEXT NOT NULL,content_sha256 TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,scope_kind TEXT NOT NULL CHECK(scope_kind IN ('literature','manifest')),scope_key TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN ('overview','detailed','question','synthesis')),question_sha256 TEXT NOT NULL,statement_id TEXT NOT NULL,statement_ordinal INTEGER NOT NULL CHECK(statement_ordinal>=0),statement_sha256 TEXT NOT NULL,source_literature_ids_json TEXT NOT NULL,scope_complete INTEGER NOT NULL CHECK(scope_complete IN (0,1)),is_default INTEGER NOT NULL CHECK(is_default IN (0,1)),FOREIGN KEY(generation_id) REFERENCES knowledge_retrieval_generations(generation_id) ON DELETE CASCADE) STRICT",
  "CREATE VIRTUAL TABLE knowledge_retrieval_fts USING fts5(title,body,tokenize='unicode61')",
  "CREATE INDEX knowledge_retrieval_entries_scope ON knowledge_retrieval_entries(generation_id,purpose,question_sha256,scope_kind,scope_key,is_default,artifact_id,statement_ordinal)",
  "CREATE TABLE knowledge_retrieval_schema_migrations(migration_id TEXT NOT NULL PRIMARY KEY,from_version INTEGER NOT NULL CHECK(from_version=7),to_version INTEGER NOT NULL CHECK(to_version=8),manifest_fingerprint TEXT NOT NULL CHECK(length(manifest_fingerprint)=64),applied_at TEXT NOT NULL) STRICT",
  ...triggers,
] as const;

export const SCHEMA_V8_MANIFEST = [
  SCHEMA_IDENTITY_V8,
  ...SCHEMA_V7_MANIFEST.slice(1),
  ...KNOWLEDGE_RETRIEVAL_SCHEMA,
] as const;
const actualFingerprint = createHash("sha256")
  .update(JSON.stringify(SCHEMA_V8_MANIFEST))
  .digest("hex");
export const SCHEMA_V8_FINGERPRINT =
  "42096bd3c5b5cf5dcb97ca0a0671bbc625b0772272228aef8e461792dda20a05" as const;
if (actualFingerprint !== SCHEMA_V8_FINGERPRINT)
  throw new Error(
    "catalog v8 schema manifest changed without a version decision",
  );
