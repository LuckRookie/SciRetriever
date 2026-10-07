import type {
  DurableCandidate,
  OperatorInput,
  WorkbenchObservation,
} from "@sciretriever/contracts";
import {
  parseBrowserAction,
  parseWorkbenchObservation,
} from "@sciretriever/contracts";
import { BrowserObservationStore } from "./observation.js";
import type { BrowserPageSnapshot } from "./observation.js";
import type { BrowserPageHandle } from "./host.js";
import type { BrowserCaptureBatchItem } from "./capture-batch.js";
import type { AgentCallLifecycle } from "../agents/protocol.js";
import {
  BrowserArticleBudgetError,
  BrowserArticleClock,
  DEFAULT_BROWSER_ARTICLE_BUDGET,
  type BrowserArticleActiveReason,
  type BrowserArticleCloseOutcome,
  type BrowserArticleExecution,
  type BrowserArticleNetworkEndOutcome,
  type BrowserArticleSessionIdentity,
  type BrowserArticleSessionPhase,
  type BrowserArticleStepResult,
} from "./article-session.js";
import {
  DEFAULT_BROWSER_AGENT_ACTION_COOLDOWN_MS,
  DEFAULT_BROWSER_AGENT_CHALLENGE_WAIT_MS,
  DEFAULT_BROWSER_AGENT_PDF_WAIT_FOR_CHANGE_MS,
  DEFAULT_BROWSER_AGENT_WAIT_FOR_CHANGE_MS,
  validateBrowserAgentCooldown,
} from "./pacing.js";
import {
  browserRefused,
  type BrowserArticleFlow,
  type BrowserDecisionTarget,
  type BrowserDeliveryRequest,
  type BrowserDeliveryResult,
} from "./boundary.js";

/**
 * The bounded automatic article flow.
 *
 * This is the production driver behind `BrowserSessionHost.deliverCandidate`: it opens
 * (or is handed) one admitted Browser page, then runs a strictly bounded
 * observation/decision/action loop until the model stops or the action budget or the
 * caller's signal ends it. Everything it touches is injectable, so the whole driver can
 * be exercised offline with a fake page and a scripted decision function — no Browser
 * process, profile, Cloak bundle or Provider is involved in tests.
 *
 * It deliberately owns no delivery semantics: bytes are spooled by the Intake owner
 * through the host's transfer callbacks, and the resulting `DurableCandidate` is read
 * back with `awaitCandidate`. The driver never invents a candidate, never returns an
 * empty success, and never reports a refusal as a delivery.
 */

/** The page surface the driver needs. Structural so a fake can satisfy it. */
export interface FlowPageHandle {
  snapshot(): Promise<BrowserPageSnapshot>;
  settleCaptures?(): Promise<void>;
  retryRateLimit?(signal: AbortSignal, deadlineAt: number): Promise<boolean>;
  apply(
    input: OperatorInput,
    documentGeneration: number,
    current: () => boolean,
  ): Promise<unknown>;
  /** Activates and returns a popup/viewer that became the article successor. */
  successor?(): Promise<FlowPageHandle | null>;
  navigate?(url: string): Promise<void>;
}

/**
 * One candidate the Intake owner spooled during the flow. The driver only forwards it:
 * bytes, hashing and identity assessment all happen behind the Intake boundary.
 */
export type SpooledArticleCandidate = BrowserCaptureBatchItem;

/** A decision function: one closed Browser action for one observation. */
export type FlowDecision = (
  observation: WorkbenchObservation,
  frame: Uint8Array | null,
  signal: AbortSignal,
  guidance?: readonly string[],
  target?: BrowserDecisionTarget,
  recentActions?: readonly OperatorInput[],
  feedback?: readonly string[],
  lifecycle?: AgentCallLifecycle,
) => Promise<unknown>;
export type CollaborativeStepResult =
  | "applied"
  | "retry"
  | "stopped"
  | "budget"
  | "cancelled"
  | "invalid-action";

export interface BrowserArticleFlowOptions {
  readonly page?: BrowserPageHandle | FlowPageHandle;
  /** Omitted only when the caller already knows the page is on the admitted start URL. */
  readonly start_url?: string;
  readonly decide: FlowDecision | undefined;
  /** When present, the production workbench owns both model and human dispatch. */
  readonly collaborativeStep?: (
    signal: AbortSignal,
  ) => Promise<CollaborativeStepResult>;
  readonly useCollaborativeStep?: () => boolean;
  /** Actions still allowed; the loop stops as soon as this reaches zero. */
  readonly max_actions: number;
  /** Model calls still allowed; bounds an unproductive loop as well as actions. */
  readonly max_model_calls: number;
  /** Cumulative active-time budget; queued permits and downloads are excluded. */
  readonly deadline_ms: number;
  /** Legacy standalone seam; production uses the injected monotonic session clock. */
  readonly started_at: number;
  /**
   * Sanitizing observation owner. It derives URL, page state and cleaned elements from
   * the raw snapshot, so the driver never has to hand-build a wire observation.
   */
  readonly observations?: BrowserObservationStore;
  readonly signal: AbortSignal;
  /** Cancels this article's opening/admission work without aborting its cohort. */
  readonly onCancel?: () => void;
  /** Revokes an initial page open before its page lifecycle has been returned. */
  readonly onClosing?: () => void;
  readonly article_id: string;
  readonly session_id: string;
  readonly identity: BrowserArticleSessionIdentity;
  readonly clock?: BrowserArticleClock;
  /** Standalone scripted tests count at invocation; production uses transport events. */
  readonly dispatch_tracking?: "transport" | "test-seam";
  readonly automatic?: BrowserArticleAutomaticContext;
  readonly onNetworkEnded?: (
    identity: BrowserArticleSessionIdentity,
    outcome: BrowserArticleNetworkEndOutcome,
  ) => void | Promise<void>;
  /**
   * The article owner's full close: owned pages, native writers and requests have
   * ended before this resolves. A confirmed close supersedes a failed cooperative
   * stop; standalone drivers without an owner must retain that stop failure.
   */
  readonly close?: (outcome: BrowserArticleCloseOutcome) => Promise<void>;
  /**
   * Reads the spooled candidate the transfer pipeline produced, if any. Supplied by the
   * Intake owner; the driver never inspects bytes itself.
   */
  readonly awaitCandidate: (
    signal: AbortSignal,
  ) => Promise<SpooledArticleCandidate | null>;
  /**
   * Non-blocking check for an already-captured candidate. When the PDF response or
   * download settles during the initial page open, the flow must end on that candidate
   * instead of asking the model for another action and risking a viewer snapshot failure
   * that would mask it.
   */
  readonly hasCandidate?: () => boolean;
  /**
   * Retires an unusable spooled candidate after file acceptance rejects it.
   * Valid candidates are retained independently of article identity verification.
   */
  readonly abandonCandidate?: (
    candidate: DurableCandidate,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly now?: () => number;
  /** Minimum action-to-decision interval, overlapping page feedback waiting. */
  readonly action_cooldown_ms?: number;
}

export interface BrowserArticleFlowResult {
  readonly actions: number;
  readonly stopped_reason:
    | "stopped"
    | "blocked"
    | "no-progress"
    | "budget"
    | "cancelled"
    | "invalid-action"
    | "unavailable-observation"
    | "no-candidate";
}

export class BrowserArticleCloseError extends Error {
  readonly code = "browser-flow-close-failed" as const;
  constructor(cause: unknown) {
    super("Browser article page cleanup failed", { cause });
  }
}

/**
 * Runs one bounded article flow. Returns the flow result; the caller turns it into a
 * delivery result. Throws only for a programming error or an unexpected driver failure,
 * never to signal "no candidate".
 */
export class BrowserArticleFlowDriver implements BrowserArticleExecution {
  readonly identity: BrowserArticleSessionIdentity;
  readonly clock: BrowserArticleClock;
  readonly session_id: string;
  get signal(): AbortSignal {
    return this.options.signal;
  }
  private page: FlowPageHandle | null;
  private resumePage: FlowPageHandle | null = null;
  private phaseValue: BrowserArticleSessionPhase;
  private generation = 0;
  private epoch = 0;
  private transferId: string | null = null;
  private recentActions: OperatorInput[] = [];
  private feedback: string[] = [];
  private previousObservationIdentity: string | null = null;
  private previousActionIdentity: string | null = null;
  private decisionAbort: AbortController | null = null;
  private pendingFeedback: Promise<void> | null = null;
  private pendingPacing: ReturnType<typeof setTimeout> | undefined;
  private budgetTimer: ReturnType<typeof setTimeout> | undefined;
  private networkAllowed = true;
  private setNetworkAccessCallback: ((allowed: boolean) => void) | undefined;
  private stopNetworkCallback: (() => Promise<void>) | undefined;
  private networkStopping: Promise<void> | null = null;
  private networkEndOutcome: BrowserArticleNetworkEndOutcome | null = null;
  private networkEndedSuccessfully = false;
  private networkCleanupError: unknown;
  private terminalResult: Exclude<
    BrowserDeliveryResult,
    { kind: "delivered" }
  > | null = null;
  private stoppedReason: BrowserArticleFlowResult["stopped_reason"] = "stopped";
  private closePromise: Promise<void> | undefined;
  private stepping = false;
  private wakeVersion = 0;
  private lastStepVersion = 0;
  private readonly waiters = new Set<() => void>();
  private delivered: SpooledArticleCandidate | null = null;
  /** A failed file attempt cannot become normal exhaustion merely through Agent Stop. */
  private unresolvedCaptureFailure: string | null = null;
  private rateLimitPending = false;
  private rateLimitRetried = false;
  private readonly onOperationAbort: () => void;
  private readonly unsubscribeClock: () => void;

