import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  canonicalJsonBytes,
  sha256,
  parseLiterature,
  parseLibrarySearchRequest,
  parseAcquirePdfSelector,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import {
  proofreadFactsFixture,
  factId,
} from "./draft-proofread-facts-fixture.js";
import { LibraryStateCache } from "./legacy-library-state-cache.js";
import { primaryDraftFactSql } from "../src/storage/sqlite/draft-facts.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

it("preserves old normalized requests, query selectors, cursor and saved task bytes when new fields are omitted", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-draft-facts-wire-")),
    app = await createApplication(home);
  try {
    for (let n = 1; n <= 2; n++)
      await app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: id(n),
          meta_literature_id: id(n + 100),
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: `Synthetic ${n}`,
            identifiers: [],
          },
        }),
      );
    const request = parseLibrarySearchRequest({
        query: {},
        sort: "title-asc",
        limit: 1,
      }),
      selector = parseAcquirePdfSelector({
        kind: "query",
        query: request.query,
        sort: "title-asc",
        limit: null,
      }),
      page = await app.library.search(request),
      job = await app.jobService!.create({
        target_kind: "selector",
        selector,
        goal: "draft",
        idempotency_key: "old-wire-fixture",
        policy_version: "wire-v1",
        policy: { mode: "never", max_retries: 0 },
      });
    expect({
      query: await sha256(canonicalJsonBytes(request.query)),
      request: await sha256(canonicalJsonBytes(request)),
      selector: await sha256(canonicalJsonBytes(selector)),
      cursor: await sha256(Buffer.from(page.next_cursor!)),
      saved: await sha256(canonicalJsonBytes(job.selector)),
    }).toEqual({
      query: "8710c23ed9c8ada5681aca8d6e8b4fc4fe1ec6bb139b753c564fd53dbb0e5c27",
      request:
        "014ef57b181f6d02e77a3afde2eb889a0842e7aca30fbf249b398503169c9a1b",
      selector:
        "46a190bb00418b2145514ca0eb7bd7eec457f55c93cdc93e8e3fbd2cce0b4393",
      cursor:
        "dcfc8ccf46bb79e46343394d011924b1265d0523f6101d256f48d56387a2ff54",
      saved: "86883fa1b282a6683b719ecb13b0dd084b7b8f7280d29d72991775a5e640e8e5",
    });
    expect(
      (
        await app.library.search({
          query: { text_levels: [], has_draft_differences: null },
          sort: request.sort,
          limit: 1,
          cursor: page.next_cursor,
        })
      ).items.map((row) => row.literature.literature_id),
    ).toEqual([id(2)]);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

