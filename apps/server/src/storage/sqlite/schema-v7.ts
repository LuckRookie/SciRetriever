import { createHash } from "node:crypto";
import { SCHEMA_V6_MANIFEST, KNOWLEDGE_SCHEMA } from "./schema-v6.js";

export const SCHEMA_V7_VERSION = 7 as const;
export const SCHEMA_IDENTITY_V7 = SCHEMA_V6_MANIFEST[0]!.replace(
  "schema_version=6",
  "schema_version=7",
);

const previousArtifactTable = KNOWLEDGE_SCHEMA[0];
if (!previousArtifactTable) throw new Error("knowledge artifact DDL missing");
export const KNOWLEDGE_ARTIFACT_V7 = previousArtifactTable
  .replace(
    "length(CAST(coverage_json AS BLOB)) BETWEEN 1 AND 16384",
    "length(CAST(coverage_json AS BLOB)) BETWEEN 1 AND 65536",
  )
  .replace(
    "CHECK((purpose='question' AND question_text IS NOT NULL) OR (purpose<>'question' AND question_text IS NULL))",
    "CHECK((purpose IN ('question','synthesis') AND question_text IS NOT NULL) OR (purpose IN ('overview','detailed') AND question_text IS NULL))",
  );
if (
  KNOWLEDGE_ARTIFACT_V7 === previousArtifactTable ||
  !KNOWLEDGE_ARTIFACT_V7.includes("BETWEEN 1 AND 65536") ||
  !KNOWLEDGE_ARTIFACT_V7.includes("purpose IN ('question','synthesis')")
)
  throw new Error("knowledge v7 DDL replacement failed");

export const KNOWLEDGE_V7_MIGRATIONS =
  "CREATE TABLE knowledge_v7_migrations(migration_id TEXT NOT NULL PRIMARY KEY,from_version INTEGER NOT NULL CHECK(from_version=6),to_version INTEGER NOT NULL CHECK(to_version=7),manifest_fingerprint TEXT NOT NULL CHECK(length(manifest_fingerprint)=64),applied_at TEXT NOT NULL CHECK(length(trim(applied_at))>0)) STRICT";

export const SCHEMA_V7_MANIFEST = [
  SCHEMA_IDENTITY_V7,
  ...SCHEMA_V6_MANIFEST.slice(1).map((sql) =>
    sql === previousArtifactTable ? KNOWLEDGE_ARTIFACT_V7 : sql,
  ),
  KNOWLEDGE_V7_MIGRATIONS,
] as const;
const actualFingerprint = createHash("sha256")
  .update(JSON.stringify(SCHEMA_V7_MANIFEST))
  .digest("hex");
export const SCHEMA_V7_FINGERPRINT =
  "2e55955946c476beddc9a0a4d61bd8e9d5788cde316f322ddae8b201e405f13a" as const;
if (actualFingerprint !== SCHEMA_V7_FINGERPRINT)
  throw new Error(
    "catalog v7 schema manifest changed without a version decision",
  );
