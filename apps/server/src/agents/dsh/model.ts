import { randomUUID } from "node:crypto";
import {
  LlmAdapter,
  ToolCallId,
  type ContentBlock,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type RequestMessage,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type {
  AgentCapabilityAdmission,
  AgentCapabilitySessionOptions,
} from "../capability.js";
import { AgentFailure, type AgentPart } from "../protocol.js";
import type {
  ModelContinuation,
  ModelMessage,
  ModelToolMessage,
} from "../model-protocol.js";
import type { SessionAttachments } from "./attachments.js";
import { createLogger } from "../../logging/index.js";

const logger = createLogger("agents.dsh");

export interface ActiveAdmission {
  readonly options: AgentCapabilityAdmission;
  readonly signal: AbortSignal;
  error?: unknown;
}

function continuation(value: unknown): ModelContinuation | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || !("response" in value))
    throw new AgentFailure("agent-history-continuation");
  value = value.response;
  if (
    !value ||
    typeof value !== "object" ||
    !("provider" in value) ||
    typeof value.provider !== "string" ||
    !("model" in value) ||
    typeof value.model !== "string" ||
    !("format" in value) ||
    typeof value.format !== "string" ||
    !("opaque" in value) ||
    !value.opaque ||
    typeof value.opaque !== "object" ||
    Array.isArray(value.opaque)
  )
    throw new AgentFailure("agent-history-continuation");
  return {
    provider: value.provider,
    model: value.model,
    format: value.format,
    opaque: value.opaque as Record<string, unknown>,
  };
}

/** Native DSH history is projected at the wire boundary; original events stay intact. */
export function projectMessages(
  messages: readonly RequestMessage[],
  attachments: SessionAttachments,
  statuses: ReadonlyMap<string, ModelToolMessage["status"]>,
  latestImageOnly: boolean,
): ModelMessage[] {
  const images = messages.flatMap((message) =>
    message.content.filter((part) => part.type === "image"),
  );
  const latest = images.at(-1);
  const calls = new Map<string, string>();
  return messages.map((message): ModelMessage => {
    const parts: AgentPart[] = [];
    for (const block of message.content) {
      if (block.type === "text")
        parts.push({ media_type: "text/plain", text: block.text });
      else if (block.type === "image") {
        if (latestImageOnly && block !== latest)
          parts.push({
            media_type: "text/plain",
            text: `[Previous image ${block.attachment.attachmentId}; retained in session history]`,
          });
        else parts.push(attachments.read(block.attachment));
      } else if (block.type !== "tool-call") {
        throw new AgentFailure("agent-history-content");
      }
    }
    if (message.role === "tool") {
      const name = calls.get(message.toolCallId);
      if (!name) throw new AgentFailure("agent-history-tool-pair");
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        name,
        status:
          statuses.get(message.toolCallId) ??
          (message.isError ? "error" : "success"),
        parts,
      };
    }
    if (message.role === "assistant") {
      const toolCalls = message.content.flatMap((block) => {
        if (block.type !== "tool-call") return [];
        const args: unknown = JSON.parse(block.arguments);
        if (!args || typeof args !== "object" || Array.isArray(args))
          throw new AgentFailure("agent-history-tool-arguments");
        calls.set(block.id, block.name);
        return [
          {
            id: block.id,
            name: block.name,
            arguments: args as Record<string, unknown>,
          },
        ];
      });
      const replay = continuation(message.source.replayState);
      return {
        role: "assistant",
        parts,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(replay === undefined ? {} : { continuation: replay }),
      };
    }
    if (message.role === "developer")
      throw new AgentFailure("agent-history-role");
    return { role: message.role, parts };
  });
}

/** One session owns one adapter route; no mutable global current-article binding. */
export class ControlledModelAdapter extends LlmAdapter {
  private readonly seenCallIds = new Set<string>();
  constructor(
    private readonly options: AgentCapabilitySessionOptions,
    private readonly attachments: SessionAttachments,
    private readonly statuses: ReadonlyMap<string, ModelToolMessage["status"]>,
    private readonly admission: () => ActiveAdmission,
  ) {
    super();
  }

