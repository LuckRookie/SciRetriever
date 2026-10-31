import {
  modelRequestFromAgentCall,
  validateModelRequest,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
} from "./model-protocol.js";
import {
  AgentFailure,
  type AgentAdapter,
  type AgentCall,
  type AgentCallLifecycle,
  type AgentResult,
  type AgentUsage,
  type ReasoningEffort,
} from "./protocol.js";
import {
  post,
  parseJson,
  modelRequestBody,
  modelResponse,
  modelToolCall,
  projectAgentResult,
  validateModelContinuations,
  sseEvents,
  usage,
  type AdapterConfig,
} from "./common.js";

/**
 * Messages reports uncached input apart from cache reads and writes; the
 * shared usage counts every prompt token in `input_tokens`.
 */
function messagesUsage(raw: Record<string, unknown>): AgentUsage {
  const optional = (key: string) =>
    raw[key] === undefined || raw[key] === null
      ? undefined
      : (raw[key] as number);
  const read = optional("cache_read_input_tokens"),
    written = optional("cache_creation_input_tokens");
  const input = raw.input_tokens;
  return usage({
    input_tokens:
      Number.isSafeInteger(input) &&
      (read === undefined || Number.isSafeInteger(read)) &&
      (written === undefined || Number.isSafeInteger(written))
        ? (input as number) + (read ?? 0) + (written ?? 0)
        : input,
    output_tokens: raw.output_tokens,
    ...(read === undefined ? {} : { cached_input_tokens: read }),
    ...(written === undefined ? {} : { cache_write_tokens: written }),
  });
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new AgentFailure("agent-protocol");
  return value as Record<string, unknown>;
}
function textValue(value: unknown): string {
  if (typeof value !== "string") throw new AgentFailure("agent-protocol");
  return value;
}

