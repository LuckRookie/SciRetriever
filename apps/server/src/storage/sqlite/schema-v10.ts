import { createHash } from "node:crypto";
import { SCHEMA_V9_MANIFEST } from "./schema-v9.js";
export const SCHEMA_V10_VERSION = 10 as const;
export const SCHEMA_IDENTITY_V10 = SCHEMA_V9_MANIFEST[0]!.replace(
  "schema_version=9",
  "schema_version=10",
);
export const PROCESSOR_SCHEMA = [
  "CREATE TABLE processor_results(result_id TEXT NOT NULL PRIMARY KEY,comparison_sha256 TEXT NOT NULL CHECK(length(comparison_sha256)=64),processor_id TEXT NOT NULL,processor_version TEXT NOT NULL,complete INTEGER NOT NULL CHECK(complete IN (0,1)),producer TEXT NOT NULL CHECK(producer IN ('internal','external')),content_reference TEXT NOT NULL,content_sha256 TEXT NOT NULL,content_size INTEGER NOT NULL CHECK(content_size>0 AND content_size<=8388608),content_media_type TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(result_id,content_sha256),FOREIGN KEY(content_reference,content_sha256,content_size,content_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT) STRICT",
  "CREATE UNIQUE INDEX processor_complete_comparison ON processor_results(comparison_sha256) WHERE complete=1 AND producer='internal'",
  "CREATE TABLE processor_result_documents(result_id TEXT NOT NULL,literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,asset_sha256 TEXT NOT NULL,document_version_id TEXT NOT NULL,representation_sha256 TEXT NOT NULL,PRIMARY KEY(result_id,document_version_id),FOREIGN KEY(result_id) REFERENCES processor_results(result_id) ON DELETE RESTRICT,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT,FOREIGN KEY(asset_id,asset_sha256) REFERENCES assets(asset_id,sha256) ON DELETE RESTRICT,FOREIGN KEY(document_version_id,representation_sha256) REFERENCES document_versions(document_version_id,representation_sha256) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE processor_result_materials(result_id TEXT NOT NULL,literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,asset_sha256 TEXT NOT NULL,PRIMARY KEY(result_id,asset_id),FOREIGN KEY(result_id) REFERENCES processor_results(result_id) ON DELETE RESTRICT,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT,FOREIGN KEY(asset_id,asset_sha256) REFERENCES assets(asset_id,sha256) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE processor_result_inputs(result_id TEXT NOT NULL,source_result_id TEXT NOT NULL,source_sha256 TEXT NOT NULL,PRIMARY KEY(result_id,source_result_id),CHECK(result_id<>source_result_id),FOREIGN KEY(result_id) REFERENCES processor_results(result_id) ON DELETE RESTRICT,FOREIGN KEY(source_result_id,source_sha256) REFERENCES processor_results(result_id,content_sha256) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE processor_result_knowledge(result_id TEXT NOT NULL,artifact_id TEXT NOT NULL,content_sha256 TEXT NOT NULL,PRIMARY KEY(result_id,artifact_id),FOREIGN KEY(result_id) REFERENCES processor_results(result_id) ON DELETE RESTRICT,FOREIGN KEY(artifact_id,content_sha256) REFERENCES knowledge_artifacts(artifact_id,content_sha256) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE processor_collections(collection_id TEXT NOT NULL PRIMARY KEY,run_id TEXT NOT NULL,name TEXT NOT NULL,processor_id TEXT NOT NULL,spec_json TEXT NOT NULL,content_reference TEXT NOT NULL,content_sha256 TEXT NOT NULL,content_size INTEGER NOT NULL,content_media_type TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(content_reference,content_sha256,content_size,content_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE processor_collection_members(collection_id TEXT NOT NULL,target_id TEXT NOT NULL,result_id TEXT,content_sha256 TEXT,gap TEXT,PRIMARY KEY(collection_id,target_id),FOREIGN KEY(collection_id) REFERENCES processor_collections(collection_id) ON DELETE RESTRICT,FOREIGN KEY(result_id,content_sha256) REFERENCES processor_results(result_id,content_sha256) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE processor_record_projection(result_id TEXT NOT NULL,record_id TEXT NOT NULL,ordinal INTEGER NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),PRIMARY KEY(result_id,record_id),FOREIGN KEY(result_id) REFERENCES processor_results(result_id) ON DELETE CASCADE) STRICT",
  "CREATE TABLE processor_projection_state(result_id TEXT NOT NULL PRIMARY KEY,content_sha256 TEXT NOT NULL,record_count INTEGER NOT NULL,FOREIGN KEY(result_id,content_sha256) REFERENCES processor_results(result_id,content_sha256) ON DELETE CASCADE) STRICT",
  "CREATE VIRTUAL TABLE processor_result_fts USING fts5(result_id UNINDEXED,record_id UNINDEXED,body,tokenize='unicode61')",
  "CREATE VIRTUAL TABLE processor_collection_fts USING fts5(collection_id UNINDEXED,body,tokenize='unicode61')",
  "CREATE INDEX processor_collection_runs ON processor_collections(run_id,created_at,collection_id)",
  "CREATE TABLE processor_schema_migrations(migration_id TEXT NOT NULL PRIMARY KEY,from_version INTEGER NOT NULL CHECK(from_version=9),to_version INTEGER NOT NULL CHECK(to_version=10),manifest_fingerprint TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT",
] as const;
export const SCHEMA_V10_MANIFEST = [
  SCHEMA_IDENTITY_V10,
  ...SCHEMA_V9_MANIFEST.slice(1),
  ...PROCESSOR_SCHEMA,
] as const;
export const SCHEMA_V10_FINGERPRINT =
  "e3493b0db0c0183c0a8b40bd5b671e4c6ec51ca5a44ed4efc2339ea694310f9d" as const;
if (
  createHash("sha256")
    .update(JSON.stringify(SCHEMA_V10_MANIFEST))
    .digest("hex") !== SCHEMA_V10_FINGERPRINT
)
  throw new Error(
    "catalog v10 schema manifest changed without a version decision",
  );
