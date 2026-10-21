import { expect, it } from "vitest";
import {
  parseRawBlocksV1,
  sha256,
  type RawBlock,
  type RawParseResource,
} from "@sciretriever/contracts";
import { cleanRawBlocks, hasKnownTextDefect } from "../src/proofread/clean.js";
import {
  normalizeForComparison,
  semanticTokens,
} from "../src/proofread/normalize.js";
import { markdownDraft } from "../src/proofread/markdown-draft.js";
import { locateMarkdown } from "../src/proofread/draft.js";
import { findSuspects, textTokens } from "../src/proofread/suspects.js";
import { renderBlocks } from "../src/proofread/render.js";
import type { PdfPageInspection } from "../src/browser/pdf-region.js";
const raw = (
  text: string,
  index = 0,
  page = 0,
  type: RawBlock["type"] = "text",
): RawBlock => ({
  page,
  index,
  type,
  title_level: type === "title" ? 1 : null,
  text,
  html: null,
  image_ref: null,
  bbox: [0, index * 10, 800, index * 10 + 10],
  source_type: "synthetic",
});
const clean = (blocks: RawBlock[]) =>
  cleanRawBlocks(
    parseRawBlocksV1(
      {
        schema_version: 1,
        page_count: Math.max(1, ...blocks.map((b) => b.page + 1)),
        blocks,
      },
      [],
    ),
  );
