import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { parseLiterature } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
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
