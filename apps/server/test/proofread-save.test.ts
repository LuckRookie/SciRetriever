import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  parseProofreadBlocksV1,
  type ProofreadBlock,
} from "@sciretriever/contracts";
import { editDocument } from "../src/proofread/manual-document.js";
import { renderBlocks } from "../src/proofread/render.js";
import { processorFixture } from "./processor-fixture.js";
import { SqliteProofreadStorage } from "../src/storage/proofread.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";

const block = (
  text: string,
  extra: Partial<ProofreadBlock> = {},
): ProofreadBlock => ({
  block_id: randomUUID(),
  page: 0,
  region: null,
  continuation_regions: [],
  locate: "page",
  type: "text",
  title_level: null,
  text,
  html: null,
  image_ref: null,
  text_source: "parser",
  basis: "text-layer",

  raw_ref: [[0, 0]],
  edit_refs: [],
  ...extra,
});
it("preserves unchanged blocks and records replacement, deletion, splitting and merging", async () => {
  const a = block("First paragraph."),
    b = block("Second paragraph."),
    c = block("Third paragraph.", { text_source: "manual", basis: "manual" });
  const old = { schema_version: 1 as const, page_count: 1, blocks: [a, b, c] };
  const edit = editDocument(
    old,
    "Changed paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\n",
    [],
  );
  expect(edit.blocks.blocks[0]).toMatchObject({
    block_id: a.block_id,
    text: "Changed paragraph.",
    text_source: "manual",
    basis: "manual",
  });
  expect(edit.blocks.blocks.slice(1)).toEqual([b, c]);
  const split = editDocument(
    old,
    "One half.\n\nOther half.\n\nSecond paragraph.\n\nThird paragraph.\n\n",
    [],
  );
  expect(split.blocks.blocks.slice(2)).toEqual([b, c]);
  expect(split.edits.map((e) => e.edit.kind)).toEqual([
    "delete",
    "insert_after",
    "insert_after",
  ]);
  const merged = editDocument(
    old,
    "First and second joined.\n\nThird paragraph.\n\n",
    [],
  );
  expect(merged.blocks.blocks[1]).toEqual(c);
  expect(merged.edits.map((e) => e.edit.kind)).toEqual([
    "delete",
    "delete",
    "insert_after",
  ]);
  const removed = editDocument(
    old,
    "First paragraph.\n\nThird paragraph.\n\n",
    [],
  );
  expect(removed.blocks.blocks).toEqual([a, c]);
  expect(removed.edits[0]!.edit).toMatchObject({
    kind: "delete",
    block_id: b.block_id,
  });
});

it("edits tables and formulas while preserving their structure and unchanged page identity", () => {
  const table = block("", {
      type: "table",
      html: "<table><tr><td>4.2</td></tr></table>",
    }),
    formula = block("E=mc^2", { type: "equation" }),
    last = block("Next page.", { page: 1 });
  const old = {
    schema_version: 1 as const,
    page_count: 2,
    blocks: [table, formula, last],
  };
  const text =
    "<table><tr><td>4.3</td></tr></table>\n\n$$\nE=mc^3\n$$\n\nNext page.\n\n";
  const result = editDocument(old, text, []);
  expect(result.blocks.blocks.at(-1)).toEqual(last);
  expect(result.blocks.blocks[0]).toMatchObject({
    type: "table",
    html: "<table><tr><td>4.3</td></tr></table>",
    basis: "manual",
  });
  expect(result.blocks.blocks[1]).toMatchObject({
    type: "equation",
    text: "E=mc^3",
    basis: "manual",
  });
  expect(
    new TextDecoder().decode(renderBlocks(result.blocks.blocks, []).markdown),
  ).toBe(text);
});

