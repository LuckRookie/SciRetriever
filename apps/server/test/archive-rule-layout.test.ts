import { expect, it } from "vitest";
import {
  parseArchiveTextBundleV2,
  parseArrangementOperation,
  parseArrangementSourceBlock,
  parseDocumentLayout,
  parseDocumentStructureV2,
  type ArrangementOperation,
  type ArchiveTextBundleV2,
} from "@sciretriever/contracts";
import {
  archiveTextFixture,
  arranged,
  assigned,
  fakeTextRuntime,
  fakePages,
  memoryTextCache,
  modelTool,
} from "./archive-text-fixture.js";
import { programChromeDrops } from "../src/archive/preprocess.js";
import { measurePdfBlock } from "../src/archive/pdf-geometry.js";
import {
  reviewArrangement,
  acceptArrangement,
} from "../src/archive/arrangement.js";
import { ArchiveArrangementService } from "../src/archive/arrangement-service.js";
import {
  renderArrangement,
  arrangementAnnotation,
} from "../src/archive/render.js";
import { correctReadingOrder } from "../src/archive/reading-order.js";
import { pageProofreadInputKey } from "../src/proofread/page-service.js";
import type { ArchiveTextSource } from "../src/archive/text-source.js";
import type { ModelRequest } from "../src/agents/model-protocol.js";
const geometry = {
  line_count: 4,
  line_height: 10,
  first_indent: 1,
  last_line_fill: 1,
  font_size: 10,
  font: "body",
};
function json(request: ModelRequest) {
  for (const m of request.messages)
    for (const p of m.parts)
      if ("text" in p)
        try {
          return JSON.parse(p.text) as Record<string, unknown>;
        } catch {
          /* system text */
        }
  throw Error("missing");
}
function bundle(
  source: ArchiveTextSource,
  ops = assigned(source),
): ArchiveTextBundleV2 {
  const r = reviewArrangement(source, ops),
    snapshot = acceptArrangement(
      source,
      {
        schema_version: 1,
        source_input_sha256: source.input_sha256,
        reviewed_candidates_sha256: r.candidates_sha256,
        operations: ops,
        break_decisions: r.candidates.map((c) =>
          ops.some(
            (o) =>
              o.kind === "merge" &&
              o.leaf_ids.includes(c.left_leaf_id) &&
              o.leaf_ids.includes(c.right_leaf_id),
          )
            ? { candidate_id: c.candidate_id, decision: "merge" }
            : {
                candidate_id: c.candidate_id,
                decision: "keep",
                reason: "new paragraph",
              },
        ),
      },
      "c".repeat(64),
    );
  const dest = new Map(
    snapshot.destinations.map((d) => [d.leaf_id, d.destination]),
  );
  return parseArchiveTextBundleV2({
    schema_version: 2,
    page_count: source.raw.page_count,
    source_blocks: source.blocks,
    arrangement: snapshot,
    leaves: snapshot.leaves.map((leaf) => ({
      leaf,
      destination: dest.get(leaf.leaf_id),
      corrected_text: leaf.original_text,
      correction_ids: [],
      text_source: "parser",
      basis: "text-layer",
    })),
  });
}
it("removes typed and repeated edge chrome, keeping notes and respecting coverage and edge thresholds", async () => {
  const f = await archiveTextFixture(
    [
      { text: "JOURNAL 42", type: "header" },
      { text: "Repeated Journal 1", page: 0 },
      { text: "Repeated Journal 2", page: 1 },
      { text: "Short Journal 4", page: 2 },
      { text: "7", page: 2 },
      { text: "Content note", type: "footnote", page: 2 },
      { text: "Real text", page: 2 },
    ],
    { page_count: 10 },
  );
  const blocks = f.source.blocks.map((b, i) => ({
    ...b,
    region_hint: (i === 0 || i === 5
      ? [10, 400, 400, 500]
      : i === 4
        ? [10, 920, 400, 950]
        : [10, 10, 400, 90]) as [number, number, number, number],
  }));
  let drops = programChromeDrops(blocks, 10);
  expect(drops.has(blocks[0]!.root_block_id)).toBe(true);
  expect(drops.has(blocks[1]!.root_block_id)).toBe(false);
  expect(drops.get(blocks[4]!.root_block_id)?.reason).toBe("footer");
  expect(drops.has(blocks[5]!.root_block_id)).toBe(false);
  drops = programChromeDrops(blocks, 6);
  expect(drops.get(blocks[1]!.root_block_id)?.rule).toContain("repeated-edge");
  const repeated = blocks.map((b, i) =>
    i === 3 ? { ...b, text: "Repeated Journal 3" } : b,
  );
  expect(programChromeDrops(repeated, 100).has(blocks[1]!.root_block_id)).toBe(
    true,
  );
  const interior = blocks.map((b) => ({
    ...b,
    region_hint: [0, 91, 500, 909] as const,
  }));
  expect(programChromeDrops(interior, 6).size).toBe(1);
});
it("audits program deletions, restores a manually locked header into the next request and skips an empty model window", async () => {
  const f = await archiveTextFixture([
    { text: "Running header", type: "header" },
    { text: "Body." },
  ]);
  const seen: unknown[] = [];
  const runtime = fakeTextRuntime(async (request) => {
    const input = json(request),
      blocks = input.blocks as { id: string; type: string }[];
    seen.push(input);
    return modelTool("submit_arrangement", {
      sections: [
        {
          first: blocks[0]!.id,
          last: blocks.at(-1)!.id,
          role: "methods",
          heading: null,
        },
      ],
      headings: [],
      drops: [],
      captions: [],
      splits: [],
    });
  });
  try {
    const service = new ArchiveArrangementService(
        runtime,
        fakePages(f.pages),
        memoryTextCache().cache,
      ),
      a = await service.build(f.source);
    expect((seen[0] as { blocks: unknown[] }).blocks).toHaveLength(1);
    expect(a.value!.operations[0]).toMatchObject({
      kind: "drop",
      source: "program",
      rule: "page-chrome-v1/mineru-header",
    });
    expect(a.value!.leaves).toHaveLength(2);
    const seed = {
      ...a.value!,
      manual_revision: 1,
      destinations: a.value!.destinations.map((d, i) =>
        i
          ? d
          : {
              ...d,
              destination: {
                kind: "assigned" as const,
                target: { role: "end-matter" as const },
                presentation: { kind: "content" as const },
              },
              locked: true,
              decision_id: "00000000-0000-4000-8000-000000000011",
            },
      ),
    };
    const b = await service.build(f.source, undefined, seed);
    expect(b.stop).toBeNull();
    expect((seen[1] as { blocks: unknown[] }).blocks).toHaveLength(2);
    expect(b.value!.destinations[0]!.destination).toMatchObject({
      kind: "assigned",
      target: { role: "end-matter" },
    });
    const all = await archiveTextFixture([
      { text: "Only header", type: "header" },
    ]);
    const c = await new ArchiveArrangementService(
      runtime,
      fakePages(all.pages),
      memoryTextCache().cache,
    ).build(all.source);
    expect(c.usage.calls).toBe(0);
    expect(c.value!.destinations[0]!.destination.kind).toBe("dropped");
  } finally {
    await runtime.close();
  }
});
it("separates direct boundary joins, geometry candidates and ordinary candidates, including cross-role joins", async () => {
  const f = await archiveTextFixture([
    { text: "We test-", page: 0 },
    { text: "ing the sample.", page: 1 },
    { text: "Sentence ended.", page: 1 },
    { text: "The next part.", page: 2 },
    ...Array.from({ length: 5 }, (_, i) => ({
      text: "Indented paragraph " + i + ".",
      page: 2,
    })),
  ]);
  const source = {
    ...f.source,
    blocks: f.source.blocks.map((b, i) => ({
      ...b,
      pdf_geometry: { ...geometry, first_indent: i === 3 ? 0 : 1 },
    })),
  };
  const ops = assigned(source);
  ops[1] = {
    ...(ops[1] as Extract<ArrangementOperation, { kind: "assign" }>),
    target: { role: "results-discussion" },
  };
  const r = reviewArrangement(source, ops);
  expect(r.candidates.map((c) => [c.basis, c.automatic, c.boundary])).toEqual([
    ["text", true, "page"],
    ["layout", false, "page"],
  ]);
  const imageOnly = {
    ...source,
    blocks: source.blocks.map(({ pdf_geometry, ...b }) => {
      expect(pdf_geometry).toBeDefined();
      return b;
    }),
  };
  expect(reviewArrangement(imageOnly, ops).candidates).toHaveLength(1);
  const ids = r.leaves.map((l) => l.leaf_id),
    b = bundle(source, [
      ...ops,
      { kind: "merge", leaf_ids: [ids[0]!, ids[1]!] },
    ]);
  expect(renderArrangement(b, []).markdown.toString()).toContain(
    "We test-ing the sample.",
  );
  const normal = await archiveTextFixture([
    { text: "to a" },
    { text: "variety of hosts." },
    {
      text: "a) Representative 2-Phosphinoylindoles in Pharmaceuticals and Materials",
    },
    { text: "oxidant, and the formed benzyl radical" },
  ]);
  const rr = reviewArrangement(normal.source, assigned(normal.source));
  expect(rr.candidates[0]!.automatic).toBe(false);
  expect(rr.candidates.at(-1)!.automatic).toBe(false);
});
it("does not ask the model to decide deterministic paragraph joins", async () => {
  const f = await archiveTextFixture([
    { text: "We" },
    { text: "A figure", type: "image", image: true },
    { text: "hypothesized this." },
  ]);
  const runtime = fakeTextRuntime(async () =>
    modelTool("submit_arrangement", {
      sections: [
        { first: "r1", last: "r2", role: "introduction", heading: null },
        { first: "r3", last: "r3", role: "results-discussion", heading: null },
      ],
      headings: [],
      drops: [],
      captions: [],
      splits: [],
    }),
  );
  try {
    const result = await new ArchiveArrangementService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source);
    expect(result.stop).toBeNull();
    expect(result.usage.calls).toBe(1);
    expect(result.value!.operations).toContainEqual(
      expect.objectContaining({
        kind: "merge",
        source: "program",
        rule: "paragraph-break-v3/text-boundary",
      }),
    );
  } finally {
    await runtime.close();
  }
});
it("measures real PDF dimensions and visible lines; geometry does not change page proofreading cache keys", async () => {
  const f = await archiveTextFixture([{ text: "Alpha beta" }]),
    page = {
      ...f.pages[0]!,
      layout: {
        width: 600,
        height: 800,
        items: [
          {
            bbox: [60, 80, 300, 90] as const,
            font_size: 10,
            font: "A",
            length: 10,
          },
          {
            bbox: [50, 100, 300, 110] as const,
            font_size: 10,
            font: "A",
            length: 10,
          },
          {
            bbox: [50, 120, 300, 130] as const,
            font_size: 10,
            font: "A",
            length: 10,
          },
        ],
      },
    };
  expect(measurePdfBlock([80, 80, 510, 180], page, [600, 800])).toMatchObject({
    line_count: 3,
    first_indent: 1,
    last_line_fill: 1,
    font_size: 10,
  });
  expect(
    measurePdfBlock([0, 0, 1000, 1000], page, [1000, 1000]),
  ).toBeUndefined();
  expect(
    measurePdfBlock(
      [0, 0, 1000, 1000],
      { ...page, hidden_glyphs: 1 },
      [600, 800],
    ),
  ).toBeUndefined();
  expect(
    measurePdfBlock([0, 0, 1000, 1000], f.pages[0], [600, 800]),
  ).toBeUndefined();
  expect(pageProofreadInputKey(f.source, [], [], page, "m")).toBe(
    pageProofreadInputKey(f.source, [], [], f.pages[0]!, "m"),
  );
});
it("renders source chapters, article information, shared panels, continued tables and cited page notes with UTF-8 ranges", async () => {
  const f = await archiveTextFixture([
    { text: "Article", type: "title" },
    { text: "Department of Science" },
    { text: "Ada Author" },
    { text: "1 Results", type: "title" },
    { text: "Body cites $^{a}$ with α😀." },
    { text: "A later paragraph." },
    { text: "$^{a}$ Note text.", type: "footnote" },
    { text: "", type: "image", image: true },
    { text: "", type: "image", image: true },
    { text: "Fig. 1. Two panels.", type: "caption" },
    { text: "2 Experiments", type: "title" },
    { text: "<table><tr><td>1</td></tr></table>", type: "table" },
    { text: "Table 1. Values", type: "caption" },
    { text: "<table><tr><td>2</td></tr></table>", type: "table" },
    { text: "Acknowledgements", type: "title" },
    { text: "Thanks." },
  ]);
  const source = {
    ...f.source,
    blocks: f.source.blocks.map((b, i) => ({
      ...b,
      region_hint: (i === 7
        ? [50, 300, 400, 450]
        : i === 8
          ? [500, 300, 850, 450]
          : i === 11
            ? [50, 600, 850, 650]
            : i === 13
              ? [50, 680, 850, 730]
              : [50, 100 + i * 5, 850, 120 + i * 5]) as [
        number,
        number,
        number,
        number,
      ],
    })),
  };
  const roles = [
    "title",
    "end-matter",
    "authors",
    ...Array(7).fill("results-discussion"),
    ...Array(4).fill("methods"),
    "end-matter",
    "end-matter",
  ];
  const ops = assigned(source).map((o, i) => ({
    ...o,
    target: { role: roles[i]! },
    presentation: [0, 3, 10, 14].includes(i)
      ? { kind: "section-heading" }
      : { kind: "content" },
  })) as ArrangementOperation[];
  const ids = arranged(source).leaves.map((l) => l.leaf_id);
  ops.push(
    {
      kind: "caption",
      object_leaf_id: ids[7]!,
      caption_leaf_ids: [ids[9]!],
      object_kind: "figure",
    },
    {
      kind: "caption",
      object_leaf_id: ids[8]!,
      caption_leaf_ids: [ids[9]!],
      object_kind: "figure",
    },
    {
      kind: "caption",
      object_leaf_id: ids[11]!,
      caption_leaf_ids: [ids[12]!],
      object_kind: "table",
    },
  );
  const b = bundle(source, ops),
    r = renderArrangement(b, source.raw.resources),
    text = r.markdown.toString(),
    layout = r.structure.layout!;
  expect(text.indexOf("Ada Author")).toBeLessThan(text.indexOf("Department"));
  expect(text.indexOf("1 Results")).toBeLessThan(text.indexOf("2 Experiments"));
  expect(text).not.toMatch(/## (?:引言|结果与讨论|文末信息)/u);
  expect(text.indexOf("Note text")).toBeLessThan(
    text.indexOf("A later paragraph"),
  );
  expect(layout.figure_groups.map((g) => [g.kind, g.rows])).toEqual([
    ["figure", [2]],
    ["table", [1, 1]],
  ]);
  expect(text.match(/Fig\. 1/gu)).toHaveLength(1);
  expect(layout.footnotes[0]).toMatchObject({
    page_index: 0,
    segment_id: ids[6],
  });
  for (const range of [
    ...layout.article_info,
    ...layout.footnotes,
    ...layout.figure_groups.flatMap((g) => [...g.objects, ...g.captions]),
  ])
    expect(
      r.markdown.subarray(range.start_utf8, range.end_utf8).length,
    ).toBeGreaterThan(0);
  expect(
    r.structure.sections.find((s) => s.title === "Acknowledgements")?.level,
  ).toBe(2);
  expect(
    arrangementAnnotation(
      "00000000-0000-4000-8000-000000000001",
      "main",
      b,
      r,
    ).segment_roles.find((s) => s.segment_id === ids[6])?.role,
  ).toBe("results-discussion");
  expect(parseDocumentStructureV2(r.structure, r.markdown.length)).toEqual(
    r.structure,
  );
  expect(() =>
    parseDocumentLayout({
      ...layout,
      footnotes: [{ ...layout.footnotes[0], page_index: -1 }],
    }),
  ).toThrow();
  expect(() =>
    parseDocumentStructureV2(
      {
        ...r.structure,
        layout: {
          ...layout,
          footnotes: [{ ...layout.footnotes[0], end_utf8: 1 }],
        },
      },
      r.markdown.length,
    ),
  ).toThrow();
});
it("delays a cross-role chapter boundary until after the merged paragraph without inventing headings", async () => {
  const f = await archiveTextFixture([
      { text: "We" },
      { text: "hypothesized this." },
      { text: "A second result." },
    ]),
    ops = assigned(f.source),
    ids = arranged(f.source).leaves.map((l) => l.leaf_id);
  ops[0] = {
    ...(ops[0] as Extract<ArrangementOperation, { kind: "assign" }>),
    target: { role: "introduction" },
  };
  ops.push({ kind: "merge", leaf_ids: [ids[0]!, ids[1]!] });
  const b = bundle(f.source, ops),
    r = renderArrangement(b, []);
  expect(r.markdown.toString()).toBe(
    "We hypothesized this.\n\nA second result.\n\n",
  );
  expect(r.structure.sections.map((s) => s.title)).toEqual([null, null]);
  expect(r.structure.sections[1]!.start_utf8).toBe(
    Buffer.byteLength("We hypothesized this.\n\n"),
  );
  const a = arrangementAnnotation(
    "00000000-0000-4000-8000-000000000001",
    "main",
    b,
    r,
  );
  expect(a.segment_roles.map((s) => s.role)).toEqual([
    "introduction",
    "methods",
    "methods",
  ]);
});
it("prefers numbered headings then reliable PDF styles, flattening end matter to body level", async () => {
  const f = await archiveTextFixture([
    { text: "1 Main", type: "title" },
    { text: "1.1 Sub", type: "title" },
    { text: "2 Main", type: "title" },
    { text: "2.1 Sub", type: "title" },
    { text: "Ack", type: "title" },
  ]);
  const ops = assigned(f.source).map((o, i) => ({
    ...o,
    target: { role: i === 4 ? "end-matter" : "methods" },
    presentation: { kind: "subheading", level: 5 },
  })) as ArrangementOperation[];
  expect(
    renderArrangement(bundle(f.source, ops), []).structure.sections.map(
      (s) => s.level,
    ),
  ).toEqual([2, 3, 2, 3, 2]);
  const base = bundle(f.source, ops),
    changed = {
      ...base,
      source_blocks: base.source_blocks.map((b, i) => ({
        ...b,
        pdf_geometry: { ...geometry, font_size: i % 2 ? 10 : 14 },
      })),
      leaves: base.leaves.map((r) => ({
        ...r,
        corrected_text: r.corrected_text.replace(/^\d(?:\.\d)?\s/u, ""),
      })),
    };
  expect(
    renderArrangement(changed, []).structure.sections.map((s) => s.level),
  ).toEqual([2, 3, 2, 3, 2]);
});
it("gates reading-order correction and leaves ambiguous and already ordered columns unchanged", async () => {
  const f = await archiveTextFixture(
    Array.from({ length: 6 }, (_, i) => ({ text: "Paragraph " + i + "." })),
  );
  const cols = f.source.blocks.map((b, i) => ({
    ...b,
    region_hint: [
      i < 3 ? 50 : 550,
      100 + (i % 3) * 100,
      i < 3 ? 450 : 950,
      150 + (i % 3) * 100,
    ] as const,
  }));
  const swapped = [...cols.slice(3), ...cols.slice(0, 3)];
  expect(correctReadingOrder(swapped)).toBe(swapped);
  expect(
    correctReadingOrder(swapped, true).map((b) => b.root_block_id),
  ).toEqual(cols.map((b) => b.root_block_id));
  expect(correctReadingOrder(cols, true)).toEqual(cols);
  expect(correctReadingOrder(cols.slice(0, 2), true)).toEqual(cols.slice(0, 2));
});
it("parses rule provenance and PDF geometry strictly and preserves the historical builder", async () => {
  const drop = {
    kind: "drop",
    leaf_id: "00000000-0000-4000-8000-000000000001",
    reason: "header",
    source: "program",
    rule: "page-chrome-v1/mineru-header",
  };
  expect(parseArrangementOperation(drop)).toEqual(drop);
  expect(() =>
    parseArrangementOperation({ ...drop, rule: undefined }),
  ).toThrow();
  expect(() =>
    parseArrangementOperation({ ...drop, source: "model" }),
  ).toThrow();
  const f = await archiveTextFixture([{ text: "Hello." }]),
    root = f.source.blocks[0]!;
  expect(parseArrangementSourceBlock(root, 1)).toEqual(root);
  expect(() =>
    parseArrangementSourceBlock(
      { ...root, pdf_geometry: { ...geometry, last_line_fill: NaN } },
      1,
    ),
  ).toThrow();
  expect(
    parseArrangementSourceBlock({ ...root, pdf_geometry: geometry }, 1)
      .pdf_geometry,
  ).toEqual(geometry);
  const b = bundle(f.source),
    legacy = renderArrangement(b, [], "arranged-leaves-v2");
  expect(legacy.markdown.toString()).toContain("## 方法");
  expect(legacy.structure.layout).toBeUndefined();
});

it("does not promote a figure-panel title that arrangement retained as content", async () => {
  const f = await archiveTextFixture([
    {
      text: "a) Representative 2-Phosphinoylindoles in Pharmaceuticals and Materials",
      type: "title",
    },
    { text: "oxidant, and the formed benzyl radical" },
  ]);
  const r = renderArrangement(bundle(f.source), []);
  expect(r.structure.sections.map((s) => s.title)).toEqual([null]);
  expect(r.markdown.toString()).not.toContain("#");
});

it("does not mistake a short one-line fragment for a full PDF column", async () => {
  const f = await archiveTextFixture([{ text: "Short." }]),
    page = {
      ...f.pages[0]!,
      layout: {
        width: 600,
        height: 800,
        items: [
          {
            bbox: [60, 80, 120, 90] as const,
            font_size: 10,
            font: "Body",
            length: 6,
          },
          {
            bbox: [50, 150, 300, 160] as const,
            font_size: 10,
            font: "Body",
            length: 40,
          },
        ],
      },
    };
  const g = measurePdfBlock(
    [90, 95, 210, 115],
    page,
    [600, 800],
    [80, 0, 510, 1000],
  );
  expect(g?.line_count).toBe(1);
  expect(g!.last_line_fill).toBeLessThan(0.6);
});
it("keeps unmarked page notes at their source position", async () => {
  const f = await archiveTextFixture([
    { text: "First paragraph." },
    { text: "Second paragraph." },
    { text: "Unmarked note.", type: "footnote" },
  ]);
  const r = renderArrangement(bundle(f.source), []);
  expect(r.markdown.toString()).toBe(
    "First paragraph.\n\nSecond paragraph.\n\nUnmarked note.\n\n",
  );
  expect(r.structure.layout!.footnotes).toHaveLength(1);
});

it("places first-page notes cited only by the title with article information after authors", async () => {
  const f = await archiveTextFixture([
      { text: "Native title†", type: "title" },
      { text: "Ada Author" },
      { text: "Body text." },
      { text: "† Electronic supporting material.", type: "footnote" },
    ]),
    ops = assigned(f.source),
    roles = ["title", "authors", "introduction", "end-matter"];
  const b = bundle(
      f.source,
      ops.map((o, i) => ({
        ...o,
        target: { role: roles[i]! },
      })) as ArrangementOperation[],
    ),
    r = renderArrangement(b, []),
    text = r.markdown.toString();
  expect(text.indexOf("Electronic supporting")).toBeGreaterThan(
    text.indexOf("Ada Author"),
  );
  expect(text.indexOf("Electronic supporting")).toBeLessThan(
    text.indexOf("Body text."),
  );
  expect(r.structure.layout!.article_info).toHaveLength(1);
});

it("keeps retained first-page publication dates out of the body continuation flow", async () => {
  const f = await archiveTextFixture([
    { text: "We selected the substrates and" },
    { text: "Received: March 4, 2018" },
    { text: "Published: April 6, 2018" },
    { text: "DBU as base to explore photocatalysts.", page: 1 },
  ]);
  const seen: Record<string, unknown>[] = [];
  const runtime = fakeTextRuntime(async (request) => {
    const input = json(request);
    seen.push(input);
    return seen.length === 1
      ? modelTool("submit_arrangement", {
          sections: [
            { first: "r1", last: "r1", role: "methods", heading: null },
            { first: "r2", last: "r3", role: "end-matter", heading: null },
            { first: "r4", last: "r4", role: "methods", heading: null },
          ],
          headings: [],
          drops: [],
          captions: [],
          splits: [],
        })
      : modelTool("submit_breaks", {
          decisions: [{ candidate: "c1", decision: "merge", reason: "" }],
        });
  });
  try {
    const result = await new ArchiveArrangementService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source);
    expect(result.stop).toBeNull();
    expect(result.value!.break_candidates).toHaveLength(1);
    expect(
      (seen[1]!.candidates as { skipped: string[] }[])[0]!.skipped,
    ).toEqual(["article-information", "article-information"]);
    expect(result.value!.operations.some((o) => o.kind === "merge")).toBe(true);
    expect(
      result.value!.destinations.every(
        (d) => d.destination.kind === "assigned",
      ),
    ).toBe(true);
  } finally {
    await runtime.close();
  }
});
