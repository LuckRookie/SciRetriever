import { createHash } from "node:crypto";
import { SCHEMA_V2_MANIFEST } from "./schema-v2.js";

export const SCHEMA_V3_VERSION = 3 as const;
const HASH = "length(%s)=64 AND %s=lower(%s) AND %s NOT GLOB '*[^0-9a-f]*'";
const hash = (field: string) => HASH.replaceAll("%s", field);

export const SCHEMA_IDENTITY_V3 =
  "CREATE TABLE schema_identity(singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),product TEXT NOT NULL CHECK(product='sciretriever'),schema_version INTEGER NOT NULL CHECK(schema_version=3),schema_fingerprint TEXT NOT NULL CHECK(length(schema_fingerprint)=64 AND schema_fingerprint=lower(schema_fingerprint) AND schema_fingerprint NOT GLOB '*[^0-9a-f]*'),created_at TEXT NOT NULL CHECK(length(trim(created_at))>0)) STRICT";

/** Only Document/Evidence's first durable surface. Later owners append their own manifests. */
export const DOCUMENT_SCHEMA = [
  `CREATE TABLE document_versions(document_version_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(document_version_id))>0),document_id TEXT NOT NULL CHECK(length(trim(document_id))>0),schema_version INTEGER NOT NULL CHECK(schema_version=1),literature_id TEXT NOT NULL,source_asset_id TEXT NOT NULL,source_sha256 TEXT NOT NULL CHECK(${hash("source_sha256")}),source_byte_size INTEGER NOT NULL CHECK(source_byte_size>0),source_media_type TEXT NOT NULL CHECK(length(trim(source_media_type))>0),source_artifact_path TEXT NOT NULL,parser_result_sha256 TEXT NOT NULL CHECK(${hash("parser_result_sha256")}),parser_provenance_id TEXT NOT NULL,builder_version TEXT NOT NULL CHECK(length(trim(builder_version))>0),locator_scheme TEXT NOT NULL CHECK(length(trim(locator_scheme))>0),representation_sha256 TEXT NOT NULL CHECK(${hash("representation_sha256")}),markdown_artifact_path TEXT NOT NULL,markdown_sha256 TEXT NOT NULL CHECK(${hash("markdown_sha256")}),markdown_byte_size INTEGER NOT NULL CHECK(markdown_byte_size>0),markdown_media_type TEXT NOT NULL CHECK(markdown_media_type='text/markdown'),structure_artifact_path TEXT NOT NULL,structure_sha256 TEXT NOT NULL CHECK(${hash("structure_sha256")}),structure_byte_size INTEGER NOT NULL CHECK(structure_byte_size>0),structure_media_type TEXT NOT NULL CHECK(structure_media_type='application/json'),created_at TEXT NOT NULL CHECK(length(trim(created_at))>0),UNIQUE(document_id,representation_sha256),UNIQUE(document_id,document_version_id),UNIQUE(document_version_id,representation_sha256),FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT,FOREIGN KEY(source_asset_id,source_sha256) REFERENCES assets(asset_id,sha256) ON DELETE RESTRICT,FOREIGN KEY(source_artifact_path,source_sha256,source_byte_size,source_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT,FOREIGN KEY(parser_provenance_id) REFERENCES provenances(provenance_id) ON DELETE RESTRICT,FOREIGN KEY(markdown_artifact_path,markdown_sha256,markdown_byte_size,markdown_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT,FOREIGN KEY(structure_artifact_path,structure_sha256,structure_byte_size,structure_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT) STRICT`,
  `CREATE TABLE document_version_resources(document_version_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),resource_id TEXT NOT NULL CHECK(length(trim(resource_id))>0),reference TEXT NOT NULL CHECK(length(trim(reference))>0),relation TEXT NOT NULL CHECK(relation IN ('image','table-source','supplement','other')),artifact_path TEXT NOT NULL,artifact_sha256 TEXT NOT NULL CHECK(${hash("artifact_sha256")}),artifact_byte_size INTEGER NOT NULL CHECK(artifact_byte_size>=0),artifact_media_type TEXT NOT NULL CHECK(length(trim(artifact_media_type))>0),PRIMARY KEY(document_version_id,ordinal),UNIQUE(document_version_id,resource_id),UNIQUE(document_version_id,reference),FOREIGN KEY(document_version_id) REFERENCES document_versions(document_version_id) ON DELETE RESTRICT,FOREIGN KEY(artifact_path,artifact_sha256,artifact_byte_size,artifact_media_type) REFERENCES artifact_objects(relative_path,sha256,byte_size,media_type) ON DELETE RESTRICT) STRICT`,
  "CREATE TABLE document_defaults(document_id TEXT NOT NULL PRIMARY KEY,document_version_id TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL CHECK(revision>=1),FOREIGN KEY(document_id,document_version_id) REFERENCES document_versions(document_id,document_version_id) ON DELETE RESTRICT) STRICT",
  `CREATE TABLE document_schema_migrations(migration_id TEXT NOT NULL PRIMARY KEY,from_version INTEGER NOT NULL CHECK(from_version IN (1,2)),to_version INTEGER NOT NULL CHECK(to_version=3),manifest_fingerprint TEXT NOT NULL CHECK(${hash("manifest_fingerprint")}),applied_at TEXT NOT NULL CHECK(length(trim(applied_at))>0)) STRICT`,
] as const;

export const SCHEMA_V3_MANIFEST = [
  SCHEMA_IDENTITY_V3,
  ...SCHEMA_V2_MANIFEST.slice(1),
  ...DOCUMENT_SCHEMA,
] as const;
const manifestFingerprint = createHash("sha256")
  .update(JSON.stringify(SCHEMA_V3_MANIFEST))
  .digest("hex");
export const SCHEMA_V3_FINGERPRINT =
  "e4d474b1627e39f668752f315bdc2edb995ab5bf5d275262b72d2019ea6f4e36" as const;
if (manifestFingerprint !== SCHEMA_V3_FINGERPRINT)
  throw new Error(
    "catalog v3 schema manifest changed without a version decision",
  );
