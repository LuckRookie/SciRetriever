import type { Message } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { AgentConversationEvent } from "@sciretriever/contracts";
import type { ModelToolMessage } from "../model-protocol.js";

/** Copy only visible message blocks; reasoning, image references and provider metadata never leave DSH. */
export function conversationEvent(
  event: SessionEvent,
  names: Map<string, string>,
  statuses: ReadonlyMap<string, ModelToolMessage["status"]>,
): AgentConversationEvent | null {
  const message =
    event.type === "user/message"
      ? event.data
      : event.type === "system/message" ||
          event.type === "assistant/message" ||
          event.type === "tool/result" ||
          event.type === "sciretriever/context"
        ? event.data.message
        : null;
  if (!message) return null;
  return visibleConversation(
    message,
    event.type as AgentConversationEvent["event_type"],
    Number(event.seq),
    event.time,
    names,
    statuses,
  );
}
export function visibleConversation(
  message: Exclude<Message, { role: "developer" }>,
  eventType: AgentConversationEvent["event_type"],
  sequence: number,
  time: number,
  names: Map<string, string>,
  statuses: ReadonlyMap<string, ModelToolMessage["status"]>,
): AgentConversationEvent {
  const role = eventType === "sciretriever/context" ? "context" : message.role;
  const text: string[] = [],
    calls: { id: string; name: string; arguments: string }[] = [];
  let images = 0;
  for (const block of message.content) {
    if (block.type === "text") text.push(block.text);
    else if (block.type === "image") {
      images++;
      text.push("[图片未保存]");
    } else if (block.type === "tool-call") {
      names.set(block.id, block.name);
      calls.push({
        id: block.id,
        name: block.name,
        arguments: block.arguments,
      });
    }
  }
  const joined = text.join("\n");
  return {
    event_type: eventType,
    sequence,
    timestamp: new Date(time).toISOString(),
    role,
    text: joined,
    tool_calls: calls,
    tool_results:
      message.role === "tool"
        ? [
            {
              id: message.toolCallId,
              name: names.get(message.toolCallId) ?? "",
              text: joined,
              status:
                statuses.get(message.toolCallId) ??
                (message.isError ? "error" : "success"),
            },
          ]
        : [],
    images_omitted: images,
    truncated: false,
  };
}