  constructor(private readonly options: BrowserArticleFlowOptions) {
    const cooldownMs =
      options.action_cooldown_ms ?? DEFAULT_BROWSER_AGENT_ACTION_COOLDOWN_MS;
    validateBrowserAgentCooldown(cooldownMs);
    this.clock =
      options.clock ??
      new BrowserArticleClock({
        ...(options.now ? { now: options.now } : {}),
        budget: {
          active_ms: Math.max(1, options.deadline_ms),
          max_model_calls: Math.max(1, options.max_model_calls),
          max_actions: Math.max(1, options.max_actions),
          min_decision_interval_ms: cooldownMs,
        },
      });
    this.identity = options.identity;
    this.session_id = this.identity.session_id;
    this.unsubscribeClock = this.clock.onActivityChanged(() =>
      this.updateBudgetTimer(),
    );
    this.page = options.page ?? null;
    this.resumePage = this.page;
    this.phaseValue = this.page ? "ready" : "queued";
    this.onOperationAbort = () => this.stop("cancelled");
    options.signal.addEventListener("abort", this.onOperationAbort, {
      once: true,
    });
    if (options.signal.aborted) this.onOperationAbort();
  }

  /** Called once by the flow owner after navigation; session binding predates it. */
  attachPage(opened: {
    readonly page: FlowPageHandle;
    readonly session_id?: string;
    readonly setNetworkAccess?: (allowed: boolean) => void;
    readonly stopNetwork?: () => Promise<void>;
  }): void {
    if (
      (opened.session_id !== undefined &&
        opened.session_id !== this.session_id) ||
      this.page !== null
    )
      throw new TypeError("Browser article page identity mismatch");
    this.page = opened.page;
    this.resumePage ??= opened.page;
    this.setNetworkAccessCallback = opened.setNetworkAccess;
    this.stopNetworkCallback = opened.stopNetwork;
    this.setNetworkAccessCallback?.(this.networkAllowed);
    if (this.phaseValue === "queued") this.phaseValue = "ready";
    if (this.options.hasCandidate?.() === true) this.candidateReady();
    if (this.networkEndOutcome !== null)
      this.endNetwork(this.networkEndOutcome);
    this.notify();
  }

  phase(): BrowserArticleSessionPhase {
    return this.phaseValue;
  }

  setNetworkAccess(allowed: boolean): void {
    if (this.phaseValue === "closed" && allowed)
      throw new TypeError("Browser article is closed");
    if (allowed && !this.networkAllowed) {
      this.networkEndOutcome = null;
      this.networkStopping = null;
      this.networkEndedSuccessfully = false;
    }
    this.networkAllowed = allowed;
    this.setNetworkAccessCallback?.(allowed);
    if (allowed) this.notify();
  }

  transferStarted(transferId: string): void {
    if (
      this.phaseValue === "closed" ||
      this.phaseValue === "closing" ||
      this.phaseValue === "candidate-ready" ||
      (this.transferId !== null && this.transferId !== transferId)
    )
      return;
    if (this.transferId === transferId) return;
    this.transferId = transferId;
    this.resumePage ??= this.page;
    this.phaseValue = "downloading";
    this.revokeDecision();
    this.suspendActive();
    this.notify();
  }

  transferCompleted(transferId: string): void {
    if (this.transferId !== transferId || this.phaseValue !== "downloading")
      return;
    this.phaseValue = "validating";
    this.suspendActive();
    this.endNetwork({ kind: "completed" });
    this.notify();
  }

  transferFailed(transferId: string, code: string): void {
    if (
      this.transferId !== transferId ||
      this.phaseValue === "closed" ||
      this.phaseValue === "closing" ||
      this.phaseValue === "candidate-ready"
    )
      return;
    this.transferId = null;
    this.unresolvedCaptureFailure = stableCaptureFailureCode(code);
    if (isLocalCaptureFailure(this.unresolvedCaptureFailure)) {
      this.fail(this.unresolvedCaptureFailure);
      return;
    }
    this.restore(this.unresolvedCaptureFailure);
    this.endNetwork({ kind: "failure" });
  }

  candidateReady(): void {
    if (
      this.phaseValue === "closed" ||
      this.phaseValue === "closing" ||
      this.phaseValue === "candidate-ready"
    )
      return;
    this.unresolvedCaptureFailure = null;
    this.phaseValue = "candidate-ready";
    this.revokeDecision();
    this.suspendActive();
    this.endNetwork({ kind: "completed" });
    this.notify();
  }

  candidateRejected(code: string): void {
    if (
      this.phaseValue === "closed" ||
      this.phaseValue === "closing" ||
      this.delivered !== null
    )
      return;
    this.transferId = null;
    this.unresolvedCaptureFailure = stableCaptureFailureCode(code);
    if (isLocalCaptureFailure(this.unresolvedCaptureFailure)) {
      this.fail(this.unresolvedCaptureFailure);
      return;
    }
    this.restore(this.unresolvedCaptureFailure);
    this.endNetwork({ kind: "failure" });
  }

  controlEpochChanged(): void {
    if (this.phaseValue === "closed" || this.phaseValue === "closing") return;
    this.revokeDecision();
    this.suspendActive();
    if (
      this.phaseValue !== "downloading" &&
      this.phaseValue !== "validating" &&
      this.phaseValue !== "candidate-ready"
    )
      this.phaseValue = "ready";
    this.notify();
  }

  cancel(): void {
    this.stop("cancelled");
    this.options.onCancel?.();
  }

  rateLimited(): void {
    if (
      [
        "closed",
        "closing",
        "candidate-ready",
        "downloading",
        "validating",
      ].includes(this.phaseValue)
    )
      return;
    if (this.rateLimitRetried) {
      this.fail("browser-rate-limited");
      return;
    }
    if (this.rateLimitPending) return;
    this.rateLimitPending = true;
    this.restore("browser-rate-limited");
    this.endNetwork({ kind: "completed" });
  }

