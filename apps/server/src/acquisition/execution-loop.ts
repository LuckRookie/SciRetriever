import { createHash } from "node:crypto";
import {
  parseOperatorInput,
  type OperatorInput,
} from "@sciretriever/contracts";
import type { BrowserAction } from "../browser/control.js";
import type { BrowserObservation } from "../browser/observation.js";
import { ExecutionPolicy, ExecutionPolicyError } from "./execution-policy.js";

export interface ExecutionRequest<T extends OperatorInput = BrowserAction> {
  readonly request_id: string;
  readonly client_id: string;
  readonly epoch: number;
  readonly observation: BrowserObservation;
  readonly action: T;
}
export type ExecutionResult = "applied" | "duplicate";
export class ExecutionLoopError extends Error {
  readonly code = "execution-loop" as const;
  constructor() {
    super("execution loop operation failed");
    this.name = "ExecutionLoopError";
  }
}
function invalid(): never {
  throw new ExecutionLoopError();
}

export class ExecutionLoop {
  private readonly policy: ExecutionPolicy;
  private readonly epoch: () => number;
  private readonly applied = new Map<
    string,
    { digest: string; completion: Promise<void> }
  >();
  constructor(policy: ExecutionPolicy, epoch: () => number) {
    this.policy = policy;
    this.epoch = epoch;
  }
  async apply<T extends OperatorInput>(
    request: ExecutionRequest<T>,
    execute: (action: T) => Promise<void>,
  ): Promise<ExecutionResult> {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(request.request_id)) invalid();
    const key = JSON.stringify([request.client_id, request.request_id]);
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          epoch: request.epoch,
          page: request.observation.page_id,
          revision: request.observation.revision,
          action: parseOperatorInput(request.action),
        }),
      )
      .digest("hex");
    const previous = this.applied.get(key);
    if (previous) {
      if (previous.digest !== digest) invalid();
      await previous.completion;
      return "duplicate";
    }
    if (this.applied.size >= 4096) invalid();
    if (request.epoch !== this.epoch()) invalid();
    if (request.action.kind !== "stop") {
      if (request.action.revision !== request.observation.revision) invalid();
    }
    try {
      this.policy.consume("action");
    } catch (error) {
      if (error instanceof ExecutionPolicyError) throw error;
      throw new ExecutionLoopError();
    }
    const completion = Promise.resolve().then(() => execute(request.action));
    this.applied.set(key, { digest, completion });
    await completion;
    return "applied";
  }
}
