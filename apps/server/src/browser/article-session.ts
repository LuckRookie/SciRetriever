import type { BrowserActivityLog } from "./activity.js";
import type {
  DurableCandidate,
  MetadataSnapshot,
  WorkbenchArticlePhase,
  WorkbenchArticleCloseOutcome,
} from "@sciretriever/contracts";
import type { BrowserAgentEvent } from "./decision.js";
import type { BrowserDeliveryResult } from "./boundary.js";

/** Immutable article ownership; foreground selection is never an ownership signal. */
export interface BrowserArticleSessionIdentity {
  readonly session_id: string;
  readonly operation_id: string;
  readonly generation: number;
  readonly literature_id: string;
  readonly metadata_snapshot: MetadataSnapshot;
  /** Title from the same frozen neutral metadata used to build article_goal. */
  readonly title?: string;
}

/** Browser runtime phases, not persistent Literature or acquisition result states. */
export type BrowserArticleSessionPhase = WorkbenchArticlePhase;

export type BrowserArticleCloseOutcome = WorkbenchArticleCloseOutcome;

export type BrowserArticleNetworkEndOutcome = {
  readonly kind: "completed" | "cancelled" | "failure" | "runtime-failure";
};

/**
 * Internal handoff retained after candidate delivery. Entry closes it after the
 * ordinary acceptance/publication path settles. Closing releases article resources;
 * it never abandons the delivered durable candidate or rolls back publication.
 */
export interface BrowserArticleDeliveryLease {
  readonly session_id: string;
  /** Article lifetime through local acceptance; optional for legacy delivery seams. */
  readonly signal?: AbortSignal;
  close(outcome: BrowserArticleCloseOutcome): Promise<void>;
}

export type BrowserArticleStepResult =
  | {
      readonly kind: "waiting";
      readonly reason: "pacing" | "page" | "human-control";
      readonly delay_ms?: number;
    }
  | { readonly kind: "suspended"; readonly transfer_id: string }
  | {
      readonly kind: "candidate";
      readonly candidate: DurableCandidate;
      readonly accepted: true;
      readonly lease: BrowserArticleDeliveryLease;
    }
  | {
      readonly kind: "terminal";
      readonly result: Exclude<
        BrowserDeliveryResult,
        { readonly kind: "delivered" }
      >;
    };

/** Internal article execution port; callers receive no page or vendor handle. */
export interface BrowserArticleExecution extends BrowserArticleDeliveryLease {
  readonly identity: BrowserArticleSessionIdentity;
  readonly clock: BrowserArticleClock;
  readonly activity?: BrowserActivityLog;
  phase(): BrowserArticleSessionPhase;
  /** Exact software-selected entry while its pre-model navigation is in flight. */
  preparationTarget?(): string | null;
  step(): Promise<BrowserArticleStepResult>;
  /** Event/deadline wake-up for Broker; this is not an observation polling loop. */
  changed(signal: AbortSignal): Promise<void>;
  transferStarted(transferId: string): void;
  transferCompleted(transferId: string): void;
  transferFailed(transferId: string, code: string): void;
  /** Source already contains an admitted candidate; this carries no second fact. */
  candidateReady(): void;
  candidateRejected(code: string): void;
  /** Broker re-enables the retained page only after reacquiring platform eligibility. */
  setNetworkAccess(allowed: boolean): void;
  /** Revoke a late decision on human takeover/release without cancelling a transfer. */
  controlEpochChanged(): void;
  /** Accepted human/control events join this article's ephemeral Agent context. */
  recordAgentEvent?(event: BrowserAgentEvent): void;
  /** Cancels this article's outstanding work; other article sessions are untouched. */
  cancel(): void;
  /** A real 429 parks this article under the shared platform policy. */
  rateLimited(): void;
}

export interface BrowserArticleBudget {
  readonly active_ms: number;
  readonly max_model_calls: number;
  /** Legacy explicit override; automatic articles only bound time and calls. */
  readonly max_actions?: number;
  readonly min_decision_interval_ms: number;
}

export const DEFAULT_BROWSER_ARTICLE_BUDGET: Readonly<BrowserArticleBudget> =
  Object.freeze({
    active_ms: 300_000,
    max_model_calls: 30,
    min_decision_interval_ms: 5_000,
  });

export type BrowserArticleActiveReason =
  | "inference"
  | "action"
  | "page-wait"
  | "pacing";

export interface BrowserArticleBudgetRemaining {
  /** Projection for the existing observation contract, not a wall-clock deadline. */
  readonly deadline_ms: number;
  readonly model_calls: number;
  /** Compatibility projection, not an independent default action budget. */
  readonly actions: number;
}

export interface BrowserArticleClockSnapshot {
  readonly active_elapsed_ms: number;
  readonly remaining_ms: number;
  readonly model_calls: number;
  readonly actions: number;
  /** Uses the clock's monotonic time base; never compare it with Date.now(). */
  readonly next_decision_at: number;
  readonly active: boolean;
}

export class BrowserArticleBudgetError extends Error {
  readonly code = "browser-flow-budget-exhausted" as const;

  constructor(readonly resource: "active-time" | "model-calls" | "actions") {
    super("Browser article budget exhausted");
    this.name = "BrowserArticleBudgetError";
  }
}

/**
 * One article's monotonic active-time and Agent counters. The session owner starts
 * explicit inference/action/page-wait/pacing intervals. Worker or model-permit
 * queues, platform cooldown, human control, download and local publication never
 * start an interval. Overlapping intervals count their union, including nested
 * intervals with the same reason.
 *
 * This clock owns no phase, timer, page, cancellation signal or network permit.
 */