  /**
   * The saved version closes the step-return / waiter-registration race. Timers
   * and callbacks only wake the owning session; Broker decides who claims it next.
   */
  changed(signal: AbortSignal): Promise<void> {
    if (
      signal.aborted ||
      this.wakeVersion !== this.lastStepVersion ||
      this.isRunnable()
    ) {
      this.lastStepVersion = this.wakeVersion;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finish = () => {
        this.waiters.delete(finish);
        signal.removeEventListener("abort", finish);
        this.lastStepVersion = this.wakeVersion;
        resolve();
      };
      this.waiters.add(finish);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted || this.wakeVersion !== this.lastStepVersion) finish();
    });
  }

  async step(): Promise<BrowserArticleStepResult> {
    if (this.stepping) return { kind: "waiting", reason: "page" };
    this.lastStepVersion = this.wakeVersion;
    this.stepping = true;
    try {
      const result = await this.oneStep();
      this.lastStepVersion = this.wakeVersion;
      return result;
    } catch (error) {
      if (this.options.signal.aborted) this.stop("cancelled");
      else if (this.options.hasCandidate?.() === true) this.candidateReady();
      else if (
        stableBrowserFlowFailureCode(error) === "browser-rate-limited" &&
        this.options.onNetworkEnded !== undefined
      )
        this.rateLimited();
      else if (error instanceof BrowserArticleBudgetError) this.stop("budget");
      else if (
        this.phaseValue !== "downloading" &&
        this.phaseValue !== "validating" &&
        this.phaseValue !== "candidate-ready"
      )
        this.fail(stableBrowserFlowFailureCode(error));
      return this.currentResult();
    } finally {
      this.stepping = false;
      if (this.isRunnable()) this.notify();
    }
  }

  /** Standalone sequential wrapper; production Broker calls step() instead. */
  async run(): Promise<BrowserArticleFlowResult> {
    for (;;) {
      const result = await this.step();
      if (result.kind === "candidate")
        return {
          actions: this.clock.snapshot().actions,
          stopped_reason: "stopped",
        };
      if (result.kind === "terminal")
        return {
          actions: this.clock.snapshot().actions,
          stopped_reason: this.stoppedReason,
        };
      await this.changed(this.options.signal);
    }
  }

  async candidate(): Promise<{
    readonly transfer_id: string;
    readonly accepted: boolean;
  } | null> {
    return this.delivered ?? this.options.awaitCandidate(this.options.signal);
  }

  async spooledCandidate(
    signal: AbortSignal,
    waitForMissing = true,
  ): Promise<SpooledArticleCandidate | null> {
    if (this.delivered !== null) return this.delivered;
    if (!waitForMissing && this.options.hasCandidate?.() !== true) return null;
    return this.options.awaitCandidate(signal);
  }

  close(outcome: BrowserArticleCloseOutcome): Promise<void> {
    this.closePromise ??= (async () => {
      this.phaseValue = "closing";
      this.options.onClosing?.();
      this.revokeDecision();
      this.suspendActive();
      this.endNetwork({
        kind: outcome.kind === "cancelled" ? "cancelled" : "completed",
      });
      this.options.signal.removeEventListener("abort", this.onOperationAbort);
      this.unsubscribeClock();
      const errors: unknown[] = [];
      try {
        await this.networkStopping;
        let ownedCloseConfirmed = false;
        try {
          if (this.options.close) {
            await this.options.close(outcome);
            ownedCloseConfirmed = true;
          }
        } catch (error) {
          errors.push(error);
        }
        if (!ownedCloseConfirmed && this.networkCleanupError !== undefined)
          errors.unshift(this.networkCleanupError);
        if (errors.length)
          throw new BrowserArticleCloseError(
            errors.length === 1
              ? errors[0]
              : new AggregateError(errors, "Browser article cleanup failed"),
          );
      } finally {
        this.phaseValue = "closed";
        this.notify();
      }
    })();
    return this.closePromise;
  }

  private async oneStep(): Promise<BrowserArticleStepResult> {
    if (this.options.hasCandidate?.() === true && this.terminalResult === null)
      this.candidateReady();
    if (
      this.phaseValue === "downloading" ||
      this.phaseValue === "validating" ||
      this.phaseValue === "candidate-ready" ||
      this.terminalResult !== null
    )
      return this.currentResult();
    if (this.options.signal.aborted) {
      this.stop("cancelled");
      return this.currentResult();
    }
    const requestedStop = this.options.automatic?.stopReason?.();
    if (requestedStop) {
      this.stop(requestedStop);
      return this.currentResult();
    }
    if (
      this.options.max_actions === 0 ||
      this.options.max_model_calls === 0 ||
      this.options.deadline_ms === 0 ||
      this.clock.remaining().deadline_ms === 0 ||
      this.clock.remaining().actions === 0 ||
      this.clock.remaining().model_calls === 0
    ) {
      this.stop("budget");
      return this.currentResult();
    }
    if (!this.page || !this.networkAllowed)
      return { kind: "waiting", reason: "page" };
    if (this.options.automatic?.canDecide() === false) {
      this.suspendActive();
      return { kind: "waiting", reason: "human-control" };
    }
    if (this.pendingFeedback !== null)
      return { kind: "waiting", reason: "page" };
    const delay = this.clock.decisionDelayMs();
    if (delay > 0) {
      this.ensurePacing();
      return { kind: "waiting", reason: "pacing", delay_ms: delay };
    }
    if (
      this.options.collaborativeStep &&
      this.options.useCollaborativeStep?.() !== false
    ) {
      const result = await this.options.collaborativeStep(this.options.signal);
      if (result === "stopped") this.stop("stopped");
      else if (result !== "applied" && result !== "retry") this.stop(result);
      return this.currentResult();
    }
    if (!this.options.decide) {
      this.stop("no-candidate");
      return this.currentResult();
    }
    const expectedEpoch = this.epoch;
    const controlEpoch = this.options.automatic?.controlEpoch() ?? 0;
    const current = () =>
      !this.options.signal.aborted &&
      this.epoch === expectedEpoch &&
      this.phaseValue !== "downloading" &&
      this.phaseValue !== "validating" &&
      this.phaseValue !== "candidate-ready" &&
      this.phaseValue !== "closing" &&
      this.phaseValue !== "closed" &&
      (this.options.automatic?.controlEpoch() ?? 0) === controlEpoch &&
      this.options.automatic?.canDecide() !== false;
    const page = this.page;
    if (this.rateLimitPending) {
      if (!page.retryRateLimit) {
        this.fail("browser-rate-limited");
        return this.currentResult();
      }
      const retryAbort = new AbortController();
      this.decisionAbort = retryAbort;
      this.rateLimitPending = false;
      this.rateLimitRetried = true;
      const resume = this.clock.exclude();
      try {
        const retried = await interruptible(
          page.retryRateLimit(
            retryAbort.signal,
            Date.now() + this.clock.remaining().deadline_ms,
          ),
          retryAbort.signal,
        );
        if (retried.kind === "aborted" || !current())
          return this.currentResult();
        if (!retried.value) {
          this.fail("browser-rate-limited");
          return this.currentResult();
        }
      } finally {
        resume();
        if (this.decisionAbort === retryAbort) this.decisionAbort = null;
      }
    }
    const endObservation = this.beginActive("page-wait");
    let snapshot: BrowserPageSnapshot;
    try {
      snapshot = await page.snapshot();
    } catch (error) {
      if (!current()) return this.currentResult();
      if (isPageTransitionError(error) || isPageRuntimeError(error)) {
        const successor = await page.successor?.().catch(() => null);
        if (successor) this.usePage(successor);
        this.scheduleFeedback(
          {
            kind: "wait-for-change",
            revision: 1,
            timeout_ms: DEFAULT_BROWSER_AGENT_WAIT_FOR_CHANGE_MS,
          },
          false,
        );
        return { kind: "waiting", reason: "page" };
      }
      throw error;
    } finally {
      endObservation();
    }
    if (!current()) return this.currentResult();
    if (this.options.hasCandidate?.() === true) {
      this.candidateReady();
      return this.currentResult();
    }
    this.generation = snapshot.document_generation ?? this.generation;
    if (
      (snapshot.loading || snapshot.partial) &&
      (snapshot.text?.trim() ?? "") === "" &&
      (snapshot.elements?.length ?? 0) === 0
    ) {
      this.scheduleFeedback(
        {
          kind: "wait-for-change",
          timeout_ms: DEFAULT_BROWSER_AGENT_WAIT_FOR_CHANGE_MS,
          revision: 1,
        },
        false,
      );
      return { kind: "waiting", reason: "page" };
    }
    const store = this.options.observations;
    if (!store) {
      this.stop("unavailable-observation");
      return this.currentResult();
    }
    const pageId =
      "id" in page && typeof page.id === "string"
        ? page.id
        : this.session_id + "-page";
    const observed = await store.observe(this.options.article_id, pageId, {
      snapshot: async () => snapshot,
    });
    const observation = toWireObservation(
      observed,
      this.options,
      this.clock,
      pageId,
      controlEpoch,
    );
    if (!current()) return this.currentResult();
    this.options.automatic?.onObservation?.(observation, observed.frame, page);
    const abort = new AbortController();
    this.decisionAbort = abort;
    this.phaseValue = "deciding";
    let endInference: (() => void) | undefined;
    let dispatched = false;
    const lifecycle: AgentCallLifecycle = {
      onDispatched: () => {
        if (dispatched)
          throw new TypeError("Browser decision dispatched twice");
        if (!current() || abort.signal.aborted)
          throw new DOMException("Browser decision revoked", "AbortError");
        this.clock.recordModelDispatch();
        this.options.automatic?.onDispatched?.();
        dispatched = true;
        endInference = this.beginActive("inference");
      },
    };
    try {
      // This is an explicit scripted-call seam. Production open() sets transport.
      if ((this.options.dispatch_tracking ?? "test-seam") === "test-seam")
        lifecycle.onDispatched();
      const decision = this.options.decide(
        observation,
        snapshot.screenshot,
        abort.signal,
        this.options.automatic?.guidance() ?? [],
        undefined,
        this.recentActions.slice(-6),
        this.feedback,
        lifecycle,
      );
      const result = await interruptible(decision, abort.signal);
      endInference?.();
      endInference = undefined;
      if (result.kind === "aborted" || !current()) return this.currentResult();
      if (this.options.hasCandidate?.() === true) {
        this.candidateReady();
        return this.currentResult();
      }
      if (this.clock.remaining().deadline_ms === 0) {
        this.stop("budget");
        return this.currentResult();
      }
      const parsed = parseActionOrNull(result.value);
      if (parsed === null) {
        this.stop("invalid-action");
        return this.currentResult();
      }
      if (
        parsed.kind === "click-point" &&
        (parsed.x >= observation.viewport.width ||
          parsed.y >= observation.viewport.height)
      ) {
        this.feedback = [
          "ClickPoint was rejected before dispatch: coordinates must be inside " +
            observation.viewport.width +
            " x " +
            observation.viewport.height +
            " CSS pixels. Choose current visible coordinates or an element.",
        ];
        this.phaseValue = "ready";
        return { kind: "waiting", reason: "page" };
      }
      if (parsed.kind === "stop") {
        this.clock.recordAgentAction();
        this.stop(
          observation.page_state !== "NORMAL" ||
            (snapshot.http_status !== undefined &&
              snapshot.http_status !== 200) ||
            (!observation.title.trim() &&
              !observation.text.trim() &&
              observation.elements.length === 0)
            ? "blocked"
            : parsed.reason === "budget"
              ? "budget"
              : parsed.reason === "cancel"
                ? "cancelled"
                : "stopped",
        );
        return this.currentResult();
      }
      const observationIdentity = stableObservationIdentity(observation);
      const actionIdentity = stableActionIdentity(parsed);
      const repeated =
        parsed.kind !== "wait-for-change" &&
        observationIdentity === this.previousObservationIdentity &&
        actionIdentity === this.previousActionIdentity;
      if (repeated) {
        this.feedback = [
          "Repeated input was suppressed; WaitForChange was executed instead. Inspect the page before choosing another action.",
        ];
        this.scheduleFeedback(
          {
            kind: "wait-for-change",
            revision: observation.observation_revision,
            timeout_ms:
              observation.page_state === "CHALLENGE"
                ? DEFAULT_BROWSER_AGENT_CHALLENGE_WAIT_MS
                : DEFAULT_BROWSER_AGENT_WAIT_FOR_CHANGE_MS,
          },
          false,
        );
        return { kind: "waiting", reason: "page" };
      }
      const input = parsed;
      if (input.kind === "wait-for-change") {
        this.recentActions.push(input);
        this.scheduleFeedback(input, true);
        return { kind: "waiting", reason: "page" };
      }
      const endAction = this.beginActive("action");
      let applied: unknown;
      try {
        const application = page
          .apply(input, this.generation, current)
          .then((value) => {
            this.clock.recordAgentAction(true);
            this.clock.actionFinished();
            return value;
          });
        const result = await interruptible(application, abort.signal);
        if (result.kind === "aborted" || !current())
          return this.currentResult();
        applied = result.value;
      } catch (error) {
        if (!current()) return this.currentResult();
        if (isStaleActionError(error) || isPageTransitionError(error)) {
          this.previousObservationIdentity = null;
          this.previousActionIdentity = null;
          this.phaseValue = "ready";
          return { kind: "waiting", reason: "page" };
        }
        throw error;
      } finally {
        endAction();
      }
      this.feedback =
        typeof applied === "object" &&
        applied !== null &&
        "feedback" in applied &&
        typeof applied.feedback === "string"
          ? [applied.feedback]
          : [];
      this.previousObservationIdentity = observationIdentity;
      this.previousActionIdentity = actionIdentity;
      this.recentActions.push(input);
      if (this.options.hasCandidate?.() === true) {
        this.candidateReady();
        return this.currentResult();
      }
      const successor = await page.successor?.();
      if (successor) this.usePage(successor);
      const selectedElement =
        input.kind === "click-element"
          ? observation.elements.find(
              (element) => element.element_id === input.element_id,
            )
          : undefined;
      const likelyPdfAction =
        (input.kind === "click-element" &&
          /(?:\bpdf\b|download)/iu.test(selectedElement?.name ?? "")) ||
        (input.kind === "click-point" &&
          typeof applied === "object" &&
          applied !== null &&
          "likely_pdf" in applied &&
          applied.likely_pdf === true);
      this.scheduleFeedback(
        {
          kind: "wait-for-change",
          timeout_ms:
            observation.page_state === "CHALLENGE" &&
            (input.kind === "click-point" || input.kind === "click-element")
              ? DEFAULT_BROWSER_AGENT_CHALLENGE_WAIT_MS
              : likelyPdfAction
                ? DEFAULT_BROWSER_AGENT_PDF_WAIT_FOR_CHANGE_MS
                : DEFAULT_BROWSER_AGENT_WAIT_FOR_CHANGE_MS,
          revision: observation.observation_revision,
        },
        false,
      );
      this.ensurePacing();
      return {
        kind: "waiting",
        reason: "page",
        delay_ms: this.clock.decisionDelayMs(),
      };
    } finally {
      endInference?.();
      if (this.decisionAbort === abort) this.decisionAbort = null;
      if (this.phaseValue === "deciding") this.phaseValue = "ready";
    }
  }

  private async currentResult(): Promise<BrowserArticleStepResult> {
    if (this.terminalResult !== null)
      return { kind: "terminal", result: this.terminalResult };
    if (
      this.phaseValue === "candidate-ready" ||
      this.options.hasCandidate?.() === true
    ) {
      this.delivered ??= await this.options.awaitCandidate(this.options.signal);
      if (this.delivered?.accepted === true)
        return {
          kind: "candidate",
          candidate: this.delivered.candidate,
          accepted: true,
          lease: this,
        };
      if (this.delivered !== null) {
        const rejected = this.delivered;
        this.delivered = null;
        await this.options.abandonCandidate?.(
          rejected.candidate,
          this.options.signal,
        );
        this.candidateRejected("browser-candidate-rejected");
      }
      return { kind: "waiting", reason: "page" };
    }
    if (this.phaseValue === "downloading" && this.transferId !== null)
      return { kind: "suspended", transfer_id: this.transferId };
    return { kind: "waiting", reason: "page" };
  }

  private scheduleFeedback(input: OperatorInput, agentWait: boolean): void {
    const page = this.page;
    if (!page) return;
    const expectedEpoch = this.epoch;
    const endWait = this.beginActive("page-wait");
    this.phaseValue = "waiting";
    const work = page
      .apply(
        input,
        this.generation,
        () =>
          this.epoch === expectedEpoch &&
          this.phaseValue === "waiting" &&
          !this.options.signal.aborted,
      )
      .then(async () => {
        if (this.epoch !== expectedEpoch || this.phaseValue !== "waiting")
          return;
        if (agentWait) {
          this.clock.recordAgentAction(true);
          this.clock.actionFinished();
        }
        const successor = await page.successor?.();
        if (successor) this.usePage(successor);
      })
      .catch((error: unknown) => {
        if (this.epoch !== expectedEpoch || this.phaseValue !== "waiting")
          return;
        if (
          isStaleActionError(error) ||
          isPageTransitionError(error) ||
          isPageRuntimeError(error)
        ) {
          this.feedback = ["The page changed while waiting; observe it again."];
          return;
        }
        this.fail(stableBrowserFlowFailureCode(error));
      })
      .finally(() => {
        endWait();
        if (this.pendingFeedback === work) this.pendingFeedback = null;
        if (this.epoch === expectedEpoch && this.phaseValue === "waiting") {
          if (this.clock.decisionDelayMs() === 0) this.phaseValue = "ready";
          else this.ensurePacing();
        }
        this.notify();
      });
    this.pendingFeedback = work;
  }

  private ensurePacing(): void {
    if (this.pendingPacing !== undefined) return;
    const delay = this.clock.decisionDelayMs();
    if (delay <= 0) return;
    const endPacing = this.beginActive("pacing");
    this.pendingPacing = setTimeout(() => {
      this.pendingPacing = undefined;
      endPacing();
      if (this.phaseValue === "waiting" && this.pendingFeedback === null)
        this.phaseValue = "ready";
      this.notify();
    }, delay);
  }

  private beginActive(reason: BrowserArticleActiveReason): () => void {
    return this.clock.beginActive(reason);
  }

  private updateBudgetTimer(): void {
    if (this.budgetTimer !== undefined) clearTimeout(this.budgetTimer);
    this.budgetTimer = undefined;
    if (
      !this.clock.snapshot().active ||
      this.terminalResult !== null ||
      this.phaseValue === "closing" ||
      this.phaseValue === "closed"
    )
      return;
    this.budgetTimer = setTimeout(() => {
      this.budgetTimer = undefined;
      if (this.clock.remaining().deadline_ms === 0) this.stop("budget");
      else this.updateBudgetTimer();
    }, this.clock.remaining().deadline_ms);
  }

  private suspendActive(): void {
    this.clock.suspend();
    if (this.budgetTimer !== undefined) clearTimeout(this.budgetTimer);
    if (this.pendingPacing !== undefined) clearTimeout(this.pendingPacing);
    this.budgetTimer = undefined;
    this.pendingPacing = undefined;
    this.pendingFeedback = null;
  }

  private revokeDecision(): void {
    this.epoch += 1;
    this.decisionAbort?.abort();
  }

  private restore(code: string): void {
    this.revokeDecision();
    this.suspendActive();
    if (this.resumePage) this.usePage(this.resumePage);
    this.feedback = [
      "The previous file attempt failed (" +
        (/^[a-zA-Z0-9._:-]{1,128}$/u.test(code)
          ? code
          : "browser-transfer-failed") +
        "). Inspect the retained article page and choose the next action.",
    ];
    this.phaseValue = "ready";
    this.notify();
  }

  private endNetwork(outcome: BrowserArticleNetworkEndOutcome): void {
    this.setNetworkAccess(false);
    if (this.networkStopping !== null) return;
    this.networkEndOutcome ??= outcome;
    if (!this.stopNetworkCallback) return;
    const terminalOutcome = this.networkEndOutcome;
    this.networkStopping = (async () => {
      await this.stopNetworkCallback!();
      await this.options.onNetworkEnded?.(this.identity, terminalOutcome);
      this.networkEndedSuccessfully = true;
    })()
      .catch((error: unknown) => {
        this.networkCleanupError ??= error;
        if (this.phaseValue === "ready")
          this.fail("browser-network-stop-failed");
      })
      .finally(() => {
        this.notify();
      });
  }

  private usePage(page: FlowPageHandle): void {
    this.page = page;
    this.generation = 0;
    this.previousObservationIdentity = null;
    this.previousActionIdentity = null;
  }

  private stop(reason: BrowserArticleFlowResult["stopped_reason"]): void {
    if (this.phaseValue === "closed" || this.terminalResult !== null) return;
    if (
      (reason === "stopped" || reason === "no-candidate") &&
      this.unresolvedCaptureFailure !== null
    ) {
      this.fail(this.unresolvedCaptureFailure);
      return;
    }
    this.stoppedReason = reason;
    this.terminalResult =
      reason === "stopped" || reason === "no-candidate"
        ? { kind: "exhausted" }
        : browserRefused(
            reason === "cancelled"
              ? "browser-flow-cancelled"
              : reason === "budget"
                ? "browser-flow-budget-exhausted"
                : reason === "blocked"
                  ? "browser-agent-stopped"
                  : reason === "invalid-action"
                    ? "browser-action-invalid"
                    : "browser-observation-unavailable",
            "The controlled Browser flow stopped before a normal no-PDF result.",
          );
    this.phaseValue = "closing";
    this.options.onClosing?.();
    this.revokeDecision();
    this.suspendActive();
    this.endNetwork({
      kind: reason === "cancelled" ? "cancelled" : "completed",
    });
    this.notify();
  }

  private fail(code: string): void {
    if (this.phaseValue === "closed" || this.terminalResult !== null) return;
    this.terminalResult = browserRefused(
      code,
      "The controlled Browser flow failed before delivering a document.",
    );
    this.stoppedReason = "unavailable-observation";
    this.phaseValue = "closing";
    this.options.onClosing?.();
    this.revokeDecision();
    this.suspendActive();
    this.endNetwork({
      kind: code === "browser-runtime-lost" ? "runtime-failure" : "failure",
    });
    this.notify();
  }

  private isRunnable(): boolean {
    return (
      this.terminalResult !== null ||
      this.phaseValue === "closed" ||
      (this.phaseValue === "candidate-ready" &&
        this.options.hasCandidate?.() === true) ||
      (this.phaseValue === "ready" &&
        this.page !== null &&
        (this.networkAllowed || this.networkEndedSuccessfully) &&
        this.options.automatic?.canDecide() !== false &&
        this.pendingFeedback === null &&
        this.clock.decisionDelayMs() === 0)
    );
  }

  private notify(): void {
    this.wakeVersion += 1;
    for (const waiter of [...this.waiters]) waiter();
  }
}

