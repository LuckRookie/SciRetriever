import { expect, it, vi } from "vitest";
import { AgentFailure } from "../src/agents/protocol.js";
import { ArchiveArrangementService } from "../src/archive/arrangement-service.js";
import { ArchivePageProofreadService } from "../src/proofread/page-service.js";
import { ArchiveTextError } from "../src/archive/text-source.js";
import {
  boundedTextWindow,
  imageContextBytes,
  runArchiveTextSession,
  TextProgress,
  TextReadCoverage,
  textReply,
  toolDeclaration,
  TEXT_CONTEXT_COMPACTION_BYTES,
  TEXT_TOOL_MAX_BYTES,
} from "../src/archive/text-session.js";
import {
  archiveTextFixture,
  fakePages,
  fakeTextRuntime,
  imageBytes,
  memoryTextCache,
  modelText,
  modelTool,
  assigned,
  arranged,
  toolJson,
} from "./archive-text-fixture.js";

it.each(["arrange", "proofread"] as const)(
  "preserves actual %s usage across cache errors and concurrent checkpoint admission",
  async (step) => {
    const f = await archiveTextFixture([{ text: "Synthetic paragraph." }]);
    for (const conflict of [false, true]) {
      const memory = memoryTextCache();
      let calls = 0;
      const runtime = fakeTextRuntime(async (request) => {
        calls++;
        if (step === "arrange") {
          if (calls === 1)
            return modelTool("read_blocks", { index: 0, offset: 0, limit: 20 });
          if (calls === 2)
            return modelTool("put_operations", {
              operations: assigned(f.source),
            });
          if (calls === 3)
            return modelTool("review_breaks", { offset: 0, limit: 20 });
          return modelTool("submit_operations", {
            reviewed_candidates_sha256:
              toolJson(request).reviewed_candidates_sha256,
          });
        }
        if (calls === 1)
          return modelTool("read_blocks", {
            page_index: 0,
            index: 0,
            offset: 0,
            limit: 20,
          });
        if (calls === 2)
          return modelTool("view_page", { page_index: 0, region: null });
        return modelTool("submit_page", { no_change: true });
      });
      const cache = {
        read: memory.cache.read,
        save: async (...args: Parameters<typeof memory.cache.save>) => {
          if (conflict) await memory.cache.save(...args);
          throw Object.assign(new Error("synthetic cache fault"), {
            code: conflict ? "proofread-cache-conflict" : "cache-write-failed",
          });
        },
      };
      try {
        const build =
          step === "arrange"
            ? new ArchiveArrangementService(
                runtime,
                fakePages(f.pages),
                cache,
              ).build(f.source)
            : new ArchivePageProofreadService(
                runtime,
                fakePages(f.pages),
                cache,
              ).build(f.source, arranged(f.source), f.pages);
        const expected = step === "arrange" ? 4 : 3;
        if (conflict)
          expect((await build).usage).toMatchObject({
            calls: expected,
            input_tokens: expected * 13,
            output_tokens: expected * 7,
          });
        else
          await expect(build).rejects.toMatchObject({
            code: "cache-write-failed",
            output: {
              usage: {
                calls: expected,
                input_tokens: expected * 13,
                output_tokens: expected * 7,
                usage_complete: true,
              },
            },
          });
        expect(calls).toBe(expected);
      } finally {
        await runtime.close();
      }
    }
  },
);
it("bounds encoded JSON windows including escaping, and counts only newly read code points", () => {
  const text = '"\\\n\t😀'.repeat(30000),
    rows = [
      { id: "long", text },
      { id: "empty", text: "" },
    ],
    coverage = new TextReadCoverage();
  let cursor: { index: number; offset: number } | null = {
      index: 0,
      offset: 0,
    },
    restored = "",
    windows = 0;
  while (cursor) {
    const chunk: ReturnType<typeof boundedTextWindow> = boundedTextWindow(
      rows,
      cursor.index,
      cursor.offset,
      20,
      (id, start, end) => coverage.add(id, start, end),
    );
    expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(
      TEXT_TOOL_MAX_BYTES,
    );
    restored += chunk.items.map((i) => i.text).join("");
    cursor = chunk.next;
    windows++;
  }
  expect(restored).toBe(text);
  expect(windows).toBeGreaterThan(2);
  expect(coverage.complete("long", [...text].length)).toBe(true);
  expect(coverage.complete("empty", 0)).toBe(true);
  expect(coverage.add("long", 0, 30)).toBe(false);
  expect(() =>
    boundedTextWindow(rows, 0, [...text].length + 1, 1, () => undefined),
  ).toThrow();
});
it("includes identities in the encoded window budget and never marks an oversized metadata reply as read", () => {
  const read = vi.fn(),
    rows = [{ id: "root", text: '😀"'.repeat(4000) }];
  expect(() =>
    boundedTextWindow(rows, 0, 0, 20, read, () => ({
      identities: "x".repeat(TEXT_TOOL_MAX_BYTES),
    })),
  ).toThrow(ArchiveTextError);
  expect(read).not.toHaveBeenCalled();
  const reply = boundedTextWindow(rows, 0, 0, 20, read, () => ({
    identities: "x".repeat(10000),
  }));
  expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(
    TEXT_TOOL_MAX_BYTES,
  );
  expect(reply.items[0]!.end).toBeGreaterThan(0);
  expect(reply.next).toEqual({ index: 0, offset: reply.items[0]!.end });
  expect(read).toHaveBeenCalledExactlyOnceWith(
    "root",
    0,
    reply.items[0]!.end,
    false,
  );
});
it("stops the third repeated validation problem set without mislabelling the task as cancelled", async () => {
  const f = await archiveTextFixture([{ text: "Untouched." }]);
  let calls = 0;
  const runtime = fakeTextRuntime(async () => {
    calls++;
    return modelTool("review_breaks", { offset: 0, limit: 20 });
  });
  try {
    const result = await new ArchiveArrangementService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source);
    expect(calls).toBe(3);
    expect(result.value).toBeNull();
    expect(result.stop).toMatchObject({
      code: "validation-repeated",
      scope: "part",
      step: "arrange",
      validation: {
        consecutive: 3,
        threshold: 3,
        issue_codes: ["leaf-destination-missing"],
      },
    });
    expect(result.usage).toMatchObject({
      calls: 3,
      input_tokens: 39,
      output_tokens: 21,
    });
  } finally {
    await runtime.close();
  }
});
it("returns the declared schema with an out-of-range argument so a real model can correct it", async () => {
  // A real model read limit as characters (8000); a bare "tool-input" left it guessing.
  // Larger counts are now capped, so a zero count stands in for the out-of-range value.
  const f = await archiveTextFixture([{ text: "Untouched." }]);
  let calls = 0,
    rejection: Record<string, unknown> | null = null;
  const runtime = fakeTextRuntime(async (request) => {
    calls++;
    if (calls === 1)
      return modelTool("read_blocks", { index: 0, offset: 0, limit: 0 });
    rejection ??= toolJson(request);
    return modelTool("read_blocks", { index: 0, offset: 0, limit: 20 });
  });
  try {
    await new ArchiveArrangementService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source);
    expect(rejection).toMatchObject({
      accepted: false,
      issues: [{ code: "tool-input" }],
      expected_arguments: {
        properties: {
          limit: {
            type: "integer",
            description: expect.stringMatching(
              /not characters.*\(value from 1 to 20\)$/u,
            ),
          },
        },
      },
    });
  } finally {
    await runtime.close();
  }
});
it("does not count page-image bytes toward the text compaction window", async () => {
  // A real 4-page paper compacted after its first page view: one image's base64 exceeded the window.
  const f = await archiveTextFixture([{ text: "Untouched." }]);
  const big = new Uint8Array(600 * 1024);
  const pages = {
    ...fakePages(f.pages),
    image: async () => ({
      media_type: "image/png" as const,
      data: big,
      width: 1000,
      height: 1400,
    }),
  };
  let calls = 0;
  const runtime = fakeTextRuntime(async () => {
    calls++;
    return calls < 4
      ? modelTool("view_page", { page_index: 0, region: null })
      : modelTool("review_breaks", { offset: 0, limit: 20 });
  });
  try {
    const result = await new ArchiveArrangementService(
      runtime,
      pages,
      memoryTextCache().cache,
    ).build(f.source);
    expect(result.usage.compaction_calls).toBe(0);
    // A 1000 × 1400 page costs about 1,900 tokens, whatever its encoded size.
    expect(imageContextBytes(1000, 1400)).toBe(7468);
  } finally {
    await runtime.close();
  }
});
it("counts actual dispatches and stops after eight calls with no new evidence or semantic operations", async () => {
  const f = await archiveTextFixture([{ text: "Untouched." }]);
  let calls = 0;
  const runtime = fakeTextRuntime(async () => {
    calls++;
    return modelTool("draft_status", { offset: 0, limit: 20 });
  });
  try {
    const result = await new ArchiveArrangementService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source);
    expect(calls).toBe(8);
    expect(result.stop).toMatchObject({
      code: "no-progress",
      progress: { consecutive_calls: 8, threshold: 8 },
    });
    expect(result.usage.calls).toBe(8);
  } finally {
    await runtime.close();
  }
});
it("also counts native DSH tool rejections toward the three-identical-errors stop", async () => {
  const f = await archiveTextFixture([{ text: "Untouched." }]);
  let calls = 0;
  const runtime = fakeTextRuntime(async () => {
    calls++;
    return modelTool("not_declared", {});
  });
  try {
    const result = await new ArchiveArrangementService(
      runtime,
      fakePages(f.pages),
      memoryTextCache().cache,
    ).build(f.source);
    expect(calls).toBe(3);
    expect(result.stop).toMatchObject({
      code: "validation-repeated",
      validation: { issue_codes: ["tool-input-schema"], consecutive: 3 },
    });
  } finally {
    await runtime.close();
  }
});
it("keeps more than 64 productive calls in one real DSH session, compacts its context and preserves host drafts", async () => {
  let inference = 0,
    compactions = 0,
    maxRequest = 0,
    maxImages = 0,
    afterCompactionBytes = Number.POSITIVE_INFINITY,
    accepted: number | null = null;
  const draft = new Map<number, string>(),
    progress = new TextProgress("arrange", null),
    sizes: number[] = [];
  const runtime = fakeTextRuntime(async (request) => {
    const bytes = Buffer.byteLength(JSON.stringify(request));
    maxRequest = Math.max(maxRequest, bytes);
    sizes.push(bytes);
    expect(request.role).toBe("proofreading");
    expect(request.input_sha256).toBe("e".repeat(64));
    const images = request.messages
      .flatMap((m) => m.parts)
      .filter((p) => "data" in p).length;
    maxImages = Math.max(maxImages, images);
    expect(images).toBeLessThanOrEqual(1);
    if (request.tool_choice === "none") {
      compactions++;
      return modelText(
        "Continue reading new source windows and inspect the host draft with next. Never change source characters.",
      );
    }
    if (compactions)
      afterCompactionBytes = Math.min(afterCompactionBytes, bytes);
    inference++;
    return modelTool("next", { index: inference });
  }, 10000000);
  const create = vi.spyOn(runtime, "createSession");
  try {
    const result = await runArchiveTextSession(runtime, {
      step: "arrange",
      page_index: null,
      input_sha256: "e".repeat(64),
      system: "Synthetic bounded-session regression.",
      initial: { count: 90 },
      tools: [
        toolDeclaration(
          "next",
          "Read the next synthetic source window; host retains all drafts.",
          { index: { type: "integer", minimum: 1 } },
        ),
      ],
      progress,
      accepted: () => accepted,
      execute: async (_name, args, context) => {
        const index = Number(args.index);
        draft.set(index, `source-${index}`);
        progress.progress("new-block", index);
        if (index === 90) {
          expect(draft.size).toBe(90);
          accepted = index;
          context.concludeTurn();
          return textReply({ accepted: true, count: draft.size });
        }
        if (index % 4 === 0)
          return {
            status: "success",
            parts: [
              {
                media_type: "image/png",
                data: imageBytes,
                width: 1,
                height: 1,
              },
            ],
          };
        return textReply({
          id: index,
          text: "Synthetic exact source text. ".repeat(330),
          draft_count: draft.size,
        });
      },
    });
    expect(result.stop).toBeNull();
    expect(result.value).toBe(90);
    expect(create).toHaveBeenCalledTimes(1);
    expect(inference).toBe(90);
    expect(compactions).toBeGreaterThan(0);
    expect(result.usage).toMatchObject({
      calls: inference + compactions,
      compaction_calls: compactions,
      input_tokens: (inference + compactions) * 13,
      output_tokens: (inference + compactions) * 7,
      usage_complete: true,
    });
    expect(maxImages).toBe(1);
    expect(afterCompactionBytes).toBeLessThan(
      TEXT_CONTEXT_COMPACTION_BYTES / 2,
    );
    expect(maxRequest).toBeLessThan(TEXT_CONTEXT_COMPACTION_BYTES + 100 * 1024);
    expect(sizes.length).toBe(result.usage.calls);
  } finally {
    await runtime.close();
  }
}, 30000);
it("does not manufacture token counts after a dispatched failure and keeps cancellation distinct", async () => {
  for (const cancelled of [false, true]) {
    const abort = new AbortController(),
      runtime = fakeTextRuntime(async () => {
        if (cancelled) abort.abort();
        throw new AgentFailure("agent-response");
      });
    try {
      const result = await runArchiveTextSession(
        runtime,
        {
          step: "proofread",
          page_index: 0,
          input_sha256: "e".repeat(64),
          system: "Synthetic page.",
          initial: { page_index: 0 },
          tools: [],
          progress: new TextProgress("proofread", 0),
          accepted: () => null,
          execute: async () => {
            throw new ArchiveTextError("unexpected-tool");
          },
        },
        abort.signal,
      );
      expect(result.usage).toMatchObject({
        calls: 1,
        input_tokens: null,
        output_tokens: null,
        usage_complete: false,
      });
      expect(result.stop?.code).toBe(cancelled ? "cancelled" : "model-failed");
    } finally {
      await runtime.close();
    }
  }
});
it("does not treat changed wording, removing/readding a draft or reading overlapping windows as new progress", () => {
  const p = new TextProgress("arrange", null),
    coverage = new TextReadCoverage();
  p.beforeCall();
  p.onDispatched();
  if (coverage.add("a", 0, 20)) p.progress("read", ["a", 0, 20]);
  p.beforeCall();
  for (let i = 0; i < 8; i++) {
    p.onDispatched();
    if (coverage.add("a", i, 10 + i)) p.progress("read", ["a", i, 10 + i]);
    if (i < 7) p.beforeCall();
  }
  p.finish();
  expect(p.state.stop?.code).toBe("no-progress");
  const q = new TextProgress("arrange", null);
  for (let i = 0; i < 3; i++)
    q.validation(
      [
        { code: "missing", id: "b" },
        { code: "unknown", id: "a" },
      ].reverse(),
    );
  expect(q.state.stop?.validation?.issue_codes).toEqual(["missing", "unknown"]);
});
