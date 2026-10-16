import { randomUUID } from "node:crypto";

/** Pick the latest observation user turn after native tool history is added. */
export function latestBrowserObservationMessage(wire: {
  readonly messages: readonly unknown[];
}): {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
  }[];
} {
  for (const value of [...wire.messages].reverse()) {
    if (
      !value ||
      typeof value !== "object" ||
      !("role" in value) ||
      value.role !== "user" ||
      !("content" in value) ||
      !Array.isArray(value.content)
    )
      continue;
    for (const part of value.content as unknown[]) {
      if (
        !part ||
        typeof part !== "object" ||
        !("type" in part) ||
        part.type !== "text" ||
        !("text" in part) ||
        typeof part.text !== "string" ||
        !part.text.startsWith("{")
      )
        continue;
      const payload: unknown = JSON.parse(part.text);
      if (
        payload &&
        typeof payload === "object" &&
        "observation_revision" in payload
      )
        return value as { content: { type: string; text?: string }[] };
    }
  }
  throw new Error("Browser model request has no observation user message");
}

/** Each synthetic provider completion carries a real, unique wire call ID. */
export function browserModelToolCallId(): string {
  return `call_${randomUUID()}`;
}
