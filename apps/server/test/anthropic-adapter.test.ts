import { describe, expect, it } from "vitest";
import { AnthropicMessagesAdapter } from "../src/agents/anthropic.js";
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
  input_sha256: "d".repeat(64),
  max_output_tokens: 10,
};
describe("Anthropic Messages adapter", () => {
  it("merges ordered text blocks and usage without exposing vendor objects", async () => {
    const adapter = new AnthropicMessagesAdapter({
      provider: "anthropic",
      model: "claude-a",
      endpoint: "https://api.example.test/v1/messages",
      credential: "secret",
      transport: async () => ({
        status: 200,
        headers: [],
        body: new TextEncoder().encode(
          JSON.stringify({
            type: "message",
            role: "assistant",
            model: "claude-a",
            stop_reason: "end_turn",
            content: [
              { type: "text", text: '{"ok":' },
              { type: "text", text: "true}" },
            ],
            usage: { input_tokens: 2, output_tokens: 3 },
          }),
        ),
      }),
    });
    await expect(
      adapter.execute(call, { reasoning: "default", stream: false }),
    ).resolves.toMatchObject({
      kind: "structured",
      value: { ok: true },
      provenance: { provider: "anthropic", model: "claude-a" },
    });
  });

  it("accepts the explicit Anthropic terminal event without an OpenAI DONE marker", async () => {
    const adapter = new AnthropicMessagesAdapter({
      provider: "anthropic",
      model: "claude-a",
      endpoint: "https://api.example.test/v1/messages",
      credential: "secret",
      transport: async () => ({
        status: 200,
        headers: [],
        body: new TextEncoder().encode(
          [
            'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}',
            'data: {"type":"content_block_start","content_block":{"type":"text"}}',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{}"}}',
            'data: {"type":"content_block_stop"}',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
            'data: {"type":"message_stop"}',
            "",
          ].join("\n"),
        ),
      }),
    });
    await expect(
      adapter.execute(call, { reasoning: "default", stream: true }),
    ).resolves.toMatchObject({ kind: "structured", value: {} });
  });

  it("rejects a delta outside its active block and provider error events", async () => {
    const malformed = new AnthropicMessagesAdapter({
      provider: "anthropic",
      model: "claude-a",
      endpoint: "https://api.example.test/v1/messages",
      credential: "secret",
      transport: async () => ({
        status: 200,
        headers: [],
        body: new TextEncoder().encode(
          'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{}"}}\n',
        ),
      }),
    });
    await expect(
      malformed.execute(call, { reasoning: "default", stream: true }),
    ).rejects.toMatchObject({ code: "agent-protocol" });
    const failed = new AnthropicMessagesAdapter({
      provider: "anthropic",
      model: "claude-a",
      endpoint: "https://api.example.test/v1/messages",
      credential: "secret",
      transport: async () => ({
        status: 200,
        headers: [],
        body: new TextEncoder().encode(
          'data: {"type":"error","error":{"type":"overloaded_error"}}\n',
        ),
      }),
    });
    await expect(
      failed.execute(call, { reasoning: "default", stream: true }),
    ).rejects.toMatchObject({ code: "agent-remote" });
  });
});
