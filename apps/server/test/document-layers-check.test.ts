import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { layersTextFits } from "@sciretriever/contracts";
import {
  LayersAnswerError,
  checkDocumentAnswer,
  checkLineAnswer,
  checkSectionAnswer,
  checkTranslationSectionAnswer,
  emptyDropped,
  layersParts,
  layersPlan,
  numberedPoints,
  sectionInput,
  type LayersFigure,
  type LayersGroup,
  type LayersParagraph,
  type LayersPlan,
} from "../src/layers/check.js";
import { locateQuote, locateQuotes } from "../src/layers/locate.js";

// Spec 10.3, ADR 0073 §7 and ADR 0074 §4: each check of the paragraph-by-paragraph layers, on a synthetic input.
const PARAGRAPHS = [
  "The first sample showed a peak near 401 nm in water. It was stable for 12 days.",
  "The second sample showed a peak near 402 nm. Its yield was 85 %.",
  "One. Two. Three. Four. Five. Six. Seven.",
  "Figure 1. Spectra of the samples.",
];
/** What each paragraph's note quotes by default: its first sentence, a caption whole. */
const FIRST = [
  "The first sample showed a peak near 401 nm in water.",
  "The second sample showed a peak near 402 nm.",
  "One.",
  "Figure 1. Spectra of the samples.",
];
const figure = (
  short: string,
  segment_id: string,
  kind: LayersFigure["kind"] = "figure",
): LayersFigure => ({
  short,
  segment_id,
  kind,
  start_utf8: 900,
  caption: `${short} caption.`,
  text:
    kind === "table" ? "| sample | yield |\n| 1 | 85 % |\n| 2 | 3.12 g |" : "",
  section_id: "sec1",
});
const F1 = figure("f1", "fig1"),
  F2 = figure("f2", "tab1", "table"),
  F3 = figure("f3", "fig3");
function paragraphs(): LayersParagraph[] {
  let at = 0;
  return PARAGRAPHS.map((source, i) => {
    const caption = i === 3;
    const p: LayersParagraph = {
      short: `p${i + 1}`,
      unit_id: `u${i + 1}`,
      source,
      start_utf8: at,
      kind: caption ? "caption" : "paragraph",
      figure: caption ? F1 : null,
      section_id: "sec1",
      annotatable: true,
    };
    at += Buffer.byteLength(source) + 2;
    return p;
  });
}
const PS = paragraphs();
const GROUP: LayersGroup = {
  section_id: "sec1",
  heading: {
    short: "s1",
    segment_id: "head1",
    section_id: "sec1",
    line: "Results",
    level: 1,
  },
  paragraphs: PS,
  figures: [F1, F2],
  parts: [PS],
};
const PLAN: LayersPlan = {
  title: "Synthetic",
  abstract: "",
  headings: new Map([["s1", GROUP.heading!]]),
  paragraphs: new Map(PS.map((p) => [p.short, p])),
  units: new Map(PS.map((p) => [p.unit_id, p])),
  figures: new Map([
    ["f1", F1],
    ["f2", F2],
    ["f3", F3],
  ]),
  groups: [GROUP],
  body_code_points: 4000,
  annotatable: 4,
};
const unit = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `p${n}`,
  kind: "result",
  statement: `Sample ${n} showed a peak.`,
  reason: "",
  label: `Sample ${n}`,
  evidence: [FIRST[n - 1] ?? "none"],
  key_terms: [],
  see: [],
  ...extra,
});
const section = (units: unknown[], line: Record<string, unknown> = {}) => ({
  section: {
    statement: "The section measures four samples.",
    label: "four samples",
    ...line,
  },
  units,
});
const check = (value: unknown, part = false) => {
  const dropped = emptyDropped();
  return { ...checkSectionAnswer(value, GROUP, PS, part, dropped), dropped };
};
const all = (extra: Record<number, Record<string, unknown>> = {}) =>
  [1, 2, 3, 4].map((n) => unit(n, extra[n]));

