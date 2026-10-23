import {
  parseAgentConversationEvent,
  type AgentConversationEvent,
} from "@sciretriever/contracts";

/** Preserve ordinary visible strings and JSON formatting; redact credentials and bound the serialized event. */
export function conversationRecord(value: unknown) {
  const event = parseAgentConversationEvent(value);
  let truncated = event.truncated;
  const plain = (text: string) =>
    text
      .replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/gu, "[图片未保存]")
      .replace(
        /((?:"(?:password|secret|credential|cookie|authorization|api[_-]?key|(?:access[_-]?)?token|reasoning_content|chain_of_thought)"\s*:\s*)")(?:\\.|[^"\\])*"/giu,
        '$1"[redacted]"',
      )
      .replace(/Bearer\s+[^\s"'<>]+/giu, "Bearer [redacted]")
      .replace(
        /\b(password|secret|api[_-]?key|(?:access[_-]?)?token|cookie|authorization)\s*[:=]\s*[^\s,;}"'<>]+/giu,
        "$1=[redacted]",
      )
      .replace(/https?:\/\/[^\s"<>]+/gu, (raw) => {
        try {
          const u = new URL(raw);
          return u.search || u.hash ? `${u.origin}${u.pathname}` : raw;
        } catch {
          return "[url]";
        }
      });
  const clean = (text: string, depth = 0): string => {
    if (depth > 16) {
      truncated = true;
      return "[nested content omitted]";
    }
    if (!/^[{[]/u.test(text.trim())) return plain(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return plain(text);
    }
    let changed = false;
    const visit = (v: unknown, level = depth): unknown => {
      if (level > 16) {
        truncated = true;
        changed = true;
        return "[nested content omitted]";
      }
      if (typeof v === "string") {
        const result = clean(v, level + 1);
        changed ||= result !== v;
        return result;
      }
      if (Array.isArray(v)) return v.map((item) => visit(item, level + 1));
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(v)) {
          if (
            /^(?:password|secret|credential|cookie|authorization|api[_-]?key|(?:access[_-]?)?token|reasoning_content|chain_of_thought|image_bytes|image_base64|screenshot_base64)$/iu.test(
              key,
            )
          ) {
            out[key] = "[redacted]";
            changed = true;
          } else out[key] = visit(value, level + 1);
        }
        return out;
      }
      return v;
    };
    const result = visit(parsed);
    return changed ? JSON.stringify(result) : plain(text);
  };
  const original: AgentConversationEvent = {
    ...event,
    text: clean(event.text),
    tool_calls: event.tool_calls.map((c) => ({
      ...c,
      arguments: clean(c.arguments),
    })),
    tool_results: event.tool_results.map((c) => ({
      ...c,
      text: clean(c.text),
    })),
  };
  let result = original,
    cap = 24000;
  while (Buffer.byteLength(JSON.stringify(result)) > 60000) {
    truncated = true;
    result = {
      ...original,
      truncated: true,
      text: original.text.slice(0, cap),
      tool_calls: original.tool_calls.slice(0, 32).map((c) => ({
        ...c,
        id: c.id.slice(0, 256),
        name: c.name.slice(0, 256),
        arguments: c.arguments.slice(
          0,
          Math.floor(cap / Math.max(1, original.tool_calls.length)),
        ),
      })),
      tool_results: original.tool_results.slice(0, 32).map((c) => ({
        ...c,
        id: c.id.slice(0, 256),
        name: c.name.slice(0, 256),
        text: c.text.slice(
          0,
          Math.floor(cap / Math.max(1, original.tool_results.length)),
        ),
      })),
    };
    cap = Math.floor(cap / 2);
  }
  return { summary: { ...result, truncated }, truncated };
}
