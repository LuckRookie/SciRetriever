export interface ExecutionBudget {
  readonly max_actions: number;
  readonly max_model_calls: number;
  readonly max_retries: number;
  readonly max_bytes: number;
  readonly deadline_ms: number;
}
export interface ExecutionUsage {
  readonly actions: number;
  readonly model_calls: number;
  readonly retries: number;
  readonly bytes: number;
}
export type ExecutionState =
  | "running"
  | "paused"
  | "cancelled"
  | "exhausted"
  | "finished";
export class ExecutionPolicyError extends Error {
  readonly code = "execution-policy" as const;
  constructor() {
    super("execution policy operation failed");
    this.name = "ExecutionPolicyError";
  }
}
function invalid(): never {
  throw new ExecutionPolicyError();
}
function positive(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) invalid();
}

export class ExecutionPolicy {
  readonly budget: Readonly<ExecutionBudget>;
  readonly source: string;
  readonly version: string;
  private readonly startedAt = Date.now();
  private current: ExecutionState = "running";
  private usageValue: ExecutionUsage = {
    actions: 0,
    model_calls: 0,
    retries: 0,
    bytes: 0,
  };
  constructor(source: string, version: string, budget: ExecutionBudget) {
    if (
      !source ||
      !version ||
      typeof source !== "string" ||
      typeof version !== "string"
    )
      invalid();
    positive(budget.max_actions);
    positive(budget.max_model_calls);
    positive(budget.max_retries);
    positive(budget.max_bytes);
    positive(budget.deadline_ms);
    this.source = source;
    this.version = version;
    this.budget = Object.freeze({ ...budget });
  }
  state(): ExecutionState {
    return this.current;
  }
  usage(): ExecutionUsage {
    return Object.freeze({ ...this.usageValue });
  }
  remaining() {
    return Object.freeze({
      actions: Math.max(0, this.budget.max_actions - this.usageValue.actions),
      model_calls: Math.max(
        0,
        this.budget.max_model_calls - this.usageValue.model_calls,
      ),
      bytes: Math.max(0, this.budget.max_bytes - this.usageValue.bytes),
      deadline_ms: Math.max(
        0,
        this.budget.deadline_ms - (Date.now() - this.startedAt),
      ),
    });
  }
  pause(): void {
    if (this.current === "running") this.current = "paused";
  }
  resume(): void {
    if (this.current === "paused") this.current = "running";
  }
  cancel(): void {
    if (this.current === "running" || this.current === "paused")
      this.current = "cancelled";
  }
  finish(): void {
    if (this.current === "running" || this.current === "paused")
      this.current = "finished";
  }
  consume(kind: "action" | "model_call" | "retry" | "bytes", amount = 1): void {
    if (
      this.current !== "running" ||
      !Number.isSafeInteger(amount) ||
      amount < 1
    )
      invalid();
    if (Date.now() - this.startedAt >= this.budget.deadline_ms) {
      this.current = "exhausted";
      invalid();
    }
    const next = { ...this.usageValue };
    if (kind === "action") next.actions += amount;
    if (kind === "model_call") next.model_calls += amount;
    if (kind === "retry") next.retries += amount;
    if (kind === "bytes") next.bytes += amount;
    if (
      next.actions > this.budget.max_actions ||
      next.model_calls > this.budget.max_model_calls ||
      next.retries > this.budget.max_retries ||
      next.bytes > this.budget.max_bytes
    ) {
      this.current = "exhausted";
      invalid();
    }
    this.usageValue = next;
  }
}