const range = (e: unknown) => {
  const s = e as { kind: string; start_utf8: number; end_utf8: number };
  return s.kind === "sentence" ? [s.start_utf8, s.end_utf8] : s.kind;
};
it("locates the first two quotes in their own paragraph; overlapping and touching ones become one evidence", () => {
  const out = check(
    section(
      all({
        // A stretch of another paragraph is not found here; one inside another is one place.
        1: {
          evidence: [
            "It was stable for 12 days.",
            "The second sample showed a peak",
          ],
        },
        4: {
          evidence: ["Spectra of the samples.", "Spectra of the"],
        },
        // Two sentences with only a space between them are one evidence.
        2: {
          evidence: [
            "Its yield was 85 %.",
            "The second sample showed a peak near 402 nm.",
          ],
        },
        // Overlapping quotes merge; a third quote is dropped.
        3: { evidence: ["Two. Three.", "Three. Four.", "Seven."] },
      }),
    ),
  );
  expect(out.notes[0]!.evidence).toEqual([
    { kind: "sentence", unit_id: "u1", start_utf8: 53, end_utf8: 79 },
  ]);
  const p2 = PS[1]!.start_utf8,
    p3 = PS[2]!.start_utf8;
  expect(out.notes[1]!.evidence.map(range)).toEqual([[p2, p2 + 64]]);
  expect(out.notes[2]!.evidence.map(range)).toEqual([[p3 + 5, p3 + 22]]);
  // A caption also rests on its own figure, last.
  expect(out.notes[3]!.evidence.map(range)).toEqual([
    [PS[3]!.start_utf8 + 10, PS[3]!.start_utf8 + 33],
    "block",
  ]);
  expect(out.notes[3]!.evidence.at(-1)).toEqual({
    kind: "block",
    segment_id: "fig1",
  });
  // Note 1: the one not found; note 3: its third.
  expect(out.dropped.evidence).toBe(2);
});

it("finds a quote exactly, across whitespace and TeX, with symbol commands as shown, and without citation marks", () => {
  const at = (text: string, quote: string) => {
    const r = locateQuote(text, quote, 300);
    return "miss" in r ? r.miss : text.slice(r.start, r.end);
  };
  expect(at("It rose. It fell.", "It fell.")).toBe("It fell.");
  // Whitespace and TeX markup do not count; the place maps back to the original.
  expect(
    at(
      "We find that the yield of $\\mathrm{NH_{3}}$ rose  to 85\\% at\nroom temperature.",
      "the yield of NH3 rose to 85% at room temperature",
    ),
  ).toBe("the yield of $\\mathrm{NH_{3}}$ rose  to 85\\% at\nroom temperature");
  // \circ is the degree sign it shows, also KaTeX's ∘; a place never cuts a formula.
  const melting = "The salt melts at $177 - 178^{\\circ}C$. It is stable.";
  expect(at(melting, "melts at 177–178 °C")).toBe(
    "melts at $177 - 178^{\\circ}C$",
  );
  expect(at(melting, "melts at 177−178∘C")).toBe(
    "melts at $177 - 178^{\\circ}C$",
  );
  expect(at("A shift of $\\Delta\\alpha$ was seen.", "shift of Δα was")).toBe(
    "shift of $\\Delta\\alpha$ was",
  );
  // Citation marks are skipped on both sides; dashes and quotes are unified.
  expect(
    at(
      "Pd is best for hydrogenation.[48] Among them, Ru is cheap.",
      "Pd is best for hydrogenation. Among them",
    ),
  ).toBe("Pd is best for hydrogenation.[48] Among them");
  expect(
    at(
      "It binds metals. $^{4,5}$ The salts — “dry” ones — were used.",
      'binds metals. The salts - "dry" ones',
    ),
  ).toBe("binds metals. $^{4,5}$ The salts — “dry” ones");
});

it("accepts a place two characters away only when it is the only one; drops ambiguous, overlong and missing quotes", () => {
  const at = (text: string, quote: string, max = 300) => {
    const r = locateQuote(text, quote, max);
    return "miss" in r ? r.miss : text.slice(r.start, r.end);
  };
  // The model corrected the author's misspelling.
  expect(
    at(
      "The photaredox catalyst gave the product in 85% yield.",
      "The photoredox catalyst gave the product",
    ),
  ).toBe("The photaredox catalyst gave the product");
  // Three characters away is too far; a short quote is never matched loosely.
  expect(
    at("The photaredox catalyst gave it.", "The phitoredix catalist gave it"),
  ).toBe("missing");
  expect(at("A peak at 401 nm.", "A peek at")).toBe("missing");
  // Twice in the paragraph: no place, exactly or loosely.
  expect(
    at("The value rose. The value rose. Then it fell.", "The value rose."),
  ).toBe("ambiguous");
  expect(
    at(
      "Sample A gave 85 percent yield and sample B gave 86 percent yield.",
      "sample C gave 87 percent yield",
    ),
  ).toBe("ambiguous");
  // Longer than 300 code points, or empty.
  const long = "word ".repeat(70).trim();
  expect(at(long, long.slice(0, 301))).toBe("long");
  expect(at("Text.", "  ")).toBe("empty");
  // Counted: a third quote and every quote not found.
  expect(
    locateQuotes(
      "It rose. It fell. Then more.",
      ["It fell.", "It rose.", "Then more."],
      2,
      300,
    ),
  ).toEqual({ ranges: [{ start: 0, end: 17 }], dropped: 1 });
});

