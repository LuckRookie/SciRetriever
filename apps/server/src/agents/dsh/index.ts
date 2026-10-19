import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry, { type AgentHandle } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime, {
  createUserMessage,
  type ContentBlock,
  type RequestMessage,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic";
import { runDshModelCall, type DshModelCall } from "./calls.js";
import type { AgentResult } from "../protocol.js";
import type { ModelResponse } from "../model-protocol.js";
import type {
  AgentCapabilityAdmission,
  AgentCapabilityInput,
  AgentCapabilityResult,
  AgentCapabilityRunOptions,
  AgentCapabilityRuntime,
  AgentCapabilitySession,
  AgentCapabilitySessionOptions,
} from "../capability.js";
import { AgentFailure } from "../protocol.js";
import type { ModelMessage, ModelToolMessage } from "../model-protocol.js";
import { SessionAttachments } from "./attachments.js";
import {
  ControlledModelAdapter,
  projectMessages,
  type ActiveAdmission,
} from "./model.js";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    sciretriever: {
      kind: "sciretriever";
      source: NonNullable<AgentCapabilityInput["source"]>;
    };
  }
}
declare module "@deepseek-ai/dsh-session" {
  interface SessionEventMap {
    "sciretriever/context": { message: UserMessage };
  }
}

class CapabilitySession implements AgentCapabilitySession {
  readonly id: string;
  private handle: AgentHandle | undefined;
  private readonly attachments: SessionAttachments;
  private readonly statuses = new Map<string, ModelToolMessage["status"]>();
  private readonly toolContents = new Map<string, ContentBlock[]>();
  private active: ActiveAdmission | undefined;
  private toolOptions: AgentCapabilityRunOptions | undefined;
  private readonly stop = new AbortController();
  private readonly pending: UserMessage[] = [];
  private unregister: (() => void) | undefined;
  private closing: Promise<void> | undefined;
  private initializing: Promise<void> | undefined;

  constructor(
    private readonly ctx: Context,
    private readonly options: AgentCapabilitySessionOptions,
    private readonly removed: () => void,
  ) {
    this.id = options.id;
    this.attachments = new SessionAttachments(this.id);
  }

  initialize(): Promise<void> {
    this.initializing ??= this.start();
    return this.initializing;
  }

