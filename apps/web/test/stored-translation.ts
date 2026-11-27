import type { Page } from "playwright";
import type { DocumentTranslationState } from "@sciretriever/contracts";

/** Segment kinds archiving translates (technical 04 §9.2); the rest stay as they are. */
const TRANSLATABLE = new Set([
  "heading",
  "text",
  "caption",
  "list",
  "footnote",
]);
interface Segment {
  segment_id: string;
  kind: string;
}
/**
 * The reader's stored translation on served replies (ADR 0068), the way
 * `draft-doubts.ts` makes a draft doubtful: `describe` says the state asked
 * for, `document-translation` gives every translatable segment its own unit —
 * the text unit `missing` left untranslated in a partial one — and `slice`
 * with `text` rebuilds the original's text with a mark of its reading. The
 * PDF's 对照翻译 replies carry the same state. Change `state` and reload to
 * read another case.
 */
export async function storedTranslation(
  page: Page,
  options: { state: DocumentTranslationState; missing?: number } = {
    state: "partial",
  },
) {
  const fake = {
    state: options.state,
    language: "zh-Hans" as const,
    /** The `text` of each translated `slice` asked for. */
    slices: [] as string[],
  };
  const segments: Segment[] = [];
  let reading: unknown = null;
  const units = () => {
    let texts = 0;
    return segments
      .filter((s) => TRANSLATABLE.has(s.kind))
      .map((s, i) => {
        const text = s.kind === "text" ? texts++ : -1;
        const missing =
          fake.state === "partial" && text === (options.missing ?? 1);
        return {
          unit_id: s.segment_id,
          segment_ids: [s.segment_id],
          translation:
            fake.state === "same-language" || missing
              ? null
              : s.kind === "heading"
                ? `标题译文 ${i}`
                : `段落译文 ${i}：在给定条件下测得的数值及其不确定度。`,
        };
      });
  };
  const listed = () =>
    fake.state === "none" || fake.state === "stale" ? [] : units();
  await page.route(
    (url) => url.pathname === "/api/v1/query/document-segments",
    async (route) => {
      const response = await route.fetch();
      const value = await response.json();
      for (const s of value.result.segments as Segment[])
        if (!segments.some((x) => x.segment_id === s.segment_id))
          segments.push({ segment_id: s.segment_id, kind: s.kind });
      await route.fulfill({ response, json: value });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/v1/query/document-describe",
    async (route) => {
      const response = await route.fetch();
      const value = await response.json();
      reading = value.result.document;
      const all = units();
      // ADR 0072: the language asked for; this paper has only `fake.language`.
      const asked =
        (
          route.request().postDataJSON() as {
            request: { target_language?: string };
          }
        ).request.target_language ?? fake.language;
      const has = asked === fake.language;
      value.result.translation = {
        target_language: asked,
        state: has ? fake.state : "none",
        units: all.length,
        translated: has
          ? listed().filter((u) => u.translation !== null).length
          : 0,
      };
      if ("translation_languages" in value.result)
        value.result.translation_languages =
          fake.state === "complete" ||
          fake.state === "partial" ||
          fake.state === "same-language"
            ? [fake.language]
            : [];
      await route.fulfill({ response, json: value });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/v1/query/document-translation",
    async (route) => {
      const asked =
        (
          route.request().postDataJSON() as {
            request: { target_language?: string };
          }
        ).request.target_language ?? fake.language;
      const has = asked === fake.language;
      const list = has
        ? listed()
        : units().map((u) => ({ ...u, translation: null }));
      await route.fulfill({
        json: {
          protocol_version: 1,
          result: {
            document: reading,
            machine_translation: true,
            target_language: asked,
            state: has ? fake.state : "none",
            units: list,
            total: list.length,
            next_cursor: null,
          },
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/v1/query/document-slice",
    async (route) => {
      const body = route.request().postDataJSON() as {
        request: { text?: string };
      };
      const text = body.request.text;
      if (!text || text === "original") return route.continue();
      fake.slices.push(text);
      delete body.request.text;
      const response = await route.fetch({ postData: JSON.stringify(body) });
      const value = await response.json();
      const original = value.result.text as string;
      value.result.text =
        text === "translation"
          ? `机器译文\n\n${original}`
          : `${original}\n\n机器译文对照`;
      value.result.machine_translation = true;
      value.result.target_language = fake.language;
      value.result.untranslated_units = 1;
      // Machine translation is never evidence (technical 04 §9.6).
      value.result.evidence = [];
      await route.fulfill({ response, json: value });
    },
  );
  // The PDF's pages: the service's own reply where it has the page's
  // blocks; otherwise one block over the page's title line.
  const block = {
    leaf_id: "fixture-title",
    type: "title",
    role: "title",
    region: [60, 60, 700, 110],
    placement: "region",
    source: "Synthetic literature workbench",
    translation: "合成文献工作台",
  };
  await page.route(
    (url) => url.pathname === "/api/translation/fulltext",
    async (route) => {
      const response = await route.fetch();
      const value = response.ok() ? await response.json() : {};
      const summary = value.summary?.pages?.some(
        (p: { blocks: number }) => p.blocks,
      )
        ? value.summary
        : {
            literature_id: new URL(route.request().url()).searchParams.get(
              "literature_id",
            ),
            target_language: fake.language,
            page_count: 1,
            pages: [{ page_index: 0, blocks: 1, saved: true }],
          };
      summary.state = fake.state;
      await route.fulfill({ json: { summary } });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/translation/fulltext/page",
    async (route) => {
      const request = route.request().postDataJSON() as {
        literature_id: string;
        page_index: number;
      };
      const response = await route.fetch();
      const value = response.ok() ? await response.json() : {};
      const blocks = (value.page?.blocks ?? []) as {
        source: string;
        translation: string | null;
      }[];
      for (const b of blocks) b.translation = `译文：${b.source.slice(0, 24)}`;
      await route.fulfill({
        json: {
          page: {
            literature_id: request.literature_id,
            page_index: request.page_index,
            target_language: fake.language,
            model: null,
            saved: true,
            blocks: blocks.length ? blocks : [block],
            state: fake.state,
          },
        },
      });
    },
  );
  return fake;
}
