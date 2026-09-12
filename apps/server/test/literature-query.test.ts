import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  parseLibraryQuery,
  parseLiterature,
  type LibrarySort,
  type LibraryQuery,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { queryFingerprint } from "../src/literature/query.js";
import {
  normalizeQueryText,
  ftsIndexText,
} from "../src/literature/unicode-casefold.js";
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const emptyQuery = {
  text: null,
  title: null,
  author: null,
  author_orcids: [],
  identifiers: [],
  publication_year_from: null,
  publication_year_to: null,
  venue: null,
  publisher: null,
  document_types: [],
  languages: [],
  keywords: [],
  version_roles: [],
  statuses: [],
  missing_steps: [],
  needs_manual_pdf: null,
  discovery_run_ids: [],
};

it("searches authoritative metadata with Unicode/AND filters and stable v1 cursors", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-library-query-"));
  const app = await createApplication(home);
  try {
    for (const [n, title, year, keywords] of [
      [1, "Alpha Straße", 2026, ["one", "two"]],
      [2, "Alpha Beta", 2024, ["one"]],
      [3, "Alpha Other", null, ["two"]],
      [4, null, 2026, []],
    ] as const) {
      await app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: id(n),
          meta_literature_id: id(n + 100),
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title,
            publication_year: year,
            keywords,
            identifiers: [{ namespace: "doi", value: `10.5555/query.${n}` }],
          },
        }),
      );
    }
    const search = (
      q: Partial<LibraryQuery> = {},
      sort: LibrarySort = "publication-year-desc",
      limit = 50,
      cursor: string | null = null,
    ) =>
      app.library.search({
        query: { ...emptyQuery, ...q },
        sort,
        limit,
        cursor,
      });
    expect(
      (await search()).items.map((item) => item.literature.literature_id),
    ).toEqual([id(1), id(4), id(2), id(3)]);
    expect(
      (await search({ text: "STRASSE" })).items.map(
        (item) => item.literature.literature_id,
      ),
    ).toEqual([id(1)]);
    expect(
      (
        await app.library.search({
          query: { ...emptyQuery, keywords: ["one", "two"] },
          sort: "title-asc",
          limit: 10,
          cursor: null,
        })
      ).total_count,
    ).toBe(1);
    expect((await search({ text: 'OR * NEAR AND NOT " --' })).total_count).toBe(
      0,
    );
    expect((await search({ text: "https fixture" })).total_count).toBe(0);
    const first = await search({}, "publication-year-desc", 1);
    expect((await app.library.search({ query: {} })).total_count).toBe(4);
    await expect(
      app.library.search({ query: { publication_year_from: 10000 } }),
    ).rejects.toThrow();
    await expect(
      app.library.search({ query: {}, sort: "relevance" }),
    ).rejects.toThrow();
    const second = await search(
      {},
      "publication-year-desc",
      2,
      first.next_cursor,
    );
    expect(second.items.map((item) => item.literature.literature_id)).toEqual([
      id(4),
      id(2),
    ]);
    expect(second.total_count).toBe(4);
    expect(first.items[0]?.missing_step).toBe("primary-pdf");
    await expect(
      search(
        { title: "changed" },
        "publication-year-desc",
        1,
        first.next_cursor,
      ),
    ).rejects.toMatchObject({ code: "literature-query" });
    await expect(
      search({}, "title-asc", 1, first.next_cursor),
    ).rejects.toMatchObject({ code: "literature-query" });
    await expect(
      search({}, "publication-year-desc", 1, first.next_cursor! + "="),
    ).rejects.toMatchObject({ code: "literature-query" });
    for (const sort of [
      "publication-year-desc",
      "publication-year-asc",
      "title-asc",
      "title-desc",
      "relevance",
    ] as const) {
      const query = parseLibraryQuery({ ...emptyQuery, text: "Alpha" });
      const page = await app.library.search({
        query,
        sort,
        limit: 1,
        cursor: null,
      });
      const raw = Buffer.from(page.next_cursor!, "base64url").toString("utf8");
      const cursor = JSON.parse(raw) as {
        kind: string;
        version: number;
        payload: {
          query_fingerprint: string;
          sort: string;
          position: { literature_id: string };
        };
      };
      expect(cursor).toMatchObject({
        kind: "library-search",
        version: 1,
        payload: {
          query_fingerprint: queryFingerprint(query),
          sort,
          position: {
            literature_id: page.items[0]!.literature.literature_id,
          },
        },
      });
      expect(Buffer.from(raw).toString("base64url")).toBe(page.next_cursor);
    }
    expect(normalizeQueryText("  Straße\u0085ΟΣ İ  ")).toBe("strasse οσ i̇");
    expect(ftsIndexText("Straße OR 你好 — İ")).toBe("strasse 你好 i̇");
    await app.observations.publish({
      observation_id: id(201),
      provenance: {
        provenance_id: id(202),
        source_kind: "metadata-provider",
        source_name: "fixture",
        source_record_id: null,
        observed_at: "2026-09-10T00:00:00Z",
        input_sha256: null,
        parameters_sha256: null,
      },
      metadata: { ...FIXTURE_LITERATURE.metadata, title: "Replacement Zeta" },
      version_role: "published",
      reference_count: null,
      cited_by_count: null,
      declared_keywords: [],
      reference_texts: ["private reference text"],
    });
    expect((await search({ text: "Zeta" })).total_count).toBe(0);
    const baseline = (await app.database.currentFacts(id(1)))!
      .metadata_snapshot;
    await app.observations.accept(
      id(201),
      id(1),
      baseline.revision,
      baseline.sha256,
    );
    expect((await search({ text: "Zeta" })).total_count).toBe(1);
    expect((await search({ text: "STRASSE" })).total_count).toBe(0);
    expect((await search({ text: "private reference text" })).total_count).toBe(
      0,
    );
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
