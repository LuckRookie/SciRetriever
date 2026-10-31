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

function string(value: unknown): string {
  if (typeof value !== "string") throw new AgentFailure("agent-protocol");
  return value;
}
/** Optional detail counter: absent or null reads as unreported. */
function detail(container: unknown, key: string): number | undefined {
  if (container === undefined || container === null) return undefined;
  const value = record(container)[key];
  return value === undefined || value === null ? undefined : (value as number);
}
function modelUsage(value: Record<string, unknown>): AgentUsage {
  const tokens = record(value.usage);
  if (
    tokens.prompt_tokens !== undefined &&
    tokens.input_tokens !== undefined &&
    tokens.prompt_tokens !== tokens.input_tokens
  )
    throw new AgentFailure("agent-response");
  if (
    tokens.completion_tokens !== undefined &&
    tokens.output_tokens !== undefined &&
    tokens.completion_tokens !== tokens.output_tokens
  )
    throw new AgentFailure("agent-response");
  // Responses and Chat report cache reads inside the prompt total; DeepSeek's
  // Chat API names them prompt_cache_hit_tokens.
  const input = tokens.input_tokens_details ?? tokens.prompt_tokens_details,
    output = tokens.output_tokens_details ?? tokens.completion_tokens_details,
    cached =
      detail(input, "cached_tokens") ??
      detail(tokens, "prompt_cache_hit_tokens"),
    written = detail(input, "cache_write_tokens"),
    reasoning = detail(output, "reasoning_tokens");
  return usage({
    input_tokens: tokens.input_tokens ?? tokens.prompt_tokens,
    output_tokens: tokens.output_tokens ?? tokens.completion_tokens,
    ...(cached === undefined ? {} : { cached_input_tokens: cached }),
    ...(written === undefined ? {} : { cache_write_tokens: written }),
    ...(reasoning === undefined ? {} : { reasoning_tokens: reasoning }),
  });
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new AgentFailure("agent-protocol");
  return value as Record<string, unknown>;
}
function completedResponse(
  value: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  if (value.object !== undefined && value.object !== "response")
    throw new AgentFailure("agent-protocol");
  if (value.status === "incomplete") throw new AgentFailure("agent-truncated");
  if (value.status === "failed") throw new AgentFailure("agent-remote", true);
  if (value.status !== undefined && value.status !== "completed")
    throw new AgentFailure("agent-protocol");
  if (value.model !== model) throw new AgentFailure("agent-model-mismatch");
  if (!Array.isArray(value.output)) throw new AgentFailure("agent-protocol");
  return value;
}
function responseOutput(
  value: Record<string, unknown>,
  request: ModelRequest,
  legacy: boolean,
): {
  text: string;
  calls: ModelToolCall[];
  items: Record<string, unknown>[];
} {
  let text = "";
  const calls: ModelToolCall[] = [];
  const items: Record<string, unknown>[] = [];
  for (const itemValue of value.output as unknown[]) {
    const item = record(itemValue);
    items.push(item);
    if (item.type === "reasoning") continue;
    if (item.type === "function_call") {
      if (item.status !== undefined && item.status !== "completed")
        throw new AgentFailure("agent-protocol");
      calls.push(
        modelToolCall(
          request,
          item.call_id,
          string(item.name),
          string(item.arguments),
          calls.length,
          legacy,
        ),
      );
    } else if (item.type === "message") {
      if (
        (item.status !== undefined && item.status !== "completed") ||
        (item.role !== undefined && item.role !== "assistant") ||
        !Array.isArray(item.content)
      )
        throw new AgentFailure("agent-protocol");
      for (const partValue of item.content) {
        const part = record(partValue);
        if (part.type === "refusal") throw new AgentFailure("agent-refusal");
        if (part.type !== "output_text")
          throw new AgentFailure("agent-protocol");
        text += string(part.text);
      }
    } else throw new AgentFailure("agent-protocol");
  }
  return { text, calls, items };
}

