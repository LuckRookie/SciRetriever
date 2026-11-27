import { expect, it } from "vitest";
import { outlineLeaf, overviewLeaf } from "../src/reading/layers/leaf.js";
import {
  captionParts,
  figureName,
  type LayerFigure,
  type LayersModel,
  type LayersPort,
} from "../src/reading/layers/model.js";

// A note that points to figures and a table, and a port that knows them.
const point = (
  number: number,
  relations: { id: string; kind: "figure" | "table" }[],
) => ({
  number,
  primary: true,
  kind: "result",
  statement: `Note ${number}.`,
  label: null,
  key_terms: [],
  translation: null,
  evidence: [],
  basis: {
    kind: "sentence",
    text: `Sentence ${number}.`,
    start_utf8: null,
    paragraph: number,
  },
  relations: relations.length
    ? [
        {
          word: "see",
          targets: relations.map((r) => ({
            kind: "block",
            segment_id: r.id,
            block_kind: r.kind,
            paragraph: 1,
          })),
        },
      ]
    : [],
});
const points = [
  point(1, [{ id: "fig-8", kind: "figure" }]),
  point(2, [
    { id: "fig-8", kind: "figure" },
    { id: "table-3", kind: "table" },
  ]),
];
const model = {
  points,
  primary: points,
  byNumber: new Map(points.map((p) => [p.number, p])),
  sections: [{ section_id: null, title: null, numbers: [1, 2] }],
  overview: {
    summary: { text: "Summary.", key_terms: [], translation: null },
    data: [],
    limits: [],
    advice: { text: null, not_given: "", places: [], translation: null },
  },
} as unknown as LayersModel;
const figure = (id: string, kind: "figure" | "table", lead: string) => ({
  segment_id: id,
  kind,
  label: lead,
  panels: id === "fig-8" ? ["fig-8", "fig-8b"] : [id],
  caption: () => `${lead}. Its caption.`,
  start: 0,
  image: async () => null,
});
const port = {
  title: null,
  section: () => null,
  blockAt: () => undefined,
  figure: (id: string) =>
    id === "fig-8"
      ? figure(id, "figure", "Fig. 8")
      : figure(id, "table", "Table 3"),
} as unknown as LayersPort;

// 脉络 on a wide sheet (reading-experience 3.3): a note's figure stands in its
// margin in place of its name among the relations; each figure once.
it("puts the figure a note points to in its margin in 脉络, in place of its name", () => {
  const { column, side } = outlineLeaf(model, port, "original", true);
  expect(column).not.toContain("rl-plate");
  const notes = side.split('<aside class="rl-pi rl-rel"').slice(1);
  // Note 1: the figure itself, “Fig. 8” under it, its name no longer a link.
  expect(notes[0]).toContain('<figure class="rl-mplate" data-fig="fig-8">');
  expect(notes[0]).toContain('data-image="fig-8b"');
  expect(notes[0]).toContain(
    "<figcaption><b>Fig. 8</b>Its caption.</figcaption>",
  );
  expect(notes[0]).not.toContain('<a data-fig="fig-8">');
  // Note 2: the figure is already beside note 1; a link goes there. A table
  // stays a name.
  expect(notes[1]).not.toContain("rl-mplate");
  expect(notes[1]).toContain('<a data-fig="fig-8">Fig. 8</a>');
  expect(notes[1]).toContain('<a data-fig="table-3">Table 3</a>');
});

// 脉络 on a sheet without a margin sets a note's figures under its sentences:
// the ones it stands on and the ones it points to, each figure once.
it("sets the figures a note points to under it in 脉络, each once", () => {
  const { column } = outlineLeaf(model, port, "original");
  const gangs = column.split('<section class="rl-gang').slice(1);
  expect(gangs[0]).toContain('<figure class="rl-plate" data-fig="fig-8"');
  expect(gangs[1]).not.toContain("rl-plate");
  expect(gangs[1]).toContain('<a data-fig="table-3">Table 3</a>');
  expect(column.match(/data-fig="fig-8"/g)).toHaveLength(1);
  // The whole figure: (a) and (b).
  expect(gangs[0]).toContain(
    'data-image="fig-8" data-zoom="fig-8" data-f="fig:fig-8"',
  );
  expect(gangs[0]).toContain('data-image="fig-8b"');
  expect(column).toContain("图表 2 件");
});

