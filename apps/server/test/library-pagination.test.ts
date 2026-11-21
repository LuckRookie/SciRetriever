import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  canonicalJsonBytes,
  EMPTY_METADATA,
  parseLiterature,
  parseLibrarySearchRequest,
  RELEVANCE_RESULT_LIMIT,
  sha256,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { selectLiteratures } from "../src/entry/selectors.js";
import { RetrievalStorageClient } from "../src/storage/sqlite/retrieval-client.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

it("pages stable Unicode keys with ties and nulls, and materializes only the requested page", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-library-pages-"));
  const app = await createApplication(home);
  let raw: DatabaseSync | undefined;
  try {
    const titles = ["a", "A", "Z", "Å", "\ue000", "\u{10000}", null, null];
    for (let n = 0; n < titles.length; n++)
      await app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: id(n + 1),
          meta_literature_id: id(n + 101),
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: titles[n],
            publication_year: n > 5 ? null : 2026,
            identifiers: [],
          },
        }),
      );
    for (const [sort, expected] of [
      ["title-asc", [1, 2, 3, 4, 5, 6, 7, 8]],
      ["title-desc", [6, 5, 4, 3, 1, 2, 7, 8]],
      ["publication-year-asc", [1, 2, 3, 4, 5, 6, 7, 8]],
      ["publication-year-desc", [1, 2, 3, 4, 5, 6, 7, 8]],
    ] as const) {
      let cursor: string | null = null;
      const actual: string[] = [];
      do {
        const page = await app.library.search({
          query: {},
          sort,
          limit: 2,
          cursor,
        });
        expect(page.total_count).toBe(8);
        actual.push(...page.items.map((p) => p.literature.literature_id));
        cursor = page.next_cursor;
      } while (cursor);
      expect(actual).toEqual(expected.map(id));
    }
    raw = new DatabaseSync(join(home, "catalog.sqlite"));
    raw
      .prepare(
        "UPDATE literature_metadata SET abstract='' WHERE literature_id=?",
      )
      .run(id(8));
    const first = await app.library.search({
      query: {},
      sort: "title-asc",
      limit: 2,
    });
    expect(first.items.map((p) => p.literature.literature_id)).toEqual([
      id(1),
      id(2),
    ]);
    expect(first.total_count).toBe(8);
    await expect(
      app.library.search({ query: {}, sort: "title-asc", limit: 20 }),
    ).rejects.toMatchObject({ code: "invalid-contract" });
    raw
      .prepare(
        "UPDATE literature_metadata SET abstract=NULL,title='0' WHERE literature_id=?",
      )
      .run(id(8));
    expect(
      (await app.library.search({ query: {}, sort: "title-asc", limit: 1 }))
        .items[0]!.literature.literature_id,
    ).toBe(id(8));
  } finally {
    raw?.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

it("ends both relevance windows at 1,000 while counts and query selections retain all matches", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-relevance-pages-"));
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    metadata: {},
  });
  let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  const count = RELEVANCE_RESULT_LIMIT + 5;
  const text = "rankwindow";
  try {
    const raw = new DatabaseSync(join(home, "catalog.sqlite"));
    try {
      const hash = await sha256(
        canonicalJsonBytes({ ...EMPTY_METADATA, title: text }),
      );
      const stronger = `${text} ${text} ${text}`;
      const strongerHash = await sha256(
        canonicalJsonBytes({ ...EMPTY_METADATA, title: stronger }),
      );
      const meta = raw.prepare("INSERT INTO meta_literatures VALUES(?,?)");
      const literature = raw.prepare(
        "INSERT INTO literatures VALUES(?,?,'published')",
      );
      const data = raw.prepare(
        "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title) VALUES(?,1,?,?)",
      );
      const fts = raw.prepare(
        "INSERT INTO literature_search_fts(literature_id,title) VALUES(?,?)",
      );
      raw.exec("BEGIN");
      for (let n = 1; n <= count; n++) {
        const key = id(n),
          family = id(n + count),
          high = n === count;
        meta.run(family, key);
        literature.run(key, family);
        data.run(key, high ? strongerHash : hash, high ? stronger : text);
        fts.run(key, high ? stronger : text);
      }
      raw.exec("COMMIT");
    } finally {
      if (raw.isTransaction) raw.exec("ROLLBACK");
      raw.close();
    }
    const { query: queryInput } = parseLibrarySearchRequest({
      query: { text },
      sort: "relevance",
      limit: 10,
    });
    const selection = (
      await app.library.selectionSnapshot(queryInput)
    ).matches.map((item) => item.literature.literature_id);
    expect(selection).toHaveLength(count);
    const batch = await selectLiteratures(app.library, {
      kind: "query",
      query: queryInput,
    });
    expect(batch.items.map((item) => item.literature.literature_id)).toEqual(
      selection,
    );
    expect(batch).not.toHaveProperty("relevance_limit");
    const ordinary = await app.library.search({
      query: { text },
      sort: "title-asc",
      limit: 1,
    });
    expect(ordinary).not.toHaveProperty("relevance_limit");
    const actual: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await app.library.search({
        query: { text },
        sort: "relevance",
        limit: 10,
        cursor,
      });
      expect(page).toMatchObject({
        total_count: count,
        relevance_limit: RELEVANCE_RESULT_LIMIT,
      });
      expect(page.items).toHaveLength(10);
      actual.push(...page.items.map((item) => item.literature.literature_id));
      cursor = page.next_cursor;
    } while (cursor && actual.length <= RELEVANCE_RESULT_LIMIT);
    expect(cursor).toBeNull();
    expect(actual).toEqual(selection.slice(0, RELEVANCE_RESULT_LIMIT));

    if (!app.maintenance?.refreshIndex)
      throw new Error("Synthetic index refresh unavailable");
    await expect(app.maintenance.refreshIndex()).resolves.toMatchObject({
      status: "updated",
    });
    query = await createQueryApplication(home);
    const request = {
      query: text,
      scope: { kind: "library" },
      kinds: ["metadata"],
      versions: { kind: "default" },
      budget: { max_items: 20, max_bytes: 65536, token_limit: null },
      continuation: null,
    };
    const ranking = vi.spyOn(RetrievalStorageClient.prototype, "search");
    try {
      const first = await query.knowledgeContext!.search({
        ...request,
        schema_version: 3,
        budget: { ...request.budget, max_items: 3 },
      });
      expect(first).toMatchObject({ relevance_limit: RELEVANCE_RESULT_LIMIT });
      expect(first.items).toHaveLength(3);
      expect(ranking).toHaveBeenCalledTimes(1);
    } finally {
      ranking.mockRestore();
    }
    const hits: string[] = [];
    do {
      const page = await query.context!.search({
        ...request,
        continuation: cursor,
      });
      expect(page).toMatchObject({ relevance_limit: RELEVANCE_RESULT_LIMIT });
      expect(page.items).toHaveLength(20);
      hits.push(...page.items.map((hit) => hit.literature_id));
      cursor = page.continuation;
    } while (cursor && hits.length <= RELEVANCE_RESULT_LIMIT);
    expect(cursor).toBeNull();
    expect(hits).toEqual([
      id(count),
      ...Array.from({ length: RELEVANCE_RESULT_LIMIT - 1 }, (_, n) =>
        id(n + 1),
      ),
    ]);
  } finally {
    await query?.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 40_000);