it("drops a note with an overlong statement or no evidence left; an empty statement is no note and no drop", () => {
  const out = check(
    section(
      all({
        1: { statement: Array(21).fill("word").join(" ") },
        2: { evidence: [5] },
        3: { statement: "" },
        4: { statement: "图".repeat(41) },
      }),
    ),
  );
  expect(out.notes).toEqual([]);
  expect(out.dropped).toMatchObject({ points: 3, evidence: 1 });
  // Forty CJK characters fit; twenty words fit.
  expect(layersTextFits("图".repeat(40), 40, 20, 300)).toBe(true);
  expect(layersTextFits(Array(20).fill("w").join(" "), 40, 20, 300)).toBe(true);
});

it("drops a kind outside the seven, an overlong reason, and a label that is too long or not in the statement", () => {
  const out = check(
    section(
      all({
        1: { kind: "finding" },
        2: { reason: Array(31).fill("because").join(" ") },
        3: { label: "Sample 3 showed a" },
        4: { label: "a peak elsewhere" },
      }),
    ),
  );
  expect(out.notes.map((n) => [n.kind, n.reason, n.label])).toEqual([
    [null, null, "Sample 1"],
    ["result", null, "Sample 2"],
    ["result", null, null],
    ["result", null, null],
  ]);
  expect(out.dropped).toMatchObject({ kinds: 1, reasons: 1, labels: 2 });
  // A label is found whatever its case.
  expect(
    check(section(all({ 1: { label: "sample 1 SHOWED" } }))).notes[0]!.label,
  ).toBe("sample 1 SHOWED");
});

it("keeps at most two key terms found in the statement", () => {
  const out = check(
    section(
      all({
        1: {
          statement: "Raman spectra of crystals showed a peak.",
          key_terms: ["crystal", "absent", "Raman spectra", "peak"],
        },
      }),
    ),
  );
  expect(out.notes[0]!.key_terms).toEqual(["crystal", "Raman spectra"]);
  expect(out.dropped.key_terms).toBe(2);
});

it("keeps `see` only for figures of this section, not the caption's own, at most three", () => {
  const out = check(
    section(
      all({ 1: { see: ["f2", "f3", "f9", "f2"] }, 4: { see: ["f1", "f2"] } }),
    ),
  );
  expect(out.notes[0]!.see).toEqual(["tab1"]);
  expect(out.notes[3]!.see).toEqual(["tab1"]);
  expect(out.dropped.see).toBe(4);
  const points = numberedPoints(out.notes, null);
  expect(points[0]!.relations).toEqual([
    { word: "see", targets: [{ kind: "block", segment_id: "tab1" }] },
  ]);
});

it("asks again when the answer is not the structure or names fewer than half the paragraphs", () => {
  expect(() => check({ units: "none" })).toThrow(LayersAnswerError);
  expect(() => check({ units: [{ id: "p1" }] })).toThrow(LayersAnswerError);
  expect(() => check(section([unit(1)]))).toThrow(LayersAnswerError);
  // Half is enough; the others count as unanswered.
  const out = check(section([unit(1), unit(3), unit(9)]));
  expect(out.notes.map((n) => n.paragraph.short)).toEqual(["p1", "p3"]);
  expect(out.dropped.unanswered).toBe(2);
});

it("keeps a section line that fits, none for a part; a line call checks the same", () => {
  expect(check(section(all())).line).toEqual({
    statement: "The section measures four samples.",
    label: "four samples",
  });
  expect(check(section(all()), true).line).toBeNull();
  const overlong = check(
    section(all(), { statement: Array(21).fill("w").join(" ") }),
  );
  expect(overlong.line).toBeNull();
  expect(overlong.dropped.sections).toBe(1);
  const dropped = { sections: 0, labels: 0 };
  expect(
    checkLineAnswer(
      { section: { statement: "A line.", label: "missing" } },
      dropped,
    ),
  ).toEqual({
    statement: "A line.",
    label: null,
  });
  expect(dropped).toEqual({ sections: 0, labels: 1 });
  expect(() => checkLineAnswer({ line: "x" }, dropped)).toThrow(
    LayersAnswerError,
  );
});