it(
  "saves once, rebuilds without models, invalidates results and rejects stale concurrent saves",
  { timeout: 0 },
  async () => {
    const e = await processorFixture();
    try {
      const id = e.parseRequest.literature_id,
        asset = e.parseRequest.asset_id;
      await e.build(e.parseRequest);
      const initial = (await e.app.archive.status(id)).parts[0]!;
      const store = new SqliteProofreadStorage(e.app.database, e.app.files),
        before = await store.load(initial.proofread_id!);
      const markdown = new TextDecoder().decode(before.markdown.bytes);
      await e.app.processors!.runBatch({
        schema_version: 1,
        idempotency_key: "edit-original",
        name: "Edit original",
        processor: { id: "summary", version: "2" },
        spec: {},
        inputs: [{ kind: "literature", literature_id: id }],
      });
      const result = (await e.app.processorRead!.list()).items[0]!;
      const metadata = await e.app.metadataFields.read(id),
        tags = await e.app.tags.assignment(id),
        calls = e.modelCalls;
      const request = {
        literature_id: id,
        asset_id: asset,
        proofread_id: initial.proofread_id,
        markdown: markdown.replace(
          "A synthetic finding.",
          "A manually checked finding.",
        ),
        actor: "cli:reviewer",
      };
      const saved = (await executeMaintenance(
        e.app,
        "proofread-save",
        request,
      )) as {
        saved: boolean;
        changed: boolean;
        proofread_id: string;
        rebuild: { status: string; code?: string };
      };
      expect(saved).toMatchObject({
        saved: true,
        changed: true,
        rebuild: { status: "completed" },
      });
      const readingStatus = await e.app.proofreading!.readingStatus({
        asset_id: asset,
      });
      expect(readingStatus).toMatchObject({
        proofread_id: saved.proofread_id,
        blocks: { manual: 1 },
        total_pages: 1,
      });
      expect(readingStatus.last_manual_edit?.actor_label).toBe("系统自动");
      expect(readingStatus.last_manual_edit?.at).toBeTruthy();
      expect(e.modelCalls).toBe(calls);
      expect(await e.app.metadataFields.read(id)).toEqual(metadata);
      expect(await e.app.tags.assignment(id)).toEqual(tags);
      expect(
        (await e.app.processorRead!.byId(String(result.result_id)))!.freshness
          ?.state,
      ).toBe("stale");
      const after = await store.load(saved.proofread_id);
      const blocks = parseProofreadBlocksV1(
        JSON.parse(new TextDecoder().decode(after.blocks.bytes)),
        [],
      );
      expect(
        blocks.blocks.find((b) => b.text === "A manually checked finding."),
      ).toMatchObject({
        basis: "manual",
        text_source: "manual",
      });
      expect(await store.load(initial.proofread_id!)).toEqual(before);
      await expect(
        executeMaintenance(e.app, "proofread-save", {
          ...request,
          markdown: markdown + "Late change.",
        }),
      ).rejects.toMatchObject({ code: "proofread-manual-stale" });
      expect((await store.current(asset))!.proofread_id).toBe(
        saved.proofread_id,
      );
      const cached = await e.app.proofreading!.build({ asset_id: asset });
      expect(cached.version.proofread_id).toBe(saved.proofread_id);
      expect(e.modelCalls).toBe(calls);
      const same = await executeMaintenance(e.app, "proofread-save", {
        ...request,
        proofread_id: saved.proofread_id,
        markdown: new TextDecoder().decode(after.markdown.bytes),
      });
      expect(same).toMatchObject({ saved: true, changed: false });
    } finally {
      await e.close();
    }
  },
);

it("records page relocation and parses separate page edits without merging their paragraphs", () => {
  const a = block("First page."),
    b = block("Second page.", { page: 1 });
  const old = { schema_version: 1 as const, page_count: 2, blocks: [a, b] };
  const text = "First page.\n\nSecond page.\n\n";
  const moved = editDocument(old, text, [], [0, 0]);
  expect(moved.blocks.blocks.map((b) => b.page)).toEqual([1, 1]);
  expect(moved.blocks.blocks[0]!.basis).toBe("manual");
  expect(moved.blocks.blocks[1]).toEqual(b);
  const changed = editDocument(old, "New first.\nNew second.", [], [0, 11]);
  expect(changed.blocks.blocks.map((b) => [b.page, b.text])).toEqual([
    [0, "New first."],
    [1, "New second."],
  ]);
});

it("preserves an intentional deletion on a later rebuild and refuses a changed raw input", async () => {
  const { proofreadFixture } = await import("./proofread-fixture.js");
  const { buildProofreadVersion } = await import("../src/proofread/engine.js");
  const { encodeManualDocument } = await import(
    "../src/proofread/manual-document.js"
  );
  const f = await proofreadFixture(),
    initial = await buildProofreadVersion(f);
  const old = parseProofreadBlocksV1(
    JSON.parse(new TextDecoder().decode(initial.blocks.bytes)),
    [],
  );
  const edited = editDocument(old, "", []);
  const decision = {
    decision_id: randomUUID(),
    part_asset_id: f.raw.source_asset_id,
    block_id: f.raw.source_asset_id,
    draft_sha256: f.raw.result_sha256,
    raw_ref: [],
    action: "document-edit" as const,
    reason: "manual-document-edit",
    page: 0,
    suspect_id: null,
    disposition: null,
    text: encodeManualDocument({
      blocks: edited.blocks,
      edits: edited.edits,
      changed_ids: edited.changed,
    }),
  };
  const rebuilt = await buildProofreadVersion({ ...f, decisions: [decision] });
  expect(rebuilt.version.status).toBe("complete");
  expect(
    parseProofreadBlocksV1(
      JSON.parse(new TextDecoder().decode(rebuilt.blocks.bytes)),
      [],
    ).blocks,
  ).toEqual([]);
  expect(rebuilt.version.stats.calls).toBe(0);
  const changed = await proofreadFixture("Changed raw text.");
  await expect(
    buildProofreadVersion({ ...changed, decisions: [decision] }),
  ).rejects.toThrow("proofread-manual-input-conflict");
});
