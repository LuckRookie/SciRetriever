import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  parseLibrarySearchRequest,
  parseLiteratureId,
  sha256,
} from "@sciretriever/contracts";
import {
  LiteratureQueryService,
  queryFingerprint,
  type LibraryPageQuery,
  type LibraryQueryRepository,
} from "../src/literature/query.js";
import { initializeCurrentCatalog } from "../src/storage/sqlite/catalog-layout.js";
import {
  LibraryRelevanceCache,
  libraryPageIds,
  libraryCounts,
  libraryFacets,
} from "../src/storage/sqlite/library-page.js";
import { StoredLibraryState } from "../src/storage/sqlite/library-state.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

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
  db.function("sr_query_continue", () => 1);
  db.function("sr_normalize", (value) =>
    typeof value === "string" ? value.toLowerCase() : null,
  );
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

function allRanks(db: DatabaseSync, fts = '"ranked"') {
  return db
    .prepare(
      `SELECT f.literature_id,bm25(literature_search_fts) AS relevance
     FROM literature_search_fts f JOIN literature_metadata m USING(literature_id)
     WHERE literature_search_fts MATCH ? AND m.publication_year>=2020
     ORDER BY relevance,literature_id`,
    )
    .all(fts);
}

it("preserves full BM25 scores and ID ties for a query at the candidate limit", () => {
  using db = new DatabaseSync(":memory:");
  initialize(db);
  add(db, 10, 3, "ranked ranked");
  add(db, 20, 2);
  add(db, 30, 1);
  add(db, 40, 4, "ranked", 2019);
  add(db, 50, 5, "unrelated");
  const cache = new LibraryRelevanceCache(4);
  const exact = allRanks(db);
  const first = libraryPageIds(db, { ...page, limit: 1 }, cache);
  expect(first.total_count).toBe(3);
  expect(first.rows.map((row) => ({ ...row }))).toEqual(
    exact.slice(0, 2).map((row) => ({ ...row })),
  );
  expect(first).not.toHaveProperty("search_window");
  expect(
    libraryPageIds(db, { ...page, sort: "title-asc" }, cache).total_count,
  ).toBe(3);

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
  expect(resumed).not.toHaveProperty("search_window");
  expect(
    libraryPageIds(
      db,
      { ...page, query: { ...page.query, publication_year_from: 2030 } },
      cache,
    ),
  ).toMatchObject({ rows: [], total_count: 0 });
});

it("checks only the raw hits in a window even when an author filter finds nothing", () => {
  using db = new DatabaseSync(":memory:");
  initialize(db);
  let visitedAuthors = 0;
  db.function("sr_normalize", (value) => {
    if (value === "An Author") visitedAuthors++;
    return typeof value === "string" ? value.toLowerCase() : null;
  });
  const author = db.prepare(
    "INSERT INTO literature_metadata_authors(literature_id,ordinal,kind,display_name) VALUES(?,0,'unknown','An Author')",
  );
  const addAuthor = (n: number) => {
    add(db, n, n);
    author.run(id(n));
  };
  for (let n = 200; n <= 205; n++) addAuthor(n);
  const request = { ...page, query: { ...page.query, author: "Nobody" } };
  const scan = () => {
    visitedAuthors = 0;
    expect(
      libraryPageIds(db, request, new LibraryRelevanceCache(3)),
    ).toMatchObject({
      rows: [],
      total_count: 0,
      scan_incomplete: true,
      search_window: {
        oldest_rowid: "203",
        newest_rowid: "205",
        limit: 3,
        scan_incomplete: true,
      },
    });
    expect(visitedAuthors).toBe(3);
  };
  scan();
  for (let n = 1; n < 200; n++) addAuthor(n);
  scan();
  for (const sort of [
    "title-asc",
    "intake-desc",
    "publication-year-desc",
  ] as const)
    expect(() =>
      libraryPageIds(db, { ...request, sort }, new LibraryRelevanceCache(3)),
    ).toThrow(expect.objectContaining({ code: "library-sort-scope-limit" }));
});