export class OpenAIResponsesAdapter implements AgentAdapter {
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
    validateModelContinuations(
      call,
      this.provider,
      this.model,
      "openai-responses",
    );
    const body = {
      ...modelRequestBody(call, "openai-responses"),
      ...(!legacy ? { include: ["reasoning.encrypted_content"] } : {}),
      ...(call.cache_key === undefined
        ? {}
        : { prompt_cache_key: call.cache_key }),
      model: this.model,
      ...(options.stream ? { stream: true } : {}),
      ...(options.reasoning !== "default"
        ? { reasoning: { effort: options.reasoning } }
        : {}),
    };
    const response = await post(
      this.config,
      call,
      body,
      options.stream,
      signal,
      "openai-responses",
      lifecycle,
    );
    if (!options.stream) {
      const value = parseJson(response);
      const parsed = completedResponse(value, this.model);
      const output = responseOutput(parsed, call, legacy);
      return modelResponse(
        this.provider,
        this.model,
        output.text,
        output.calls,
        modelUsage(parsed),
        output.items.length
          ? {
              provider: this.provider,
              model: this.model,
              format: "openai-responses",
              opaque: { items: output.items },
            }
          : undefined,
      );
    }
    let terminal: Record<string, unknown> | undefined;
    let terminalSeen = false;
    const completedItems: Record<string, unknown>[] = [];
    const completedTexts = new Map<string, string>();
    for (const event of sseEvents(response, "optional")) {
      if (terminalSeen) throw new AgentFailure("agent-protocol");
      if (event.type === "response.output_text.delta") string(event.delta);
      else if (event.type === "response.output_text.done") {
        const key = `${event.output_index}:${event.content_index}`;
        if (completedTexts.has(key) || typeof event.text !== "string")
          throw new AgentFailure("agent-protocol");
        completedTexts.set(key, event.text);
      } else if (event.type === "response.output_item.done") {
        if (
          !Number.isSafeInteger(event.output_index) ||
          completedItems.some((item) => item.__index === event.output_index)
        )
          throw new AgentFailure("agent-protocol");
        const item = record(event.item);
        completedItems.push({ ...item, __index: event.output_index });
      } else if (
        event.type === "response.completed" ||
        event.type === "response.failed" ||
        event.type === "response.incomplete"
      ) {
        if (terminalSeen) throw new AgentFailure("agent-protocol");
        if (event.type === "response.failed")
          throw new AgentFailure("agent-remote", true);
        if (event.type === "response.incomplete")
          throw new AgentFailure("agent-truncated");
        terminal = record(event.response);
        terminalSeen = true;
      } else if (event.type === "error") throw new AgentFailure("agent-remote");
      else if (
        typeof event.type !== "string" ||
        (event.type !== "keepalive" && !event.type.startsWith("response."))
      )
        throw new AgentFailure("agent-protocol");
    }
    if (!terminal) throw new AgentFailure("agent-truncated");
    const output = terminal.output;
    if (
      Array.isArray(output) &&
      output.length === 0 &&
      completedItems.length > 0
    )
      terminal = {
        ...terminal,
        output: completedItems
          .sort((a, b) => Number(a.__index) - Number(b.__index))
          .map((item) => {
            const copy = { ...item };
            delete copy.__index;
            return copy;
          }),
      };
    if (
      Array.isArray(terminal.output) &&
      terminal.output.length === 0 &&
      completedTexts.size === 1
    )
      terminal = {
        ...terminal,
        output: [
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              { type: "output_text", text: [...completedTexts.values()][0] },
            ],
          },
        ],
      };
    const parsed = completedResponse(terminal, this.model);
    const outputValue = responseOutput(parsed, call, legacy);
    return modelResponse(
      this.provider,
      this.model,
      outputValue.text,
      outputValue.calls,
      modelUsage(parsed),
      outputValue.items.length
        ? {
            provider: this.provider,
            model: this.model,
            format: "openai-responses",
            opaque: { items: outputValue.items },
          }
        : undefined,
    );
  }
}

