import { expect, it } from "vitest";
import {
  documentLayersFileVersion,
  layersLabelFits,
  layersLabelInStatement,
  layersReasonFits,
  layersStatementFits,
  markKeyTerms,
  matchKeyTerm,
  parseDocumentLayersFile,
  sentenceNumbers,
  splitSentences,
  splitSentencesUtf8,
} from "../src/index.js";

const sentences = (text: string, whole = false) =>
  splitSentences(text, { whole }).map((s) => text.slice(s.start, s.end));
const marked = (text: string, term: string) =>
  matchKeyTerm(text, term).map((r) => text.slice(r.start, r.end));

it("splits sentences at sentence ends only (sentence-split-v1)", () => {
  expect(sentences("First result. Second result! Third? Last.")).toEqual([
    "First result.",
    "Second result!",
    "Third?",
    "Last.",
  ]);
  // A period needs whitespace and an upper-case letter, a digit or a quote after it.
  expect(sentences("It rose. then fell. 3 samples followed.")).toEqual([
    "It rose. then fell.",
    "3 samples followed.",
  ]);
  expect(sentences('He wrote. "Quoted" next.')).toEqual([
    "He wrote.",
    '"Quoted" next.',
  ]);
  // Abbreviations, numbers and ellipses do not split.
  expect(
    sentences(
      "Salts, e.g. NaCl, were used (Fig. 2). Smith et al. Reported it. See Eq. 3 vs. No. 5 and Dr. Who.",
    ),
  ).toEqual([
    "Salts, e.g. NaCl, were used (Fig. 2).",
    "Smith et al. Reported it.",
    "See Eq. 3 vs. No. 5 and Dr. Who.",
  ]);
  expect(sentences("The yield was 3.12 g. It was pure.")).toEqual([
    "The yield was 3.12 g.",
    "It was pure.",
  ]);
  expect(sentences("Wait...for it. Then go")).toEqual([
    "Wait...for it.",
    "Then go",
  ]);
  // Closing quotes and brackets join the sentence before them; an opening
  // bracket is not among the starts of a sentence the rule names.
  expect(sentences('They said "stop." Then (it worked.) Next.')).toEqual([
    'They said "stop."',
    "Then (it worked.)",
    "Next.",
  ]);
  // Semicolons, colons and line breaks never split.
  expect(sentences("One; two: three\nfour. Five.")).toEqual([
    "One; two: three\nfour.",
    "Five.",
  ]);
  // Chinese sentence ends, with closing quotes kept.
  expect(sentences("我们合成了化合物。产率很高！为什么？“好。”结束")).toEqual([
    "我们合成了化合物。",
    "产率很高！",
    "为什么？",
    "“好。”",
    "结束",
  ]);
  // Inline math stays in its sentence; display math is a sentence of its own.
  expect(
    sentences("We use $a. B$ here. Then $$x = 1. Y$$ and more. End."),
  ).toEqual([
    "We use $a. B$ here.",
    "Then",
    "$$x = 1. Y$$",
    "and more.",
    "End.",
  ]);
  // Headings and captions are one sentence.
  expect(sentences("Figure 1. Spectra. Of samples.", true)).toEqual([
    "Figure 1. Spectra. Of samples.",
  ]);
});

it("gives UTF-8 ranges and the sentence numbers a range touches", () => {
  const text = "首句。Second one. Third.";
  const ranges = splitSentencesUtf8(text);
  expect(ranges).toEqual([
    { start_utf8: 0, end_utf8: 9 },
    { start_utf8: 9, end_utf8: 20 },
    { start_utf8: 21, end_utf8: 27 },
  ]);
  // A range starting inside a sentence counts that sentence.
  expect(sentenceNumbers(ranges, 12, 27)).toEqual([2, 3]);
});

it("matches key terms by key-term-match-v1", () => {
  // Case does not matter.
  expect(marked("Raman Spectra and raman spectra", "raman spectra")).toEqual([
    "Raman Spectra",
    "raman spectra",
  ]);
  // A plural with s or es.
  expect(
    marked("one crystal, two crystals; process and processes", "crystal"),
  ).toEqual(["crystal", "crystals"]);
  expect(marked("processes", "process")).toEqual(["processes"]);
  // Never inside a word.
  expect(marked("crystalline, nanocrystal, crystallize", "crystal")).toEqual(
    [],
  );
  expect(marked("tetrazoles", "azole")).toEqual([]);
  // Chinese matches character by character, inside longer words too.
  expect(marked("含能材料与高能含能材料", "含能材料")).toEqual([
    "含能材料",
    "含能材料",
  ]);
  expect(marked("用TiO2薄膜", "TiO2")).toEqual(["TiO2"]);
  // Several terms never overlap; the first term wins.
  expect(
    markKeyTerms("thermal stability of salts", [
      "thermal stability",
      "stability",
    ]),
  ).toEqual([{ start: 0, end: 17, term: 0 }]);
});

