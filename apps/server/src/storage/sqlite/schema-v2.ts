import { createHash } from "node:crypto";
import { SCHEMA_MANIFEST } from "./schema.js";
import {
  EXECUTION_RUNTIME_SCHEMA,
  EXECUTION_SCHEMA,
} from "./execution-schema.js";

export const SCHEMA_V2_VERSION = 2 as const;

/** The only v1 business table rebuilt by the explicit v1 -> v2 migration. */
export const SCHEMA_IDENTITY_V2 =
  "CREATE TABLE schema_identity(singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),product TEXT NOT NULL CHECK(product='sciretriever'),schema_version INTEGER NOT NULL CHECK(schema_version=2),schema_fingerprint TEXT NOT NULL CHECK(length(schema_fingerprint)=64 AND schema_fingerprint=lower(schema_fingerprint) AND schema_fingerprint NOT GLOB '*[^0-9a-f]*'),created_at TEXT NOT NULL CHECK(length(trim(created_at))>0)) STRICT";

/** Complete catalog-v2 DDL. Existing v1 business statements stay byte-for-byte frozen. */
export const SCHEMA_V2_MANIFEST = [
  SCHEMA_IDENTITY_V2,
  ...SCHEMA_MANIFEST.slice(1),
  ...EXECUTION_SCHEMA,
  ...EXECUTION_RUNTIME_SCHEMA,
] as const;

export const SCHEMA_V2_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify(SCHEMA_V2_MANIFEST))
  .digest("hex");
