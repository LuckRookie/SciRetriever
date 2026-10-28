import { createHash } from "node:crypto";
import {
  AgentFailure,
  type AgentCall,
  type AgentCallLifecycle,
  type AgentResult,
  type AgentTransport,
  type AgentTransportResponse,
} from "./protocol.js";
import {
  modelRequestFromAgentCall,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
  type ModelContinuation,
  type ModelAssistantMessage,
} from "./model-protocol.js";
import {
  canonicalJsonBytes,
  parseStrictJsonObject,
} from "@sciretriever/contracts";

export interface AdapterConfig {
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  readonly credential: string | null;
  /** Resolve a fresh secret immediately before each request dispatch. */
  readonly credentialProvider?: () => Promise<string | null>;
  readonly transport: AgentTransport;
  readonly maxResponseBytes?: number;
}

export type AgentWireProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic";

/** Anthropic requires the API version header on every request. */
export const ANTHROPIC_API_VERSION_HEADER = [
  "anthropic-version",
  "2023-06-01",
] as const;

/**
 * The single protocol-derived credential header. A configuration probe and the
 * production adapter must never disagree about which header carries the key:
 * Anthropic authenticates with `x-api-key`, the OpenAI protocols with a bearer
 * `authorization` header.
 */
export function credentialHeader(
  protocol: AgentWireProtocol,
  credential: string,
): readonly [string, string] {
  switch (protocol) {
    case "anthropic":
      return ["x-api-key", credential];
    case "openai-chat":
    case "openai-responses":
      return ["authorization", `Bearer ${credential}`];
    default: {
      // A new wire protocol has to decide its credential header explicitly: silently
      // inheriting the bearer form would send the key to an unverified destination.
      const exhaustive: never = protocol;
      throw new AgentFailure(
        `agent-protocol-unsupported:${String(exhaustive)}`,
      );
    }
  }
}
export function requestBody(
  call: AgentCall,
  protocol: AgentWireProtocol,
): Record<string, unknown> {
  return modelRequestBody(modelRequestFromAgentCall(call), protocol);
}

