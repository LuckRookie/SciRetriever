import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sha256 } from "@sciretriever/contracts";
import { DshAgentRuntime } from "../src/agents/dsh/runtime.js";
import { AgentFailure, type AgentAdapter } from "../src/agents/protocol.js";
import type { ModelResponse } from "../src/agents/model-protocol.js";
import { dshCorrector } from "../src/proofread/correction.js";
import { prepareDraft } from "../src/proofread/draft.js";
import { findSuspects } from "../src/proofread/suspects.js";
import { draftBlocks } from "../src/proofread/apply.js";
import type {
  ProofreadCache,
  PdfPages,
  CorrectionContext,
} from "../src/proofread/contract.js";
import { proofreadFixture } from "./proofread-fixture.js";
const tool = (name: string, args: Record<string, unknown>): ModelResponse => ({
  message: {
    role: "assistant",
    parts: [],
    tool_calls: [
      {
        id: randomUUID(),
        name,
        arguments:
          name === "submit_result" && Array.isArray(args.dispositions)
            ? {
                ...args,
                dispositions: args.dispositions.map(
                  (d: { disposition: unknown }, index: number) => ({
                    suspect_ids: [`q${index}`],
                    disposition: d.disposition,
                  }),
                ),
              }
            : args,
      },
    ],
  },
  stop_reason: "tool_calls",
  provenance: {
    provider: "fixture",
    model: "vision",
    usage: { input_tokens: 13, output_tokens: 7 },
  },
});
function setup(executeModel: NonNullable<AgentAdapter["executeModel"]>) {
  const cache = new Map<
    string,
    { id: string; bytes: Uint8Array; media_type: string }
  >();
  const storage: ProofreadCache = {
    read: async (key) => cache.get(key) ?? null,
    save: async (key, bytes, media_type) => {
      cache.set(key, { id: randomUUID(), bytes, media_type });
      return cache.get(key)!.id;
    },
  };
  const runtime = new DshAgentRuntime([
    {
      role: "proofreading",
      provider: "fixture",
      model: "vision",
      capabilities: ["structured_text", "tool_decision", "image_input"],
      reasoning: "default",
      stream: false,
      context_window_tokens: 1000000,
      max_output_tokens: 4096,
      adapter: {
        provider: "fixture",
        model: "vision",
        execute: async () => {
          throw new Error("Atomic fallback is forbidden");
        },
        executeModel,
      },
    },
  ]);
  const pages: PdfPages = {
    method: "synthetic-pages",
    inspect: async () => [],
    image: async () => ({
      media_type: "image/png",
      data: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      ),
      width: 1,
      height: 1,
    }),
  };
  return { runtime, storage, pages, cache };
}
async function context(): Promise<CorrectionContext> {
  const f = await proofreadFixture("Yield 67%.", "Yield 97%."),
    d = await prepareDraft(f.raw, f.reader, f.pages);
  return {
    asset_id: f.raw.source_asset_id,
    asset_sha256: f.raw.source_sha256,
    page: f.pages[0]!,
    pages: f.pages,
    drafts: d.drafts,
    suspects: findSuspects(
      f.pages,
      draftBlocks(d.drafts, f),
      d.removed,
      d.drafts,
    ),
    resources: [],
  };
}
it("asks the same DSH session to preserve table markup and correct a rejected flattening", async () => {
  const base = await context();
  const original =
    "<table><tr><th>parameter</th><th>hk1</th></tr><tr><td>a = 2.812(2)</td><td>003</td></tr></table>";
  const table = {
    ...base.drafts[0]!,
    type: "table" as const,
    text: "",
    html: original,
  };
  const c = { ...base, drafts: [table], suspects: [] };
  let calls = 0;
  const e = setup(async (request, _options, _signal, lifecycle) => {
    calls++;
    lifecycle?.onDispatched();
    if (calls === 1) {
      expect(JSON.stringify(request.messages)).toContain(
        "preserve all unaffected content verbatim",
      );
      return tool("page_image", { page: 0 });
    }
    if (calls === 3)
      expect(JSON.stringify(request.messages.at(-1))).toContain(
        "proofread-table-format",
      );
    return tool("submit_result", {
      edits: [
        {
          kind: "replace",
          block_id: table.block_id,
          basis_page: 0,
          reason: "Only correct hk1 to hkl; retain the side-cell parameter.",
          text:
            calls === 2
              ? "parameter | hkl\n003"
              : original.replace("hk1", "hkl"),
        },
      ],
      dispositions: [],
      no_body_reason: null,
    });
  });
  try {
    const corrector = (await dshCorrector(e.runtime, e.storage, e.pages, 3))!;
    const result = await corrector.correct(c, 3);
    expect(result.calls).toBe(3);
    expect(result.reason).toBeNull();
    expect(result.submission?.edits[0]).toMatchObject({
      text: original.replace("hk1", "hkl"),
    });
    expect(e.cache.size).toBe(1);
  } finally {
    await e.runtime.close();
  }
});
it("uses one DSH conversation to view images, correct rejected drafts, count tokens and reuse only verified submissions", async () => {
  let calls = 0;
  const c = await context();
  const submission = {
    edits: [
      {
        kind: "replace",
        block_id: c.drafts[0]!.block_id,
        text: "Yield 97%.",
        basis_page: 0,
        reason: "The image shows 97.",
      },
    ],
    dispositions: c.suspects.map((s) => ({
      suspect_id: s.suspect_id,
      disposition: {
        status: "fixed",
        reason: "Read the number in the original image.",
      },
    })),
    no_body_reason: null,
  };
  const e = setup(async (request, _options, _signal, lifecycle) => {
    calls++;
    lifecycle?.onDispatched();
    expect(request.role).toBe("proofreading");
    for (const declaration of request.tools ?? []) {
      const parameters = declaration.parameters;
      expect(new Set(parameters.required as string[])).toEqual(
        new Set(Object.keys(parameters.properties as object)),
      );
    }
    const last = request.messages.at(-1)!;
    if (calls === 1) return tool("submit_result", submission);
    if (calls === 2) {
      expect(JSON.stringify(last)).toContain("proofread-image-not-viewed");
      return tool("page_image", { page: 0 });
    }
    if (calls === 3) {
      expect(last.parts.some((p) => "data" in p)).toBe(true);
      return tool("submit_result", {
        ...submission,
        edits: [
          { kind: "delete", block_id: c.drafts[0]!.block_id, basis_page: 0 },
        ],
      });
    }
    if (calls === 4) {
      expect(JSON.stringify(last)).toContain("result-schema");
      return tool("zoom", { page: 0, region: [0, 0, 1000, 1000] });
    }
    return tool("submit_result", submission);
  });
  try {
    const corrector = (await dshCorrector(e.runtime, e.storage, e.pages, 5))!;
    const a = await corrector.correct(c, 5);
    expect(a).toMatchObject({
      submission,
      reason: null,
      calls: 5,
      input_tokens: 65,
      output_tokens: 35,
    });
    expect(e.cache.size).toBe(1);
    expect(await corrector.correct(c, 0)).toMatchObject({
      submission,
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
    });
    expect(calls).toBe(5);
    const changed = {
      ...c,
      asset_sha256: await sha256(Buffer.from("new PDF")),
    };
    expect(await corrector.correct(changed, 0)).toMatchObject({
      submission: null,
      reason: "correction-budget-exhausted",
      calls: 0,
    });
    expect(calls).toBe(5);
  } finally {
    await e.runtime.close();
  }
}, 20_000);
it("stops at the exact dispatch budget without caching unfinished work", async () => {
  let calls = 0;
  const e = setup(async (_request, _options, _signal, lifecycle) => {
    calls++;
    lifecycle?.onDispatched();
    return tool("page_image", { page: 0 });
  });
  try {
    const c = (await dshCorrector(e.runtime, e.storage, e.pages, 1))!;
    const result = await c.correct(await context(), 1);
    expect(result).toMatchObject({
      submission: null,
      reason: "correction-budget-exhausted",
      calls: 1,
      input_tokens: 13,
      output_tokens: 7,
    });
    expect(calls).toBe(1);
    expect(e.cache.size).toBe(0);
  } finally {
    await e.runtime.close();
  }
}, 20_000);
it("records failed dispatches and never caches provider failure as accepted correction", async () => {
  let calls = 0;
  const e = setup(async (_request, _options, _signal, lifecycle) => {
    calls++;
    lifecycle?.onDispatched();
    throw new AgentFailure("agent-network");
  });
  try {
    const c = (await dshCorrector(e.runtime, e.storage, e.pages, 1))!;
    const result = await c.correct(await context(), 1);
    expect(result.submission).toBeNull();
    expect(result.calls).toBe(1);
    expect(result.reason).toBe("correction-failed");
    expect(calls).toBe(1);
    expect(e.cache.size).toBe(0);
    await expect(
      c.correct(await context(), 1, AbortSignal.abort()),
    ).rejects.toThrow();
  } finally {
    await e.runtime.close();
  }
}, 20_000);

