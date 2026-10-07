import { createHash, randomUUID } from "node:crypto";
import {
  parseLiteratureId,
  type CandidatePublicationReceipt,
  type LiteratureDetail,
  type LiteratureId,
  type MetadataObservation,
  type MetadataSnapshot,
  type VersionRole,
} from "@sciretriever/contracts";
import { CandidateAcceptanceService } from "../acquisition/candidate-acceptance.js";
import {
  assemblePublicPdfDownloadTransport,
  splitAcquisitionRoutes,
} from "../acquisition/assembly.js";
import {
  downloadPdfCandidate,
  downloadSourceCandidate,
  type PublicAcquisitionRegistry,
} from "../acquisition/sources/public.js";
import {
  AcquisitionCandidateSkippedError,
  AcquisitionRouteError,
  AcquisitionUnavailableError,
  classifyAcquisitionFailure,
  TieredAcquisitionService,
  type AcquisitionBatchFailure,
} from "../acquisition/tiered.js";
import type { BrowserTransferCollector } from "../browser/transfer.js";
import { BrowserArticleCloseError } from "../browser/article-flow.js";
import type {
  BrowserDeliveryResult,
  BrowserSessionHost,
} from "../browser/boundary.js";
import { createBrowserArticleGoal } from "../browser/boundary.js";
import type { BrowserArticleCloseOutcome } from "../browser/article-session.js";
import { createLogger } from "../logging/index.js";
import { BrowserArticleScheduler } from "./browser-scheduler.js";
import type { NetworkBudgetCoordinator } from "../network/budget.js";
import {
  directCompletionCommit,
  type CompletionCommit,
} from "./completion-execution.js";

export interface PdfAcquisitionRequest {
  readonly literature_id: LiteratureId;
  readonly detail: LiteratureDetail;
  readonly metadata_snapshot: MetadataSnapshot;
  readonly signal: AbortSignal;
  readonly commit?: CompletionCommit;
  /** Operation-local cohort generation; never persisted or reused across operations. */
  readonly generation?: number;
  readonly operation_id?: string;
  /** PDF hashes already rejected as NoUsableContent during this operation. */
  readonly excluded_sha256?: readonly string[];
}

/**
 * One automatic acquisition attempt for a single Literature. The outcome is
 * already classified: `exhausted` is the only value that may become a durable
 * exhaustion fact, and `failure` is the only value that may enter a report as
 * an unresolved automatic route failure.
 */
export type PdfAcquisitionOutcome =
  | {
      readonly kind: "acquired";
      readonly literature_id: LiteratureId;
      readonly receipt: CandidatePublicationReceipt;
    }
  | { readonly kind: "exhausted" }
  | {
      readonly kind: "route-failure";
      readonly failure: AcquisitionBatchFailure;
    }
  /** The frozen assistance policy paused this target: action-required, not a stop. */
  | {
      readonly kind: "assistance-required";
      readonly failure: AcquisitionBatchFailure;
    }
  /**
   * The frozen assistance policy reported this eligible target instead of continuing it.
   * It is an explicit, non-executed skip — never a failure partition and never a silent
   * success — and the stable `pdf-assistance-skipped` code travels on the progress detail.
   */
  | {
      readonly kind: "policy-skip";
      readonly failure: AcquisitionBatchFailure;
    }
  /**
   * A stable Browser-tier failure that must keep its own code in the target report
   * (for example `browser-runtime-unavailable` or `browser-flow-unavailable`).
   */
  | {
      readonly kind: "browser-failure";
      readonly code: string;
      readonly reason: string;
    }
  /** A user-controlled stop; the only outcome mapped to `interrupted`. */
  | { readonly kind: "cancelled" };

export interface PdfAcquisitionPort {
  acquire(request: PdfAcquisitionRequest): Promise<PdfAcquisitionOutcome>;
  /**
   * Prepare one bounded generation behind Public/API/Browser barriers. Results
   * may be emitted in frozen request order after each tier so successful
   * targets can continue while the unresolved remainder enters a riskier tier.
   */
  acquireCohort?(
    requests: readonly PdfAcquisitionRequest[],
    options?: {
      readonly on_outcomes?: (
        outcomes: readonly PdfAcquisitionCohortOutcome[],
      ) => void;
    },
  ): Promise<readonly PdfAcquisitionOutcome[]>;
  /** Stop admitting Browser deliveries and drain the process-local lane. */
  close?(): Promise<void>;
}

