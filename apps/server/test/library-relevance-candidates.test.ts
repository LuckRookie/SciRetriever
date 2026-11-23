import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { parseLibrarySearchRequest } from "@sciretriever/contracts";
import type { LibraryPageQuery } from "../src/literature/query.js";
import { initializeCurrentCatalog } from "../src/storage/sqlite/catalog-layout.js";
import {
  LibraryRelevanceCache,
  libraryPageIds,
} from "../src/storage/sqlite/library-page.js";
import { StoredLibraryState } from "../src/storage/sqlite/library-state.js";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const page: LibraryPageQuery = {
  query: parseLibrarySearchRequest({
    query: { text: "ranked", publication_year_from: 2020 },
  }).query,
  sort: "relevance",
  ftsQuery: '"ranked"',
  after: null,
  limit: 50,
  rankingKey: "ranked fixture",
};

function initialize(db: DatabaseSync) {
  initializeCurrentCatalog(db);
  new StoredLibraryState(db, { max_tags: 6, archive_profile: "vlm-engine" });
}

function add(
  db: DatabaseSync,
  doc: number,
  n: number,
  title = "ranked",
  year = 2026,
) {
  db.exec("BEGIN");
  db.prepare(
    "INSERT INTO meta_literatures(meta_literature_id,representative_literature_id) VALUES(?,?)",
  ).run(id(n), id(n));
  db.prepare(
    "INSERT INTO literatures(literature_id,meta_literature_id,version_role) VALUES(?,?,'published')",
  ).run(id(n), id(n));
  db.prepare(
    `INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title,publication_year)
     VALUES(?,1,?,?,?)`,
  ).run(id(n), "a".repeat(64), title, year);
  db.prepare(
    "INSERT INTO literature_search_fts(rowid,literature_id,title) VALUES(?,?,?)",
  ).run(doc, id(n), title);
  db.exec("COMMIT");
}

function allRanks(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT f.literature_id,bm25(literature_search_fts) AS relevance
     FROM literature_search_fts f JOIN literature_metadata m USING(literature_id)
     WHERE literature_search_fts MATCH '"ranked"' AND m.publication_year>=2020
     ORDER BY relevance,literature_id`,
    )
    .all();
}

it("preserves full BM25 scores and ID ties for a query at the candidate limit", () => {
  using db = new DatabaseSync(":memory:");
  initialize(db);
  db.function("sr_query_continue", () => 1);
  add(db, 10, 3, "ranked ranked");
  add(db, 20, 2);
  add(db, 30, 1);
  add(db, 40, 4, "ranked", 2019);
  add(db, 50, 5, "unrelated");
  const cache = new LibraryRelevanceCache(3);
  const exact = allRanks(db);
  const first = libraryPageIds(db, { ...page, limit: 1 }, cache);
  expect(first.total_count).toBe(3);
  expect(first.rows.map((row) => ({ ...row }))).toEqual(
    exact.slice(0, 2).map((row) => ({ ...row })),
  );
  expect(first).not.toHaveProperty("candidate_window");

  const anchor = exact[0]!;
  const resumed = libraryPageIds(
    db,
    {
      ...page,
      after: {
        literature_id: String(anchor.literature_id),
        value: Number(anchor.relevance),
        total: { total_count: 3 },
      },
    },
    cache,
  );
  expect(resumed.rows).toEqual(exact.slice(1));
  expect(resumed).not.toHaveProperty("candidate_window");
  expect(
    libraryPageIds(
      db,
      { ...page, query: { ...page.query, publication_year_from: 2030 } },
      cache,
    ),
  ).toMatchObject({ rows: [], total_count: 0 });
});

it("ranks only the newest qualifying matches and probes one extra hit", () => {
  using db = new DatabaseSync(":memory:");
  initialize(db);
  let visits = 0;
  db.function("sr_query_continue", () => {
    visits++;
    return 1;
  });
  add(db, 10, 1, "ranked ranked ranked");
  add(db, 20, 4, "ranked ordinary title");
  add(db, 30, 3, "ranked ranked");
  add(db, 40, 2, "ranked ranked");
  add(db, 50, 5, "ranked", 2019);
  const cache = new LibraryRelevanceCache(3);
  const first = libraryPageIds(db, page, cache);
  expect(first.total_count).toBe(4);
  expect(first.candidate_window).toEqual({
    oldest_rowid: "20",
    newest_rowid: "40",
    limit: 3,
  });
  expect(first.rows.map((row) => row.literature_id)).toEqual([
    id(2),
    id(3),
    id(4),
  ]);

  const resume = (total_count: number) => {
    visits = 0;
    // A v2-style cursor carries the already counted total into an uncached
    // ranking. Count work separately from the candidate scan.
    const result = libraryPageIds(
      db,
      {
        ...page,
        after: { literature_id: id(0), value: -1000, total: { total_count } },
      },
      cache,
    );
    expect(result.candidate_window).toEqual(first.candidate_window);
    expect(result.rows.map((row) => row.literature_id)).toEqual([
      id(2),
      id(3),
      id(4),
    ]);
    return visits;
  };
  const initialVisits = resume(4);
  expect(initialVisits).toBeGreaterThan(0);
  for (let n = 6; n <= 106; n++) add(db, -n, n);
  expect(resume(105)).toBe(initialVisits);
});

it("continues inside the original rowid interval after appends and a cache miss", () => {
  using db = new DatabaseSync(":memory:");
  initialize(db);
  db.function("sr_query_continue", () => 1);
  for (let n = 1; n <= 5; n++) add(db, n, n);
  const cache = new LibraryRelevanceCache(4);
  const first = libraryPageIds(db, { ...page, limit: 1 }, cache);
  expect(first.rows.map((row) => row.literature_id)).toEqual([id(2), id(3)]);
  const anchor = first.rows[0]!;
  const request: LibraryPageQuery = {
    ...page,
    after: {
      literature_id: String(anchor.literature_id),
      value: Number(anchor.relevance),
      total: { total_count: first.total_count },
      ranking_id: first.ranking_id!,
      candidate_window: first.candidate_window!,
    },
  };

  add(db, 6, 6, "ranked ranked ranked");
  db.prepare("DELETE FROM literature_search_fts WHERE rowid=?").run(4);
  // A cached result keeps the first ranking and returns current visible facts.
  const warm = libraryPageIds(db, request, cache);
  expect(warm.rows.map((row) => row.literature_id)).toEqual([
    id(3),
    id(4),
    id(5),
  ]);
  expect(warm.candidate_window).toEqual(first.candidate_window);
  // A fresh worker repeats MATCH within the old interval. Neither the newer
  // match nor the older match can move into the gap left by a reindexed item.
  const cold = libraryPageIds(db, request, new LibraryRelevanceCache(4));
  expect(cold.rows.map((row) => row.literature_id)).toEqual([id(3), id(5)]);
  expect(cold.candidate_window).toEqual(first.candidate_window);
  expect(cold.total_count).toBe(5);
});