const page = (
  text: string,
  n = 0,
  kind: PdfPageInspection["kind"] = "text-layer",
): PdfPageInspection => ({
  page: n,
  kind,
  text,
  visible_glyphs: text.length,
  unmapped_glyphs: 0,
  hidden_glyphs: 0,
  has_graphics: kind === "image-only",
});
it.each(["header", "footer", "page-number", "discarded"] as const)(
  "records removed %s without losing its text or raw address",
  (type) => {
    const out = clean([raw("noise", 0, 0, type), raw("Text.", 1)]);
    expect(out.blocks).toHaveLength(1);
    expect(out.removed).toEqual([
      { page: 0, type, text: "noise", raw_ref: [0, 0] },
    ]);
  },
);
it("joins continued paragraphs, keeps cross-page regions, and records original per-page text", () => {
  const out = clean([
    raw("A continu-", 0),
    raw("ation with", 1),
    raw("cross-page text.", 0, 1),
  ]).blocks;
  expect(out).toHaveLength(1);
  expect(out[0]!.text).toBe("A continuation with cross-page text.");
  expect(out[0]!.raw_ref).toEqual([
    [0, 0],
    [0, 1],
    [1, 0],
  ]);
  expect(out[0]!.continuation_regions).toEqual([
    { page: 0, region: [0, 10, 800, 20] },
    { page: 1, region: [0, 0, 800, 10] },
  ]);
  expect(out[0]!.text_source).toBe("rule");
  expect(out[0]!.page_text).toHaveLength(3);
});
it.each([
  "Completed.",
  "完成。",
  "完成！",
  "Complete?",
  'Complete!"',
  "结束？）",
])("keeps a sentence boundary %s", (s) =>
  expect(clean([raw(s), raw("Next", 1)]).blocks).toHaveLength(2),
);
it("keeps titles, numbered paragraphs, bullets and references separate", () => {
  for (const text of [
    "2. Methods",
    "II. Methods",
    "• First option",
    "- First option",
  ])
    expect(clean([raw("Incomplete"), raw(text, 1)]).blocks).toHaveLength(2);
  expect(
    clean([
      raw("References", 0, 0, "title"),
      raw("Author A.", 1),
      raw("Author B.", 2),
      raw("Appendix", 3, 0, "title"),
      raw("Item", 4, 0, "list"),
    ]).blocks.map((b) => b.type),
  ).toEqual(["title", "reference", "reference", "title", "list"]);
  expect(clean([raw("Zn-"), raw("O material.", 1)]).blocks[0]!.text).toBe(
    "Zn- O material.",
  );
});
it("marks unmapped/control characters without rewriting source bytes", () => {
  expect(hasKnownTextDefect("clean\ntext\tmore\r\n")).toBe(false);
  const text = "word\ue103\u0000";
  expect(clean([raw(text)]).blocks[0]).toMatchObject({
    text,
    known_defect: true,
  });
});
it.each([
  ["12.5 ℃", "12.5%", false],
  ["1 2 . 5 ~ ^ { \\circ } C", "12.5^{\\circ}\\mathrm{C}", true],
  ["K BX", "K_{2}BX", false],
  ["（实验）", "(实验)", true],
  ["1.0 mol", "1.00 mol", false],
  ["-2 K", "2 K", false],
  ["5‰", "5%", false],
  ["1 2", "12", false],
  ["CO₂", "CO_{2}", true],
  ["CO2", "CO_{2}", true],
  ["Fe2O3", "Fe_{2}O_{3}", true],
  ["Fe2O3", "Fe_{3}O_{3}", false],
  ["m·s⁻¹", "m·s^{-1}", true],
  ["CO<sub>2</sub>", "CO_{2}", true],
  ["CO<sub>2</sub>", "CO^{2}", false],
] as const)("preserves scientific token identities: %s / %s", (a, b, equal) =>
  expect(JSON.stringify(textTokens(a)) === JSON.stringify(textTokens(b))).toBe(
    equal,
  ),
);
it("retains precision, signs, units and Chinese compatibility normalization", () => {
  expect(semanticTokens("12.50 °C, -2.0e-3 mol").numbers).toEqual([
    "12.50",
    "-2.0e-3",
  ]);
  expect(normalizeForComparison("中 文\n实验")).toBe("中文实验");
  expect(semanticTokens("m·s⁻¹ and 1 μm").numbers).toEqual(["-1", "1"]);
  expect(semanticTokens("m·s⁻¹ and 1 μm").units).toContain("μm");
});
it("tokenizes Markdown tables, equations, image references and fences without treating code as headings", () => {
  const blocks = markdownDraft(
    "```txt\n# Code\n```\n\n$$\nx^2\n$$\n\n# Actual heading",
  );
  expect(blocks.map((b) => b.type)).toEqual(["text", "equation", "title"]);
  expect(blocks[1]!.text).toBe("x^2");
  const other = markdownDraft(
    "Before.\nA | B\n--- | :---:\n1 | 2\n\n![figure][FIG]\n\n[fig]: images/a.png\nAfter.",
  );
  expect(other.map((b) => b.type)).toEqual(["text", "table", "image", "text"]);
  expect(other[1]!.html).toContain("<td>2</td>");
  expect(other[2]!.image_ref).toBe("images/a.png");
  expect(other.every((b) => b.region === null && b.page === -1)).toBe(true);
});
it("locates legacy paragraphs only with unique monotone pages, refusing ambiguous or image-only content", () => {
  expect(
    locateMarkdown("First page.\n\nSecond page.", [
      page("First page."),
      page("Second page.", 1),
    ]).map((b) => b.page),
  ).toEqual([0, 1]);
  expect(() =>
    locateMarkdown("Same text.", [page("Same text."), page("Same text.", 1)]),
  ).toThrow("proofread-needs-parse");
  expect(() => locateMarkdown("Scan.", [page("", 0, "image-only")])).toThrow(
    "proofread-needs-parse",
  );
  expect(() =>
    locateMarkdown("Second page.\n\nFirst page.", [
      page("First page."),
      page("Second page.", 1),
    ]),
  ).toThrow("proofread-needs-parse");
});
it("uses multisets, discounts rule removals and identifies cross-page reference questions", () => {
  const block = (text: string, n: number) => ({
    block_id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
    page: n,
    text,
    html: null,
  });
  expect(
    findSuspects(
      [page("alpha beta alpha")],
      [block("alpha alpha beta", 0)],
      [],
    ),
  ).toEqual([]);
  expect(
    findSuspects(
      [page("Header body")],
      [block("body", 0)],
      [{ page: 0, type: "header", text: "Header", raw_ref: [0, 0] }],
    ),
  ).toEqual([]);
  expect(
    findSuspects(
      [page("RefA 1"), page("RefB 2", 1)],
      [block("RefA 1 RefB 2", 0)],
      [],
    ).some((s) => s.kind === "page-misplaced" && s.page === 1),
  ).toBe(true);
  expect(
    findSuspects([page("12.5 °C")], [block("12.5%", 0)], []).map((s) => s.kind),
  ).toEqual(expect.arrayContaining(["missing", "extra", "token-mismatch"]));
});
it("renders deterministic Unicode byte ranges and only referenced image resources", async () => {
  const image: RawParseResource = {
    reference: "figure.png",
    artifact: {
      sha256: await sha256(Buffer.from("png")),
      byte_size: 3,
      media_type: "image/png",
    },
  };
  const blocks = [
    {
      block_id: "b1",
      type: "text" as const,
      title_level: null,
      text: "中文。",
      html: null,
      image_ref: null,
    },
    {
      block_id: "b2",
      type: "image" as const,
      title_level: null,
      text: "",
      html: null,
      image_ref: image.reference,
    },
  ];
  const a = renderBlocks(blocks, [
      image,
      { ...image, reference: "unused.png" },
    ]),
    b = renderBlocks(blocks, [image]);
  expect(a).toEqual(b);
  expect(a.resources).toEqual([image]);
  expect(
    Buffer.from(a.markdown)
      .subarray(a.ranges[0]!.start_utf8, a.ranges[0]!.end_utf8)
      .toString(),
  ).toBe("中文。\n\n");
  expect(a.ranges[1]!.start_utf8).toBe(Buffer.byteLength("中文。\n\n"));
  expect(() => renderBlocks(blocks, [])).toThrow("proofread-resource-missing");
});

