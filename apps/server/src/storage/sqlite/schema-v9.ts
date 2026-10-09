import { createHash } from "node:crypto";
import { SCHEMA_V8_MANIFEST } from "./schema-v8.js";

export const SCHEMA_V9_VERSION = 9 as const;
export const SCHEMA_IDENTITY_V9 = SCHEMA_V8_MANIFEST[0]!.replace(
  "schema_version=8",
  "schema_version=9",
);
export const ARTICLE_IDENTITY_SCHEMA = [
  "CREATE TABLE article_identity_assessments(assessment_id TEXT NOT NULL PRIMARY KEY,literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,asset_sha256 TEXT NOT NULL,document_version_id TEXT NOT NULL,representation_sha256 TEXT NOT NULL,metadata_revision INTEGER NOT NULL CHECK(metadata_revision>=1),metadata_sha256 TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('match-supported','conflict','insufficient-evidence')),assessment_json TEXT NOT NULL CHECK(json_valid(assessment_json) AND length(CAST(assessment_json AS BLOB))<=65536),created_at TEXT NOT NULL,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT,FOREIGN KEY(asset_id,asset_sha256) REFERENCES assets(asset_id,sha256) ON DELETE RESTRICT,FOREIGN KEY(document_version_id,representation_sha256) REFERENCES document_versions(document_version_id,representation_sha256) ON DELETE RESTRICT) STRICT",
  "CREATE INDEX article_identity_current ON article_identity_assessments(literature_id,asset_id,metadata_revision,metadata_sha256,created_at,assessment_id)",
  "CREATE TABLE article_identity_schema_migrations(migration_id TEXT NOT NULL PRIMARY KEY,from_version INTEGER NOT NULL CHECK(from_version=8),to_version INTEGER NOT NULL CHECK(to_version=9),manifest_fingerprint TEXT NOT NULL CHECK(length(manifest_fingerprint)=64),applied_at TEXT NOT NULL) STRICT",
] as const;
export const SCHEMA_V9_MANIFEST = [
  SCHEMA_IDENTITY_V9,
  ...SCHEMA_V8_MANIFEST.slice(1),
  ...ARTICLE_IDENTITY_SCHEMA,
] as const;
const actualFingerprint = createHash("sha256")
  .update(JSON.stringify(SCHEMA_V9_MANIFEST))
  .digest("hex");
export const SCHEMA_V9_FINGERPRINT =
  "cf706d007d7ff430470b7fc110a7a95294d998bf0732fa4f34b0c05fbe36e378" as const;
if (actualFingerprint !== SCHEMA_V9_FINGERPRINT)
  throw new Error(
    "catalog v9 schema manifest changed without a version decision",
  );
