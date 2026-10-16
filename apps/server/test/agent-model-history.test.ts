import { describe, expect, it } from "vitest";
import {
  OpenAIChatAdapter,
  OpenAIResponsesAdapter,
} from "../src/agents/openai.js";
import { AnthropicMessagesAdapter } from "../src/agents/anthropic.js";
import { type AdapterConfig } from "../src/agents/common.js";
import {
  type ModelRequest,
  type ModelMessage,
  validateModelRequest,
} from "../src/agents/model-protocol.js";
import { AgentRuntime } from "../src/agents/runtime.js";
import {
  type AgentCall,
  type AgentTransportResponse,
} from "../src/agents/protocol.js";

const variants = ["chat", "responses", "anthropic"] as const;
type Variant = (typeof variants)[number];
const model = "qiuzk/gpt-6-luna";
const parameters = {
  type: "object",
  properties: { target: { type: "string" } },
  required: ["target"],
  additionalProperties: false,
};
const request: ModelRequest = {
  role: "browser",
  input_sha256: "a".repeat(64),
  required_capabilities: ["tool_decision", "image_input"],
  max_output_tokens: 128,
  messages: [
    {
      role: "system",
      parts: [
        { media_type: "text/plain", text: "Inspect the current article." },
      ],
    },
    {
      role: "user",
      parts: [{ media_type: "text/plain", text: "Find the PDF." }],
    },
  ],
  tools: [
    { name: "inspect", description: "Inspect current observation", parameters },
  ],
};
const tools = [
  { id: "call_1", name: "inspect", arguments: { target: "first" } },
  { id: "call_2", name: "inspect", arguments: { target: "second" } },
];
function make(variant: Variant, config: AdapterConfig) {
  return variant === "chat"
    ? new OpenAIChatAdapter(config)
    : variant === "responses"
      ? new OpenAIResponsesAdapter(config)
      : new AnthropicMessagesAdapter(config);
}
function response(
  variant: Variant,
  withTools = true,
  withText = true,
): Record<string, unknown> {
  const text = withText
    ? withTools
      ? "I will inspect these references."
      : "The requested material is ready."
    : "";
  if (variant === "chat")
    return {
      model,
      choices: [
        {
          index: 0,
          finish_reason: withTools ? "tool_calls" : "stop",
          message: {
            role: "assistant",
            content: text || null,
            ...(withTools
              ? {
                  tool_calls: tools.map((tool) => ({
                    id: tool.id,
                    type: "function",
                    function: {
                      name: tool.name,
                      arguments: JSON.stringify(tool.arguments),
                    },
                  })),
                }
              : {}),
          },
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    };
  if (variant === "responses")
    return {
      model,
      status: "completed",
      output: [
        ...(text
          ? [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text }],
              },
            ]
          : []),
        ...(withTools
          ? tools.map((tool) => ({
              type: "function_call",
              id: `item_${tool.id}`,
              call_id: tool.id,
              name: tool.name,
              arguments: JSON.stringify(tool.arguments),
            }))
          : []),
      ],
      usage: { input_tokens: 7, output_tokens: 3 },
    };
  return {
    model,
    type: "message",
    role: "assistant",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...(withTools
        ? tools.map((tool) => ({
            type: "tool_use",
            id: tool.id,
            name: tool.name,
            input: tool.arguments,
          }))
        : []),
    ],
    stop_reason: withTools ? "tool_use" : "end_turn",
    usage: { input_tokens: 7, output_tokens: 3 },
  };
}
function encode(value: Record<string, unknown>): AgentTransportResponse {
  return { status: 200, headers: [], body: Buffer.from(JSON.stringify(value)) };
}
function withContinuation(variant: Variant): Record<string, unknown> {
  const value = response(variant);
  if (variant === "responses")
    (value.output as unknown[]).unshift({
      type: "reasoning",
      id: "reasoning_1",
      summary: [],
      encrypted_content: "synthetic-encrypted-reasoning",
    });
  else if (variant === "anthropic")
    (value.content as unknown[]).unshift({
      type: "thinking",
      thinking: "synthetic reasoning",
      signature: "synthetic-signature",
    });
  else
    (
      value.choices as { message: Record<string, unknown> }[]
    )[0]!.message.reasoning_content = "synthetic reasoning";
  return value;
}
function streamResponse(
  variant: Variant,
  withTools = true,
  replay = false,
  valueOverride?: Record<string, unknown>,
): AgentTransportResponse {
  const value =
    valueOverride ??
    (replay ? withContinuation(variant) : response(variant, withTools));
  const events: Record<string, unknown>[] = [];
  if (variant === "chat") {
    events.push({
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            ...(replay ? { reasoning_content: "synthetic reasoning" } : {}),
            content: withTools
              ? "I will inspect these references."
              : "The requested material is ready.",
          },
          finish_reason: null,
        },
      ],
    });
    if (withTools) {
      events.push({
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: tools.map((tool, index) => ({
                index,
                id: tool.id,
                type: "function",
                function: { name: tool.name, arguments: '{"target":' },
              })),
            },
            finish_reason: null,
          },
        ],
      });
      events.push({
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: tools.map((tool, index) => ({
                index,
                function: {
                  arguments: `${JSON.stringify(tool.arguments.target)}}`,
                },
              })),
            },
            finish_reason: null,
          },
        ],
      });
    }
    events.push(
      {
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: withTools ? "tool_calls" : "stop",
          },
        ],
      },
      { choices: [], usage: value.usage },
    );
  } else if (variant === "responses") {
    for (const [index, item] of (value.output as unknown[]).entries())
      events.push({
        type: "response.output_item.done",
        output_index: index,
        item,
      });
    events.push({
      type: "response.completed",
      response: { ...value, output: [] },
    });
  } else {
    events.push({
      type: "message_start",
      message: {
        model,
        role: "assistant",
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    });
    for (const [index, block] of (
      value.content as Record<string, unknown>[]
    ).entries()) {
      const tool = block.type === "tool_use";
      if (block.type === "thinking") {
        events.push(
          {
            type: "content_block_start",
            index,
            content_block: { type: "thinking", thinking: "" },
          },
          {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking: block.thinking },
          },
          {
            type: "content_block_delta",
            index,
            delta: { type: "signature_delta", signature: block.signature },
          },
          { type: "content_block_stop", index },
        );
        continue;
      }
      events.push({
        type: "content_block_start",
        index,
        content_block: tool
          ? { ...block, input: {} }
          : { type: "text", text: "" },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: tool
          ? {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            }
          : { type: "text_delta", text: block.text },
      });
      events.push({ type: "content_block_stop", index });
    }
    events.push(
      {
        type: "message_delta",
        delta: { stop_reason: withTools ? "tool_use" : "end_turn" },
        usage: { output_tokens: 3 },
      },
      { type: "message_stop" },
    );
  }
  return {
    status: 200,
    headers: [["content-type", "text/event-stream"]],
    body: Buffer.from(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
        (variant === "chat" ? "data: [DONE]\n\n" : ""),
    ),
  };
}
function createRuntime(
  variant: Variant,
  transport: AdapterConfig["transport"],
  stream = false,
) {
  const adapter = make(variant, {
    provider: "synthetic",
    model,
    endpoint: "http://model.example.test/v1",
    credential: null,
    transport,
  });
  return new AgentRuntime([
    {
      role: "browser",
      provider: "synthetic",
      model,
      capabilities: ["image_input", "tool_decision", "structured_text"],
      reasoning: "max",
      stream,
      context_window_tokens: 4096,
      max_output_tokens: 128,
      adapter,
    },
  ]);
}

