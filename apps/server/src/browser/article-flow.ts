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
import {
  browserRefused,
  type BrowserArticleFlow,
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
  apply(
    input: OperatorInput,
    documentGeneration: number,
    current: () => boolean,
  ): Promise<unknown>;
  navigate?(url: string): Promise<void>;
}

/**
 * One candidate the Intake owner spooled during the flow. The driver only forwards it:
 * bytes, hashing and identity assessment all happen behind the Intake boundary.
 */
export interface SpooledArticleCandidate {
  readonly transfer_id: string;
  readonly candidate: DurableCandidate;
  readonly accepted: boolean;
}

/** A decision function: one closed Browser action for one observation. */
export type FlowDecision = (
  observation: WorkbenchObservation,
  frame: Uint8Array | null,
  signal: AbortSignal,
) => Promise<unknown>;
export type CollaborativeStepResult =
  | "applied"
  | "retry"
  | "stopped"
  | "budget"
  | "cancelled"
  | "invalid-action";

export interface BrowserArticleFlowOptions {
  readonly page: BrowserPageHandle | FlowPageHandle;
  /** Omitted only when the caller already knows the page is on the admitted start URL. */
  readonly start_url?: string;
  readonly decide: FlowDecision | undefined;
  /** When present, the production workbench owns both model and human dispatch. */
  readonly collaborativeStep?: (
    signal: AbortSignal,
  ) => Promise<CollaborativeStepResult>;
  /** Actions still allowed; the loop stops as soon as this reaches zero. */
  readonly max_actions: number;
  /** Model calls still allowed; bounds an unproductive loop as well as actions. */
  readonly max_model_calls: number;
  /** Wall-clock budget for the whole attempt, in milliseconds. */
  readonly deadline_ms: number;
  readonly started_at: number;
  /**
   * Sanitizing observation owner. It derives URL, page state and cleaned elements from
   * the raw snapshot, so the driver never has to hand-build a wire observation.
   */
  readonly observations?: BrowserObservationStore;
  readonly signal: AbortSignal;
  readonly article_id: string;
  readonly session_id: string;
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
   * Retires a spooled candidate that the automatic path must not keep. `receive()`
   * already committed a durable candidate before the identity verdict is known, so a
   * non-accepted result would otherwise leave an unowned durable record behind.
   */
  readonly abandonCandidate?: (
    candidate: DurableCandidate,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly now?: () => number;
}

export interface BrowserArticleFlowResult {
  readonly actions: number;
  readonly stopped_reason:
    | "stopped"
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
export class BrowserArticleFlowDriver {
  constructor(private readonly options: BrowserArticleFlowOptions) {}

  async run(): Promise<BrowserArticleFlowResult> {
    const { signal } = this.options;
    if (signal.aborted) return { actions: 0, stopped_reason: "cancelled" };
    // The owner already opened the admitted page on its start URL (`host.openPage`
    // performs that admitted first navigation), so the driver must not navigate again.
    if (this.options.decide === undefined && !this.options.collaborativeStep)
      return this.noCandidate(0);
    if (signal.aborted) return { actions: 0, stopped_reason: "cancelled" };
    return this.loop();
  }

