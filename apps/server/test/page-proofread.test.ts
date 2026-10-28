import { expect, it } from "vitest";
import type {
  ArrangementOperation,
  CorrectOperation,
  PageReviewEvidence,
  RetainedPageSuspect,
} from "@sciretriever/contracts";
import { AgentFailure } from "../src/agents/protocol.js";
import { ArchivePageProofreadService } from "../src/proofread/page-service.js";
import {
  acceptPageSubmission,
  applyLeafCorrections,
  pageReviewSuspects,
  retainedPageSuspects,
} from "../src/proofread/leaf-corrections.js";
import { arrangementLeafId } from "../src/archive/arrangement.js";
import { textHash } from "../src/archive/text-source.js";
import {
  archiveTextFixture,
  arranged,
  assigned,
  fakePages,
  fakeTextRuntime,
  initialPage,
  memoryTextCache,
  modelTool,
  toolJson,
} from "./archive-text-fixture.js";
const hash = "d".repeat(64);
it("retries only an explicitly selected failed page and preserves other unfinished records without charging them again", async () => {
  const f = await archiveTextFixture([
      { text: "FIRSTPAGE synthetic.", page: 0 },
      { text: "SECONDPAGE synthetic.", page: 1 },
    ]),
    snapshot = arranged(f.source),
    cache = memoryTextCache(),
    steps = new Map<number, number>(),
    visited: number[] = [];
  let fail = true;
  const runtime = fakeTextRuntime(async (request) => {
    const { page_index } = initialPage(request);
    visited.push(page_index);
    if (fail) throw new AgentFailure("agent-response-limit");
    const n = (steps.get(page_index) ?? 0) + 1;
    steps.set(page_index, n);
    if (n === 1)
      return modelTool("read_blocks", {
        page_index,
        index: 0,
        offset: 0,
        limit: 20,
      });
    if (n === 2) return modelTool("view_page", { page_index, region: null });
    return modelTool("submit_page", { no_change: true });
  });
  try {
    const service = new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      cache.cache,
    );
    const first = await service.build(f.source, snapshot, f.pages);
    expect(first.pages.map((p) => p.status)).toEqual(["failed", "failed"]);
    fail = false;
    visited.length = 0;
    const second = await service.build(
      f.source,
      snapshot,
      f.pages,
      undefined,
      [],
      undefined,
      new Map([[1, first.pages[1]!]]),
    );
    expect(visited).toEqual([0, 0, 0]);
    expect(second.pages.map((p) => p.status)).toEqual(["accepted", "failed"]);
    expect(second.pages[1]).toEqual(first.pages[1]);
    expect(second.untouched_page_indexes).toEqual([1]);
    expect(second.complete).toBe(false);
    expect(second.usage.calls).toBe(3);
    visited.length = 0;
    const third = await service.build(
      f.source,
      snapshot,
      f.pages,
      undefined,
      [],
      undefined,
      new Map([[0, second.pages[0]!]]),
    );
    expect(visited).toEqual([1, 1, 1]);
    expect(third.complete).toBe(true);
    expect(third.reused_page_indexes).toEqual([0]);
    expect(third.usage.calls).toBe(3);
  } finally {
    await runtime.close();
  }
});
const evidence = (ids: readonly string[]): PageReviewEvidence => ({
  read_leaf_ids: ids,
  viewed_full_page: true,
  viewed_regions: [],
});
it("applies leaf-local code-point corrections with an exact raw span, including insertions and deletions", async () => {
  const f = await archiveTextFixture([{ text: "prefix:A😀B12Z" }]),
    root = f.source.blocks[0]!,
    start = 7,
    id = arrangementLeafId(
      root.root_block_id,
      start,
      [...root.text].length,
      f.source.raw.result_sha256,
    ),
    ops: ArrangementOperation[] = [
      { kind: "split", root_block_id: root.root_block_id, cuts: [start] },
      {
        kind: "drop",
        leaf_id: arrangementLeafId(
          root.root_block_id,
          0,
          start,
          f.source.raw.result_sha256,
        ),
        reason: "interface",
      },
      {
        kind: "assign",
        leaf_id: id,
        target: { role: "methods" },
        presentation: { kind: "content" },
      },
    ],
    snapshot = arranged(f.source, ops),
    leaf = snapshot.leaves[1]!;
  const correct: CorrectOperation = {
    kind: "correct",
    leaf_id: id,
    start: 1,
    end: 2,
    original: "😀",
    replacement: "β",
    basis_page_index: 0,
    reason: "image",
  };
  const result = applyLeafCorrections(
    [leaf],
    [
      correct,
      { ...correct, start: 3, end: 5, original: "12", replacement: "" },
      { ...correct, start: 6, end: 6, original: "", replacement: "!" },
    ],
    0,
    hash,
  );
  expect(result.texts.get(id)).toBe("AβBZ!");
  expect(result.records[0]!.source_span).toMatchObject({
    root_block_id: root.root_block_id,
    start: 8,
    end: 9,
  });
  for (const invalid of [
    { ...correct, original: "B" },
    { ...correct, basis_page_index: 1 },
    { ...correct, leaf_id: snapshot.leaves[0]!.leaf_id },
    { ...correct, end: 99, original: "x" },
  ])
    expect(() => applyLeafCorrections([leaf], [invalid], 0, hash)).toThrow();
  expect(() =>
    applyLeafCorrections([leaf], [correct, correct], 0, hash),
  ).toThrow();
  expect(() =>
    applyLeafCorrections([leaf], [correct], 0, hash, new Set([id])),
  ).toThrow();
});
it("refuses overlapping edits and flattened table corrections while retaining valid table markup", async () => {
  const html = "<table><tr><td>67</td></tr></table>",
    f = await archiveTextFixture([{ type: "table", text: "67", html }]),
    leaf = arranged(f.source).leaves[0]!,
    offset = [...html.slice(0, html.indexOf("67"))].length;
  const correct: CorrectOperation = {
    kind: "correct",
    leaf_id: leaf.leaf_id,
    start: offset,
    end: offset + 2,
    original: "67",
    replacement: "97",
    basis_page_index: 0,
    reason: "image",
  };
  expect(
    applyLeafCorrections([leaf], [correct], 0, hash).texts.get(leaf.leaf_id),
  ).toBe(html.replace("67", "97"));
  expect(() =>
    applyLeafCorrections(
      [leaf],
      [
        {
          ...correct,
          start: 0,
          end: [...html].length,
          original: html,
          replacement: "97",
        },
      ],
      0,
      hash,
    ),
  ).toThrow();
  expect(() =>
    applyLeafCorrections(
      [leaf],
      [
        correct,
        {
          ...correct,
          start: offset + 1,
          end: offset + 2,
          original: "7",
          replacement: "9",
        },
      ],
      0,
      hash,
    ),
  ).toThrow();
});
it("subtracts only deleted token occurrences, retains repeated-number questions and has no cross-page suspect type", async () => {
  const f = await archiveTextFixture(
      [{ text: "Yield 5." }, { text: "5", type: "footer" }],
      { layers: ["Yield 5 5 5."] },
    ),
    ops = assigned(f.source),
    drop = ops[1]!;
  ops[1] = {
    kind: "drop",
    leaf_id: "leaf_id" in drop ? drop.leaf_id : "",
    reason: "footer",
  };
  const snapshot = arranged(f.source, ops),
    suspects = retainedPageSuspects(
      f.pages[0]!,
      snapshot.leaves.slice(0, 1),
      snapshot.leaves.slice(1),
      hash,
    );
  // A number is counted once, as a token mismatch, not also as missing text.
  expect(suspects.map((s) => [s.kind, s.tokens])).toEqual([
    ["token-mismatch", ["5"]],
  ]);
  const badGlyph = await archiveTextFixture([{ text: "x\uFFFD" }], {
    layers: ["x"],
  });
  expect(
    retainedPageSuspects(
      badGlyph.pages[0]!,
      arranged(badGlyph.source).leaves,
      [],
      hash,
    ).some((s) => s.tokens.includes("U+FFFD")),
  ).toBe(true);
});
it("asks one question per run of adjacent differences and ignores where a compound hyphen breaks", async () => {
  // A real RSC page: scheme text the layer lacks became 115 one-word questions, and a
  // compound hyphen at a layer line end made "metal-catalyzed" two words on one side only.
  const f = await archiveTextFixture(
    [
      {
        text: "A metal-catalyzed route. Scheme scope with varied aryl iodides 97% yield.",
      },
    ],
    { layers: ["A metal-\ncatalyzed route."] },
  );
  const suspects = retainedPageSuspects(
    f.pages[0]!,
    arranged(f.source).leaves,
    [],
    hash,
  );
  expect(suspects.map((s) => [s.kind, s.tokens])).toEqual([
    [
      "token-mismatch",
      [
        "Scheme",
        "scope",
        "with",
        "varied",
        "aryl",
        "iodides",
        "97",
        "%",
        "yield",
      ],
    ],
  ]);
});
it("requires complete source reading, a full image and an explicit disposition for every original and newly introduced suspect", async () => {
  const f = await archiveTextFixture([{ text: "Yield 67%." }], {
      layers: ["Yield 97%."],
    }),
    leaves = arranged(f.source).leaves,
    leaf = leaves[0]!,
    initial = retainedPageSuspects(f.pages[0]!, leaves, [], hash),
    base = {
      page: f.pages[0]!,
      retained: leaves,
      deleted: [],
      page_input_sha256: hash,
      suspects: initial,
      evidence: evidence([leaf.leaf_id]),
    };
  const value = {
    schema_version: 2,
    page_index: 0,
    page_input_sha256: hash,
    corrections: [],
    no_change: true,
    dispositions: initial.map((s) => ({
      suspect_id: s.suspect_id,
      status: "uncertain",
      reason: "unclear",
    })),
  };
  expect(() => acceptPageSubmission(base, value)).not.toThrow();
  expect(() =>
    acceptPageSubmission(
      { ...base, evidence: { ...base.evidence, viewed_full_page: false } },
      value,
    ),
  ).toThrow();
  expect(() =>
    acceptPageSubmission(
      { ...base, evidence: { ...base.evidence, read_leaf_ids: [] } },
      value,
    ),
  ).toThrow();
  expect(() =>
    acceptPageSubmission(base, { ...value, dispositions: [] }),
  ).toThrow();
  const operation: CorrectOperation = {
      kind: "correct",
      leaf_id: leaf.leaf_id,
      start: 6,
      end: 8,
      original: "67",
      replacement: "97",
      basis_page_index: 0,
      reason: "image",
    },
    applied = applyLeafCorrections(leaves, [operation], 0, hash),
    fixed = {
      ...value,
      corrections: [operation],
      no_change: false,
      dispositions: initial.map((s) => ({
        suspect_id: s.suspect_id,
        status: "fixed",
        correction_ids: [applied.records[0]!.correction_id],
      })),
    };
  expect(acceptPageSubmission(base, fixed).texts.get(leaf.leaf_id)).toBe(
    "Yield 97%.",
  );
  const introduces = { ...operation, replacement: "42" },
    changed = applyLeafCorrections(leaves, [introduces], 0, hash),
    questions = pageReviewSuspects(
      f.pages[0]!,
      leaves,
      [],
      hash,
      changed.texts,
    );
  expect(questions.length).toBeGreaterThan(initial.length);
  expect(() =>
    acceptPageSubmission(base, {
      ...value,
      corrections: [introduces],
      no_change: false,
    }),
  ).toThrow();
  expect(() =>
    acceptPageSubmission(
      { ...base, suspects: questions },
      {
        ...value,
        corrections: [introduces],
        no_change: false,
        dispositions: questions.map((s) => ({
          suspect_id: s.suspect_id,
          status: "uncertain",
          reason: "unclear",
        })),
      },
    ),
  ).not.toThrow();
});
it.each(["text-layer", "image-only"] as const)(
  "recovers a premature submission and crop-only view in one %s page session",
  async (kind) => {
    const f = await archiveTextFixture(
        [{ text: "Page content." }],
        kind === "image-only" ? { layers: [""] } : {},
      ),
      snapshot = arranged(f.source),
      cache = memoryTextCache();
    let calls = 0;
    const runtime = fakeTextRuntime(async (request) => {
      calls++;
      const { page_index } = initialPage(request);
      if (calls === 1) return modelTool("submit_page", { no_change: true });
      if (calls === 2) {
        expect(toolJson(request)).toMatchObject({ accepted: false });
        return modelTool("view_page", { page_index, region: [0, 0, 500, 500] });
      }
      if (calls === 3)
        return modelTool("read_blocks", {
          page_index,
          index: 0,
          offset: 0,
          limit: 20,
        });
      if (calls === 4) return modelTool("submit_page", { no_change: true });
      if (calls === 5) {
        expect(JSON.stringify(toolJson(request))).toContain(
          "full-page-not-viewed",
        );
        return modelTool("view_page", { page_index, region: null });
      }
      return modelTool("submit_page", { no_change: true });
    });
    try {
      const result = await new ArchivePageProofreadService(
        runtime,
        fakePages(f.pages),
        cache.cache,
      ).build(f.source, snapshot, f.pages);
      expect(result.complete).toBe(true);
      expect(result.pages[0]).toMatchObject({
        status: "accepted",
        no_change: true,
        evidence: { viewed_full_page: true },
        usage: { calls: 6 },
      });
      expect(cache.entries.size).toBe(1);
    } finally {
      await runtime.close();
    }
  },
);
it("isolates page context, retries only the failed page, and reuses unchanged page inputs after rearrangement", async () => {
  const f = await archiveTextFixture([
      { text: "FIRSTPAGE secret synthetic.", page: 0 },
      { text: "SECONDPAGE synthetic.", page: 1 },
      { text: "SECONDNOTE synthetic.", page: 1 },
      { text: "THIRDPAGE synthetic.", page: 2 },
    ]),
    snapshot = arranged(f.source),
    cache = memoryTextCache(),
    steps = new Map<string, number>(),
    seenPages: number[] = [];
  let fail = true;
  const runtime = fakeTextRuntime(async (request) => {
    const { page_index, page_input_sha256 } = initialPage(request),
      step = (steps.get(page_input_sha256) ?? 0) + 1;
    steps.set(page_input_sha256, step);
    seenPages.push(page_index);
    const body = JSON.stringify(request.messages);
    for (const [index, marker] of [
      "FIRSTPAGE",
      "SECONDPAGE",
      "THIRDPAGE",
    ].entries())
      if (index !== page_index) expect(body).not.toContain(marker);
    if (page_index === 1 && fail) {
      fail = false;
      steps.set(page_input_sha256, 0);
      throw new AgentFailure("agent-response-limit");
    }
    if (step === 1)
      return modelTool("read_blocks", {
        page_index,
        index: 0,
        offset: 0,
        limit: 20,
      });
    if (step === 2) return modelTool("view_page", { page_index, region: null });
    return modelTool("submit_page", { no_change: true });
  });
  try {
    const service = () =>
      new ArchivePageProofreadService(runtime, fakePages(f.pages), cache.cache);
    const first = await service().build(f.source, snapshot, f.pages);
    expect(first.complete).toBe(false);
    expect(first.pages.map((p) => p.status)).toEqual([
      "accepted",
      "failed",
      "accepted",
    ]);
    expect(first.pages[1]!.stop?.code).toBe("response-too-large");
    expect(first.pages[1]!.usage).toMatchObject({
      calls: 1,
      input_tokens: null,
      output_tokens: null,
      usage_complete: false,
    });
    seenPages.length = 0;
    const second = await service().build(f.source, snapshot, f.pages);
    expect(second.complete).toBe(true);
    expect(second.reused_page_indexes).toEqual([0, 2]);
    expect(seenPages).toEqual([1, 1, 1]);
    expect(second.usage.calls).toBe(3);
    const changed = assigned(f.source),
      leaf = snapshot.leaves[2]!;
    changed[2] = { kind: "drop", leaf_id: leaf.leaf_id, reason: "footer" };
    seenPages.length = 0;
    const third = await service().build(
      f.source,
      arranged(f.source, changed),
      f.pages,
    );
    expect(third.complete).toBe(true);
    expect(third.reused_page_indexes).toEqual([0, 2]);
    expect(seenPages).toEqual([1, 1, 1]);
    expect(third.pages[1]!.page_input_sha256).not.toBe(
      second.pages[1]!.page_input_sha256,
    );
  } finally {
    await runtime.close();
  }
});
it("does not call a model for classified or missing pages, and reports a nonblocking content gap without inventing leaves", async () => {
  const f = await archiveTextFixture(
      [{ text: "Page header.", type: "header" }],
      { page_count: 2, layers: ["Page header.", "This body was not parsed."] },
    ),
    operation = assigned(f.source)[0]!,
    id = "leaf_id" in operation ? operation.leaf_id : "",
    snapshot = arranged(f.source, [
      { kind: "drop", leaf_id: id, reason: "header" },
    ]);
  let calls = 0;
  const runtime = fakeTextRuntime(async () => {
    calls++;
    throw Error("model-not-allowed");
  });
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source, snapshot, f.pages);
    expect(result.complete).toBe(true);
    expect(result.pages.map((p) => p.not_required_reason)).toEqual([
      "all-content-classified",
      "no-retained-content",
    ]);
    expect(result.issues).toEqual([
      { code: "page-content-missing", page_index: 1, affects_readiness: false },
    ]);
    expect(result.usage.calls).toBe(0);
    expect(calls).toBe(0);
    expect(snapshot.leaves).toHaveLength(1);
  } finally {
    await runtime.close();
  }
});
it("revalidates computed suspects on a page-cache hit instead of trusting an omitted question set", async () => {
  const f = await archiveTextFixture([{ text: "Yield 67%." }], {
      layers: ["Yield 97%."],
    }),
    snapshot = arranged(f.source),
    cache = memoryTextCache();
  let calls = 0;
  const runtime = fakeTextRuntime(async (request) => {
    calls++;
    const { page_index } = initialPage(request);
    if (calls === 1)
      return modelTool("read_blocks", {
        page_index,
        index: 0,
        offset: 0,
        limit: 20,
      });
    if (calls === 2)
      return modelTool("view_page", { page_index, region: null });
    if (calls === 3)
      return modelTool("read_reference", {
        page_index,
        text_offset: 0,
        suspect_offset: 0,
      });
    if (calls === 4) {
      const questions = toolJson(request).suspects as RetainedPageSuspect[];
      return modelTool("put_dispositions", {
        dispositions: questions.map((s) => ({
          suspect_id: s.suspect_id,
          status: "uncertain",
          reason: "image",
        })),
      });
    }
    return modelTool("submit_page", { no_change: true });
  });
  try {
    const service = () =>
      new ArchivePageProofreadService(runtime, fakePages(f.pages), cache.cache);
    expect((await service().build(f.source, snapshot, f.pages)).complete).toBe(
      true,
    );
    expect(
      (await service().build(f.source, snapshot, f.pages)).usage.calls,
    ).toBe(0);
    const entry = [...cache.entries.values()][0]!,
      record = JSON.parse(Buffer.from(entry.bytes).toString()) as {
        suspects: unknown[];
        dispositions: unknown[];
      };
    record.suspects = [];
    record.dispositions = [];
    entry.bytes = Buffer.from(JSON.stringify(record));
    await expect(
      service().build(f.source, snapshot, f.pages),
    ).rejects.toMatchObject({ code: "source-integrity" });
    expect(calls).toBe(5);
  } finally {
    await runtime.close();
  }
});
it("rejects a changed source mapping or missing page inspection before any model call", async () => {
  const f = await archiveTextFixture([{ text: "Stable." }]),
    snapshot = arranged(f.source),
    runtime = fakeTextRuntime(async () => {
      throw Error("forbidden");
    });
  try {
    const service = new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    );
    await expect(
      service.build(
        f.source,
        { ...snapshot, source_input_sha256: textHash("other") },
        f.pages,
      ),
    ).rejects.toThrow();
    await expect(service.build(f.source, snapshot, [])).rejects.toMatchObject({
      code: "source-integrity",
    });
  } finally {
    await runtime.close();
  }
});
it("rejects neighbor-page access and does not count a short or cropped inspection as complete", async () => {
  const f = await archiveTextFixture([
      { text: "Only this page.", page: 0 },
      { text: "OTHERPAGE hidden synthetic.", page: 1 },
    ]),
    ops = assigned(f.source),
    other = ops[1]!;
  ops[1] = {
    kind: "drop",
    leaf_id: "leaf_id" in other ? other.leaf_id : "",
    reason: "interface",
  };
  let calls = 0;
  const runtime = fakeTextRuntime(async (request) => {
    calls++;
    expect(JSON.stringify(request.messages)).not.toContain("OTHERPAGE");
    if (calls === 1)
      return modelTool("read_blocks", {
        page_index: 1,
        index: 0,
        offset: 0,
        limit: 20,
      });
    if (calls === 2) {
      expect(JSON.stringify(toolJson(request))).toContain(
        "page-outside-session",
      );
      return modelTool("read_blocks", {
        page_index: 0,
        index: 0,
        offset: 5,
        limit: 20,
      });
    }
    if (calls === 3)
      return modelTool("view_page", { page_index: 0, region: null });
    if (calls === 4) return modelTool("submit_page", { no_change: true });
    if (calls === 5) {
      expect(JSON.stringify(toolJson(request))).toContain("leaf-not-read");
      return modelTool("read_blocks", {
        page_index: 0,
        index: 0,
        offset: 0,
        limit: 20,
      });
    }
    return modelTool("submit_page", { no_change: true });
  });
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source, arranged(f.source, ops), f.pages);
    expect(result.complete).toBe(true);
    expect(calls).toBe(6);
  } finally {
    await runtime.close();
  }
});
it("removes draft-only questions when their correction is removed and preserves source questions", async () => {
  const f = await archiveTextFixture([{ text: "Yield 97%." }]),
    snapshot = arranged(f.source),
    leaf = snapshot.leaves[0]!;
  let calls = 0,
    correctionId = "";
  const runtime = fakeTextRuntime(async (request) => {
    calls++;
    if (calls === 1)
      return modelTool("read_blocks", {
        page_index: 0,
        index: 0,
        offset: 0,
        limit: 20,
      });
    if (calls === 2)
      return modelTool("view_page", { page_index: 0, region: null });
    if (calls === 3)
      return modelTool("put_corrections", {
        corrections: [
          {
            kind: "correct",
            leaf_id: leaf.leaf_id,
            start: 6,
            end: 8,
            original: "97",
            replacement: "42",
            basis_page_index: 0,
            reason: "image",
          },
        ],
      });
    if (calls === 4) {
      const data = toolJson(request);
      expect(data.suspect_count).toBeGreaterThan(0);
      correctionId = (data.correction_ids as string[])[0]!;
      return modelTool("remove_corrections", {
        correction_ids: [correctionId],
      });
    }
    if (calls === 5)
      // Paging suspects only: an offset past the layer end returns no text, not a rejection.
      return modelTool("read_reference", {
        page_index: 0,
        text_offset: 9999,
        suspect_offset: 0,
      });
    if (calls === 6) {
      expect(toolJson(request)).toMatchObject({ text: "", suspects: [] });
      return modelTool("submit_page", { no_change: true });
    }
    throw Error("unexpected-call");
  });
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source, snapshot, f.pages);
    expect(result.complete).toBe(true);
    expect(result.pages[0]!.corrections).toEqual([]);
    expect(calls).toBe(6);
  } finally {
    await runtime.close();
  }
});
it("names each rejected disposition so the model does not resend the same batch", async () => {
  // A real 112-suspect page: one bad id in a batch of 20 drew three identical resends.
  const f = await archiveTextFixture([{ text: "Yield 67%." }], {
    layers: ["Yield 97%."],
  });
  const replies: Record<string, unknown>[] = [];
  let calls = 0;
  const runtime = fakeTextRuntime(async (request) => {
    calls++;
    if (calls > 1) replies.push(toolJson(request));
    return modelTool("put_dispositions", {
      dispositions: [
        {
          suspect_id: "00000000-0000-4000-8000-000000000000",
          status: "draft-correct",
          correction_ids: [],
          reason: "The image shows this text.",
        },
      ],
    });
  });
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source, arranged(f.source), f.pages);
    expect(result.complete).toBe(false);
    expect(replies[0]).toMatchObject({
      accepted: false,
      issues: [
        {
          code: "suspect-disposition-invalid",
          id: "00000000-0000-4000-8000-000000000000",
        },
      ],
      hint: expect.stringContaining("not a current suspect"),
    });
  } finally {
    await runtime.close();
  }
});
it("ends a page with a typed page-tools stop when image rendering fails", async () => {
  const f = await archiveTextFixture([{ text: "Content." }]),
    runtime = fakeTextRuntime(async () =>
      modelTool("view_page", { page_index: 0, region: null }),
    );
  try {
    const result = await new ArchivePageProofreadService(
      runtime,
      {
        ...fakePages(f.pages),
        image: async () => {
          throw Error("synthetic-render-failure");
        },
      },
      memoryTextCache().cache,
    ).build(f.source, arranged(f.source), f.pages);
    expect(result.complete).toBe(false);
    expect(result.pages[0]!.stop).toMatchObject({
      code: "page-tools-unavailable",
      page_index: 0,
      scope: "page",
    });
    expect(result.usage.calls).toBe(1);
  } finally {
    await runtime.close();
  }
});

it("compares retained text with the text layer after removing notation differences", async () => {
  const { comparableTokens } = await import("../src/proofread/suspects.js");
  // Text layer (left) and parser text (right) from a real ACS page, 2026-10-28.
  expect(
    comparableTokens(
      "Over 20 syntheses of sparteine.4 Its antiar-\nrhythmic use (±)-sparteine and η2 binding were sup-\npressed",
    ),
  ).toEqual(
    comparableTokens(
      "Over 20 syntheses of sparteine.$^{4}$ Its antiarrhythmic use $(\\pm)$-sparteine and $\\eta^2$ binding were suppressed",
    ),
  );
  // A real character difference survives.
  expect(comparableTokens("measured 4.2 eV")).not.toEqual(
    comparableTokens("measured 4.7 eV"),
  );
});
