import { expect, it } from "vitest";
import {
  checkLayersAnswer,
  unitSentences,
  type LayersInput,
  type LayersUnit,
} from "../src/layers/check.js";

// Spec 10.2.1: each check of ADR 0070's content, on a synthetic input.
const PARAGRAPHS = [
  "The first sample showed a peak near 401 nm in water. It was stable for 12 days.",
  "The second sample showed a peak near 402 nm. Its yield was 85 %.",
  "The third sample was prepared the same way. No change was seen.",
  "The fourth sample confirms the trend. The method is general.",
];
function input(): LayersInput {
  const units = new Map<string, LayersUnit>();
  let at = 0;
  PARAGRAPHS.forEach((source, i) => {
    units.set(`p${i + 1}`, {
      short: `p${i + 1}`,
      unit_id: `u${i + 1}`,
      source,
      start_utf8: at,
      sentences: unitSentences(source, "text"),
    });
    at += Buffer.byteLength(source) + 2;
  });
  return {
    text: "",
    units,
    figures: new Map([
      [
        "f1",
        {
          short: "f1",
          segment_id: "fig1",
          kind: "figure",
          start_utf8: at,
          caption: "Spectra.",
          text: "Spectra.",
        },
      ],
      [
        "f2",
        {
          short: "f2",
          segment_id: "tab1",
          kind: "table",
          start_utf8: at + 20,
          caption: "Yields.",
          text: "| sample | yield |\n| 1 | 85 % |\n| 2 | 3.12 g | Yields.",
        },
      ],
    ]),
    headings: new Map([["s1", { short: "s1", segment_id: "head1" }]]),
    body_code_points: 4000,
  };
}
const SEGMENTS = [
  {
    segment_id: "u1",
    kind: "text",
    start_utf8: 0,
    end_utf8: 10,
    section_id: "sec1",
  },
];
const point = (n: number, extra: Record<string, unknown> = {}) => ({
  statement: `Sample ${n} showed a peak.`,
  evidence: [`p${n}.1`],
  key_terms: [],
  primary: n <= 3,
  label: `Sample ${n}`,
  kind: "result",
  relations: [],
  basis: null,
  ...extra,
});
const answer = (
  points: unknown[],
  extra: {
    data?: unknown[];
    advice?: Record<string, unknown>;
    limits?: unknown[];
  } = {},
) => ({
  digest: {
    summary: {
      text: "Four samples were measured; the trend is stable.",
      units: ["p1"],
      key_terms: [],
    },
    limits: extra.limits ?? [],
    advice: extra.advice ?? {
      text: null,
      not_given: "Nothing to add.",
      units: [],
      key_terms: [],
      places: [],
    },
  },
  data: extra.data ?? [],
  points,
});
const check = (value: unknown) =>
  checkLayersAnswer(value, input(), SEGMENTS, true);

it("drops a kind or relation word outside the fixed values; the point stays without a kind", () => {
  const out = check(
    answer([
      point(1, { kind: "speculation" }),
      point(2, { relations: [{ word: "contradicts", targets: ["k1"] }] }),
      point(3, { relations: [{ word: "follows", targets: ["k2"] }] }),
    ]),
  );
  expect(out.points).toHaveLength(3);
  expect(out.points[0]!.kind).toBeNull();
  expect(out.points[1]!.relations).toEqual([]);
  expect(out.points[2]!.relations).toEqual([
    { word: "follows", targets: [{ kind: "point", number: 2 }] },
  ]);
  expect(out.dropped).toMatchObject({ kinds: 1, relations: 1 });
});

it("drops a relation whose target is missing or the point itself, and a see pointing at a point", () => {
  const out = check(
    answer([
      point(1, { relations: [{ word: "see", targets: ["f9"] }] }),
      point(2, { relations: [{ word: "based_on", targets: ["k2"] }] }),
      point(3, {
        relations: [
          { word: "see", targets: ["k1"] },
          { word: "explains", targets: ["k7"] },
          { word: "see", targets: ["f1"] },
        ],
      }),
    ]),
  );
  expect(out.points.map((p) => p.relations)).toEqual([
    [],
    [],
    [{ word: "see", targets: [{ kind: "block", segment_id: "fig1" }] }],
  ]);
  expect(out.dropped.relations).toBe(4);
});

it("renumbers relation targets with the points, and drops one aimed at a dropped point", () => {
  const out = check(
    answer([
      point(3),
      point(1, { relations: [{ word: "sums_up", targets: ["k1", "k3"] }] }),
      { statement: "", evidence: ["p2.1"], key_terms: [] },
      point(2, { primary: true }),
      point(4, { relations: [{ word: "extends", targets: ["k3"] }] }),
    ]),
  );
  // Answer k1 (paragraph 3) becomes number 3, k4 (paragraph 2) number 2.
  expect(out.points.map((p) => p.statement)).toEqual([
    "Sample 1 showed a peak.",
    "Sample 2 showed a peak.",
    "Sample 3 showed a peak.",
    "Sample 4 showed a peak.",
  ]);
  expect(out.points[0]!.relations).toEqual([]);
  expect(out.points[3]!.relations).toEqual([]);
  expect(out.dropped.relations).toBe(2);
});

