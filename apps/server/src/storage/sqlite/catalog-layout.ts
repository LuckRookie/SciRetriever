import type { DatabaseSync } from "node:sqlite";
import type * as ExecutionSchema from "./execution-schema.js";
import type * as Schema from "./schema.js";
import type { CatalogAddition } from "./catalog-ddl.js";
const {
  manifestWithAdditions,
  registerCatalogAddition,
}: typeof import("./catalog-ddl.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./catalog-ddl.ts" : "./catalog-ddl.js",
    import.meta.url,
  ).href
);
const {
  SCHEMA_VERSION,
  SCHEMA_FINGERPRINT,
  SCHEMA_MANIFEST,
  CATALOG_BASE_SCHEMA,
  CATALOG_ADDITIONS,
}: typeof Schema = await import(
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
  schema_additions: CATALOG_ADDITIONS,
  execution_schema_version: EXECUTION_SCHEMA_VERSION,
  execution_schema_fingerprint: EXECUTION_SCHEMA_FINGERPRINT,
  execution_runtime_schema_version: EXECUTION_RUNTIME_SCHEMA_VERSION,
  execution_runtime_schema_fingerprint: EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
});

export function catalogConfigFor(additions: readonly CatalogAddition[]) {
  return {
    ...CURRENT_CATALOG_CONFIG,
    schema_manifest: manifestWithAdditions(CATALOG_BASE_SCHEMA, additions),
    schema_additions: additions,
  };
}

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
      "INSERT INTO schema_identity(singleton,product,schema_version,schema_fingerprint,created_at) VALUES(1,'sciretriever',?,?,?)",
    ).run(SCHEMA_VERSION, SCHEMA_FINGERPRINT, createdAt);
    db.prepare(
      "INSERT INTO execution_schema_identity(singleton,version,fingerprint) VALUES(1,?,?)",
    ).run(EXECUTION_SCHEMA_VERSION, EXECUTION_SCHEMA_FINGERPRINT);
    db.prepare(
      "INSERT INTO execution_runtime_schema_identity(singleton,version,fingerprint) VALUES(1,?,?)",
    ).run(
      EXECUTION_RUNTIME_SCHEMA_VERSION,
      EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
    );
    db.exec(
      "INSERT INTO retrieval_source_revision(singleton,revision) VALUES(1,0); INSERT INTO retrieval_change_state(singleton,processed_position) VALUES(1,0); INSERT INTO vocabulary_state(singleton,version,consolidated_version) VALUES(1,0,0)",
    );
    for (const addition of CATALOG_ADDITIONS)
      registerCatalogAddition(db, addition, createdAt, true);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
