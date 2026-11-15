import type { Page } from "playwright";

/**
 * A fixture's page layer agrees with its parse, so every segment matches
 * it. The reader's doubts are shown on served replies made doubtful: the
 * second body segment differs from the text layer, the third has none, and
 * the differences of the second are given.
 */
export async function doubtfulDraft(page: Page) {
  const doubtful = new Map<string, string>();
  await page.route(
    (url) => url.pathname === "/api/v1/query/document-segments",
    async (route) => {
      const response = await route.fetch();
      const value = await response.json();
      const segments = value.result.segments as {
        segment_id: string;
        kind: string;
        basis?: string;
      }[];
      const body = segments.filter((s) => s.kind === "text");
      if (body[1]) {
        body[1].basis = "text-layer-differs";
        doubtful.set(body[1].segment_id, "text-layer-differs");
      }
      if (body[2]) {
        body[2].basis = "no-text-layer";
        doubtful.set(body[2].segment_id, "no-text-layer");
      }
      await route.fulfill({ response, json: value });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/v1/query/document-draft-differences",
    async (route) => {
      const response = await route.fetch();
      const value = await response.json();
      const text = JSON.stringify([
        {
          leaf_id: "11111111-2222-4333-8444-555555555555",
          page_index: 0,
          kind: "mismatch",
          parsed: "results",
          text_layer: "findings",
          other_page_index: null,
        },
        {
          leaf_id: "11111111-2222-4333-8444-555555555555",
          page_index: 0,
          kind: "elsewhere",
          parsed: "a second paragraph",
          text_layer: "",
          other_page_index: 2,
        },
      ]);
      const bytes = Buffer.byteLength(text);
      value.result.basis = "text-layer-differs";
      value.result.location.basis = "text-layer-differs";
      value.result.text = text;
      value.result.actual_range = { start_utf8: 0, end_utf8: bytes };
      value.result.total_bytes = bytes;
      value.result.continuation = null;
      await route.fulfill({ response, json: value });
    },
  );
  return doubtful;
}

/**
 * The library side of the same simulated doubt: the paper's draft facts as
 * the doubtful replies above would make them (one segment, two differences),
 * so a sample's library row and its reader agree.
 */
export async function doubtfulFacts(page: Page, literatureId: string) {
  await page.route(
    (url) =>
      url.pathname === "/api/v1/query/search" ||
      url.pathname === "/api/library/search",
    async (route) => {
      const response = await route.fetch();
      const value = await response.json();
      const page = value.result?.page ?? value.page;
      for (const item of page?.items ?? [])
        if (item.literature?.literature_id === literatureId && item.draft_facts)
          Object.assign(item.draft_facts, {
            differs_segments: 1,
            differences: 2,
          });
      // Sorted by differences, it comes first, as the server would put it.
      if (page?.items)
        page.items.sort(
          (
            a: { draft_facts?: { differs_segments: number } | null },
            b: typeof a,
          ) =>
            (b.draft_facts?.differs_segments ?? -1) -
            (a.draft_facts?.differs_segments ?? -1),
        );
      await route.fulfill({ response, json: value });
    },
  );
}
