import { expect, it, vi } from "vitest";
import { AgentFailure } from "../src/agents/protocol.js";
import { ArchiveArrangementService } from "../src/archive/arrangement-service.js";
import { ArchivePageProofreadService } from "../src/proofread/page-service.js";
import { ArchiveTextError } from "../src/archive/text-source.js";
import {
  imageContextBytes,
  runArchiveTextSession,
  TextProgress,
  textReply,
  toolDeclaration,
  TEXT_CONTEXT_COMPACTION_BYTES,
} from "../src/archive/text-session.js";
import {
  archiveTextFixture,
  fakePages,
  fakeTextRuntime,
  imageBytes,
  memoryTextCache,
  modelText,
  modelTool,
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
      const runtime = fakeTextRuntime(async () => {
        calls++;
        // ADR 0048: one arrangement request; this paragraph leaves no break candidate.
        if (step === "arrange")
          return modelTool("submit_arrangement", {
            sections: [
              { first: "r1", last: "r1", role: "methods", heading: null },
            ],
            headings: [],
            drops: [],
            captions: [],
            splits: [],
          });
        // ADR 0047: one proofreading request per page.
        return modelTool("submit_corrections", {
          corrections: [],
          uncertain: [],
        });
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
        const expected = 1;
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
/** A one-tool session over the real DSH runtime, for the shared stop rules. */
function session(
  runtime: ReturnType<typeof fakeTextRuntime>,
  execute: Parameters<typeof runArchiveTextSession>[1]["execute"],
  parameters: Record<string, unknown> = {},
) {
  return runArchiveTextSession(runtime, {
    step: "arrange",
    page_index: null,
    input_sha256: "e".repeat(64),
    system: "Synthetic stop-rule regression.",
    initial: { synthetic: true },
    tools: [toolDeclaration("work", "Synthetic work.", parameters)],
    progress: new TextProgress("arrange", null),
    accepted: () => null,
    execute,
  });
}
it("stops the third repeated validation problem set without mislabelling the task as cancelled", async () => {
  let calls = 0;
  const runtime = fakeTextRuntime(async () => {
    calls++;
    return modelTool("work", {});
  });
  try {
    const result = await session(runtime, async () => {
      throw new ArchiveTextError("arrangement-invalid", [
        { code: "leaf-destination-missing", id: null },
      ]);
    });
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
  let calls = 0,
    rejection: Record<string, unknown> | null = null;
  const runtime = fakeTextRuntime(async (request) => {
    calls++;
    if (calls > 1) rejection ??= toolJson(request);
    return modelTool("work", { limit: calls === 1 ? 0 : 20 });
  });
  try {
    await session(
      runtime,
      async () => {
        throw new ArchiveTextError("tool-input");
      },
      {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Number of items, not characters.",
        },
      },
    );
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
  const big = new Uint8Array(600 * 1024);
  let calls = 0;
  const runtime = fakeTextRuntime(async () => {
    calls++;
    return modelTool("work", {});
  });
  try {
    const result = await session(runtime, async () => {
      if (calls >= 4) throw new ArchiveTextError("source-integrity");
      return {
        status: "success",
        parts: [
          { media_type: "image/png", data: big, width: 1000, height: 1400 },
        ],
      };
    });
    expect(result.usage.compaction_calls).toBe(0);
    // A 1000 × 1400 page costs about 1,900 tokens, whatever its encoded size.
    expect(imageContextBytes(1000, 1400)).toBe(7468);
  } finally {
    await runtime.close();
  }
});
it("counts actual dispatches and stops after eight calls with no new evidence or semantic operations", async () => {
  let calls = 0;
  const runtime = fakeTextRuntime(async () => {
    calls++;
    return modelTool("work", {});
  });
  try {
    const result = await session(runtime, async () =>
      textReply({ idle: true }),
    );
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
  let calls = 0;
  const runtime = fakeTextRuntime(async () => {
    calls++;
    return modelTool("not_declared", {});
  });
  try {
    const result = await session(runtime, async () => textReply({}));
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
it("does not treat changed wording, removing/readding a draft or repeating the same evidence as new progress", () => {
  const p = new TextProgress("arrange", null);
  p.beforeCall();
  p.onDispatched();
  p.progress("read", ["a", 0, 20]);
  p.beforeCall();
  for (let i = 0; i < 8; i++) {
    p.onDispatched();
    p.progress("read", ["a", 0, 20]);
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
it("gives a compacted session a fresh no-progress window only after real work", () => {
  // A real 57-suspect page disposed 40 suspects, compacted, and was stopped while
  // re-reading its draft to dispose the last 17.
  const run = (work: boolean) => {
    const p = new TextProgress("proofread", 1);
    const call = () => {
      try {
        p.beforeCall();
        p.onDispatched();
      } catch {
        // The stop is read from state below.
      }
    };
    call();
    if (work) p.progress("dispositions", "s1");
    for (let i = 0; i < 5; i++) call();
    call(); // the compaction request
    p.compacted();
    for (let i = 0; i < 5; i++) call();
    p.finish();
    return p.state.stop?.code ?? null;
  };
  expect(run(true)).toBeNull();
  expect(run(false)).toBe("no-progress");
});
