import {
  AgentFailure,
  type AgentAdapter,
  type AgentCall,
  type AgentResult,
  type ReasoningEffort,
} from "./protocol.js";
import {
  post,
  parseJson,
  requestBody,
  resultText,
  sseEvents,
  toolResult,
  usage,
  type AdapterConfig,
} from "./common.js";

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
  ): Promise<AgentResult> {
    const request = requestBody(call, "anthropic");
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
    );
    let text = "";
    let toolName: string | undefined;
    let argumentsText = "";
    let tokenUsage: { input_tokens: number; output_tokens: number };
    let stopReason: string | undefined;
    let textBlockSeen = false;
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
        if (item.type === "text") {
          if (toolName !== undefined) throw new AgentFailure("agent-tool");
          textBlockSeen = true;
          text += textValue(item.text);
        } else if (item.type === "tool_use") {
          if (toolName !== undefined || textBlockSeen)
            throw new AgentFailure("agent-tool");
          toolName = textValue(item.name);
          if (
            item.input === null ||
            typeof item.input !== "object" ||
            Array.isArray(item.input)
          )
            throw new AgentFailure("agent-tool");
          argumentsText = JSON.stringify(item.input);
        } else throw new AgentFailure("agent-protocol");
      }
      if (toolName !== undefined && stopReason !== "tool_use")
        throw new AgentFailure("agent-tool");
      tokenUsage = usage({
        input_tokens: record(value.usage).input_tokens,
        output_tokens: record(value.usage).output_tokens,
      });
    } else {
      let started = false;
      let stopped = false;
      let messageDeltaSeen = false;
      let activeIndex: number | undefined;
      let activeBlock = false;
      let indexedStream: boolean | undefined;
      let streamTextBlockSeen = false;
      const stoppedIndexes = new Set<number>();
      let inputTokens = 0;
      let outputTokens = 0;
      for (const event of sseEvents(response, false)) {
        const type = event.type;
        if (type === "message_start") {
          if (started || stopped) throw new AgentFailure("agent-protocol");
          const message = record(event.message);
          if (
            (message.model !== undefined && message.model !== this.model) ||
            (message.role !== undefined && message.role !== "assistant")
          )
            throw new AgentFailure("agent-model-mismatch");
          started = true;
          inputTokens = record(message.usage).input_tokens as number;
        } else if (type === "content_block_start") {
          if (!started || messageDeltaSeen || activeBlock)
            throw new AgentFailure("agent-protocol");
          if (event.index === undefined) {
            indexedStream = indexedStream ?? false;
            if (indexedStream) throw new AgentFailure("agent-protocol");
            activeIndex = undefined;
          } else {
            indexedStream = indexedStream ?? true;
            if (
              !indexedStream ||
              !Number.isSafeInteger(event.index) ||
              event.index !== stoppedIndexes.size
            )
              throw new AgentFailure("agent-protocol");
            activeIndex = event.index as number;
            if (stoppedIndexes.has(activeIndex))
              throw new AgentFailure("agent-protocol");
          }
          activeBlock = true;
          const block = record(event.content_block);
          if (block?.type === "tool_use") {
            if (toolName !== undefined || streamTextBlockSeen)
              throw new AgentFailure("agent-tool");
            toolName = textValue(block.name);
          } else if (block?.type === "text") streamTextBlockSeen = true;
          else throw new AgentFailure("agent-protocol");
        } else if (type === "content_block_delta") {
          if (!activeBlock || (indexedStream && event.index !== activeIndex))
            throw new AgentFailure("agent-protocol");
          const delta = record(event.delta);
          if (delta?.type === "text_delta") text += textValue(delta.text);
          else if (delta?.type === "input_json_delta")
            argumentsText += textValue(delta.partial_json);
          else throw new AgentFailure("agent-protocol");
        } else if (type === "content_block_stop") {
          if (!activeBlock || (indexedStream && event.index !== activeIndex))
            throw new AgentFailure("agent-protocol");
          if (activeIndex !== undefined) stoppedIndexes.add(activeIndex);
          activeIndex = undefined;
          activeBlock = false;
        } else if (type === "message_delta") {
          if (!started || activeBlock || messageDeltaSeen || stopped)
            throw new AgentFailure("agent-protocol");
          const deltaUsage = record(event.usage);
          outputTokens = deltaUsage.output_tokens as number;
          const delta = record(event.delta);
          stopReason = textValue(delta.stop_reason);
          messageDeltaSeen = true;
        } else if (type === "message_stop") {
          if (!started || !messageDeltaSeen || activeBlock || stopped)
            throw new AgentFailure("agent-protocol");
          stopped = true;
        } else if (type === "error")
          throw new AgentFailure("agent-remote", true);
        else if (type !== "content_block_stop" && type !== "ping")
          throw new AgentFailure("agent-protocol");
      }
      if (
        !started ||
        !stopped ||
        !messageDeltaSeen ||
        activeIndex !== undefined ||
        !Number.isSafeInteger(inputTokens) ||
        !Number.isSafeInteger(outputTokens)
      )
        throw new AgentFailure("agent-truncated");
      tokenUsage = usage({
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      });
    }
    if (toolName !== undefined && stopReason !== "tool_use")
      throw new AgentFailure("agent-tool");
    if (toolName === undefined && stopReason === "max_tokens")
      throw new AgentFailure("agent-truncated");
    if (
      toolName === undefined &&
      stopReason !== "end_turn" &&
      stopReason !== "stop_sequence"
    )
      throw new AgentFailure("agent-protocol");
    if (toolName !== undefined)
      return toolResult(
        this.provider,
        this.model,
        toolName,
        argumentsText,
        tokenUsage,
        call.tools?.find((tool) => tool.name === toolName)?.parameters,
      );
    return resultText(
      this.provider,
      this.model,
      text,
      tokenUsage,
      call.response_schema,
    );
  }
}