  override resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: {
        contextWindow: this.options.modelContext.context_window_tokens,
      },
      defaultMaxTokens: this.options.modelContext.max_output_tokens,
      // Preserve supplied images for the host capability check; never silently downgrade them.
    });
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const active = this.admission();
    // A later request means the framework recovered the previous request failure.
    active.error = undefined;
    const signal = options.signal
      ? AbortSignal.any([options.signal, active.signal])
      : active.signal;
    let lifecycle:
      | Awaited<ReturnType<AgentCapabilityAdmission["admitRequest"]>>
      | undefined;
    const identity = {
      session_id: this.options.id,
      request_id: randomUUID(),
      purpose:
        options.purpose === "compaction"
          ? ("compaction" as const)
          : ("inference" as const),
      provider: this.options.modelContext.provider,
      model: this.options.modelContext.model,
    };
    let dispatchedAt: number | undefined;
    let tokens: { input_tokens: number; output_tokens: number } | undefined;
    logger.info("model_request_requested", identity);
    try {
      signal.throwIfAborted();
      if (options.sessionId !== this.options.id)
        throw new AgentFailure("agent-session-identity");
      lifecycle = await active.options.admitRequest(identity, signal);
      signal.throwIfAborted();
      const messages = projectMessages(
        options.messages,
        this.attachments,
        this.statuses,
        this.options.image_policy === "latest",
      );
      if (options.system)
        messages.unshift({
          role: "system",
          parts: [{ media_type: "text/plain", text: options.system }],
        });
      const result = await this.options.modelCall(
        {
          role: this.options.role,
          messages,
          required_capabilities: [
            ...(messages.some((message) =>
              message.parts.some((part) => "data" in part),
            )
              ? ["image_input" as const]
              : []),
            ...(options.tools?.length ? ["tool_decision" as const] : []),
          ],
          input_sha256: this.options.input_sha256,
          ...(options.tools?.length ? { tools: options.tools } : {}),
          ...(options.maxTokens === undefined
            ? {}
            : {
                max_output_tokens: Math.min(
                  options.maxTokens,
                  options.purpose === "compaction"
                    ? this.options.modelContext.max_output_tokens
                    : (this.options.max_output_tokens ??
                        this.options.modelContext.max_output_tokens),
                ),
              }),
          tool_choice:
            options.purpose === "compaction"
              ? "none"
              : (this.options.tool_choice ?? "auto"),
        },
        signal,
        {
          onDispatched: () => {
            lifecycle?.onDispatched();
            dispatchedAt = Date.now();
            logger.info("model_request_dispatched", identity);
          },
        },
      );
      tokens = result.provenance.usage;
      signal.throwIfAborted();
      const batchIds = new Set<string>();
      for (const call of result.message.tool_calls ?? []) {
        if (
          !call.id.trim() ||
          batchIds.has(call.id) ||
          this.seenCallIds.has(call.id)
        )
          throw new AgentFailure("agent-response");
        batchIds.add(call.id);
      }
      for (const id of batchIds) this.seenCallIds.add(id);
      let index = 0;
      const blocks: ContentBlock[] = [
        ...this.attachments.store(result.message.parts),
        ...(result.message.tool_calls ?? []).map(
          (call): ContentBlock => ({
            type: "tool-call",
            id: ToolCallId(call.id),
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          }),
        ),
      ];
      for (const block of blocks) {
        yield { type: "block-start", index, blockType: block.type };
        if (block.type === "text")
          yield { type: "text-delta", index, text: block.text };
        if (block.type === "tool-call")
          yield {
            type: "tool-call-delta",
            index,
            id: block.id,
            name: block.name,
            argumentsDelta: block.arguments,
          };
        yield { type: "block-end", index, block };
        index += 1;
      }
      yield {
        type: "usage",
        usage: {
          inputTokens: result.provenance.usage.input_tokens,
          outputTokens: result.provenance.usage.output_tokens,
        },
      };
      yield {
        type: "finish",
        reason: {
          kind: result.stop_reason === "tool_calls" ? "tool-calls" : "stop",
        },
        ...(result.message.continuation === undefined
          ? {}
          : { replayState: { response: result.message.continuation } }),
      };
    } catch (error) {
      active.error = error;
      throw error;
    } finally {
      try {
        lifecycle?.onSettled?.();
      } finally {
        logger.info("model_request_settled", {
          ...identity,
          status: signal.aborted
            ? "cancelled"
            : active.error === undefined
              ? "completed"
              : "failed",
          elapsed_ms:
            dispatchedAt === undefined ? 0 : Date.now() - dispatchedAt,
          ...(tokens ?? {}),
          ...(active.error === undefined
            ? {}
            : {
                code:
                  active.error instanceof AgentFailure
                    ? active.error.code
                    : "agent-execution",
              }),
        });
      }
    }
  }
}