it("groups adjacent missing tokens and retains distinct repeated locations", () => {
  const out = findSuspects(
    [page("alpha lost words beta other text gamma")],
    [{ block_id: "draft", page: 0, text: "alpha beta gamma", html: null }],
    [],
  );
  expect(out.filter((s) => s.kind === "missing").map((s) => s.tokens)).toEqual([
    ["lost", "words"],
    ["other", "text"],
  ]);
  expect(new Set(out.map((s) => s.suspect_id)).size).toBe(out.length);
});
it("finds references merged across three pages and unmapped ligatures", () => {
  const pages = Array.from({ length: 3 }, (_, n) =>
    page(
      Array.from(
        { length: 10 },
        (_, i) => `Author${n * 10 + i} Citation${n * 10 + i}`,
      ).join(" "),
      n,
    ),
  );
  const out = findSuspects(
    pages,
    [
      {
        block_id: "merged",
        page: 0,
        text: pages.map((p) => p.text).join(" "),
        html: null,
      },
    ],
    [],
  );
  expect(
    out.some(
      (s) =>
        s.kind === "page-misplaced" &&
        s.page === 2 &&
        s.block_ids.includes("merged"),
    ),
  ).toBe(true);
  const ligatures = findSuspects(
    [page("efficient")],
    [{ block_id: "ligature", page: 0, text: "e\ue123cient", html: null }],
    [],
  );
  expect(ligatures.some((s) => s.tokens.includes("U+E123"))).toBe(true);
});

it("compares Han text independently of PDF line and parser-block boundaries without hiding missing characters", () => {
  const blocks = ["中文", "纳米晶 合成 nanocrystal.", "钙钛矿纳米晶合成"].map(
    (text, i) => ({
      block_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      page: 0,
      text,
      html: null,
    }),
  );
  expect(
    findSuspects([page(blocks.map((b) => b.text).join("\n"))], blocks, []),
  ).toEqual([]);
  expect(
    findSuspects(
      [page("中文纳米晶合成nanocrystal.钙钛矿纳米晶合成")],
      blocks,
      [],
    ),
  ).toEqual([]);
  const missing = findSuspects(
    [page("中文纳米晶合成nanocrystal.钙钛矿纳米晶合成")],
    blocks.slice(1),
    [],
  );
  expect(
    missing.some((s) => s.kind === "missing" && s.tokens.includes("中")),
  ).toBe(true);
  expect(textTokens("纳米晶 1.00 mol")).not.toEqual(
    textTokens("纳米晶 1.0 mol"),
  );
});

it("does not retry a chemical-formula match at every character of a long non-formula token", () => {
  const tokens = semanticTokens(`${"A".repeat(64000)}_suffix H2O Fe2O3`);
  expect(tokens.formulas).toEqual(["H_{2}O", "Fe_{2}O_{3}"]);
});