export class OpenAIChatAdapter implements AgentAdapter {
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
    validateModelContinuations(call, this.provider, this.model, "openai-chat");
    const body = {
      ...modelRequestBody(call, "openai-chat"),
      ...(options.stream ? { stream_options: { include_usage: true } } : {}),
      // Other Chat-compatible services may reject the field; headers carry affinity there.
      ...(call.cache_key !== undefined &&
      new URL(this.config.endpoint).hostname === "api.openai.com"
        ? { prompt_cache_key: call.cache_key }
        : {}),
      model: this.model,
      ...(options.stream ? { stream: true } : {}),
      ...(options.reasoning !== "default"
        ? { reasoning_effort: options.reasoning }
        : {}),
    };
    const response = await post(
      this.config,
      call,
      body,
      options.stream,
      signal,
      "openai-chat",
      lifecycle,
    );
    let text = "";
    let reasoningContent: string | undefined;
    let finishReason: string | undefined;
    const calls: ModelToolCall[] = [];
    let tokenUsage: AgentUsage;
    const finish = (reason: unknown): void => {
      finishReason = String(reason);
      if (reason === "length") throw new AgentFailure("agent-truncated");
      if (reason === "content_filter") throw new AgentFailure("agent-refusal");
      if (!["stop", "tool_calls", "function_call"].includes(String(reason)))
        throw new AgentFailure("agent-protocol");
    };
    if (!options.stream) {
      const value = parseJson(response);
      if (
        value.model !== this.model ||
        !Array.isArray(value.choices) ||
        value.choices.length !== 1
      )
        throw new AgentFailure("agent-protocol");
      const choice = record(value.choices[0]);
      if (choice.index !== undefined && choice.index !== 0)
        throw new AgentFailure("agent-protocol");
      if (typeof choice.finish_reason !== "string" || !choice.finish_reason)
        throw new AgentFailure("agent-truncated");
      finish(choice.finish_reason);
      const message = record(choice.message);
      if (message.role !== undefined && message.role !== "assistant")
        throw new AgentFailure("agent-protocol");
      if (message.refusal !== undefined && message.refusal !== null)
        throw new AgentFailure("agent-refusal");
      if (
        message.reasoning_content !== undefined &&
        message.reasoning_content !== null
      )
        reasoningContent = string(message.reasoning_content);
      if (message.content !== undefined && message.content !== null)
        text = string(message.content);
      if (
        message.tool_calls !== undefined &&
        !Array.isArray(message.tool_calls)
      )
        throw new AgentFailure("agent-protocol");
      for (const toolValue of (message.tool_calls ?? []) as unknown[]) {
        const tool = record(toolValue);
        if (tool.type !== undefined && tool.type !== "function")
          throw new AgentFailure("agent-tool");
        const fn = record(tool.function);
        calls.push(
          modelToolCall(
            call,
            tool.id,
            string(fn.name),
            string(fn.arguments),
            calls.length,
            legacy,
          ),
        );
      }
      tokenUsage = modelUsage(value);
    } else {
      let terminal = false;
      let usageValue: unknown;
      const chunks = new Map<
        number,
        { id?: string; name: string; arguments: string; count: number }
      >();
      for (const chunk of sseEvents(response)) {
        if (
          chunk.object !== undefined &&
          chunk.object !== "chat.completion.chunk"
        )
          throw new AgentFailure("agent-protocol");
        if (chunk.model !== undefined && chunk.model !== this.model)
          throw new AgentFailure("agent-model-mismatch");
        if (chunk.choices !== undefined && !Array.isArray(chunk.choices))
          throw new AgentFailure("agent-protocol");
        if (Array.isArray(chunk.choices) && chunk.choices.length > 1)
          throw new AgentFailure("agent-protocol");
        const choice =
          Array.isArray(chunk.choices) && chunk.choices.length === 1
            ? record(chunk.choices[0])
            : undefined;
        if (terminal && choice) throw new AgentFailure("agent-protocol");
        if (
          choice?.index !== undefined &&
          choice.index !== null &&
          choice.index !== 0
        )
          throw new AgentFailure("agent-protocol");
        const delta =
          choice?.delta === undefined ? undefined : record(choice.delta);
        if (delta?.role !== undefined && delta.role !== "assistant")
          throw new AgentFailure("agent-protocol");
        if (delta?.refusal !== undefined && delta.refusal !== null)
          throw new AgentFailure("agent-refusal");
        if (
          delta?.reasoning_content !== undefined &&
          delta.reasoning_content !== null
        )
          reasoningContent =
            (reasoningContent ?? "") + string(delta.reasoning_content);
        if (delta?.content !== undefined && delta.content !== null)
          text += string(delta.content);
        if (delta?.tool_calls !== undefined && !Array.isArray(delta.tool_calls))
          throw new AgentFailure("agent-tool");
        for (const toolValue of (delta?.tool_calls ?? []) as unknown[]) {
          const tool = record(toolValue);
          const index = tool.index ?? (legacy ? 0 : undefined);
          if (
            !Number.isSafeInteger(index) ||
            (index as number) < 0 ||
            (index as number) > 63
          )
            throw new AgentFailure("agent-tool");
          const item = chunks.get(index as number) ?? {
            name: "",
            arguments: "",
            count: 0,
          };
          if (tool.id !== undefined) {
            const id = string(tool.id);
            if (item.id !== undefined && item.id !== id)
              throw new AgentFailure("agent-tool");
            item.id = id;
          }
          item.count++;
          if (legacy && item.count > 1 && item.id === undefined)
            throw new AgentFailure("agent-tool");
          if (tool.type !== undefined && tool.type !== "function")
            throw new AgentFailure("agent-tool");
          const fn = record(tool.function);
          if (fn.name !== undefined) {
            const name = string(fn.name);
            if (item.name && item.name !== name)
              throw new AgentFailure("agent-tool");
            item.name = name;
          }
          if (fn.arguments !== undefined)
            item.arguments += string(fn.arguments);
          chunks.set(index as number, item);
        }
        if (
          choice?.finish_reason !== undefined &&
          choice.finish_reason !== null
        ) {
          terminal = true;
          finish(choice.finish_reason);
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          if (
            !terminal ||
            usageValue !== undefined ||
            !Array.isArray(chunk.choices) ||
            chunk.choices.length !== 0
          )
            throw new AgentFailure("agent-protocol");
          usageValue = chunk.usage;
        } else if (Array.isArray(chunk.choices) && chunk.choices.length === 0)
          throw new AgentFailure("agent-protocol");
      }
      if (!terminal || usageValue === undefined)
        throw new AgentFailure("agent-truncated");
      for (const [index, item] of [...chunks.entries()].sort(
        ([a], [b]) => a - b,
      )) {
        if (index !== calls.length) throw new AgentFailure("agent-tool");
        calls.push(
          modelToolCall(
            call,
            item.id,
            item.name,
            item.arguments,
            index,
            legacy,
          ),
        );
      }
      tokenUsage = modelUsage({ usage: usageValue });
    }
    if (
      calls.length
        ? finishReason !== "tool_calls" && finishReason !== "function_call"
        : finishReason !== "stop"
    )
      throw new AgentFailure("agent-tool");
    return modelResponse(
      this.provider,
      this.model,
      text,
      calls,
      tokenUsage,
      reasoningContent !== undefined
        ? {
            provider: this.provider,
            model: this.model,
            format: "openai-chat",
            opaque: { reasoning_content: reasoningContent },
          }
        : undefined,
    );
  }
}
