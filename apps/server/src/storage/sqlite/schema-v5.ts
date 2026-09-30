import { createHash } from "node:crypto";
import { SCHEMA_V4_MANIFEST } from "./schema-v4.js";

export const SCHEMA_V5_VERSION = 5 as const;
export const SCHEMA_IDENTITY_V5 =
  "CREATE TABLE schema_identity(singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),product TEXT NOT NULL CHECK(product='sciretriever'),schema_version INTEGER NOT NULL CHECK(schema_version=5),schema_fingerprint TEXT NOT NULL CHECK(length(schema_fingerprint)=64 AND schema_fingerprint=lower(schema_fingerprint) AND schema_fingerprint NOT GLOB '*[^0-9a-f]*'),created_at TEXT NOT NULL CHECK(length(trim(created_at))>0)) STRICT";

/** Extraction keeps immutable negotiation metadata, receipts and exact input pins; never records payloads. */
export const EXTRACTION_SCHEMA = [
  "CREATE TABLE extraction_specs(caller_id TEXT NOT NULL,spec_id TEXT NOT NULL,spec_version TEXT NOT NULL,spec_sha256 TEXT NOT NULL CHECK(length(spec_sha256)=64 AND spec_sha256=lower(spec_sha256) AND spec_sha256 NOT GLOB '*[^0-9a-f]*'),spec_json TEXT NOT NULL CHECK(length(CAST(spec_json AS BLOB))>0 AND length(CAST(spec_json AS BLOB))<=65536),PRIMARY KEY(caller_id,spec_id,spec_version),UNIQUE(caller_id,spec_id,spec_version,spec_sha256)) STRICT",
  "CREATE TABLE extraction_operations(operation_id TEXT NOT NULL PRIMARY KEY,caller_id TEXT NOT NULL,spec_id TEXT NOT NULL,spec_version TEXT NOT NULL,spec_sha256 TEXT NOT NULL,manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256=lower(manifest_sha256) AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),manifest_json TEXT NOT NULL CHECK(length(CAST(manifest_json AS BLOB))>0 AND length(CAST(manifest_json AS BLOB))<=262144),status TEXT NOT NULL CHECK(status IN ('open','closed','cancelled')),created_at TEXT NOT NULL,accept_until TEXT NOT NULL,closed_at TEXT,FOREIGN KEY(caller_id,spec_id,spec_version,spec_sha256) REFERENCES extraction_specs(caller_id,spec_id,spec_version,spec_sha256) ON DELETE RESTRICT,CHECK((status='open' AND closed_at IS NULL) OR (status<>'open' AND closed_at IS NOT NULL))) STRICT",
  "CREATE TABLE extraction_receipts(receipt_id TEXT NOT NULL PRIMARY KEY,operation_id TEXT NOT NULL,submission_key TEXT NOT NULL,batch_id TEXT NOT NULL,submission_sha256 TEXT NOT NULL CHECK(length(submission_sha256)=64 AND submission_sha256=lower(submission_sha256) AND submission_sha256 NOT GLOB '*[^0-9a-f]*'),accepted_at TEXT NOT NULL,receipt_expires_at TEXT NOT NULL,protection_expires_at TEXT NOT NULL,checks_json TEXT NOT NULL CHECK(length(CAST(checks_json AS BLOB))>0 AND length(CAST(checks_json AS BLOB))<=4096),UNIQUE(operation_id,submission_key),UNIQUE(operation_id,batch_id),FOREIGN KEY(operation_id) REFERENCES extraction_operations(operation_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE extraction_receipt_materials(receipt_id TEXT NOT NULL,input_id TEXT NOT NULL,literature_id TEXT NOT NULL,asset_id TEXT NOT NULL,asset_sha256 TEXT NOT NULL,PRIMARY KEY(receipt_id,input_id),FOREIGN KEY(receipt_id) REFERENCES extraction_receipts(receipt_id) ON DELETE CASCADE,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE RESTRICT,FOREIGN KEY(asset_id,asset_sha256) REFERENCES assets(asset_id,sha256) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE extraction_receipt_documents(receipt_id TEXT NOT NULL,input_id TEXT NOT NULL,document_version_id TEXT NOT NULL,representation_sha256 TEXT NOT NULL,PRIMARY KEY(receipt_id,input_id),FOREIGN KEY(receipt_id,input_id) REFERENCES extraction_receipt_materials(receipt_id,input_id) ON DELETE CASCADE,FOREIGN KEY(document_version_id,representation_sha256) REFERENCES document_versions(document_version_id,representation_sha256) ON DELETE RESTRICT) STRICT",
  "CREATE INDEX extraction_receipts_expiry ON extraction_receipts(receipt_expires_at,receipt_id)",
  "CREATE INDEX extraction_operations_expiry ON extraction_operations(accept_until,operation_id)",
  "CREATE TABLE extraction_schema_migrations(migration_id TEXT NOT NULL PRIMARY KEY,from_version INTEGER NOT NULL CHECK(from_version=4),to_version INTEGER NOT NULL CHECK(to_version=5),manifest_fingerprint TEXT NOT NULL CHECK(length(manifest_fingerprint)=64),applied_at TEXT NOT NULL CHECK(length(trim(applied_at))>0)) STRICT",
] as const;
export const SCHEMA_V5_MANIFEST = [
  SCHEMA_IDENTITY_V5,
  ...SCHEMA_V4_MANIFEST.slice(1),
  ...EXTRACTION_SCHEMA,
] as const;
const actualFingerprint = createHash("sha256")
  .update(JSON.stringify(SCHEMA_V5_MANIFEST))
  .digest("hex");
export const SCHEMA_V5_FINGERPRINT =
  "b32a2e853ae0dbde4ae3bcb1f58e109e86a1489db7b9025c4b7e809e330bd7b5" as const;
if (actualFingerprint !== SCHEMA_V5_FINGERPRINT)
  throw new Error(
    "catalog v5 schema manifest changed without a version decision",
  );
