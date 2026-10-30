import type { ModelRequest, ModelResponse } from "./model-protocol.js";

export const AGENT_ROLES = [
  "analysis",
  "proofreading",
  "browser",
  "tagging",
  "tag-consolidation",
  "tag-backfill",
  "translation",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export type AgentCapability =
  | "structured_text"
  | "image_input"
  | "tool_decision";
export type ReasoningEffort =
  | "default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface AgentTextPart {
  readonly media_type: "text/plain" | "application/json";
  readonly text: string;
}
export interface AgentImagePart {
  readonly media_type: "image/png" | "image/jpeg" | "image/webp";
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}
export type AgentPart = AgentTextPart | AgentImagePart;
export interface AgentMessage {
  readonly role: "system" | "user" | "assistant";
  readonly parts: readonly AgentPart[];
}
export interface AgentToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}
export interface AgentCall {
  readonly role: AgentRole;
  readonly messages: readonly AgentMessage[];
  readonly required_capabilities: readonly AgentCapability[];
  readonly input_sha256: string;
  readonly response_schema?: Record<string, unknown>;
  readonly tools?: readonly AgentToolDeclaration[];
  /** Omit to use the model service's native generation limit. */
  readonly max_output_tokens?: number;
}
export interface AgentUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}
export interface AgentProvenance {
  readonly provider: string;
  readonly model: string;
  readonly usage: AgentUsage;
}
export interface AgentStructuredResult {
  readonly kind: "structured";
  readonly value: Record<string, unknown>;
  readonly provenance: AgentProvenance;
}
export interface AgentToolCall {
  readonly kind: "tool";
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly provenance: AgentProvenance;
}
export type AgentResult = AgentStructuredResult | AgentToolCall;

export class AgentFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(
    code: string,
    retryable = false,
    options?: ErrorOptions & { readonly retry_after_ms?: number },
  ) {
    super("agent operation failed", options);
    this.name = "AgentFailure";
    this.code = code;
    this.retryable = retryable;
    this.retry_after_ms = options?.retry_after_ms;
  }
  readonly retry_after_ms: number | undefined;
}

export interface AgentTransportResponse {
  readonly status: number;
  /** Bounded Retry-After observed by Network, including earlier redirect hops. */
  readonly retry_after_ms?: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
}
/** In-process lifecycle; never serialized into a model request. */
export interface AgentCallLifecycle {
  readonly onDispatched: () => void;
}
export type AgentTransport = (request: {
  readonly onDispatched?: () => void;
  readonly endpoint: string;
  readonly method?: string;
  readonly timeout_ms?: number;
  readonly timeout_mode?: "total" | "idle";
  readonly headers: readonly (readonly [string, string])[];
  /** Credentials that a legacy provider requires in the request query. */
  readonly credential_query?: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
  readonly signal?: AbortSignal;
}) => Promise<AgentTransportResponse>;
export interface AgentAdapter {
  readonly provider: string;
  readonly model: string;
  execute(
    call: AgentCall,
    options: { readonly reasoning: ReasoningEffort; readonly stream: boolean },
    signal?: AbortSignal,
    lifecycle?: AgentCallLifecycle,
  ): Promise<AgentResult>;
  /** Optional for existing public adapters; production wires implement it. */
  executeModel?(
    request: ModelRequest,
    options: { readonly reasoning: ReasoningEffort; readonly stream: boolean },
    signal?: AbortSignal,
    lifecycle?: AgentCallLifecycle,
  ): Promise<ModelResponse>;
}

const CAPABILITIES = new Set<AgentCapability>([
  "structured_text",
  "image_input",
  "tool_decision",
]);
const IMAGE_MEDIA = new Set(["image/png", "image/jpeg", "image/webp"]);

