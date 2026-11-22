import type { DatabaseSync } from "node:sqlite";

const suffix = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const { nameCatalogInsertColumns }: typeof import("./catalog-ddl.js") =
  await import(new URL("./catalog-ddl" + suffix, import.meta.url).href);
const {
  refreshDiscoveryIntegrity,
  refreshDiscoveryMembers,
  refreshFolderMembers,
  refreshIntakeMembers,
}: typeof import("./library-paging-schema.js") = await import(
  new URL("./library-paging-schema" + suffix, import.meta.url).href
);
const { historicalCollectionTimeSql }: typeof import("./schema.js") =
  await import(new URL("./schema" + suffix, import.meta.url).href);

const range = "WHERE rowid BETWEEN ? AND ?";
const stages = [
  {
    table: "library_collected",
    writes: [
      `INSERT INTO library_collection_times(literature_id,collected_at)
       SELECT c.literature_id,${historicalCollectionTimeSql("c.literature_id")}
       FROM library_collected c ${range} AND NOT EXISTS(
         SELECT 1 FROM library_collection_times t WHERE t.literature_id=c.literature_id
       ) ON CONFLICT DO NOTHING`,
    ],
  },
  {
    table: "folder_members",
    writes: refreshFolderMembers(
      `SELECT DISTINCT literature_id FROM folder_members ${range}`,
    ),
  },
  {
    table: "intake_batch_members",
    writes: refreshIntakeMembers(
      `SELECT batch_id AS scope_id,literature_id FROM intake_batch_members ${range}`,
    ),
  },
  ...(["topic_discovery_causes", "citation_discovery_causes"] as const).map(
    (table) => ({
      table,
      writes: [
        ...refreshDiscoveryMembers(
          `SELECT DISTINCT discovery_run_id AS scope_id,actual_literature_id AS literature_id FROM ${table} ${range}`,
        ),
        ...refreshDiscoveryIntegrity(
          `SELECT DISTINCT discovery_run_id,meta_literature_id FROM ${table} ${range}`,
        ),
      ],
    }),
  ),
  {
    table: "discovery_results",
    writes: refreshDiscoveryIntegrity(
      `SELECT discovery_run_id,meta_literature_id FROM discovery_results ${range}`,
    ),
  },
];

export function libraryPagingReady(db: DatabaseSync): boolean {
  return !!db
    .prepare(
      "SELECT 1 FROM library_paging_progress WHERE singleton=1 AND stage=?",
    )
    .get(stages.length);
}

export function initializeLibraryPaging(db: DatabaseSync) {
  // An empty catalog has no historical members. New facts already have triggers.
  db.prepare(
    `INSERT INTO library_paging_progress(singleton,stage,after_rowid)
     SELECT 1,?,NULL WHERE NOT EXISTS(SELECT 1 FROM literatures)
       AND NOT EXISTS(SELECT 1 FROM discovery_results)
       AND NOT EXISTS(SELECT 1 FROM topic_discovery_causes)
       AND NOT EXISTS(SELECT 1 FROM citation_discovery_causes)
     ON CONFLICT DO NOTHING`,
  ).run(stages.length);
}

/** Used by 04 before inserting its historical selections into library_collected. */
export function backfillCollection(
  db: DatabaseSync,
  ids: string,
  historicalSelection: string,
) {
  db.prepare(
    `INSERT INTO library_collection_times(literature_id,collected_at)
     SELECT l.literature_id,${historicalCollectionTimeSql("l.literature_id")}
     FROM json_each(?) j CROSS JOIN literatures l ON l.literature_id=j.value
     WHERE NOT EXISTS(SELECT 1 FROM library_collection_times c WHERE c.literature_id=l.literature_id)
       AND ${historicalSelection} ON CONFLICT DO NOTHING`,
  ).run(ids);
  db.prepare(
    `INSERT INTO library_collected(literature_id,intake_at)
     SELECT l.literature_id,i.intake_at FROM json_each(?) j
     CROSS JOIN literatures l ON l.literature_id=j.value
     JOIN library_collection_times t ON t.literature_id=l.literature_id
     LEFT JOIN literature_intake i ON i.literature_id=l.literature_id
     WHERE true ON CONFLICT DO NOTHING`,
  ).run(ids);
}

/** Run under catalog admission. Readers keep using facts until all stages commit. */
export function backfillLibraryPaging(db: DatabaseSync, limit: number) {
  const progress = db.prepare(
    "SELECT stage,after_rowid FROM library_paging_progress WHERE singleton=1",
  );
  progress.setReadBigInts(true);
  const row = progress.get();
  let stage = Number(row?.stage ?? 0);
  let previous = row?.after_rowid ?? null;
  let remaining = limit;
  while (stage < stages.length && remaining > 0) {
    const input = stages[stage]!;
    const select = db.prepare(
      `SELECT rowid AS position FROM ${input.table} ${previous === null ? "" : "WHERE rowid>?"} ORDER BY rowid LIMIT ?`,
    );
    select.setReadBigInts(true);
    const page =
      previous === null
        ? select.all(remaining)
        : select.all(previous, remaining);
    const first = page[0]?.position;
    const last = page.at(-1)?.position;
    if (first !== undefined && last !== undefined)
      for (const sql of input.writes)
        db.prepare(nameCatalogInsertColumns(sql)).run(first, last);
    if (page.length < remaining) {
      stage++;
      previous = null;
    } else previous = last!;
    remaining -= page.length;
  }
  db.prepare(
    "INSERT INTO library_paging_progress(singleton,stage,after_rowid) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET stage=excluded.stage,after_rowid=excluded.after_rowid",
  ).run(stage, previous);
  return stage < stages.length;
}
