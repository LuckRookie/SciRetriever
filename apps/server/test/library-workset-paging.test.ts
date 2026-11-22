import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { LiteratureQueryService } from "../src/literature/query.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import {
  initializeCurrentCatalog,
  CURRENT_CATALOG_CONFIG,
} from "../src/storage/sqlite/catalog-layout.js";
import { migrateLiteratureSearchSchema } from "../src/storage/sqlite/literature-search-schema-migration.js";
import {
  refreshDiscoveryIntegrity,
  refreshDiscoveryMembers,
} from "../src/storage/sqlite/library-paging-schema.js";
import {
  SCHEMA_FINGERPRINT_V19_COUNTS,
  SCHEMA_MANIFEST_V19_COUNTS,
  SCHEMA_VERSION,
} from "../src/storage/sqlite/schema.js";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const day = (n: number) =>
  `2026-10-${String(n).padStart(2, "0")}T00:00:00.000Z`;
const folder = id(101);
const child = id(102);
const batch = id(103);
const run = id(104);

it("seeks the full projection keys when a discovery replacement can affect two owners", () => {
  using db = new DatabaseSync(":memory:");
  initializeCurrentCatalog(db);
  const staged =
    "FROM library_discovery_replaced WHERE source='citation_discovery_causes'";
  const members = refreshDiscoveryMembers(
    `SELECT 'run' AS scope_id,'paper' AS literature_id UNION
     SELECT discovery_run_id,actual_literature_id ${staged}`,
  )[0]!;
  const validation = refreshDiscoveryIntegrity(
    `SELECT 'run' AS discovery_run_id,'meta' AS meta_literature_id UNION
     SELECT discovery_run_id,meta_literature_id ${staged}`,
  )[0]!;
  const plan = (sql: string) =>
    db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((row) => row.detail);
  expect(plan(members)).toContain(
    "SEARCH library_ordered_members USING PRIMARY KEY (kind=? AND scope_id=? AND literature_id=?)",
  );
  expect(plan(validation)).toContain(
    "SEARCH library_discovery_invalid USING PRIMARY KEY (discovery_run_id=? AND meta_literature_id=?)",
  );
});

function seedBooks(db: DatabaseSync, n: number) {
  for (let i = 1; i <= n; i++) {
    db.prepare("INSERT INTO meta_literatures VALUES(?,?)").run(id(i), id(i));
    db.prepare("INSERT INTO literatures VALUES(?,?,'published')").run(
      id(i),
      id(i),
    );
    db.prepare(
      "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title) VALUES(?,1,?,?)",
    ).run(id(i), "a".repeat(64), "Synthetic version " + i);
    db.prepare(
      "UPDATE literature_intake SET intake_at=? WHERE literature_id=?",
    ).run(day(i), id(i));
  }
}
function folders(db: DatabaseSync) {
  const insert = db.prepare("INSERT INTO folders VALUES(?,?,?,0,?,?)");
  insert.run(folder, null, "Folder", day(1), day(1));
  insert.run(child, folder, "Child", day(1), day(1));
}
function addFolder(db: DatabaseSync, dest: string, paper: number, n: number) {
  db.prepare("INSERT INTO folder_members VALUES(?,?,?,'local:cli')").run(
    dest,
    id(paper),
    day(n),
  );
}
async function drain(worker: SqliteWorker) {
  while (await worker.libraryStatePending()) {
    if (!(await worker.refreshLibraryState()).more) break;
  }
}

