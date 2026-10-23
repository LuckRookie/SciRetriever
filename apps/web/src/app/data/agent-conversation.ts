import {
  CONVERSATION_EVENTS,
  parseAgentConversationEvent,
  parseActorPresentation,
} from "@sciretriever/contracts";
import type { ApiClient } from "./api.js";
import { archiveQuery } from "./archive.js";
import { record } from "./wire.js";

export async function readAgentConversation(
  api: ApiClient,
  session_id: string,
  after = 0,
  signal?: AbortSignal,
) {
  const value = await archiveQuery(
    api,
    "agent-sessions",
    { operation: "read", request: { session_id, after, limit: 50 } },
    signal,
  );
  if (value === null) return null;
  const r = record(value, "agent session"),
    session = record(r.session, "session");
  if (session.session_id !== session_id)
    throw new Error("会话响应与选择不一致");
  if (
    !Array.isArray(r.events) ||
    (r.next_after !== null &&
      (!Number.isSafeInteger(r.next_after) || Number(r.next_after) < 0))
  )
    throw new Error("会话事件回执无效");
  const events = r.events.map((v) => {
    const e = record(v, "event");
    if (
      !Number.isSafeInteger(e.sequence) ||
      Number(e.sequence) <= after ||
      typeof e.kind !== "string"
    )
      throw new Error("会话事件顺序无效");
    return {
      cursor: Number(e.sequence),
      kind: e.kind,
      value: e.value,
      message: CONVERSATION_EVENTS.includes(
        e.kind as (typeof CONVERSATION_EVENTS)[number],
      )
        ? parseAgentConversationEvent(e.value)
        : null,
    };
  });
  for (let n = 1; n < events.length; n++)
    if (events[n]!.cursor <= events[n - 1]!.cursor)
      throw new Error("会话事件顺序无效");
  return {
    session: { ...session, ...parseActorPresentation(session) },
    events,
    next_after: r.next_after as number | null,
    last_sequence: events.at(-1)?.cursor ?? after,
  };
}
