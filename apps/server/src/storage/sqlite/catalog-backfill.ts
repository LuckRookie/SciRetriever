import type { DatabaseSync } from "node:sqlite";
import type { CatalogAdditionRequirement } from "./catalog-ddl.js";

export const CATALOG_BACKFILL_WRITE_MS = 40;
const CATALOG_BACKFILL_MAX_KEYS = 1024;
const BACKFILL_SLICE_KEYS = 32;

/** A completed slice has moved its own cursor and can commit before yielding. */
export function visitCatalogBackfillSlices(
  shouldYield: () => boolean,
  visit: (keys: number) => boolean,
) {
  for (
    let keys = 0;
    keys < CATALOG_BACKFILL_MAX_KEYS;
    keys += BACKFILL_SLICE_KEYS
  )
    if (!visit(BACKFILL_SLICE_KEYS) || shouldYield()) return;
}

export function catalogBackfillPending(
  db: DatabaseSync,
  addition: CatalogAdditionRequirement,
): boolean {
  return !!db
    .prepare(
      "SELECT 1 FROM catalog_schema_additions WHERE name=? AND backfill_step<?",
    )
    .get(addition.name, addition.backfill_steps.length);
}

export type CatalogBackfillStep<T> = (cursor: unknown) => {
  readonly done: boolean;
  readonly cursor: unknown;
  readonly value: T;
};

/** Use the caller's short admitted write transaction for both work and progress. */
export function runCatalogBackfillBatch<T>(
  db: DatabaseSync,
  addition: CatalogAdditionRequirement,
  steps: Readonly<Record<string, CatalogBackfillStep<T>>>,
): T | undefined {
  if (!db.isTransaction)
    throw new Error("catalog backfill requires a write transaction");
  const row = db
    .prepare(
      "SELECT backfill_step,backfill_cursor_json FROM catalog_schema_additions WHERE name=?",
    )
    .get(addition.name);
  if (!row) throw new Error("catalog backfill addition is missing");
  const position = Number(row.backfill_step);
  const name = addition.backfill_steps[position];
  if (name === undefined) return undefined;
  const run = steps[name];
  if (!run) throw new Error("catalog backfill step is missing");
  const result = run(JSON.parse(String(row.backfill_cursor_json)) as unknown);
  db.prepare(
    "UPDATE catalog_schema_additions SET backfill_step=?,backfill_cursor_json=? WHERE name=?",
  ).run(
    position + Number(result.done),
    JSON.stringify(result.done ? null : result.cursor),
    addition.name,
  );
  return result.value;
}
