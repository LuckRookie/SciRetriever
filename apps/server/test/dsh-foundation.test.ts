import { afterEach, describe, expect, it, vi } from "vitest";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import { promptCacheKey } from "../src/agents/common.js";
import {
  DshAgentRuntime,
  type AgentBinding,
} from "../src/agents/dsh/runtime.js";
import {
  AgentFailure,
  type AgentAdapter,
  type AgentCall,
  type AgentPart,
} from "../src/agents/protocol.js";
import type {
  ModelRequest,
  ModelResponse,
} from "../src/agents/model-protocol.js";
import type {
  AgentCapabilityRunOptions,
  AgentSessionRequest,
} from "../src/agents/capability.js";

const text = (text: string): AgentPart => ({ media_type: "text/plain", text });
const image = (value: number): AgentPart => ({
  media_type: "image/png",
  data: new Uint8Array([value]),
  width: 1,
  height: 1,
});
const provenance = {
  provider: "fixture",
  model: "model",
  usage: { input_tokens: 20, output_tokens: 5 },
};
const reply = (value: string): ModelResponse => ({
  message: { role: "assistant", parts: [text(value)] },
  stop_reason: "complete",
  provenance,
});
const call: AgentCall = {
  role: "analysis",
  messages: [
    {
      role: "user",
      parts: [{ media_type: "application/json", text: '{"paper":"A"}' }],
    },
  ],
  required_capabilities: ["structured_text"],
  input_sha256: "a".repeat(64),
  response_schema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  },
};
const runtimes: DshAgentRuntime[] = [];
function runtime(
  adapter: AgentAdapter,
  capabilities: AgentBinding["capabilities"] = [
    "structured_text",
    "tool_decision",
    "image_input",
  ],
) {
  const value = new DshAgentRuntime([
    {
      role: "analysis",
      provider: "fixture",
      model: "model",
      capabilities,
      reasoning: "high",
      stream: false,
      context_window_tokens: 128_000,
      max_output_tokens: 16_384,
      adapter,
    },
  ]);
  runtimes.push(value);
  return value;
}
function adapter(
  executeModel: NonNullable<AgentAdapter["executeModel"]>,
): AgentAdapter {
  return {
    provider: "fixture",
    model: "model",
    executeModel,
    execute: async () => ({
      kind: "structured",
      value: { answer: "reported" },
      provenance,
    }),
  };
}
const sessionRequest = (id: string): AgentSessionRequest => ({
  id,
  role: "analysis",
  system: "Read fixed material and retain its evidence.",
  input_sha256: "b".repeat(64),
  tools: [],
});
const control = (): AgentCapabilityRunOptions => ({
  admitRequest: () => ({ onDispatched() {} }),
  executeTool: async () => {
    throw new Error("No tools allowed");
  },
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((value) => value.close()));
  vi.restoreAllMocks();
});