const D = "a".repeat(64);
const note = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  unit_id: `u${number}`,
  statement: `Sample ${number} showed a peak near 401 nm.`,
  reason: null,
  evidence: [
    { kind: "sentence", unit_id: `u${number}`, start_utf8: 0, end_utf8: 10 },
  ],
  key_terms: [],
  section_id: null,
  primary: number <= 3,
  label: `sample ${number}`,
  kind: "result",
  relations: [],
  basis:
    number <= 3
      ? { kind: "sentence", unit_id: `u${number}`, start_utf8: 0, end_utf8: 10 }
      : null,
  ...extra,
});
const DROPPED = [
  "unanswered",
  "points",
  "evidence",
  "key_terms",
  "kinds",
  "labels",
  "reasons",
  "see",
  "sections",
  "relations",
  "primary",
  "digest_units",
  "data",
  "places",
  "limits",
];
const file = (extra: Record<string, unknown> = {}) => ({
  schema_version: 3,
  literature_id: "lit-1",
  asset_id: "asset-1",
  document_version_id: "doc-1",
  annotation_id: D,
  content_version: D,
  sentence_rule: "sentence-split-v1",
  digest: {
    summary: { text: "Four samples.", units: [], key_terms: [] },
    limits: [],
    advice: {
      text: null,
      not_given: null,
      units: [],
      key_terms: [],
      places: [],
    },
  },
  sections: [
    {
      section_id: null,
      statement: "Four samples peak near 401 nm.",
      label: "Four samples",
    },
  ],
  points: [1, 2, 3, 4].map((n) => note(n)),
  data: [],
  model: "fixture/model",
  prompt_version: "reading-layers-v3",
  dropped: Object.fromEntries(DROPPED.map((k) => [k, 0])),
  translation: null,
  ...extra,
});

it("parses a version 3 layers file: one note per paragraph, its basis its first evidence", () => {
  expect(parseDocumentLayersFile(file()).points).toHaveLength(4);
  expect(documentLayersFileVersion(file({ schema_version: 2 }))).toBe(2);
  // Version 2 is not the current layout: it reads as stale, never parsed.
  expect(() => parseDocumentLayersFile(file({ schema_version: 2 }))).toThrow();
  const four = [1, 2, 3, 4].map((n) => note(n));
  const bad = (points: unknown[]) => () =>
    parseDocumentLayersFile(file({ points }));
  // A note's sentence evidence lies in its own paragraph.
  const elsewhere = {
    kind: "sentence",
    unit_id: "u9",
    start_utf8: 0,
    end_utf8: 10,
  };
  expect(
    bad([
      note(1, { evidence: [elsewhere], basis: elsewhere }),
      ...four.slice(1),
    ]),
  ).toThrow();
  // A primary note's basis is its first evidence; others have none.
  expect(bad([note(1, { basis: null }), ...four.slice(1)])).toThrow();
  // Two notes on one paragraph, a label not in its statement, an overlong statement.
  expect(bad([...four.slice(0, 3), note(4, { unit_id: "u1" })])).toThrow();
  expect(bad([...four.slice(0, 3), note(4, { label: "elsewhere" })])).toThrow();
  expect(
    bad([
      ...four.slice(0, 3),
      note(4, { statement: Array(21).fill("w").join(" ") }),
    ]),
  ).toThrow();
  // `see` names figures only; the other words name notes only.
  expect(
    bad([
      ...four.slice(0, 3),
      note(4, {
        relations: [
          { word: "follows", targets: [{ kind: "block", segment_id: "f" }] },
        ],
      }),
    ]),
  ).toThrow();
});

it("measures notes, reasons and labels by CJK characters or words, and finds a label in its statement", () => {
  expect(layersStatementFits("图".repeat(40))).toBe(true);
  expect(layersStatementFits("图".repeat(41))).toBe(false);
  expect(layersStatementFits(Array(21).fill("w").join(" "))).toBe(false);
  expect(layersReasonFits(Array(30).fill("w").join(" "))).toBe(true);
  expect(layersLabelFits("热稳定性与密度")).toBe(true);
  expect(layersLabelFits("thermal stability of salts")).toBe(false);
  expect(
    layersLabelInStatement("Thermal  stability rises.", "thermal stability"),
  ).toBe(true);
  expect(
    layersLabelInStatement("Thermal stability rises.", "stability falls"),
  ).toBe(false);
});