it("splits a long section into runs of about equal size", () => {
  const many = Array.from({ length: 41 }, (_, i) => `p${i}`);
  expect(layersParts(many, () => "x").map((r) => r.length)).toEqual([21, 20]);
  expect(
    layersParts(["a", "b", "c"], () => "x".repeat(6001)).map((r) => r.length),
  ).toEqual([2, 1]);
  expect(layersParts(["a"], () => "x".repeat(30_000))).toEqual([["a"]]);
});

const notes = check(section(all())).notes;
const NUMBERS = new Map(notes.map((n, i) => [n.paragraph.short, i + 1]));
const digest = (extra: Record<string, unknown> = {}) => ({
  digest: {
    summary: {
      text: "Four samples were measured; the trend is stable.",
      units: ["p1", "p9"],
      key_terms: [],
    },
    limits: [],
    advice: {
      text: null,
      not_given: "Nothing to add.",
      units: [],
      key_terms: [],
      places: [],
    },
  },
  primary: ["p1", "p2", "p3"],
  relations: [],
  data: [],
  ...extra,
});
const document = (value: unknown, see = new Map<number, number>()) => {
  const dropped = emptyDropped();
  return {
    ...checkDocumentAnswer(value, PLAN, NUMBERS, see, dropped),
    dropped,
  };
};

it("keeps the first five of the trunk by number and drops what names no note", () => {
  const out = document(
    digest({ primary: ["p4", "p9", "p3", "p1", "p2", "p3", "f1"] }),
  );
  expect([...out.primary]).toEqual([1, 2, 3, 4]);
  expect(out.dropped.primary).toBe(3);
  expect(out.dropped.digest_units).toBe(1);
  const points = numberedPoints(notes, out);
  expect(points.filter((p) => p.primary).map((p) => p.basis)).toEqual(
    points.filter((p) => p.primary).map((p) => p.evidence[0]),
  );
  expect(points.find((p) => !p.primary)).toBeUndefined();
});

it("drops a relation with a fixed word missing, a target that is no note or itself, or beyond three", () => {
  const out = document(
    digest({
      relations: [
        { from: "p2", word: "follows", targets: ["p1"] },
        { from: "p2", word: "see", targets: ["p1"] },
        { from: "p2", word: "supports", targets: ["p1"] },
        { from: "p3", word: "explains", targets: ["p3"] },
        { from: "p3", word: "explains", targets: ["p1", "p9"] },
        { from: "p9", word: "follows", targets: ["p1"] },
        { from: "p4", word: "sums_up", targets: ["p1", "p2"] },
        { from: "p4", word: "based_on", targets: ["p1"] },
        { from: "p4", word: "extends", targets: ["p3"] },
      ],
    }),
    // Note 4 already has a `see`: two more fit.
    new Map([[4, 1]]),
  );
  expect(out.relations.get(2)).toEqual([
    { word: "follows", targets: [{ kind: "point", number: 1 }] },
  ]);
  expect(out.relations.get(3)).toBeUndefined();
  expect(out.relations.get(4)!.map((r) => r.word)).toEqual([
    "sums_up",
    "based_on",
  ]);
  expect(out.dropped.relations).toBe(6);
});

it("drops a data row whose digits are not in its source, a place not in the advice, an overlong limitation and summary", () => {
  const out = document(
    digest({
      digest: {
        summary: { text: "x".repeat(401), units: [], key_terms: [] },
        limits: [
          { text: "Only water.", units: ["p1"] },
          { text: "y".repeat(201), units: [] },
        ],
        advice: {
          text: "Read Results and f2.",
          not_given: null,
          units: [],
          key_terms: [],
          places: [
            { text: "Results", target: "s1" },
            { text: "f2", target: "f2" },
            { text: "Methods", target: "s1" },
            { text: "Results", target: "s9" },
          ],
        },
      },
      data: [
        { quantity: "Peak", value: "401 nm", source: "p1" },
        { quantity: "Yield", value: "85 %", source: "f2" },
        { quantity: "Mass", value: "3.1 g", source: "f2" },
        { quantity: "Peak", value: "40 nm", source: "p1" },
        { quantity: "Figure value", value: "1", source: "f1" },
      ],
    }),
  );
  expect(out.summary_missing).toBe(true);
  expect(out.digest.limits.map((l) => l.text)).toEqual(["Only water."]);
  expect(out.digest.advice.places.map((p) => p.text)).toEqual([
    "Results",
    "f2",
  ]);
  expect(out.data.map((d) => d.value)).toEqual(["401 nm", "85 %"]);
  expect(out.dropped).toMatchObject({ limits: 1, places: 2, data: 3 });
  expect(() => document({ digest: { summary: "none" } })).toThrow(
    LayersAnswerError,
  );
});

