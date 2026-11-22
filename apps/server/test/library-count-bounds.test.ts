import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseLibrarySearchRequest } from "@sciretriever/contracts";
import { initializeCurrentCatalog } from "../src/storage/sqlite/catalog-layout.js";
import { SqliteReadLane, SqliteWorker } from "../src/storage/sqlite/worker.js";
import { LiteratureQueryService } from "../src/literature/query.js";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

it("counts 9,999 and 10,000 exactly, limits a larger sample, and keeps complete selection", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-count-bounds-"));
  const path = join(home, "catalog.sqlite");
  const db = new DatabaseSync(path);
  const lane = new SqliteReadLane();
  const worker = new SqliteWorker(path, undefined, {
    readOnly: true,
    readLane: lane,
  });
  const service = new LiteratureQueryService(worker);
  try {
    initializeCurrentCatalog(db);
    db.exec("PRAGMA journal_mode=WAL; BEGIN");
    const meta = db.prepare("INSERT INTO meta_literatures VALUES(?,?)");
    const version = db.prepare(
      "INSERT INTO literatures VALUES(?,?,'published')",
    );
    const metadata = db.prepare(
      "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title,publication_year) VALUES(?,1,?,'Sample record',?)",
    );
    const word = db.prepare(
      "INSERT INTO literature_metadata_keywords VALUES(?,0,'sample')",
    );
    const fts = db.prepare(
      "INSERT INTO literature_search_fts(literature_id,title) VALUES(?,'sample record')",
    );
    for (let n = 1; n <= 10_001; n++) {
      const key = id(n);
      meta.run(key, key);
      version.run(key, key);
      metadata.run(
        key,
        "a".repeat(64),
        n <= 9999 ? 2020 : n === 10_000 ? 2021 : 2022,
      );
      word.run(key);
      fts.run(key);
    }
    db.exec("COMMIT");
    for (const [year, n] of [
      [2020, 9999],
      [2021, 10_000],
      [2022, 10_001],
    ] as const) {
      const query = { text: "sample", publication_year_to: year };
      const total = Math.min(10_000, n);
      const [counts, facets, page] = await Promise.all([
        service.counts(query),
        service.facets({ query, limit: 20 }),
        service.search({ query, sort: "relevance", limit: 2 }),
      ]);
      expect(counts.total).toBe(total);
      expect(counts.statuses.UNREVIEWED).toBe(total);
      expect(counts.full_text.total).toBe(total);
      expect(facets.total).toBe(total);
      expect(facets.coverage.keywords).toBe(total);
      expect(facets.keywords[0]?.count).toBe(total);
      expect(page.total_count).toBe(total);
      expect(page.relevance_limit).toBe(1_000);
      for (const result of [counts, facets, page])
        expect(result.count_truncated).toBe(n > 10_000 ? true : undefined);
      expect(facets.facets_truncated).toBe(n > 10_000 ? true : undefined);
    }

    const full = { text: "sample", publication_year_to: 2022 };
    const exact = await service.exactCount({ kind: "counts", query: full });
    expect(exact).toMatchObject({
      kind: "counts",
      snapshot_at: expect.any(String),
      counts: { total: 10_001 },
    });
    const facets = await service.exactCount({
      kind: "facets",
      query: full,
      limit: 20,
    });
    expect(facets).toMatchObject({
      kind: "facets",
      facets: { total: 10_001, coverage: { keywords: 10_001 } },
    });
    expect(await service.facets({ query: {}, limit: 20 })).toMatchObject({
      total: 10_001,
      facets_truncated: true,
      coverage: { keywords: 10_000 },
    });
    expect(await service.counts({})).toMatchObject({
      total: 10_001,
      counts_backfill_pending: true,
    });

    const selection = await service.pdfSelection({
      kind: "query",
      query: full,
      sort: "relevance",
      limit: 1,
    });
    expect(selection.counts).toMatchObject({
      matched: 10_001,
      over_limit: 10_000,
    });

    const request = {
      query: { title: "Sample record", publication_year_to: 2020 },
      sort: "title-asc",
      limit: 2,
    };
    const first = await service.search(request);
    expect(first.total_count).toBe(9999);
    expect(first.next_cursor).not.toBeNull();
    db.prepare(
      "UPDATE literature_metadata SET publication_year=2020 WHERE literature_id=?",
    ).run(id(10_000));
    expect(
      (await service.search({ ...request, cursor: first.next_cursor }))
        .total_count,
    ).toBe(9999);
    expect((await service.search(request)).total_count).toBe(10_000);
    expect(
      await service.exactCount({ kind: "search-total", query: request.query }),
    ).toMatchObject({ total_count: 10_000 });

    const cancellation = new AbortController();
    const pending = service.exactCount(
      { kind: "facets", query: full, limit: 20 },
      cancellation.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    setTimeout(() => cancellation.abort(), 1).unref();
    await rejected;
    expect(
      await service.exactCount({
        kind: "search-total",
        query: parseLibrarySearchRequest({ query: full }).query,
      }),
    ).toMatchObject({ total_count: 10_001 });
  } finally {
    db.close();
    await worker.close();
    await lane.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