describe.each(variants)("%s complete internal model history", (variant) => {
  it.each([false, true])(
    "round trips text, multiple calls, native IDs and image results (stream=%s)",
    async (stream) => {
      const bodies: Record<string, unknown>[] = [];
      let dispatches = 0;
      const runtime = createRuntime(
        variant,
        async (wire) => {
          wire.onDispatched?.();
          bodies.push(
            JSON.parse(Buffer.from(wire.body).toString()) as Record<
              string,
              unknown
            >,
          );
          return stream
            ? streamResponse(variant, bodies.length === 1)
            : encode(response(variant, bodies.length === 1));
        },
        stream,
      );
      try {
        const first = await runtime.executeModel(request, undefined, {
          onDispatched: () => dispatches++,
        });
        expect(first.message.tool_calls).toEqual(tools);
        expect(first.message.parts).toEqual([
          {
            media_type: "text/plain",
            text: "I will inspect these references.",
          },
        ]);
        expect(first.provenance.usage).toEqual({
          input_tokens: 7,
          output_tokens: 3,
        });
        const history: ModelMessage[] = [
          ...request.messages,
          first.message,
          {
            role: "tool",
            tool_call_id: "call_1",
            name: "inspect",
            status: "success",
            parts: [
              { media_type: "text/plain", text: "First result." },
              {
                media_type: "image/png",
                data: Uint8Array.from([1, 2, 3]),
                width: 1,
                height: 1,
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_2",
            name: "inspect",
            status: "rejected",
            parts: [
              {
                media_type: "text/plain",
                text: "Observation already consumed.",
              },
            ],
          },
        ];
        const second = await runtime.executeModel(
          { ...request, messages: history },
          undefined,
          { onDispatched: () => dispatches++ },
        );
        expect(second.stop_reason).toBe("complete");
        expect(second.message.parts).toEqual([
          {
            media_type: "text/plain",
            text: "The requested material is ready.",
          },
        ]);
        expect(dispatches).toBe(2);
        const body = bodies[1]!;
        expect(body.model).toBe(model);
        expect(body.stream).toBe(stream ? true : undefined);
        expect(JSON.stringify(body)).not.toContain("input_sha256");
        if (variant === "chat") {
          expect(body.reasoning_effort).toBe("max");
          expect(body.tool_choice).toBe("auto");
          const messages = body.messages as Record<string, unknown>[];
          expect(messages[2]).toMatchObject({
            role: "assistant",
            tool_calls: tools.map((tool) => ({
              id: tool.id,
              function: {
                name: tool.name,
                arguments: JSON.stringify(tool.arguments),
              },
            })),
          });
          expect(messages.slice(3, 5).map((item) => item.role)).toEqual([
            "tool",
            "tool",
          ]);
          expect(messages[4]).toMatchObject({ tool_call_id: "call_2" });
          expect(String(messages[4]?.content)).toContain('"status":"rejected"');
          expect(messages[5]).toMatchObject({
            role: "user",
            content: [
              expect.anything(),
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AQID" },
              },
            ],
          });
        } else if (variant === "responses") {
          expect(body.reasoning).toEqual({ effort: "max" });
          expect(body.tool_choice).toBe("auto");
          const input = body.input as Record<string, unknown>[];
          expect(input.filter((item) => item.type === "function_call")).toEqual(
            tools.map((tool) => ({
              type: "function_call",
              id: `item_${tool.id}`,
              call_id: tool.id,
              name: tool.name,
              arguments: JSON.stringify(tool.arguments),
            })),
          );
          expect(
            input
              .filter((item) => item.type === "function_call_output")
              .map((item) => item.call_id),
          ).toEqual(["call_1", "call_2"]);
          expect(JSON.stringify(input)).toContain(
            '"image_url":"data:image/png;base64,AQID"',
          );
        } else {
          expect(body.output_config).toEqual({ effort: "max" });
          expect(body.tool_choice).toEqual({ type: "auto" });
          const messages = body.messages as Record<string, unknown>[];
          expect(messages[1]).toMatchObject({
            role: "assistant",
            content: [
              expect.anything(),
              ...tools.map((tool) => ({
                type: "tool_use",
                id: tool.id,
                name: tool.name,
                input: tool.arguments,
              })),
            ],
          });
          expect(messages[2]).toMatchObject({
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_1", is_error: false },
              { type: "tool_result", tool_use_id: "call_2", is_error: true },
            ],
          });
          expect(JSON.stringify(messages[2])).toContain(
            '"media_type":"image/png"',
          );
        }
      } finally {
        runtime.close();
      }
    },
  );

  it.each([false, true])(
    "replays provider continuation without exposing it as prompt text (stream=%s)",
    async (stream) => {
      const bodies: Record<string, unknown>[] = [];
      const runtime = createRuntime(
        variant,
        async (wire) => {
          bodies.push(
            JSON.parse(Buffer.from(wire.body).toString()) as Record<
              string,
              unknown
            >,
          );
          return stream
            ? streamResponse(variant, bodies.length === 1, bodies.length === 1)
            : encode(
                bodies.length === 1
                  ? withContinuation(variant)
                  : response(variant, false),
              );
        },
        stream,
      );
      try {
        const first = await runtime.executeModel(request);
        expect(first.message.continuation).toMatchObject({
          provider: "synthetic",
          model,
        });
        const results: ModelMessage[] = tools.map((tool) => ({
          role: "tool",
          tool_call_id: tool.id,
          name: tool.name,
          status: "success",
          parts: [],
        }));
        await runtime.executeModel({
          ...request,
          messages: [...request.messages, first.message, ...results],
        });
        const next = bodies[1]!;
        expect(JSON.stringify(next)).not.toContain('"continuation"');
        if (variant === "responses") {
          expect(next.include).toEqual(["reasoning.encrypted_content"]);
          expect((next.input as unknown[])[2]).toMatchObject({
            type: "reasoning",
            id: "reasoning_1",
            encrypted_content: "synthetic-encrypted-reasoning",
          });
        } else if (variant === "anthropic")
          expect(
            (next.messages as { content: unknown[] }[])[1]!.content[0],
          ).toEqual({
            type: "thinking",
            thinking: "synthetic reasoning",
            signature: "synthetic-signature",
          });
        else
          expect((next.messages as unknown[])[2]).toMatchObject({
            reasoning_content: "synthetic reasoning",
          });
        await expect(
          runtime.executeModel({
            ...request,
            messages: [
              ...request.messages,
              {
                ...first.message,
                continuation: {
                  ...first.message.continuation!,
                  model: "other",
                },
              },
              ...results,
            ],
          }),
        ).rejects.toMatchObject({ code: "agent-model-mismatch" });
        expect(bodies).toHaveLength(2);
      } finally {
        runtime.close();
      }
    },
  );

  it("rejects missing and duplicate IDs and malformed arguments", async () => {
    for (const corruption of ["missing", "duplicate", "arguments"] as const) {
      const value = response(variant, true, false);
      if (variant === "chat") {
        const items = (
          value.choices as {
            message: { tool_calls: Record<string, unknown>[] };
          }[]
        )[0]!.message.tool_calls;
        if (corruption === "missing") delete items[0]!.id;
        else if (corruption === "duplicate") items[1]!.id = items[0]!.id;
        else
          (items[0]!.function as Record<string, unknown>).arguments =
            '{"target":3}';
      } else if (variant === "responses") {
        const items = value.output as Record<string, unknown>[];
        if (corruption === "missing") delete items[0]!.call_id;
        else if (corruption === "duplicate")
          items[1]!.call_id = items[0]!.call_id;
        else items[0]!.arguments = '{"target":3}';
      } else {
        const items = value.content as Record<string, unknown>[];
        if (corruption === "missing") delete items[0]!.id;
        else if (corruption === "duplicate") items[1]!.id = items[0]!.id;
        else items[0]!.input = { target: 3 };
      }
      const runtime = createRuntime(variant, async () => encode(value));
      try {
        await expect(runtime.executeModel(request)).rejects.toMatchObject({
          code: "agent-tool",
        });
      } finally {
        runtime.close();
      }
    }
  });

  it("keeps legacy results strict while allowing ordinary text internally", async () => {
    let value = response(variant, false);
    const runtime = createRuntime(variant, async () => encode(value));
    const legacy: AgentCall = {
      ...request,
      messages: request.messages as AgentCall["messages"],
    };
    try {
      await expect(runtime.executeModel(request)).resolves.toMatchObject({
        stop_reason: "complete",
      });
      await expect(runtime.execute(legacy)).rejects.toMatchObject({
        code: "agent-structured-response",
      });
      value = response(variant, true, false);
      await expect(runtime.execute(legacy)).rejects.toMatchObject({
        code: "agent-tool",
      });
    } finally {
      runtime.close();
    }
  });

  it("does not accept incomplete streamed turns", async () => {
    const complete = streamResponse(variant);
    const source = Buffer.from(complete.body).toString();
    const truncated = source.split("\n\n").slice(0, -2).join("\n\n") + "\n\n";
    const runtime = createRuntime(
      variant,
      async () => ({ ...complete, body: Buffer.from(truncated) }),
      true,
    );
    try {
      await expect(runtime.executeModel(request)).rejects.toMatchObject({
        code: "agent-truncated",
      });
    } finally {
      runtime.close();
    }
  });
});