  private async loop(): Promise<BrowserArticleFlowResult> {
    const { page, signal, decide } = this.options;
    if (decide === undefined && !this.options.collaborativeStep)
      return this.noCandidate(0);
    let actions = 0;
    let modelCalls = 0;
    let generation = 0;
    for (;;) {
      if (signal.aborted) return { actions, stopped_reason: "cancelled" };
      // Three independent ceilings: actions, model calls and wall clock. A loop that
      // keeps observing without a usable action must not run past any of them.
      if (actions >= this.options.max_actions)
        return { actions, stopped_reason: "budget" };
      if (
        !this.options.collaborativeStep &&
        modelCalls >= this.options.max_model_calls
      )
        return { actions, stopped_reason: "budget" };
      if (
        (this.options.now?.() ?? Date.now()) - this.options.started_at >=
        this.options.deadline_ms
      )
        return { actions, stopped_reason: "budget" };
      // A candidate captured during the initial page open must end the flow before the
      // next observation: asking the model again would risk a viewer snapshot failure
      // masking a PDF that already arrived.
      if (this.options.hasCandidate?.() === true)
        return { actions, stopped_reason: "stopped" };
      if (this.options.collaborativeStep) {
        const step = await this.options.collaborativeStep(signal);
        if (step === "applied") actions += 1;
        else if (step === "retry") continue;
        else if (step === "stopped")
          return { actions, stopped_reason: "stopped" };
        else return { actions, stopped_reason: step };
        continue;
      }
      const snapshot = await page.snapshot();
      if (signal.aborted) return { actions, stopped_reason: "cancelled" };
      if (this.options.hasCandidate?.() === true)
        return { actions, stopped_reason: "stopped" };
      generation = snapshot.document_generation ?? generation;
      // The sanitizing owner derives URL, page state and cleaned elements from the raw
      // snapshot; a hand-built wire observation would have to guess at closed contracts
      // (`page_state` enum casing, query/fragment-free URL, element shapes).
      const store = this.options.observations;
      if (!store)
        // Without the sanitizing owner the flow cannot build a valid wire observation,
        // so it ends instead of hand-rolling one that the contract would reject.
        return { actions, stopped_reason: "unavailable-observation" };
      const observation = toWireObservation(
        await store.observe(
          this.options.article_id,
          `${this.options.session_id}-page`,
          { snapshot: async () => snapshot },
        ),
        this.options,
        actions,
        modelCalls,
      );
      modelCalls += 1;
      if (!decide)
        return { actions, stopped_reason: "unavailable-observation" };
      const action = await decide(observation, snapshot.screenshot, signal);
      if (signal.aborted) return { actions, stopped_reason: "cancelled" };
      // Untrusted model output must pass the closed six-action schema before it can
      // reach the page; an invalid action ends the flow with a stable outcome instead of
      // escaping as an unclassified internal error.
      const parsed = parseActionOrNull(action);
      if (parsed === null) return { actions, stopped_reason: "invalid-action" };
      if (parsed.kind === "stop")
        return {
          actions,
          stopped_reason:
            parsed.reason === "budget"
              ? "budget"
              : parsed.reason === "cancel"
                ? "cancelled"
                : "stopped",
        };
      await page.apply(parsed, generation, () => !signal.aborted);
      actions += 1;
    }
  }

  private async noCandidate(
    actions: number,
  ): Promise<BrowserArticleFlowResult> {
    const candidate = await this.options.awaitCandidate(this.options.signal);
    return {
      actions,
      stopped_reason: candidate === null ? "no-candidate" : "stopped",
    };
  }

