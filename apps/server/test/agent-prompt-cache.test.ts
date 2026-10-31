import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { AnthropicMessagesAdapter } from "../src/agents/anthropic.js";
import { harnessUsage, promptCacheKey } from "../src/agents/common.js";
import { createDshCapabilityRuntime } from "../src/agents/dsh/index.js";
import { DshAgentRuntime } from "../src/agents/dsh/runtime.js";
import {
  OpenAIChatAdapter,
  OpenAIResponsesAdapter,
} from "../src/agents/openai.js";
import {
  AgentFailure,
  validateAgentCall,
  type AgentCall,
  type AgentTransport,
} from "../src/agents/protocol.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { createAgentTransport } from "../src/network/http.js";

const call: AgentCall = {
  role: "analysis",
  messages: [
    {
      role: "system",
      parts: [{ media_type: "text/plain", text: "Answer in JSON." }],
    },
    {
      role: "user",
      parts: [{ media_type: "text/plain", text: "return JSON" }],
    },
  ],
  required_capabilities: ["structured_text"],
  input_sha256: "e".repeat(64),
  max_output_tokens: 10,
  cache_key: promptCacheKey("session-a"),
};
type AgentTransportRequest = Parameters<AgentTransport>[0];
const header = (request: AgentTransportRequest, name: string) =>
  request.headers.find(([key]) => key === name)?.[1];
const body = (request: AgentTransportRequest) =>
  JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
const reply = (value: unknown) => ({
  status: 200,
  headers: [] as const,
  body: new TextEncoder().encode(JSON.stringify(value)),
});

