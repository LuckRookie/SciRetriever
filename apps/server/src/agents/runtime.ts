import {
  AgentFailure,
  type AgentAdapter,
  type AgentCall,
  type AgentCapability,
  type AgentResult,
  type AgentRole,
  type ReasoningEffort,
  validateAgentCall,
} from "./protocol.js";

export interface AgentBinding {
  readonly role: AgentRole;
  readonly provider: string;
  readonly model: string;
  readonly capabilities: readonly AgentCapability[];
  readonly reasoning: ReasoningEffort;
  readonly stream: boolean;
  readonly context_window_tokens: number;
  readonly max_output_tokens: number;
  readonly adapter: AgentAdapter;
}

export class AgentRuntime {
  private readonly bindings: ReadonlyMap<AgentRole, AgentBinding>;
  private closed = false;
  private readonly stop = new AbortController();

  constructor(bindings: readonly AgentBinding[]) {
    if (
      new Set(bindings.map((binding) => binding.role)).size !== bindings.length
    )
      throw new AgentFailure("agent-configuration");
    this.bindings = new Map(
      bindings.map((binding) => [binding.role, binding] as const),
    );
  }

  readiness(role: AgentRole): {
    readonly configured: boolean;
    readonly missing: readonly AgentCapability[];
  } {
    const binding = this.bindings.get(role);
    if (!binding) return { configured: false, missing: [] };
    const required: readonly AgentCapability[] =
      role === "analysis"
        ? ["structured_text"]
        : ["image_input", "tool_decision"];
    return {
      configured: true,
      missing: required.filter(
        (capability) =>
          !binding.capabilities.includes(capability as AgentCapability),
      ),
    };
  }

  identity(
    role: AgentRole,
  ): Pick<
    AgentBinding,
    "role" | "provider" | "model" | "reasoning" | "stream"
  > {
    const binding = this.bindings.get(role);
    if (!binding) throw new AgentFailure("agent-configuration");
    return {
      role: binding.role,
      provider: binding.provider,
      model: binding.model,
      reasoning: binding.reasoning,
      stream: binding.stream,
    };
  }

  async execute(call: AgentCall, signal?: AbortSignal): Promise<AgentResult> {
    if (this.closed) throw new AgentFailure("agent-closed");
    validateAgentCall(call);
    const binding = this.bindings.get(call.role);
    if (!binding) throw new AgentFailure("agent-configuration");
    if (
      call.required_capabilities.some(
        (capability) => !binding.capabilities.includes(capability),
      ) ||
      call.max_output_tokens >
        Math.min(binding.max_output_tokens, binding.context_window_tokens)
    )
      throw new AgentFailure("agent-capability");
    if (signal?.aborted) throw new AgentFailure("agent-cancelled");
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    try {
      const result = await binding.adapter.execute(
        call,
        { reasoning: binding.reasoning, stream: binding.stream },
        active,
      );
      if (active.aborted) throw new AgentFailure("agent-cancelled");
      if (
        result.provenance.provider !== binding.provider ||
        result.provenance.model !== binding.model ||
        result.provenance.usage.input_tokens < 0 ||
        result.provenance.usage.output_tokens < 0 ||
        result.provenance.usage.input_tokens +
          result.provenance.usage.output_tokens >
          binding.context_window_tokens
      )
        throw new AgentFailure("agent-response");
      return result;
    } catch (error) {
      if (active.aborted) throw new AgentFailure("agent-cancelled");
      if (error instanceof AgentFailure) throw error;
      throw new AgentFailure("agent-internal");
    }
  }

  close(): void {
    this.closed = true;
    this.stop.abort();
  }
}
