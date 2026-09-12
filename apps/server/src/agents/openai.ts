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

function string(value: unknown): string {
  if (typeof value !== "string") throw new AgentFailure("agent-protocol");
  return value;
}
function modelUsage(value: Record<string, unknown>): {
  input_tokens: number;
  output_tokens: number;
} {
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
  return usage({
    input_tokens: tokens.input_tokens ?? tokens.prompt_tokens,
    output_tokens: tokens.output_tokens ?? tokens.completion_tokens,
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
function responseOutput(value: Record<string, unknown>): {
  text: string;
  tool?: { name: string; arguments: string };
} {
  const messages: Record<string, unknown>[] = [];
  const calls: Record<string, unknown>[] = [];
  for (const itemValue of value.output as unknown[]) {
    const item = record(itemValue);
    if (item.type === "reasoning") continue;
    if (item.type === "message") messages.push(item);
    else if (item.type === "function_call") calls.push(item);
    else throw new AgentFailure("agent-protocol");
  }
  if (calls.length > 1 || (calls.length === 1 && messages.length > 0))
    throw new AgentFailure("agent-tool");
  if (calls.length === 1) {
    const call = calls[0];
    if (!call) throw new AgentFailure("agent-protocol");
    const name = call.name;
    const args = call.arguments;
    if (typeof name !== "string" || typeof args !== "string")
      throw new AgentFailure("agent-tool");
    return { text: "", tool: { name, arguments: args } };
  }
  const message = messages[0];
  if (!message || messages.length !== 1)
    throw new AgentFailure("agent-protocol");
  if (message.status !== undefined && message.status !== "completed")
    throw new AgentFailure("agent-protocol");
  if (message.role !== undefined && message.role !== "assistant")
    throw new AgentFailure("agent-protocol");
  const content = message.content;
  if (!Array.isArray(content) || content.length !== 1)
    throw new AgentFailure("agent-protocol");
  const part = record(content[0]);
  if (part.type === "refusal") throw new AgentFailure("agent-refusal");
  if (part.type !== "output_text" || typeof part.text !== "string")
    throw new AgentFailure("agent-protocol");
  return { text: part.text };
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
  ): Promise<AgentResult> {
    const body = {
      ...requestBody(call, "openai-responses"),
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
    );
    if (!options.stream) {
      const value = parseJson(response);
      const parsed = completedResponse(value, this.model);
      const output = responseOutput(parsed);
      if (output.tool)
        return toolResult(
          this.provider,
          this.model,
          output.tool.name,
          output.tool.arguments,
          modelUsage(parsed),
          call.tools?.find((tool) => tool.name === output.tool?.name)
            ?.parameters,
        );
      return resultText(
        this.provider,
        this.model,
        output.text,
        modelUsage(parsed),
        call.response_schema,
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
    const outputValue = responseOutput(parsed);
    if (outputValue.tool)
      return toolResult(
        this.provider,
        this.model,
        outputValue.tool.name,
        outputValue.tool.arguments,
        modelUsage(parsed),
        call.tools?.find((tool) => tool.name === outputValue.tool?.name)
          ?.parameters,
      );
    return resultText(
      this.provider,
      this.model,
      outputValue.text,
      modelUsage(parsed),
      call.response_schema,
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
  ): Promise<AgentResult> {
    const body = {
      ...requestBody(call, "openai-chat"),
      ...(options.stream ? { stream_options: { include_usage: true } } : {}),
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
    );
    let text = "";
    let toolName: string | undefined;
    let toolArguments = "";
    let tokenUsage: { input_tokens: number; output_tokens: number };
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
      const message = record(choice.message);
      if (message.role !== undefined && message.role !== "assistant")
        throw new AgentFailure("agent-protocol");
      if (
        message.content !== undefined &&
        typeof message.content !== "string" &&
        message.content !== null
      )
        throw new AgentFailure("agent-protocol");
      if (
        message.tool_calls !== undefined &&
        !Array.isArray(message.tool_calls)
      )
        throw new AgentFailure("agent-protocol");
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 1)
        throw new AgentFailure("agent-tool");
      if (
        Array.isArray(message.tool_calls) &&
        message.tool_calls.length === 1
      ) {
        const tool = message.tool_calls[0] as Record<string, unknown>;
        const functionValue = record(tool.function);
        toolName = string(functionValue.name);
        toolArguments = string(functionValue.arguments);
      }
      if (
        toolName !== undefined &&
        message.content !== undefined &&
        message.content !== null
      )
        throw new AgentFailure("agent-tool");
      if (message.refusal !== undefined && message.refusal !== null)
        throw new AgentFailure("agent-refusal");
      if (typeof message.content === "string") text = message.content;
      if (choice.finish_reason === "length")
        throw new AgentFailure("agent-truncated");
      if (
        !["stop", "tool_calls", "function_call", "content_filter"].includes(
          choice.finish_reason as string,
        ) &&
        choice.finish_reason !== "length"
      )
        throw new AgentFailure("agent-protocol");
      tokenUsage = modelUsage(value);
    } else {
      let terminal = false;
      let terminalCount = 0;
      let usageCount = 0;
      let choiceIndex: number | undefined;
      let toolId: string | undefined;
      let toolCount = 0;
      let usageValue: unknown;
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
        const choice =
          Array.isArray(chunk.choices) && chunk.choices.length === 1
            ? record(chunk.choices[0])
            : undefined;
        if (terminal && choice) throw new AgentFailure("agent-protocol");
        if (Array.isArray(chunk.choices) && chunk.choices.length > 1)
          throw new AgentFailure("agent-protocol");
        if (choice && choice.index !== undefined && choice.index !== null) {
          if (
            !Number.isSafeInteger(choice.index) ||
            (choiceIndex !== undefined && choice.index !== choiceIndex)
          )
            throw new AgentFailure("agent-protocol");
          choiceIndex = choice.index as number;
        }
        const delta =
          choice?.delta === undefined ? undefined : record(choice.delta);
        if (typeof delta?.content === "string") text += delta.content;
        const calls = delta?.tool_calls;
        if (Array.isArray(calls) && calls.length > 1)
          throw new AgentFailure("agent-tool");
        if (Array.isArray(calls) && calls.length === 1) {
          const tool = record(calls[0]);
          if (
            tool.index !== undefined &&
            (!Number.isSafeInteger(tool.index) || tool.index !== 0)
          )
            throw new AgentFailure("agent-tool");
          if (tool.id !== undefined) {
            const id = string(tool.id);
            if (toolId !== undefined && id !== toolId)
              throw new AgentFailure("agent-tool");
            toolId = id;
          }
          toolCount += 1;
          if (toolCount > 1 && toolId === undefined)
            throw new AgentFailure("agent-tool");
          const functionValue = record(tool.function);
          if (functionValue.name !== undefined)
            toolName = string(functionValue.name);
          if (functionValue.arguments !== undefined)
            toolArguments += string(functionValue.arguments);
        }
        if (
          choice?.finish_reason !== undefined &&
          choice.finish_reason !== null
        ) {
          if (terminal) throw new AgentFailure("agent-protocol");
          terminal = true;
          terminalCount += 1;
          if (choice.finish_reason === "length")
            throw new AgentFailure("agent-truncated");
          if (
            !["stop", "tool_calls", "function_call", "content_filter"].includes(
              String(choice.finish_reason),
            )
          )
            throw new AgentFailure("agent-protocol");
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          if (!terminal) throw new AgentFailure("agent-protocol");
          usageCount += 1;
          if (usageCount > 1) throw new AgentFailure("agent-protocol");
          if (
            chunk.choices === undefined ||
            !Array.isArray(chunk.choices) ||
            chunk.choices.length !== 0
          )
            throw new AgentFailure("agent-protocol");
          usageValue = chunk.usage;
        } else if (Array.isArray(chunk.choices) && chunk.choices.length === 0) {
          throw new AgentFailure("agent-protocol");
        }
      }
      if (terminalCount !== 1 || usageValue === undefined)
        throw new AgentFailure("agent-truncated");
      tokenUsage = modelUsage({ usage: usageValue });
    }
    if (toolName !== undefined) {
      if (text) throw new AgentFailure("agent-tool");
      return toolResult(
        this.provider,
        this.model,
        toolName,
        toolArguments,
        tokenUsage,
        call.tools?.find((tool) => tool.name === toolName)?.parameters,
      );
    }
    return resultText(
      this.provider,
      this.model,
      text,
      tokenUsage,
      call.response_schema,
    );
  }
}