it("reports only this window's matches and exposes the same scope for counts and facets", () => {
  using db = new DatabaseSync(":memory:");
  initialize(db);
  for (let n = 1; n <= 6; n++) add(db, n, n, "ranked", n === 6 ? 2019 : 2026);
  db.prepare(
    "INSERT INTO literature_metadata_keywords(literature_id, ordinal, keyword) VALUES(?,0,?)",
  ).run(id(2), "earlier");
  const cache = new LibraryRelevanceCache(3);
  const latest = libraryPageIds(db, page, cache);
  expect(latest.total_count).toBe(2);
  expect(latest.count_truncated).toBeUndefined();
  expect(latest.scan_incomplete).toBe(true);
  expect(latest.rows.map(({ literature_id }) => literature_id)).toEqual([
    id(4),
    id(5),
  ]);
  expect(
    libraryCounts(
      db,
      page.query,
      page.ftsQuery,
      false,
      Date.now(),
      undefined,
      3,
    ),
  ).toMatchObject({ total: 2, scan_incomplete: true });
  expect(
    libraryFacets(
      db,
      page.query,
      page.ftsQuery,
      10,
      false,
      Date.now(),
      undefined,
      3,
    ),
  ).toMatchObject({ total: 2, scan_incomplete: true, keywords: [] });

  add(db, 7, 7); // A new index entry belongs to the newer end of the scan.
  const before = latest.search_window!.oldest_rowid;
  const earlier = libraryPageIds(db, { ...page, beforeRowid: before }, cache);
  expect(earlier).not.toHaveProperty("scan_incomplete");
  expect(earlier.total_count).toBe(3);
  expect(earlier.rows.map(({ literature_id }) => literature_id)).toEqual([
    id(1),
    id(2),
    id(3),
  ]);
  expect(
    libraryCounts(db, page.query, page.ftsQuery, false, Date.now(), before, 3),
  ).toMatchObject({ total: 3 });
  const facets = libraryFacets(
    db,
    page.query,
    page.ftsQuery,
    10,
    false,
    Date.now(),
    before,
    3,
  );
  expect(facets).not.toHaveProperty("scan_incomplete");
  expect(facets).toMatchObject({
    total: 3,
    keywords: [{ value: "earlier", count: 1, tag: null }],
  });
});

it("counts sparse collected matches without an FTS seek for every member", () => {
  using db = new DatabaseSync(":memory:");
  initialize(db);
  let visits = 0;
  db.function("sr_query_continue", () => {
    visits++;
    return 1;
  });
  const collect = db.prepare(
    "INSERT INTO library_collected(literature_id,intake_at) VALUES(?,NULL)",
  );
  const addPaper = (n: number) => {
    add(db, n, n, `Paper ${String(n).padStart(5, "0")}`);
    collect.run(id(n));
  };
  addPaper(1);
  const query = parseLibrarySearchRequest({
    query: { text: "Paper 00001", collection_scope: "collected" },
  }).query;
  const ftsQuery = '"paper" AND "00001"';
  const reads = () => {
    visits = 0;
    expect(libraryCounts(db, query, ftsQuery)).toMatchObject({ total: 1 });
    expect(libraryFacets(db, query, ftsQuery, 10)).toMatchObject({ total: 1 });
    return visits;
  };
  const oneMember = reads();
  for (let n = 2; n <= 260; n++) addPaper(n);
  expect(reads()).toBe(oneMember);

  // The probe's cutoff cannot limit exact workset aggregation.
  const broad = { ...query, text: "Paper" };
  expect(libraryCounts(db, broad, '"paper"')).toMatchObject({ total: 260 });
  expect(libraryFacets(db, broad, '"paper"', 10)).toMatchObject({ total: 260 });
});

