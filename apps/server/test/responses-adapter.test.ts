import { describe, expect, it } from "vitest";

import { OpenAIResponsesAdapter } from "../src/agents/openai.js";
import type { AgentCall } from "../src/agents/protocol.js";

const call: AgentCall = {
  role: "analysis",
  messages: [
    {
      role: "user",
      parts: [{ media_type: "text/plain", text: "return JSON" }],
    },
  ],
  required_capabilities: ["structured_text"],
  input_sha256: "b".repeat(64),
  max_output_tokens: 10,
};
const response = (body: string, stream = false) => ({
  status: 200,
  headers: [
    ["content-type", stream ? "text/event-stream" : "application/json"],
  ] as const,
  body: new TextEncoder().encode(body),
});

describe("OpenAI Responses adapter", () => {
  it("maps JSON and UTF-8 SSE output to the same neutral result", async () => {
    const json = new OpenAIResponsesAdapter({
      provider: "openai",
      model: "model-a",
      endpoint: "https://api.example.test/v1/responses",
      credential: "secret",
      transport: async ({ headers }) => {
        expect(headers.find(([name]) => name === "authorization")?.[1]).toBe(
          "Bearer secret",
        );
        return response(
          JSON.stringify({
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
            usage: { input_tokens: 2, output_tokens: 3 },
          }),
        );
      },
    });
    const streaming = new OpenAIResponsesAdapter({
      provider: "openai",
      model: "model-a",
      endpoint: "https://api.example.test/v1/responses",
      credential: "secret",
      transport: async () =>
        response(
          'data: {"type":"response.output_text.delta","delta":"{\\"ok\\":"}\n\ndata: {"type":"response.output_text.delta","delta":"true}"}\n\ndata: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"{\\"ok\\":true}"}\n\ndata: {"type":"response.completed","response":{"object":"response","status":"completed","model":"model-a","output":[],"usage":{"input_tokens":2,"output_tokens":3}}}\n\ndata: [DONE]\n',
          true,
        ),
    });
    await expect(
      json.execute(call, { reasoning: "default", stream: false }),
    ).resolves.toMatchObject({ value: { ok: true } });
    await expect(
      streaming.execute(call, { reasoning: "default", stream: true }),
    ).resolves.toMatchObject({ value: { ok: true } });
  });

  it("does not hide a truncated stream as a JSON retry", async () => {
    const adapter = new OpenAIResponsesAdapter({
      provider: "openai",
      model: "model-a",
      endpoint: "https://api.example.test/v1/responses",
      credential: "secret",
      transport: async () =>
        response(
          'data: {"type":"response.output_text.delta","delta":"{}"}\n',
          true,
        ),
    });
    await expect(
      adapter.execute(call, { reasoning: "low", stream: true }),
    ).rejects.toMatchObject({ code: "agent-truncated" });
  });

  it("rejects duplicate response keys before vendor fields are consumed", async () => {
    const adapter = new OpenAIResponsesAdapter({
      provider: "openai",
      model: "model-a",
      endpoint: "https://api.example.test/v1/responses",
      credential: "secret",
      transport: async () =>
        response(
          '{"model":"model-a","model":"model-a","output_text":"{}","usage":{"input_tokens":0,"output_tokens":0}}',
        ),
    });
    await expect(
      adapter.execute(call, { reasoning: "default", stream: false }),
    ).rejects.toMatchObject({ code: "agent-protocol" });
  });

  it("validates structured output against the requested closed schema", async () => {
    const adapter = new OpenAIResponsesAdapter({
      provider: "openai",
      model: "model-a",
      endpoint: "https://api.example.test/v1/responses",
      credential: "secret",
      transport: async () =>
        response(
          JSON.stringify({
            object: "response",
            status: "completed",
            model: "model-a",
            output: [
              {
                type: "message",
                status: "completed",
                role: "assistant",
                content: [
                  { type: "output_text", text: '{"ok":true,"unexpected":1}' },
                ],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ),
    });
    await expect(
      adapter.execute(
        {
          ...call,
          response_schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
        { reasoning: "default", stream: false },
      ),
    ).rejects.toMatchObject({ code: "agent-structured-response" });
  });

  it("maps provider failure, incomplete output, and refusal to stable failures", async () => {
    for (const [event, code] of [
      ["response.failed", "agent-remote"],
      ["response.incomplete", "agent-truncated"],
    ] as const) {
      const adapter = new OpenAIResponsesAdapter({
        provider: "openai",
        model: "model-a",
        endpoint: "https://api.example.test/v1/responses",
        credential: "secret",
        transport: async () =>
          response(
            `data: {"type":"${event}","response":{"model":"model-a","status":"${event === "response.failed" ? "failed" : "incomplete"}"}}\ndata: [DONE]\n`,
            true,
          ),
      });
      await expect(
        adapter.execute(call, { reasoning: "default", stream: true }),
      ).rejects.toMatchObject({ code });
    }
    const refusal = new OpenAIResponsesAdapter({
      provider: "openai",
      model: "model-a",
      endpoint: "https://api.example.test/v1/responses",
      credential: "secret",
      transport: async () =>
        response(
          JSON.stringify({
            model: "model-a",
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "refusal", refusal: "no" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ),
    });
    await expect(
      refusal.execute(call, { reasoning: "default", stream: false }),
    ).rejects.toMatchObject({ code: "agent-refusal" });
  });

  it("rejects a second terminal event and data after the done marker", async () => {
    const adapter = new OpenAIResponsesAdapter({
      provider: "openai",
      model: "model-a",
      endpoint: "https://api.example.test/v1/responses",
      credential: "secret",
      transport: async () =>
        response(
          'data: {"type":"response.completed","response":{"model":"model-a","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\ndata: {"type":"response.completed","response":{"model":"model-a","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\ndata: [DONE]\n',
          true,
        ),
    });
    await expect(
      adapter.execute(call, { reasoning: "default", stream: true }),
    ).rejects.toMatchObject({ code: "agent-protocol" });
  });
});
