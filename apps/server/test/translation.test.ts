import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  TranslationInputError,
  parseRawParse,
  rawParseIdentity,
  sha256,
} from "@sciretriever/contracts";
import { archiveTextFixture } from "./archive-text-fixture.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { DshAgentRuntime } from "../src/agents/dsh/runtime.js";
import {
  AgentFailure,
  type AgentCall,
  type AgentResult,
} from "../src/agents/protocol.js";
import { TranslationCache } from "../src/translation/cache.js";
import {
  TRANSLATION_PROMPT_VERSION,
  TranslationService,
  normalizeTranslationText,
} from "../src/translation/service.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});
async function setup(limit?: number, failure?: AgentFailure) {
  const dir = await mkdtemp(join(tmpdir(), "translation-"));
  dirs.push(dir);
  const calls: AgentCall[] = [];
  const execute =
    (model: string) =>
    async (call: AgentCall): Promise<AgentResult> => {
      calls.push(call);
      if (failure) throw failure;
      const part = call.messages[1]!.parts[0]!;
      return {
        kind: "structured",
        value: { translation: `译:${"text" in part ? part.text : ""}` },
        provenance: {
          provider: "fixture",
          model,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      };
    };
  const runtimes = new Map<string, DshAgentRuntime>();
  const runtime = (reference: string) => {
    let r = runtimes.get(reference);
    if (!r) {
      r = new DshAgentRuntime([
        {
          role: "translation",
          provider: "fixture",
          model: reference,
          capabilities: ["structured_text"],
          reasoning: "medium",
          stream: false,
          context_window_tokens: 100_000,
          max_output_tokens: 10_000,
          adapter: {
            provider: "fixture",
            model: reference,
            execute: execute(reference),
          },
        },
      ]);
      runtimes.set(reference, r);
    }
    return r;
  };
  const path = join(dir, ".sciretriever", "cache", "translations.sqlite");
  const cache = new TranslationCache(path, limit);
  const service = new TranslationService({
    models: ["p/a", "p/b"],
    defaultModel: "p/a",
    runtime,
    cache,
  });
  return { service, cache, calls, path, runtimes };
}
const ask = (text: string, extra: Record<string, unknown> = {}) => ({
  text,
  target_language: "zh-Hans",
  model: null,
  force: false,
  ...extra,
});

it("sends the built-in prompt with the passage once, then answers the same sentence from the cache", async () => {
  const { service, cache, calls } = await setup();
  try {
    const first = await service.translate(
      ask("Hydrogen  evolution\nreaction."),
    );
    expect(first).toEqual({
      translation: "译:Hydrogen evolution reaction.",
      target_language: "zh-Hans",
      model: "p/a",
      cached: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.role).toBe("translation");
    const system = calls[0]!.messages[0]!.parts[0]!;
    expect("text" in system && system.text).toMatch(/Simplified Chinese/u);
    // Whitespace and Unicode width differences still match the same entry.
    const again = await service.translate(
      ask(" Hydrogen evolution reaction． ", { model: "p/b" }),
    );
    expect(again).toMatchObject({ cached: true, model: "p/a" });
    expect(calls).toHaveLength(1);
    // Another language is another entry.
    await service.translate(
      ask("Hydrogen evolution reaction.", { target_language: "ja" }),
    );
    expect(calls).toHaveLength(2);
    // Translating again skips the cache and records the new model.
    const forced = await service.translate(
      ask("Hydrogen evolution reaction.", { model: "p/b", force: true }),
    );
    expect(forced).toMatchObject({ cached: false, model: "p/b" });
    expect(calls).toHaveLength(3);
    expect(
      await service.translate(ask("Hydrogen evolution reaction.")),
    ).toMatchObject({ cached: true, model: "p/b" });
    expect(await cache.size()).toBe(2);
  } finally {
    await cache.close();
  }
});
it("keeps at most the configured number of entries, evicting the one used longest ago, across restarts", async () => {
  const { service, cache, calls, path } = await setup(2);
  try {
    await service.translate(ask("one"));
    await service.translate(ask("two"));
    await service.translate(ask("one")); // "two" is now the least recently used
    await service.translate(ask("three"));
    expect(await cache.size()).toBe(2);
    expect(calls).toHaveLength(3);
  } finally {
    await cache.close();
  }
  const reopened = new TranslationCache(path, 2);
  try {
    const { TranslationService: Service } = await import(
      "../src/translation/service.js"
    );
    const again = new Service({
      models: ["p/a"],
      defaultModel: "p/a",
      runtime: () => {
        throw new Error("no model call expected");
      },
      cache: reopened,
    });
    expect(await again.translate(ask("one"))).toMatchObject({ cached: true });
    expect(await again.translate(ask("three"))).toMatchObject({ cached: true });
    await expect(again.translate(ask("two"))).rejects.toThrow();
  } finally {
    await reopened.close();
  }
});
it("refuses an unregistered model, oversized or malformed input, and never calls a model for them", async () => {
  const { service, cache, calls } = await setup();
  try {
    await expect(
      service.translate(ask("x", { model: "p/unknown" })),
    ).rejects.toMatchObject({
      code: "translation-model-unavailable",
    });
    await expect(
      service.translate(ask("a".repeat(4001))),
    ).rejects.toBeInstanceOf(TranslationInputError);
    await expect(service.translate(ask("  "))).rejects.toBeInstanceOf(
      TranslationInputError,
    );
    await expect(
      service.translate({ ...ask("x"), target_language: "xx" }),
    ).rejects.toBeInstanceOf(TranslationInputError);
    await expect(service.translate({ text: "x" })).rejects.toBeInstanceOf(
      TranslationInputError,
    );
    expect(calls).toHaveLength(0);
    expect(service.catalog()).toMatchObject({
      models: ["p/a", "p/b"],
      default_model: "p/a",
      max_chars: 4000,
    });
    expect(normalizeTranslationText(" a\\u00a0 b ")).toBe(
      "a\\u00a0 b".normalize("NFKC").replace(/\\s+/gu, " "),
    );
    expect(TRANSLATION_PROMPT_VERSION).toBe("translation-v1");
  } finally {
    await cache.close();
  }
});
it("names the model failure behind a failed translation and caches nothing", async () => {
  const { service, cache } = await setup(
    undefined,
    new AgentFailure("agent-auth"),
  );
  try {
    await expect(service.translate(ask("x"))).rejects.toMatchObject({
      code: "translation-failed",
      reason: "agent-auth",
    });
    await expect(
      service.translateBlocks([{ id: "a", text: "x" }], "zh-Hans", null),
    ).rejects.toMatchObject({
      code: "translation-failed",
      reason: "agent-auth",
    });
  } finally {
    await cache.close();
  }
});

async function fullText(
  options: { drop?: (round: number) => boolean; limit?: number } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "fulltext-"));
  dirs.push(dir);
  const calls: AgentCall[] = [];
  let round = 0;
  const execute = async (call: AgentCall): Promise<AgentResult> => {
    calls.push(call);
    round++;
    const part = call.messages[1]!.parts[0]!;
    const items = JSON.parse("text" in part ? part.text : "[]") as {
      id: string;
      text: string;
    }[];
    return {
      kind: "structured",
      value: {
        translations: items
          .filter((_, i) => !(options.drop?.(round) && i === 0))
          .map((i) => ({ id: i.id, translation: `译:${i.text}` })),
      },
      provenance: {
        provider: "fixture",
        model: "p/a",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
  };
  const runtime = new DshAgentRuntime([
    {
      role: "translation",
      provider: "fixture",
      model: "p/a",
      capabilities: ["structured_text"],
      reasoning: "medium",
      stream: false,
      context_window_tokens: 100_000,
      max_output_tokens: 10_000,
      adapter: { provider: "fixture", model: "p/a", execute },
    },
  ]);
  const cache = new TranslationCache(join(dir, "translations.sqlite"));
  const service = new TranslationService({
    models: ["p/a"],
    defaultModel: "p/a",
    runtime: () => runtime,
    cache,
  });
  const blocks = [
    {
      leaf_id: "l1",
      type: "title",
      role: "title",
      region: [80, 130, 910, 180] as const,
      page_index: 0,
      source: "A Title",
    },
    {
      leaf_id: "l2",
      type: "text",
      role: "authors",
      region: [80, 185, 530, 200] as const,
      page_index: 0,
      source: "Ada Author",
    },
    {
      leaf_id: "l3",
      type: "text",
      role: "abstract",
      region: [80, 290, 600, 420] as const,
      page_index: 0,
      source: "Both enantiomers suffered.",
    },
    {
      leaf_id: "l4",
      type: "image",
      role: "abstract",
      region: [600, 290, 900, 390] as const,
      page_index: 0,
      source: "",
    },
    {
      leaf_id: "l7",
      type: "caption",
      role: "abstract",
      region: [600, 290, 900, 390] as const,
      page_index: 0,
      source: "Scheme 1. A caption.",
    },
    {
      leaf_id: "l5",
      type: "reference",
      role: "references",
      region: null,
      page_index: 1,
      source: "(1) Ref.",
    },
    {
      leaf_id: "l6",
      type: "text",
      role: "conclusion",
      region: null,
      page_index: 1,
      source: "In summary, it works.",
    },
  ];
  let source = { page_count: 3, blocks };
  const { FullTextTranslation } = await import(
    "../src/translation/fulltext.js"
  );
  const full = new FullTextTranslation({
    dir: join(dir, "fulltext"),
    translation: service,
    source: async (id) =>
      id === "00000000-0000-4000-8000-000000000001" ? source : null,
    ...(options.limit ? { limit: options.limit } : {}),
  });
  return {
    full,
    calls,
    cache,
    setSource: (next: typeof source) => (source = next),
    blocks,
  };
}
const ID = "00000000-0000-4000-8000-000000000001";
const pageOf = (page_index: number, extra: Record<string, unknown> = {}) => ({
  literature_id: ID,
  page_index,
  target_language: "zh-Hans",
  model: null,
  force: false,
  ...extra,
});

it("translates the primary default draft by raw block type without assigning roles or falling back to an old corrected source", async () => {
  let fixture = await archiveTextFixture([
    { text: "Synthetic title", type: "title" },
    { text: "Ada Author.", type: "text" },
    { text: "A synthetic finding.", type: "text" },
    { text: "[1] Known reference.", type: "reference" },
  ]);
  let parses = 0;
  const f = await coreProcessingFixture({
    offline: true,
    rawParser: {
      identity: async () => ({
        parser_version: fixture.input.parser_version,
        model_identity: fixture.input.model_identity,
        parameters_sha256: fixture.input.parameters_sha256,
      }),
      async parseRaw(request, profile) {
        parses++;
        const privateBytes = Buffer.from("[]");
        const input = {
          ...fixture.input,
          source_asset_id: request.source_asset_id,
          source_sha256: request.source_sha256,
          profile,
          private_content_list: {
            sha256: await sha256(privateBytes),
            byte_size: privateBytes.length,
            media_type: "application/json",
          },
        };
        return {
          result: await parseRawParse({
            ...input,
            ...(await rawParseIdentity(input)),
          }),
          blocks: { artifact: input.blocks!, bytes: fixture.bytes },
          private_content_list: {
            artifact: input.private_content_list,
            bytes: privateBytes,
          },
          markdown: { artifact: input.markdown, bytes: fixture.markdown },
          resources: [],
        };
      },
    },
  });
  try {
    f.setText(fixture.markdown.toString());
    const lit = f.rawParseRequest.literature_id;
    await expect(
      f.app.fullTextTranslation.summary(lit, "zh-Hans"),
    ).rejects.toMatchObject({ code: "translation-not-archived" });
    const receipt = await f.app.documentProcessing.parseDocuments({
      ...f.rawParseRequest,
      profiles: ["vlm-engine"],
    });
    expect(receipt.draft, JSON.stringify(receipt)).toMatchObject({
      status: "formed",
    });
    const pages = vi
      .spyOn(f.app.archiveText!.pdf, "inspect")
      .mockRejectedValue(new Error("Synthetic unavailable page tools"));
    f.setModel((input) => {
      if (!Array.isArray(input))
        throw new Error("Synthetic translation batch expected");
      return {
        translations: input.map((item: { id: string; text: string }) => ({
          id: item.id,
          translation: `译:${item.text}`,
        })),
      };
    });
    expect(
      await f.app.fullTextTranslation.summary(lit, "zh-Hans"),
    ).toMatchObject({ page_count: 1, pages: [{ blocks: 3 }] });
    const result = await f.app.fullTextTranslation.page({
      ...pageOf(0),
      literature_id: lit,
    });
    expect(
      result.blocks.map((block) => [
        block.source,
        block.role,
        block.translation,
      ]),
    ).toEqual([
      ["Synthetic title", "", "译:Synthetic title"],
      ["Ada Author.", "", "译:Ada Author."],
      ["A synthetic finding.", "", "译:A synthetic finding."],
    ]);
    expect(pages).not.toHaveBeenCalled();
    expect(parses).toBe(1);
    expect(f.modelCalls).toBe(1);
    pages.mockRestore();
    // Switching the default to a corrected fixed version still works. The
    // translator must not select an unrelated current proofread instead.
    const proofread = await f.app.proofreading!.build({
      asset_id: f.asset.asset_id,
    });
    await f.app.proofreadDocuments.publish({
      literature_id: lit,
      asset_id: f.asset.asset_id,
      proofread_id: proofread.version.proofread_id,
      expected_default_revision: 1,
    });
    expect(
      await f.app.fullTextTranslation.summary(lit, "zh-Hans"),
    ).toMatchObject({ page_count: 1 });
    fixture = await archiveTextFixture([
      { text: "A newly parsed synthetic finding.", type: "text" },
    ]);
    f.setText(fixture.markdown.toString());
    vi.spyOn(f.app.archiveText!.pdf, "inspect").mockRejectedValue(
      new Error("Synthetic unavailable page tools"),
    );
    await f.app.documentProcessing.parseDocuments({
      ...f.rawParseRequest,
      profiles: ["vlm-engine"],
      force: true,
    });
    // A failed formation after force reparse removes the default. An old
    // corrected source is still stored, but must not be translated implicitly.
    await expect(
      f.app.fullTextTranslation.summary(lit, "zh-Hans"),
    ).rejects.toMatchObject({ code: "translation-not-archived" });
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 60_000);

it("translates a page's own blocks in one request, keeps references, authors and figures, and reuses the saved page", async () => {
  const { full, calls, cache } = await fullText();
  try {
    expect(await full.summary(ID, "zh-Hans")).toMatchObject({
      page_count: 3,
      pages: [
        { page_index: 0, blocks: 3, saved: false },
        { page_index: 1, blocks: 1, saved: false },
        { page_index: 2, blocks: 0, saved: true },
      ],
    });
    const first = await full.page(pageOf(0));
    expect(calls).toHaveLength(1);
    expect(first).toMatchObject({ saved: false, model: "p/a" });
    expect(
      first.blocks.map((b) => [b.leaf_id, b.translation, b.placement]),
    ).toEqual([
      ["l1", "译:A Title", "region"],
      ["l3", "译:Both enantiomers suffered.", "region"],
      // A caption the parser boxed over its figure is placed from the text layer.
      ["l7", "译:Scheme 1. A caption.", "text-layer"],
    ]);
    expect(first.blocks[0]).toMatchObject({
      region: [80, 130, 910, 180],
      placement: "region",
    });
    const again = await full.page(pageOf(0));
    expect(again).toMatchObject({ saved: true });
    expect(calls).toHaveLength(1);
    expect((await full.summary(ID, "zh-Hans")).pages[0]).toMatchObject({
      saved: true,
    });
    // Each block also answers a selection from the sentence cache.
    expect(await cache.size()).toBe(3);
    await expect(
      full.page({
        ...pageOf(0),
        literature_id: "00000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toMatchObject({ code: "translation-not-archived" });
    await expect(full.page(pageOf(9))).rejects.toBeInstanceOf(
      TranslationInputError,
    );
  } finally {
    await cache.close();
  }
});
it("asks once more for a block the answer left out, translates again only a page whose blocks changed, and keeps at most the limit of papers", async () => {
  const { full, calls, cache, setSource, blocks } = await fullText({
    drop: (round) => round === 1,
  });
  try {
    const page = await full.page(pageOf(0));
    // The first answer left out l1; the second request carried only l1.
    expect(calls).toHaveLength(2);
    const second = calls[1]!.messages[1]!.parts[0]!;
    expect(JSON.parse("text" in second ? second.text : "[]")).toEqual([
      { id: "b1", text: "A Title" },
    ]);
    expect(page.blocks.every((b) => b.translation)).toBe(true);
    await full.page(pageOf(1));
    expect(calls).toHaveLength(3);
    setSource({
      page_count: 3,
      blocks: blocks.map((b) =>
        b.leaf_id === "l6" ? { ...b, source: "In summary, it works well." } : b,
      ),
    });
    expect(
      (await full.summary(ID, "zh-Hans")).pages.map((p) => p.saved),
    ).toEqual([true, false, true]);
    expect((await full.page(pageOf(0))).saved).toBe(true);
    expect((await full.page(pageOf(1))).saved).toBe(false);
    expect(calls).toHaveLength(4);
  } finally {
    await cache.close();
  }
  const capped = await fullText({ limit: 1 });
  try {
    await capped.full.page(pageOf(0));
    await capped.full.page(pageOf(0, { target_language: "ja" }));
    // Only the paper-language file used last is kept.
    expect((await capped.full.summary(ID, "ja")).pages[0]).toMatchObject({
      saved: true,
    });
    expect((await capped.full.summary(ID, "zh-Hans")).pages[0]).toMatchObject({
      saved: false,
    });
  } finally {
    await capped.cache.close();
  }
});