it("aggregates indexed version facts without files and exposes coherent defaults for all PDF parts", async () => {
  const e = await proofreadFactsFixture(),
    { f, db } = e;
  try {
    const a = f.output.document.document_version_id,
      b = await e.paper(2, "draft", {
        differs_segments: 3,
        differences: 8,
        image_only_pages: 2,
      }),
      c = await e.paper(3, "draft"),
      d = await e.paper(4, "proofread");
    await e.paper(5, "missing");
    await e.paper(6, "no-pdf");
    const sup = e.part(
      factId(1),
      50,
      "draft",
      { differs_segments: 999, differences: 999, image_only_pages: 999 },
      "supplementary-pdf",
    );
    const first = e.result(1, [a, b.vid!, a]),
      older = e.result(2, [a], "current", "older-method"),
      stale = e.result(3, [a], "stale");
    e.unfound(first, a, "/x");
    e.unfound(first, a, "/x");
    e.unfound(first, a, "/y");
    e.unfound(first, b.vid!, "/x");
    e.unfound(older, a, "/x");
    e.unfound(stale, a, "/stale");
    expect(
      db
        .prepare(
          "SELECT state FROM processor_result_currentness WHERE result_id=?",
        )
        .get(older)!.state,
    ).toBe("stale");
    expect(() => e.unfound(first, d.vid!, "/proofread")).toThrow(
      "draft version required",
    );
    const noFiles = vi
      .spyOn(f.e.app.files, "withVerified")
      .mockRejectedValue(new Error("Synthetic fact reads must not open files"));
    const expected = {
      ...f.output.counts,
      citing_results: 2,
      unfound_citations: 3,
    };
    const page = await f.e.app.library.search({
      query: {},
      sort: "title-asc",
      limit: 100,
    });
    expect(
      page.items.find((r) => r.literature.literature_id === factId(1))!
        .draft_facts,
    ).toEqual(expected);
    for (const n of [4, 5, 6])
      expect(
        page.items.find((r) => r.literature.literature_id === factId(n))!
          .draft_facts,
      ).toBeNull();
    const detail = await f.e.app.library.detail(factId(1));
    expect(detail.draft_facts).toEqual(expected);
    expect(detail.primary_pdf!.default_text).toEqual({
      document_version_id: a,
      text_level: "draft",
      draft_facts: expected,
    });
    expect(
      detail.additional_assets.find((r) => r.asset.asset_id === sup.aid)!
        .default_text!.draft_facts,
    ).toMatchObject({ differs_segments: 999, image_only_pages: 999 });
    const state = await f.e.app.archive.status(factId(1));
    expect(state.draft_facts).toEqual(expected);
    expect(state.parts.find((p) => p.part === "main")).toMatchObject({
      document_version_id: a,
      text_level: "draft",
      draft_facts: expected,
    });
    expect(state.parts.find((p) => p.asset_id === sup.aid)).toMatchObject({
      document_version_id: sup.vid,
      text_level: "draft",
      draft_facts: { differs_segments: 999 },
    });
    for (const [key, yes, no] of [
      ["has_draft_differences", [2], [1, 3]],
      ["has_image_only_pages", [2], [1, 3]],
      ["cited_by_results", [1, 2], [3]],
      ["has_unfound_citations", [1, 2], [3]],
    ] as const)
      for (const [flag, expectedIds] of [
        [true, yes],
        [false, no],
      ] as const) {
        const result = await f.e.app.library.search({
          query: { [key]: flag },
          sort: "title-asc",
          limit: 100,
        });
        expect(
          result.items.map((r) => r.literature.literature_id).sort(),
          `${key}:${flag}`,
        ).toEqual(expectedIds.map(factId).sort());
      }
    for (const [level, expectedIds] of [
      ["draft", [1, 2, 3]],
      ["proofread", [4]],
    ] as const)
      expect(
        (
          await f.e.app.library.search({
            query: { text_levels: [level] },
            limit: 100,
          })
        ).items
          .map((r) => r.literature.literature_id)
          .sort(),
      ).toEqual(expectedIds.map(factId).sort());
    expect(
      (
        await f.e.app.library.search({
          query: {
            text: "Synthetic",
            text_levels: ["draft"],
            has_image_only_pages: true,
          },
          sort: "draft-differences-desc",
        })
      ).items.map((row) => row.literature.literature_id),
    ).toEqual([b.lit]);
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT ${primaryDraftFactSql("citing_results")},${primaryDraftFactSql("unfound_citations")} FROM literatures l`,
      )
      .all()
      .map((r) => String(r.detail))
      .join("\n");
    expect(plan).toContain("processor_result_documents_version");
    expect(plan).toContain("processor_unfound_citations_version");
    expect(plan).not.toMatch(/SCAN (?:rd|uc|processor_results)\b/u);
    expect(noFiles).not.toHaveBeenCalled();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(c.vid).not.toBeNull();
  } finally {
    vi.restoreAllMocks();
    await e.close();
  }
}, 60_000);

it("sorts nullable fact tuples with stable ties and cursors, including form-drafts selection", async () => {
  const e = await proofreadFactsFixture();
  try {
    const b = await e.paper(2, "draft", {
        differs_segments: 3,
        differences: 8,
        image_only_pages: 0,
      }),
      c = await e.paper(3, "draft", {
        differs_segments: 3,
        differences: 4,
        image_only_pages: 2,
      }),
      d = await e.paper(4, "draft", {
        differs_segments: 3,
        differences: 4,
        image_only_pages: 2,
      }),
      x = await e.paper(5, "draft", {
        differs_segments: 1,
        differences: 9,
        image_only_pages: 1,
      });
    await e.paper(6, "proofread");
    await e.paper(7, "missing");
    await e.paper(8, "no-pdf");
    const r = e.result(1, [b.vid!, c.vid!, x.vid!]);
    e.result(2, [b.vid!, e.f.output.document.document_version_id]);
    e.unfound(r, c.vid!, "/1");
    e.unfound(r, c.vid!, "/2");
    e.unfound(r, x.vid!, "/1");
    for (const [sort, expected] of [
      ["draft-differences-desc", [2, 3, 4, 5, 1, 6, 7, 8]],
      ["image-only-pages-desc", [3, 4, 5, 1, 2, 6, 7, 8]],
      ["citing-results-desc", [2, 1, 3, 5, 4, 6, 7, 8]],
      ["unfound-citations-desc", [3, 5, 1, 2, 4, 6, 7, 8]],
    ] as const) {
      let cursor: string | null = null;
      const actual: string[] = [];
      do {
        const page = await e.f.e.app.library.search({
          query: {},
          sort,
          limit: 2,
          cursor,
        });
        actual.push(...page.items.map((r) => r.literature.literature_id));
        cursor = page.next_cursor;
      } while (cursor);
      expect(actual, sort).toEqual(expected.map(factId));
    }
    const selector = {
      kind: "query",
      query: { has_draft_differences: true },
      sort: "draft-differences-desc",
      limit: 2,
    };
    await e.f.e.app.library.pdfSelection(selector);
    e.db
      .prepare(
        "UPDATE document_versions SET draft_method_sha256=? WHERE document_version_id IN (?,?,?,?)",
      )
      .run("0".repeat(64), b.vid!, c.vid!, d.vid!, x.vid!);
    const job = await e.f.e.app.jobService!.create({
      goal: "draft",
      target_kind: "selector",
      selector:
        selector as import("../src/entry/selectors.js").LiteratureSelector,
      include_older_method: true,
      idempotency_key: "facts-selector",
      policy_version: "facts-v1",
      policy: { mode: "never", max_retries: 0 },
    });
    expect(
      (await e.f.e.app.jobs!.listTargets(job.job_id)).map(
        (r) => r.literature_id,
      ),
    ).toEqual([b.lit, c.lit]);
    const first = await e.f.e.app.library.search({
      query: {},
      sort: "draft-differences-desc",
      limit: 1,
    });
    await expect(
      e.f.e.app.library.search({
        query: { has_draft_differences: true },
        sort: "draft-differences-desc",
        limit: 1,
        cursor: first.next_cursor,
      }),
    ).rejects.toMatchObject({ code: "literature-query" });
  } finally {
    await e.close();
  }
}, 60_000);

it("invalidates changed cached owners for result facts and reads default removal without stale facts", async () => {
  const e = await proofreadFactsFixture(),
    cache = new LibraryStateCache(),
    other = new LibraryStateCache();
  const read = (c = cache) => c.read(e.db, "facts", 6, "vlm-engine", () => {});
  try {
    const b = await e.paper(2, "draft"),
      a = e.f.output.document.document_version_id,
      before = read();
    read(other);
    const result = e.result(1, [a]);
    e.unfound(result, a, "/value");
    const next = read();
    expect(next.get(factId(1))).not.toBe(before.get(factId(1)));
    expect(next.get(b.lit)).toBe(before.get(b.lit));
    expect(read(other).get(factId(1))).toEqual(next.get(factId(1)));
    expect(
      (await e.f.e.app.library.detail(factId(1))).draft_facts,
    ).toMatchObject({ citing_results: 1, unfound_citations: 1 });
    e.db
      .prepare(
        "UPDATE processor_result_summaries SET method_revision='older' WHERE result_id=?",
      )
      .run(result);
    expect(read()).toBe(next);
    e.db
      .prepare(
        "UPDATE processor_result_freshness SET state='stale' WHERE result_id=?",
      )
      .run(result);
    const stale = read();
    expect(stale.get(factId(1))).not.toBe(next.get(factId(1)));
    expect(stale.get(b.lit)).toBe(next.get(b.lit));
    expect(
      (await e.f.e.app.library.detail(factId(1))).draft_facts,
    ).toMatchObject({ citing_results: 0, unfound_citations: 0 });
    e.db
      .prepare("DELETE FROM document_defaults WHERE document_version_id=?")
      .run(a);
    expect(read().get(factId(1))).not.toBe(stale.get(factId(1)));
    const detail = await e.f.e.app.library.detail(factId(1));
    expect(detail.draft_facts).toBeNull();
    expect(detail.primary_pdf!.default_text).toBeNull();
    expect(
      (await e.f.e.app.archive.status(factId(1))).parts.find(
        (p) => p.part === "main",
      ),
    ).toMatchObject({
      document_version_id: null,
      text_level: null,
      draft_facts: null,
    });
  } finally {
    await e.close();
  }
}, 60_000);

it("invalidates a cached owner on real raw/default removal and on subsequent draft formation", async () => {
  const e = await proofreadFactsFixture(),
    cache = new LibraryStateCache(),
    read = () => cache.read(e.db, "facts", 6, "vlm-engine", () => {});
  try {
    // The replacement Markdown has no image; the fake parser must not declare
    // the initial source's image as an unreferenced resource.
    e.f.e.setResources([]);
    const before = read(),
      next = await e.f.prepare("# Replacement\n\nNew synthetic raw text.\n");
    expect(next.output.document.raw_parse_id).not.toBe(
      e.f.output.document.raw_parse_id,
    );
    expect(
      await e.f.e.app.database.documentDefault(
        factId(1),
        e.f.e.asset.asset_id,
        e.f.e.asset.sha256,
      ),
    ).toBeNull();
    const noDefault = read();
    expect(noDefault.get(factId(1))).not.toBe(before.get(factId(1)));
    expect((await e.f.e.app.library.detail(factId(1))).draft_facts).toBeNull();
    await e.f.storage.commitDraftVersion(next.publication);
    expect(read().get(factId(1))).not.toBe(noDefault.get(factId(1)));
    const detail = await e.f.e.app.library.detail(factId(1));
    expect(detail.primary_pdf!.default_text).toEqual({
      document_version_id: next.output.document.document_version_id,
      text_level: "draft",
      draft_facts: {
        ...next.output.counts,
        citing_results: 0,
        unfound_citations: 0,
      },
    });
  } finally {
    await e.close();
  }
}, 60_000);

it("measures new filters and sorting on 1000 synthetic papers with known primary-PDF facts", async () => {
  const e = await proofreadFactsFixture();
  try {
    for (let n = 2; n <= 1000; n++)
      await e.paper(n, n % 10 === 0 ? "proofread" : "draft", {
        differs_segments: n % 7,
        differences: n % 11,
        image_only_pages: n % 3,
      });
    const expected = Array.from({ length: 999 }, (_, k) => k + 2)
      .filter((n) => n % 10 !== 0 && n % 3 > 0)
      .sort((a, b) => (b % 7) - (a % 7) || (b % 11) - (a % 11) || a - b);
    const timings: Record<string, number> = {};
    for (const label of ["cold", "warm"]) {
      const start = performance.now(),
        page = await e.f.e.app.library.search({
          query: { has_image_only_pages: true },
          sort: "draft-differences-desc",
          limit: 50,
        });
      timings[`${label}_filter_sort_ms`] =
        Math.round((performance.now() - start) * 100) / 100;
      expect(page.total_count).toBe(expected.length);
      expect(page.items.map((r) => r.literature.literature_id)).toEqual(
        expected.slice(0, 50).map(factId),
      );
    }
    const start = performance.now(),
      counted = await e.f.e.app.library.counts({
        text_levels: ["draft"],
        has_image_only_pages: true,
      });
    timings.counts_ms = Math.round((performance.now() - start) * 100) / 100;
    expect(counted.total).toBe(expected.length);
    expect(e.db.prepare("SELECT count(*) AS n FROM literatures").get()!.n).toBe(
      1000,
    );
    expect(e.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    console.info(
      "Synthetic draft fact queries (1000 papers):",
      JSON.stringify(timings),
    );
  } finally {
    await e.close();
  }
}, 180_000);
