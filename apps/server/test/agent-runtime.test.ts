import { describe, expect, it } from "vitest";

import { AgentRuntime } from "../src/agents/runtime.js";
import {
  AgentFailure,
  type AgentAdapter,
  type AgentCall,
  validateAgentCall,
} from "../src/agents/protocol.js";

const call: AgentCall = {
  role: "analysis",
  messages: [
    {
      role: "user",
      parts: [{ media_type: "text/plain", text: "return JSON" }],
    },
  ],
  required_capabilities: ["structured_text"],
  input_sha256: "a".repeat(64),
  max_output_tokens: 32,
};
function adapter(): AgentAdapter {
  return {
    provider: "test-provider",
    model: "test-model",
    execute: async () => ({
      kind: "structured",
      value: { ok: true },
      provenance: {
        provider: "test-provider",
        model: "test-model",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
  };
}

describe("provider-neutral agent runtime", () => {
  it("checks role capabilities before adapter I/O and exposes binding identity", async () => {
    let calls = 0;
    const wrapped = adapter();
    const runtime = new AgentRuntime([
      {
        role: "analysis",
        provider: "test-provider",
        model: "test-model",
        capabilities: ["structured_text"],
        reasoning: "default",
        stream: false,
        context_window_tokens: 100,
        max_output_tokens: 32,
        adapter: {
          ...wrapped,
          execute: async (...args) => {
            calls += 1;
            return wrapped.execute(...args);
          },
        },
      },
    ]);
    await expect(runtime.execute(call)).resolves.toMatchObject({
      kind: "structured",
    });
    expect(calls).toBe(1);
    expect(runtime.identity("analysis")).toMatchObject({
      provider: "test-provider",
      model: "test-model",
    });
    await expect(
      runtime.execute({ ...call, required_capabilities: ["tool_decision"] }),
    ).rejects.toMatchObject({ code: "agent-capability" });
    expect(calls).toBe(1);
  });

  it("returns readiness gaps and converts unknown adapter failures", async () => {
    const runtime = new AgentRuntime([
      {
        role: "analysis",
        provider: "p",
        model: "m",
        capabilities: ["structured_text"],
        reasoning: "default",
        stream: true,
        context_window_tokens: 100,
        max_output_tokens: 32,
        adapter: {
          ...adapter(),
          execute: async () => {
            throw new Error("private adapter detail");
          },
        },
      },
    ]);
    expect(runtime.readiness("browser")).toEqual({
      configured: false,
      missing: [],
    });
    await expect(runtime.execute(call)).rejects.toBeInstanceOf(AgentFailure);
    await expect(runtime.execute(call)).rejects.toMatchObject({
      code: "agent-internal",
    });
  });

  it("rejects duplicate tools and non-closed nested schemas before adapter I/O", () => {
    expect(() =>
      validateAgentCall({
        ...call,
        tools: [
          {
            name: "lookup",
            description: "lookup",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: {
                query: {
                  type: "string",
                  additionalProperties: false,
                },
              },
              required: ["query"],
            },
          },
          {
            name: "lookup",
            description: "duplicate",
            parameters: { type: "object", additionalProperties: false },
          },
        ],
      }),
    ).toThrow(AgentFailure);
    expect(() =>
      validateAgentCall({
        ...call,
        response_schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            nested: {
              type: "object",
              additionalProperties: true,
            },
          },
        },
      }),
    ).toThrow(AgentFailure);
  });
});