  private async start(): Promise<void> {
    const route = `sciretriever-${randomUUID()}`;
    this.unregister = this.ctx.llm.registerAdapter(
      [route],
      new ControlledModelAdapter(
        this.options,
        this.attachments,
        this.statuses,
        () => {
          if (!this.active) throw new AgentFailure("agent-session-inactive");
          return this.active;
        },
      ),
    );
    try {
      this.handle = await this.ctx.agents.create({
        sessionId: SessionId(this.id),
        signal: this.stop.signal,
        agentOptions: {
          provider: route,
          model: this.options.modelContext.model,
          maxTokens: this.options.modelContext.max_output_tokens,
        },
        setup: (scope) => {
          scope.systemPrompt.section({
            name: "sciretriever:capability",
            order: 0,
            complete: true,
            interpolate: false,
            text: this.options.system,
          });
          scope.on("agent/error", ({ error }) => {
            if (this.active && this.active.error === undefined)
              this.active.error = error;
          });
          for (const declaration of this.options.tools) {
            scope.tools.register({
              ...declaration,
              finalizeContent: (execution, result) => {
                const content = this.toolContents.get(execution.callId);
                if (!result.isError || !content) return undefined;
                const status = this.statuses.get(execution.callId) ?? "error";
                return [
                  ...result.content,
                  {
                    type: "text",
                    text: `Host tool outcome before settlement: ${status}`,
                  },
                  ...content,
                ];
              },
              output: {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    content: { type: "array" },
                  },
                  required: ["status", "content"],
                  additionalProperties: false,
                },
                render: (_args, value) => {
                  if (
                    !value ||
                    typeof value !== "object" ||
                    Array.isArray(value) ||
                    !Array.isArray(value.content)
                  )
                    throw new AgentFailure("agent-tool-output");
                  return this.attachments.content(value.content);
                },
                presentationMeta: (_args, value) =>
                  value && typeof value === "object" && !Array.isArray(value)
                    ? { status: value.status ?? "error" }
                    : { status: "error" },
              },
              execute: async (args, execution) => {
                const options = this.toolOptions;
                if (
                  !options ||
                  !args ||
                  typeof args !== "object" ||
                  Array.isArray(args)
                )
                  throw new AgentFailure("agent-tool-input");
                const result = await options.executeTool(
                  {
                    id: execution.callId,
                    name: execution.name,
                    arguments: args as Record<string, unknown>,
                  },
                  {
                    signal: execution.signal,
                    concludeTurn: () => execution.concludeTurn(),
                  },
                );
                this.statuses.set(execution.callId, result.status);
                const content = this.attachments.store(result.parts);
                this.toolContents.set(execution.callId, content);
                return {
                  status: result.status,
                  content,
                };
              },
            });
          }
        },
      });
    } catch (error) {
      this.unregister?.();
      this.attachments.close();
      throw error;
    }
  }

  append(input: AgentCapabilityInput): void {
    const agent = this.requireHandle().agent;
    const message = this.message(input);
    agent.session.append("sciretriever/context", { message });
    this.pending.push(message);
  }

  async run(
    input: AgentCapabilityInput,
    options: AgentCapabilityRunOptions,
  ): Promise<AgentCapabilityResult> {
    const handle = this.requireHandle();
    const binding = this.bind(options);
    this.toolOptions = options;
    const before = this.history().length;
    try {
      for (const message of this.pending.splice(0))
        handle.agent.session.append("user/message", message, {
          surfaceOp: "append",
        });
      handle.agent.followup(this.message(input));
      await handle.agent.whenIdle();
      if (this.stop.signal.aborted)
        return { status: "cancelled", message: null, tool_results: [] };
      const history = this.history().slice(before);
      const tail = handle.agent.session
        .snapshotEvents()
        .slice()
        .reverse()
        .find((event) => event.type === "turn/end");
      const status = binding.signal.aborted
        ? "cancelled"
        : binding.error !== undefined ||
            (tail?.type === "turn/end" && tail.data.reason.kind !== "completed")
          ? "failed"
          : "completed";
      const last = history
        .slice()
        .reverse()
        .find((message) => message.role === "assistant");
      return {
        status,
        message: last?.role === "assistant" ? last : null,
        tool_results: history.filter(
          (message): message is ModelToolMessage => message.role === "tool",
        ),
        ...(status === "failed"
          ? {
              retryable:
                binding.error instanceof AgentFailure &&
                binding.error.retryable,
              error_code:
                binding.error instanceof AgentFailure
                  ? binding.error.code
                  : "agent-execution",
            }
          : {}),
      };
    } finally {
      this.unbind(binding);
      this.toolOptions = undefined;
    }
  }

  async compact(options: AgentCapabilityAdmission): Promise<boolean> {
    const handle = this.requireHandle();
    const binding = this.bind(options);
    try {
      return (
        (await this.ctx.compaction.compactNow(handle.agent, binding.signal)) !==
        null
      );
    } catch (error) {
      throw binding.error ?? error;
    } finally {
      this.unbind(binding);
    }
  }

  history(): readonly ModelMessage[] {
    const messages: RequestMessage[] = [];
    const seen = new Set<string>();
    for (const event of this.requireHandle().agent.session.snapshotEvents()) {
      const message =
        event.type === "user/message"
          ? event.data
          : event.type === "system/message" ||
              event.type === "assistant/message" ||
              event.type === "tool/result" ||
              event.type === "sciretriever/context"
            ? event.data.message
            : undefined;
      if (!message || seen.has(message.id)) continue;
      seen.add(message.id);
      messages.push(message);
    }
    return projectMessages(messages, this.attachments, this.statuses, false);
  }

  close(): Promise<void> {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose(): Promise<void> {
    this.stop.abort();
    try {
      // The creating caller owns initialization errors; teardown joins rollback.
      if (this.initializing) await Promise.allSettled([this.initializing]);
      await this.handle?.dispose();
    } finally {
      this.handle = undefined;
      this.pending.splice(0);
      this.statuses.clear();
      this.toolContents.clear();
      this.attachments.close();
      this.unregister?.();
      this.unregister = undefined;
      this.removed();
    }
  }

  private requireHandle(): AgentHandle {
    if (!this.handle || this.stop.signal.aborted)
      throw new AgentFailure("agent-session-closed");
    return this.handle;
  }

  private message(input: AgentCapabilityInput): UserMessage {
    if (!input.parts.length) throw new AgentFailure("agent-input");
    return createUserMessage({
      source: { kind: "sciretriever", source: input.source ?? "context" },
      content: this.attachments.store(input.parts),
    });
  }

  private readonly cancel = (): void => {
    this.handle?.agent.cancel({ kind: "user" });
  };

  private bind(options: AgentCapabilityAdmission): ActiveAdmission {
    if (this.active) throw new AgentFailure("agent-session-busy");
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.stop.signal])
      : this.stop.signal;
    if (signal.aborted) throw new AgentFailure("agent-cancelled");
    const binding = { options, signal };
    this.active = binding;
    signal.addEventListener("abort", this.cancel, { once: true });
    return binding;
  }

  private unbind(binding: ActiveAdmission): void {
    binding.signal.removeEventListener("abort", this.cancel);
    this.active = undefined;
  }
}

