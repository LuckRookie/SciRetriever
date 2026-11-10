import { CONVERSATION_EVENTS } from "@sciretriever/contracts";
import { conversationRecord } from "./conversation-record.js";
import { createLogger } from "../logging/index.js";
import type {
  AgentTraceInfo,
  AgentTraceRecorder,
  AgentTraceSink,
} from "../agents/trace.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";

/** Bounded diagnostics: exclude images, credentials, headers and hidden reasoning. */
export function traceSummary(value: unknown) {
  let nodes = 0,
    truncated = false;
  const redact = (text: string) =>
    text
      .replace(
        /(?:srd1_|srp1_)[A-Za-z0-9_-]{43}|sr-connect1:[^\s"<>]+/gu,
        "[redacted]",
      )
      .replace(
        /(?:Bearer\s+\S+|(?:password|secret|api[_-]?key|(?:access[_-]?)?token|cookie|authorization)["']?\s*[:=]\s*[^\s,;}]+)/giu,
        "[redacted]",
      )
      .replace(/https?:\/\/[^\s"<>]+/gu, (raw) => {
        try {
          const url = new URL(raw);
          return `${url.origin}${url.pathname}`;
        } catch {
          return "[url]";
        }
      });
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 800 || depth > 8) {
      truncated = true;
      return "[truncated]";
    }
    if (value instanceof Uint8Array || value instanceof ArrayBuffer)
      return "[image omitted]";
    if (typeof value === "string") {
      if (/^data:.*;base64,/iu.test(value)) return "[image omitted]";
      if (value.length > 4000) truncated = true;
      return redact(value.slice(0, 4000));
    }
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return value;
    if (Array.isArray(value)) {
      if (value.length > 64) truncated = true;
      return value.slice(0, 64).map((item) => visit(item, depth + 1));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        if (
          /(?:password|secret|credential|cookie|authorization|api[_-]?key|token|^auth$|headers|data|image_bytes|reasoning_content|chain_of_thought)/iu.test(
            key,
          ) &&
          !["metadata", "input_tokens", "output_tokens"].includes(key)
        ) {
          out[key] = "[omitted]";
          continue;
        }
        if (
          key === "text" &&
          typeof item === "string" &&
          /^[{[]/u.test(item.trim())
        ) {
          try {
            out[key] = visit(JSON.parse(item), depth + 1);
            continue;
          } catch {
            /* Plain text remains bounded below. */
          }
        }
        out[key] = visit(item, depth + 1);
        if (nodes > 800) break;
      }
      return out;
    }
    return null;
  };
  let summary = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(summary)) > 16384) {
    truncated = true;
    summary = { preview: JSON.stringify(summary).slice(0, 3000) };
  }
  return { summary, truncated };
}
export class AgentTraceService implements AgentTraceRecorder {
  private timer: ReturnType<typeof setInterval> | undefined;
  private closing = false;
  private cleaning: Promise<unknown> | undefined;
  constructor(private readonly database: SqliteWorker) {}
  async initialize() {
    await this.cleanup();
    this.timer = setInterval(
      () => {
        if (!this.cleaning)
          this.cleaning = this.cleanup().finally(() => {
            this.cleaning = undefined;
          });
        void this.cleaning?.catch(() => {
          createLogger("agent-traces").warn("trace_cleanup_failed", {
            code: "trace-cleanup-failed",
          });
        });
      },
      60 * 60 * 1000,
    );
    this.timer.unref();
  }
  cleanup(now = new Date()) {
    return this.database.review("session-cleanup", {
      before: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
  }
  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.cleaning;
  }
  async start(info: AgentTraceInfo): Promise<AgentTraceSink> {
    if (this.closing) throw new Error("agent-trace-closed");
    await this.database.review("session-start", {
      ...info,
      started_at: new Date().toISOString(),
    });
    let pending = Promise.resolve(),
      ended = false,
      calls = 0,
      input = 0,
      output = 0;
    const write = (
      action: "session-event" | "session-finish",
      value: unknown,
    ) => {
      pending = pending.then(async () => {
        await this.database.review(action, value);
      });
      // Observe early rejection; flush/finish still propagates the original failure.
      void pending.catch(() => undefined);
    };
    return {
      event: (kind, value) => {
        if (!ended)
          write("session-event", {
            session_id: info.session_id,
            kind,
            ...(CONVERSATION_EVENTS.includes(
              kind as (typeof CONVERSATION_EVENTS)[number],
            )
              ? conversationRecord(value)
              : traceSummary(value)),
            created_at: new Date().toISOString(),
          });
      },
      usage: (c, i, o) => {
        calls += c;
        input += i;
        output += o;
        if (!ended)
          write("session-event", {
            session_id: info.session_id,
            kind: "usage",
            summary: { calls, input_tokens: input, output_tokens: output },
            truncated: false,
            created_at: new Date().toISOString(),
          });
      },
      flush: () => pending,
      finish: async (status) => {
        if (!ended) {
          ended = true;
          write("session-finish", {
            session_id: info.session_id,
            status,
            calls,
            input_tokens: input,
            output_tokens: output,
            finished_at: new Date().toISOString(),
          });
        }
        await pending;
      },
    };
  }
}
