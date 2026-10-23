import { visibleConversation } from "./events.js";
import type { AgentConversationEvent } from "@sciretriever/contracts";
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import {
  BlockAssembler,
  createMessage,
  LlmAdapter,
  ToolCallId,
  type ContentBlock,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { AgentFailure, type AgentCall, type AgentResult } from "../protocol.js";
import type {
  ModelRequest,
  ModelResponse,
  ModelToolMessage,
} from "../model-protocol.js";
import { SessionAttachments } from "./attachments.js";

/** Request-local schema and provenance remain in the adapter, not in DSH history. */
export interface DshModelCall<T extends AgentResult | ModelResponse> {
  readonly request: AgentCall | ModelRequest;
  readonly observeEvent?: (event: AgentConversationEvent) => void;
  readonly provider: string;
  readonly model: string;
  readonly context_window_tokens: number;
  readonly invoke: (signal?: AbortSignal) => Promise<T>;
  readonly signal: AbortSignal;
}

function messages(
  call: DshModelCall<AgentResult | ModelResponse>,
  attachments: SessionAttachments,
): Exclude<Message, { role: "developer" }>[] {
  return call.request.messages.map(
    (message): Exclude<Message, { role: "developer" }> => {
      const content = attachments.store(message.parts);
      if (message.role === "tool")
        return createMessage({
          role: "tool",
          toolCallId: ToolCallId(message.tool_call_id),
          source: { kind: "tool", callId: ToolCallId(message.tool_call_id) },
          isError: message.status !== "success",
          content,
        });
      if (message.role === "assistant") {
        if ("tool_calls" in message)
          for (const tool of message.tool_calls ?? [])
            content.push({
              type: "tool-call",
              id: ToolCallId(tool.id),
              name: tool.name,
              arguments: JSON.stringify(tool.arguments),
            });
        return createMessage({
          role: "assistant",
          source: { kind: "model", provider: call.provider, model: call.model },
          content,
        });
      }
      return message.role === "system"
        ? createMessage({
            role: "system",
            source: { kind: "system-prompt" },
            content,
          })
        : createMessage({ role: "user", source: { kind: "user" }, content });
    },
  );
}

/** One adapter per in-flight request keeps concurrent schemas and callbacks isolated. */
class CallAdapter<T extends AgentResult | ModelResponse> extends LlmAdapter {
  result: T | undefined;
  error: unknown;
  constructor(
    private readonly call: DshModelCall<T>,
    private readonly attachments: SessionAttachments,
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
      context: { contextWindow: this.call.context_window_tokens },
      inputModalities: ["text", "image"],
    });
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try {
      options.signal?.throwIfAborted();
      const result = await this.call.invoke(options.signal);
      this.result = result;
      const blocks: ContentBlock[] = [];
      if ("kind" in result) {
        blocks.push(
          result.kind === "structured"
            ? { type: "text", text: JSON.stringify(result.value) }
            : {
                type: "tool-call",
                id: ToolCallId(randomUUID()),
                name: result.name,
                arguments: JSON.stringify(result.arguments),
              },
        );
      } else {
        blocks.push(...this.attachments.store(result.message.parts));
        for (const call of result.message.tool_calls ?? [])
          blocks.push({
            type: "tool-call",
            id: ToolCallId(call.id),
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          });
      }
      for (const [index, block] of blocks.entries()) {
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
          kind: blocks.some((b) => b.type === "tool-call")
            ? "tool-calls"
            : "stop",
        },
      };
    } catch (error) {
      this.error = error;
      throw error;
    }
  }
}

export async function runDshModelCall<T extends AgentResult | ModelResponse>(
  ctx: Context,
  call: DshModelCall<T>,
): Promise<T> {
  const route = `sciretriever-call-${randomUUID()}`;
  const attachments = new SessionAttachments(route);
  const adapter = new CallAdapter(call, attachments);
  const unregister = ctx.llm.registerAdapter([route], adapter);
  try {
    const assembler = new BlockAssembler();
    const input = messages(call, attachments),
      names = new Map<string, string>(),
      statuses = new Map<string, ModelToolMessage["status"]>();
    for (const m of call.request.messages)
      if (m.role === "tool") {
        names.set(m.tool_call_id, m.name);
        statuses.set(m.tool_call_id, m.status);
      }
    for (const [sequence, message] of input.entries())
      call.observeEvent?.(
        visibleConversation(
          message,
          message.role === "tool" ? "tool/result" : `${message.role}/message`,
          sequence,
          Date.now(),
          names,
          statuses,
        ),
      );
    let finished = false;
    for await (const chunk of ctx.llm.stream({
      provider: route,
      model: call.model,
      messages: input,
      ...(call.request.tools ? { tools: [...call.request.tools] } : {}),
      ...(call.request.max_output_tokens === undefined
        ? {}
        : { maxTokens: call.request.max_output_tokens }),
      signal: call.signal,
    })) {
      if (finished) throw new AgentFailure("agent-response");
      assembler.push(chunk);
      if (chunk.type === "finish") {
        finished = true;
        if (chunk.reason.kind !== "stop" && chunk.reason.kind !== "tool-calls")
          throw (
            adapter.error ??
            new AgentFailure(
              call.signal.aborted ? "agent-cancelled" : "agent-response",
            )
          );
      }
    }
    if (!finished || !adapter.result) throw new AgentFailure("agent-response");
    call.signal.throwIfAborted();
    call.observeEvent?.(
      visibleConversation(
        createMessage({
          role: "assistant",
          source: { kind: "model", provider: call.provider, model: call.model },
          content: assembler.blocks(),
        }),
        "assistant/message",
        input.length,
        Date.now(),
        names,
        statuses,
      ),
    );
    // Preserve validated neutral bytes, JSON media types and opaque provider replay data.
    return adapter.result;
  } finally {
    unregister();
    attachments.close();
  }
}