/** Assemble only the public in-process services used by controlled capabilities. */
export interface DshExecutionRuntime extends AgentCapabilityRuntime {
  call<T extends AgentResult | ModelResponse>(
    request: DshModelCall<T>,
  ): Promise<T>;
}

export async function createDshCapabilityRuntime(): Promise<DshExecutionRuntime> {
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
    });
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    await ctx.plugin(TokenMeter);
    await ctx.plugin(BasicCompactionEngine, {
      auto: true,
      compactionRetries: 0,
      maxOverflowRetries: 0,
      maxTokens: 4096,
      headroomTokens: 0,
    });
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
  const sessions = new Map<string, CapabilitySession>();
  const calls = new Set<Promise<unknown>>();
  const stop = new AbortController();
  let closing: Promise<void> | undefined;
  return {
    call(request) {
      if (closing) return Promise.reject(new AgentFailure("agent-closed"));
      const operation = runDshModelCall(ctx, {
        ...request,
        signal: AbortSignal.any([request.signal, stop.signal]),
      });
      calls.add(operation);
      void operation
        .finally(() => calls.delete(operation))
        .catch(() => undefined);
      return operation;
    },
    async createSession(options) {
      if (closing) throw new AgentFailure("agent-closed");
      if (!options.id.trim() || sessions.has(options.id))
        throw new AgentFailure("agent-session-identity");
      const session = new CapabilitySession(ctx, options, () => {
        sessions.delete(options.id);
      });
      sessions.set(options.id, session);
      try {
        await session.initialize();
        if (closing) {
          await session.close();
          throw new AgentFailure("agent-closed");
        }
        return session;
      } catch (error) {
        sessions.delete(options.id);
        throw error;
      }
    },
    close() {
      stop.abort();
      closing ??= (async () => {
        const results = await Promise.allSettled(
          [...sessions.values()].map((session) => session.close()),
        );
        await Promise.allSettled([...calls]);
        await ctx.fiber.dispose();
        const failures = results.filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Agent capability shutdown failed",
          );
      })();
      return closing;
    },
  };
}
