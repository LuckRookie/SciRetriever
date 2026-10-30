import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TranslationInputError } from "@sciretriever/contracts";
import { DshAgentRuntime } from "../src/agents/dsh/runtime.js";
import type { AgentCall, AgentResult } from "../src/agents/protocol.js";
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
async function setup(limit?: number) {
  const dir = await mkdtemp(join(tmpdir(), "translation-"));
  dirs.push(dir);
  const calls: AgentCall[] = [];
  const execute =
    (model: string) =>
    async (call: AgentCall): Promise<AgentResult> => {
      calls.push(call);
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
