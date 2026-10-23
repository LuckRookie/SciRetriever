import { ContractValidationError, parseUtcTimestamp } from "./index.js";
import { tagRecord, tagInteger } from "./tags.js";
export const CONVERSATION_EVENTS = [
  "user/message",
  "system/message",
  "assistant/message",
  "tool/result",
  "sciretriever/context",
] as const;
export interface AgentConversationEvent {
  readonly event_type: (typeof CONVERSATION_EVENTS)[number];
  readonly sequence: number;
  readonly timestamp: string;
  readonly role: "user" | "system" | "assistant" | "tool" | "context";
  readonly text: string;
  readonly tool_calls: readonly {
    id: string;
    name: string;
    arguments: string;
  }[];
  readonly tool_results: readonly {
    id: string;
    name: string;
    text: string;
    status: "success" | "error" | "rejected" | "cancelled";
  }[];
  readonly images_omitted: number;
  readonly truncated: boolean;
}
export function parseAgentConversationEvent(
  value: unknown,
): AgentConversationEvent {
  const r = tagRecord(value, [
    "event_type",
    "sequence",
    "timestamp",
    "role",
    "text",
    "tool_calls",
    "tool_results",
    "images_omitted",
    "truncated",
  ]);
  const fail = (): never => {
    throw new ContractValidationError();
  };
  const text = (v: unknown): string => (typeof v === "string" ? v : fail());
  const roles = {
    "user/message": "user",
    "system/message": "system",
    "assistant/message": "assistant",
    "tool/result": "tool",
    "sciretriever/context": "context",
  } as const;
  if (
    !CONVERSATION_EVENTS.includes(
      r.event_type as AgentConversationEvent["event_type"],
    ) ||
    r.role !== roles[r.event_type as keyof typeof roles] ||
    typeof r.truncated !== "boolean" ||
    !Array.isArray(r.tool_calls) ||
    !Array.isArray(r.tool_results)
  )
    fail();
  return {
    event_type: r.event_type as AgentConversationEvent["event_type"],
    sequence: tagInteger(r.sequence),
    timestamp: parseUtcTimestamp(r.timestamp),
    role: r.role as AgentConversationEvent["role"],
    text: text(r.text),
    truncated: r.truncated as boolean,
    images_omitted: tagInteger(r.images_omitted),
    tool_calls: (r.tool_calls as unknown[]).map((v) => {
      const c = tagRecord(v, ["id", "name", "arguments"]);
      return {
        id: text(c.id),
        name: text(c.name),
        arguments: text(c.arguments),
      };
    }),
    tool_results: (r.tool_results as unknown[]).map((v) => {
      const c = tagRecord(v, ["id", "name", "text", "status"]);
      if (
        !["success", "error", "rejected", "cancelled"].includes(
          String(c.status),
        )
      )
        fail();
      return {
        id: text(c.id),
        name: text(c.name),
        text: text(c.text),
        status:
          c.status as AgentConversationEvent["tool_results"][number]["status"],
      };
    }),
  };
}
