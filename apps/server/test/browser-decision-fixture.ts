import type {
  BrowserAction,
  WorkbenchObservation,
} from "@sciretriever/contracts";
import type { DshAgentRuntime } from "../src/agents/dsh/runtime.js";
import type { AgentCallLifecycle } from "../src/agents/protocol.js";
import type { BrowserDecisionTarget } from "../src/browser/boundary.js";
import { createBrowserCapability } from "../src/browser/decision.js";

/** One-turn test driver over the real native DSH capability, not a model fallback. */
export function browserDecisionFixture(runtime: DshAgentRuntime) {
  return async (
    observation: WorkbenchObservation,
    frame: Uint8Array | null,
    signal: AbortSignal,
    guidance: readonly string[] = [],
    target?: BrowserDecisionTarget,
    _recent?: unknown,
    feedback: readonly string[] = [],
    lifecycle?: AgentCallLifecycle,
  ): Promise<BrowserAction> => {
    const session = await createBrowserCapability(runtime).open(
      {
        session_id: observation.session_id,
        literature_id: observation.article_id,
      },
      target,
    );
    let action: BrowserAction | undefined;
    try {
      await session.run(
        {
          observation,
          frame,
          guidance,
          feedback,
          admitRequest: () => lifecycle ?? { onDispatched() {} },
          executeAction: async (value) => {
            action = value;
            return { status: "success", code: "applied" };
          },
        },
        signal,
      );
      if (!action) throw new Error("No accepted Browser action");
      return action;
    } finally {
      await session.close();
    }
  };
}