async function interruptible<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<
  { readonly kind: "result"; readonly value: T } | { readonly kind: "aborted" }
> {
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ kind: "result" as const, value })),
      new Promise<{ readonly kind: "aborted" }>((resolve) => {
        onAbort = () => resolve({ kind: "aborted" });
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** One source for the accepted article action/call/active-time ceilings. */
export const DEFAULT_FLOW_MAX_ACTIONS =
  DEFAULT_BROWSER_ARTICLE_BUDGET.max_actions;
export const DEFAULT_FLOW_MAX_MODEL_CALLS =
  DEFAULT_BROWSER_ARTICLE_BUDGET.max_model_calls;
export const DEFAULT_FLOW_DEADLINE_MS =
  DEFAULT_BROWSER_ARTICLE_BUDGET.active_ms;
/** Hard ceiling on waiting for a captured candidate once the driver stops. */
export const DEFAULT_FLOW_CANDIDATE_WAIT_MS = 30_000;

/** Resolves to null when the bounded wait elapses, so the caller stays unblocked. */
async function withTimeout<T>(
  promise: Promise<T | null>,
  timeoutMs: number,
): Promise<
  | { readonly kind: "settled"; readonly value: T | null }
  | { readonly kind: "timed-out" }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ kind: "settled" as const, value })),
      new Promise<{ readonly kind: "timed-out" }>((resolve) => {
        timer = setTimeout(
          () => resolve({ kind: "timed-out" }),
          Math.max(0, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Maps a sanitized BrowserObservation onto the model-facing wire contract. */
function toWireObservation(
  observation: Awaited<ReturnType<BrowserObservationStore["observe"]>>,
  options: BrowserArticleFlowOptions,
  clock: BrowserArticleClock,
  pageId: string,
  controlEpoch: number,
): WorkbenchObservation {
  return parseWorkbenchObservation({
    session_id: options.session_id,
    article_id: options.article_id,
    page_id: pageId,
    document_generation: observation.document_generation ?? 0,
    observation_revision: observation.revision,
    viewport_revision: observation.viewport_version,
    control_epoch: controlEpoch,
    frame_seq: observation.revision,
    frame_available: observation.frame !== null,
    frame_dropped: false,
    observed_at: new Date().toISOString(),
    url: observation.url,
    title: observation.title,
    text: observation.text ?? "",
    loading: observation.loading ?? false,
    partial: observation.partial ?? false,
    viewport: observation.viewport,
    elements: observation.elements ?? [],
    page_state: observation.page_state,
    capture_state: observation.capture_state ?? "NONE",
    remaining: {
      actions: clock.remaining().actions,
      model_calls: clock.remaining().model_calls,
      bytes: 0,
      deadline_ms: clock.remaining().deadline_ms,
    },
  });
}

/** Parses untrusted model output through the closed action schema; null when invalid. */
function parseActionOrNull(action: unknown): OperatorInput | null {
  if (!action || typeof action !== "object") return null;
  try {
    return parseBrowserAction(action) as OperatorInput;
  } catch {
    return null;
  }
}

function isStaleActionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { readonly code?: unknown }).code ===
      "browser-page-stale-action"
  );
}

function isPageTransitionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { readonly code?: unknown }).code ===
      "browser-page-transition"
  );
}

function isPageRuntimeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { readonly code?: unknown }).code ===
      "browser-page-runtime"
  );
}

/** Preserve only a small, non-sensitive failure taxonomy across the Browser boundary. */
function stableCaptureFailureCode(code: string): string {
  if (/^(?:storage|file)-[a-z0-9-]{1,96}$/u.test(code))
    return `browser-${code}`;
  if (code === "pdf-acceptance") return "browser-pdf-acceptance";
  return /^(?:browser|pdf-reader)-[a-z0-9-]{1,96}$/u.test(code)
    ? code
    : "browser-transfer-failed";
}

function isLocalCaptureFailure(code: string): boolean {
  return (
    code.startsWith("pdf-reader-") ||
    code.startsWith("browser-storage-") ||
    code.startsWith("browser-file-") ||
    code === "browser-runtime-lost" ||
    [
      "browser-download-temporary-quota",
      "browser-download-disk-reserve",
      "browser-download-disk-unavailable",
      "browser-download-resource-ownership",
    ].includes(code)
  );
}

function stableBrowserFlowFailureCode(error: unknown): string {
  const code =
    error instanceof Error
      ? (error as Error & { readonly code?: unknown }).code
      : undefined;
  if (
    typeof code === "string" &&
    /^(?:browser-download|pdf-reader)-[a-z0-9-]{1,96}$/u.test(code)
  )
    return code;
  switch (code) {
    case "browser-navigation-failed":
    case "browser-rate-limited":
    case "browser-page-runtime":
    case "browser-page-closed":
    case "browser-page-crashed":
    case "browser-session-cleanup-failed":
    case "browser-runtime-lost":
    case "browser-page-stale-action":
    case "browser-page-transition":
      return code;
    case "browser-transfer":
      return "browser-transfer-failed";
    case "pdf-acceptance":
      return "browser-pdf-acceptance";
    case "candidate-abandonment":
      return "browser-candidate-abandonment";
    default:
      return "browser-flow-failed";
  }
}