export class BrowserArticleClock {
  readonly budget: Readonly<BrowserArticleBudget>;
  private readonly now: () => number;
  private lastRead: number;
  private activeSince: number | null = null;
  private elapsed = 0;
  private readonly intervals = new Set<number>();
  private readonly exclusions = new Set<number>();
  private readonly activityListeners = new Set<() => void>();
  private nextInterval = 0;
  private modelCalls = 0;
  private actions = 0;
  private nextDecisionAt = 0;

  constructor(
    options: {
      readonly now?: () => number;
      readonly budget?: BrowserArticleBudget;
    } = {},
  ) {
    const budget = options.budget ?? DEFAULT_BROWSER_ARTICLE_BUDGET;
    if (
      [
        budget.active_ms,
        budget.max_model_calls,
        ...(budget.max_actions === undefined ? [] : [budget.max_actions]),
      ].some((value) => !Number.isSafeInteger(value) || value < 1) ||
      !Number.isSafeInteger(budget.min_decision_interval_ms) ||
      budget.min_decision_interval_ms < 0
    )
      throw new TypeError("invalid Browser article budget");
    this.budget = Object.freeze({ ...budget });
    this.now = options.now ?? (() => performance.now());
    this.lastRead = this.now();
    if (!Number.isFinite(this.lastRead) || this.lastRead < 0)
      throw new TypeError("invalid Browser article monotonic clock");
  }

  /** Returns an idempotent end handle; a suspend makes outstanding handles inert. */
  beginActive(reason: BrowserArticleActiveReason): () => void {
    if (!["inference", "action", "page-wait", "pacing"].includes(reason))
      throw new TypeError("invalid Browser article activity");
    const at = this.readNow();
    this.requireActiveTime(at);
    if (this.intervals.size === 0 && this.exclusions.size === 0) {
      this.activeSince = at;
      this.activityChanged();
    }
    const id = ++this.nextInterval;
    this.intervals.add(id);
    return () => {
      if (!this.intervals.delete(id)) return;
      if (this.intervals.size === 0) {
        this.settleActive(this.readNow());
        this.activityChanged();
      }
    };
  }

  /** Platform/model queues exclude time while preserving the active work handles. */
  exclude(): () => void {
    const at = this.readNow();
    if (this.exclusions.size === 0) this.settleActive(at);
    const id = ++this.nextInterval;
    this.exclusions.add(id);
    this.activityChanged();
    return () => {
      if (!this.exclusions.delete(id)) return;
      if (this.exclusions.size === 0 && this.intervals.size > 0)
        this.activeSince = this.readNow();
      this.activityChanged();
    };
  }

  /** The session owner uses activity changes to arm its one budget timer. */
  onActivityChanged(listener: () => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  /** End active work on suspension without resetting elapsed time or counters. */
  suspend(): void {
    const at = this.readNow();
    this.settleActive(at);
    this.intervals.clear();
    this.exclusions.clear();
    this.activityChanged();
  }

  /** Called immediately before a real model request is sent, after permit queues. */
  recordModelDispatch(): void {
    this.requireActiveTime(this.readNow());
    if (this.modelCalls >= this.budget.max_model_calls)
      throw new BrowserArticleBudgetError("model-calls");
    this.modelCalls += 1;
  }

  /**
   * Called for a validated Agent action; internal observation/wait is not an action.
   * An already-completed input still records its fact after revocation or expiry.
   */
  recordAgentAction(completed = false): void {
    if (!completed) this.requireActiveTime(this.readNow());
    if (
      this.budget.max_actions !== undefined &&
      this.actions >= this.budget.max_actions
    )
      throw new BrowserArticleBudgetError("actions");
    this.actions += 1;
  }

  /** Feedback waiting and this interval run together, rather than adding two waits. */
  actionFinished(): void {
    this.nextDecisionAt = this.readNow() + this.budget.min_decision_interval_ms;
  }

  decisionDelayMs(): number {
    return Math.max(0, this.nextDecisionAt - this.readNow());
  }

  remaining(): BrowserArticleBudgetRemaining {
    const at = this.readNow();
    return Object.freeze({
      deadline_ms: this.remainingActive(at),
      model_calls: Math.max(0, this.budget.max_model_calls - this.modelCalls),
      actions: Math.max(
        0,
        (this.budget.max_actions ?? this.budget.max_model_calls) - this.actions,
      ),
    });
  }

  snapshot(): BrowserArticleClockSnapshot {
    const at = this.readNow();
    return Object.freeze({
      active_elapsed_ms: this.activeElapsed(at),
      remaining_ms: this.remainingActive(at),
      model_calls: this.modelCalls,
      actions: this.actions,
      next_decision_at: this.nextDecisionAt,
      active: this.activeSince !== null,
    });
  }

  private activityChanged(): void {
    for (const listener of this.activityListeners) listener();
  }

  private readNow(): number {
    const at = this.now();
    if (!Number.isFinite(at) || at < this.lastRead)
      throw new TypeError("Browser article clock must be monotonic");
    this.lastRead = at;
    return at;
  }

  private activeElapsed(at: number): number {
    return (
      this.elapsed + (this.activeSince === null ? 0 : at - this.activeSince)
    );
  }

  private remainingActive(at: number): number {
    return Math.max(
      0,
      Math.ceil(this.budget.active_ms - this.activeElapsed(at)),
    );
  }

  private requireActiveTime(at: number): void {
    if (this.activeElapsed(at) >= this.budget.active_ms)
      throw new BrowserArticleBudgetError("active-time");
  }

  private settleActive(at: number): void {
    if (this.activeSince !== null) this.elapsed += at - this.activeSince;
    this.activeSince = null;
  }
}
