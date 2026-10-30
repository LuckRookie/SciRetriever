import { expect, it } from "vitest";
import type { ArrangementLeaf } from "@sciretriever/contracts";
import type { PdfPageInspection } from "../src/browser/pdf-region.js";
import {
  editOperations,
  guardEdit,
  identifierFixes,
  pageReviewPlan,
  reviewNormalize,
  reviewTokens,
} from "../src/proofread/page-review.js";
import {
  matchingBlocks,
  opcodes,
  similarity,
} from "../src/proofread/sequence.js";

const page = (
  text: string,
  kind: PdfPageInspection["kind"] = "text-layer",
  unmapped = 0,
): PdfPageInspection => ({
  page: 0,
  kind,
  text,
  visible_glyphs: [...text].length,
  unmapped_glyphs: unmapped,
  hidden_glyphs: 0,
  has_graphics: false,
});
let next = 0;
const leaf = (text: string, type = "text"): ArrangementLeaf =>
  ({
    leaf_id: `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
    original_text: text,
    type,
    page_index: 0,
  }) as unknown as ArrangementLeaf;
const guard = (
  p: PdfPageInspection,
  l: ArrangementLeaf,
  o: string,
  n: string,
) => guardEdit(p, pageReviewPlan(p, [l]), l, o, n);

it("matches runs like difflib: longest common run first, then each side", () => {
  const a = "the cat sat on a mat".split(" "),
    b = "a cat sat on the mat".split(" ");
  expect(matchingBlocks(a, b)).toEqual([
    { a: 1, b: 1, size: 3 },
    { a: 5, b: 5, size: 1 },
  ]);
  expect(opcodes(a, b).map((o) => o[0])).toEqual([
    "replace",
    "equal",
    "replace",
    "equal",
  ]);
  expect(similarity("phosphinoylation", "phosphonylation")).toBeGreaterThan(
    0.8,
  );
  expect(similarity("eld", "field")).toBeLessThan(0.8);
});

it("treats LaTeX markup, dashes and quotes as notation, not text", () => {
  expect(reviewTokens("$\\mathrm{Gd_2O_3}$ – ’s")).toEqual(
    reviewTokens("Gd2O3 - 's"),
  );
  expect(reviewNormalize("antiar-\nrhythmic", true)).toBe("antiarrhythmic");
});

it("sends differences only for a trusted text layer and marks text the layer does not hold", () => {
  const text = leaf(
      "The sample was heated to 50 °C for 2 h and then cooled slowly.",
    ),
    figure = leaf("n-Bu OMe Ph R1 5aa", "image_caption");
  const trusted = pageReviewPlan(
    page("The sample was heated to 60 °C for 2 h and then cooled slowly."),
    [text, figure],
  );
  expect(trusted).toMatchObject({
    mode: "differences",
    trusted: true,
    differences: [{ leaf_id: text.leaf_id, parsed: "50", text_layer: "60" }],
    figure_leaf_ids: [figure.leaf_id],
  });
  expect(pageReviewPlan(page("", "image-only"), [text])).toMatchObject({
    mode: "whole-page",
    differences: [],
  });
  // Less than 90 % of the words match: the model compares the whole page with the image.
  expect(
    pageReviewPlan(
      page("The specimen got warm at sixty degrees for some hours."),
      [text],
    ).mode,
  ).toBe("whole-page");
});

it("refuses insertions from nothing, copyright lines, deletions, lost digits and structure labels", () => {
  const p = page(
      "We isolated 3a in 85% yield after 12 h at reflux in toluene.",
    ),
    l = leaf("We isolated 3a in 85% yield after 12 h at reflux in toluene.");
  expect(guard(p, l, "", "Figure 2")).toBe("insert-from-nothing");
  expect(guard(p, l, "toluene.", "toluene. © 2024 Elsevier")).toBe(
    "copyright",
  );
  expect(guard(p, l, "after 12 h at reflux in toluene.", "after")).toBe(
    "shrinks",
  );
  expect(guard(p, l, "85% yield", "% yield")).toBe("drops-digits");
  expect(guard(p, l, "3a", "3a O N Me Ph")).toBe("structure-labels");
  expect(guard(p, l, "not here", "x")).toBe("not-in-leaf");
});

it("lets an edit add only what the text layer prints at that place", () => {
  const refs =
      "(e) Seo, J.; Park, Y.; Jeon, I.; Ryu, T. Org. Lett. 2004, 6, 101.",
    p = page(refs),
    l = leaf(refs);
  // A single letter counts: the print says I., not J.
  expect(guard(p, l, "Jeon, I.", "Jeon, J.")).toBe("not-printed");
  const body = page(
      "did not generate the phosphonylation/cyclization product 3a in water",
    ),
    wrong = leaf(
      "did not generate the phosphorylation/cyclization product 3a in water",
    );
  expect(guard(body, wrong, "phosphorylation", "phosphinoylation")).toBe(
    "not-printed",
  );
  expect(guard(body, wrong, "phosphorylation", "phosphonylation")).toBeNull();
  // A citation the text layer glues to its word is still printed there.
  const cited = page(
      "P-radical reactions3 effectively build the C–P bond in good yield",
    ),
    c = leaf(
      "P-radical reactions effectively build the C–P bond in good yield",
    );
  expect(
    guard(cited, c, "reactions effectively", "reactions$^{3}$ effectively"),
  ).toBeNull();
  // Splitting a fused footnote marker is not a new spelling.
  const table = page("entry yielda,b (%) 1 85 2 90 3 75 4 60 5 trace"),
    t = leaf("entry yielda,b(%) 1 85 2 90 3 75 4 60 5 trace");
  expect(guard(table, t, "yielda,b(%)", "yield$^{a,b}$ (%)")).toBeNull();
});

it("refuses a close but different spelling even where the text layer is not trusted", () => {
  // Unmapped glyphs make the page untrusted for G1, but the place still shows the print.
  const p = page(
      "did not generate the phosphonylation/cyclization product 3a in water",
      "text-layer",
      4,
    ),
    l = leaf(
      "did not generate the phosphorylation/cyclization product 3a in water",
    );
  expect(guard(p, l, "phosphorylation", "phosphinoylation")).toBe("near-miss");
});

it("accepts a dash or curly quote only where the text layer prints one", () => {
  const acs = page(
      "Org. Lett. 2008, 10, 1691−1692. Lithiation−borylation of the ester",
    ),
    a = leaf(
      "Org. Lett. 2008, 10, 1691-1692. Lithiation-borylation of the ester",
    );
  // ACS stores the printed dash as the minus sign.
  expect(guard(acs, a, "1691-1692", "1691–1692")).toBeNull();
  const hyphen = page(
      "the 1,2-allenyl group and the UV-vis spectrum of the sample",
    ),
    h = leaf("the 1,2-allenyl group and the UV-vis spectrum of the sample");
  expect(guard(hyphen, h, "UV-vis", "UV–vis")).toBe("mark-not-printed");
  expect(guard(page("", "image-only"), h, "UV-vis", "UV–vis")).toBeNull();
});

it("takes a DOI as the text layer prints it", () => {
  const l = leaf("https://doi.org/10.1002/smssc.202300070");
  expect(
    identifierFixes(page("https://doi.org/10.1002/smsc.202300070"), [l]),
  ).toEqual([
    {
      leaf_id: l.leaf_id,
      original: "https://doi.org/10.1002/smssc.202300070",
      replacement: "https://doi.org/10.1002/smsc.202300070",
    },
  ]);
  expect(identifierFixes(page("no identifiers here"), [l])).toEqual([]);
});

it("corrects every occurrence of an original in its leaf, in code points", () => {
  const l = leaf("𝛼 Pd2(dbab)3 then Pd2(dbab)3");
  const ops = editOperations(
    l,
    "Pd2(dbab)3",
    "Pd2(dba)3",
    0,
    "printed dba\nsecond line",
  );
  expect(ops.map((o) => [o.start, o.end, o.reason])).toEqual([
    [2, 12, "printed dba"],
    [18, 28, "printed dba"],
  ]);
});