/**
 * A semantic page identity deliberately excludes document generation and element IDs.
 * Those values can change while a challenge iframe re-renders even though a human sees
 * the same page. They must not allow the Agent to repeat the same click forever.
 */
function stableObservationIdentity(observation: WorkbenchObservation): string {
  return JSON.stringify({
    url: observation.url,
    title: observation.title,
    text: observation.text,
    loading: observation.loading,
    partial: observation.partial,
    page_state: observation.page_state,
    elements: observation.elements.map(({ role, name, editable }) => ({
      role,
      name,
      editable,
    })),
  });
}

/** Revisions bind execution; they are excluded when detecting a repeated action. */
function stableActionIdentity(action: OperatorInput): string {
  return JSON.stringify(action, (key, value: unknown) =>
    key === "revision" || key === "viewport_version" ? undefined : value,
  );
}

/**
 * One page per delivery attempt. The owner binds the delivery context (identity and the
 * pending candidate) before opening, so this only has to return the page and its closer.
 */
export interface ArticleFlowPageSource {
  openPage(request: BrowserDeliveryRequest): Promise<{
    readonly page: FlowPageHandle;
    readonly session_id?: string;
    readonly setNetworkAccess?: (allowed: boolean) => void;
    readonly stopNetwork?: () => Promise<void>;
    /** Resolves only after this article's pages, native writers and requests end. */
    readonly close: () => Promise<void>;
  }>;
}

/**
 * The production `BrowserArticleFlow` port creates one bounded execution per article:
 * open its admitted page, run its driver, and hand off its spooled candidate with a
 * lease that Entry closes after acceptance and publication settle.
 *
 * It refuses with a stable reason instead of inventing a delivery whenever a required
 * piece is missing (no driver decision, no spooled candidate). It never reports an
 * empty success and never turns a refusal into a delivered candidate.
 */
export interface BrowserArticleCandidateSource {
  hasCandidate(): boolean;
  next(signal: AbortSignal): Promise<SpooledArticleCandidate | null>;
}

export interface BrowserArticleAutomaticContext {
  canDecide(): boolean;
  controlEpoch(): number;
  guidance(): readonly string[];
  onDispatched?(): void;
  onObservation?(
    observation: WorkbenchObservation,
    frame: Uint8Array | null,
    page: FlowPageHandle,
  ): void;
  stopReason?(): "stopped" | "budget" | "cancelled" | undefined;
}