export interface PdfAcquisitionCohortOutcome {
  readonly index: number;
  readonly outcome: PdfAcquisitionOutcome;
}

export interface EntryPdfAcquisitionPorts {
  readonly registry: PublicAcquisitionRegistry;
  readonly network_budget: NetworkBudgetCoordinator;
  readonly transfers: BrowserTransferCollector;
  readonly acceptance: CandidateAcceptanceService;
  readonly assistance?: "never" | "notify" | "pause";
  readonly cooldown_ms?: number;
  /**
   * The process-owned controlled Browser session, reached through Bootstrap. It is
   * the last escalation after every public and authorized API route failed, and it is
   * optional: an unwired or disabled tier simply contributes no Browser attempt.
   */
  readonly browser_host?: () => BrowserSessionHost | null;
  readonly browser_scheduler?: BrowserArticleScheduler;
}

export class BrowserDeliveryStaleGenerationError extends Error {
  readonly code = "browser-stale-generation" as const;
  constructor() {
    super("browser delivery generation is stale");
    this.name = "BrowserDeliveryStaleGenerationError";
  }
}

/** Process-local Browser lane shared by every target in one Application. */
export class BrowserDeliveryScheduler {
  private tail: Promise<void> = Promise.resolve();
  private readonly latest = new Map<string, number>();
  private closed = false;

  run<T>(
    operationId: string,
    generation: number,
    signal: AbortSignal,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new DOMException(
          "Browser delivery scheduler closed",
          "InvalidStateError",
        ),
      );
    const previous = this.latest.get(operationId) ?? 0;
    if (generation < previous)
      return Promise.reject(new BrowserDeliveryStaleGenerationError());
    this.latest.set(operationId, generation);
    const pending = this.tail.then(async () => {
      if (this.closed)
        throw new DOMException(
          "Browser delivery scheduler closed",
          "InvalidStateError",
        );
      if (signal.aborted)
        throw new DOMException("Browser delivery cancelled", "AbortError");
      const current = this.latest.get(operationId) ?? generation;
      if (generation < current) throw new BrowserDeliveryStaleGenerationError();
      return action();
    });
    this.tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async drain(): Promise<void> {
    await this.tail;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.drain();
    this.latest.clear();
  }
}

/**
 * One Application-scoped session broker. It owns Browser delivery admission
 * and queue lifetime while Bootstrap remains the owner of the actual host.
 */
export class BrowserSessionBroker {
  private readonly scheduler = new BrowserDeliveryScheduler();
  private readonly active = new Set<AbortController>();
  private closed = false;

  constructor(
    private readonly host: () => BrowserSessionHost | null,
    private readonly articles = new BrowserArticleScheduler({
      sessions: 5,
      workers: 2,
    }),
  ) {}

  async deliver(
    request: PdfAcquisitionRequest,
    action: (
      host: BrowserSessionHost,
      signal: AbortSignal,
    ) => Promise<BrowserDeliveryResult>,
  ): Promise<BrowserDeliveryResult | null> {
    if (this.closed)
      throw new DOMException("Browser broker closed", "InvalidStateError");
    const host = this.host();
    if (!host) return null;
    const open = host.openArticle?.bind(host);
    if (open)
      return action(
        {
          deliverCandidate: (input) => this.articles.deliver(input, open),
          close: () => host.close(),
        },
        request.signal,
      );
    return this.scheduler.run(
      request.operation_id ?? "direct",
      request.generation ?? 0,
      request.signal,
      async () => {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        request.signal.addEventListener("abort", cancel, { once: true });
        this.active.add(controller);
        try {
          if (request.signal.aborted || this.closed) controller.abort();
          return await action(host, controller.signal);
        } finally {
          this.active.delete(controller);
          request.signal.removeEventListener("abort", cancel);
        }
      },
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.active) controller.abort();
    await Promise.all([this.articles.close(), this.scheduler.close()]);
  }
}

/**
 * Entry-owned automatic PDF acquisition over the locator source registry.
 * The controlled Browser is deliberately escalated outside that locator batch through
 * the process-owned Browser session; an unavailable or unadmitted tier is reported
 * as a stable failure instead of silently truncating the attempt (S4).
 */