it("locates translated evidence in the unit's translation, or leaves its position empty", () => {
  const points = numberedPoints(notes, document(digest()));
  const translation = "首句。第二句。第三句。";
  const asked = [0, 1].map((i) => ({
    paragraph: PS[i]!,
    point: points[i]!,
    translation,
    evidence: [0],
  }));
  const dropped = {
    points: 0,
    sections: 0,
    reasons: 0,
    labels: 0,
    key_terms: 0,
    evidence: 0,
    places: 0,
  };
  const out = checkTranslationSectionAnswer(
    {
      section: { statement: "本节测量了四个样品。", label: "四个样品" },
      units: [
        {
          id: "p1",
          statement: "样品一出现峰。",
          reason: "",
          label: "样品一",
          key_terms: ["样品"],
          evidence: [{ id: "e1", quote: "第二句。 第三句。" }],
        },
        {
          id: "p2",
          statement: "样品二出现峰。",
          reason: "",
          label: "样品三",
          key_terms: [],
          evidence: [{ id: "e1", quote: "第四句。" }],
        },
      ],
    },
    asked,
    false,
    dropped,
  );
  expect(out.points.get("u1")).toEqual({
    statement: "样品一出现峰。",
    reason: null,
    label: "样品一",
    key_terms: ["样品"],
    evidence: [{ start_utf8: 9, end_utf8: 33 }],
  });
  expect(out.points.get("u2")).toMatchObject({ label: null, evidence: [null] });
  expect(out.line).toEqual({
    statement: "本节测量了四个样品。",
    label: "四个样品",
  });
  expect(dropped).toMatchObject({ evidence: 1, labels: 1 });
});

it("leaves a table note out of the paragraphs: not sent, no note, not counted", () => {
  const texts = [
    "The salts were dried and weighed before every measurement of the spectra in water at room temperature, and each was measured three times.",
    "Table 1. Peaks of the salts.",
    "| salt | peak |\n| --- | --- |\n| 1 | 401 nm |",
    "$^{a}$ Measured in water at room temperature after drying every salt for twelve hours under vacuum at 80 °C.",
  ];
  const kinds = ["paragraph", "caption", "table", "footnote"];
  let markdown = "";
  const segments = texts.map((t, i) => {
    const start_utf8 = Buffer.byteLength(markdown);
    markdown += t + "\n\n";
    return {
      segment_id: `s${i}`,
      kind: kinds[i]!,
      start_utf8,
      end_utf8: start_utf8 + Buffer.byteLength(t),
      section_id: null,
    };
  });
  const range = (i: number) => ({
    segment_id: `s${i}`,
    start_utf8: segments[i]!.start_utf8,
    end_utf8: segments[i]!.end_utf8,
  });
  // A table is no unit of the translation; its note is one.
  const units = [0, 1, 3].map((i) => ({
    unit_id: `s${i}`,
    segment_ids: [`s${i}`],
    source: texts[i]!,
    source_sha256: createHash("sha256").update(texts[i]!, "utf8").digest("hex"),
  }));
  const plan = layersPlan(
    units as never,
    {
      segments,
      sections: [],
      layout: {
        schema_version: 1,
        article_info: [],
        figure_groups: [
          {
            group_id: "g1",
            kind: "table",
            objects: [{ ...range(2), row: 0, column: 0 }],
            captions: [range(1)],
            notes: [range(3)],
            rows: [0],
          },
        ],
        footnotes: [],
      },
    },
    Buffer.from(markdown),
    new Map(),
    "Synthetic",
  );
  // The paragraph and the caption are paragraphs; the note is neither sent nor counted.
  expect([...plan.paragraphs.values()].map((p) => p.unit_id)).toEqual([
    "s0",
    "s1",
  ]);
  expect(plan.units.has("s3")).toBe(false);
  expect(plan.annotatable).toBe(1);
  expect(plan.body_code_points).toBe(
    [...texts[0]!].length + [...texts[1]!].length,
  );
  expect(plan.figures.get("f1")).toMatchObject({ kind: "table" });
  const group = plan.groups[0]!;
  const input = sectionInput(plan, group, group.paragraphs, null);
  expect(input).toContain("[p2] caption of f1");
  expect(input).not.toContain("Measured in water");
  // Without the note in the layout it is an ordinary footnote paragraph.
  const plain = layersPlan(
    units as never,
    { segments, sections: [] },
    Buffer.from(markdown),
    new Map(),
    "Synthetic",
  );
  expect(plain.units.has("s3")).toBe(true);
});