it("ranks exact folder matches from the member side and preserves native BM25 scores", () => {
  using db = new DatabaseSync(":memory:");
  initialize(db);
  const folder = id(100);
  const at = "2026-01-01T00:00:00.000Z";
  db.prepare(
    "INSERT INTO folders(folder_id,name,position,created_at,updated_at) VALUES(?,'test',0,?,?)",
  ).run(folder, at, at);
  add(db, 1, 1, "ranked a a a á café study");
  add(db, 2, 2, "ranked ranked a a cafe a a study");
  add(db, 3, 3, "ranked café study");
  db.prepare(
    "UPDATE literature_search_fts SET abstract=?,authors=?,content_body=? WHERE rowid=2",
  ).run("study café ranked", "Café", "study study");
  for (let n = 4; n <= 20; n++) add(db, n, n, "ranked extra words");
  for (const n of [1, 2, 3])
    db.prepare(
      "INSERT INTO folder_members(folder_id,literature_id,added_at,actor) VALUES(?,?,?,'user')",
    ).run(folder, id(n), at);
  const request = {
    ...page,
    query: {
      ...page.query,
      folder: { id: folder, include_descendants: false },
    },
  };
  const cache = new LibraryRelevanceCache(2);
  for (const text of ['"ranked"', '"ranked" AND "cafe" AND "study"', '"a a"']) {
    const result = libraryPageIds(db, { ...request, ftsQuery: text }, cache);
    const exact = allRanks(db, text).filter(({ literature_id }) =>
      [id(1), id(2), id(3)].includes(String(literature_id)),
    );
    expect(result.total_count).toBe(exact.length);
    expect(result.rows).toEqual(exact);
    expect(result).not.toHaveProperty("search_window");
  }
  for (const sort of ["title-asc", "intake-desc"] as const)
    expect(libraryPageIds(db, { ...request, sort }, cache).total_count).toBe(3);
});

it("preserves member BM25 scores for overlapping phrases and Unicode terms", () => {
  using db = new DatabaseSync(":memory:");
  initialize(db);
  add(db, 30, 1, "studies of materials in a a a café 研究");
  add(db, 10, 2, "studies of systems in a a cafe 研究");
  add(db, 20, 3, "Studies, of/a-a in CAFE cafe archive");
  add(db, 40, 4, "studies of a a a in science café 研究");
  add(db, 50, 5, "other results");
  add(db, 60, 6, "studies of systems");
  add(db, 70, 7, "studies of 研究");
  add(
    db,
    80,
    8,
    "studies of methods in a a café 研究 Δοκιμή 日本語 รหัส اختبار Пример",
  );
  db.prepare(
    "UPDATE literature_search_fts SET abstract=?,content_body=? WHERE rowid=30",
  ).run("in vitro studies of 研究", "a á a cafe—in");
  const collected = [1, 2, 3, 6, 7, 8].map(id);
  for (const literature of collected)
    db.prepare(
      "INSERT INTO library_collected(literature_id,intake_at) VALUES(?,NULL)",
    ).run(literature);

  for (const [ftsQuery, matches] of [
    ['"in"', 4],
    ['"a a"', 4],
    ['"studies" AND "of" AND "in"', 4],
    ['"a a" AND "of" AND "in"', 4],
    ['"研究"', 4],
    ['"a a" AND "a" AND "café"', 4],
    ['"café" AND "cafe" AND "研究"', 3],
  ] as const) {
    const exact = allRanks(db, ftsQuery).filter(({ literature_id }) =>
      collected.includes(String(literature_id)),
    );
    expect(exact, ftsQuery).toHaveLength(matches);
    const ranked = libraryPageIds(db, {
      ...page,
      query: { ...page.query, text: ftsQuery, collection_scope: "collected" },
      ftsQuery,
    });
    expect(ranked.total_count, ftsQuery).toBe(exact.length);
    expect(ranked.rows, ftsQuery).toEqual(exact);
  }
});

