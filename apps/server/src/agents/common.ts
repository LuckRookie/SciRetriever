import {
  AgentFailure,
  type AgentCall,
  type AgentResult,
  type AgentTransport,
  type AgentTransportResponse,
} from "./protocol.js";
import { parseStrictJsonObject } from "@sciretriever/contracts";

export interface AdapterConfig {
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  readonly credential: string | null;
  readonly transport: AgentTransport;
  readonly maxResponseBytes?: number;
}

export type AgentWireProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic";
export function requestBody(
  call: AgentCall,
  protocol: AgentWireProtocol,
): Record<string, unknown> {
  const messages = call.messages.map((message) => ({
    role: message.role,
    content: message.parts.map((part) => {
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
    }),
  }));
  const schema = call.response_schema;
  if (protocol === "anthropic")
    return {
      messages: messages.filter((m) => m.role !== "system"),
      ...(messages.some((m) => m.role === "system")
        ? {
            system: messages
              .filter((m) => m.role === "system")
              .flatMap((m) => m.content),
          }
        : {}),
      max_tokens: call.max_output_tokens,
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
            tool_choice: { type: "any" },
          }
        : {}),
    };
  const format = {
    type: "json_schema",
    name: "sciretriever_structured_result",
    strict: true,
    schema,
  };
  return {
    ...(protocol === "openai-responses"
      ? { input: messages, max_output_tokens: call.max_output_tokens }
      : { messages, max_completion_tokens: call.max_output_tokens }),
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
          tool_choice: "required",
        }
      : {}),
  };
}

export async function post(
  config: AdapterConfig,
  call: AgentCall,
  body: Record<string, unknown>,
  stream: boolean,
  signal?: AbortSignal,
  protocol: AgentWireProtocol = "openai-chat",
): Promise<AgentTransportResponse> {
  const endpoint = new URL(config.endpoint);
  if (
    (endpoint.protocol === "http:" && config.credential !== null) ||
    (endpoint.protocol === "https:" && !config.credential)
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
    headers: [
      ["content-type", "application/json"],
      ...(protocol === "anthropic"
        ? ([["anthropic-version", "2023-06-01"]] as const)
        : []),
      ...(config.credential === null
        ? []
        : protocol === "anthropic"
          ? ([["x-api-key", config.credential]] as const)
          : ([["authorization", `Bearer ${config.credential}`]] as const)),
      ["accept", stream ? "text/event-stream" : "application/json"],
    ],
    body: encoded,
    ...(signal ? { signal } : {}),
  });
  if (response.body.byteLength > (config.maxResponseBytes ?? 4_194_304))
    throw new AgentFailure("agent-response-limit");
  if (response.status < 200 || response.status > 299) {
    if (response.status === 401 || response.status === 403)
      throw new AgentFailure("agent-auth");
    if (response.status === 429) throw new AgentFailure("agent-quota", true);
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

function matchesSchema(
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
