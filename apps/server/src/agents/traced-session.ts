import type {
  AgentCapabilitySession,
  AgentCapabilityAdmission,
  AgentCapabilityRunOptions,
} from "./capability.js";
import type { AgentTraceSink } from "./trace.js";

/** Observe the existing DSH loop; no extra model turns or execution decisions. */
export function tracedSession(
  session: AgentCapabilitySession,
  trace: AgentTraceSink,
): AgentCapabilitySession {
  let status = "interrupted";
  const admission = (
    options: AgentCapabilityAdmission,
  ): AgentCapabilityAdmission => ({
    ...options,
    admitRequest: async (request, signal) => {
      const hooks = await options.admitRequest(request, signal);
      return {
        ...hooks,
        onRequest: (model) => {
          hooks.onRequest?.(model);
          trace.event("model-request", {
            request_id: request.request_id,
            purpose: request.purpose,
          });
        },
        onDispatched: () => {
          hooks.onDispatched();
          trace.usage(1, 0, 0);
        },
        onUsage: (usage) => {
          hooks.onUsage?.(usage);
          trace.usage(0, usage.input_tokens, usage.output_tokens);
        },
      };
    },
  });
  const tools = (
    options: AgentCapabilityRunOptions,
  ): AgentCapabilityRunOptions => ({
    ...admission(options),
    executeTool: async (call, context) => {
      const start = performance.now();
      trace.event("tool-start", {
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
      await trace.flush();
      try {
        const result = await options.executeTool(call, context);
        trace.event("tool-result", {
          call_id: call.id,
          name: call.name,
          status: result.status,
          parts: result.parts,
          elapsed_ms: Math.round(performance.now() - start),
        });
        await trace.flush();
        return result;
      } catch (error) {
        trace.event("tool-failed", {
          call_id: call.id,
          name: call.name,
          elapsed_ms: Math.round(performance.now() - start),
        });
        await trace.flush();
        throw error;
      }
    },
  });
  return {
    id: session.id,
    append: (input) => session.append(input),
    history: () => session.history(),
    run: async (input, options) => {
      trace.event("input", input);
      await trace.flush();
      try {
        const result = await session.run(input, tools(options));
        status = result.status;
        await trace.flush();
        return result;
      } catch (error) {
        status = options.signal?.aborted ? "cancelled" : "failed";
        throw error;
      }
    },
    compact: async (options) => {
      try {
        return await session.compact(admission(options));
      } finally {
        await trace.flush();
      }
    },
    close: async () => {
      try {
        await session.close();
      } finally {
        await trace.finish(status);
      }
    },
  };
}
