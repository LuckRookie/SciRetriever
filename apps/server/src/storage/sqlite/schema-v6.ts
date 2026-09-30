import { createHash } from "node:crypto";
import { SCHEMA_V5_MANIFEST } from "./schema-v5.js";

export const SCHEMA_V6_VERSION = 6 as const;
export const SCHEMA_IDENTITY_V6 =
  "CREATE TABLE schema_identity(singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),product TEXT NOT NULL CHECK(product='sciretriever'),schema_version INTEGER NOT NULL CHECK(schema_version=6),schema_fingerprint TEXT NOT NULL CHECK(length(schema_fingerprint)=64 AND schema_fingerprint=lower(schema_fingerprint) AND schema_fingerprint NOT GLOB '*[^0-9a-f]*'),created_at TEXT NOT NULL CHECK(length(trim(created_at))>0)) STRICT";

/** Analysis owns knowledge facts; these relations pin their exact input closure. */
export const KNOWLEDGE_SCHEMA = [
  "CREATE TABLE knowledge_artifacts(artifact_id TEXT NOT NULL PRIMARY KEY,comparison_sha256 TEXT NOT NULL UNIQUE CHECK(length(comparison_sha256)=64 AND comparison_sha256=lower(comparison_sha256) AND comparison_sha256 NOT GLOB '*[^0-9a-f]*'),scope_kind TEXT NOT NULL CHECK(scope_kind IN ('literature','manifest')),scope_key TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN ('overview','detailed','question','synthesis')),question_sha256 TEXT NOT NULL CHECK(length(question_sha256)=64 AND question_sha256=lower(question_sha256) AND question_sha256 NOT GLOB '*[^0-9a-f]*'),question_text TEXT,manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64),manifest_json TEXT NOT NULL CHECK(length(CAST(manifest_json AS BLOB)) BETWEEN 1 AND 262234),method_id TEXT NOT NULL,method_version TEXT NOT NULL,parameters_sha256 TEXT NOT NULL CHECK(length(parameters_sha256)=64),method_json TEXT NOT NULL CHECK(length(CAST(method_json AS BLOB)) BETWEEN 1 AND 16384),content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),content_size INTEGER NOT NULL CHECK(content_size BETWEEN 1 AND 1048576),content_media_type TEXT NOT NULL CHECK(content_media_type='application/vnd.sciretriever.knowledge+json'),content_reference TEXT NOT NULL,coverage_json TEXT NOT NULL CHECK(length(CAST(coverage_json AS BLOB)) BETWEEN 1 AND 16384),provenance_json TEXT NOT NULL CHECK(length(CAST(provenance_json AS BLOB)) BETWEEN 1 AND 16384),created_at TEXT NOT NULL,UNIQUE(artifact_id,scope_kind,scope_key,purpose,question_sha256),FOREIGN KEY(content_reference,content_sha256,content_size,content_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT,CHECK((purpose='question' AND question_text IS NOT NULL) OR (purpose<>'question' AND question_text IS NULL)),CHECK((scope_kind='literature' AND purpose<>'synthesis') OR (scope_kind='manifest' AND purpose='synthesis'))) STRICT",
  "CREATE TABLE knowledge_input_materials(artifact_id TEXT NOT NULL,input_id TEXT NOT NULL,literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,asset_sha256 TEXT NOT NULL,PRIMARY KEY(artifact_id,input_id),FOREIGN KEY(artifact_id) REFERENCES knowledge_artifacts(artifact_id) ON DELETE RESTRICT,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT,FOREIGN KEY(asset_id,asset_sha256) REFERENCES assets(asset_id,sha256) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE knowledge_input_documents(artifact_id TEXT NOT NULL,input_id TEXT NOT NULL,document_version_id TEXT NOT NULL,representation_sha256 TEXT NOT NULL,PRIMARY KEY(artifact_id,input_id),FOREIGN KEY(artifact_id,input_id) REFERENCES knowledge_input_materials(artifact_id,input_id) ON DELETE RESTRICT,FOREIGN KEY(document_version_id,representation_sha256) REFERENCES document_versions(document_version_id,representation_sha256) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE knowledge_input_artifacts(artifact_id TEXT NOT NULL,input_id TEXT NOT NULL,source_artifact_id TEXT NOT NULL,source_content_sha256 TEXT NOT NULL,compression_depth INTEGER NOT NULL CHECK(compression_depth BETWEEN 1 AND 32),PRIMARY KEY(artifact_id,input_id),FOREIGN KEY(artifact_id) REFERENCES knowledge_artifacts(artifact_id) ON DELETE RESTRICT,FOREIGN KEY(source_artifact_id,source_content_sha256) REFERENCES knowledge_artifacts(artifact_id,content_sha256) ON DELETE RESTRICT,CHECK(artifact_id<>source_artifact_id)) STRICT",
  "CREATE UNIQUE INDEX knowledge_artifacts_id_content ON knowledge_artifacts(artifact_id,content_sha256)",
  "CREATE INDEX knowledge_input_materials_asset ON knowledge_input_materials(asset_id,asset_sha256)",
  "CREATE INDEX knowledge_input_documents_version ON knowledge_input_documents(document_version_id,representation_sha256)",
  "CREATE INDEX knowledge_input_artifacts_source ON knowledge_input_artifacts(source_artifact_id)",
  "CREATE TABLE knowledge_defaults(scope_kind TEXT NOT NULL CHECK(scope_kind='literature'),scope_key TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN ('overview','detailed','question')),question_sha256 TEXT NOT NULL,artifact_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),PRIMARY KEY(scope_kind,scope_key,purpose,question_sha256),FOREIGN KEY(scope_key) REFERENCES literatures(literature_id) ON DELETE RESTRICT,FOREIGN KEY(artifact_id,scope_kind,scope_key,purpose,question_sha256) REFERENCES knowledge_artifacts(artifact_id,scope_kind,scope_key,purpose,question_sha256) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE knowledge_schema_migrations(migration_id TEXT NOT NULL PRIMARY KEY,from_version INTEGER NOT NULL CHECK(from_version=5),to_version INTEGER NOT NULL CHECK(to_version=6),manifest_fingerprint TEXT NOT NULL CHECK(length(manifest_fingerprint)=64),applied_at TEXT NOT NULL CHECK(length(trim(applied_at))>0)) STRICT",
] as const;

export const SCHEMA_V6_MANIFEST = [
  SCHEMA_IDENTITY_V6,
  ...SCHEMA_V5_MANIFEST.slice(1),
  ...KNOWLEDGE_SCHEMA,
] as const;
const actualFingerprint = createHash("sha256")
  .update(JSON.stringify(SCHEMA_V6_MANIFEST))
  .digest("hex");
export const SCHEMA_V6_FINGERPRINT =
  "7c721811397763aa44115fa788d35f7ed641d071ac310cc6b7d0ece61d0930ec" as const;
if (actualFingerprint !== SCHEMA_V6_FINGERPRINT)
  throw new Error(
    "catalog v6 schema manifest changed without a version decision",
  );
