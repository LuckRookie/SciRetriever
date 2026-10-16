import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createDshCapabilityRuntime } from "../src/agents/dsh/index.js";
import { OpenAIChatAdapter } from "../src/agents/openai.js";
import { AgentRuntime } from "../src/agents/runtime.js";
import { AgentFailure } from "../src/agents/protocol.js";
import type { AgentCapabilityAdmission } from "../src/agents/capability.js";
import { createAgentTransport } from "../src/network/http.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";

describe("DSH shared Network transport", () => {
  it("sends inference, tool continuation and compaction through per-request credentials and real Network dispatch", async () => {
    const bodies: Record<string, unknown>[] = [];
    const authorizations: (string | undefined)[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk as Uint8Array));
      bodies.push(
        JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
      );
      authorizations.push(request.headers.authorization);
      const first = bodies.length === 1;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          model: "model",
          choices: [
            {
              index: 0,
              finish_reason: first ? "tool_calls" : "stop",
              message: first
                ? {
                    role: "assistant",
                    content: "Trying route",
                    tool_calls: [
                      {
                        id: "network-tool",
                        type: "function",
                        function: { name: "act", arguments: "{}" },
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    content:
                      bodies.length === 3
                        ? "Tried route failed; continue the requested goal."
                        : "Recorded the attempted route.",
                  },
            },
          ],
          usage: { prompt_tokens: 200, completion_tokens: 10 },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const coordinator = new NetworkBudgetCoordinator();
    const limits = {
      maxConcurrency: 1,
      maxHostConcurrency: 1,
      maxResponseBytes: 100_000,
      maxRedirects: 0,
      maxRetries: 0,
    };
    let credentials = 0;
    const model = new AgentRuntime([
      {
        role: "browser",
        provider: "fixture",
        model: "model",
        capabilities: ["image_input", "tool_decision"],
        reasoning: "max",
        stream: false,
        context_window_tokens: 128_000,
        max_output_tokens: 4096,
        adapter: new OpenAIChatAdapter({
          provider: "fixture",
          model: "model",
          endpoint: `http://127.0.0.1:${port}/chat/completions`,
          credential: null,
          credentialProvider: async () => {
            credentials++;
            return null;
          },
          transport: createAgentTransport({
            resolver: () => ["127.0.0.1"],
            policy: {
              allowed_schemes: ["http"],
              allowed_classes: ["loopback"],
              allowed_addresses: ["127.0.0.1"],
              allowed_ports: [{ scheme: "http", port }],
            },
            coordinator,
            scope: "dsh-loopback",
            limits,
          }),
        }),
      },
    ]);
    const runtime = await createDshCapabilityRuntime();
    const dispatched: string[] = [];
    const settled: string[] = [];
    const ids: string[] = [];
    let deny = false;
    const admission: AgentCapabilityAdmission = {
      admitRequest: (request) => {
        expect(request.session_id).toBe("network-session");
        ids.push(request.request_id);
        return {
          onDispatched: () => {
            if (deny) throw new AgentFailure("browser-flow-budget-exhausted");
            dispatched.push(request.purpose);
          },
          onSettled: () => {
            settled.push(request.purpose);
          },
        };
      },
    };
    try {
      const session = await runtime.createSession({
        id: "network-session",
        role: "browser",
        input_sha256: "a".repeat(64),
        system: "Use controlled tools.",
        tools: [
          {
            name: "act",
            description: "controlled action",
            parameters: {
              type: "object",
              properties: {},
              required: [],
              additionalProperties: false,
            },
          },
        ],
        modelContext: model.effectiveIdentity("browser"),
        modelCall: (request, signal, lifecycle) =>
          model.executeModel(request, signal, lifecycle),
      });
      const result = await session.run(
        {
          parts: [
            { media_type: "text/plain", text: "Inspect route. ".repeat(500) },
          ],
        },
        {
          ...admission,
          executeTool: async () => ({
            status: "error",
            parts: [
              {
                media_type: "text/plain",
                text: "route not available; continue",
              },
            ],
          }),
        },
      );
      expect({
        status: result.status,
        error_code: result.error_code,
        sent: bodies.length,
      }).toEqual({ status: "completed", error_code: undefined, sent: 2 });
      expect(await session.compact(admission)).toBe(true);
      expect(dispatched).toEqual(["inference", "inference", "compaction"]);
      expect(settled).toEqual(dispatched);
      expect(new Set(ids).size).toBe(3);
      expect(authorizations).toEqual([undefined, undefined, undefined]);
      expect(credentials).toBe(3);
      expect(JSON.stringify(bodies[1]?.messages)).toContain(
        "route not available; continue",
      );
      expect(bodies.every((body) => body.reasoning_effort === "max")).toBe(
        true,
      );
      deny = true;
      const rejected = await session.run(
        { parts: [{ media_type: "text/plain", text: "resume" }] },
        {
          ...admission,
          executeTool: async () => ({ status: "success", parts: [] }),
        },
      );
      expect(rejected).toMatchObject({
        status: "failed",
        error_code: "browser-flow-budget-exhausted",
      });
      expect(bodies).toHaveLength(3);
      expect(dispatched).toHaveLength(3);
      expect(settled).toHaveLength(4);
    } finally {
      await runtime.close();
      model.close();
      coordinator.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
