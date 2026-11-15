import { expect, it } from "vitest";
import {
  ARRANGE_INPUT_MAX_BYTES,
  classifyArchiveDocument,
  longDocumentInfo,
  parseArchiveDocumentClassification,
  parseLongDocumentInfo,
  parsePageProofreadRecord,
  parseLongDocumentStructure,
  parseDocumentStructureV2,
  DRAFT_BASES,
} from "../src/index.js";

it("accepts mixed bases only through the explicit long-document structure parser", () => {
  const bases = ["text-layer", "image-only", "manual", ...DRAFT_BASES];
  const value = {
    schema_version: 2,
    text_encoding: "utf8",
    page_count: 51,
    long_document: classifyArchiveDocument(51, 100),
    sections: [],
    segments: bases.map((basis, i) => ({
      segment_id: `s${i}`,
      block_id: `b${i}`,
      kind: "text",
      section_id: null,
      start_utf8: i,
      end_utf8: i + 1,
      page: i,
      region: null,
      continuation_regions: [],
      locate: "page",
      source: "parser",
      basis,
    })),
  };
  expect(
    parseLongDocumentStructure(value, 6).segments.map((s) => s.basis),
  ).toEqual(bases);
  expect(() => parseDocumentStructureV2(value, 6)).toThrow();
  const { long_document: _marker, ...unmarked } = value;
  void _marker;
  expect(() => parseLongDocumentStructure(unmarked, 6)).toThrow();
  expect(() =>
    parseLongDocumentStructure(
      { ...value, segments: [{ ...value.segments[0], basis: "unknown" }] },
      6,
    ),
  ).toThrow();
});

it("classifies strict page and UTF-8 input boundaries and parses the saved evidence without guessing", () => {
  const regular = classifyArchiveDocument(50, ARRANGE_INPUT_MAX_BYTES);
  expect(regular.reasons).toEqual([]);
  expect(longDocumentInfo(regular)).toBeNull();
  expect(classifyArchiveDocument(51, ARRANGE_INPUT_MAX_BYTES).reasons).toEqual([
    "pages",
  ]);
  expect(
    classifyArchiveDocument(50, ARRANGE_INPUT_MAX_BYTES + 1).reasons,
  ).toEqual(["arrange-input"]);
  const long = classifyArchiveDocument(51, ARRANGE_INPUT_MAX_BYTES + 1);
  expect(parseArchiveDocumentClassification(long)).toEqual(long);
  expect(parseLongDocumentInfo(long)).toEqual(long);
  for (const invalid of [
    regular,
    { ...long, reasons: ["pages"] },
    { ...long, pages: "51" },
    { ...long, reasons: ["arrange-input", "pages"] },
    { ...long, extra: true },
  ])
    expect(() => parseLongDocumentInfo(invalid)).toThrow();
});

it("distinguishes unreviewed parser text from accepted evidence and permits no model edits or fabricated image review", () => {
  const page = {
    schema_version: 2,
    page_index: 0,
    page_kind: "text-layer",
    page_input_sha256: "a".repeat(64),
    retained_leaf_ids: ["00000000-0000-4000-8000-000000000001"],
    evidence: {
      read_leaf_ids: [],
      viewed_full_page: false,
      viewed_regions: [],
    },
    suspects: [],
    dispositions: [],
    corrections: [],
    usage: {
      calls: 0,
      compaction_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      usage_complete: true,
      elapsed_ms: 0,
    },
    status: "unreviewed",
    unreviewed_reason: "long-document",
    no_change: true,
    not_required_reason: null,
    classified_leaf_ids: [],
    stop: null,
  };
  expect(parsePageProofreadRecord(page, 51)).toEqual(page);
  for (const invalid of [
    { ...page, unreviewed_reason: "cost" },
    { ...page, evidence: { ...page.evidence, viewed_full_page: true } },
    { ...page, status: "accepted" },
    { ...page, retained_leaf_ids: [] },
  ])
    expect(() => parsePageProofreadRecord(invalid, 51)).toThrow();
});
