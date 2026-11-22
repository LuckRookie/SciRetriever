import type { DatabaseSync } from "node:sqlite";
import type { RetrievalSchemaConfig } from "./retrieval-engine.js";
import type * as CatalogDdl from "./catalog-ddl.js";

const {
  appendedColumns,
  catalogObjects,
  manifestObject,
  objectKey,
  CATALOG_ADDITIONS_TABLE,
  CATALOG_ADDITION_REQUIRED,
}: typeof CatalogDdl = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./catalog-ddl.ts" : "./catalog-ddl.js",
    import.meta.url,
  ).href
);

type Config = Omit<RetrievalSchemaConfig, "schema_version"> & {
  readonly schema_version: number;
};
export class CatalogLayoutError extends Error {
  readonly reason:
    | "catalog-layout-not-current"
    | "catalog-integrity-refused"
    | typeof CATALOG_ADDITION_REQUIRED;
  readonly addition?: string;

  constructor(
    reason: CatalogLayoutError["reason"] = "catalog-integrity-refused",
    addition?: string,
  ) {
    super(
      reason === CATALOG_ADDITION_REQUIRED
        ? `required catalog addition is missing: ${addition}`
        : "catalog-layout-not-current",
    );
    this.reason = reason;
    if (addition !== undefined) this.addition = addition;
  }
}

export interface CatalogAdditionStatus {
  readonly name: string;
  readonly ddl_fingerprint: string;
  readonly applied_at: string;
  readonly backfill_step: number;
  readonly backfill_cursor: unknown;
}

function readAdditions(db: DatabaseSync): CatalogAdditionStatus[] {
  const rows = db
    .prepare(
      "SELECT name,ddl_fingerprint,applied_at,backfill_step,backfill_cursor_json FROM catalog_schema_additions ORDER BY name",
    )
    .all();
  return rows.map((row) => {
    if (
      typeof row.name !== "string" ||
      !row.name.length ||
      typeof row.ddl_fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/u.test(row.ddl_fingerprint) ||
      typeof row.applied_at !== "string" ||
      !Number.isFinite(Date.parse(row.applied_at)) ||
      typeof row.backfill_step !== "number" ||
      !Number.isSafeInteger(row.backfill_step) ||
      row.backfill_step < 0 ||
      typeof row.backfill_cursor_json !== "string"
    )
      throw new CatalogLayoutError();
    return {
      name: row.name,
      ddl_fingerprint: row.ddl_fingerprint,
      applied_at: row.applied_at,
      backfill_step: row.backfill_step,
      backfill_cursor: JSON.parse(row.backfill_cursor_json) as unknown,
    };
  });
}

const rebuildableProcessorTables = new Set([
  "processor_record_projection",
  "processor_projection_state",
  "processor_result_fts",
  "processor_collection_fts",
]);
const ftsShadows = [
  "literature_search_fts",
  "tag_search",
  "retrieval_fts",
  "processor_result_fts",
  "processor_collection_fts",
].flatMap((prefix) =>
  ["data", "idx", "content", "docsize", "config"].map(
    (suffix) => `table:${prefix}_${suffix}`,
  ),
);

function readBaseIdentity(db: DatabaseSync, config: Config) {
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
  return identity;
}

function requiredAdditions(db: DatabaseSync, config: Config) {
  const additions = config.schema_additions ? readAdditions(db) : [];
  const installed = new Map(
    additions.map((addition) => [addition.name, addition]),
  );
  for (const requirement of config.schema_additions ?? []) {
    const entry = installed.get(requirement.name);
    if (!entry)
      throw new CatalogLayoutError(CATALOG_ADDITION_REQUIRED, requirement.name);
    if (
      entry.ddl_fingerprint !== requirement.ddl_fingerprint ||
      entry.backfill_step > requirement.backfill_steps.length
    )
      throw new CatalogLayoutError();
  }
  return additions;
}

function checkExecutionIdentity(db: DatabaseSync, config: Config) {
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
}

/** Recheck the version records when a proven layout is reopened after another writer. */
export function checkCatalogIdentityRows(db: DatabaseSync, config: Config) {
  const identity = readBaseIdentity(db, config);
  requiredAdditions(db, config);
  checkExecutionIdentity(db, config);
  return identity;
}

/** One schema inventory and singleton identities. Historical manifests remain exact. */
export function readCatalogLayout(
  db: DatabaseSync,
  config: Config,
  ignoreRetrieval = false,
) {
  const actual = catalogObjects(db);
  if (!actual.size) return null;
  if (!actual.has("table:schema_identity"))
    throw new CatalogLayoutError("catalog-layout-not-current");
  const identity = readBaseIdentity(db, config);
  const requirements = config.schema_additions;
  if (requirements) {
    const registry = actual.get(`table:${CATALOG_ADDITIONS_TABLE}`);
    if (!registry)
      throw new CatalogLayoutError(
        CATALOG_ADDITION_REQUIRED,
        requirements[0]?.name,
      );
    const registrySql = config.schema_manifest.find((sql) =>
      sql.startsWith(`CREATE TABLE ${CATALOG_ADDITIONS_TABLE}(`),
    );
    const expected = registrySql && manifestObject(registrySql);
    if (
      !expected ||
      (expected.sql !== registry.sql &&
        !appendedColumns(db, expected, registry))
    )
      throw new CatalogLayoutError();
  }
  const additions = requiredAdditions(db, config);

  const allowed = new Set(ftsShadows);
  const extra_columns: CatalogDdl.CatalogExtraColumn[] = [];
  for (const sql of config.schema_manifest) {
    const object = manifestObject(sql);
    const key = objectKey(object);
    allowed.add(key);
    const found = actual.get(key);
    if (
      (ignoreRetrieval && object.name.startsWith("retrieval_")) ||
      rebuildableProcessorTables.has(object.name) ||
      found?.sql === sql
    )
      continue;
    const additional =
      requirements && found ? appendedColumns(db, object, found) : null;
    if (!additional) throw new CatalogLayoutError();
    extra_columns.push(...additional);
  }
  const extra_objects = [...actual]
    .filter(([key]) => !allowed.has(key))
    .map(([, { type, name }]) => ({ type, name }));
  if (!requirements && extra_objects.length) throw new CatalogLayoutError();

  checkExecutionIdentity(db, config);
  return { identity, additions, extra_objects, extra_columns };
}

export function readCatalogIdentity(
  db: DatabaseSync,
  config: Config,
  ignoreRetrieval = false,
): Record<string, unknown> | null {
  return readCatalogLayout(db, config, ignoreRetrieval)?.identity ?? null;
}
