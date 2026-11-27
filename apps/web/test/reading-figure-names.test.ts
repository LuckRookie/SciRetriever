import { expect, it } from "vitest";
import { outlineLeaf } from "../src/reading/layers/leaf.js";
import {
  captionParts,
  figureName,
  type LayerFigure,
  type LayersModel,
  type LayersPort,
} from "../src/reading/layers/model.js";

// 脉络 sets a note's figures under its sentences (reading-experience 3.3.2):
// the ones it stands on and the ones it points to, each figure once.
it("sets the figures a note points to under it in 脉络, each once", () => {
  const point = (
    number: number,
    relations: { id: string; kind: "figure" | "table" }[],
  ) => ({
    number,
    primary: false,
    kind: "result",
    statement: `Note ${number}.`,
    label: null,
    key_terms: [],
    translation: null,
    evidence: [],
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
    byNumber: new Map(points.map((p) => [p.number, p])),
    sections: [{ section_id: null, title: null, numbers: [1, 2] }],
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