it("uses actual frequencies for clamped IDF and ranks only the workset prefix that fits", async () => {
  using db = new DatabaseSync(":memory:");
  initialize(db);
  const folder = id(100);
  const january = "2026-01-01T00:00:00.000Z";
  const february = "2026-02-01T00:00:00.000Z";
  const march = "2026-03-01T00:00:00.000Z";
  db.prepare(
    "INSERT INTO folders(folder_id,name,position,created_at,updated_at) VALUES(?,'budget',0,?,?)",
  ).run(folder, january, january);
  const insertMember = db.prepare(
    "INSERT INTO folder_members(folder_id,literature_id,added_at,actor) VALUES(?,?,?,'user')",
  );
  const intake = db.prepare(
    `INSERT INTO literature_intake(literature_id,intake_at) VALUES(?,?)
     ON CONFLICT(literature_id) DO UPDATE SET intake_at=excluded.intake_at`,
  );
  for (const [n, terms, at] of [
    [1, "ranked ranked ranked", january],
    [2, "ranked ranked filler", february],
    [3, "ranked filler filler", march],
    [4, "ranked ranked ranked", null],
    [5, "ranked filler filler", january],
    [6, "filler filler filler", march],
  ] as const) {
    add(db, n, n, "Fixture", 2026);
    db.prepare(
      "UPDATE literature_search_fts SET title='',content_body=? WHERE rowid=?",
    ).run(terms, n);
    intake.run(id(n), at);
    insertMember.run(folder, id(n), january);
  }
  const query = {
    ...page.query,
    folder: { id: folder, include_descendants: false },
  };
  const storageRequest = { ...page, query };
  const exact = allRanks(db);
  expect(exact).toHaveLength(5);
  expect(new Set(exact.map(({ relevance }) => relevance)).size).toBe(3);
  const ample = libraryPageIds(
    db,
    storageRequest,
    new LibraryRelevanceCache(1, 2_000),
  );
  expect(ample.rows).toEqual(exact);
  expect(ample).not.toHaveProperty("relevance_scored_count");
  const cache = new LibraryRelevanceCache(1, 2 * (3 + 256));
  const limited = libraryPageIds(db, storageRequest, cache);
  expect(limited).toMatchObject({ total_count: 5, relevance_scored_count: 2 });
  expect(limited.rows).toEqual([
    ...exact.filter(({ literature_id }) =>
      [id(2), id(3)].includes(String(literature_id)),
    ),
    { literature_id: id(1), relevance: null, workset_at: january },
    { literature_id: id(5), relevance: null, workset_at: january },
    { literature_id: id(4), relevance: null, workset_at: null },
  ]);
  expect(libraryCounts(db, query, page.ftsQuery).total).toBe(5);
  expect(libraryFacets(db, query, page.ftsQuery, 5).total).toBe(5);
  expect(
    libraryPageIds(db, { ...storageRequest, sort: "title-asc" }, cache),
  ).not.toHaveProperty("relevance_scored_count");

  const hash = await sha256(new Uint8Array());
  const unexpected = () => {
    throw new Error("unexpected repository call");
  };
  const service = new LiteratureQueryService({
    literatureDetailSnapshot: unexpected,
    librarySnapshot: unexpected,
    referenceQuerySnapshot: unexpected,
    libraryCounts: unexpected,
    async librarySearchPage(request) {
      const { rows, ...summary } = libraryPageIds(db, request, cache);
      return {
        ...summary,
        rows: rows.map(({ literature_id, relevance, workset_at }) => ({
          item: {
            literature: {
              ...FIXTURE_LITERATURE,
              literature_id: parseLiteratureId(literature_id),
            },
            metadata_revision: 1,
            metadata_sha256: hash,
            missing_step: null,
            needs_manual_pdf: false,
          },
          relevance: relevance as number | null,
          ...(workset_at === undefined
            ? {}
            : { workset_at: workset_at as string | null }),
          has_pdf_exhaustion: false,
          discovery_run_ids: [],
        })),
      };
    },
  });
  const request = { query, sort: "relevance", limit: 1 };
  const actual: string[] = [];
  let cursor: string | null = null;
  do {
    if (actual.length === 3) cache.clear(); // Recompute after an unscored cursor.
    const result = await service.search({ ...request, cursor });
    expect(result).toMatchObject({ total_count: 5, relevance_scored_count: 2 });
    actual.push(result.items[0]!.literature.literature_id);
    cursor = result.next_cursor;
  } while (cursor && actual.length <= 5);
  expect(cursor).toBeNull();
  expect(actual).toEqual([id(2), id(3), id(1), id(5), id(4)]);
});