export class AnthropicMessagesAdapter implements AgentAdapter {
  readonly provider: string;
  readonly model: string;
  private readonly config: AdapterConfig;
  constructor(config: AdapterConfig) {
    this.provider = config.provider;
    this.model = config.model;
    this.config = config;
  }
  async execute(
    call: AgentCall,
    options: { readonly reasoning: ReasoningEffort; readonly stream: boolean },
    signal?: AbortSignal,
    lifecycle?: AgentCallLifecycle,
  ): Promise<AgentResult> {
    return projectAgentResult(
      call,
      await this.runModel(
        modelRequestFromAgentCall(call),
        options,
        signal,
        lifecycle,
        true,
      ),
    );
  }
  async executeModel(
    request: ModelRequest,
    options: { readonly reasoning: ReasoningEffort; readonly stream: boolean },
    signal?: AbortSignal,
    lifecycle?: AgentCallLifecycle,
  ): Promise<ModelResponse> {
    validateModelRequest(request);
    return this.runModel(request, options, signal, lifecycle, false);
  }
  private async runModel(
    call: ModelRequest,
    options: { readonly reasoning: ReasoningEffort; readonly stream: boolean },
    signal: AbortSignal | undefined,
    lifecycle: AgentCallLifecycle | undefined,
    legacy: boolean,
  ): Promise<ModelResponse> {
    validateModelContinuations(call, this.provider, this.model, "anthropic");
    const request = modelRequestBody(call, "anthropic");
    const body = {
      ...request,
      model: this.model,
      ...(options.stream ? { stream: true } : {}),
      ...(options.reasoning !== "default"
        ? {
            output_config: {
              ...(request.output_config as Record<string, unknown> | undefined),
              effort: options.reasoning,
            },
          }
        : {}),
    };
    const response = await post(
      this.config,
      call,
      body,
      options.stream,
      signal,
      "anthropic",
      lifecycle,
    );
    let text = "";
    const calls: ModelToolCall[] = [];
    const orderedBlocks: Record<string, unknown>[] = [];
    const acceptThinking = (block: Record<string, unknown>): void => {
      if (
        block.type === "thinking"
          ? typeof block.thinking !== "string" ||
            typeof block.signature !== "string" ||
            !block.signature
          : block.type !== "redacted_thinking" || typeof block.data !== "string"
      )
        throw new AgentFailure("agent-protocol");
    };
    let tokenUsage: AgentUsage;
    let stopReason: string | undefined;
    if (!options.stream) {
      const value = parseJson(response);
      if (
        value.model !== this.model ||
        (value.type !== undefined && value.type !== "message") ||
        (value.role !== undefined && value.role !== "assistant") ||
        !Array.isArray(value.content) ||
        value.content.length === 0 ||
        typeof value.stop_reason !== "string"
      )
        throw new AgentFailure("agent-protocol");
      stopReason = value.stop_reason;
      for (const block of value.content) {
        const item = record(block);
        if (item.type === "text") text += textValue(item.text);
        else if (item.type === "tool_use") {
          if (
            !item.input ||
            typeof item.input !== "object" ||
            Array.isArray(item.input)
          )
            throw new AgentFailure("agent-tool");
          calls.push(
            modelToolCall(
              call,
              item.id,
              textValue(item.name),
              JSON.stringify(item.input),
              calls.length,
              legacy,
            ),
          );
        } else if (
          item.type === "thinking" ||
          item.type === "redacted_thinking"
        )
          acceptThinking(item);
        else throw new AgentFailure("agent-protocol");
        orderedBlocks.push(item);
      }
      tokenUsage = messagesUsage(record(value.usage));
    } else {
      let started = false;
      let stopped = false;
      let messageDeltaSeen = false;
      let indexedStream: boolean | undefined;
      let blockCount = 0;
      let active:
        | {
            index?: number;
            type: "text" | "tool_use" | "thinking" | "redacted_thinking";
            wire: Record<string, unknown>;
            id?: unknown;
            name: string;
            arguments: string;
            initialInput?: Record<string, unknown>;
          }
        | undefined;
      let inputUsage: Record<string, unknown> = {};
      let outputTokens: unknown;
      for (const event of sseEvents(response, false)) {
        const type = event.type;
        if (stopped && type !== "ping")
          throw new AgentFailure("agent-protocol");
        if (type === "message_start") {
          if (started) throw new AgentFailure("agent-protocol");
          const message = record(event.message);
          if (
            (message.model !== undefined && message.model !== this.model) ||
            (message.role !== undefined && message.role !== "assistant")
          )
            throw new AgentFailure("agent-model-mismatch");
          started = true;
          inputUsage = record(message.usage);
        } else if (type === "content_block_start") {
          if (!started || messageDeltaSeen || active)
            throw new AgentFailure("agent-protocol");
          if (event.index === undefined) {
            indexedStream ??= false;
            if (indexedStream) throw new AgentFailure("agent-protocol");
          } else {
            indexedStream ??= true;
            if (
              !indexedStream ||
              !Number.isSafeInteger(event.index) ||
              event.index !== blockCount
            )
              throw new AgentFailure("agent-protocol");
          }
          const block = record(event.content_block);
          if (
            block.type !== "text" &&
            block.type !== "tool_use" &&
            block.type !== "thinking" &&
            block.type !== "redacted_thinking"
          )
            throw new AgentFailure("agent-protocol");
          active = {
            ...(event.index !== undefined
              ? { index: event.index as number }
              : {}),
            type: block.type,
            wire: { ...block },
            name: block.type === "tool_use" ? textValue(block.name) : "",
            arguments: "",
            ...(block.type === "tool_use"
              ? {
                  id: block.id,
                  ...(block.input !== undefined
                    ? { initialInput: record(block.input) }
                    : {}),
                }
              : {}),
          };
          if (block.type === "text" && block.text !== undefined)
            text += textValue(block.text);
        } else if (type === "content_block_delta") {
          if (!active || (indexedStream && event.index !== active.index))
            throw new AgentFailure("agent-protocol");
          const delta = record(event.delta);
          if (delta.type === "text_delta" && active.type === "text") {
            text += textValue(delta.text);
            active.wire.text =
              textValue(active.wire.text ?? "") + textValue(delta.text);
          } else if (
            delta.type === "input_json_delta" &&
            active.type === "tool_use"
          )
            active.arguments += textValue(delta.partial_json);
          else if (
            delta.type === "thinking_delta" &&
            active.type === "thinking"
          )
            active.wire.thinking =
              textValue(active.wire.thinking ?? "") + textValue(delta.thinking);
          else if (
            delta.type === "signature_delta" &&
            active.type === "thinking"
          )
            active.wire.signature =
              textValue(active.wire.signature ?? "") +
              textValue(delta.signature);
          else throw new AgentFailure("agent-protocol");
        } else if (type === "content_block_stop") {
          if (!active || (indexedStream && event.index !== active.index))
            throw new AgentFailure("agent-protocol");
          if (active.type === "tool_use")
            calls.push(
              modelToolCall(
                call,
                active.id,
                active.name,
                active.arguments || JSON.stringify(active.initialInput ?? {}),
                calls.length,
                legacy,
              ),
            );
          if (active.type === "thinking" || active.type === "redacted_thinking")
            acceptThinking(active.wire);
          if (active.type === "tool_use")
            active.wire.input = calls.at(-1)?.arguments;
          orderedBlocks.push(active.wire);
          active = undefined;
          blockCount++;
        } else if (type === "message_delta") {
          if (!started || active || messageDeltaSeen)
            throw new AgentFailure("agent-protocol");
          const delta = record(event.usage);
          outputTokens = delta.output_tokens;
          // A cumulative delta may restate input and cache counts.
          for (const key of [
            "input_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
          ])
            if (delta[key] !== undefined && delta[key] !== null)
              inputUsage = { ...inputUsage, [key]: delta[key] };
          stopReason = textValue(record(event.delta).stop_reason);
          messageDeltaSeen = true;
        } else if (type === "message_stop") {
          if (!started || !messageDeltaSeen || active)
            throw new AgentFailure("agent-protocol");
          stopped = true;
        } else if (type === "error")
          throw new AgentFailure("agent-remote", true);
        else if (type !== "ping") throw new AgentFailure("agent-protocol");
      }
      if (
        !started ||
        !stopped ||
        !messageDeltaSeen ||
        active ||
        !Number.isSafeInteger(inputUsage.input_tokens) ||
        !Number.isSafeInteger(outputTokens)
      )
        throw new AgentFailure("agent-truncated");
      tokenUsage = messagesUsage({
        ...inputUsage,
        output_tokens: outputTokens,
      });
    }
    if (stopReason === "max_tokens") throw new AgentFailure("agent-truncated");
    if (stopReason === "refusal") throw new AgentFailure("agent-refusal");
    if (calls.length && stopReason !== "tool_use")
      throw new AgentFailure("agent-tool");
    if (
      !calls.length &&
      stopReason !== "end_turn" &&
      stopReason !== "stop_sequence"
    )
      throw new AgentFailure("agent-protocol");
    return modelResponse(
      this.provider,
      this.model,
      text,
      calls,
      tokenUsage,
      orderedBlocks.length
        ? {
            provider: this.provider,
            model: this.model,
            format: "anthropic",
            opaque: { blocks: orderedBlocks },
          }
        : undefined,
    );
  }
}
