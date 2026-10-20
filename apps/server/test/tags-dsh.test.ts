import { expect, it } from "vitest";
import { DshAgentRuntime } from "../src/agents/dsh/runtime.js";
import { dshTagModel } from "../src/tags/model.js";
import type { AgentAdapter, AgentRole } from "../src/agents/protocol.js";
it("routes tagging, consolidation and backfill through the shared DSH foundation and records real adapter tokens", async () => {
  const calls: AgentRole[] = [];
  const adapter: AgentAdapter = {
    provider: "fixture",
    model: "offline",
    async execute(call) {
      calls.push(call.role);
      return {
        kind: "structured",
        value: { synthetic: true },
        provenance: {
          provider: "fixture",
          model: "offline",
          usage: { input_tokens: 13, output_tokens: 7 },
        },
      };
    },
  };
  const runtime = new DshAgentRuntime(
    (["tagging", "tag-consolidation", "tag-backfill"] as const).map((role) => ({
      role,
      provider: "fixture",
      model: "offline",
      capabilities: ["structured_text"],
      reasoning: "default",
      stream: false,
      context_window_tokens: 100000,
      max_output_tokens: 10000,
      adapter,
    })),
  );
  try {
    const model = await dshTagModel(runtime);
    for (const task of ["topics", "select", "consolidate", "backfill"] as const)
      expect((await model.run(task, {})).usage).toEqual({
        calls: 1,
        input_tokens: 13,
        output_tokens: 7,
      });
    expect(calls).toEqual([
      "tagging",
      "tagging",
      "tag-consolidation",
      "tag-backfill",
    ]);
  } finally {
    await runtime.close();
  }
});
