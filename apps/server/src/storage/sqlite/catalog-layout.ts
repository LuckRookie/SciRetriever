import type { DatabaseSync } from "node:sqlite";
import type * as ExecutionSchema from "./execution-schema.js";
import type * as Schema from "./schema.js";
const { SCHEMA_VERSION, SCHEMA_FINGERPRINT, SCHEMA_MANIFEST }: typeof Schema =
  await import(
    new URL(
      import.meta.url.endsWith(".ts") ? "./schema.ts" : "./schema.js",
      import.meta.url,
    ).href
  );
const {
  EXECUTION_SCHEMA_VERSION,
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
}: typeof ExecutionSchema = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./execution-schema.ts"
      : "./execution-schema.js",
    import.meta.url,
  ).href
);

export const CURRENT_CATALOG_CONFIG = Object.freeze({
  schema_version: SCHEMA_VERSION,
  schema_fingerprint: SCHEMA_FINGERPRINT,
  schema_manifest: SCHEMA_MANIFEST,
  execution_schema_version: EXECUTION_SCHEMA_VERSION,
  execution_schema_fingerprint: EXECUTION_SCHEMA_FINGERPRINT,
  execution_runtime_schema_version: EXECUTION_RUNTIME_SCHEMA_VERSION,
  execution_runtime_schema_fingerprint: EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
});

/** Only creates an empty current catalog. Existing catalogs are never changed implicitly. */
export function initializeCurrentCatalog(
  db: DatabaseSync,
  createdAt = new Date().toISOString(),
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' LIMIT 1",
        )
        .get()
    )
      throw new Error("catalog-initialization-target-not-empty");
    for (const sql of SCHEMA_MANIFEST) db.exec(sql);
    db.prepare(
      "INSERT INTO schema_identity VALUES(1,'sciretriever',?,?,?)",
    ).run(SCHEMA_VERSION, SCHEMA_FINGERPRINT, createdAt);
    db.prepare("INSERT INTO execution_schema_identity VALUES(1,?,?)").run(
      EXECUTION_SCHEMA_VERSION,
      EXECUTION_SCHEMA_FINGERPRINT,
    );
    db.prepare(
      "INSERT INTO execution_runtime_schema_identity VALUES(1,?,?)",
    ).run(
      EXECUTION_RUNTIME_SCHEMA_VERSION,
      EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
    );
    db.exec(
      "INSERT INTO retrieval_source_revision VALUES(1,0); INSERT INTO retrieval_change_state VALUES(1,0); INSERT INTO vocabulary_state VALUES(1,0,0)",
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