export interface BrowserArticleFlowFactoryOptions {
  readonly pages: ArticleFlowPageSource;
  readonly decide: FlowDecision | undefined;
  readonly session_id: string;
  readonly max_actions?: number;
  readonly max_model_calls?: number;
  readonly deadline_ms?: number;
  readonly candidate_timeout_ms?: number;
  readonly observations?: BrowserObservationStore;
  /** Explicit lifecycle seam for standalone wrappers; production open is transport. */
  readonly dispatch_tracking?: "transport" | "test-seam";
  /** Standalone low-level source; production supplies candidateSource. */
  readonly awaitCandidate?: BrowserArticleFlowOptions["awaitCandidate"];
  readonly hasCandidate?: BrowserArticleFlowOptions["hasCandidate"];
  readonly candidateSource?: (
    identity: BrowserArticleSessionIdentity,
  ) => BrowserArticleCandidateSource;
  /** Registers Intake and lifecycle routing before the first article request. */
  readonly onSession?: (
    execution: BrowserArticleExecution,
    request: BrowserDeliveryRequest,
  ) => void | Promise<void>;
  readonly onNetworkEnded?: BrowserArticleFlowOptions["onNetworkEnded"];
  readonly abandonCandidate?: BrowserArticleFlowOptions["abandonCandidate"];
  readonly now?: () => number;
  readonly action_cooldown_ms?: number;
  readonly collaboration?: {
    /** Scheduler-owned queue identity and cancellation; no page has been created. */
    queued?(identity: BrowserArticleSessionIdentity, cancel: () => void): void;
    removed?(sessionId: string, outcome: BrowserArticleCloseOutcome): void;
    /** Registers an article projection before page creation or platform admission. */
    registered?(
      execution: BrowserArticleExecution,
      request: BrowserDeliveryRequest,
    ):
      | void
      | { close(outcome: BrowserArticleCloseOutcome): void | Promise<void> }
      | Promise<void | {
          close(outcome: BrowserArticleCloseOutcome): void | Promise<void>;
        }>;
    open(
      request: BrowserDeliveryRequest,
      page: FlowPageHandle,
      /** Legacy standalone projection; production consumes execution.clock. */
      deadlineAt: number,
      execution?: BrowserArticleExecution,
    ): Promise<{
      step(signal: AbortSignal): Promise<CollaborativeStepResult>;
      /** Production uses the session's single decision loop and these UI inputs. */
      automatic?: BrowserArticleAutomaticContext;
      beforeClose?(outcome?: BrowserArticleCloseOutcome): Promise<void>;
      close(
        failed: boolean,
        outcome?: BrowserArticleCloseOutcome,
      ): void | Promise<void>;
    }>;
  };
}

export class BrowserArticleOpenError extends Error {
  constructor(
    readonly code: string,
    cause?: unknown,
  ) {
    super("The controlled Browser article could not be opened", { cause });
    this.name = "BrowserArticleOpenError";
  }
}