it("continues bounded draft and text-layer reads inside the same conversation", async () => {
  const c = await context(),
    long = "source text ".repeat(4000),
    input = {
      ...c,
      page: { ...c.page, text: long },
      pages: [{ ...c.page, text: long }],
      drafts: [{ ...c.drafts[0]!, text: long }],
    };
  let calls = 0,
    next = 0,
    read = "";
  const e = setup(async (request, _options, _signal, lifecycle) => {
    calls++;
    lifecycle?.onDispatched();
    if (calls === 1) return tool("read_draft", { page: 0 });
    const last = request.messages.at(-1)!;
    if (calls <= 5) {
      const result = JSON.parse(
        last.parts
          .filter((p) => "text" in p)
          .map((p) => ("text" in p ? p.text : ""))
          .join(""),
      );
      expect(result.text.length).toBeLessThanOrEqual(16000);
      read += result.text;
      next = result.next_offset;
      if (next !== null) return tool("read_draft", { page: 0, offset: next });
      expect(JSON.parse(read)[0].text).toBe(long);
      return tool("page_image", { page: 0 });
    }
    return tool("submit_result", {
      edits: [],
      dispositions: c.suspects.map((s) => ({
        suspect_id: s.suspect_id,
        disposition: {
          status: "draft-correct",
          reason: "Original page checked.",
        },
      })),
      no_body_reason: null,
    });
  });
  try {
    expect(
      (
        await (await dshCorrector(e.runtime, e.storage, e.pages, 8))!.correct(
          input,
          8,
        )
      ).submission,
    ).not.toBeNull();
  } finally {
    await e.runtime.close();
  }
});
