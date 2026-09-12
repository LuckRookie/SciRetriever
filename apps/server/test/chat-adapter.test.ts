import { describe, expect, it } from "vitest";
import { OpenAIChatAdapter } from "../src/agents/openai.js";
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
  input_sha256: "c".repeat(64),
  max_output_tokens: 10,
};
describe("OpenAI Chat adapter", () => {
  it("maps a single function tool call and preserves explicit reasoning", async () => {
    let request: Record<string, unknown> | undefined;
    const adapter = new OpenAIChatAdapter({
      provider: "openai",
      model: "chat-a",
      endpoint: "https://api.example.test/v1/chat/completions",
      credential: "secret",
      transport: async ({ body }) => {
        request = JSON.parse(new TextDecoder().decode(body)) as Record<
          string,
          unknown
        >;
        return {
          status: 200,
          headers: [],
          body: new TextEncoder().encode(
            JSON.stringify({
              model: "chat-a",
              choices: [
                {
                  index: 0,
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant",
                    tool_calls: [
                      { function: { name: "select", arguments: '{"id":1}' } },
                    ],
                  },
                },
              ],
              usage: { input_tokens: 1, output_tokens: 2 },
            }),
          ),
        };
      },
    });
    await expect(
      adapter.execute(call, { reasoning: "high", stream: false }),
    ).resolves.toMatchObject({
      kind: "tool",
      name: "select",
      arguments: { id: 1 },
    });
    expect(request?.reasoning_effort).toBe("high");
  });

  it("rejects tool arguments that do not satisfy the closed declaration", async () => {
    const adapter = new OpenAIChatAdapter({
      provider: "openai",
      model: "chat-a",
      endpoint: "https://api.example.test/v1/chat/completions",
      credential: "secret",
      transport: async () => ({
        status: 200,
        headers: [],
        body: new TextEncoder().encode(
          JSON.stringify({
            model: "chat-a",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      function: { name: "select", arguments: '{"extra":1}' },
                    },
                  ],
                },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 2 },
          }),
        ),
      }),
    });
    await expect(
      adapter.execute(
        {
          ...call,
          tools: [
            {
              name: "select",
              description: "Select one record",
              parameters: {
                type: "object",
                properties: { id: { type: "integer" } },
                required: ["id"],
                additionalProperties: false,
              },
            },
          ],
        },
        { reasoning: "default", stream: false },
      ),
    ).rejects.toMatchObject({ code: "agent-tool" });
  });

  it("requires a single finished choice and a separate terminal usage chunk", async () => {
    const adapter = new OpenAIChatAdapter({
      provider: "openai",
      model: "chat-a",
      endpoint: "https://api.example.test/v1/chat/completions",
      credential: "secret",
      transport: async () => ({
        status: 200,
        headers: [],
        body: new TextEncoder().encode(
          [
            'data: {"object":"chat.completion.chunk","model":"chat-a","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
            'data: {"object":"chat.completion.chunk","model":"chat-a","choices":[{"index":0,"delta":{"content":"{}"},"finish_reason":null}]}',
            'data: {"object":"chat.completion.chunk","model":"chat-a","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            'data: {"object":"chat.completion.chunk","model":"chat-a","choices":[],"usage":{"input_tokens":1,"output_tokens":1}}',
            "data: [DONE]",
            "",
          ].join("\n"),
        ),
      }),
    });
    await expect(
      adapter.execute(call, { reasoning: "default", stream: true }),
    ).resolves.toMatchObject({ kind: "structured", value: {} });
  });

  it("rejects content mixed with a streamed tool call", async () => {
    const adapter = new OpenAIChatAdapter({
      provider: "openai",
      model: "chat-a",
      endpoint: "https://api.example.test/v1/chat/completions",
      credential: "secret",
      transport: async () => ({
        status: 200,
        headers: [],
        body: new TextEncoder().encode(
          [
            'data: {"object":"chat.completion.chunk","model":"chat-a","choices":[{"index":0,"delta":{"content":"{}","tool_calls":[{"index":0,"id":"call-1","function":{"name":"select","arguments":"{}"}}]},"finish_reason":null}]}',
            'data: {"object":"chat.completion.chunk","model":"chat-a","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
            'data: {"object":"chat.completion.chunk","model":"chat-a","choices":[],"usage":{"input_tokens":1,"output_tokens":1}}',
            "data: [DONE]",
            "",
          ].join("\n"),
        ),
      }),
    });
    await expect(
      adapter.execute(call, { reasoning: "default", stream: true }),
    ).rejects.toMatchObject({ code: "agent-tool" });
  });

  it("rejects repeated finish reasons and unknown finish reasons", async () => {
    const make = (finish: string) =>
      new OpenAIChatAdapter({
        provider: "openai",
        model: "chat-a",
        endpoint: "https://api.example.test/v1/chat/completions",
        credential: "secret",
        transport: async () => ({
          status: 200,
          headers: [],
          body: new TextEncoder().encode(
            [
              `data: {"object":"chat.completion.chunk","model":"chat-a","choices":[{"index":0,"delta":{"content":"{}"},"finish_reason":"${finish}"}]}`,
              `data: {"object":"chat.completion.chunk","model":"chat-a","choices":[{"index":0,"delta":{},"finish_reason":"${finish}"}]}`,
              'data: {"object":"chat.completion.chunk","model":"chat-a","choices":[],"usage":{"input_tokens":1,"output_tokens":1}}',
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        }),
      });
    await expect(
      make("stop").execute(call, { reasoning: "default", stream: true }),
    ).rejects.toMatchObject({ code: "agent-protocol" });
    await expect(
      make("unknown").execute(call, { reasoning: "default", stream: true }),
    ).rejects.toMatchObject({ code: "agent-protocol" });
  });
});