export function createBrowserArticleFlow(
  options: BrowserArticleFlowFactoryOptions,
): BrowserArticleFlow {
  const createSession = async (
    request: BrowserDeliveryRequest,
    tracking: "transport" | "test-seam",
  ): Promise<{
    readonly driver: BrowserArticleFlowDriver;
    readonly page: FlowPageHandle;
    readonly source: BrowserArticleCandidateSource;
  }> => {
    if (request.signal.aborted)
      throw new BrowserArticleOpenError("browser-flow-cancelled");
    if (options.decide === undefined)
      throw new BrowserArticleOpenError("browser-model-unavailable");
    const target: BrowserDecisionTarget = request.article_goal ?? {
      literature_id: request.literature_id,
      identifier: request.identifier,
      version: request.version,
    };
    if (
      target.literature_id !== request.literature_id ||
      target.identifier !== request.identifier ||
      target.version !== request.version
    )
      throw new BrowserArticleOpenError("browser-goal-mismatch");
    if (request.start_url === null)
      throw new BrowserArticleOpenError("browser-flow-unavailable");
    const articleAbort = new AbortController();
    const openingAbort = new AbortController();
    const signal = AbortSignal.any([request.signal, articleAbort.signal]);
    const boundRequest = { ...request, signal };
    const identity =
      request.session_identity ??
      Object.freeze({
        session_id: options.session_id,
        operation_id: request.operation_id ?? "standalone-browser-flow",
        generation: request.generation ?? 0,
        literature_id: request.literature_id,
        metadata_snapshot: Object.freeze({ ...request.metadata_snapshot }),
      });
    if (
      identity.literature_id !== request.literature_id ||
      (request.operation_id !== undefined &&
        identity.operation_id !== request.operation_id) ||
      identity.generation !== (request.generation ?? 0) ||
      identity.metadata_snapshot.revision !==
        request.metadata_snapshot.revision ||
      identity.metadata_snapshot.sha256 !== request.metadata_snapshot.sha256
    )
      throw new BrowserArticleOpenError("browser-session-identity-mismatch");
    const clock = new BrowserArticleClock({
      ...(options.now ? { now: options.now } : {}),
      budget: {
        active_ms: Math.max(1, options.deadline_ms ?? DEFAULT_FLOW_DEADLINE_MS),
        max_model_calls: Math.max(
          1,
          options.max_model_calls ?? DEFAULT_FLOW_MAX_MODEL_CALLS,
        ),
        max_actions: Math.max(
          1,
          options.max_actions ?? DEFAULT_FLOW_MAX_ACTIONS,
        ),
        min_decision_interval_ms:
          options.action_cooldown_ms ??
          DEFAULT_BROWSER_AGENT_ACTION_COOLDOWN_MS,
      },
    });
    let source: BrowserArticleCandidateSource | undefined;
    let opened:
      | Awaited<ReturnType<ArticleFlowPageSource["openPage"]>>
      | undefined;
    let opening: ReturnType<ArticleFlowPageSource["openPage"]> | undefined;
    let collaboration:
      | Awaited<ReturnType<NonNullable<typeof options.collaboration>["open"]>>
      | undefined;
    let registration: {
      close(outcome: BrowserArticleCloseOutcome): void | Promise<void>;
    } | void;
    const decide = options.decide;
    const driver = new BrowserArticleFlowDriver({
      identity,
      clock,
      start_url: request.start_url,
      decide: (
        observation,
        frame,
        signal,
        guidance,
        _target,
        recentActions,
        feedback,
        lifecycle,
      ) =>
        decide(
          observation,
          frame,
          signal,
          guidance,
          target,
          recentActions,
          feedback,
          lifecycle,
        ),
      ...(tracking === "test-seam" && options.collaboration
        ? {
            collaborativeStep: (signal: AbortSignal) =>
              collaboration!.step(signal),
            useCollaborativeStep: () => collaboration?.automatic === undefined,
          }
        : {}),
      ...(options.collaboration
        ? {
            automatic: {
              canDecide: () => collaboration?.automatic?.canDecide() ?? true,
              controlEpoch: () => collaboration?.automatic?.controlEpoch() ?? 0,
              guidance: () => collaboration?.automatic?.guidance() ?? [],
              onDispatched: () => collaboration?.automatic?.onDispatched?.(),
              onObservation: (observation, frame, page) =>
                collaboration?.automatic?.onObservation?.(
                  observation,
                  frame,
                  page,
                ),
              stopReason: () => collaboration?.automatic?.stopReason?.(),
            },
          }
        : {}),
      dispatch_tracking: tracking,
      max_actions: options.max_actions ?? DEFAULT_FLOW_MAX_ACTIONS,
      max_model_calls: options.max_model_calls ?? DEFAULT_FLOW_MAX_MODEL_CALLS,
      deadline_ms: options.deadline_ms ?? DEFAULT_FLOW_DEADLINE_MS,
      started_at: 0,
      signal,
      onCancel: () => articleAbort.abort(),
      onClosing: () => openingAbort.abort(),
      ...(options.observations ? { observations: options.observations } : {}),
      article_id: request.literature_id,
      session_id: identity.session_id,
      hasCandidate: () => source?.hasCandidate() ?? false,
      awaitCandidate: (signal) => source?.next(signal) ?? Promise.resolve(null),
      ...(options.abandonCandidate
        ? { abandonCandidate: options.abandonCandidate }
        : {}),
      ...(options.onNetworkEnded
        ? { onNetworkEnded: options.onNetworkEnded }
        : {}),
      close: async (outcome) => {
        if (outcome.kind === "cancelled") articleAbort.abort();
        const errors: unknown[] = [];
        try {
          await opening;
        } catch (error) {
          // The opening owner has already closed its session on normal failure.
          // A failed owned cleanup must still fail the shared full close.
          if (
            stableBrowserFlowFailureCode(error) ===
            "browser-session-cleanup-failed"
          )
            errors.push(error);
        }
        try {
          await collaboration?.beforeClose?.(outcome);
        } catch (error) {
          errors.push(error);
        }
        try {
          await opened?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await collaboration?.close(
            outcome.kind === "cancelled" ||
              (outcome.kind === "retained" &&
                outcome.code !== "delivered" &&
                outcome.code !== "exhausted"),
            outcome,
          );
        } catch (error) {
          errors.push(error);
        }
        try {
          await registration?.close(outcome);
        } catch (error) {
          errors.push(error);
        }
        if (errors.length)
          throw new BrowserArticleCloseError(
            errors.length === 1
              ? errors[0]
              : new AggregateError(errors, "Browser article cleanup failed"),
          );
      },
    });
    try {
      // Source registration must precede both candidateSource lookup and navigation.
      registration = await options.collaboration?.registered?.(
        driver,
        boundRequest,
      );
      await options.onSession?.(driver, boundRequest);
      source = options.candidateSource
        ? options.candidateSource(identity)
        : {
            hasCandidate: () => options.hasCandidate?.() ?? false,
            next: (signal) =>
              options.awaitCandidate?.(signal) ?? Promise.resolve(null),
          };
      if (tracking === "transport" && options.candidateSource === undefined)
        throw new BrowserArticleOpenError("browser-session-source-unavailable");
      if (signal.aborted)
        throw new BrowserArticleOpenError("browser-flow-cancelled");
      const endOpen = clock.beginActive("page-wait");
      try {
        opening = options.pages
          .openPage({
            ...boundRequest,
            // Budget shutdown must reach Host while open is pending, without
            // turning the Scheduler's article lifetime signal into user cancel.
            signal: AbortSignal.any([signal, openingAbort.signal]),
            session_identity: identity,
          })
          .then((value) => {
            opened = value;
            return value;
          });
        opened = await opening;
      } finally {
        endOpen();
      }
      driver.attachPage(opened);
      if (["closing", "closed"].includes(driver.phase())) {
        const terminal = await driver.step();
        throw new BrowserArticleOpenError(
          terminal.kind === "terminal" && terminal.result.kind === "refused"
            ? terminal.result.code
            : "browser-flow-cancelled",
        );
      }
      if (signal.aborted)
        throw new BrowserArticleOpenError("browser-flow-cancelled");
      if (options.collaboration) {
        collaboration = await options.collaboration.open(
          boundRequest,
          opened.page,
          Date.now() + clock.remaining().deadline_ms,
          driver,
        );
        if (tracking === "transport" && collaboration.automatic === undefined)
          throw new BrowserArticleOpenError(
            "browser-collaboration-session-unavailable",
          );
      }
      if (signal.aborted)
        throw new BrowserArticleOpenError("browser-flow-cancelled");
      return { driver, page: opened.page, source };
    } catch (error) {
      const stopped = ["closing", "closed"].includes(driver.phase())
        ? await driver.step()
        : undefined;
      const stoppedCode =
        stopped?.kind === "terminal" && stopped.result.kind === "refused"
          ? stopped.result.code
          : undefined;
      const failureCode =
        stoppedCode ??
        (error instanceof BrowserArticleOpenError
          ? error.code
          : stableBrowserFlowFailureCode(error));
      const openFailureCode =
        failureCode === "browser-flow-failed"
          ? "browser-page-unavailable"
          : failureCode;
      try {
        await driver.close(
          stoppedCode === "browser-flow-cancelled" ||
            (stoppedCode === undefined && signal.aborted)
            ? { kind: "cancelled" }
            : { kind: "retained", code: openFailureCode },
        );
      } catch (closeError) {
        if (openFailureCode === "browser-session-cleanup-failed")
          throw new BrowserArticleOpenError(
            openFailureCode,
            new AggregateError(
              [error, closeError],
              "Browser open cleanup failed",
            ),
          );
        throw new BrowserArticleCloseError(
          new AggregateError(
            [error, closeError],
            "Browser article open and close failed",
          ),
        );
      }
      if (
        stoppedCode === "browser-flow-cancelled" ||
        (stoppedCode === undefined && signal.aborted)
      )
        throw new BrowserArticleOpenError("browser-flow-cancelled", error);
      if (
        error instanceof BrowserArticleOpenError &&
        error.code === openFailureCode
      )
        throw error;
      throw new BrowserArticleOpenError(openFailureCode, error);
    }
  };

  return Object.freeze({
    open: async (request: BrowserDeliveryRequest) =>
      (await createSession(request, "transport")).driver,
    /** Low-level standalone wrapper; production uses open()/step()/close(). */
    deliver: async (
      request: BrowserDeliveryRequest,
    ): Promise<BrowserDeliveryResult> => {
      let session: Awaited<ReturnType<typeof createSession>>;
      try {
        session = await createSession(
          request,
          options.dispatch_tracking ?? "test-seam",
        );
      } catch (error) {
        if (error instanceof BrowserArticleCloseError) throw error;
        return browserRefused(
          error instanceof BrowserArticleOpenError
            ? error.code
            : "browser-page-unavailable",
          "The controlled Browser article could not be opened.",
        );
      }
      let result: BrowserDeliveryResult;
      try {
        const stopped = await session.driver.run();
        if (session.page.settleCaptures)
          await withTimeout(
            session.page.settleCaptures().then(() => null),
            options.candidate_timeout_ms ?? DEFAULT_FLOW_CANDIDATE_WAIT_MS,
          );
        if (request.signal.aborted)
          result = browserRefused(
            "browser-flow-cancelled",
            "The Browser delivery was cancelled while running.",
          );
        else {
          const candidateWait = new AbortController();
          const candidateSignal = AbortSignal.any([
            request.signal,
            candidateWait.signal,
          ]);
          const awaited = await withTimeout(
            session.driver.spooledCandidate(
              candidateSignal,
              session.page.settleCaptures === undefined,
            ),
            options.candidate_timeout_ms ?? DEFAULT_FLOW_CANDIDATE_WAIT_MS,
          ).finally(() => candidateWait.abort());
          if (awaited.kind === "timed-out")
            result = browserRefused(
              "browser-candidate-timeout",
              "The controlled Browser candidate did not settle before the wait deadline.",
            );
          else if (awaited.value?.accepted === true)
            result = {
              kind: "delivered",
              candidate: awaited.value.candidate,
              accepted: true,
            };
          else if (awaited.value !== null) {
            await options.abandonCandidate?.(
              awaited.value.candidate,
              request.signal,
            );
            result = browserRefused(
              "browser-candidate-rejected",
              "The delivered candidate did not pass PDF file admission.",
            );
          } else {
            const final = await session.driver.step();
            result =
              final.kind === "terminal"
                ? final.result
                : stopped.stopped_reason === "stopped" ||
                    stopped.stopped_reason === "no-candidate"
                  ? { kind: "exhausted" }
                  : browserRefused(
                      "browser-flow-failed",
                      "The controlled Browser flow stopped before delivering a document.",
                    );
          }
        }
      } catch (error) {
        result = browserRefused(
          request.signal.aborted
            ? "browser-flow-cancelled"
            : stableBrowserFlowFailureCode(error),
          "The controlled Browser flow failed before delivering a document.",
        );
      }
      await session.driver.close(
        request.signal.aborted
          ? { kind: "cancelled" }
          : { kind: "retained", code: result.kind },
      );
      return result;
    },
  });
}

/** Stable refusal used when no driver can be assembled for this process. */
export function flowUnavailable(): BrowserDeliveryResult {
  return browserRefused(
    "browser-flow-unavailable",
    "The controlled Browser article flow is not wired in this process.",
  );
}
