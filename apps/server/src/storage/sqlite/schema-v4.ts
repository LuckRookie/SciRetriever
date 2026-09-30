import { createHash } from "node:crypto";
import { SCHEMA_V3_MANIFEST } from "./schema-v3.js";

export const SCHEMA_V4_VERSION = 4 as const;
export const SCHEMA_IDENTITY_V4 =
  "CREATE TABLE schema_identity(singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),product TEXT NOT NULL CHECK(product='sciretriever'),schema_version INTEGER NOT NULL CHECK(schema_version=4),schema_fingerprint TEXT NOT NULL CHECK(length(schema_fingerprint)=64 AND schema_fingerprint=lower(schema_fingerprint) AND schema_fingerprint NOT GLOB '*[^0-9a-f]*'),created_at TEXT NOT NULL CHECK(length(trim(created_at))>0)) STRICT";

/** Retrieval owns only a rebuildable projection. No source fact is stored here. */
const revisionSources = [
  "literatures",
  "literature_metadata",
  "literature_metadata_authors",
  "literature_metadata_author_affiliations",
  "literature_metadata_identifiers",
  "literature_metadata_keywords",
  "assets",
  "literature_assets",
  "document_versions",
  "document_version_resources",
  "document_defaults",
] as const;
const revisionTriggers = revisionSources.flatMap((source) =>
  (["INSERT", "UPDATE", "DELETE"] as const).map(
    (event) =>
      `CREATE TRIGGER retrieval_revision_${source}_${event.toLowerCase()} AFTER ${event} ON ${source} BEGIN UPDATE retrieval_source_revision SET revision=revision+1 WHERE singleton=1; END`,
  ),
);

export const RETRIEVAL_SCHEMA = [
  "CREATE TABLE retrieval_source_revision(singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL CHECK(revision>=0)) STRICT",
  "CREATE TABLE retrieval_generations(generation_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(generation_id))>0),index_schema_version INTEGER NOT NULL CHECK(index_schema_version=1),unit_rule TEXT NOT NULL CHECK(unit_rule='markdown-context-v1'),source_revision INTEGER NOT NULL CHECK(source_revision>=0),status TEXT NOT NULL CHECK(status IN ('building','ready')),entry_count INTEGER NOT NULL CHECK(entry_count>=0),fts_count INTEGER NOT NULL CHECK(fts_count>=0),source_count INTEGER NOT NULL CHECK(source_count>=0),content_sha256 TEXT CHECK(content_sha256 IS NULL OR (length(content_sha256)=64 AND content_sha256=lower(content_sha256) AND content_sha256 NOT GLOB '*[^0-9a-f]*')),posting_sha256 TEXT CHECK(posting_sha256 IS NULL OR (length(posting_sha256)=64 AND posting_sha256=lower(posting_sha256) AND posting_sha256 NOT GLOB '*[^0-9a-f]*')),created_at TEXT NOT NULL CHECK(length(trim(created_at))>0),CHECK(status='building' OR (content_sha256 IS NOT NULL AND posting_sha256 IS NOT NULL))) STRICT",
  "CREATE TABLE retrieval_active_generation(singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),generation_id TEXT NOT NULL,FOREIGN KEY(generation_id) REFERENCES retrieval_generations(generation_id) ON DELETE RESTRICT) STRICT",
  "CREATE TABLE retrieval_entries(entry_id INTEGER PRIMARY KEY,generation_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('metadata','document')),literature_id TEXT NOT NULL,meta_literature_id TEXT NOT NULL,metadata_revision INTEGER NOT NULL CHECK(metadata_revision>=1),metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256)=64),document_version_id TEXT,representation_sha256 TEXT,source_asset_id TEXT,source_asset_sha256 TEXT,unit_start_utf8 INTEGER,unit_end_utf8 INTEGER,unit_sha256 TEXT,section_id TEXT,unit_ordinal INTEGER NOT NULL CHECK(unit_ordinal>=0),is_default INTEGER NOT NULL CHECK(is_default IN (0,1)),CHECK((kind='metadata' AND document_version_id IS NULL AND representation_sha256 IS NULL AND source_asset_id IS NULL AND source_asset_sha256 IS NULL AND unit_start_utf8 IS NULL AND unit_end_utf8 IS NULL AND unit_sha256 IS NULL AND section_id IS NULL) OR (kind='document' AND document_version_id IS NOT NULL AND representation_sha256 IS NOT NULL AND source_asset_id IS NOT NULL AND source_asset_sha256 IS NOT NULL AND unit_start_utf8>=0 AND unit_end_utf8>unit_start_utf8 AND unit_sha256 IS NOT NULL)),FOREIGN KEY(generation_id) REFERENCES retrieval_generations(generation_id) ON DELETE CASCADE) STRICT",
  "CREATE VIRTUAL TABLE retrieval_fts USING fts5(title,body,tokenize='unicode61')",
  "CREATE INDEX retrieval_entries_scope ON retrieval_entries(generation_id,kind,literature_id,is_default,document_version_id,entry_id)",
  "CREATE INDEX retrieval_entries_version ON retrieval_entries(generation_id,document_version_id,unit_ordinal)",
  "CREATE TABLE retrieval_schema_migrations(migration_id TEXT NOT NULL PRIMARY KEY,from_version INTEGER NOT NULL CHECK(from_version=3),to_version INTEGER NOT NULL CHECK(to_version=4),manifest_fingerprint TEXT NOT NULL CHECK(length(manifest_fingerprint)=64),applied_at TEXT NOT NULL CHECK(length(trim(applied_at))>0)) STRICT",
  ...revisionTriggers,
] as const;

export const SCHEMA_V4_MANIFEST = [
  SCHEMA_IDENTITY_V4,
  ...SCHEMA_V3_MANIFEST.slice(1),
  ...RETRIEVAL_SCHEMA,
] as const;
const manifestFingerprint = createHash("sha256")
  .update(JSON.stringify(SCHEMA_V4_MANIFEST))
  .digest("hex");
export const SCHEMA_V4_FINGERPRINT =
  "5391b92b4cab13ad2f1380705d603e21619264f442789a6659a1036ba0086c33" as const;
if (manifestFingerprint !== SCHEMA_V4_FINGERPRINT)
  throw new Error(
    `catalog v4 schema manifest changed without a version decision: ${manifestFingerprint}`,
  );