export class EntryPdfAcquisitionService implements PdfAcquisitionPort {
  private readonly routes: ReturnType<typeof splitAcquisitionRoutes>;
  private readonly publicLocator: TieredAcquisitionService;
  private readonly apiLocator: TieredAcquisitionService;
  private readonly browserBroker: BrowserSessionBroker;
  private readonly lifetime = new AbortController();
  private readonly active = new Set<
    Promise<readonly PdfAcquisitionOutcome[]>
  >();
  private closing: Promise<void> | undefined;
  /**
   * Operation-local locator evidence. A later generation can reject a locator before
   * downloading it again when its previously delivered bytes are now listed in
   * `excluded_sha256`. Keys are digests so signed locators never remain in memory as
   * diagnostic state. The bounded map is only an optimization; hash exclusion after
   * download remains the correctness boundary.
   */
  private readonly deliveredHashes = new Map<string, Map<string, string>>();

  constructor(private readonly ports: EntryPdfAcquisitionPorts) {
    this.routes = splitAcquisitionRoutes(ports.registry);
    const options = {
      assistance: ports.assistance ?? "never",
      cooldown_ms: ports.cooldown_ms ?? 30_000,
      max_items: 100_000,
    } as const;
    this.publicLocator = new TieredAcquisitionService(
      this.routes.public_routes,
      options,
    );
    this.apiLocator = new TieredAcquisitionService(
      this.routes.authorized_api_routes,
      options,
    );
    this.browserBroker = new BrowserSessionBroker(
      ports.browser_host ?? (() => null),
      ports.browser_scheduler,
    );
  }

  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      try {
        await this.browserBroker.close();
      } finally {
        // Delivery does not end Entry's ownership of acceptance or its real reader.
        await Promise.allSettled([...this.active]);
      }
    });
    this.lifetime.abort();
    return this.closing;
  }

  async acquire(
    request: PdfAcquisitionRequest,
  ): Promise<PdfAcquisitionOutcome> {
    const [outcome] = await this.trackCohort([request], {}, true);
    if (!outcome) throw new TypeError("acquisition cohort returned no result");
    return outcome;
  }

  async acquireCohort(
    requests: readonly PdfAcquisitionRequest[],
    options: {
      readonly on_outcomes?: (
        outcomes: readonly PdfAcquisitionCohortOutcome[],
      ) => void;
    } = {},
  ): Promise<readonly PdfAcquisitionOutcome[]> {
    return this.trackCohort(requests, options, false);
  }

  private trackCohort(
    requests: readonly PdfAcquisitionRequest[],
    options: Parameters<EntryPdfAcquisitionService["acquireCohort"]>[1],
    preserveSinglePriorFailure: boolean,
  ): Promise<readonly PdfAcquisitionOutcome[]> {
    const pending = this.acquireCohortInternal(
      requests,
      options ?? {},
      preserveSinglePriorFailure,
    );
    this.active.add(pending);
    const finished = () => this.active.delete(pending);
    void pending.then(finished, finished);
    return pending;
  }

  private async acquireCohortInternal(
    incoming: readonly PdfAcquisitionRequest[],
    options: {
      readonly on_outcomes?: (
        outcomes: readonly PdfAcquisitionCohortOutcome[],
      ) => void;
    },
    preserveSinglePriorFailure: boolean,
  ): Promise<readonly PdfAcquisitionOutcome[]> {
    if (!Array.isArray(incoming) || incoming.length > 100_000)
      throw new TypeError("acquisition cohort request is invalid");
    const ids = new Set<string>();
    for (const request of incoming) {
      const id = parseLiteratureId(request.literature_id);
      if (ids.has(id))
        throw new TypeError("acquisition cohort Literature is duplicated");
      ids.add(id);
    }
    const requests = incoming.map((request) => ({
      ...request,
      signal: AbortSignal.any([request.signal, this.lifetime.signal]),
    }));
    const final = new Array<PdfAcquisitionOutcome | undefined>(requests.length);
    const priorFailures = new Map<number, AcquisitionBatchFailure>();
    let active = requests.map((_request, index) => index);
    const emit = (wave: readonly PdfAcquisitionCohortOutcome[]) => {
      if (!wave.length) return;
      const ordered = Object.freeze(
        [...wave].sort((a, b) => a.index - b.index),
      );
      options.on_outcomes?.(ordered);
    };
    for (const locator of [this.publicLocator, this.apiLocator]) {
      if (!active.length) break;
      const results = await Promise.all(
        active.map((index) => this.runLocator(requests[index]!, locator)),
      );
      const wave: PdfAcquisitionCohortOutcome[] = [];
      const unresolved: number[] = [];
      for (let position = 0; position < active.length; position += 1) {
        const index = active[position]!;
        const result = results[position]!;
        const outcome = result.outcome;
        if (preserveSinglePriorFailure && result.priorFailure)
          priorFailures.set(index, result.priorFailure);
        if (outcome.kind === "exhausted") unresolved.push(index);
        else {
          final[index] = outcome;
          wave.push(Object.freeze({ index, outcome }));
        }
      }
      emit(wave);
      active = unresolved;
    }
    if (active.length) {
      const browserWave = await Promise.all(
        active.map(async (index) => {
          const request = requests[index]!;
          const outcome = this.routes.browser.enabled
            ? await this.attemptBrowserEscalation(
                request,
                parseLiteratureId(request.literature_id),
                this.routes.browser,
                preserveSinglePriorFailure
                  ? (priorFailures.get(index) ?? null)
                  : null,
              )
            : ({ kind: "exhausted" } as const);
          final[index] = outcome;
          return Object.freeze({ index, outcome });
        }),
      );
      emit(browserWave);
    }
    if (final.some((outcome) => outcome === undefined))
      throw new TypeError("acquisition cohort partition is incomplete");
    return Object.freeze(final as PdfAcquisitionOutcome[]);
  }

  private async runLocator(
    request: PdfAcquisitionRequest,
    locator: TieredAcquisitionService,
  ): Promise<{
    readonly outcome: PdfAcquisitionOutcome;
    readonly priorFailure?: AcquisitionBatchFailure;
  }> {
    const literatureId = parseLiteratureId(request.literature_id);
    if (request.signal.aborted) return { outcome: { kind: "cancelled" } };
    const publications: CandidatePublicationReceipt[] = [];
    // Single acquisition path: the tiered service only sees the locator routes, and the
    // controlled Browser is escalated to exactly once afterwards. Leaving the throwing
    // Browser source inside the batch would abort the run before it could deliver.
    // The unavailable Browser tier fails closed with a non-retryable route error, which
    // aborts its own one-item batch. That is the signal to escalate to the controlled
    // Browser, not an operation-level failure: the public/API tier already concluded.
    let result:
      | Awaited<ReturnType<TieredAcquisitionService["run"]>>[number]
      | undefined;
    try {
      [result] = await locator.run(
        [
          {
            key: literatureId,
            request: {
              identifiers: request.detail.literature.metadata.identifiers,
              observations: request.detail.metadata_observations,
              asset_hints: request.detail.metadata_observations.flatMap(
                (observation) => observation.asset_hints,
              ),
            },
          },
        ],
        async (_item, source, candidate, signal) => {
          const operationKey = `${request.operation_id ?? "direct"}:${literatureId}`;
          const locatorKey = createHash("sha256")
            .update(candidate.locator)
            .digest("hex");
          const knownHash = this.deliveredHashes
            .get(operationKey)
            ?.get(locatorKey);
          if (knownHash && request.excluded_sha256?.includes(knownHash))
            throw new AcquisitionCandidateSkippedError();
          const operationId = randomUUID();
          const transferId = `entry-pdf-${operationId}`;
          const sourceUrl = new URL(candidate.locator);
          sourceUrl.search = "";
          sourceUrl.hash = "";
          const downloadOptions = {
            collector: this.ports.transfers,
            transfer_id: transferId,
            signal,
            capture: {
              session_id: `entry-pdf-${operationId}`,
              article_id: literatureId,
              page_id: candidate.source,
              document_generation: 0,
              source_url: sourceUrl.toString(),
              captured_at: new Date().toISOString(),
            },
          };
          let durable;
          try {
            if (source.download_candidate)
              durable = await downloadSourceCandidate(candidate, {
                ...downloadOptions,
                registry: this.ports.registry,
              });
            else
              durable = await downloadPdfCandidate(
                candidate,
                assemblePublicPdfDownloadTransport(
                  candidate,
                  this.ports.network_budget,
                ),
                downloadOptions,
              );
          } catch (error) {
            // A rejected candidate is one route outcome. Cancellation and every
            // storage/receipt/system failure must keep their own identity.
            if (signal.aborted) throw error;
            if (
              error instanceof AcquisitionCandidateSkippedError ||
              error instanceof AcquisitionUnavailableError ||
              error instanceof AcquisitionRouteError
            )
              throw error;
            if (error instanceof Error && /^acquisition /u.test(error.message))
              throw new AcquisitionRouteError(
                "candidate-download-failed",
                "The candidate bytes were rejected by the acquisition boundary.",
                true,
              );
            throw error;
          }
          if (request.excluded_sha256?.includes(durable.sha256)) {
            this.rememberDeliveredHash(
              operationKey,
              locatorKey,
              durable.sha256,
            );
            await this.ports.transfers.discard(transferId);
            throw new AcquisitionCandidateSkippedError();
          }
          this.rememberDeliveredHash(operationKey, locatorKey, durable.sha256);
          publications.push(
            await (request.commit ?? directCompletionCommit)(() =>
              this.ports.acceptance.accept(
                {
                  receipt_id: `entry-pdf-${operationId}`,
                  literature_id: literatureId,
                  transfer_id: transferId,
                  metadata_snapshot: request.metadata_snapshot,
                },
                signal,
              ),
            ),
          );
        },
        { signal: request.signal },
      );
    } catch (error) {
      if (classifyAcquisitionFailure(error, request.signal) === "cancel")
        return { outcome: { kind: "cancelled" } };
      if (!(error instanceof AcquisitionRouteError) || error.retryable)
        throw error;
      // A non-retryable route error is surfaced with its own stable code. It is never
      // escalated on the strength of its code: only a route that declared an explicit
      // low-risk unavailability can authorize the Browser, and an action-required or
      // deferred state must never become an automatic Browser run (ADR 0015 §7).
      const failure = Object.freeze({
        code: error.code,
        source: null,
        reason: error.reason,
        retryable: false,
      });
      return {
        outcome: { kind: "route-failure", failure },
        priorFailure: failure,
      };
    }
    if (!result) throw new TypeError("acquisition batch returned no result");
    if (result.disposition === "interrupted")
      // A policy pause and a user stop are different facts: only a stop is a
      // cancellation, and a pause keeps its own stable failure.
      return {
        outcome:
          result.failure?.code === "assistance-required"
            ? { kind: "assistance-required", failure: result.failure }
            : { kind: "cancelled" },
      };
    if (result.disposition === "skipped")
      // The target was eligible and a route ran, yet the frozen assistance policy only
      // reports it: that is an explicit, non-executed skip (the operator decision), never
      // a failure partition and never a silent success. The stable
      // `pdf-assistance-skipped` code stays on the progress detail for stderr.
      return {
        outcome: {
          kind: "policy-skip",
          failure:
            result.failure ??
            Object.freeze({
              code: "assistance-skipped" as const,
              source: result.source,
              reason:
                "The frozen assistance policy stopped the target after a route failure.",
              retryable: false,
            }),
        },
      };
    const publication = publications.at(-1);
    if (result.disposition === "acquired" && publication)
      return {
        outcome: {
          kind: "acquired",
          literature_id: literatureId,
          receipt: publication,
        },
      };
    if (result.disposition === "exhausted")
      return { outcome: { kind: "exhausted" } };
    if (
      result.disposition === "failed" &&
      result.failure?.unavailability != null
    )
      return {
        outcome: { kind: "exhausted" },
        priorFailure: result.failure,
      };
    // ADR 0015 §7 is fail-closed: a resolved route failure (timeout, temporary
    // transport/API failure, 429/Retry-After, quota/deferred, action-required, system,
    // storage, cancel, or any other unresolved route-local issue) must never be converted
    // into Browser traffic. Only the two cases above escalate: a normal miss (every
    // applicable route ended without a candidate) and a route's own explicit low-risk
    // declaration.
    const failure =
      result.failure ??
      Object.freeze({
        code: "download-unavailable" as const,
        source: result.source,
        reason: "No acquisition route delivered an admitted primary PDF.",
        retryable: false,
      });
    return { outcome: { kind: "route-failure", failure } };
  }

  private rememberDeliveredHash(
    operationKey: string,
    locatorKey: string,
    sha256: string,
  ): void {
    let locators = this.deliveredHashes.get(operationKey);
    if (!locators) {
      locators = new Map();
      this.deliveredHashes.set(operationKey, locators);
      while (this.deliveredHashes.size > 128)
        this.deliveredHashes.delete(this.deliveredHashes.keys().next().value!);
    }
    locators.set(locatorKey, sha256);
    while (locators.size > 256) locators.delete(locators.keys().next().value!);
  }

  /**
   * Deliver through the controlled Browser session, then hand the spooled candidate to
   * the ordinary acceptance/receipt path.
   *
   * `priorFailure` carries the already-recorded explicit low-risk unavailability when this
   * escalation follows one: the original failure stays the target's stable outcome if the
   * Browser cannot deliver, so a rescue attempt never masks the reason the locator routes
   * stopped and never invents a second failure taxonomy.
   *
   * The Browser tier never reports a candidate locator and never returns an empty
   * route result: an empty result reads as a normal route end and could be committed
   * as a durable exhaustion fact for an article that was never fetched. A refusal is a
   * stable unresolved failure instead.
   */
  private async attemptBrowserEscalation(
    request: PdfAcquisitionRequest,
    literatureId: LiteratureId,
    browser: { readonly unavailable_reason: string | null },
    priorFailure: AcquisitionBatchFailure | null,
  ): Promise<PdfAcquisitionOutcome> {
    let delivery: BrowserDeliveryResult;
    try {
      const delivered = await this.browserBroker.deliver(
        request,
        (session, signal) =>
          session.deliverCandidate({
            literature_id: literatureId,
            identifier: browserIdentifier(request),
            version: request.detail.literature.version_role,
            article_goal: createBrowserArticleGoal({
              literature_id: literatureId,
              identifier: browserIdentifier(request),
              version: request.detail.literature.version_role,
              metadata: request.detail.literature.metadata,
            }),
            start_url: browserStartUrl(
              request.detail.metadata_observations,
              request.detail.literature.version_role,
              request.detail.literature.metadata.identifiers,
            ),
            metadata_snapshot: request.metadata_snapshot,
            signal,
            generation: request.generation ?? 0,
            ...(request.excluded_sha256
              ? { excluded_sha256: request.excluded_sha256 }
              : {}),
            ...(request.operation_id !== undefined
              ? { operation_id: request.operation_id }
              : {}),
          }),
      );
      if (!delivered)
        return priorFailure !== null
          ? { kind: "route-failure", failure: priorFailure }
          : {
              kind: "browser-failure",
              code: browser.unavailable_reason ?? "browser-host-not-wired",
              reason:
                "The controlled Browser route is admitted but no session is available in this process.",
            };
      delivery = delivered;
    } catch (error) {
      if (error instanceof BrowserArticleCloseError)
        return {
          kind: "browser-failure",
          code: error.code,
          reason: "The controlled Browser article could not be closed cleanly.",
        };
      if (error instanceof BrowserDeliveryStaleGenerationError)
        return {
          kind: "browser-failure",
          code: error.code,
          reason:
            "The queued Browser delivery belongs to an obsolete cohort generation.",
        };
      if (classifyAcquisitionFailure(error, request.signal) === "cancel")
        return { kind: "cancelled" };
      throw error;
    }
    if (delivery.kind === "exhausted")
      return priorFailure !== null
        ? { kind: "route-failure", failure: priorFailure }
        : { kind: "exhausted" };
    if (
      delivery.kind === "refused" &&
      delivery.code === "browser-flow-cancelled"
    )
      return { kind: "cancelled" };
    if (delivery.kind === "refused")
      return priorFailure !== null
        ? { kind: "route-failure", failure: priorFailure }
        : {
            kind: "browser-failure",
            code: delivery.code,
            reason: delivery.reason,
          };
    let closeOutcome: BrowserArticleCloseOutcome = {
      kind: "retained",
      code: "browser-publication-incomplete",
    };
    const acceptanceSignal = delivery.lease?.signal
      ? AbortSignal.any([request.signal, delivery.lease.signal])
      : request.signal;
    try {
      if (acceptanceSignal.aborted) {
        closeOutcome = { kind: "cancelled" };
        return { kind: "cancelled" };
      }
      if (!delivery.accepted) {
        closeOutcome = { kind: "retained", code: "browser-candidate-rejected" };
        return {
          kind: "browser-failure",
          code: "browser-candidate-rejected",
          reason: "The Browser delivery did not pass PDF file admission.",
        };
      }
      if (request.excluded_sha256?.includes(delivery.candidate.sha256)) {
        // Production rejects this in the live session and continues exploration.
        // A legacy delivery seam violating that handoff is an error, not exhaustion.
        closeOutcome = { kind: "retained", code: "browser-candidate-excluded" };
        return {
          kind: "browser-failure",
          code: "browser-candidate-excluded",
          reason:
            "The Browser returned an excluded candidate instead of continuing the article session.",
        };
      }
      const publication = await (request.commit ?? directCompletionCommit)(() =>
        this.ports.acceptance.accept(
          {
            receipt_id: `entry-browser-${delivery.candidate.transfer_id}`,
            literature_id: literatureId,
            transfer_id: delivery.candidate.transfer_id,
            metadata_snapshot: request.metadata_snapshot,
          },
          acceptanceSignal,
        ),
      );
      closeOutcome = { kind: "published", receipt_id: publication.receipt_id };
      return {
        kind: "acquired",
        literature_id: literatureId,
        receipt: publication,
      };
    } catch (error) {
      if (classifyAcquisitionFailure(error, acceptanceSignal) === "cancel") {
        closeOutcome = { kind: "cancelled" };
        return { kind: "cancelled" };
      }
      throw error;
    } finally {
      try {
        await delivery.lease?.close(closeOutcome);
      } catch (error) {
        // Cleanup is a separate diagnostic. Never revoke a committed publication
        // or discard a valid retained candidate to disguise a cleanup failure.
        createLogger("pdf-acquisition").error(
          "Browser article cleanup failed",
          {
            code: "browser-flow-close-failed",
            status: closeOutcome.kind,
            cause_code:
              error instanceof Error &&
              "code" in error &&
              typeof error.code === "string" &&
              /^browser-[a-z-]{1,80}$/u.test(error.code)
                ? error.code
                : "browser-session-cleanup-failed",
          },
        );
      }
    }
  }
}