  /** Reads the spooled candidate the transfer pipeline produced, if any. */
  async candidate(): Promise<{
    readonly transfer_id: string;
    readonly accepted: boolean;
  } | null> {
    return this.options.awaitCandidate(this.options.signal);
  }
}

/** Hard ceilings for one automatic attempt: actions, model calls and wall clock. */
export const DEFAULT_FLOW_MAX_ACTIONS = 24;
export const DEFAULT_FLOW_MAX_MODEL_CALLS = 12;
export const DEFAULT_FLOW_DEADLINE_MS = 120_000;
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

function nowMs(): number {
  return Date.now();
}

/** Maps a sanitized BrowserObservation onto the model-facing wire contract. */
function toWireObservation(
  observation: Awaited<ReturnType<BrowserObservationStore["observe"]>>,
  options: BrowserArticleFlowOptions,
  revision: number,
  modelCalls: number,
): WorkbenchObservation {
  return parseWorkbenchObservation({
    session_id: options.session_id,
    article_id: options.article_id,
    page_id: `${options.session_id}-page`,
    document_generation: observation.document_generation ?? 0,
    observation_revision: observation.revision ?? revision,
    viewport_revision: observation.viewport_version,
    control_epoch: 0,
    frame_seq: observation.revision ?? revision,
    frame_available: observation.frame !== null,
    frame_dropped: false,
    observed_at: new Date(options.now?.() ?? Date.now()).toISOString(),
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
      actions: Math.max(0, options.max_actions - revision),
      model_calls: Math.max(0, options.max_model_calls - modelCalls),
      bytes: 0,
      deadline_ms: Math.max(
        0,
        options.deadline_ms -
          ((options.now?.() ?? Date.now()) - options.started_at),
      ),
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

/**
 * One page per delivery attempt. The owner binds the delivery context (identity and the
 * pending candidate) before opening, so this only has to return the page and its closer.
 */
export interface ArticleFlowPageSource {
  openPage(request: BrowserDeliveryRequest): Promise<{
    readonly page: FlowPageHandle;
    readonly close: () => Promise<void>;
  }>;
}

/**
 * The production `BrowserArticleFlow` port. It owns one bounded attempt at a time:
 * open the admitted page, run the driver, read the spooled candidate, then always
 * release the page — regardless of outcome.
 *
 * It refuses with a stable reason instead of inventing a delivery whenever a required
 * piece is missing (no driver decision, no spooled candidate). It never reports an
 * empty success and never turns a refusal into a delivered candidate.
 */
export function createBrowserArticleFlow(options: {
  readonly pages: ArticleFlowPageSource;
  readonly decide: FlowDecision | undefined;
  readonly session_id: string;
  readonly max_actions?: number;
  readonly max_model_calls?: number;
  readonly deadline_ms?: number;
  /** Bounded wait for a captured candidate after the driver stops. */
  readonly candidate_timeout_ms?: number;
  readonly observations?: BrowserObservationStore;
  readonly awaitCandidate: BrowserArticleFlowOptions["awaitCandidate"];
  /** Non-blocking check for an already-captured candidate. */
  readonly hasCandidate?: BrowserArticleFlowOptions["hasCandidate"];
  /** Retires a spooled candidate the automatic path must not keep. */
  readonly abandonCandidate?: BrowserArticleFlowOptions["abandonCandidate"];
  readonly now?: () => number;
  readonly collaboration?: {
    open(
      request: BrowserDeliveryRequest,
      page: FlowPageHandle,
      deadlineAt: number,
    ): Promise<{
      step(signal: AbortSignal): Promise<CollaborativeStepResult>;
      beforeClose?(): Promise<void>;
      close(failed: boolean): void | Promise<void>;
    }>;
  };
}): BrowserArticleFlow {
  return Object.freeze({
    deliver: async (
      request: BrowserDeliveryRequest,
    ): Promise<BrowserDeliveryResult> => {
      if (request.signal.aborted)
        return browserRefused(
          "browser-flow-cancelled",
          "The Browser delivery was cancelled before it started.",
        );
      if (options.decide === undefined)
        return browserRefused(
          "browser-model-unavailable",
          "No Browser decision model is configured for the controlled flow.",
        );
      if (request.start_url === null)
        return browserRefused(
          "browser-flow-unavailable",
          "No admitted landing page is available for this article.",
        );
      const startUrl = request.start_url;
      let opened: {
        readonly page: unknown;
        readonly close: () => Promise<void>;
      };
      try {
        opened = await options.pages.openPage(request);
      } catch {
        // A page that cannot be opened is a stable Browser refusal, not an operation-level
        // failure: Entry must keep this at target level with no exhaustion.
        return browserRefused(
          request.signal.aborted
            ? "browser-flow-cancelled"
            : "browser-page-unavailable",
          "The controlled Browser page could not be opened for this article.",
        );
      }
      let deliveredCandidate: DurableCandidate | null = null;
      // The article-page budget starts after the admitted page opens. The workbench
      // and driver use this same cutoff, including collaboration setup and waiting.
      const flowStartedAt = nowMs();
      const flowDeadlineAt =
        flowStartedAt + (options.deadline_ms ?? DEFAULT_FLOW_DEADLINE_MS);
      let collaboration:
        | Awaited<ReturnType<NonNullable<typeof options.collaboration>["open"]>>
        | undefined;
      if (options.collaboration) {
        try {
          collaboration = await options.collaboration.open(
            request,
            opened.page as FlowPageHandle,
            flowDeadlineAt,
          );
        } catch (error) {
          try {
            await opened.close();
          } catch (closeError) {
            throw new BrowserArticleCloseError(
              new AggregateError(
                [error, closeError],
                "Collaboration open and page cleanup failed",
              ),
            );
          }
          throw error;
        }
      }
      const run = async (): Promise<BrowserDeliveryResult> => {
        const driver = new BrowserArticleFlowDriver({
          page: opened.page as FlowPageHandle,
          start_url: startUrl,
          decide: options.decide,
          ...(collaboration
            ? {
                collaborativeStep: (signal: AbortSignal) =>
                  collaboration.step(signal),
              }
            : {}),
          max_actions: options.max_actions ?? DEFAULT_FLOW_MAX_ACTIONS,
          max_model_calls:
            options.max_model_calls ?? DEFAULT_FLOW_MAX_MODEL_CALLS,
          deadline_ms: options.deadline_ms ?? DEFAULT_FLOW_DEADLINE_MS,
          started_at: flowStartedAt,
          signal: request.signal,
          ...(options.observations
            ? { observations: options.observations }
            : {}),
          article_id: request.literature_id,
          session_id: options.session_id,
          awaitCandidate: options.awaitCandidate,
          ...(options.hasCandidate
            ? { hasCandidate: options.hasCandidate }
            : {}),
          ...(options.now ? { now: options.now } : {}),
        });
        try {
          const stopped = await driver.run();
          if (request.signal.aborted)
            return browserRefused(
              "browser-flow-cancelled",
              "The Browser delivery was cancelled while the flow was running.",
            );
          // The wait must be bounded: after the driver budgets end there may simply be
          // no PDF, and an unbounded wait would hang the delivery forever.
          const awaited = await withTimeout(
            options.awaitCandidate(request.signal),
            options.candidate_timeout_ms ?? DEFAULT_FLOW_CANDIDATE_WAIT_MS,
          );
          if (awaited.kind === "timed-out")
            return browserRefused(
              "browser-candidate-timeout",
              "The controlled Browser candidate did not settle before the wait deadline.",
            );
          const candidate = awaited.value;
          if (candidate === null)
            return stopped.stopped_reason === "stopped" ||
              stopped.stopped_reason === "no-candidate"
              ? Object.freeze({ kind: "exhausted" as const })
              : browserRefused(
                  stopped.stopped_reason === "cancelled"
                    ? "browser-flow-cancelled"
                    : stopped.stopped_reason === "budget"
                      ? "browser-flow-budget-exhausted"
                      : stopped.stopped_reason === "invalid-action"
                        ? "browser-action-invalid"
                        : "browser-observation-unavailable",
                  "The controlled Browser flow stopped before a normal no-PDF result.",
                );
          if (!candidate.accepted) {
            // `accepted` reflects only the identity/version assessment. A mismatch must
            // not be reported as a delivery, and the durable candidate it already spooled
            // has to be retired so no unowned record survives the attempt.
            await options.abandonCandidate?.(
              candidate.candidate,
              request.signal,
            );
            return browserRefused(
              "browser-identity-mismatch",
              "The delivered document did not match the target article identity.",
            );
          }
          deliveredCandidate = candidate.candidate;
          return Object.freeze({
            kind: "delivered" as const,
            candidate: candidate.candidate,
            accepted: true,
          });
        } catch {
          // Host, page, transfer, decision and intake failures are all Browser-tier
          // outcomes. Converting them here keeps the target-level report stable and
          // prevents an unclassified error from becoming an operation-level failure.
          return browserRefused(
            request.signal.aborted
              ? "browser-flow-cancelled"
              : "browser-flow-failed",
            "The controlled Browser flow failed before delivering a document.",
          );
        }
      };
      let result: BrowserDeliveryResult | undefined;
      let flowError: unknown;
      try {
        result = await run();
      } catch (error) {
        flowError = error;
      }
      const cleanupErrors: unknown[] = [];
      try {
        await collaboration?.beforeClose?.();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await opened.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await collaboration?.close(
          result?.kind !== "delivered" && result?.kind !== "exhausted",
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length) {
        if (deliveredCandidate !== null)
          try {
            await options.abandonCandidate?.(
              deliveredCandidate,
              request.signal,
            );
          } catch (error) {
            cleanupErrors.push(error);
          }
        throw new BrowserArticleCloseError(
          cleanupErrors.length === 1
            ? cleanupErrors[0]
            : new AggregateError(
                cleanupErrors,
                "Browser collaboration cleanup failed",
              ),
        );
      }
      if (flowError !== undefined) throw flowError;
      if (result === undefined) throw new Error("Browser flow did not settle");
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
