import { expect, it } from "vitest";
import {
  ARCHIVE_SECTION_ROLES,
  ARCHIVE_DROP_REASONS,
  parseArrangementOperation,
  parseArrangementSubmission,
  parseCorrectOperation,
  parsePageProofreadSubmission,
  parseArrangementLeaf,
  parseArchiveTextStop,
  parsePageProofreadRecord,
  parseArchiveModelUsage,
  parseArrangementSourceBlock,
  parseArrangementSnapshot,
  parseArchiveTextBundleV2,
  classifyArchiveDocument,
  DRAFT_BASES,
} from "../src/index.js";
const id = "00000000-0000-0000-0000-000000000001",
  hash = "a".repeat(64);
const correct = {
  kind: "correct",
  leaf_id: id,
  start: 1,
  end: 2,
  original: "😀",
  replacement: "β",
  basis_page_index: 0,
  reason: "image",
};
it("defines eleven skeleton sections and exactly six drop reasons", () => {
  expect(ARCHIVE_SECTION_ROLES).toEqual([
    "title",
    "authors",
    "abstract",
    "keywords",
    "introduction",
    "methods",
    "results-discussion",
    "conclusion",
    "end-matter",
    "references",
    "additional",
  ]);
  expect(ARCHIVE_DROP_REASONS).toEqual([
    "header",
    "footer",
    "interface",
    "bibliography",
    "copyright",
    "decoration",
  ]);
  for (const reason of ARCHIVE_DROP_REASONS)
    expect(
      parseArrangementOperation({ kind: "drop", leaf_id: id, reason }),
    ).toMatchObject({ reason });
});

const id2 = "00000000-0000-0000-0000-000000000002",
  id3 = "00000000-0000-0000-0000-000000000003";
