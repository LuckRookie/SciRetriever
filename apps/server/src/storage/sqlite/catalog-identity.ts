import type { DatabaseSync } from "node:sqlite";
import type { RetrievalSchemaConfig } from "./retrieval-engine.js";

type Config = Omit<RetrievalSchemaConfig, "schema_version"> & {
  readonly schema_version: number;
};
export class CatalogLayoutError extends Error {
  readonly reason: "catalog-layout-not-current" | "catalog-integrity-refused";
  constructor(
    reason:
      | "catalog-layout-not-current"
      | "catalog-integrity-refused" = "catalog-integrity-refused",
  ) {
    super("catalog-layout-not-current");
    this.reason = reason;
  }
}
/** One schema inventory and singleton identities; never visits catalog data. */
export function readCatalogIdentity(
  db: DatabaseSync,
  config: Config,
  ignoreRetrieval = false,
): Record<string, unknown> | null {
  const actual = new Map(
    db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'",
      )
      .all()
      .map((r) => [String(r.name), r.sql]),
  );
  if (!actual.size) return null;
  if (!actual.has("schema_identity"))
    throw new CatalogLayoutError("catalog-layout-not-current");
  const identity = db
    .prepare(
      "SELECT product,schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1",
    )
    .get();
  if (
    identity?.product !== "sciretriever" ||
    identity.schema_version !== config.schema_version ||
    identity.schema_fingerprint !== config.schema_fingerprint
  )
    throw new CatalogLayoutError("catalog-layout-not-current");
  const allowed = new Set<string>();
  for (const sql of config.schema_manifest) {
    const name =
      /^CREATE (?:UNIQUE )?(?:VIRTUAL )?(?:TABLE|INDEX|TRIGGER|VIEW) ([a-z_][a-z0-9_]*)/u.exec(
        sql,
      )?.[1];
    if (!name) throw new CatalogLayoutError();
    allowed.add(name);
    const derived =
      (ignoreRetrieval && name.startsWith("retrieval_")) ||
      [
        "processor_record_projection",
        "processor_projection_state",
        "processor_result_fts",
        "processor_collection_fts",
      ].includes(name);
    if (!derived && actual.get(name) !== sql) throw new CatalogLayoutError();
  }
  for (const prefix of [
    "literature_search_fts",
    "tag_search",
    "retrieval_fts",
    "processor_result_fts",
    "processor_collection_fts",
  ])
    for (const suffix of ["data", "idx", "content", "docsize", "config"])
      allowed.add(`${prefix}_${suffix}`);
  if ([...actual.keys()].some((name) => !allowed.has(name)))
    throw new CatalogLayoutError();

  const execution = db
    .prepare(
      "SELECT version,fingerprint FROM execution_schema_identity WHERE singleton=1",
    )
    .get();
  const runtime = db
    .prepare(
      "SELECT version,fingerprint FROM execution_runtime_schema_identity WHERE singleton=1",
    )
    .get();
  if (
    execution?.version !== config.execution_schema_version ||
    execution.fingerprint !== config.execution_schema_fingerprint ||
    runtime?.version !== config.execution_runtime_schema_version ||
    runtime.fingerprint !== config.execution_runtime_schema_fingerprint
  )
    throw new CatalogLayoutError();
  return identity;
}
