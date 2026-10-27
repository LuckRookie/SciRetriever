import { expect, it } from "vitest";
import {
  rawParseIdentity,
  type ArrangementOperation,
} from "@sciretriever/contracts";
import { ArchiveArrangementService } from "../src/archive/arrangement-service.js";
import {
  acceptArrangement,
  arrangementLeafId,
  arrangementPreview,
  reviewArrangement,
  verifyArrangement,
  verifyArrangementPayload,
} from "../src/archive/arrangement.js";
import {
  ArchiveTextError,
  prepareArrangementSource,
  textHash,
} from "../src/archive/text-source.js";
import {
  archiveTextFixture,
  arranged,
  assigned,
  fakePages,
  fakeTextRuntime,
  lastTool,
  memoryTextCache,
  modelTool,
  modelText,
  toolJson,
} from "./archive-text-fixture.js";
const method = "c".repeat(64),
  foreign = "00000000-0000-0000-0000-000000000099";
function accept(
  source: Parameters<typeof acceptArrangement>[0],
  operations: readonly ArrangementOperation[],
  decide: "keep" | "merge" = "keep",
) {
  const review = reviewArrangement(source, operations);
  return acceptArrangement(
    source,
    {
      schema_version: 1,
      source_input_sha256: source.input_sha256,
      reviewed_candidates_sha256: review.candidates_sha256,
      operations,
      break_decisions: review.candidates.map((c) =>
        decide === "merge"
          ? { candidate_id: c.candidate_id, decision: decide }
          : {
              candidate_id: c.candidate_id,
              decision: decide,
              reason: "separate",
            },
      ),
    },
    method,
  );
}
it("keeps raw headers, bibliography, interface labels and exact hyphenated text for explicit decisions", async () => {
  const f = await archiveTextFixture([
    { type: "header", text: "Journal header" },
    { text: "Cite This" },
    { text: "DOI: 10.0000/synthetic" },
    { text: "poten-" },
    { text: "tial remains." },
    { type: "image", text: "", image: true },
  ]);
  expect(f.source.blocks.map((b) => b.text)).toEqual([
    "Journal header",
    "Cite This",
    "DOI: 10.0000/synthetic",
    "poten-",
    "tial remains.",
    "",
  ]);
  const ops = assigned(f.source),
    ids = ops.map((o) => ("leaf_id" in o ? o.leaf_id : ""));
  ops[0] = { kind: "drop", leaf_id: ids[0]!, reason: "header" };
  ops[1] = { kind: "drop", leaf_id: ids[1]!, reason: "interface" };
  ops[2] = { kind: "drop", leaf_id: ids[2]!, reason: "bibliography" };
  ops.push({ kind: "merge", leaf_ids: [ids[3]!, ids[4]!] });
  const snapshot = accept(f.source, ops, "merge"),
    preview = arrangementPreview(snapshot);
  expect(snapshot.leaves).toHaveLength(6);
  expect(preview[0]).toMatchObject({
    text: "poten-tial remains.",
    joiners: [""],
  });
  expect(
    snapshot.destinations.filter((d) => d.destination.kind === "dropped"),
  ).toHaveLength(3);
  expect(preview.flatMap((n) => n.leaf_ids)).toContain(ids[5]);
  expect(verifyArrangement(f.source, snapshot, method)).toEqual(snapshot);
});
it("splits by code points, assigns every resulting leaf once and drops only the embedded copyright", async () => {
  const text = "A😀 abstract.© Synthetic publisher.",
    f = await archiveTextFixture([{ text }]);
  const root = f.source.blocks[0]!,
    cut = [..."A😀 abstract."].length,
    left = arrangementLeafId(
      root.root_block_id,
      0,
      cut,
      f.source.raw.result_sha256,
    ),
    right = arrangementLeafId(
      root.root_block_id,
      cut,
      [...text].length,
      f.source.raw.result_sha256,
    );
  const ops: ArrangementOperation[] = [
    { kind: "split", root_block_id: root.root_block_id, cuts: [cut] },
    {
      kind: "assign",
      leaf_id: left,
      target: { role: "abstract" },
      presentation: { kind: "content" },
    },
    { kind: "drop", leaf_id: right, reason: "copyright" },
  ];
  const snapshot = accept(f.source, ops);
  expect(
    snapshot.leaves.map((l) => [l.original_text, l.source.start, l.source.end]),
  ).toEqual([
    ["A😀 abstract.", 0, cut],
    ["© Synthetic publisher.", cut, [...text].length],
  ]);
  expect(arrangementPreview(snapshot).map((n) => n.text)).toEqual([
    "A😀 abstract.",
  ]);
  expect(() =>
    reviewArrangement(f.source, [...ops, assigned(f.source)[0]!]),
  ).toThrow(ArchiveTextError);
  expect(() => reviewArrangement(f.source, ops.slice(0, 2))).toThrow(
    ArchiveTextError,
  );
  expect(() => reviewArrangement(f.source, [...ops, ops[1]!])).toThrow(
    ArchiveTextError,
  );
  expect(() =>
    reviewArrangement(f.source, [
      {
        kind: "split",
        root_block_id: root.root_block_id,
        cuts: [[...text].length],
      },
    ]),
  ).toThrow(ArchiveTextError);
});
it("moves intervening footnotes, figures, captions and tables after a merged paragraph without losing or duplicating payload", async () => {
  const f = await archiveTextFixture([
    { text: "The first part" },
    { type: "footnote", text: "Footnote." },
    { type: "image", text: "", image: true },
    { type: "caption", text: "Figure one." },
    {
      type: "table",
      text: "A table",
      html: "<table><tr><td>7</td></tr></table>",
    },
    { text: "continues here." },
  ]);
  const ops = assigned(f.source),
    ids = ops.map((o) => ("leaf_id" in o ? o.leaf_id : ""));
  ops[1] = {
    kind: "assign",
    leaf_id: ids[1]!,
    target: { role: "end-matter" },
    presentation: { kind: "content" },
  };
  ops.push(
    { kind: "merge", leaf_ids: [ids[0]!, ids[5]!] },
    {
      kind: "caption",
      object_kind: "figure",
      object_leaf_id: ids[2]!,
      caption_leaf_ids: [ids[3]!],
    },
  );
  const snapshot = accept(f.source, ops, "merge"),
    preview = arrangementPreview(snapshot),
    payload = preview.flatMap((n) => n.payloads);
  expect(preview.map((n) => n.text)).toEqual([
    "The first part continues here.",
    "Footnote.",
    "",
    "Figure one.",
    "<table><tr><td>7</td></tr></table>",
  ]);
  expect(preview.slice(1).every((n) => n.out_of_flow)).toBe(true);
  expect(payload).toHaveLength(6);
  expect(() =>
    verifyArrangementPayload(f.source, snapshot, payload),
  ).not.toThrow();
  for (const bad of [
    payload.slice(1),
    [...payload, payload[0]!],
    payload.map((p, i) => (i ? p : { ...p, text: p.text + "!" })),
  ])
    expect(() => verifyArrangementPayload(f.source, snapshot, bad)).toThrow(
      ArchiveTextError,
    );
  const ordinary = await archiveTextFixture([
    { text: "First part" },
    { text: "Another retained paragraph." },
    { text: "continues." },
  ]);
  const normal = assigned(ordinary.source),
    normalIds = normal.map((o) => ("leaf_id" in o ? o.leaf_id : ""));
  expect(() =>
    reviewArrangement(ordinary.source, [
      ...normal,
      { kind: "merge", leaf_ids: [normalIds[0]!, normalIds[2]!] },
    ]),
  ).toThrow(ArchiveTextError);
  expect(() =>
    reviewArrangement(f.source, [
      ...ops,
      {
        kind: "caption",
        object_kind: "table",
        object_leaf_id: ids[4]!,
        caption_leaf_ids: [ids[3]!],
      },
    ]),
  ).toThrow(ArchiveTextError);
});
it("requires decisions for all versioned paragraph candidates and refuses stale review hashes", async () => {
  const f = await archiveTextFixture([
      { text: "Fragment" },
      { text: "continuation." },
      { text: "Complete。" },
      { text: "next paragraph." },
    ]),
    ops = assigned(f.source),
    review = reviewArrangement(f.source, ops);
  expect(review.candidates).toHaveLength(1);
  expect(review.candidates[0]?.rule_version).toBe("paragraph-break-v1");
  const base = {
    schema_version: 1,
    source_input_sha256: f.source.input_sha256,
    reviewed_candidates_sha256: review.candidates_sha256,
    operations: ops,
    break_decisions: [],
  };
  expect(() => acceptArrangement(f.source, base, method)).toThrow(
    ArchiveTextError,
  );
  expect(() =>
    acceptArrangement(
      f.source,
      {
        ...base,
        break_decisions: [
          {
            candidate_id: review.candidates[0]!.candidate_id,
            decision: "merge",
          },
        ],
      },
      method,
    ),
  ).toThrow(ArchiveTextError);
  expect(() =>
    acceptArrangement(
      f.source,
      { ...base, reviewed_candidates_sha256: "d".repeat(64) },
      method,
    ),
  ).toThrow(ArchiveTextError);
});
it("requires page-image evidence for page reassignment and keeps source coordinates fixed", async () => {
  const f = await archiveTextFixture([{ text: "Text from the other page." }], {
      page_count: 2,
      layers: ["", "Text from the other page."],
    }),
    ops = assigned(f.source),
    id = "leaf_id" in ops[0]! ? ops[0].leaf_id : "";
  const moved: ArrangementOperation[] = [
    ...ops,
    {
      kind: "assign-page",
      leaf_id: id,
      page_index: 1,
      basis_page_index: 1,
      reason: "image",
    },
  ];
  expect(() =>
    reviewArrangement(f.source, moved, { viewed_pages: new Set([0]) }),
  ).toThrow(ArchiveTextError);
  const review = reviewArrangement(f.source, moved, {
    viewed_pages: new Set([1]),
  });
  expect(review.leaves[0]).toMatchObject({
    page_index: 1,
    region: null,
    source: { start: 0, root_block_id: f.source.blocks[0]!.root_block_id },
  });
  expect(review.leaves[0]!.leaf_id).toBe(id);
});
it("preserves additional native headings and keywords, and refuses invented headings or partial HTML tables", async () => {
  const f = await archiveTextFixture([
      { type: "title", text: "Experimental Section" },
      { text: "Materials." },
      { text: "catalysis; ligand" },
    ]),
    ops = assigned(f.source),
    ids = ops.map((o) => ("leaf_id" in o ? o.leaf_id : ""));
  ops[0] = {
    kind: "assign",
    leaf_id: ids[0]!,
    target: { role: "additional", original_heading_leaf_id: ids[0]! },
    presentation: { kind: "subheading", level: 2 },
  };
  ops[1] = {
    kind: "assign",
    leaf_id: ids[1]!,
    target: { role: "additional", original_heading_leaf_id: ids[0]! },
    presentation: { kind: "content" },
  };
  ops[2] = {
    kind: "assign",
    leaf_id: ids[2]!,
    target: { role: "keywords" },
    presentation: { kind: "content" },
  };
  expect(arrangementPreview(accept(f.source, ops)).map((n) => n.text)).toEqual([
    "Experimental Section",
    "Materials.",
    "catalysis; ligand",
  ]);
  expect(() =>
    reviewArrangement(f.source, [
      ...ops.slice(0, 1),
      {
        kind: "assign",
        leaf_id: ids[1]!,
        target: { role: "additional", original_heading_leaf_id: foreign },
        presentation: { kind: "content" },
      },
      ops[2]!,
    ]),
  ).toThrow(ArchiveTextError);
  const table = await archiveTextFixture([
    {
      type: "table",
      text: "label",
      html: "<table><tr><td>7</td></tr></table>",
    },
  ]);
  expect(() =>
    reviewArrangement(table.source, [
      {
        kind: "split",
        root_block_id: table.source.blocks[0]!.root_block_id,
        cuts: [10],
      },
    ]),
  ).toThrow(ArchiveTextError);
});
it("verifies immutable raw bytes and retains exact legacy Markdown substrings only with unique page attribution", async () => {
  const f = await archiveTextFixture(
    [{ text: "Legacy exact.\n\nMore text." }],
    { layers: ["Legacy exact. More text."] },
  );
  await expect(
    prepareArrangementSource(
      f.source.raw,
      { readArtifact: async () => Buffer.from("changed") },
      f.pages,
    ),
  ).rejects.toMatchObject({ code: "source-integrity" });
  const input = {
      ...f.input,
      profile: "vlm-engine-markdown-only" as const,
      blocks: null,
      private_content_list: null,
      page_sizes: [],
    },
    raw = { ...input, ...(await rawParseIdentity(input)) };
  const source = await prepareArrangementSource(
    raw,
    { readArtifact: async () => f.markdown },
    f.pages,
  );
  expect(source.blocks.map((b) => b.text).join("")).toBe(f.markdown.toString());
  expect(source.blocks[0]!.locator).toMatchObject({
    kind: "raw-markdown",
    start_utf8: 0,
  });
  const duplicatePages = [f.pages[0]!, { ...f.pages[0]!, page: 1 }],
    duplicateInput = {
      ...input,
      page_count: 2,
      page_sizes: [],
    },
    duplicateRaw = {
      ...duplicateInput,
      ...(await rawParseIdentity(duplicateInput)),
    };
  await expect(
    prepareArrangementSource(
      duplicateRaw,
      { readArtifact: async () => f.markdown },
      duplicatePages,
    ),
  ).rejects.toMatchObject({ code: "input-missing" });
});
it("corrects a rejected draft in the same real DSH conversation and restores a verified checkpoint without another call", async () => {
  const f = await archiveTextFixture([{ text: "Synthetic paragraph." }]),
    ops = assigned(f.source),
    cache = memoryTextCache();
  let calls = 0;
  const runtime = fakeTextRuntime(async (request) => {
    calls++;
    expect(request.role).toBe("proofreading");
    if (calls === 1)
      return modelTool("read_blocks", { index: 0, offset: 0, limit: 20 });
    if (calls === 2)
      return modelTool("put_operations", {
        operations: [{ kind: "drop", leaf_id: foreign, reason: "header" }],
      });
    if (calls === 3) {
      expect(lastTool(request)?.status).toBe("rejected");
      expect(toolJson(request)).toMatchObject({ accepted: false });
      return modelTool("put_operations", { operations: ops });
    }
    if (calls === 4)
      return modelTool("review_breaks", { offset: 0, limit: 20 });
    return modelTool("submit_operations", {
      reviewed_candidates_sha256: toolJson(request).reviewed_candidates_sha256,
    });
  });
  try {
    const built = await new ArchiveArrangementService(
      runtime,
      fakePages(f.pages),
      cache.cache,
    ).build(f.source);
    expect(built.stop).toBeNull();
    expect(built.value?.leaves).toHaveLength(1);
    expect(built.usage).toMatchObject({
      calls: 5,
      input_tokens: 65,
      output_tokens: 35,
      usage_complete: true,
    });
    const again = await new ArchiveArrangementService(
      runtime,
      fakePages(f.pages),
      cache.cache,
    ).build(f.source);
    expect(again.value).toEqual(built.value);
    expect(again.usage.calls).toBe(0);
    expect(calls).toBe(5);
    const entry = [...cache.entries.values()][0]!,
      stored = JSON.parse(Buffer.from(entry.bytes).toString()) as {
        snapshot: { leaves: { original_text: string }[] };
      };
    stored.snapshot.leaves[0]!.original_text = "Tampered paragraph.";
    entry.bytes = Buffer.from(JSON.stringify(stored));
    await expect(
      new ArchiveArrangementService(
        runtime,
        fakePages(f.pages),
        cache.cache,
      ).build(f.source),
    ).rejects.toMatchObject({ code: "source-integrity" });
  } finally {
    await runtime.close();
  }
});
it("rejects mismatching cache and snapshot identities even when the payload remains superficially plausible", async () => {
  const f = await archiveTextFixture([{ text: "Unchanged." }]),
    snapshot = arranged(f.source);
  expect(() =>
    verifyArrangement(
      f.source,
      { ...snapshot, arrangement_id: textHash("other") },
      method,
    ),
  ).toThrow(ArchiveTextError);
  expect(() =>
    verifyArrangement(f.source, { ...snapshot, destinations: [] }, method),
  ).toThrow();
});
it("provides text-layer wrong-page hints and program-derived leaf IDs, then verifies reassignment evidence on checkpoint reuse", async () => {
  const f = await archiveTextFixture(
      [{ text: "Misplaced synthetic paragraph." }],
      { page_count: 2, layers: ["", "Misplaced synthetic paragraph."] },
    ),
    cache = memoryTextCache();
  let calls = 0,
    leaf = "";
  const runtime = fakeTextRuntime(async (request) => {
    calls++;
    if (calls === 1)
      return modelTool("read_blocks", { index: 0, offset: 0, limit: 20 });
    if (calls === 2)
      return modelTool("block_info", {
        root_block_id: f.source.blocks[0]!.root_block_id,
      });
    if (calls === 3) {
      const data = toolJson(request);
      expect(data.text_layer_page_hints).toEqual([1]);
      leaf = (data.leaves as { leaf_id: string }[])[0]!.leaf_id;
      return modelTool("view_page", { page_index: 1, region: null });
    }
    if (calls === 4)
      return modelTool("put_operations", {
        operations: [
          {
            kind: "assign",
            leaf_id: leaf,
            target: { role: "keywords" },
            presentation: { kind: "content" },
          },
          {
            kind: "assign-page",
            leaf_id: leaf,
            page_index: 1,
            basis_page_index: 1,
            reason: "image",
          },
        ],
      });
    if (calls === 5)
      return modelTool("review_breaks", { offset: 0, limit: 20 });
    return modelTool("submit_operations", {
      reviewed_candidates_sha256: toolJson(request).reviewed_candidates_sha256,
    });
  });
  try {
    const service = () =>
        new ArchiveArrangementService(runtime, fakePages(f.pages), cache.cache),
      result = await service().build(f.source);
    expect(result.stop).toBeNull();
    expect(result.value?.leaves[0]).toMatchObject({
      page_index: 1,
      region: null,
      leaf_id: leaf,
    });
    expect((await service().build(f.source)).usage.calls).toBe(0);
    const entry = [...cache.entries.values()][0]!,
      stored = JSON.parse(Buffer.from(entry.bytes).toString()) as {
        evidence: { viewed_pages: number[] };
      };
    stored.evidence.viewed_pages = [];
    entry.bytes = Buffer.from(JSON.stringify(stored));
    await expect(service().build(f.source)).rejects.toMatchObject({
      code: "source-integrity",
    });
  } finally {
    await runtime.close();
  }
});
it("finishes an 80-block document past the old call cap with bounded requests and a complete host-held operation set", async () => {
  const f = await archiveTextFixture(
      Array.from({ length: 80 }, (_, i) => ({
        text: `Paragraph ${i}: ` + "exact unchanged content ".repeat(150) + ".",
      })),
    ),
    ops = assigned(f.source),
    cache = memoryTextCache();
  let step = 0,
    maxRequest = 0;
  const runtime = fakeTextRuntime(async (request) => {
    maxRequest = Math.max(
      maxRequest,
      Buffer.byteLength(JSON.stringify(request)),
    );
    if (request.tool_choice === "none")
      return modelText(
        "Continue the same document; source reading and operation drafts are stored by the host. Inspect draft_status if needed.",
      );
    const current = step++;
    if (current < 240) {
      const index = Math.floor(current / 3);
      if (current % 3 === 0)
        return modelTool("read_blocks", { index, offset: 0, limit: 1 });
      if (current % 3 === 1)
        return modelTool("block_info", {
          root_block_id: f.source.blocks[index]!.root_block_id,
        });
      return modelTool("put_operations", { operations: [ops[index]!] });
    }
    if (current === 240)
      return modelTool("review_breaks", { offset: 0, limit: 20 });
    return modelTool("submit_operations", {
      reviewed_candidates_sha256: toolJson(request).reviewed_candidates_sha256,
    });
  });
  try {
    const result = await new ArchiveArrangementService(
      runtime,
      fakePages(f.pages),
      cache.cache,
    ).build(f.source);
    expect(result.stop).toBeNull();
    expect(result.value?.destinations).toHaveLength(80);
    expect(result.usage.calls).toBeGreaterThanOrEqual(242);
    expect(result.usage.compaction_calls).toBeGreaterThan(0);
    expect(maxRequest).toBeLessThan(500 * 1024);
    verifyArrangementPayload(
      f.source,
      result.value!,
      arrangementPreview(result.value!).flatMap((n) => n.payloads),
    );
  } finally {
    await runtime.close();
  }
}, 30000);
