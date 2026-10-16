import { afterEach, describe, expect, it } from "vitest";
import { createDshCapabilityRuntime } from "../src/agents/dsh/index.js";
import type {
  AgentCapabilityRunOptions,
  AgentCapabilityRuntime,
  AgentCapabilitySessionOptions,
} from "../src/agents/capability.js";
import type {
  ModelRequest,
  ModelResponse,
} from "../src/agents/model-protocol.js";
import { validateModelRequest } from "../src/agents/model-protocol.js";
import { AgentFailure, type AgentPart } from "../src/agents/protocol.js";
import { SessionAttachments } from "../src/agents/dsh/attachments.js";

const text = (value: string): AgentPart => ({
  media_type: "text/plain",
  text: value,
});
const input = (value: string) => ({ parts: [text(value)] });
const declaration = {
  name: "act",
  description: "Apply a controlled action",
  parameters: {
    type: "object",
    properties: { action: { type: "string" } },
    required: ["action"],
    additionalProperties: false,
  },
};
const response = (value: string): ModelResponse => ({
  message: { role: "assistant", parts: [text(value)] },
  stop_reason: "complete",
  provenance: {
    provider: "fixture",
    model: "model",
    usage: { input_tokens: 10, output_tokens: 3 },
  },
});
const call = (id: string): ModelResponse => ({
  ...response("Apply action"),
  message: {
    role: "assistant",
    parts: [text("Apply action")],
    tool_calls: [{ id, name: "act", arguments: { action: "click" } }],
  },
  stop_reason: "tool_calls",
});
function options(
  id: string,
  modelCall: AgentCapabilitySessionOptions["modelCall"],
): AgentCapabilitySessionOptions {
  return {
    id,
    role: "browser",
    system: "Use controlled tools to obtain the requested material.",
    input_sha256: "a".repeat(64),
    tools: [declaration],
    image_policy: "latest",
    modelContext: {
      provider: "fixture",
      model: "model",
      context_window_tokens: 128_000,
      max_output_tokens: 4096,
    },
    modelCall,
  };
}
const runOptions = (): AgentCapabilityRunOptions => ({
  admitRequest: () => ({ onDispatched() {} }),
  executeTool: async () => ({ status: "success", parts: [text("clicked")] }),
});
const runtimes: AgentCapabilityRuntime[] = [];
async function runtime() {
  const value = await createDshCapabilityRuntime();
  runtimes.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((value) => value.close()));
});