it("rejects dangling, repeated and mismatched tool results before any dispatch", () => {
  const assistant: ModelMessage = {
    role: "assistant",
    parts: [],
    tool_calls: tools,
  };
  const result: ModelMessage = {
    role: "tool",
    tool_call_id: "call_1",
    name: "inspect",
    status: "success",
    parts: [],
  };
  const histories: readonly ModelMessage[][] = [
    [...request.messages, result],
    [...request.messages, assistant, result],
    [...request.messages, assistant, result, result],
    [...request.messages, assistant, { ...result, name: "other" }],
    [...request.messages, { ...assistant, tool_calls: [tools[0]!, tools[0]!] }],
    [
      ...request.messages,
      {
        ...assistant,
        tool_calls: [{ ...tools[0]!, arguments: { invalid: NaN } }],
      },
    ],
  ];
  for (const messages of histories)
    expect(() => validateModelRequest({ ...request, messages })).toThrowError(
      expect.objectContaining({ code: "agent-input" }),
    );
});

it("applies the existing runtime capability, cancellation, close and usage boundaries to model requests", async () => {
  let sends = 0;
  const runtime = createRuntime("chat", async (wire) => {
    sends++;
    wire.onDispatched?.();
    return encode(response("chat", false));
  });
  try {
    await expect(
      runtime.executeModel({ ...request, max_output_tokens: 129 }),
    ).rejects.toMatchObject({ code: "agent-capability" });
    await expect(
      runtime.executeModel(request, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "agent-cancelled" });
    expect(sends).toBe(0);
    runtime.close();
    await expect(runtime.executeModel(request)).rejects.toMatchObject({
      code: "agent-closed",
    });
  } finally {
    runtime.close();
  }
});