it("migrates the first selection timestamp from the earliest evidence, preserves unknowns, and registers new selections transactionally", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-paging-history-"));
  const path = join(home, "catalog.sqlite");
  const db = new DatabaseSync(path);
  const worker = new SqliteWorker(path);
  const library = new LiteratureQueryService(worker);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; BEGIN");
    for (const sql of SCHEMA_MANIFEST_V19_COUNTS) db.exec(sql);
    const config = CURRENT_CATALOG_CONFIG;
    db.prepare(
      "INSERT INTO schema_identity VALUES(1,'sciretriever',?,?,?)",
    ).run(SCHEMA_VERSION, SCHEMA_FINGERPRINT_V19_COUNTS, day(1));
    db.prepare("INSERT INTO execution_schema_identity VALUES(1,?,?)").run(
      config.execution_schema_version,
      config.execution_schema_fingerprint,
    );
    db.prepare(
      "INSERT INTO execution_runtime_schema_identity VALUES(1,?,?)",
    ).run(
      config.execution_runtime_schema_version,
      config.execution_runtime_schema_fingerprint,
    );
    db.exec(
      "INSERT INTO retrieval_source_revision VALUES(1,0); INSERT INTO retrieval_change_state VALUES(1,0); INSERT INTO vocabulary_state VALUES(1,0,0)",
    );
    seedBooks(db, 4);
    folders(db);
    addFolder(db, folder, 1, 6);
    db.prepare("INSERT INTO reading_history VALUES(?,?,2)").run(id(1), day(3));
    db.prepare("INSERT INTO reading_history VALUES(?,?,1)").run(id(2), day(5));
    db.prepare("INSERT INTO library_collected VALUES(?,?)").run(id(3), day(3));
    db.exec("COMMIT");
    await migrateLiteratureSearchSchema(path);
    await worker.configureLibraryState(6, "vlm-engine");
    const request = {
      query: { collection_scope: "collected" },
      sort: "collected-desc",
      limit: 1,
    };
    const collect = async () => {
      const result: [string, string | null | undefined][] = [];
      let cursor: string | null = null;
      do {
        const page = await library.search({ ...request, cursor });
        result.push(
          ...page.items.map((row): [string, string | null | undefined] => [
            row.literature.literature_id,
            row.collected_at,
          ]),
        );
        cursor = page.next_cursor;
      } while (cursor);
      return result;
    };
    const historical = [
      [id(2), day(5)],
      [id(1), day(3)],
      [id(3), null],
    ];
    expect(await collect()).toEqual(historical);
    await worker.refreshLibraryState();
    await drain(worker);
    expect(await collect()).toEqual(historical);
    expect(
      (
        await library.search({ ...request, sort: "intake-desc", limit: 3 })
      ).items.map((row) => row.literature.literature_id),
    ).toEqual([id(3), id(2), id(1)]);

    const sql = db.prepare(
      "SELECT collected_at FROM library_collection_times WHERE literature_id=?",
    );
    db.exec("BEGIN");
    addFolder(db, folder, 4, 2);
    expect(sql.get(id(4))?.collected_at).toEqual(expect.any(String));
    db.exec("ROLLBACK");
    expect(sql.get(id(4))).toBeUndefined();
    await worker.collectLiteratures([id(4)]);
    const first = sql.get(id(4))?.collected_at;
    expect(first).toEqual(expect.any(String));
    addFolder(db, folder, 4, 8);
    db.prepare("DELETE FROM folder_members WHERE literature_id=?").run(id(4));
    expect(sql.get(id(4))?.collected_at).toBe(first);
    expect(sql.get(id(1))?.collected_at).toBe(day(3));
    expect(
      (await library.search({ query: {}, limit: 1 }, undefined, "browse"))
        .items[0]?.literature.literature_id,
    ).toBe(id(4));
  } finally {
    db.close();
    await worker.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

it("asks the ordered members for current facts and rejects a run whose cause became invalid through direct SQL", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-paging-members-"));
  const path = join(home, "catalog.sqlite");
  const db = new DatabaseSync(path);
  const worker = new SqliteWorker(path);
  const library = new LiteratureQueryService(worker);
  try {
    initializeCurrentCatalog(db);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
    await worker.configureLibraryState(6, "vlm-engine");
    expect(await worker.libraryStatePending()).toBe(false);
    db.exec("BEGIN");
    seedBooks(db, 5);
    folders(db);
    addFolder(db, child, 1, 4);
    addFolder(db, child, 2, 4);
    addFolder(db, folder, 1, 4);
    addFolder(db, folder, 3, 4);
    db.prepare(
      "INSERT INTO intake_batches(batch_id,kind,default_label,origin,created_at,state,result,initiated_by,request_json) VALUES(?,'citation','Fixture','cli',?,'finished','completed','local:cli','{}')",
    ).run(batch, day(1));
    db.prepare(
      "INSERT INTO intake_batch_members VALUES(?,?,'matched'),(?,?,'matched')",
    ).run(batch, id(2), batch, id(3));
    db.prepare(
      "INSERT INTO discovery_runs VALUES(?,'citation','COMPLETED',?)",
    ).run(run, day(1));
    db.prepare(
      "INSERT INTO citation_discovery_inputs VALUES(?,'citation','references',1,10)",
    ).run(run);
    const discovered = db.prepare("INSERT INTO discovery_results VALUES(?,?)");
    const cause = db.prepare(
      "INSERT INTO citation_discovery_causes VALUES(?,?,?,?,?,1)",
    );
    for (const n of [2, 3, 4]) {
      discovered.run(run, id(n));
      cause.run(run, id(n), id(5), id(n), id(n));
    }
    db.exec("COMMIT");
    const pages = async (query: object) => {
      let cursor: string | null = null;
      const ids: string[] = [];
      do {
        const page = await library.search({
          query,
          sort: "intake-desc",
          limit: 1,
          cursor,
        });
        ids.push(...page.items.map((row) => row.literature.literature_id));
        cursor = page.next_cursor;
      } while (cursor);
      return ids;
    };
    const folderQuery = { folder: { id: folder, include_descendants: true } };
    const discoveryQuery = { discovery_run_ids: [run] };
    expect(await pages(folderQuery)).toEqual([id(3), id(2), id(1)]);
    expect(await pages({ intake_batch_ids: [batch] })).toEqual([id(3), id(2)]);
    expect(await pages(discoveryQuery)).toEqual([id(4), id(3), id(2)]);
    db.prepare(
      "UPDATE literature_intake SET intake_at=? WHERE literature_id=?",
    ).run(day(9), id(2));
    expect(await pages(discoveryQuery)).toEqual([id(2), id(4), id(3)]);
    expect(await pages(folderQuery)).toEqual([id(2), id(3), id(1)]);
    db.prepare("UPDATE folders SET parent_id=NULL WHERE folder_id=?").run(
      child,
    );
    expect(await pages(folderQuery)).toEqual([id(3), id(1)]);
    db.prepare(
      "INSERT INTO intake_withdrawn_objects VALUES('literature',?,?,?)",
    ).run(id(5), batch, day(8));
    expect(await pages(discoveryQuery)).toEqual([]);
    db.exec("DELETE FROM intake_withdrawn_objects");
    expect(await pages(discoveryQuery)).toEqual([id(2), id(4), id(3)]);

    db.exec("PRAGMA foreign_keys=OFF; PRAGMA recursive_triggers=OFF");
    discovered.run(run, id(5));
    db.prepare(
      "INSERT OR REPLACE INTO citation_discovery_causes VALUES(?,?,?,?,?,1)",
    ).run(run, id(5), id(5), id(2), id(5));
    // The implicit delete removed the sole cause for Meta 2.
    await expect(pages(discoveryQuery)).rejects.toMatchObject({
      code: "sqlite-worker",
    });
    db.prepare(
      "DELETE FROM discovery_results WHERE discovery_run_id=? AND meta_literature_id=?",
    ).run(run, id(2));
    expect(await pages(discoveryQuery)).toEqual([id(5), id(4), id(3)]);
  } finally {
    db.close();
    await worker.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