export function modelRequestBody(
  call: ModelRequest,
  protocol: AgentWireProtocol,
): Record<string, unknown> {
  const chatImages: Record<string, unknown>[] = [];
  const messages = call.messages.flatMap(
    (message, messageIndex): Record<string, unknown>[] => {
      const content = message.parts.map((part) => {
        if (
          part.media_type === "text/plain" ||
          part.media_type === "application/json"
        )
          return {
            type:
              protocol === "openai-responses"
                ? message.role === "assistant"
                  ? "output_text"
                  : "input_text"
                : "text",
            text: part.text,
          };
        if (!("data" in part)) throw new AgentFailure("agent-input");
        const encoded = Buffer.from(part.data).toString("base64");
        if (protocol === "anthropic")
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: part.media_type,
              data: encoded,
            },
          };
        const url = `data:${part.media_type};base64,${encoded}`;
        return protocol === "openai-responses"
          ? { type: "input_image", image_url: url }
          : { type: "image_url", image_url: { url } };
      });
      if (message.role === "tool") {
        const status = {
          type: protocol === "openai-responses" ? "input_text" : "text",
          text: JSON.stringify({ status: message.status }),
        };
        if (protocol === "anthropic")
          return [
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: message.tool_call_id,
                  is_error: message.status !== "success",
                  content: [status, ...content],
                },
              ],
            },
          ];
        if (protocol === "openai-responses")
          return [
            {
              type: "function_call_output",
              call_id: message.tool_call_id,
              output: [status, ...content],
            },
          ];
        // Chat tool messages accept text only. Images stay attached to an explicit
        // user message tied to this tool result, rather than being dropped.
        const texts = content.filter((part) => part.type === "text");
        const images = content.filter((part) => part.type !== "text");
        if (images.length)
          chatImages.push({
            role: "user",
            content: [
              {
                type: "text",
                text: `Images returned by tool call ${message.tool_call_id}`,
              },
              ...images,
            ],
          });
        const finishedBatch = call.messages[messageIndex + 1]?.role !== "tool";
        return [
          {
            role: "tool",
            tool_call_id: message.tool_call_id,
            content: JSON.stringify({
              status: message.status,
              content: texts.map((part) => part.text),
            }),
          },
          ...(finishedBatch ? chatImages.splice(0) : []),
        ];
      }
      const calls =
        message.role === "assistant" ? (message.tool_calls ?? []) : [];
      const replay =
        message.role === "assistant" ? message.continuation?.opaque : undefined;
      if (protocol === "openai-responses")
        return replay?.items
          ? (replay.items as Record<string, unknown>[])
          : [
              ...(content.length ? [{ role: message.role, content }] : []),
              ...calls.map((call) => ({
                type: "function_call",
                call_id: call.id,
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              })),
            ];
      if (protocol === "anthropic")
        return [
          {
            role: message.role,
            content: replay?.blocks ?? [
              ...content,
              ...calls.map((call) => ({
                type: "tool_use",
                id: call.id,
                name: call.name,
                input: call.arguments,
              })),
            ],
          },
        ];
      return [
        {
          role: message.role,
          ...(replay?.reasoning_content !== undefined
            ? { reasoning_content: replay.reasoning_content }
            : {}),
          content: content.length ? content : null,
          ...(calls.length
            ? {
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                })),
              }
            : {}),
        },
      ];
    },
  );
  const schema = call.response_schema;
  if (protocol === "anthropic") {
    const turns: Record<string, unknown>[] = [];
    for (const message of messages.filter((m) => m.role !== "system")) {
      const previous = turns.at(-1);
      if (
        previous &&
        previous.role === message.role &&
        Array.isArray(previous.content) &&
        Array.isArray(message.content)
      )
        previous.content.push(...message.content);
      else turns.push(message);
    }
    return {
      messages: turns,
      ...(messages.some((m) => m.role === "system")
        ? {
            system: messages
              .filter((m) => m.role === "system")
              .flatMap((m) => m.content),
          }
        : {}),
      // Messages requires max_tokens; this protocol default is not a publication budget.
      max_tokens: call.max_output_tokens ?? 16384,
      ...(schema
        ? { output_config: { format: { type: "json_schema", schema } } }
        : {}),
      ...(call.tools?.length
        ? {
            tools: call.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
            tool_choice: {
              type:
                call.tool_choice === "required"
                  ? "any"
                  : (call.tool_choice ?? "auto"),
            },
          }
        : {}),
    };
  }
  const format = {
    type: "json_schema",
    name: "sciretriever_structured_result",
    strict: true,
    schema,
  };
  return {
    ...(protocol === "openai-responses"
      ? {
          input: messages,
          ...(call.max_output_tokens === undefined
            ? {}
            : { max_output_tokens: call.max_output_tokens }),
        }
      : {
          messages,
          ...(call.max_output_tokens === undefined
            ? {}
            : { max_completion_tokens: call.max_output_tokens }),
        }),
    ...(schema
      ? protocol === "openai-responses"
        ? { text: { format } }
        : {
            response_format: {
              type: "json_schema",
              json_schema: { name: format.name, strict: true, schema },
            },
          }
      : {}),
    ...(call.tools?.length
      ? {
          tools: call.tools.map((t) =>
            protocol === "openai-responses"
              ? { type: "function", ...t, strict: true }
              : { type: "function", function: { ...t, strict: true } },
          ),
          tool_choice: call.tool_choice ?? "auto",
        }
      : {}),
  };
}

