import { expect, it } from "vitest";
import {
  processorOutcomeCounts,
  parseProcessorOutcomeCounts,
  type ProcessorContent,
  type ProcessorCoverage,
  type ProcessorInput,
} from "../src/index.js";
const content: ProcessorContent = {
  kind: "report",
  text: "A result",
  claims: [],
};
const coverage: ProcessorCoverage[] = [
  {
    input_id: "document",
    status: "complete",
    read_segments: [],
    gaps: [],
    parts: [
      {
        literature_id: "paper",
        asset_id: null,
        part: "main",
        outcome: "complete",
        read_segments: [],
        gaps: [],
      },
      {
        literature_id: "paper",
        asset_id: null,
        part: "supplementary",
        outcome: "complete",
        read_segments: [],
        gaps: [],
      },
    ],
  },
];
it("counts one paper across parts, separates empty results and prioritizes incomplete reads", () => {
  const result = {
    literature_ids: ["paper"],
    coverage,
    content,
    invocation: { inputs: [] },
  };
  expect(processorOutcomeCounts(result)).toEqual({
    with_result: 1,
    empty: 0,
    incomplete: 0,
  });
  expect(
    processorOutcomeCounts({
      ...result,
      content: { kind: "report", text: "", claims: [] },
    }),
  ).toEqual({ with_result: 0, empty: 1, incomplete: 0 });
  expect(
    processorOutcomeCounts({
      ...result,
      coverage: [
        {
          ...coverage[0]!,
          status: "partial",
          parts: [
            {
              ...coverage[0]!.parts[0]!,
              outcome: "incomplete",
              gaps: ["unread-segments"],
            },
          ],
        },
      ],
    }),
  ).toEqual({ with_result: 0, empty: 0, incomplete: 1 });
  expect(
    parseProcessorOutcomeCounts({ with_result: 1, empty: 2, incomplete: 3 }),
  ).toEqual({ with_result: 1, empty: 2, incomplete: 3 });
  expect(() =>
    parseProcessorOutcomeCounts({
      extracted: 1,
      "not-reported": 2,
      "part-absent": 3,
      incomplete: 0,
    }),
  ).toThrow();
});
it("counts mapped papers separately even when the combined report has content", () => {
  const part = coverage[0]!.parts[0]!;
  const input: ProcessorInput = {
    kind: "snapshot",
    input_id: "snapshot",
    snapshot_id: "snapshot",
    content_sha256: "a".repeat(64),
    mapped_results: [],
  };
  const summary = {
    literature_ids: ["full", "empty", "missing"],
    invocation: { inputs: [input] },
    content,
    coverage: [
      {
        ...coverage[0]!,
        parts: ["full", "empty", "missing"].map((id) => ({
          ...part,
          literature_id: id,
        })),
      },
    ],
  };
  const mapped = [
    {
      literature_ids: ["full"],
      invocation: { inputs: [] },
      content,
      coverage: [],
    },
    {
      literature_ids: ["empty"],
      invocation: { inputs: [] },
      content: { kind: "records" as const, schema: {}, records: [] },
      coverage: [],
    },
  ];
  expect(processorOutcomeCounts(summary, mapped)).toEqual({
    with_result: 1,
    empty: 1,
    incomplete: 1,
  });
});
