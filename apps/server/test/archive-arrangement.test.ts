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
import type { ModelRequest } from "../src/agents/model-protocol.js";
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
/** The JSON the host sent as the first message of a request. */
function requestJson(request: ModelRequest): Record<string, unknown> {
  for (const m of request.messages)
    for (const p of m.parts)
      if ("text" in p)
        try {
          return JSON.parse(p.text) as Record<string, unknown>;
        } catch {
          /* Not the host's JSON input. */
        }
  throw Error("missing-request-json");
}
const service = (
  runtime: ReturnType<typeof fakeTextRuntime>,
  f: { pages: Parameters<typeof fakePages>[0] },
  cache = memoryTextCache().cache,
) => new ArchiveArrangementService(runtime, fakePages(f.pages), cache);
const wholeAnswer = (): Record<string, unknown> => ({
  sections: [],
  headings: [],
  drops: [],
  captions: [],
  splits: [],
});
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
  expect(review.candidates[0]?.rule_version).toBe("paragraph-break-v2");
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
it("requires stated page evidence for page reassignment and keeps source coordinates fixed", async () => {
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
    reviewArrangement(f.source, moved, { evidence_pages: new Set([0]) }),
  ).toThrow(ArchiveTextError);
  const review = reviewArrangement(f.source, moved, {
    evidence_pages: new Set([1]),
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

it("sends every block at once with short names, page hints, regions and exact text, then decides every break in one more request", async () => {
  const f = await archiveTextFixture([
    { text: "Synthetic Title", type: "title" },
    { text: "Ada Author" },
    { text: "Journal header", type: "header" },
    { text: "Abstract text." },
    { text: "", type: "image", image: true },
    { text: "Figure 1. Synthetic.", type: "caption" },
    { text: "Fragment of a sentence" },
    { text: "Continues here." },
  ]);
  const seen: Record<string, unknown>[] = [];
  const runtime = fakeTextRuntime(async (request) => {
    seen.push(requestJson(request));
    expect(request.tool_choice).toBe("required");
    if (seen.length === 1)
      return modelTool("submit_arrangement", {
        ...wholeAnswer(),
        sections: [
          { first: "r1", last: "r1", role: "title", heading: null },
          { first: "r2", last: "r2", role: "authors", heading: null },
          { first: "r3", last: "r4", role: "abstract", heading: null },
          {
            first: "r5",
            last: "r8",
            role: "results-discussion",
            heading: null,
          },
        ],
        drops: [{ block: "r3", reason: "header" }],
        captions: [{ object: "r5", captions: ["r6", "r7"], kind: "figure" }],
      });
    return modelTool("submit_breaks", {
      decisions: [{ candidate: "c1", decision: "merge", reason: "" }],
    });
  });
  try {
    const result = await service(runtime, f).build(f.source);
    expect(result.stop).toBeNull();
    expect(result.usage.calls).toBe(2);
    const blocks = seen[0]!.blocks as Record<string, unknown>[];
    expect(blocks.map((b) => b.id)).toEqual([
      "r1",
      "r2",
      "r3",
      "r4",
      "r5",
      "r6",
      "r7",
      "r8",
    ]);
    expect(blocks[4]).toEqual({
      id: "r5",
      type: "image",
      page: 0,
      region: [0, 0, 900, 200],
      text: "",
    });
    expect(blocks[6]).toEqual({
      id: "r7",
      type: "text",
      page: 0,
      text: "Fragment of a sentence",
    });
    expect(seen[1]!.candidates).toEqual([
      {
        candidate: "c1",
        left_tail: "Fragment of a sentence",
        right_head: "Continues here.",
        left_is_whole: true,
        left_ends_with_hyphen: false,
        skipped: [],
      },
    ]);
    const leaves = result.value!.leaves.map((l) => l.leaf_id),
      ops = result.value!.operations;
    expect(ops).toContainEqual({
      kind: "drop",
      leaf_id: leaves[2],
      reason: "header",
    });
    // A text block listed as a caption is not linked; the caption is.
    expect(ops).toContainEqual({
      kind: "caption",
      object_leaf_id: leaves[4],
      caption_leaf_ids: [leaves[5]],
      object_kind: "figure",
    });
    expect(ops).toContainEqual({
      kind: "merge",
      leaf_ids: [leaves[6], leaves[7]],
    });
    expect(arrangementPreview(result.value!).map((n) => n.text)).toContain(
      "Fragment of a sentence Continues here.",
    );
  } finally {
    await runtime.close();
  }
});
it("splits a glued copyright line before the request and drops only that part", async () => {
  const f = await archiveTextFixture([
    { text: "Body paragraph.\n© 2024 Synthetic Publisher" },
  ]);
  const runtime = fakeTextRuntime(async (request) => {
    const blocks = requestJson(request).blocks as {
      id: string;
      text: string;
    }[];
    expect(blocks).toMatchObject([
      { id: "r1#1", text: "Body paragraph.\n" },
      { id: "r1#2", text: "© 2024 Synthetic Publisher" },
    ]);
    return modelTool("submit_arrangement", {
      ...wholeAnswer(),
      sections: [
        { first: "r1#1", last: "r1#2", role: "methods", heading: null },
      ],
      drops: [{ block: "r1#2", reason: "copyright" }],
    });
  });
  try {
    const result = await service(runtime, f).build(f.source);
    expect(result.usage.calls).toBe(1);
    expect(result.value!.operations).toContainEqual({
      kind: "split",
      root_block_id: f.source.blocks[0]!.root_block_id,
      cuts: [16],
    });
    expect(result.value!.destinations.map((d) => d.destination.kind)).toEqual([
      "assigned",
      "dropped",
    ]);
  } finally {
    await runtime.close();
  }
});
it("returns a rejected answer to the same request once, reuses a verified checkpoint, and stops after a second rejection", async () => {
  const f = await archiveTextFixture([
      { text: "Synthetic paragraph." },
      { text: "Another one." },
    ]),
    cache = memoryTextCache();
  let calls = 0;
  const runtime = fakeTextRuntime(async (request) => {
    calls++;
    if (calls === 2) {
      expect(lastTool(request)?.status).toBe("rejected");
      expect(toolJson(request)).toMatchObject({
        accepted: false,
        issues: [{ code: "block-without-section", id: "r2" }],
      });
    }
    return modelTool("submit_arrangement", {
      ...wholeAnswer(),
      sections: [
        {
          first: "r1",
          last: calls === 1 ? "r1" : "r2",
          role: "methods",
          heading: null,
        },
      ],
    });
  });
  try {
    const built = await service(runtime, f, cache.cache).build(f.source);
    expect(built.stop).toBeNull();
    expect(built.usage).toMatchObject({
      calls: 2,
      input_tokens: 26,
      output_tokens: 14,
      usage_complete: true,
    });
    const again = await service(runtime, f, cache.cache).build(f.source);
    expect(again.value).toEqual(built.value);
    expect(again.usage.calls).toBe(0);
    const entry = [...cache.entries.values()][0]!,
      stored = JSON.parse(Buffer.from(entry.bytes).toString()) as {
        snapshot: { leaves: { original_text: string }[] };
      };
    stored.snapshot.leaves[0]!.original_text = "Tampered paragraph.";
    entry.bytes = Buffer.from(JSON.stringify(stored));
    await expect(
      service(runtime, f, cache.cache).build(f.source),
    ).rejects.toMatchObject({ code: "source-integrity" });
  } finally {
    await runtime.close();
  }
  let wrong = 0;
  const stubborn = fakeTextRuntime(async () => {
    wrong++;
    return modelTool("submit_arrangement", {
      ...wholeAnswer(),
      sections: [{ first: "r1", last: "r1", role: "methods", heading: null }],
    });
  });
  try {
    const failed = await service(stubborn, f).build(f.source);
    expect(failed.value).toBeNull();
    expect(failed.stop).toMatchObject({
      step: "arrange",
      scope: "part",
      cause_code: "arrangement-invalid",
      retryable: true,
    });
    // No resend after a corrected answer was rejected again.
    expect(wrong).toBe(2);
  } finally {
    await stubborn.close();
  }
});
it("resends a request once when it ends without an answer", async () => {
  const f = await archiveTextFixture([{ text: "Synthetic paragraph." }]);
  let calls = 0;
  const runtime = fakeTextRuntime(async () => {
    calls++;
    return calls === 1
      ? modelText("no tool call")
      : modelTool("submit_arrangement", {
          ...wholeAnswer(),
          sections: [
            { first: "r1", last: "r1", role: "methods", heading: null },
          ],
        });
  });
  try {
    const result = await service(runtime, f).build(f.source);
    expect(result.stop).toBeNull();
    expect(result.usage.calls).toBe(2);
  } finally {
    await runtime.close();
  }
});
it("moves a leaf to the page whose text layer prints it, and verifies that evidence on checkpoint reuse", async () => {
  const words = "Misplaced synthetic paragraph about sulfur hosts.";
  const f = await archiveTextFixture([{ text: words }], {
      page_count: 2,
      layers: ["Other words entirely.", words],
    }),
    cache = memoryTextCache();
  const runtime = fakeTextRuntime(async () =>
    modelTool("submit_arrangement", {
      ...wholeAnswer(),
      sections: [
        { first: "r1", last: "r1", role: "references", heading: null },
      ],
    }),
  );
  try {
    const result = await service(runtime, f, cache.cache).build(f.source);
    expect(result.stop).toBeNull();
    expect(result.value!.leaves[0]).toMatchObject({
      page_index: 1,
      region: null,
    });
    expect(result.value!.operations).toContainEqual(
      expect.objectContaining({
        kind: "assign-page",
        page_index: 1,
        basis_page_index: 1,
      }),
    );
    expect(
      (await service(runtime, f, cache.cache).build(f.source)).usage.calls,
    ).toBe(0);
    const entry = [...cache.entries.values()][0]!,
      stored = JSON.parse(Buffer.from(entry.bytes).toString()) as {
        evidence: { evidence_pages: number[] };
      };
    stored.evidence.evidence_pages = [];
    entry.bytes = Buffer.from(JSON.stringify(stored));
    await expect(
      service(runtime, f, cache.cache).build(f.source),
    ).rejects.toMatchObject({ code: "source-integrity" });
  } finally {
    await runtime.close();
  }
});
it("keeps a person's locked destination whatever the model answers", async () => {
  const f = await archiveTextFixture([
      { text: "Kept by hand." },
      { text: "Ordinary text." },
    ]),
    seed = arranged(f.source);
  const locked = {
    ...seed,
    destinations: seed.destinations.map((d, i) =>
      i === 0
        ? {
            ...d,
            destination: {
              kind: "dropped" as const,
              reason: "decoration" as const,
            },
            decision_id: "00000000-0000-4000-8000-000000000001",
            locked: true,
          }
        : d,
    ),
  };
  const runtime = fakeTextRuntime(async () =>
    modelTool("submit_arrangement", {
      ...wholeAnswer(),
      sections: [{ first: "r1", last: "r2", role: "methods", heading: null }],
    }),
  );
  try {
    const result = await service(runtime, f).build(f.source, undefined, locked);
    expect(result.stop).toBeNull();
    expect(result.value!.destinations[0]).toMatchObject({
      destination: { kind: "dropped", reason: "decoration" },
      locked: true,
    });
    expect(result.value!.destinations[1]!.destination).toMatchObject({
      kind: "assigned",
      target: { role: "methods" },
    });
  } finally {
    await runtime.close();
  }
});
it("stops a part larger than the input limit before sending any request", async () => {
  const f = await archiveTextFixture([{ text: "word ".repeat(80000) + "." }]);
  let calls = 0;
  const runtime = fakeTextRuntime(async () => {
    calls++;
    return modelText("unused");
  });
  try {
    const result = await service(runtime, f).build(f.source);
    expect(result.stop).toMatchObject({
      code: "request-too-large",
      step: "arrange",
    });
    expect(calls).toBe(0);
  } finally {
    await runtime.close();
  }
});
it("finds a break where the next block starts with a capital letter or a formula", async () => {
  const f = await archiveTextFixture([
    { text: "selected diphenylphosphine oxide and" },
    { text: "DBU as base." },
    { text: "yields of" },
    { text: "$67 - 91\\%$ were obtained." },
  ]);
  expect(
    reviewArrangement(f.source, assigned(f.source)).candidates,
  ).toHaveLength(2);
});
