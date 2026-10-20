import { expect, it } from "vitest";
import { parseProofreadBlocksV1 } from "@sciretriever/contracts";
import {
  applyEdits,
  draftBlocks,
  parseCorrectionSubmission,
} from "../src/proofread/apply.js";
import { prepareDraft } from "../src/proofread/draft.js";
import type {
  CorrectionContext,
  CorrectionSubmission,
} from "../src/proofread/contract.js";
import { proofreadFixture } from "./proofread-fixture.js";
async function setup() {
  const f = await proofreadFixture("First."),
    d = await prepareDraft(f.raw, f.reader, f.pages);
  d.drafts.push({
    ...d.drafts[0]!,
    block_id: "00000000-0000-0000-0000-000000000123",
    text: "Second.",
  });
  const c: CorrectionContext = {
    asset_id: f.raw.source_asset_id,
    asset_sha256: f.raw.source_sha256,
    page: f.pages[0]!,
    pages: f.pages,
    drafts: d.drafts,
    suspects: [],
    resources: [],
  };
  return { c, blocks: draftBlocks(d.drafts, c) };
}
const submission = (
  edits: CorrectionSubmission["edits"],
): CorrectionSubmission => ({ edits, dispositions: [], no_body_reason: null });
it("keeps uncertainty when replacement and move are submitted after the annotation", async () => {
  const { c, blocks } = await setup(),
    id = blocks[0]!.block_id;
  const out = applyEdits(
    blocks,
    submission([
      {
        kind: "mark_uncertain",
        block_id: id,
        span: [0, 3],
        basis_page: 0,
        reason: "Digits are unclear.",
      },
      {
        kind: "replace",
        block_id: id,
        text: "97? yield.",
        basis_page: 0,
        reason: "Only the final digit is unclear.",
      },
      {
        kind: "move",
        block_id: id,
        page: 0,
        after_block_id: blocks[1]!.block_id,
        basis_page: 0,
        reason: "Column order.",
      },
    ]),
    c,
  );
  expect(out.blocks.at(-1)).toMatchObject({
    text: "97? yield.",
    basis: "uncertain",
    uncertainty: { span: [0, 3], reason: "Digits are unclear." },
  });
  expect(out.blocks.at(-1)!.edit_refs).toHaveLength(3);
  const repeated = applyEdits(
    out.blocks,
    submission([
      {
        kind: "replace",
        block_id: id,
        text: "97? yield.",
        basis_page: 0,
        reason: "Only the final digit is unclear.",
      },
    ]),
    c,
  );
  expect(repeated.blocks.at(-1)!.edit_refs).toHaveLength(3);
});
it("rejects conflicting edits, deleted anchors, move cycles and changes to locked text atomically", async () => {
  const { c, blocks } = await setup(),
    [a, b] = blocks.map((b) => b.block_id),
    common = { basis_page: 0, reason: "Checked image." };
  const replacement = {
    ...common,
    kind: "replace" as const,
    block_id: a!,
    text: "Changed.",
  };
  expect(() =>
    applyEdits(blocks, submission([replacement, replacement]), c),
  ).toThrow("proofread-edit-conflict");
  expect(() =>
    applyEdits(
      blocks,
      submission([
        { ...common, kind: "delete", block_id: b! },
        { ...common, kind: "move", block_id: a!, page: 0, after_block_id: b! },
      ]),
      c,
    ),
  ).toThrow("proofread-edit-target");
  expect(() =>
    applyEdits(
      blocks,
      submission([
        { ...common, kind: "move", block_id: a!, page: 0, after_block_id: b! },
        { ...common, kind: "move", block_id: b!, page: 0, after_block_id: a! },
      ]),
      c,
    ),
  ).toThrow("proofread-edit-cycle");
  expect(() =>
    applyEdits(blocks, submission([replacement]), c, new Set([a!])),
  ).toThrow("proofread-manual-locked");
  expect(blocks[0]!.text).toBe("First.");
});
it("rejects unexplained deletion and unregistered image references at submission", async () => {
  const { c, blocks } = await setup();
  expect(() =>
    parseCorrectionSubmission(
      submission([
        {
          kind: "delete",
          block_id: blocks[0]!.block_id,
          basis_page: 0,
          reason: " ",
        },
      ]),
      c,
    ),
  ).toThrow();
  expect(() =>
    parseCorrectionSubmission(
      submission([
        {
          kind: "insert_after",
          after_block_id: null,
          basis_page: 0,
          reason: "Figure visible.",
          block: {
            page: 0,
            region: null,
            type: "image",
            title_level: null,
            text: "",
            html: null,
            image_ref: "unknown.png",
          },
        },
      ]),
      c,
    ),
  ).toThrow();
});

it("keeps uncertainty valid after shortening text and annotates the HTML content of a table", async () => {
  const { c, blocks } = await setup();
  const annotated = applyEdits(
    blocks,
    submission([
      {
        kind: "mark_uncertain",
        block_id: blocks[0]!.block_id,
        span: [0, 6],
        basis_page: 0,
        reason: "Unreadable letters.",
      },
    ]),
    c,
  );
  const shortened = applyEdits(
    annotated.blocks,
    submission([
      {
        kind: "replace",
        block_id: blocks[0]!.block_id,
        text: "?",
        basis_page: 0,
        reason: "Only one symbol remains visible.",
      },
    ]),
    c,
  );
  expect(shortened.blocks[0]!.uncertainty?.span).toEqual([0, 1]);
  const table = {
    ...blocks[0]!,
    type: "table" as const,
    text: "",
    html: "<table><tr><td>?</td></tr></table>",
  };
  const checked = applyEdits(
    [table],
    submission([
      {
        kind: "mark_uncertain",
        block_id: table.block_id,
        span: [15, 16],
        basis_page: 0,
        reason: "Unreadable table value.",
      },
    ]),
    c,
  );
  expect(
    parseProofreadBlocksV1(
      { schema_version: 1, page_count: 1, blocks: checked.blocks },
      [],
    ).blocks[0]!.basis,
  ).toBe("uncertain");
});

it("rejects replaying the same insertion into a draft that already contains it", async () => {
  const { c, blocks } = await setup();
  const edit: CorrectionSubmission["edits"][number] = {
    kind: "insert_after",
    after_block_id: blocks[0]!.block_id,
    basis_page: 0,
    reason: "Missing caption.",
    block: {
      page: 0,
      region: null,
      type: "text",
      title_level: null,
      text: "Caption.",
      html: null,
      image_ref: null,
    },
  };
  const first = applyEdits(blocks, submission([edit]), c);
  expect(() => applyEdits(first.blocks, submission([edit]), c)).toThrow(
    "proofread-edit-conflict",
  );
});