// 概览 sets a main note's figures in the margin beside it (reading-experience 3.2).
it("sets the figures a main note points to in the margin in 概览, each once", () => {
  const { column, side } = overviewLeaf(model, port, "original", () => null);
  expect(column).not.toContain("rl-plate");
  const plates = side.split('<figure class="rl-oplate"').slice(1);
  expect(plates).toHaveLength(1);
  expect(plates[0]).toContain('data-point="1" data-fig="fig-8"');
  expect(plates[0]).toContain('data-image="fig-8b"');
  expect(plates[0]).toContain("<b>Fig. 8</b>");
  expect(side).not.toContain("table-3");
});

// The layers name a figure by its caption's own lead (reading-experience 3.3:
// no bare “图” naming a part of the page).
it("takes a caption's lead, also after labels a parser ran into it", () => {
  expect(captionParts("Fig. 8. Nyquist (a) and Bode (b) plots.")).toEqual({
    lead: "Fig. 8",
    rest: "Nyquist (a) and Bode (b) plots.",
  });
  expect(captionParts("C1 C3Fig. 1. Molecular structures of dyes.")).toEqual({
    lead: "Fig. 1",
    rest: "Molecular structures of dyes.",
  });
  expect(captionParts("C1 C3图 1. 染料的分子结构。").lead).toBe("图 1");
  // A sentence that mentions a figure is not a lead.
  expect(captionParts("Molecular structures as in Fig. 2.").lead).toBeNull();
  expect(captionParts("In summary, see Fig. 2 for details.").lead).toBeNull();
});

it("names a figure in the reading's language, else by the engine's label", () => {
  const figure = (
    original: string,
    translation: string | null,
  ): LayerFigure => ({
    segment_id: "s",
    kind: "figure",
    label: "Fig. 8",
    panels: ["s"],
    caption: (mode) => (mode === "original" ? original : translation),
    start: 0,
    image: async () => null,
  });
  const f = figure("Fig. 8. Nyquist plots.", "图 8. Nyquist 图。");
  expect(figureName(f, "figure", "original")).toBe("Fig. 8");
  expect(figureName(f, "figure", "translation")).toBe("图 8");
  expect(
    figureName(figure("Fig. 8. Nyquist plots.", null), "figure", "translation"),
  ).toBe("Fig. 8");
  expect(figureName(null, "table", "original")).toBe("表");
});

it("reads a block's own words without the source control it carries", async () => {
  const { build } = await import("esbuild");
  const { chromium } = await import("playwright");
  const script = await build({
    entryPoints: ["apps/web/src/reading/block-text.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "BlockText",
    platform: "browser",
  });
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<style>.reading-block-source{display:none}</style><main><section id="b"><button class="reading-block-source">对照 PDF 自带的文字</button><p>Fig. 8. Nyquist plots.</p></section></main>',
    );
    await page.addScriptTag({ content: script.outputFiles[0]!.text });
    const read = await page.evaluate(() => {
      const { blockSourceText } = (
        window as unknown as {
          BlockText: {
            blockSourceText(block: HTMLElement, rendered?: boolean): string;
          };
        }
      ).BlockText;
      const block = document.getElementById("b")!;
      const shown = document.createElement("style");
      const off = blockSourceText(block, false);
      // Sources shown: the control is on the page and in innerText.
      shown.textContent = ".reading-block-source{display:inline}";
      document.head.append(shown);
      return { off, shown: blockSourceText(block) };
    });
    expect(read).toEqual({
      off: "Fig. 8. Nyquist plots.",
      shown: "Fig. 8. Nyquist plots.",
    });
  } finally {
    await browser.close();
  }
}, 30_000);