/**
 * The one already-admitted landing page the Browser delivery may start from.
 *
 * It comes from the target's own observations (`asset_hints`, `kind =
 * "landing-page"`), is restricted to HTTP(S) without embedded credentials or a
 * fragment, and matches the frozen target version (an unversioned hint is the only
 * hint fallback). When metadata has a canonical DOI but no landing hint, the generic
 * DOI resolver is the only additional start point; Entry never asks the Agent to guess
 * a Publisher URL.
 */
export function browserStartUrl(
  observations: readonly MetadataObservation[],
  targetVersion: VersionRole,
  identifiers: readonly {
    readonly namespace: string;
    readonly value: string;
  }[] = [],
): string | null {
  const admitted = observations.flatMap(
    (observation) => observation.asset_hints,
  );
  const safe = (hint: (typeof admitted)[number]): string | null => {
    if (hint.kind !== "landing-page") return null;
    let url: URL;
    try {
      url = new URL(hint.url);
    } catch {
      return null;
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      return null;
    return url.toString();
  };
  // Exact version match wins; an unversioned hint is the only safe fallback (its
  // landing page is not claimed to belong to a different concrete version). A hint
  // that names another version is never navigated to.
  const ordered = [
    ...admitted.filter((hint) => hint.version_role === targetVersion),
    ...admitted.filter((hint) => hint.version_role === null),
  ];
  for (const hint of ordered) {
    const url = safe(hint);
    if (url !== null) return url;
  }
  const doi = identifiers
    .find(
      (identifier) =>
        identifier.namespace.toLowerCase() === "doi" &&
        /^10\.\d{4,9}\/.+$/iu.test(identifier.value.trim()) &&
        !/[\s?#]/u.test(identifier.value.trim()),
    )
    ?.value.trim();
  if (doi)
    return `https://doi.org/${doi
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/")}`;
  return null;
}

/** The stable identifier the Browser delivery must attribute its bytes to. */
function browserIdentifier(request: PdfAcquisitionRequest): string {
  const stable = request.detail.literature.metadata.identifiers.find(
    (identifier) =>
      identifier.namespace === "doi" || identifier.namespace === "arxiv",
  );
  return stable
    ? `${stable.namespace}:${stable.value}`
    : (request.detail.literature.metadata.title ?? "untitled");
}