function invalid(): never {
  throw new AgentFailure("agent-input");
}
function boundedText(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1_048_576)
    invalid();
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid();
  return value as Record<string, unknown>;
}
function validateSchema(value: Record<string, unknown>, depth = 0): void {
  if (depth > 64) invalid();
  const allowed = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "description",
    "anyOf",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid();
  const types = new Set([
    "object",
    "string",
    "number",
    "integer",
    "boolean",
    "null",
    "array",
  ]);
  if (value.anyOf !== undefined) {
    if (
      !Array.isArray(value.anyOf) ||
      value.anyOf.length < 1 ||
      value.anyOf.length > 32
    )
      invalid();
    for (const alternative of value.anyOf)
      validateSchema(object(alternative), depth + 1);
  }
  if (value.type === undefined) {
    if (
      value.anyOf === undefined ||
      value.properties !== undefined ||
      value.items !== undefined ||
      value.required !== undefined ||
      value.additionalProperties !== undefined
    )
      invalid();
  } else if (typeof value.type !== "string" || !types.has(value.type))
    invalid();
  if (
    value.type === "object"
      ? value.additionalProperties !== false
      : value.additionalProperties !== undefined &&
        value.additionalProperties !== false
  )
    invalid();
  if (
    (value.properties !== undefined || value.required !== undefined) &&
    value.type !== "object"
  )
    invalid();
  if (value.items !== undefined && value.type !== "array") invalid();
  if (value.description !== undefined) boundedText(value.description);
  if (value.properties !== undefined) {
    const properties = object(value.properties);
    for (const [name, property] of Object.entries(properties)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name)) invalid();
      validateSchema(object(property), depth + 1);
    }
  }
  if (value.required !== undefined) {
    if (!Array.isArray(value.required)) invalid();
    const required = value.required;
    if (
      required.some((item) => typeof item !== "string") ||
      new Set(required).size !== required.length
    )
      invalid();
    const properties =
      value.properties === undefined ? {} : object(value.properties);
    if (required.some((item) => !(item in properties))) invalid();
  }
  if (value.items !== undefined) validateSchema(object(value.items), depth + 1);
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0) invalid();
    if (
      new Set(value.enum.map((item) => JSON.stringify(item))).size !==
      value.enum.length
    )
      invalid();
  }
}
export function validateAgentCall(
  call: AgentCall,
  history: "atomic" | "session" = "atomic",
): void {
  if (call === null || typeof call !== "object") invalid();
  if (
    !AGENT_ROLES.includes(call.role) ||
    !Array.isArray(call.messages) ||
    call.messages.length === 0 ||
    (history === "atomic" && call.messages.length > 128) ||
    !Array.isArray(call.required_capabilities) ||
    call.required_capabilities.some((item) => !CAPABILITIES.has(item)) ||
    typeof call.input_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(call.input_sha256) ||
    (call.role === "browser" && call.max_output_tokens === undefined) ||
    (call.max_output_tokens !== undefined &&
      (!Number.isSafeInteger(call.max_output_tokens) ||
        call.max_output_tokens < 1 ||
        call.max_output_tokens > 1_000_000)) ||
    (call.response_schema !== undefined && call.tools !== undefined)
  )
    invalid();
  let imageBytes = 0;
  let imageCount = 0;
  for (const message of call.messages) {
    if (
      !message ||
      !["system", "user", "assistant"].includes(message.role) ||
      !Array.isArray(message.parts) ||
      message.parts.length === 0 ||
      message.parts.length > 64
    )
      invalid();
    for (const part of message.parts) {
      if (
        part.media_type === "text/plain" ||
        part.media_type === "application/json"
      )
        boundedText(part.text);
      else if (IMAGE_MEDIA.has(part.media_type)) {
        if (
          !(part.data instanceof Uint8Array) ||
          part.data.byteLength > 16_777_216 ||
          !Number.isSafeInteger(part.width) ||
          !Number.isSafeInteger(part.height) ||
          part.width < 1 ||
          part.height < 1
        )
          invalid();
        imageCount += 1;
        imageBytes += part.data.byteLength;
      } else invalid();
    }
  }
  if (imageCount > 16 || imageBytes > 67_108_864) invalid();
  if (call.response_schema !== undefined)
    validateSchema(object(call.response_schema));
  if (call.tools !== undefined) {
    if (!Array.isArray(call.tools) || call.tools.length > 64) invalid();
    const names = new Set<string>();
    for (const tool of call.tools) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(tool.name)) invalid();
      if (names.has(tool.name)) invalid();
      names.add(tool.name);
      boundedText(tool.description);
      validateSchema(object(tool.parameters));
    }
  }
}