it.each([
  ["responses", false],
  ["responses", true],
  ["anthropic", false],
  ["anthropic", true],
] as const)(
  "preserves interleaved %s native output exactly and binds replay to its assistant projection (stream=%s)",
  async (variant, stream) => {
    const value = withContinuation(variant);
    const original = (
      variant === "responses" ? value.output : value.content
    ) as Record<string, unknown>[];
    const secondReasoning =
      variant === "responses"
        ? {
            type: "reasoning",
            id: "reasoning_2",
            summary: [],
            encrypted_content: "synthetic-second-encrypted-reasoning",
          }
        : {
            type: "thinking",
            thinking: "second synthetic reasoning",
            signature: "second-synthetic-signature",
          };
    const secondText =
      variant === "responses"
        ? {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Second explanation after the first tool call.",
              },
            ],
          }
        : {
            type: "text",
            text: "Second explanation after the first tool call.",
          };
    original.splice(3, 0, secondReasoning, secondText);
    const bodies: Record<string, unknown>[] = [];
    const runtime = createRuntime(
      variant,
      async (wire) => {
        bodies.push(
          JSON.parse(Buffer.from(wire.body).toString()) as Record<
            string,
            unknown
          >,
        );
        return stream
          ? streamResponse(
              variant,
              bodies.length === 1,
              false,
              bodies.length === 1 ? value : undefined,
            )
          : encode(bodies.length === 1 ? value : response(variant, false));
      },
      stream,
    );
    try {
      const result = await runtime.executeModel(request);
      const results: ModelMessage[] = tools.map((tool) => ({
        role: "tool",
        tool_call_id: tool.id,
        name: tool.name,
        status: "success",
        parts: [],
      }));
      const history = [...request.messages, result.message, ...results];
      await runtime.executeModel({ ...request, messages: history });
      if (variant === "responses")
        expect(
          (bodies[1]!.input as unknown[]).slice(2, 2 + original.length),
        ).toEqual(original);
      else
        expect(
          (bodies[1]!.messages as { content: unknown[] }[])[1]!.content,
        ).toEqual(original);
      await expect(
        runtime.executeModel({
          ...request,
          messages: [
            ...request.messages,
            {
              ...result.message,
              parts: [
                {
                  media_type: "text/plain",
                  text: "Changed assistant projection",
                },
              ],
            },
            ...results,
          ],
        }),
      ).rejects.toMatchObject({ code: "agent-history-continuation" });
      await expect(
        runtime.executeModel({
          ...request,
          messages: [
            ...request.messages,
            {
              ...result.message,
              tool_calls: [
                { ...tools[0]!, arguments: { target: "changed" } },
                tools[1]!,
              ],
            },
            ...results,
          ],
        }),
      ).rejects.toMatchObject({ code: "agent-history-continuation" });
      expect(bodies).toHaveLength(2);
    } finally {
      runtime.close();
    }
  },
);