export async function post(
  config: AdapterConfig,
  call: Pick<AgentCall, "role">,
  body: Record<string, unknown>,
  stream: boolean,
  signal?: AbortSignal,
  protocol: AgentWireProtocol = "openai-chat",
  lifecycle?: AgentCallLifecycle,
): Promise<AgentTransportResponse> {
  const endpoint = new URL(config.endpoint);
  const credential = config.credentialProvider
    ? await config.credentialProvider()
    : config.credential;
  if (
    (endpoint.protocol === "http:" && credential !== null) ||
    (endpoint.protocol === "https:" && !credential)
  )
    throw new AgentFailure("agent-credentials");
  let encoded: Uint8Array;
  try {
    encoded = new TextEncoder().encode(JSON.stringify(body));
  } catch {
    throw new AgentFailure("agent-input");
  }
  if (encoded.byteLength > 4_194_304)
    throw new AgentFailure("agent-request-limit");
  const response = await config.transport({
    endpoint: config.endpoint,
    method: "POST",
    timeout_ms: 120_000,
    ...(["analysis", "proofreading"].includes(call.role)
      ? { timeout_mode: "idle" as const }
      : {}),
    headers: [
      ["content-type", "application/json"],
      ...(protocol === "anthropic" ? [ANTHROPIC_API_VERSION_HEADER] : []),
      ...(credential === null ? [] : [credentialHeader(protocol, credential)]),
      ["accept", stream ? "text/event-stream" : "application/json"],
    ],
    body: encoded,
    ...(lifecycle ? { onDispatched: lifecycle.onDispatched } : {}),
    ...(signal ? { signal } : {}),
  });
  if (response.body.byteLength > (config.maxResponseBytes ?? 4_194_304))
    throw new AgentFailure("agent-response-limit");
  if (response.status < 200 || response.status > 299) {
    if (response.status === 401 || response.status === 403)
      throw new AgentFailure("agent-auth");
    if (response.status === 429)
      throw new AgentFailure("agent-quota", true, {
        ...(response.retry_after_ms === undefined
          ? {}
          : { retry_after_ms: response.retry_after_ms }),
      });
    throw new AgentFailure(
      response.status >= 500 ? "agent-remote" : "agent-request",
      response.status >= 500,
    );
  }
  return response;
}

export function parseJson(
  response: AgentTransportResponse,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = parseStrictJsonObject(
      new TextDecoder("utf-8", { fatal: true }).decode(response.body),
    );
  } catch {
    throw new AgentFailure("agent-protocol");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new AgentFailure("agent-protocol");
  return value as Record<string, unknown>;
}

export function sseEvents(
  response: AgentTransportResponse,
  requireDone: boolean | "optional" = true,
): readonly Record<string, unknown>[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
  } catch {
    throw new AgentFailure("agent-truncated");
  }
  if (!text.endsWith("\n") && !text.endsWith("\r"))
    throw new AgentFailure("agent-truncated");
  const events: Record<string, unknown>[] = [];
  let sawDone = false;
  let doneCount = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      doneCount += 1;
      if (sawDone) throw new AgentFailure("agent-protocol");
      sawDone = true;
      continue;
    }
    if (!data) continue;
    if (sawDone) throw new AgentFailure("agent-protocol");
    let value: unknown;
    try {
      value = parseStrictJsonObject(data);
    } catch {
      throw new AgentFailure("agent-protocol");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new AgentFailure("agent-protocol");
    events.push(value as Record<string, unknown>);
  }
  if (
    (requireDone === true && (doneCount !== 1 || !sawDone)) ||
    (requireDone === false && doneCount > 0) ||
    events.length === 0
  )
    throw new AgentFailure("agent-truncated");
  return events;
}

export function usage(value: unknown): {
  input_tokens: number;
  output_tokens: number;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new AgentFailure("agent-response");
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.input_tokens) ||
    !Number.isSafeInteger(record.output_tokens) ||
    (record.input_tokens as number) < 0 ||
    (record.output_tokens as number) < 0
  )
    throw new AgentFailure("agent-response");
  return {
    input_tokens: record.input_tokens as number,
    output_tokens: record.output_tokens as number,
  };
}

