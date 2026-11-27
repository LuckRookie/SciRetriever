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
  numberedPoints,
  unitSentences,
  type LayersFigure,
  type LayersGroup,
  type LayersParagraph,
  type LayersPlan,
} from "../src/layers/check.js";

// Spec 10.3 and ADR 0073 §7: each check of the paragraph-by-paragraph layers, on a synthetic input.
const PARAGRAPHS = [
  "The first sample showed a peak near 401 nm in water. It was stable for 12 days.",
  "The second sample showed a peak near 402 nm. Its yield was 85 %.",
  "One. Two. Three. Four. Five. Six. Seven.",
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
      sentences: unitSentences(source, caption ? "caption" : "text"),
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
  evidence: [1],
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

it("keeps existing sentences, joins consecutive ones, at most two (three from seven sentences)", () => {
  const out = check(
    section(
      all({
        1: { evidence: [2, 9, 2, 0] },
        3: { evidence: [7, 1, 2, 4] },
        4: { evidence: [1] },
      }),
    ),
  );
  // 9 and 0 name no sentence; 2 twice is once.
  expect(out.notes[0]!.evidence).toEqual([
    { kind: "sentence", unit_id: "u1", start_utf8: 53, end_utf8: 79 },
  ]);
  // Seven sentences allow three: 1 and 2 join, 4 stands apart, 7 is one too many.
  expect(
    out.notes[2]!.evidence.map(
      (e) => e.kind === "sentence" && [e.start_utf8, e.end_utf8],
    ),
  ).toEqual([
    [PS[2]!.start_utf8, PS[2]!.start_utf8 + 9],
    [PS[2]!.start_utf8 + 17, PS[2]!.start_utf8 + 22],
  ]);
  // A caption also rests on its own figure, last.
  expect(out.notes[3]!.evidence.at(-1)).toEqual({
    kind: "block",
    segment_id: "fig1",
  });
  expect(out.dropped.evidence).toBe(4);
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

it("keeps translated evidence only for existing consecutive sentences", () => {
  const points = numberedPoints(notes, document(digest()));
  const translation = "首句。第二句。第三句。";
  const asked = [0, 1].map((i) => ({
    paragraph: PS[i]!,
    point: points[i]!,
    translation,
    sentences: unitSentences(translation, "text"),
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
          evidence: [{ id: "e1", sentences: [2, 3] }],
        },
        {
          id: "p2",
          statement: "样品二出现峰。",
          reason: "",
          label: "样品三",
          key_terms: [],
          evidence: [{ id: "e1", sentences: [1, 3] }],
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
