import { randomUUID } from "node:crypto";
import { activityContext } from "../../logging/activity.js";
import type { AgentTraceRecorder, AgentTraceSubject } from "../trace.js";
import { tracedSession } from "../traced-session.js";
import {
  createDshCapabilityRuntime,
  type DshExecutionRuntime,
} from "./index.js";
import type {
  AgentSessionRequest,
  AgentCapabilitySession,
} from "../capability.js";
import {
  type ModelRequest,
  type ModelResponse,
  validateModelRequest,
} from "../model-protocol.js";
import {
  AgentFailure,
  type AgentAdapter,
  type AgentCall,
  type AgentCallLifecycle,
  type AgentCapability,
  type AgentResult,
  type AgentRole,
  type ReasoningEffort,
  validateAgentCall,
} from "../protocol.js";

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
  /** Effective non-secret wire target; credentials never enter a method identity. */
  readonly nonsecret_transport?: {
    readonly api: string;
    readonly endpoint: string;
  };
}

/** Configuration-facing facade over the sole DSH execution foundation. */
export class DshAgentRuntime {
  private readonly bindings: ReadonlyMap<AgentRole, AgentBinding>;
  private closed = false;
  private readonly stop = new AbortController();
  private backend: Promise<DshExecutionRuntime> | undefined;
  private closing: Promise<void> | undefined;
  private readonly active = new Set<Promise<unknown>>();
  private readonly sessions = new Set<AgentCapabilitySession>();
  private track<T>(operation: Promise<T>): Promise<T> {
    this.active.add(operation);
    void operation
      .finally(() => this.active.delete(operation))
      .catch(() => undefined);
    return operation;
  }

  constructor(
    bindings: readonly AgentBinding[],
    private readonly traces?: AgentTraceRecorder,
  ) {
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
      role === "browser"
        ? ["image_input", "tool_decision"]
        : role === "proofreading"
          ? ["structured_text", "image_input", "tool_decision"]
          : ["structured_text"];
    return {
      configured: true,
      missing: required.filter(
        (capability) =>
          !binding.capabilities.includes(capability as AgentCapability),
      ),
    };
  }