describe("prompt cache routing and accounting", () => {
  it("derives an opaque key per scope and rejects malformed keys", () => {
    const key = promptCacheKey("archive-proofread-1");
    expect(key).toMatch(/^sr-[0-9a-f]{40}$/u);
    expect(key).not.toContain("archive");
    expect(promptCacheKey("archive-proofread-1")).toBe(key);
    expect(promptCacheKey("archive-proofread-2")).not.toBe(key);
    expect(() => validateAgentCall(call)).not.toThrow();
    expect(() =>
      validateAgentCall({ ...call, cache_key: "has spaces" }),
    ).toThrow(AgentFailure);
    expect(() =>
      validateAgentCall({ ...call, cache_key: "x".repeat(65) }),
    ).toThrow(AgentFailure);
  });

  it("sends the Responses cache key and session headers and reads cache usage", async () => {
    let seen: AgentTransportRequest | undefined;
    const adapter = new OpenAIResponsesAdapter({
      provider: "relay",
      model: "model-a",
      endpoint: "https://relay.example.test/v1/responses",
      credential: "secret",
      transport: async (request) => {
        seen = request;
        return reply({
          object: "response",
          status: "completed",
          model: "model-a",
          output: [
            {
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: '{"ok":true}' }],
            },
          ],
          usage: {
            input_tokens: 2778,
            input_tokens_details: {
              cached_tokens: 2560,
              cache_write_tokens: 0,
            },
            output_tokens: 5,
            output_tokens_details: { reasoning_tokens: 2 },
          },
        });
      },
    });
    const result = await adapter.execute(call, {
      reasoning: "default",
      stream: false,
    });
    expect(body(seen!).prompt_cache_key).toBe(call.cache_key);
    expect(header(seen!, "session_id")).toBe(call.cache_key);
    expect(header(seen!, "x-client-request-id")).toBe(call.cache_key);
    expect(result.provenance.usage).toEqual({
      input_tokens: 2778,
      output_tokens: 5,
      cached_input_tokens: 2560,
      cache_write_tokens: 0,
      reasoning_tokens: 2,
    });
    // DSH counts uncached input apart from cache reads and writes.
    expect(harnessUsage(result.provenance.usage)).toEqual({
      inputTokens: 218,
      outputTokens: 5,
      totalTokens: 2783,
      cacheReadTokens: 2560,
      cacheWriteTokens: 0,
      reasoningTokens: 2,
    });
  });

  it("keeps the Chat body portable and reads OpenAI and DeepSeek cache reads", async () => {
    const requests: AgentTransportRequest[] = [];
    const chat = (endpoint: string, usage: unknown) =>
      new OpenAIChatAdapter({
        provider: "chat",
        model: "chat-a",
        endpoint,
        credential: "secret",
        transport: async (request) => {
          requests.push(request);
          return reply({
            model: "chat-a",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: '{"ok":true}' },
              },
            ],
            usage,
          });
        },
      });
    const relay = await chat("https://relay.example.test/v1/chat/completions", {
      prompt_tokens: 100,
      completion_tokens: 4,
      prompt_cache_hit_tokens: 64,
    }).execute(call, { reasoning: "default", stream: false });
    const openai = await chat("https://api.openai.com/v1/chat/completions", {
      prompt_tokens: 100,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 80 },
      completion_tokens_details: { reasoning_tokens: 1 },
    }).execute(call, { reasoning: "default", stream: false });
    expect(body(requests[0]!).prompt_cache_key).toBeUndefined();
    expect(header(requests[0]!, "session_id")).toBe(call.cache_key);
    expect(body(requests[1]!).prompt_cache_key).toBe(call.cache_key);
    expect(relay.provenance.usage).toMatchObject({ cached_input_tokens: 64 });
    expect(openai.provenance.usage).toMatchObject({
      cached_input_tokens: 80,
      reasoning_tokens: 1,
    });
  });

  it("marks Anthropic cache breakpoints and counts cached input in the total", async () => {
    let seen: AgentTransportRequest | undefined;
    const adapter = new AnthropicMessagesAdapter({
      provider: "anthropic",
      model: "claude-a",
      endpoint: "https://api.example.test/v1/messages",
      credential: "secret",
      transport: async (request) => {
        seen = request;
        return reply({
          type: "message",
          role: "assistant",
          model: "claude-a",
          stop_reason: "end_turn",
          content: [{ type: "text", text: '{"ok":true}' }],
          usage: {
            input_tokens: 5,
            output_tokens: 3,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 20,
          },
        });
      },
    });
    const result = await adapter.execute(call, {
      reasoning: "default",
      stream: false,
    });
    const sent = body(seen!) as {
      system: { cache_control?: unknown }[];
      messages: { content: { cache_control?: unknown }[] }[];
    };
    const ephemeral = { type: "ephemeral" };
    expect(sent.system.at(-1)?.cache_control).toEqual(ephemeral);
    expect(sent.messages.at(-1)?.content.at(-1)?.cache_control).toEqual(
      ephemeral,
    );
    expect(header(seen!, "session_id")).toBeUndefined();
    expect(result.provenance.usage).toEqual({
      input_tokens: 125,
      output_tokens: 3,
      cached_input_tokens: 100,
      cache_write_tokens: 20,
    });
  });

  it("gives every request of one DSH session the same key and other sessions their own", async () => {
    const sent: { session: string; key: unknown }[] = [];
    let turn = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk as Uint8Array));
      const parsed = JSON.parse(Buffer.concat(chunks).toString()) as {
        prompt_cache_key?: unknown;
      };
      sent.push({
        session: String(request.headers["session_id"]),
        key: parsed.prompt_cache_key,
      });
      turn++;
      const more = turn % 2 === 1;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: `resp_${turn}`,
          status: "completed",
          model: "model",
          output: more
            ? [
                {
                  type: "function_call",
                  call_id: `call_${turn}`,
                  name: "act",
                  arguments: "{}",
                  status: "completed",
                },
              ]
            : [
                {
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "done" }],
                },
              ],
          usage: { input_tokens: 200, output_tokens: 10 },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const coordinator = new NetworkBudgetCoordinator();
    const model = new DshAgentRuntime([
      {
        role: "browser",
        provider: "fixture",
        model: "model",
        capabilities: ["image_input", "tool_decision"],
        reasoning: "default",
        stream: false,
        context_window_tokens: 128_000,
        max_output_tokens: 4096,
        adapter: new OpenAIResponsesAdapter({
          provider: "fixture",
          model: "model",
          endpoint: `http://127.0.0.1:${port}/responses`,
          credential: null,
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
            limits: {
              maxConcurrency: 1,
              maxHostConcurrency: 1,
              maxResponseBytes: 100_000,
              maxRedirects: 0,
              maxRetries: 0,
            },
          }),
        }),
      },
    ]);
    const runtime = await createDshCapabilityRuntime();
    try {
      for (const id of ["cache-session-a", "cache-session-b"]) {
        const session = await runtime.createSession({
          id,
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
          { parts: [{ media_type: "text/plain", text: "Inspect." }] },
          {
            admitRequest: () => ({ onDispatched() {} }),
            executeTool: async () => ({
              status: "success",
              parts: [{ media_type: "text/plain", text: "ok" }],
            }),
          },
        );
        expect(result.status).toBe("completed");
        await session.close();
      }
    } finally {
      await runtime.close();
      model.close();
      coordinator.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(sent).toHaveLength(4);
    const [a1, a2, b1, b2] = sent;
    expect(a1).toEqual({
      session: promptCacheKey("cache-session-a"),
      key: promptCacheKey("cache-session-a"),
    });
    expect(a2).toEqual(a1);
    expect(b1).toEqual({
      session: promptCacheKey("cache-session-b"),
      key: promptCacheKey("cache-session-b"),
    });
    expect(b2).toEqual(b1);
  });
});
