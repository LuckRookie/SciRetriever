import { expect, it } from "vitest";
import {
  chunkTokenLimit,
  chunkHeading,
  splitProcessorText,
  selectProcessorText,
  PROCESSOR_CHUNKING,
} from "../src/analysis/processor-chunking.js";
import type { ProcessorSegment } from "../src/analysis/processor.js";
import { createProcessorRegistry } from "../src/analysis/processor-registry.js";
import { canonicalJsonBytes, sha256 } from "@sciretriever/contracts";
const segment = (
  id: string,
  text: string,
  extra: Partial<ProcessorSegment> = {},
): ProcessorSegment => ({
  segment_id: id,
  text,
  document_title: "Synthetic paper",
  part_key: "main",
  kind: "text",
  page: 0,
  basis: "text-layer",
  citation: {
    kind: "result",
    result_id: "00000000-0000-0000-0000-000000000001",
    content_sha256: "a".repeat(64),
    record_id: id,
    pointer: "",
  },
  ...extra,
});
it("defaults to whole documents and chooses the smaller context or 200K limit", () => {
  expect(chunkTokenLimit(null)).toBe(200000);
  expect(
    chunkTokenLimit({
      context_window_tokens: 1000000,
      max_output_tokens: 1000000,
    }),
  ).toBe(200000);
  expect(
    chunkTokenLimit({ context_window_tokens: 32000, max_output_tokens: 4000 }),
  ).toBe(19808);
  expect(
    chunkTokenLimit(
      { context_window_tokens: 64000, max_output_tokens: 4096 },
      50000,
    ),
  ).toBe(9904);
  expect(
    chunkTokenLimit({ context_window_tokens: 1000, max_output_tokens: 4000 }),
  ).toBe(0);
  const input = [
    segment("a", "one", { section_path: ["Introduction"] }),
    segment("b", "two", { section_path: ["Results"] }),
  ];
  expect(splitProcessorText(input, chunkTokenLimit(null))).toEqual({
    chunks: [input],
    gaps: [],
  });
  expect(chunkHeading(input)).toEqual({
    document_title: "Synthetic paper",
    section_path: "全文",
  });
});
it("splits at headings before paragraphs and carries the nested section path", () => {
  const input = [
    segment("h1", "# Results", {
      kind: "heading",
      heading_level: 1,
      section_path: ["Results"],
    }),
    segment("h2", "## Conditions", {
      kind: "heading",
      heading_level: 2,
      section_path: ["Results", "Conditions"],
    }),
    segment("a", "A".repeat(1300), { section_path: ["Results", "Conditions"] }),
    segment("h3", "## Products", {
      kind: "heading",
      heading_level: 2,
      section_path: ["Results", "Products"],
    }),
    segment("b", "B".repeat(1300), { section_path: ["Results", "Products"] }),
    segment("h4", "# Discussion", {
      kind: "heading",
      heading_level: 1,
      section_path: ["Discussion"],
    }),
    segment("c", "C".repeat(1300), { section_path: ["Discussion"] }),
  ];
  const result = splitProcessorText(input, 2000);
  expect(result.gaps).toEqual([]);
  expect(result.chunks).toHaveLength(3);
  expect(result.chunks.map((c) => c.map((s) => s.segment_id))).toEqual([
    ["h1", "h2", "a"],
    ["h3", "b"],
    ["h4", "c"],
  ]);
  expect(chunkHeading(result.chunks[1]!)).toMatchObject({
    section_path: "Results > Products",
  });
  const paragraphs = [
    segment("p1", "A".repeat(1300)),
    segment("p2", "B".repeat(1300)),
  ];
  expect(splitProcessorText(paragraphs, 2000).chunks).toEqual(
    paragraphs.map((p) => [p]),
  );
});
it("keeps table captions, notes, continued tables, image captions and formulas indivisible", () => {
  const table = [
    segment("caption", "Table 1", { kind: "caption" }),
    segment("table", "A".repeat(900), { kind: "table" }),
    segment("footnote", "Footnote", { kind: "footnote" }),
    segment("continued", "B".repeat(900), { kind: "table", page: 1 }),
  ];
  const output = splitProcessorText(
    [...table, segment("text", "Other paragraph", { page: 1 })],
    1800,
  );
  expect(output.gaps).toEqual(["unit-too-large:caption"]);
  expect(output.chunks.flat().map((s) => s.segment_id)).toEqual(["text"]);
  const image = [
    segment("image", "image", { kind: "image" }),
    segment("image-caption", "C".repeat(1000), { kind: "caption" }),
  ];
  expect(splitProcessorText(image, 2000).chunks).toEqual([image]);
  expect(splitProcessorText(image, 600).chunks).toEqual([]);
  expect(
    splitProcessorText(
      [segment("equation", "E".repeat(2000), { kind: "equation" })],
      1000,
    ).gaps,
  ).toEqual(["unit-too-large:equation"]);
});
it("makes chunk policy part of processor method identity", async () => {
  const definition = createProcessorRegistry().get("records", "2").definition;
  expect(definition.chunking).toEqual(PROCESSOR_CHUNKING);
  expect(await sha256(canonicalJsonBytes(definition))).not.toBe(
    await sha256(
      canonicalJsonBytes({
        ...definition,
        chunking: "whole-segment-bounded-v1",
      }),
    ),
  );
});
it("searches atomic material units without dropping their captions, notes or continued tables", () => {
  const table = [
    segment("caption", "Table 1", { kind: "caption" }),
    segment("table", "Yield 91%", { kind: "table" }),
    segment("footnote", "Room temperature", { kind: "footnote" }),
    segment("continued", "Product B", { kind: "table", page: 1 }),
  ];
  const other = segment("other", "Introduction", { page: 1 });
  const selected = selectProcessorText([...table, other], "yield");
  expect(selected).toEqual(table);
  expect(selectProcessorText([...table, other], "temperature")).toEqual(table);
  expect(splitProcessorText(selected, 200000).chunks).toEqual([table]);
  expect(selectProcessorText([...table, other], "absent")).toEqual([]);
});