export function resultText(
  provider: string,
  model: string,
  text: string,
  tokenUsage: { input_tokens: number; output_tokens: number },
  schema?: Record<string, unknown>,
): AgentResult {
  if (!text || text.length > 4_194_304)
    throw new AgentFailure("agent-result-limit");
  let value: unknown;
  try {
    value = parseStrictJsonObject(text);
  } catch {
    throw new AgentFailure("agent-structured-response");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new AgentFailure("agent-structured-response");
  if (schema && !matchesSchema(value, schema))
    throw new AgentFailure("agent-structured-response");
  return {
    kind: "structured",
    value: value as Record<string, unknown>,
    provenance: { provider, model, usage: tokenUsage },
  };
}

export function toolResult(
  provider: string,
  model: string,
  name: string,
  argumentsText: string,
  tokenUsage: { input_tokens: number; output_tokens: number },
  schema?: Record<string, unknown>,
): AgentResult {
  let value: unknown;
  try {
    value = parseStrictJsonObject(argumentsText);
  } catch {
    throw new AgentFailure("agent-tool");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new AgentFailure("agent-tool");
  if (schema && !matchesSchema(value, schema))
    throw new AgentFailure("agent-tool");
  return {
    kind: "tool",
    name,
    arguments: value as Record<string, unknown>,
    provenance: { provider, model, usage: tokenUsage },
  };
}

export function matchesSchema(
  value: unknown,
  schema: Record<string, unknown>,
  depth = 0,
): boolean {
  if (depth > 64) return false;
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) ||
      !schema.enum.some(
        (item) => JSON.stringify(item) === JSON.stringify(value),
      ))
  )
    return false;
  if (schema.anyOf !== undefined) {
    if (
      !Array.isArray(schema.anyOf) ||
      !schema.anyOf.some(
        (branch) =>
          branch &&
          typeof branch === "object" &&
          !Array.isArray(branch) &&
          matchesSchema(value, branch as Record<string, unknown>, depth + 1),
      )
    )
      return false;
    if (schema.type === undefined) return true;
  }
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return false;
    const record = value as Record<string, unknown>;
    const properties =
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some((key) => typeof key !== "string" || !(key in record)))
      return false;
    if (
      schema.additionalProperties === false &&
      Object.keys(record).some((key) => !(key in properties))
    )
      return false;
    return Object.entries(record).every(
      ([key, item]) =>
        properties[key] === undefined ||
        (properties[key] !== null &&
          typeof properties[key] === "object" &&
          !Array.isArray(properties[key]) &&
          matchesSchema(
            item,
            properties[key] as Record<string, unknown>,
            depth + 1,
          )),
    );
  }
  if (schema.type === "array")
    return (
      Array.isArray(value) &&
      (schema.items === undefined ||
        (schema.items !== null &&
          typeof schema.items === "object" &&
          !Array.isArray(schema.items) &&
          value.every((item) =>
            matchesSchema(
              item,
              schema.items as Record<string, unknown>,
              depth + 1,
            ),
          )))
    );
  if (schema.type === "string") return typeof value === "string";
  if (schema.type === "number")
    return typeof value === "number" && Number.isFinite(value);
  if (schema.type === "integer") return Number.isSafeInteger(value);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "null") return value === null;
  return false;
}

/** Shared strict tool argument parser; missing IDs are tolerated only by the
 * legacy single-call projection, which never exposes or replays those IDs. */
export function modelToolCall(
  request: ModelRequest,
  id: unknown,
  name: string,
  argumentsText: string,
  index: number,
  legacy: boolean,
): ModelToolCall {
  if (id === undefined && legacy) id = `legacy-tool-${index}`;
  if (typeof id !== "string" || !id.trim() || id.length > 256)
    throw new AgentFailure("agent-tool");
  const tool = request.tools?.find((tool) => tool.name === name);
  if (!tool && !legacy) throw new AgentFailure("agent-tool");
  const parsed = toolResult(
    "internal",
    "internal",
    name,
    argumentsText,
    { input_tokens: 0, output_tokens: 0 },
    tool?.parameters,
  );
  if (parsed.kind !== "tool") throw new AgentFailure("agent-tool");
  return { id, name, arguments: parsed.arguments };
}