function checkedPage() {
  return {
    schema_version: 2,
    page_index: 0,
    page_kind: "text-layer",
    page_input_sha256: hash,
    retained_leaf_ids: [id],
    evidence: {
      read_leaf_ids: [id],
      viewed_full_page: true,
      viewed_regions: [],
    },
    suspects: [],
    dispositions: [],
    corrections: [],
    usage: {
      calls: 1,
      compaction_calls: 0,
      input_tokens: 13,
      output_tokens: 7,
      usage_complete: true,
      elapsed_ms: 1,
    },
    status: "accepted",
    no_change: true,
    not_required_reason: null,
    classified_leaf_ids: [],
    stop: null,
  };
}
it("parses positive split, merge, page and multi-caption operations without accepting extra keys", () => {
  for (const op of [
    { kind: "split", root_block_id: id, cuts: [1, 4] },
    { kind: "merge", leaf_ids: [id, id2] },
    {
      kind: "caption",
      object_leaf_id: id,
      caption_leaf_ids: [id2, id3],
      object_kind: "scheme",
    },
    {
      kind: "assign-page",
      leaf_id: id,
      page_index: 1,
      basis_page_index: 1,
      reason: "image",
    },
    {
      kind: "assign",
      leaf_id: id,
      target: { role: "additional", original_heading_leaf_id: id2 },
      presentation: { kind: "subheading", level: 2 },
    },
  ])
    expect(parseArrangementOperation(op)).toEqual(op);
});
it("accepts a table note only as a program attachment to a table", () => {
  const note = {
    kind: "caption",
    object_leaf_id: id,
    caption_leaf_ids: [id2],
    object_kind: "table",
    relation: "table-note",
    source: "program",
    rule: "format-normalize-v1/table-note",
  };
  expect(parseArrangementOperation(note)).toEqual(note);
  for (const change of [
    { object_kind: "figure" },
    { relation: "footnote" },
    { source: undefined, rule: undefined },
    { relation: undefined },
  ])
    expect(() =>
      parseArrangementOperation(
        JSON.parse(JSON.stringify({ ...note, ...change })),
      ),
    ).toThrow();
});
it("rejects forged page records with missing, duplicated or unrelated suspect dispositions", () => {
  const q = {
      suspect_id: id2,
      page_index: 0,
      kind: "missing",
      leaf_ids: [id],
      tokens: ["97"],
    },
    record = {
      ...checkedPage(),
      suspects: [q],
      dispositions: [{ suspect_id: id2, status: "uncertain", reason: "image" }],
    };
  expect(parsePageProofreadRecord(record, 1).suspects).toHaveLength(1);
  for (const change of [
    { dispositions: [] },
    { suspects: [q, q] },
    { dispositions: [...record.dispositions, ...record.dispositions] },
    {
      dispositions: [{ suspect_id: id3, status: "uncertain", reason: "image" }],
    },
    {
      dispositions: [
        { suspect_id: id2, status: "fixed", correction_ids: [id3] },
      ],
    },
    { suspects: [{ ...q, leaf_ids: [id3] }] },
    { suspects: [{ ...q, tokens: [] }] },
    { not_required_reason: "blank" },
    { classified_leaf_ids: [id] },
    { evidence: { ...record.evidence, read_leaf_ids: [id2] } },
  ])
    expect(() =>
      parsePageProofreadRecord({ ...record, ...change }, 1),
    ).toThrow();
});
it("rejects fake correction ownership and mismatching raw ranges in a page record", () => {
  const correction = {
      correction_id: id3,
      operation: correct,
      source_span: {
        root_block_id: id2,
        source_sha256: hash,
        start: 8,
        end: 9,
      },
      source: "agent",
      decision_id: null,
    },
    record = { ...checkedPage(), corrections: [correction], no_change: false };
  expect(
    parsePageProofreadRecord(record, 1).corrections[0]!.source_span.start,
  ).toBe(8);
  // A program correction names its rule (ADR 0074 §2); nothing else carries one.
  const program = {
    ...correction,
    source: "program",
    rule: "format-normalize-v1/superscript",
  };
  expect(
    parsePageProofreadRecord({ ...record, corrections: [program] }, 1)
      .corrections[0],
  ).toEqual(program);
  for (const change of [
    { source: "program", rule: undefined },
    { source: "program", decision_id: id2 },
    { rule: "format-normalize-v1/superscript" },
  ])
    expect(() =>
      parsePageProofreadRecord(
        {
          ...record,
          corrections: [
            JSON.parse(JSON.stringify({ ...correction, ...change })),
          ],
        },
        1,
      ),
    ).toThrow();
  for (const change of [
    { source: "manual" },
    { decision_id: id2 },
    { source_span: { ...correction.source_span, end: 10 } },
  ])
    expect(() =>
      parsePageProofreadRecord(
        { ...record, corrections: [{ ...correction, ...change }] },
        1,
      ),
    ).toThrow();
});
it("rejects invalid page counts, leaf spans, duplicate destinations and dangling break candidates", () => {
  const leaf = {
    leaf_id: id,
    source: { root_block_id: id2, source_sha256: hash, start: 0, end: 1 },
    type: "text",
    original_text: "x",
    page_index: 0,
    region: null,
    image_ref: null,
  };
  for (const count of [0, NaN, 1.5, 10001])
    expect(() => parseArrangementLeaf(leaf, count)).toThrow();
  expect(() =>
    parseArrangementLeaf({ ...leaf, original_text: "😀x" }, 1),
  ).toThrow();
  const snapshot = {
    schema_version: 1,
    arrangement_id: hash,
    source_input_sha256: hash,
    method_sha256: hash,
    leaves: [leaf],
    operations: [
      {
        kind: "assign",
        leaf_id: id,
        target: { role: "keywords" },
        presentation: { kind: "content" },
      },
    ],
    destinations: [
      {
        leaf_id: id,
        destination: {
          kind: "assigned",
          target: { role: "keywords" },
          presentation: { kind: "content" },
        },
        decision_id: null,
        locked: false,
      },
    ],
    break_candidates: [],
    break_decisions: [],
    manual_revision: 0,
  };
  expect(parseArrangementSnapshot(snapshot, 1).leaves).toHaveLength(1);
  const bundle = {
    schema_version: 2,
    page_count: 51,
    source_blocks: [
      {
        root_block_id: id2,
        raw_parse_id: id3,
        result_sha256: hash,
        source_sha256: hash,
        locator: {
          kind: "raw-block",
          page_index: 0,
          block_index: 0,
          field: "text",
        },
        type: "text",
        text: "x",
        page_hint: 0,
        region_hint: null,
        image_ref: null,
        title_level: null,
      },
    ],
    arrangement: {
      ...snapshot,
      classification: classifyArchiveDocument(51, 100),
    },
    leaves: [
      {
        leaf,
        destination: snapshot.destinations[0]!.destination,
        corrected_text: "x",
        correction_ids: [],
        text_source: "parser",
        basis: "text-layer-match",
      },
    ],
  };
  for (const basis of DRAFT_BASES) {
    const row = { ...bundle.leaves[0]!, basis };
    expect(
      parseArchiveTextBundleV2({ ...bundle, leaves: [row] }).leaves[0]!.basis,
    ).toBe(basis);
    for (const changed of [
      { ...bundle, arrangement: snapshot },
      { ...bundle, leaves: [{ ...row, text_source: "manual" }] },
      { ...bundle, leaves: [{ ...row, corrected_text: "changed" }] },
      { ...bundle, leaves: [{ ...row, correction_ids: [id3] }] },
      { ...bundle, leaves: [{ ...row, basis: { toString: () => basis } }] },
    ])
      expect(() => parseArchiveTextBundleV2(changed)).toThrow();
    // Program corrections (ADR 0074 §2) change draft text; the storage owner checks their source.
    expect(
      parseArchiveTextBundleV2({
        ...bundle,
        leaves: [{ ...row, corrected_text: "y", correction_ids: [id3] }],
      }).leaves[0]!.corrected_text,
    ).toBe("y");
  }
  for (const change of [
    { destinations: [...snapshot.destinations, ...snapshot.destinations] },
    { destinations: [] },
    { destinations: [{ ...snapshot.destinations[0], locked: true }] },
    {
      break_candidates: [
        {
          candidate_id: hash,
          left_leaf_id: id,
          right_leaf_id: id2,
          skipped_leaf_ids: [],
          input_sha256: hash,
          rule_version: "paragraph-break-v1",
          left_ends_with_hyphen: false,
        },
      ],
      break_decisions: [
        { candidate_id: hash, decision: "keep", reason: "separate" },
      ],
    },
  ])
    expect(() =>
      parseArrangementSnapshot({ ...snapshot, ...change }, 1),
    ).toThrow();
});
it("rejects zero thresholds and stop scopes from another page", () => {
  const stop = {
    code: "no-progress",
    step: "proofread",
    scope: "page",
    page_index: 0,
    retryable: true,
    cause_code: null,
    validation: null,
    progress: { consecutive_calls: 8, threshold: 8 },
  };
  for (const progress of [
    { consecutive_calls: 0, threshold: 0 },
    { consecutive_calls: 2, threshold: 8 },
  ])
    expect(() => parseArchiveTextStop({ ...stop, progress })).toThrow();
  expect(() =>
    parseArchiveTextStop({ ...stop, code: "other", progress: null }),
  ).toThrow();
  expect(() =>
    parsePageProofreadRecord(
      { ...checkedPage(), status: "failed", stop: { ...stop, page_index: 1 } },
      2,
    ),
  ).toThrow();
});
it.each([
  { kind: "drop", leaf_id: id, reason: "other" },
  {
    kind: "assign",
    leaf_id: id,
    target: { role: "body" },
    presentation: { kind: "content" },
  },
  { kind: "split", root_block_id: id, cuts: [2, 2] },
  { kind: "merge", leaf_ids: [id, id] },
  {
    kind: "assign-page",
    leaf_id: id,
    page_index: -1,
    basis_page_index: 0,
    reason: "image",
  },
  { kind: "drop", leaf_id: id, reason: "header", text: "rewritten" },
  {
    kind: "caption",
    object_leaf_id: id,
    caption_leaf_ids: [],
    object_kind: "figure",
  },
])("rejects invalid or legacy arrangement operations %j", (v) =>
  expect(() => parseArrangementOperation(v)).toThrow(),
);
it("uses code-point half-open correction ranges and rejects rewritten/overlong contracts", () => {
  expect(parseCorrectOperation(correct).original).toBe("😀");
  // A real model explains a correction in a sentence; one short line is enough evidence.
  expect(
    parseCorrectOperation({
      ...correct,
      reason: "The image prints superscript citation 1 after the period.",
    }).reason,
  ).toContain("superscript");
  for (const change of [
    { end: 3 },
    { original: "wrong" },
    { replacement: "😀" },
    { reason: "two\nlines" },
    { reason: "a".repeat(121) },
    { reason: "  " },
    { start: -1 },
    { kind: "replace" },
    { extra: true },
  ])
    expect(() => parseCorrectOperation({ ...correct, ...change })).toThrow();
});
it("accepts one disposition shape for every status, as a real model sends it", async () => {
  const { parseSuspectDisposition } = await import("../src/archive-text.js");
  const suspect = "00000000-0000-4000-8000-000000000001",
    correction = "00000000-0000-4000-8000-000000000002";
  expect(
    parseSuspectDisposition({
      suspect_id: suspect,
      status: "fixed",
      correction_ids: [correction],
      reason: "Image confirms the corrected spelling.",
    }),
  ).toEqual({
    suspect_id: suspect,
    status: "fixed",
    correction_ids: [correction],
  });
  expect(
    parseSuspectDisposition({
      suspect_id: suspect,
      status: "draft-correct",
      correction_ids: [],
      reason: "Notation only.",
    }),
  ).toEqual({
    suspect_id: suspect,
    status: "draft-correct",
    reason: "Notation only.",
  });
  for (const bad of [
    { status: "fixed", correction_ids: [], reason: "x" },
    { status: "draft-correct", correction_ids: [correction], reason: "x" },
  ])
    expect(() =>
      parseSuspectDisposition({ suspect_id: suspect, ...bad }),
    ).toThrow();
});
it("validates page submissions, zero change and source bounds", () => {
  const value = {
    schema_version: 2,
    page_index: 0,
    page_input_sha256: hash,
    corrections: [correct],
    no_change: false,
    dispositions: [],
  };
  expect(parsePageProofreadSubmission(value).corrections).toHaveLength(1);
  expect(() =>
    parsePageProofreadSubmission({ ...value, no_change: true }),
  ).toThrow();
  expect(() =>
    parseArrangementLeaf(
      {
        leaf_id: id,
        source: { root_block_id: id, source_sha256: hash, start: 0, end: 1 },
        type: "text",
        original_text: "x",
        page_index: 1,
        region: null,
        image_ref: null,
      },
      1,
    ),
  ).toThrow();
  expect(() =>
    parseArrangementSourceBlock(
      {
        root_block_id: id,
        locator: {
          kind: "raw-block",
          page_index: 0,
          block_index: 0,
          field: "text",
        },
        raw_parse_id: id,
        result_sha256: hash,
        source_sha256: hash,
        type: "text",
        text: "x",
        page_hint: 0,
        region_hint: [0, 0, 1001, 900],
        image_ref: null,
        title_level: null,
      },
      1,
    ),
  ).toThrow();
});
it("never accepts an old full-body edit or incomplete page as a checked page", () => {
  expect(() =>
    parsePageProofreadSubmission({
      edits: [{ kind: "replace", block_id: id, text: "whole text" }],
    }),
  ).toThrow();
  expect(() =>
    parseArrangementSubmission({
      schema_version: 1,
      source_input_sha256: hash,
      reviewed_candidates_sha256: hash,
      operations: [],
      break_decisions: [],
      body: "text",
    }),
  ).toThrow();
  const page = {
    schema_version: 2,
    page_index: 0,
    page_kind: "text-layer",
    page_input_sha256: hash,
    retained_leaf_ids: [id],
    evidence: {
      read_leaf_ids: [],
      viewed_full_page: false,
      viewed_regions: [],
    },
    suspects: [],
    dispositions: [],
    corrections: [],
    usage: {
      calls: 1,
      compaction_calls: 0,
      input_tokens: 13,
      output_tokens: 7,
      usage_complete: true,
      elapsed_ms: 1,
    },
    status: "accepted",
    no_change: true,
    not_required_reason: null,
    classified_leaf_ids: [],
    stop: null,
  };
  expect(() => parsePageProofreadRecord(page, 1)).toThrow();
  expect(
    parsePageProofreadRecord(
      {
        ...page,
        evidence: {
          ...page.evidence,
          read_leaf_ids: [id],
          viewed_full_page: true,
        },
      },
      1,
    ).status,
  ).toBe("accepted");
});
it("retains incomplete usage and discriminates progress stops from cancellation", () => {
  expect(
    parseArchiveModelUsage({
      calls: 2,
      compaction_calls: 1,
      input_tokens: null,
      output_tokens: null,
      usage_complete: false,
      elapsed_ms: 1,
    }).input_tokens,
  ).toBeNull();
  const value = {
    code: "no-progress",
    step: "proofread",
    scope: "page",
    page_index: 0,
    retryable: true,
    cause_code: null,
    validation: null,
    progress: { consecutive_calls: 8, threshold: 8 },
  };
  expect(parseArchiveTextStop(value).code).toBe("no-progress");
  expect(() => parseArchiveTextStop({ ...value, progress: null })).toThrow();
  expect(() => parseArchiveTextStop({ ...value, scope: "part" })).toThrow();
});