describe("DSH capability runtime with real published services", () => {
  it("rejects a reused call identity before a second real tool execution", async () => {
    const host = await runtime();
    let applied = 0;
    const session = await host.createSession(
      options("duplicate-call", async () => call("same-call")),
    );
    const turn: AgentCapabilityRunOptions = {
      ...runOptions(),
      executeTool: async (_call, context) => {
        applied++;
        context.concludeTurn();
        return { status: "success", parts: [text("applied")] };
      },
    };
    expect((await session.run(input("first"), turn)).status).toBe("completed");
    expect(await session.run(input("second"), turn)).toMatchObject({
      status: "failed",
      error_code: "agent-response",
      tool_results: [],
    });
    expect(applied).toBe(1);
    expect(
      session.history().filter((message) => message.role === "tool"),
    ).toHaveLength(1);
  });
  it("does not retain a recovered automatic-compaction failure as the next turn outcome", async () => {
    const host = await runtime();
    let compactions = 0;
    let inferences = 0;
    const session = await host.createSession({
      ...options("automatic-compaction", async (request) => {
        if (request.tool_choice === "none") {
          compactions++;
          throw new AgentFailure("agent-provider-failed");
        }
        inferences++;
        return response("Continue using the original history");
      }),
      modelContext: {
        provider: "fixture",
        model: "model",
        context_window_tokens: 2048,
        max_output_tokens: 512,
      },
    });
    await session.run(
      input("Original route observation. ".repeat(600)),
      runOptions(),
    );
    // The real compactor retains the newest complete context span.
    await session.run(
      input("Recent route observation. ".repeat(600)),
      runOptions(),
    );
    const result = await session.run(input("next observation"), runOptions());
    expect([compactions, inferences]).toEqual([1, 3]);
    expect(result.status).toBe("completed");
    expect(JSON.stringify(session.history())).toContain(
      "Original route observation.",
    );
  });
  it("executes a real tool and carries its paired result into the next model request", async () => {
    const host = await runtime();
    const requests: ModelRequest[] = [];
    let dispatched = 0;
    let settled = 0;
    const ids: string[] = [];
    const session = await host.createSession(
      options("article-a", async (request, _signal, lifecycle) => {
        validateModelRequest(request);
        requests.push(request);
        lifecycle.onDispatched();
        return requests.length === 1 ? call("call-a") : response("finished");
      }),
    );
    const result = await session.run(input("inspect article"), {
      ...runOptions(),
      admitRequest: (request) => {
        ids.push(request.request_id);
        expect(request.session_id).toBe("article-a");
        return {
          onDispatched: () => {
            dispatched++;
          },
          onSettled: () => {
            settled++;
          },
        };
      },
    });
    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toContainEqual({
      role: "tool",
      tool_call_id: "call-a",
      name: "act",
      status: "success",
      parts: [text("clicked")],
    });
    expect(session.history()).toHaveLength(5);
    expect([dispatched, settled, new Set(ids).size]).toEqual([2, 2, 2]);
  });

  it("concludes after a complete batch and preserves host rejection of later calls", async () => {
    const host = await runtime();
    let modelCalls = 0;
    let applied = 0;
    const session = await host.createSession(
      options("batch", async () => {
        modelCalls++;
        return {
          ...call("first"),
          message: {
            ...call("first").message,
            tool_calls: [
              { id: "first", name: "act", arguments: { action: "click" } },
              { id: "second", name: "act", arguments: { action: "click" } },
            ],
          },
        };
      }),
    );
    const result = await session.run(input("current observation"), {
      ...runOptions(),
      executeTool: async (_call, context) => {
        context.concludeTurn();
        if (applied)
          return {
            status: "rejected",
            parts: [text("observation already consumed")],
          };
        applied++;
        return { status: "success", parts: [text("actual click completed")] };
      },
    });
    expect(result.status).toBe("completed");
    expect([modelCalls, applied]).toEqual([1, 1]);
    expect(result.tool_results.map((value) => value.status)).toEqual([
      "success",
      "rejected",
    ]);
  });

  it("preserves full history and readable images while projecting only the latest screenshot", async () => {
    const host = await runtime();
    const requests: ModelRequest[] = [];
    const session = await host.createSession(
      options("images", async (request) => {
        requests.push(request);
        return response("ok");
      }),
    );
    const image = (byte: number): AgentPart => ({
      media_type: "image/png",
      data: new Uint8Array([byte]),
      width: 10,
      height: 10,
    });
    await session.run({ parts: [text("first"), image(1)] }, runOptions());
    session.append({
      parts: [text("human instructed a different route")],
      source: "human",
    });
    expect(requests).toHaveLength(1);
    await session.run({ parts: [text("second"), image(2)] }, runOptions());
    const projected = requests[1]?.messages
      .flatMap((message) => message.parts)
      .filter((part) => "data" in part);
    expect(projected).toHaveLength(1);
    expect(projected?.[0]).toMatchObject({ data: new Uint8Array([2]) });
    expect(JSON.stringify(requests[1]?.messages)).toContain("human instructed");
    expect(
      session
        .history()
        .flatMap((message) => message.parts)
        .filter((part) => "data" in part),
    ).toHaveLength(2);
    await session.close();
    expect(() => session.history()).toThrow(AgentFailure);
    await expect(
      session.run(input("closed"), runOptions()),
    ).rejects.toMatchObject({ code: "agent-session-closed" });
  });

  it("runs real compaction through independent admission without deleting original messages", async () => {
    const host = await runtime();
    const requests: ModelRequest[] = [];
    const purposes: string[] = [];
    const session = await host.createSession(
      options("compact", async (request, _signal, lifecycle) => {
        lifecycle.onDispatched();
        validateModelRequest(request);
        requests.push(request);
        return response(
          request.tool_choice === "none"
            ? "Tried old route; it failed. Continue current goal."
            : "Recorded the result.",
        );
      }),
    );
    const admission = {
      admitRequest: (request: { purpose: string }) => {
        purposes.push(request.purpose);
        return { onDispatched() {} };
      },
    };
    await session.run(
      input(`Failed route one. ${"Detailed observation. ".repeat(500)}`),
      { ...runOptions(), ...admission },
    );
    const before = session.history();
    expect(await session.compact(admission)).toBe(true);
    expect(session.history().slice(0, before.length)).toEqual(before);
    await session.run(input("current observation"), {
      ...runOptions(),
      ...admission,
    });
    expect(purposes).toEqual(["inference", "compaction", "inference"]);
    expect(JSON.stringify(requests[2]?.messages)).toContain(
      "Tried old route; it failed",
    );
    expect(JSON.stringify(requests[2]?.messages)).not.toContain(
      "Detailed observation. Detailed observation.",
    );
  });

  it("cancels one concurrent session while its sibling completes and rejects reentry", async () => {
    const host = await runtime();
    let announce: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const a = await host.createSession(
      options("a", async (_request, signal) => {
        announce();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new AgentFailure("agent-cancelled"));
            },
            { once: true },
          );
        });
        return response("late");
      }),
    );
    const b = await host.createSession(
      options("b", async () => response("sibling complete")),
    );
    const stop = new AbortController();
    const runningA = a.run(input("a"), {
      ...runOptions(),
      signal: stop.signal,
    });
    await entered;
    await expect(a.run(input("reentry"), runOptions())).rejects.toMatchObject({
      code: "agent-session-busy",
    });
    const runningB = b.run(input("b"), runOptions());
    stop.abort();
    expect((await runningA).status).toBe("cancelled");
    expect((await runningB).status).toBe("completed");
    expect(JSON.stringify(b.history())).not.toContain('"text":"a"');
  });

  it("rejects attachment cross-scope lookup, changed references and reads after close", () => {
    const a = new SessionAttachments("a");
    const b = new SessionAttachments("b");
    const block = a.store([
      {
        media_type: "image/png",
        width: 10,
        height: 10,
        data: new Uint8Array([1]),
      },
    ])[0];
    if (block?.type !== "image") throw new Error("missing image");
    expect(() => b.read(block.attachment)).toThrow(AgentFailure);
    expect(() => a.read({ ...block.attachment, width: 11 })).toThrow(
      AgentFailure,
    );
    const returned = a.read(block.attachment);
    returned.data[0] = 99;
    expect(a.read(block.attachment).data[0]).toBe(1);
    a.close();
    expect(() => a.read(block.attachment)).toThrow(AgentFailure);
  });

  it("keeps actual tool success when cancellation arrives before the host callback settles", async () => {
    const host = await runtime();
    const requests: ModelRequest[] = [];
    const session = await host.createSession(
      options("tool-cancel", async (request) => {
        validateModelRequest(request);
        requests.push(request);
        return requests.length === 1
          ? call("accepted-tool")
          : response("Observed actual success");
      }),
    );
    const stop = new AbortController();
    const result = await session.run(input("click"), {
      ...runOptions(),
      signal: stop.signal,
      executeTool: async (_call, context) => {
        context.concludeTurn();
        stop.abort();
        await Promise.resolve();
        return {
          status: "success",
          parts: [text("actual_outcome: applied; transfer started")],
        };
      },
    });
    expect(result.status).toBe("cancelled");
    expect(result.tool_results[0]?.status).toBe("success");
    expect(JSON.stringify(result.tool_results)).toContain(
      "actual_outcome: applied",
    );
    await session.run(
      input("transfer failed; inspect current observation"),
      runOptions(),
    );
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      "actual_outcome: applied",
    );
  });

  it("preserves owner admission errors and settles each admitted request", async () => {
    const host = await runtime();
    let settled = 0;
    let sent = 0;
    const session = await host.createSession(
      options("budget", async (_request, _signal, lifecycle) => {
        lifecycle.onDispatched();
        sent++;
        return response("impossible");
      }),
    );
    const result = await session.run(input("inspect"), {
      ...runOptions(),
      admitRequest: () => ({
        onDispatched: () => {
          throw new AgentFailure("browser-flow-budget-exhausted");
        },
        onSettled: () => {
          settled++;
        },
      }),
    });
    expect(result).toMatchObject({
      status: "failed",
      error_code: "browser-flow-budget-exhausted",
    });
    expect([sent, settled]).toEqual([0, 1]);
  });

  it("retains original history after failed compaction and resumes the same session", async () => {
    const host = await runtime();
    const session = await host.createSession(
      options("compact-error", async (request) => {
        if (request.tool_choice === "none")
          throw new AgentFailure("agent-provider-failed");
        return response("normal turn");
      }),
    );
    await session.run(input("Failed route. ".repeat(500)), runOptions());
    const before = session.history();
    await expect(session.compact(runOptions())).rejects.toMatchObject({
      code: "agent-provider-failed",
    });
    expect(session.history()).toEqual(before);
    expect((await session.run(input("resume"), runOptions())).status).toBe(
      "completed",
    );
  });

  it("joins a pending scope creation on runtime close and rejects all later work", async () => {
    const host = await runtime();
    const creating = host.createSession(
      options("starting", async () => response("unused")),
    );
    const closing = host.close();
    const results = await Promise.allSettled([creating, closing]);
    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("fulfilled");
    await expect(
      host.createSession(options("late", async () => response("unused"))),
    ).rejects.toMatchObject({ code: "agent-closed" });
  });

  it("waits for active requests to settle while closing the runtime", async () => {
    const host = await runtime();
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let settled = 0;
    const session = await host.createSession(
      options("closing", async (_request, signal, lifecycle) => {
        lifecycle.onDispatched();
        entered();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new AgentFailure("agent-cancelled"));
            },
            { once: true },
          );
        });
        return response("late");
      }),
    );
    const running = session.run(input("work"), {
      ...runOptions(),
      admitRequest: () => ({
        onDispatched() {},
        onSettled: () => {
          settled++;
        },
      }),
    });
    await started;
    await host.close();
    expect((await running).status).toBe("cancelled");
    expect(settled).toBe(1);
    expect(() => session.history()).toThrow(AgentFailure);
  });

  it("retains adapter continuation through native DSH assistant replay state", async () => {
    const host = await runtime();
    const continuation = {
      provider: "fixture",
      model: "model",
      format: "fixture",
      opaque: { signature: "synthetic-replay-data" },
    };
    const requests: ModelRequest[] = [];
    const session = await host.createSession(
      options("replay", async (request) => {
        requests.push(request);
        if (requests.length === 1)
          return {
            ...call("replay-tool"),
            message: { ...call("replay-tool").message, continuation },
          };
        return response("finished");
      }),
    );
    expect((await session.run(input("start"), runOptions())).status).toBe(
      "completed",
    );
    const assistant = requests[1]?.messages.find(
      (message) => message.role === "assistant",
    );
    expect(assistant?.role === "assistant" && assistant.continuation).toEqual(
      continuation,
    );
  });
});
