import { expect, it } from "vitest";
import { parseProofreadBlocksV1, sha256 } from "@sciretriever/contracts";
import {
  applyEdits,
  draftBlocks,
  parseCorrectionSubmission,
} from "../src/proofread/apply.js";
import { prepareDraft } from "../src/proofread/draft.js";
import { renderBlocks } from "../src/proofread/render.js";
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
it("rejects flattened table replacements before changing content or rendering", async () => {
  const { c, blocks } = await setup();
  const original =
    "<table><tr><th>phase</th><th>hk1</th></tr><tr><td>a = 2.812(2)</td><td>003</td></tr></table>";
  const table = {
    ...blocks[0]!,
    type: "table" as const,
    text: "",
    html: original,
  };
  const edit = {
    kind: "replace" as const,
    block_id: table.block_id,
    basis_page: 0,
    reason: "The last header character is a lowercase l.",
    text: "phase | hkl\n003",
  };
  expect(() => applyEdits([table], submission([edit]), c)).toThrow(
    "proofread-table-format",
  );
  expect(table.html).toBe(original);
  expect(() => renderBlocks([{ ...table, html: edit.text }], [])).toThrow(
    "proofread-table-format",
  );
  const corrected = original.replace("hk1", "hkl");
  const applied = applyEdits(
    [table],
    submission([{ ...edit, text: corrected }]),
    c,
  );
  const markdown = new TextDecoder().decode(
    renderBlocks(applied.blocks, []).markdown,
  );
  expect(markdown).toBe(corrected + "\n\n");
  expect(markdown).toContain("a = 2.812(2)");
});
it("retains an unreadable image-only table as an empty, traceable block instead of invented HTML", async () => {
  const { c, blocks } = await setup();
  const table = {
    ...blocks[0]!,
    type: "table" as const,
    text: "Unverified OCR",
    html: "<table><tr><td>67%</td></tr></table>",
  };
  const edit = {
    kind: "replace" as const,
    block_id: table.block_id,
    text: "",
    basis_page: 0,
    reason: "The scanned table remains unreadable after zooming.",
  };
  expect(() => applyEdits([table], submission([edit]), c)).toThrow(
    "proofread-table-format",
  );
  const page = {
    ...c.page,
    kind: "image-only" as const,
    text: "",
    visible_glyphs: 0,
  };
  const applied = applyEdits([table], submission([edit]), {
    ...c,
    page,
    pages: [page],
  });
  expect(applied.blocks[0]).toMatchObject({
    block_id: table.block_id,
    text: "",
    html: null,
    basis: "image-only",
    text_source: "agent",
  });
  expect(applied.blocks[0]!.edit_refs).toHaveLength(1);
  expect(applied.edits[0]!.edit).toEqual(edit);
  expect(
    Buffer.from(renderBlocks(applied.blocks, []).markdown).toString().trim(),
  ).toBe("");
  expect(() =>
    applyEdits(
      [table],
      submission([edit]),
      { ...c, page, pages: [page] },
      new Set([table.block_id]),
    ),
  ).toThrow("proofread-manual-locked");
});
it("keeps the source table image in the readable document for non-text cells", async () => {
  const { blocks } = await setup();
  const image = {
    reference: "images/synthetic-table.png",
    artifact: {
      sha256: await sha256(Buffer.from("synthetic image")),
      byte_size: 15,
      media_type: "image/png",
    },
  };
  const table = {
    ...blocks[0]!,
    type: "table" as const,
    text: "",
    html: "<table><tr><td>Product A</td><td>91%</td></tr></table>",
    image_ref: image.reference,
  };
  const rendered = renderBlocks([table], [image]);
  const text = new TextDecoder().decode(rendered.markdown);
  expect(text).toContain(table.html);
  expect(text).toContain("![](images/synthetic-table.png)");
  expect(rendered.resources).toEqual([image]);
  expect(rendered.ranges[0]!.end_utf8).toBe(Buffer.byteLength(text));
});
it("keeps source basis and idempotent edit lineage across replacement and move", async () => {
  const { c, blocks } = await setup(),
    id = blocks[0]!.block_id;
  const out = applyEdits(
    blocks,
    submission([
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
    basis: "text-layer",
  });
  expect(out.blocks.at(-1)!.edit_refs).toHaveLength(2);
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
  expect(repeated.blocks.at(-1)!.edit_refs).toHaveLength(2);
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

it("rejects retired uncertainty edits and block fields while preserving reasoned dispositions", async () => {
  const { c, blocks } = await setup();
  expect(() =>
    parseCorrectionSubmission(
      {
        edits: [
          {
            kind: "mark_uncertain",
            block_id: blocks[0]!.block_id,
            span: [0, 1],
            basis_page: 0,
            reason: "Unreadable",
          },
        ],
        dispositions: [],
        no_body_reason: null,
      },
      c,
    ),
  ).toThrow();
  expect(() =>
    parseProofreadBlocksV1(
      {
        schema_version: 1,
        page_count: 1,
        blocks: [
          {
            ...blocks[0],
            basis: "uncertain",
            uncertainty: { span: [0, 1], reason: "Unreadable", page: 0 },
          },
        ],
      },
      [],
    ),
  ).toThrow();
  expect(() =>
    parseProofreadBlocksV1(
      {
        schema_version: 1,
        page_count: 1,
        blocks: [{ ...blocks[0], uncertainty: null }],
      },
      [],
    ),
  ).toThrow();
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
