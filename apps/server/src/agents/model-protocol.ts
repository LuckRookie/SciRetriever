import {
  AgentFailure,
  type AgentCall,
  type AgentMessage,
  type AgentPart,
  type AgentProvenance,
  validateAgentCall,
} from "./protocol.js";

/** Internal, non-persistent model protocol. Vendor/session types stay in adapters. */
export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}
export interface ModelAssistantMessage {
  readonly role: "assistant";
  readonly parts: readonly AgentPart[];
  readonly tool_calls?: readonly ModelToolCall[];
  /** Adapter-owned, in-memory replay state; never a business fact or prompt. */
  readonly continuation?: ModelContinuation;
}
export interface ModelContinuation {
  readonly provider: string;
  readonly model: string;
  readonly format: string;
  readonly opaque: Record<string, unknown>;
}
export interface ModelToolMessage {
  readonly role: "tool";
  readonly tool_call_id: string;
  readonly name: string;
  readonly status: "success" | "error" | "rejected" | "cancelled";
  readonly parts: readonly AgentPart[];
}
export type ModelMessage =
  | { readonly role: "system" | "user"; readonly parts: readonly AgentPart[] }
  | ModelAssistantMessage
  | ModelToolMessage;
export interface ModelRequest extends Omit<AgentCall, "messages"> {
  readonly messages: readonly ModelMessage[];
  readonly tool_choice?: "auto" | "required" | "none";
}
export interface ModelResponse {
  readonly message: ModelAssistantMessage;
  readonly stop_reason: "complete" | "tool_calls";
  readonly provenance: AgentProvenance;
}

export function modelRequestFromAgentCall(call: AgentCall): ModelRequest {
  return {
    ...call,
    ...(call.tools?.length ? { tool_choice: "required" } : {}),
  };
}

function validateJson(value: unknown, depth = 0): void {
  if (depth > 64) throw new AgentFailure("agent-input");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    typeof value !== "object" ||
    value === null ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new AgentFailure("agent-input");
  for (const child of Object.values(value)) validateJson(child, depth + 1);
}

/** Reject ambiguous histories before dispatch; each batch must be fully answered. */
export function validateModelRequest(request: ModelRequest): void {
  const invalid = (): never => {
    throw new AgentFailure("agent-input");
  };
  if (!request || !Array.isArray(request.messages)) invalid();
  if (
    request.tool_choice !== undefined &&
    !["auto", "required", "none"].includes(request.tool_choice)
  )
    invalid();
  const seen = new Set<string>();
  const pending = new Map<string, string>();
  const projected: AgentMessage[] = [];
  for (const message of request.messages) {
    if (!message || !Array.isArray(message.parts)) invalid();
    if (message.role === "tool") {
      if (
        pending.get(message.tool_call_id) !== message.name ||
        !["success", "error", "rejected", "cancelled"].includes(message.status)
      )
        invalid();
      pending.delete(message.tool_call_id);
    } else {
      if (pending.size) invalid();
      if (message.role === "assistant") {
        if (message.continuation !== undefined) {
          const continuation = message.continuation;
          if (
            !continuation ||
            typeof continuation.provider !== "string" ||
            typeof continuation.model !== "string" ||
            typeof continuation.format !== "string" ||
            !continuation.opaque ||
            typeof continuation.opaque !== "object" ||
            Array.isArray(continuation.opaque)
          )
            invalid();
          validateJson(continuation.opaque);
        }
        if (
          message.tool_calls !== undefined &&
          (!Array.isArray(message.tool_calls) || message.tool_calls.length > 64)
        )
          invalid();
        for (const call of message.tool_calls ?? []) {
          if (
            !call ||
            typeof call.id !== "string" ||
            !call.id.trim() ||
            call.id.length > 256 ||
            seen.has(call.id) ||
            !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(call.name) ||
            !call.arguments ||
            typeof call.arguments !== "object" ||
            Array.isArray(call.arguments)
          )
            invalid();
          validateJson(call.arguments);
          seen.add(call.id);
          pending.set(call.id, call.name);
        }
      }
    }
    if (
      message.parts.length === 0 &&
      message.role !== "tool" &&
      !(message.role === "assistant" && message.tool_calls?.length)
    )
      invalid();
    projected.push({
      role: message.role === "tool" ? "user" : message.role,
      parts: message.parts.length
        ? message.parts
        : [{ media_type: "text/plain", text: "empty tool content" }],
    });
  }
  if (pending.size) invalid();
  validateAgentCall({ ...request, messages: projected });
}