it("binds a separately resumable window cursor to the normalized query", async () => {
  const calls: LibraryPageQuery[] = [];
  const unexpected = () => {
    throw new Error("unexpected repository call");
  };
  const repository: LibraryQueryRepository = {
    libraryCounts: unexpected,
    literatureDetailSnapshot: unexpected,
    librarySnapshot: unexpected,
    referenceQuerySnapshot: unexpected,
    async librarySearchPage(request: LibraryPageQuery) {
      calls.push(request);
      return request.beforeRowid
        ? { rows: [], total_count: 0 }
        : {
            rows: [],
            total_count: 0,
            scan_incomplete: true as const,
            search_window: {
              oldest_rowid: "19",
              newest_rowid: "20",
              limit: 2,
              scan_incomplete: true as const,
            },
          };
    },
  };
  const service = new LiteratureQueryService(repository);
  const request = { query: { text: "ranked" }, sort: "relevance" };
  const first = await service.search(request);
  expect(first).toMatchObject({
    scan_incomplete: true,
    scan_limit: 2,
    total_count: 0,
    next_cursor: null,
    next_window_cursor: expect.any(String),
  });
  const next = { ...request, window_cursor: first.next_window_cursor };
  expect(await service.search(next)).toEqual({
    items: [],
    total_count: 0,
    next_cursor: null,
  });
  expect(calls.at(-1)?.beforeRowid).toBe("19");
  await expect(
    service.search({ ...next, query: { text: "other" } }),
  ).rejects.toMatchObject({ code: "literature-query" });
  await expect(
    service.search({ ...next, cursor: first.next_window_cursor }),
  ).rejects.toThrow();

  const legacy = {
    kind: "library-search",
    payload: {
      candidate_window: {
        limit: 200_000,
        newest_rowid: "20",
        oldest_rowid: "1",
      },
      position: { bm25: -0.1, literature_id: id(1) },
      query_fingerprint: queryFingerprint(
        parseLibrarySearchRequest(request).query,
      ),
      ranking_id: null,
      sort: "relevance",
      total: { total_count: 10_000 },
    },
    version: 4,
  };
  const checksum = createHash("sha256")
    .update(JSON.stringify(legacy))
    .digest("hex");
  await service.search({
    ...request,
    cursor: Buffer.from(JSON.stringify({ checksum, ...legacy })).toString(
      "base64url",
    ),
  });
  expect(calls.at(-1)?.after).toEqual({
    literature_id: id(1),
    value: -0.1,
    legacy_newest_rowid: "20",
  });
});