export function modelResponse(
  provider: string,
  model: string,
  text: string,
  calls: readonly ModelToolCall[],
  tokenUsage: { input_tokens: number; output_tokens: number },
  continuation?: ModelContinuation,
): ModelResponse {
  if (new Set(calls.map((call) => call.id)).size !== calls.length)
    throw new AgentFailure("agent-tool");
  if ((!text && !calls.length) || text.length > 4_194_304)
    throw new AgentFailure("agent-result-limit");
  const message: ModelAssistantMessage = {
    role: "assistant",
    parts: text ? [{ media_type: "text/plain", text }] : [],
    ...(calls.length ? { tool_calls: calls } : {}),
  };
  return {
    message: {
      ...message,
      ...(continuation
        ? {
            continuation: {
              ...continuation,
              opaque: {
                ...continuation.opaque,
                binding_sha256: replayBinding(message, continuation.opaque),
              },
            },
          }
        : {}),
    },
    stop_reason: calls.length ? "tool_calls" : "complete",
    provenance: { provider, model, usage: tokenUsage },
  };
}

function replayBinding(
  message: ModelAssistantMessage,
  opaque: Record<string, unknown>,
): string {
  const payload = Object.fromEntries(
    Object.entries(opaque).filter(([key]) => key !== "binding_sha256"),
  );
  return createHash("sha256")
    .update(
      canonicalJsonBytes({
        parts: message.parts.map((part) =>
          "text" in part
            ? part
            : { ...part, data: Buffer.from(part.data).toString("base64") },
        ),
        tool_calls: message.tool_calls ?? [],
        payload,
      }),
    )
    .digest("hex");
}

/** Replay envelopes are bound to the exact adapter route that produced them. */
export function validateModelContinuations(
  request: ModelRequest,
  provider: string,
  model: string,
  format: AgentWireProtocol,
): void {
  for (const message of request.messages) {
    if (message.role !== "assistant" || !message.continuation) continue;
    const state = message.continuation;
    if (
      state.provider !== provider ||
      state.model !== model ||
      state.format !== format
    )
      throw new AgentFailure("agent-model-mismatch");
    if (state.opaque.binding_sha256 !== replayBinding(message, state.opaque))
      throw new AgentFailure("agent-history-continuation");
    const field =
      format === "openai-responses"
        ? "items"
        : format === "anthropic"
          ? "blocks"
          : "reasoning_content";
    if (
      Object.keys(state.opaque).some(
        (key) => key !== field && key !== "binding_sha256",
      )
    )
      throw new AgentFailure("agent-input");
    const content = state.opaque[field];
    if (format === "openai-chat") {
      if (typeof content !== "string") throw new AgentFailure("agent-input");
    } else if (
      !Array.isArray(content) ||
      content.some(
        (item: unknown) =>
          !item ||
          typeof item !== "object" ||
          !("type" in item) ||
          (format === "openai-responses"
            ? !["reasoning", "message", "function_call"].includes(
                String(item.type),
              )
            : !["thinking", "redacted_thinking", "text", "tool_use"].includes(
                String(item.type),
              )),
      )
    )
      throw new AgentFailure("agent-input");
  }
}

export function projectAgentResult(
  call: AgentCall,
  result: ModelResponse,
): AgentResult {
  const calls = result.message.tool_calls ?? [];
  const text = result.message.parts
    .map((part) => ("text" in part ? part.text : ""))
    .join("");
  if (calls.length) {
    if (calls.length !== 1 || result.message.parts.length)
      throw new AgentFailure("agent-tool");
    const selected = calls[0];
    if (!selected) throw new AgentFailure("agent-tool");
    return {
      kind: "tool",
      name: selected.name,
      arguments: selected.arguments,
      provenance: result.provenance,
    };
  }
  return resultText(
    result.provenance.provider,
    result.provenance.model,
    text,
    result.provenance.usage,
    call.response_schema,
  );
}