it("keeps a basis inside one of the point's evidence and drops one outside it", () => {
  const out = check(
    answer([
      point(1, {
        evidence: ["p1.1-2"],
        basis: { evidence: "p1.2", quote: "stable for 12 days" },
      }),
      point(2, { basis: { evidence: "p2.2", quote: null } }),
      point(3, { basis: { evidence: "p3.1", quote: "words not there" } }),
      point(4, { primary: false, basis: { evidence: "p4.1", quote: null } }),
    ]),
  );
  const first = out.points[0]!.basis!;
  expect(first).toMatchObject({ kind: "sentence", unit_id: "u1" });
  if (first.kind !== "sentence") throw new Error("sentence basis expected");
  expect(
    Buffer.from(PARAGRAPHS[0]!)
      .subarray(first.start_utf8, first.end_utf8)
      .toString(),
  ).toBe("stable for 12 days");
  // p2.2 is not inside its evidence p2.1; the quote of point 3 is not in its sentence.
  expect(out.points.slice(1).map((p) => p.basis)).toEqual([null, null, null]);
  expect(out.dropped.basis).toBe(3);
});

it("drops a data row whose value's digits are not in its source", () => {
  const out = check(
    answer([point(1), point(2), point(3)], {
      data: [
        { quantity: "Peak", value: "401 nm", source: "p1" },
        { quantity: "Stability", value: "12 days", source: "p1" },
        { quantity: "Peak", value: "40 nm", source: "p1" },
        { quantity: "Yield", value: "85 %", source: "f2" },
        { quantity: "Mass", value: "3.1 g", source: "f2" },
        { quantity: "Peak", value: "401 nm", source: "f1" },
        { quantity: "Peak", value: "about four hundred", source: "p1" },
        { quantity: "Peak", value: "402 nm", source: "p9" },
      ],
    }),
  );
  expect(out.data).toEqual([
    {
      quantity: "Peak",
      value: "401 nm",
      source: { kind: "unit", unit_id: "u1" },
    },
    {
      quantity: "Stability",
      value: "12 days",
      source: { kind: "unit", unit_id: "u1" },
    },
    {
      quantity: "Yield",
      value: "85 %",
      source: { kind: "block", segment_id: "tab1" },
    },
  ]);
  // 40 is inside 401, 3.1 inside 3.12, a figure is not a table, no digits, no paragraph 9.
  expect(out.dropped.data).toBe(5);
});

it("drops a place whose words are not in the advice or whose target does not exist", () => {
  const out = check(
    answer([point(1), point(2), point(3)], {
      advice: {
        text: "Read Section 2 and Figure 1 first.",
        not_given: null,
        units: [],
        key_terms: [],
        places: [
          { text: "Section 2", target: "s1" },
          { text: "Figure 1", target: "f1" },
          { text: "Table 4", target: "f2" },
          { text: "Section 2", target: "s9" },
        ],
      },
    }),
  );
  expect(out.digest.advice.places).toEqual([
    { text: "Section 2", target: { kind: "section", segment_id: "head1" } },
    { text: "Figure 1", target: { kind: "block", segment_id: "fig1" } },
  ]);
  expect(out.dropped.places).toBe(2);
});

it("keeps the first five primary points by number and reports fewer than three", () => {
  const many = check(
    answer(
      [1, 2, 3, 4].flatMap((n) => [
        point(n, { primary: true }),
        point(n, { primary: true, statement: `Sample ${n} again.` }),
      ]),
    ),
  );
  expect(many.points.filter((p) => p.primary).map((p) => p.number)).toEqual([
    1, 2, 3, 4, 5,
  ]);
  expect(many.dropped.primary).toBe(3);
  expect(many.primary).toBe(5);
  const few = check(answer([point(1), point(2, { primary: false }), point(3)]));
  // The step fails on this count (spec 10.3); see the step test.
  expect(few.primary).toBe(2);
});

it("drops an overlong label, limitation and summary, the last failing the step", () => {
  const out = check({
    ...answer(
      [
        point(1, { label: "one two three four five six seven" }),
        point(2, { label: "含能材料的热稳定性与分解机理研究" }),
        point(3, { label: "热稳定性" }),
      ],
      {
        limits: [
          { text: "x".repeat(201), units: [] },
          ...Array.from({ length: 6 }, (_, i) => ({
            text: `Limit ${i}.`,
            units: ["p1"],
          })),
        ],
      },
    ),
  });
  expect(out.points.map((p) => p.label)).toEqual([null, null, "热稳定性"]);
  expect(out.dropped.labels).toBe(2);
  expect(out.digest.limits).toHaveLength(5);
  expect(out.dropped.limits).toBe(2);
  expect(out.summary_missing).toBe(false);
  const long = answer([point(1), point(2), point(3)]);
  long.digest.summary.text = "y".repeat(401);
  expect(check(long).summary_missing).toBe(true);
});