it("reuses one raw window for changed filters, quick counts, facets and sort", async () => {
  using db = new DatabaseSync(":memory:");
  initialize(db);
  db.function("sr_derive_status", (value) =>
    value === id(2) ? "READY" : "UNREVIEWED",
  );
  for (let n = 1; n <= 6; n++) add(db, n, n, `Ranked ${n}`);
  const keyword = db.prepare(
    "INSERT INTO literature_metadata_keywords(literature_id,ordinal,keyword) VALUES(?,0,?)",
  );
  keyword.run(id(1), "earlier");
  keyword.run(id(4), "newer");
  const cache = new LibraryRelevanceCache(3);
  const metadataHash = await sha256(new Uint8Array());
  const unexpected = () => {
    throw new Error("unexpected repository call");
  };
  const repository: LibraryQueryRepository = {
    literatureDetailSnapshot: unexpected,
    librarySnapshot: unexpected,
    referenceQuerySnapshot: unexpected,
    async librarySearchPage(request) {
      const { rows, ...summary } = libraryPageIds(db, request, cache);
      return {
        ...summary,
        rows: rows.map(({ literature_id, relevance }) => ({
          item: {
            literature: {
              ...FIXTURE_LITERATURE,
              literature_id: parseLiteratureId(literature_id),
            },
            metadata_revision: 1,
            metadata_sha256: metadataHash,
            missing_step: null,
            needs_manual_pdf: false,
          },
          relevance: typeof relevance === "number" ? relevance : null,
          has_pdf_exhaustion: false,
          discovery_run_ids: [],
        })),
      };
    },
    async libraryCounts(query, fts, _signal, before) {
      return libraryCounts(
        db,
        query,
        fts,
        false,
        Date.now(),
        before,
        cache.windowLimit,
      );
    },
    async libraryFacets(query, limit, fts, _signal, before) {
      return libraryFacets(
        db,
        query,
        fts,
        limit,
        false,
        Date.now(),
        before,
        cache.windowLimit,
      );
    },
  };
  const service = new LiteratureQueryService(repository);
  const firstQuery = { text: "Ranked", statuses: ["UNREVIEWED"] };
  const first = await service.search({ query: firstQuery, sort: "relevance" });
  expect(first).toMatchObject({ total_count: 3, scan_incomplete: true });
  const window_cursor = first.next_window_cursor!;
  const query = { text: "RANKED! ranked" };
  const earlier = await service.search({
    query: { ...query, statuses: ["UNREVIEWED"], publication_year_from: 2020 },
    window_cursor,
    sort: "title-desc",
  });
  expect(earlier.total_count).toBe(2);
  expect(
    earlier.items.map(({ literature }) => literature.literature_id),
  ).toEqual([id(3), id(1)]);
  expect(earlier).not.toHaveProperty("scan_incomplete");
  expect(await service.counts(query, undefined, window_cursor)).toMatchObject({
    total: 3,
    statuses: { UNREVIEWED: 2, READY: 1 },
  });
  expect(
    await service.facets({ query, limit: 10, window_cursor }),
  ).toMatchObject({
    total: 3,
    keywords: [{ value: "earlier", count: 1, tag: null }],
  });

  const other = { text: "different" };
  const invalid = expect.objectContaining({ code: "literature-query" });
  await expect(service.search({ query: other, window_cursor })).rejects.toThrow(
    invalid,
  );
  await expect(service.counts(other, undefined, window_cursor)).rejects.toThrow(
    invalid,
  );
  expect(() =>
    service.facets({ query: other, limit: 10, window_cursor }),
  ).toThrow(invalid);
  await expect(
    service.search({
      query: { ...query, collection_scope: "collected" },
      window_cursor,
    }),
  ).rejects.toThrow(invalid);

  const old = {
    kind: "library-search-window",
    payload: {
      before_rowid: "4",
      query_fingerprint: queryFingerprint(
        parseLibrarySearchRequest({ query: firstQuery }).query,
      ),
    },
    version: 1,
  };
  const checksum = createHash("sha256")
    .update(JSON.stringify(old))
    .digest("hex");
  const oldCursor = Buffer.from(JSON.stringify({ checksum, ...old })).toString(
    "base64url",
  );
  await expect(
    service.search({ query: firstQuery, window_cursor: oldCursor }),
  ).rejects.toThrow(invalid);
});

it("finds collected members with durable selection evidence during backfill", () => {
  using db = new DatabaseSync(":memory:");
  initialize(db);
  for (let n = 1; n <= 6; n++) add(db, n, n);
  db.prepare(
    "INSERT INTO reading_history(literature_id,last_opened_at,open_count) VALUES(?,?,1)",
  ).run(id(1), "2026-01-01T00:00:00.000Z");
  db.prepare("DELETE FROM library_collected WHERE literature_id=?").run(id(1));
  const result = libraryPageIds(
    db,
    {
      ...page,
      query: { ...page.query, collection_scope: "collected" },
    },
    new LibraryRelevanceCache(1),
  );
  expect(result.total_count).toBe(1);
  expect(result.rows.map(({ literature_id }) => literature_id)).toEqual([
    id(1),
  ]);
  expect(result).not.toHaveProperty("scan_incomplete");
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
      search_window: first.search_window!,
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
  expect(warm.search_window).toEqual(first.search_window);
  // A fresh worker repeats MATCH within the old interval. Neither the newer
  // match nor the older match can move into the gap left by a reindexed item.
  const cold = libraryPageIds(db, request, new LibraryRelevanceCache(4));
  expect(cold.rows.map((row) => row.literature_id)).toEqual([id(3), id(5)]);
  expect(cold.search_window).toEqual(first.search_window);
  expect(cold.total_count).toBe(4);
});