  supports(role: AgentRole, capability: AgentCapability): boolean {
    return this.bindings.get(role)?.capabilities.includes(capability) ?? false;
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

  effectiveIdentity(role: AgentRole): {
    readonly provider: string;
    readonly model: string;
    readonly reasoning: ReasoningEffort;
    readonly stream: boolean;
    readonly context_window_tokens: number;
    readonly max_output_tokens: number;
    readonly transport: AgentBinding["nonsecret_transport"] | null;
  } {
    const binding = this.bindings.get(role);
    if (!binding) throw new AgentFailure("agent-configuration");
    return {
      provider: binding.provider,
      model: binding.model,
      reasoning: binding.reasoning,
      stream: binding.stream,
      context_window_tokens: binding.context_window_tokens,
      max_output_tokens: binding.max_output_tokens,
      transport: binding.nonsecret_transport ?? null,
    };
  }

  execute(
    call: AgentCall,
    signal?: AbortSignal,
    lifecycle?: AgentCallLifecycle,
  ): Promise<AgentResult> {
    return this.track(this.executeTraced(call, signal, lifecycle));
  }
  private async executeTraced(
    call: AgentCall,
    signal?: AbortSignal,
    lifecycle?: AgentCallLifecycle,
  ): Promise<AgentResult> {
    if (this.closed) throw new AgentFailure("agent-closed");
    validateAgentCall(call);
    const trace = await this.traces?.start({
      session_id: `${call.role}-${randomUUID()}`,
      ...this.identity(call.role),
      context: activityContext(),
      subject: { kind: activityContext().operation ?? call.role },
    });
    try {
      if (this.stop.signal.aborted || signal?.aborted)
        throw new AgentFailure("agent-cancelled");
      trace?.event("input", {
        messages: call.messages.filter((m) => m.role !== "system"),
      });
      const result = await this.executeBound(
        call,
        signal,
        async (binding, active) =>
          (await this.foundation()).call({
            request: call,
            ...(trace
              ? {
                  observeEvent: (
                    event: import("@sciretriever/contracts").AgentConversationEvent,
                  ) => trace.event(event.event_type, event),
                }
              : {}),
            provider: binding.provider,
            model: binding.model,
            context_window_tokens: binding.context_window_tokens,
            signal: active,
            invoke: (signal) =>
              binding.adapter.execute(
                call,
                { reasoning: binding.reasoning, stream: binding.stream },
                signal,
                {
                  onDispatched: () => {
                    lifecycle?.onDispatched();
                    trace?.usage(1, 0, 0);
                  },
                },
              ),
          }),
      );
      trace?.usage(
        0,
        result.provenance.usage.input_tokens,
        result.provenance.usage.output_tokens,
      );
      trace?.event(
        "submission",
        result.kind === "structured"
          ? result.value
          : { name: result.name, arguments: result.arguments },
      );
      await trace?.finish("completed");
      return result;
    } catch (error) {
      await trace?.finish(
        signal?.aborted || this.stop.signal.aborted ? "cancelled" : "failed",
      );
      throw error;
    }
  }

  async executeModel(
    request: ModelRequest,
    signal?: AbortSignal,
    lifecycle?: AgentCallLifecycle,
  ): Promise<ModelResponse> {
    if (this.closed) throw new AgentFailure("agent-closed");
    validateModelRequest(request);
    return this.executeBound(request, signal, async (binding, active) => {
      const invoke = binding.adapter.executeModel?.bind(binding.adapter);
      if (!invoke) throw new AgentFailure("agent-capability");
      return (await this.foundation()).call({
        request,
        provider: binding.provider,
        model: binding.model,
        context_window_tokens: binding.context_window_tokens,
        signal: active,
        invoke: (signal) =>
          invoke(
            request,
            { reasoning: binding.reasoning, stream: binding.stream },
            signal,
            lifecycle,
          ),
      });
    });
  }

  private executeBound<T extends Pick<AgentResult, "provenance">>(
    call: Pick<
      AgentCall,
      "role" | "required_capabilities" | "max_output_tokens"
    >,
    signal: AbortSignal | undefined,
    execute: (binding: AgentBinding, active: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.track(this.runBound(call, signal, execute));
  }

  private async runBound<T extends Pick<AgentResult, "provenance">>(
    call: Pick<
      AgentCall,
      "role" | "required_capabilities" | "max_output_tokens"
    >,
    signal: AbortSignal | undefined,
    execute: (binding: AgentBinding, active: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new AgentFailure("agent-closed");
    const binding = this.bindings.get(call.role);
    if (!binding) throw new AgentFailure("agent-configuration");
    if (
      call.required_capabilities.some(
        (capability) => !binding.capabilities.includes(capability),
      ) ||
      (call.max_output_tokens !== undefined &&
        call.max_output_tokens >
          Math.min(binding.max_output_tokens, binding.context_window_tokens))
    )
      throw new AgentFailure("agent-capability");
    if (signal?.aborted) throw new AgentFailure("agent-cancelled");
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    if (active.aborted) throw new AgentFailure("agent-cancelled");
    try {
      const result = await execute(binding, active);
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
      throw new AgentFailure("agent-internal", false, { cause: error });
    }
  }

  createSession(
    request: AgentSessionRequest & { readonly trace?: AgentTraceSubject },
  ): Promise<AgentCapabilitySession> {
    return this.track(this.openSession(request));
  }
  private async openSession(
    request: AgentSessionRequest & { readonly trace?: AgentTraceSubject },
  ): Promise<AgentCapabilitySession> {
    if (this.closed) throw new AgentFailure("agent-closed");
    const binding = this.bindings.get(request.role);
    if (!binding) throw new AgentFailure("agent-configuration");
    if (
      !binding.adapter.executeModel ||
      (request.tools.length && !binding.capabilities.includes("tool_decision"))
    )
      throw new AgentFailure("agent-capability");
    const backend = await this.foundation();
    if (this.closed) throw new AgentFailure("agent-closed");
    const { trace: subject, ...sessionRequest } = request;
    const trace = await this.traces?.start({
      session_id: request.id,
      role: request.role,
      provider: binding.provider,
      model: binding.model,
      context: activityContext(),
      subject: subject ?? {},
    });
    let session: AgentCapabilitySession;
    try {
      session = await backend.createSession({
        ...sessionRequest,
        ...(trace
          ? {
              observeEvent: (
                event: import("@sciretriever/contracts").AgentConversationEvent,
              ) => trace.event(event.event_type, event),
            }
          : {}),
        modelContext: {
          ...this.effectiveIdentity(request.role),
          capabilities: binding.capabilities,
        },
        modelCall: (call, signal, lifecycle) => {
          validateModelRequest(call);
          // Already dispatched by DSH's session LlmRuntime; enter the protocol adapter directly.
          return this.executeBound(call, signal, (model, active) => {
            const invoke = model.adapter.executeModel?.bind(model.adapter);
            if (!invoke) throw new AgentFailure("agent-capability");
            return invoke(
              call,
              { reasoning: model.reasoning, stream: model.stream },
              active,
              lifecycle,
            );
          });
        },
      });
    } catch (error) {
      await trace?.finish("failed");
      throw error;
    }
    const observed = trace ? tracedSession(session, trace) : session;
    let closing: Promise<void> | undefined;
    const wrapped: AgentCapabilitySession = {
      id: observed.id,
      append: (input) => observed.append(input),
      run: (input, options) => observed.run(input, options),
      compact: (options) => observed.compact(options),
      history: () => observed.history(),
      close: () =>
        (closing ??= (async () => {
          try {
            await observed.close();
          } finally {
            this.sessions.delete(wrapped);
          }
        })()),
    };
    this.sessions.add(wrapped);
    if (this.closed) {
      await wrapped.close();
      throw new AgentFailure("agent-closed");
    }
    return wrapped;
  }

  private foundation(): Promise<DshExecutionRuntime> {
    if (this.closed) return Promise.reject(new AgentFailure("agent-closed"));
    return (this.backend ??= createDshCapabilityRuntime());
  }

  close(): Promise<void> {
    this.closed = true;
    this.stop.abort();
    return (this.closing ??= (async () => {
      const backend = this.backend ? await this.backend : undefined;
      await backend?.close();
      await Promise.allSettled([...this.active]);
      await Promise.allSettled(
        [...this.sessions].map((session) => session.close()),
      );
    })());
  }
}
