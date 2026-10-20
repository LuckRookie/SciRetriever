import { createHash } from "node:crypto";
import type * as Schema from "./schema.js";
const { SCHEMA_MANIFEST }: typeof Schema = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./schema.ts" : "./schema.js",
    import.meta.url,
  ).href
);
/** Runtime-owned subsets of the one current catalog, never independently installed. */
export const EXECUTION_SCHEMA_VERSION = 1;
export const EXECUTION_RUNTIME_SCHEMA_VERSION = 1;
export const EXECUTION_SCHEMA = SCHEMA_MANIFEST.filter((sql) =>
  /^CREATE TABLE execution_(schema_identity|candidates|receipts)\(/u.test(sql),
);
export const EXECUTION_RUNTIME_SCHEMA = SCHEMA_MANIFEST.filter(
  (sql) =>
    /^CREATE (?:UNIQUE INDEX|TABLE) execution_/u.test(sql) &&
    !EXECUTION_SCHEMA.includes(sql),
);
export const EXECUTION_SCHEMA_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify(EXECUTION_SCHEMA))
  .digest("hex");
export const EXECUTION_RUNTIME_SCHEMA_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify(EXECUTION_RUNTIME_SCHEMA))
  .digest("hex");