describe("one DSH foundation for model calls and application sessions", () => {
  it("fails closed when DSH dispatch fails instead of calling the transport directly", async () => {
    const failure = new Error("fixture DSH dispatch unavailable");
    const native = vi
      .spyOn(LlmRuntime.prototype, "stream")
      .mockImplementation(() => {
        throw failure;
      });
    const transport = adapter(vi.fn(async () => reply("must not run")));
    const singleCall = vi.spyOn(transport, "execute");
    const host = runtime(transport);

    await expect(host.execute(call)).rejects.toMatchObject({
      code: "agent-internal",
      cause: failure,
    });
    await expect(host.executeModel(call)).rejects.toMatchObject({
      code: "agent-internal",
      cause: failure,
    });
    expect(native).toHaveBeenCalledTimes(2);
    expect(singleCall).not.toHaveBeenCalled();
    expect(transport.executeModel).not.toHaveBeenCalled();
  });

  it("routes legacy structured calls and full-history calls through native DSH without changing schema or settings", async () => {
    expect(DshAgentRuntime).toBe(DshAgentRuntime);
    const native = vi.spyOn(LlmRuntime.prototype, "stream");
    const observed: AgentCall[] = [];
    const transport = adapter(async (request) => {
      expect(request.messages[1]).toMatchObject({
        role: "assistant",
        continuation: { format: "fixture" },
      });
      return reply("full-history");
    });
    transport.execute = async (request, options, _signal, lifecycle) => {
      expect(options).toEqual({ reasoning: "high", stream: false });
      observed.push(request);
      lifecycle?.onDispatched();
      return {
        kind: "structured",
        value: { answer: "42 mg, dry only" },
        provenance,
      };
    };
    const host = runtime(transport);
    const dispatched = vi.fn();
    await expect(
      host.execute(call, undefined, { onDispatched: dispatched }),
    ).resolves.toMatchObject({ value: { answer: "42 mg, dry only" } });
    // A single call shares its role's cache route.
    expect(observed[0]).toEqual({
      ...call,
      cache_key: promptCacheKey(`call:${call.role}`),
    });
    expect(dispatched).toHaveBeenCalledTimes(1);
    await host.executeModel({
      ...call,
      messages: [
        ...call.messages,
        {
          role: "assistant",
          parts: [text("read")],
          continuation: {
            provider: "fixture",
            model: "model",
            format: "fixture",
            opaque: { state: "kept" },
          },
        },
        { role: "user", parts: [text("continue")] },
      ],
    });
    expect(native).toHaveBeenCalledTimes(2);
  });

  it("keeps concurrent schemas, all input images and structured outputs isolated", async () => {
    const seen: AgentCall[] = [];
    const transport = adapter(async () => reply("unused"));
    transport.execute = async (request) => {
      seen.push(request);
      await Promise.resolve();
      return {
        kind: "structured",
        value: { answer: request.input_sha256 },
        provenance,
      };
    };
    const host = runtime(transport);
    const second = {
      ...call,
      input_sha256: "c".repeat(64),
      messages: [
        {
          role: "user" as const,
          parts: [text("compare figures"), image(1), image(2)],
        },
      ],
      required_capabilities: ["structured_text", "image_input"] as const,
    };
    const results = await Promise.all([
      host.execute(call),
      host.execute(second),
    ]);
    expect(seen).toEqual(
      [call, second].map((c) => ({
        ...c,
        cache_key: promptCacheKey(`call:${c.role}`),
      })),
    );
    expect(results).toMatchObject([
      { value: { answer: call.input_sha256 } },
      { value: { answer: second.input_sha256 } },
    ]);
  });

  it("runs a pure-text analysis session without requiring image or tool support", async () => {
    const requests: ModelRequest[] = [];
    const host = runtime(
      adapter(async (request) => {
        requests.push(request);
        return reply(
          requests.length === 1
            ? "Only the dry condition improved."
            : "The wet condition did not improve.",
        );
      }),
      ["structured_text"],
    );
    const session = await host.createSession(sessionRequest("text-analysis"));
    expect(
      (
        await session.run(
          { parts: [text("Read dry and wet conditions.")] },
          control(),
        )
      ).status,
    ).toBe("completed");
    expect(
      (
        await session.run(
          { parts: [text("Clarify wet conditions.")] },
          control(),
        )
      ).status,
    ).toBe("completed");
    expect(
      requests.every((request) => request.required_capabilities.length === 0),
    ).toBe(true);
    expect(
      requests[1]?.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.parts.some(
            (part) => "text" in part && part.text.includes("dry condition"),
          ),
      ),
    ).toBe(true);
    expect(requests[1]?.tool_choice).toBe("auto");
  });

  it("supports evidence reading and corrective tool feedback in one analysis conversation", async () => {
    const requests: ModelRequest[] = [];
    const host = runtime(
      adapter(async (request) => {
        requests.push(request);
        if (requests.length === 3)
          return reply("Yield was 42%, only in dry conditions [segment-2].");
        return {
          ...reply(""),
          message: {
            role: "assistant",
            parts: [],
            tool_calls: [
              {
                id: `call-${requests.length}`,
                name:
                  requests.length === 1 ? "read_evidence" : "check_candidate",
                arguments: {},
              },
            ],
          },
          stop_reason: "tool_calls",
        };
      }),
      ["structured_text", "tool_decision"],
    );
    const session = await host.createSession({
      ...sessionRequest("evidence-analysis"),
      tools: ["read_evidence", "check_candidate"].map((name) => ({
        name,
        description: name,
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      })),
    });
    const result = await session.run(
      { parts: [text("Analyze the reported yield.")] },
      {
        ...control(),
        executeTool: async (tool) =>
          tool.name === "read_evidence"
            ? {
                status: "success",
                parts: [text("segment-2: yield 42%, dry only; wet failed.")],
              }
            : {
                status: "error",
                parts: [
                  text(
                    "Candidate omitted dry-only condition; recheck segment-2.",
                  ),
                ],
              },
      },
    );
    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(3);
    expect(
      requests[2]?.messages.filter((message) => message.role === "tool"),
    ).toMatchObject([{ status: "success" }, { status: "error" }]);
    expect(result.message?.parts).toEqual([
      text("Yield was 42%, only in dry conditions [segment-2]."),
    ]);
  });

  it("retains every supplied image by default and rejects images on a text-only binding", async () => {
    const requests: ModelRequest[] = [];
    const host = runtime(
      adapter(async (request) => {
        requests.push(request);
        return reply("observed");
      }),
    );
    const session = await host.createSession(sessionRequest("figures"));
    await session.run({ parts: [text("figure A"), image(1)] }, control());
    await session.run({ parts: [text("compare to B"), image(2)] }, control());
    expect(
      requests[1]?.messages
        .flatMap((message) => message.parts)
        .filter((part) => "data" in part),
    ).toHaveLength(2);
    expect(requests[1]?.required_capabilities).toEqual(["image_input"]);
    let dispatched = false;
    const textOnly = runtime(
      adapter(async () => {
        dispatched = true;
        return reply("invalid");
      }),
      ["structured_text"],
    );
    const rejected = await textOnly.createSession(
      sessionRequest("text-image-rejected"),
    );
    expect(await rejected.run({ parts: [image(3)] }, control())).toMatchObject({
      status: "failed",
      error_code: "agent-capability",
    });
    expect(dispatched).toBe(false);
  });

  it("does not leak another analysis session's history", async () => {
    const requests: ModelRequest[] = [];
    const host = runtime(
      adapter(async (request) => {
        requests.push(request);
        return reply("read");
      }),
      ["structured_text"],
    );
    const a = await host.createSession(sessionRequest("paper-a"));
    const b = await host.createSession(sessionRequest("paper-b"));
    await a.run({ parts: [text("Private paper A context")] }, control());
    await b.run({ parts: [text("Paper B context")] }, control());
    expect(JSON.stringify(requests[1])).not.toContain(
      "Private paper A context",
    );
  });

  it("preserves stable provider failure and cause through the DSH terminal stream", async () => {
    const cause = new Error("fixture connection failed");
    const failure = new AgentFailure("agent-network", true, { cause });
    const transport = adapter(async () => {
      throw failure;
    });
    transport.execute = async () => {
      throw failure;
    };
    const host = runtime(transport);
    await expect(host.execute(call)).rejects.toBe(failure);
    await expect(host.executeModel(call)).rejects.toBe(failure);
  });

  it("cancels and joins an in-flight call before disposing the shared foundation", async () => {
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    let settled = false;
    const transport = adapter(async () => reply("unused"));
    transport.execute = async (_call, _options, signal) => {
      started();
      await new Promise<void>((_resolve, reject) =>
        signal!.addEventListener(
          "abort",
          () => {
            settled = true;
            reject(new AgentFailure("agent-cancelled"));
          },
          { once: true },
        ),
      );
      throw new Error("unreachable");
    };
    const host = runtime(transport);
    const run = host.execute(call);
    const rejected = expect(run).rejects.toMatchObject({
      code: "agent-cancelled",
    });
    await start;
    await host.close();
    await rejected;
    expect(settled).toBe(true);
    await expect(host.execute(call)).rejects.toMatchObject({
      code: "agent-closed",
    });
    await expect(
      host.createSession(sessionRequest("closed")),
    ).rejects.toMatchObject({ code: "agent-closed" });
  });
});
