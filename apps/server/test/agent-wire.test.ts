import { expect, it } from "vitest";
import {
  OpenAIChatAdapter,
  OpenAIResponsesAdapter,
} from "../src/agents/openai.js";
import { AnthropicMessagesAdapter } from "../src/agents/anthropic.js";
import { validateAgentCall, type AgentCall } from "../src/agents/protocol.js";
import type { AdapterConfig } from "../src/agents/common.js";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] } },
  required: ["value"],
};
const call: AgentCall = {
  role: "analysis",
  messages: [
    {
      role: "system",
      parts: [
        { media_type: "text/plain", text: "Return structured evidence." },
      ],
    },
    {
      role: "user",
      parts: [
        { media_type: "application/json", text: '{"source":"fixture"}' },
        {
          media_type: "image/png",
          data: Uint8Array.from([1, 2, 3]),
          width: 1,
          height: 1,
        },
      ],
    },
  ],
  required_capabilities: ["structured_text", "image_input"],
  input_sha256: "a".repeat(64),
  response_schema: schema,
  max_output_tokens: 64,
};
const variants = ["chat", "responses", "anthropic"] as const;
type Variant = (typeof variants)[number];
function make(variant: Variant, config: AdapterConfig) {
  return variant === "chat"
    ? new OpenAIChatAdapter(config)
    : variant === "responses"
      ? new OpenAIResponsesAdapter(config)
      : new AnthropicMessagesAdapter(config);
}
function response(variant: Variant, value: unknown, tool = false) {
  const text = JSON.stringify(value);
  if (variant === "chat")
    return {
      model: "fixture",
      choices: [
        {
          finish_reason: tool ? "tool_calls" : "stop",
          message: tool
            ? {
                tool_calls: [
                  {
                    type: "function",
                    function: { name: "select", arguments: text },
                  },
                ],
              }
            : { content: text },
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    };
  if (variant === "responses")
    return {
      model: "fixture",
      status: "completed",
      output: [
        tool
          ? { type: "function_call", name: "select", arguments: text }
          : { type: "message", content: [{ type: "output_text", text }] },
      ],
      usage: { input_tokens: 2, output_tokens: 3 },
    };
  return {
    model: "fixture",
    content: [
      tool
        ? { type: "tool_use", name: "select", input: value }
        : { type: "text", text },
    ],
    stop_reason: tool ? "tool_use" : "end_turn",
    usage: { input_tokens: 2, output_tokens: 3 },
  };
}
function config(
  variant: Variant,
  value: unknown,
  inspect: (
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ) => void,
  tool = false,
): AdapterConfig {
  return {
    provider: variant,
    model: "fixture",
    endpoint: "https://model.example.test/v1",
    credential: "synthetic-key",
    transport: async (request) => {
      inspect(
        JSON.parse(Buffer.from(request.body).toString()) as Record<
          string,
          unknown
        >,
        Object.fromEntries(request.headers),
      );
      return {
        status: 200,
        headers: [],
        body: Buffer.from(JSON.stringify(response(variant, value, tool))),
      };
    },
  };
}
it.each(variants)(
  "encodes %s schema, image, instruction, token budget and authentication in native wire fields",
  async (variant) => {
    validateAgentCall(call);
    const adapter = make(
      variant,
      config(variant, { value: null }, (body, headers) => {
        expect(body).not.toHaveProperty("response_schema");
        expect(body).not.toHaveProperty("input_sha256");
        expect(body).toHaveProperty("model", "fixture");
        const plain = {
          type: variant === "responses" ? "input_text" : "text",
          text: '{"source":"fixture"}',
        };
        if (variant === "anthropic") {
          expect(headers).toMatchObject({
            "x-api-key": "synthetic-key",
            "anthropic-version": "2023-06-01",
          });
          expect(headers).not.toHaveProperty("authorization");
          expect(body).toMatchObject({
            max_tokens: 64,
            output_config: {
              effort: "high",
              format: { type: "json_schema", schema },
            },
          });
          expect(body.system).toEqual([
            { type: "text", text: "Return structured evidence." },
          ]);
          expect(body.messages).toEqual([
            {
              role: "user",
              content: [
                plain,
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "AQID",
                  },
                },
              ],
            },
          ]);
        } else {
          expect(headers.authorization).toBe("Bearer synthetic-key");
          expect(headers).not.toHaveProperty("x-api-key");
          const content = [
            plain,
            variant === "chat"
              ? {
                  type: "image_url",
                  image_url: { url: "data:image/png;base64,AQID" },
                }
              : {
                  type: "input_image",
                  image_url: "data:image/png;base64,AQID",
                },
          ];
          expect(body[variant === "chat" ? "messages" : "input"]).toEqual([
            {
              role: "system",
              content: [
                {
                  type: variant === "chat" ? "text" : "input_text",
                  text: "Return structured evidence.",
                },
              ],
            },
            { role: "user", content },
          ]);
          if (variant === "chat")
            expect(body).toMatchObject({
              max_completion_tokens: 64,
              reasoning_effort: "high",
              response_format: {
                type: "json_schema",
                json_schema: { strict: true, schema },
              },
            });
          else
            expect(body).toMatchObject({
              max_output_tokens: 64,
              reasoning: { effort: "high" },
              text: { format: { type: "json_schema", strict: true, schema } },
            });
        }
      }),
    );
    await expect(
      adapter.execute(call, { reasoning: "high", stream: false }),
    ).resolves.toMatchObject({
      value: { value: null },
      provenance: { usage: { input_tokens: 2, output_tokens: 3 } },
    });
  },
);
it.each(variants)(
  "encodes %s tool declaration and rejects an invalid anyOf result",
  async (variant) => {
    const { response_schema: parameters, ...base } = call;
    const tool = {
      name: "select",
      description: "Select evidence",
      parameters: parameters!,
    };
    const toolCall = {
      ...base,
      tools: [tool],
      required_capabilities: ["tool_decision" as const],
    };
    validateAgentCall(toolCall);
    const adapter = make(
      variant,
      config(
        variant,
        { value: "chosen" },
        (body) => {
          expect(body.tools).toEqual(
            variant === "chat"
              ? [{ type: "function", function: { ...tool, strict: true } }]
              : variant === "responses"
                ? [{ type: "function", ...tool, strict: true }]
                : [
                    {
                      name: tool.name,
                      description: tool.description,
                      input_schema: schema,
                    },
                  ],
          );
          expect(body.tool_choice).toEqual(
            variant === "anthropic" ? { type: "any" } : "required",
          );
        },
        true,
      ),
    );
    await expect(
      adapter.execute(toolCall, { reasoning: "default", stream: false }),
    ).resolves.toMatchObject({
      kind: "tool",
      name: "select",
      arguments: { value: "chosen" },
    });
    const invalid = make(
      variant,
      config(variant, { value: 5 }, () => {}),
    );
    await expect(
      invalid.execute(call, { reasoning: "default", stream: false }),
    ).rejects.toMatchObject({ code: "agent-structured-response" });
  },
);
it("validates constraints alongside anyOf and rejects an open nested object", async () => {
  const constrained = {
    ...schema,
    properties: {
      value: { anyOf: [{ type: "string" }, { type: "null" }], enum: [null] },
    },
  };
  const c = { ...call, response_schema: constrained };
  validateAgentCall(c);
  await expect(
    make(
      "chat",
      config("chat", { value: "forbidden" }, () => {}),
    ).execute(c, { reasoning: "default", stream: false }),
  ).rejects.toMatchObject({ code: "agent-structured-response" });
  expect(() =>
    validateAgentCall({
      ...call,
      response_schema: {
        ...schema,
        properties: {
          value: { anyOf: [{ type: "object" }, { type: "null" }] },
        },
      },
    }),
  ).toThrow();
});
it("accepts native Chat nullable usage chunks and Responses completion without a DONE marker", async () => {
  for (const variant of ["chat", "responses"] as const) {
    const events =
      variant === "chat"
        ? [
            {
              model: "fixture",
              choices: [
                {
                  index: 0,
                  delta: { content: '{"value":null}' },
                  finish_reason: null,
                },
              ],
              usage: null,
            },
            {
              model: "fixture",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: null,
            },
            {
              model: "fixture",
              choices: [],
              usage: { prompt_tokens: 2, completion_tokens: 3 },
            },
          ]
        : [
            {
              type: "response.completed",
              response: response("responses", { value: null }),
            },
          ];
    const adapter = make(variant, {
      ...config(variant, {}, () => {}),
      transport: async ({ body }) => {
        if (variant === "chat")
          expect(JSON.parse(Buffer.from(body).toString())).toMatchObject({
            stream: true,
            stream_options: { include_usage: true },
          });
        return {
          status: 200,
          headers: [],
          body: Buffer.from(
            events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
              (variant === "chat" ? "data: [DONE]\n\n" : ""),
          ),
        };
      },
    });
    await expect(
      adapter.execute(call, { reasoning: "default", stream: true }),
    ).resolves.toMatchObject({
      value: { value: null },
      provenance: { usage: { input_tokens: 2, output_tokens: 3 } },
    });
  }
});
