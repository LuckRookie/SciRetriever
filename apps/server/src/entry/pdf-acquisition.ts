import {
  parseAcquisitionAttempt,
  parsePdfSourceResult,
  type PdfSourceResult,
  MAX_ACQUISITION_ATTEMPTS,
  type AcquisitionAttempt,
} from "@sciretriever/contracts";
import { observeNetworkRequests } from "../network/request-activity.js";
import { observeNetworkEgress, isProxyUnavailable } from "../network/egress.js";
import { outboundEgress, selectedEgress } from "../configuration/egress.js";
import { sourceProblem } from "../providers/shared/source-problem.js";
import { createHash, randomUUID } from "node:crypto";
import {
  parseLiteratureId,
  BROWSER_AGENT_STOP_REASONS,
  type CandidatePublicationReceipt,
  type LiteratureDetail,
  type LiteratureId,
  type MetadataObservation,
  type MetadataSnapshot,
  type VersionRole,
} from "@sciretriever/contracts";
import { CandidateAcceptanceService } from "../acquisition/candidate-acceptance.js";
import { resolveDoiLanding } from "../acquisition/doi-resolution.js";
import type { AcquisitionStage } from "../acquisition/ports.js";
import { authorizedTargets } from "../providers/acquisition.js";
import {
  resolvePublisherNames,
  type PublisherAliases,
} from "../providers/publisher-names.js";
import {
  articleUrl,
  browserStartUrls,
  createAcquisitionContext,
  doiStartUrl,
  type AcquisitionContext,
} from "./acquisition-context.js";
export { browserStartUrls } from "./acquisition-context.js";
import {
  assemblePublicPdfDownloadTransport,
  splitAcquisitionRoutes,
} from "../acquisition/assembly.js";
import {
  downloadPdfCandidate,
  downloadSourceCandidate,
  DoiLandingSource,
  hasPdfHeader,
  PublicAcquisitionRegistry,
} from "../acquisition/sources/public.js";
import {
  AcquisitionCandidateSkippedError,
  AcquisitionRouteError,
  AcquisitionUnavailableError,
  classifyAcquisitionFailure,
  routeFailure,
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
import type { HttpResponse } from "../network/http.js";
import {
  directCompletionCommit,
  type CompletionCommit,
} from "./completion-execution.js";

export interface PdfAcquisitionRequest {
  readonly literature_id: LiteratureId;
  readonly detail: LiteratureDetail;
  readonly on_attempt?: (attempt: AcquisitionAttempt) => Promise<void>;
  readonly on_source_result?: (result: PdfSourceResult) => Promise<void>;
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
   * Prepare one bounded generation behind the five acquisition-stage barriers. Results
   * are emitted after each HTTP tier; Browser results are emitted individually.
   * The final array preserves request order without delaying fast Browser feedback.
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
  readonly acquisition_options?: import("../acquisition/assembly.js").PublicAcquisitionAssemblyOptions;
  readonly registry: PublicAcquisitionRegistry;
  readonly network_budget: NetworkBudgetCoordinator;
  readonly transfers: BrowserTransferCollector;
  readonly acceptance: CandidateAcceptanceService;
  readonly assistance?: "never" | "notify" | "pause";
  readonly cooldown_ms?: number;
  readonly publisher_aliases?: PublisherAliases;
  /** DOI locator resolution only; never a publisher request or Browser probe. */
  readonly resolve_doi_landing?: (
    url: string,
    signal: AbortSignal,
    options: { readonly on_response: (response: HttpResponse) => void },
  ) => Promise<string | null>;
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
  private readonly locators: readonly {
    readonly stage: AcquisitionStage;
    readonly service: TieredAcquisitionService;
  }[];
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
      // Operator assistance is considered after all automatic stages, not between them.
      assistance: "never",
      cooldown_ms: ports.cooldown_ms ?? 30_000,
      max_items: 100_000,
    } as const;
    this.locators = (
      ["direct", "publisher-api", "general-api", "public-web"] as const
    ).map((stage) => ({
      stage,
      service: new TieredAcquisitionService(this.routes.stages[stage], options),
    }));
    this.browserBroker = new BrowserSessionBroker(
      ports.browser_host ?? (() => null),
      ports.browser_scheduler,
    );
  }

  private async preparePublisherEvidence(
    request: PdfAcquisitionRequest,
    context: AcquisitionContext,
  ): Promise<PdfAcquisitionOutcome | null> {
    const providers = this.routes.stages["publisher-api"].sources.filter(
      (source) =>
        source.ready &&
        (source.source_name === "elsevier" || source.source_name === "wiley"),
    );
    if (!providers.length) return null;
    const identifiers = request.detail.literature.metadata.identifiers;
    const observations = request.detail.metadata_observations;
    const input = {
      identifiers,
      observations,
      target_version: request.detail.literature.version_role,
      landing_origins: [...context.landing_origins],
    };
    if (
      providers.some(
        (source) =>
          authorizedTargets(source.source_name as "elsevier" | "wiley", input)
            .length > 0,
      )
    )
      return null;
    const doi = doiStartUrl(identifiers);
    if (!doi) return null;
    if (
      context.attempted_locators.has(
        createHash("sha256").update(doi).digest("hex"),
      )
    )
      return null;
    const startedAt = new Date().toISOString();
    let requested = false;
    let resolutionResult: AcquisitionAttempt["result"] = "miss";
    let resolutionCode = "access-evidence-ready";
    const egresses = new Set<import("@sciretriever/contracts").NetworkEgress>();
    const candidates = this.publisherCandidates(request);
    createLogger("pdf-acquisition").debug("Resolving article access evidence", {
      candidate_count: candidates.length,
      source_count: providers.length,
      evidence: candidates.length ? "publisher-name" : "doi",
    });
    try {
      if (request.signal.aborted)
        throw new DOMException("Acquisition cancelled", "AbortError");
      const target = await observeNetworkEgress(
        (egress) => egresses.add(egress),
        () =>
          observeNetworkRequests(
            () => {
              requested = true;
            },
            () =>
              (
                this.ports.resolve_doi_landing ??
                ((url, signal, options) =>
                  resolveDoiLanding(url, this.ports.network_budget, signal, {
                    ...options,
                    egress: outboundEgress(
                      this.ports.acquisition_options?.network,
                      { kind: "doi-resolution" },
                      this.ports.acquisition_options?.credentials,
                      this.ports.acquisition_options?.currentCredential,
                    ),
                  }))
              )(doi, request.signal, {
                on_response: (response) => {
                  context.doi_response = { url: doi, response };
                },
              }),
          ),
      );
      if (request.signal.aborted)
        throw new DOMException("Acquisition cancelled", "AbortError");
      const safe = target === null ? null : articleUrl(target);
      if (safe && safe !== doi) {
        context.doi_landing = safe;
        context.doi_response = null;
        context.landing_urls.push(safe);
        context.landing_origins.add(new URL(safe).origin);
      }
      if (
        context.doi_response &&
        context.doi_response.response.status >= 200 &&
        context.doi_response.response.status < 300 &&
        hasPdfHeader(context.doi_response.response)
      ) {
        // A resolver that already served PDF bytes needs no API lookup or second GET.
        const cached = new TieredAcquisitionService(
          new PublicAcquisitionRegistry(
            [new DoiLandingSource()],
            ["doi-landing"],
          ),
          { assistance: "never" },
        );
        const outcome = (await this.runLocator(request, cached, context))
          .outcome;
        if (outcome.kind === "acquired") resolutionResult = "hit";
        return outcome;
      }
      return null;
    } catch (error) {
      resolutionResult = "failed";
      resolutionCode = isProxyUnavailable(error)
        ? "proxy-unavailable"
        : "doi-resolution-failed";
      const kind = classifyAcquisitionFailure(error, request.signal);
      if (kind === "cancel") return { kind: "cancelled" };
      if (kind !== "route" && !(error instanceof AcquisitionRouteError))
        throw error;
      return {
        kind: "route-failure",
        failure: routeFailure(error, "doi-resolution", {
          code: "network-failed",
          source: "doi-resolution",
          reason: "Article resolution could not be completed.",
          retryable: false,
        }),
      };
    } finally {
      await this.recordAttempt(request, context, {
        stage: "publisher-api",
        source: "doi-resolution",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        requested,
        result: resolutionResult,
        code: resolutionCode,
        egresses: [...egresses],
      });
    }
  }

  private publisherCandidates(
    request: PdfAcquisitionRequest,
  ): readonly string[] {
    const names = [
      request.detail.literature.metadata.publisher,
      ...request.detail.metadata_observations.map(
        (item) => item.metadata.publisher,
      ),
    ].filter((name): name is string => name !== null);
    const candidates = [
      ...new Set(
        names.flatMap((name) =>
          resolvePublisherNames(name, this.ports.publisher_aliases),
        ),
      ),
    ];
    // Conflicting observations do not override the configured source order.
    return candidates.length === 1 ? candidates : [];
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
    const contexts = requests.map(() => createAcquisitionContext());
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
    for (const { stage, service: locator } of this.locators) {
      if (!active.length) break;
      for (const index of active)
        for (const route of this.ports.registry.not_enabled.filter(
          (r) => r.stage === stage,
        )) {
          const at = new Date().toISOString();
          await this.recordAttempt(requests[index]!, contexts[index]!, {
            stage,
            source: route.source,
            started_at: at,
            finished_at: at,
            requested: false,
            result: "not-enabled",
            code: "source-not-enabled",
          });
        }
      if (stage === "publisher-api") {
        const prepared = await Promise.all(
          active.map(async (index) => ({
            index,
            outcome: await this.preparePublisherEvidence(
              requests[index]!,
              contexts[index]!,
            ),
          })),
        );
        const stopped: PdfAcquisitionCohortOutcome[] = [];
        for (const { index, outcome } of prepared) {
          if (!outcome || outcome.kind === "exhausted") continue;
          if (outcome.kind === "route-failure")
            priorFailures.set(
              index,
              priorFailures.get(index) ?? outcome.failure,
            );
          else {
            final[index] = outcome;
            stopped.push({ index, outcome });
          }
        }
        emit(stopped);
        active = active.filter((index) => final[index] === undefined);
      }
      const results = await Promise.all(
        active.map((index) =>
          this.runLocator(
            requests[index]!,
            locator,
            contexts[index]!,
            stage === "publisher-api"
              ? this.publisherCandidates(requests[index]!)
              : [],
          ),
        ),
      );
      const wave: PdfAcquisitionCohortOutcome[] = [];
      const unresolved: number[] = [];
      for (let position = 0; position < active.length; position += 1) {
        const index = active[position]!;
        const result = results[position]!;
        const outcome = result.outcome;
        if (
          preserveSinglePriorFailure &&
          result.priorFailure &&
          !priorFailures.has(index)
        )
          priorFailures.set(index, result.priorFailure);
        if (outcome.kind === "route-failure") {
          // A source failure does not decide another source's access. Keep the first
          // unresolved failure if subsequent independent routes also fail to deliver.
          const prior = priorFailures.get(index);
          if (!prior || prior.unavailability != null)
            priorFailures.set(index, outcome.failure);
          unresolved.push(index);
        } else if (outcome.kind === "exhausted") unresolved.push(index);
        else {
          final[index] = outcome;
          wave.push(Object.freeze({ index, outcome }));
        }
      }
      emit(wave);
      active = unresolved;
    }
    if (active.length) {
      const browserAbort = new AbortController();
      const browserFailures: unknown[] = [];
      await Promise.allSettled(
        active.map(async (index) => {
          const request = {
            ...requests[index]!,
            signal: AbortSignal.any([
              requests[index]!.signal,
              browserAbort.signal,
            ]),
          };
          try {
            if (!this.routes.browser.enabled) {
              const at = new Date().toISOString();
              await this.recordAttempt(request, contexts[index]!, {
                stage: "browser",
                source: "browser",
                started_at: at,
                finished_at: at,
                requested: false,
                result: "not-enabled",
                code: "browser-disabled",
              });
            }
            const automaticOutcome = this.routes.browser.enabled
              ? await this.attemptBrowserEscalation(
                  request,
                  parseLiteratureId(request.literature_id),
                  this.routes.browser,
                  priorFailures.get(index) ?? null,
                  contexts[index]!,
                )
              : priorFailures.get(index)?.unavailability == null &&
                  priorFailures.has(index)
                ? ({
                    kind: "route-failure",
                    failure: priorFailures.get(index)!,
                  } as const)
                : ({ kind: "exhausted" } as const);
            const outcome = this.applyAssistance(automaticOutcome);
            final[index] = outcome;
            // Completion feedback follows each result. Final report ordering does
            // not require a fast article to wait for an unrelated slow transfer.
            emit([Object.freeze({ index, outcome })]);
          } catch (error) {
            // An immediate observer/internal failure cannot leave sibling
            // deliveries running after this cohort has returned to its caller.
            browserFailures.push(error);
            browserAbort.abort();
            throw error;
          }
        }),
      );
      if (browserFailures.length) throw browserFailures[0];
    }
    if (final.some((outcome) => outcome === undefined))
      throw new TypeError("acquisition cohort partition is incomplete");
    for (const [index, outcome] of final.entries()) {
      if (outcome?.kind !== "acquired")
        await requests[index]!.on_source_result?.(
          parsePdfSourceResult({
            schema_version: 1,
            literature_id: requests[index]!.literature_id,
            finished_at: new Date().toISOString(),
            result: "not-obtained",
            source: null,
            stage: null,
            receipt_id: null,
            technical_details: { diagnostics: [] },
          }),
        );
    }
    return Object.freeze(final as PdfAcquisitionOutcome[]);
  }

  private applyAssistance(
    outcome: PdfAcquisitionOutcome,
  ): PdfAcquisitionOutcome {
    if (outcome.kind !== "route-failure") return outcome;
    if (this.ports.assistance === "pause")
      return {
        kind: "assistance-required",
        failure: {
          ...outcome.failure,
          code: "assistance-required",
          retryable: false,
        },
      };
    if (this.ports.assistance === "notify")
      return {
        kind: "policy-skip",
        failure: {
          ...outcome.failure,
          code: "assistance-skipped",
          retryable: false,
        },
      };
    return outcome;
  }

  private async recordAttempt(
    request: PdfAcquisitionRequest,
    context: AcquisitionContext,
    value: AcquisitionAttempt,
  ): Promise<void> {
    if (context.attempts.length >= MAX_ACQUISITION_ATTEMPTS) return;
    const attempt = parseAcquisitionAttempt(
      value.source === "browser" &&
        value.requested &&
        value.egresses === undefined
        ? {
            ...value,
            egresses: [
              selectedEgress(this.ports.acquisition_options?.network, {
                kind: "browser",
              }),
            ],
          }
        : value,
    );
    context.attempts.push(attempt);
    await request.on_attempt?.(attempt);
  }

  private async runLocator(
    request: PdfAcquisitionRequest,
    locator: TieredAcquisitionService,
    context: AcquisitionContext,
    preferredSources: readonly string[] = [],
  ): Promise<{
    readonly outcome: PdfAcquisitionOutcome;
    readonly priorFailure?: AcquisitionBatchFailure;
  }> {
    const literatureId = parseLiteratureId(request.literature_id);
    if (request.signal.aborted) return { outcome: { kind: "cancelled" } };
    const publications: CandidatePublicationReceipt[] = [];
    // One locator stage uses the common download/publication path. Entry keeps the
    // operation context across stages and owns the single final Browser escalation.
    let result:
      | Awaited<ReturnType<TieredAcquisitionService["run"]>>[number]
      | undefined;
    try {
      [result] = await locator.run(
        [
          {
            key: literatureId,
            preferred_sources: preferredSources,
            request: {
              landing_origins: [...context.landing_origins],
              target_version: request.detail.literature.version_role,
              identifiers: request.detail.literature.metadata.identifiers,
              observations: request.detail.metadata_observations,
              asset_hints: request.detail.metadata_observations.flatMap(
                (observation) => observation.asset_hints,
              ),
            },
          },
        ],
        async (_item, source, candidate, signal) => {
          if (candidate.source === "doi-landing" && context.doi_landing)
            candidate = { ...candidate, locator: context.doi_landing };
          // Metadata PDF hints can also use HTTP. The stateless downloader is
          // HTTPS-only; leave this route without turning a valid external hint
          // into a contract failure that aborts the whole completion cohort.
          if (new URL(candidate.locator).protocol === "http:")
            throw new AcquisitionUnavailableError(
              "download-unavailable",
              "The candidate requires browser navigation over HTTP.",
              "http-route-unavailable",
            );
          const operationKey = `${request.operation_id ?? "direct"}:${literatureId}`;
          const locatorKey = createHash("sha256")
            .update(candidate.locator)
            .digest("hex");
          const knownHash = this.deliveredHashes
            .get(operationKey)
            ?.get(locatorKey);
          if (knownHash && request.excluded_sha256?.includes(knownHash))
            throw new AcquisitionCandidateSkippedError();
          if (context.attempted_locators.has(locatorKey))
            throw new AcquisitionCandidateSkippedError();
          context.attempted_locators.add(locatorKey);
          const operationId = randomUUID();
          const transferId = `entry-pdf-${operationId}`;
          const sourceUrl = new URL(candidate.locator);
          sourceUrl.search = "";
          sourceUrl.hash = "";
          const downloadOptions = {
            on_landing: (origin: string) => {
              context.landing_origins.add(origin);
            },
            on_response: (response: {
              readonly requested_url: string;
              readonly final_url: string;
              readonly status: number;
              readonly media_type: string | null;
            }) => {
              const target = articleUrl(response.final_url);
              if (response.status >= 400) {
                for (const url of [
                  response.requested_url,
                  response.final_url,
                ]) {
                  const safe = articleUrl(url);
                  if (safe) context.failed_urls.add(safe);
                }
              }
              if (
                candidate.source === "doi-landing" &&
                target &&
                response.media_type?.includes("html")
              ) {
                context.landing_urls.push(target);
                context.landing_origins.add(new URL(target).origin);
              }
            },
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
            else {
              const transport = assemblePublicPdfDownloadTransport(
                candidate,
                this.ports.network_budget,
                this.ports.acquisition_options,
              );
              durable = await downloadPdfCandidate(
                candidate,
                {
                  request: async (url, options) => {
                    options?.signal?.throwIfAborted();
                    if (context.doi_response?.url === url) {
                      const { response } = context.doi_response;
                      context.doi_response = null;
                      return response;
                    }
                    return transport.request(url, options);
                  },
                },
                downloadOptions,
              );
            }
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
          await request.on_source_result?.(
            parsePdfSourceResult({
              schema_version: 1,
              literature_id: literatureId,
              finished_at: new Date().toISOString(),
              result: "obtained",
              source: source.source_name,
              stage:
                source.acquisition_stage ??
                (source.acquisition_tier === "authorized-api"
                  ? "publisher-api"
                  : "direct"),
              receipt_id: publications.at(-1)!.receipt_id,
              technical_details: { diagnostics: [] },
            }),
          );
        },
        {
          signal: request.signal,
          on_attempt: (attempt) =>
            this.recordAttempt(request, context, attempt),
        },
      );
    } catch (error) {
      if (classifyAcquisitionFailure(error, request.signal) === "cancel")
        return { outcome: { kind: "cancelled" } };
      throw error;
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
    // Keep source failures distinct from misses while continuing independent stages.
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
   * `priorFailure` carries an earlier public outage or explicit low-risk unavailability:
   * the original failure stays the target's stable outcome if the
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
    context: AcquisitionContext,
  ): Promise<PdfAcquisitionOutcome> {
    const startedAt = new Date().toISOString();
    let requested = false;
    let outcome: PdfAcquisitionOutcome | undefined;
    const markRequested = () => {
      requested = true;
    };
    try {
      outcome = await observeNetworkRequests(markRequested, () =>
        this.runBrowserEscalation(
          request,
          literatureId,
          browser,
          priorFailure,
          context,
          markRequested,
        ),
      );
      return outcome;
    } finally {
      const code = request.signal.aborted
        ? "browser-flow-cancelled"
        : outcome?.kind === "browser-failure"
          ? outcome.code
          : outcome?.kind === "route-failure"
            ? outcome.failure.code
            : "browser-delivery-failed";
      await this.recordAttempt(request, context, {
        stage: "browser",
        source: "browser",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        requested,
        result:
          outcome?.kind === "acquired"
            ? "hit"
            : outcome?.kind === "exhausted"
              ? "miss"
              : "failed",
        ...(outcome?.kind === "acquired" || outcome?.kind === "exhausted"
          ? {}
          : { code, problem: sourceProblem(code, "pdf") }),
      });
    }
  }

  private async runBrowserEscalation(
    request: PdfAcquisitionRequest,
    literatureId: LiteratureId,
    browser: { readonly unavailable_reason: string | null },
    priorFailure: AcquisitionBatchFailure | null,
    context: AcquisitionContext,
    onRequestDispatched: () => void,
  ): Promise<PdfAcquisitionOutcome> {
    let delivery: BrowserDeliveryResult;
    const at = new Date().toISOString();
    await this.recordAttempt(request, context, {
      stage: "browser",
      source: "browser",
      started_at: at,
      finished_at: at,
      requested: false,
      result: "escalated",
    });
    try {
      const delivered = await this.browserBroker.deliver(
        request,
        (session, signal) =>
          session.deliverCandidate({
            literature_id: literatureId,
            on_request_dispatched: onRequestDispatched,
            prior_attempts: context.attempts.slice(-16),
            identifier: browserIdentifier(request),
            version: request.detail.literature.version_role,
            article_goal: createBrowserArticleGoal({
              literature_id: literatureId,
              identifier: browserIdentifier(request),
              version: request.detail.literature.version_role,
              metadata: request.detail.literature.metadata,
            }),
            start_url:
              browserStartUrls(
                request.detail.metadata_observations,
                request.detail.literature.version_role,
                request.detail.literature.metadata.identifiers,
                context,
              )[0] ?? null,
            start_urls: browserStartUrls(
              request.detail.metadata_observations,
              request.detail.literature.version_role,
              request.detail.literature.metadata.identifiers,
              context,
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
      // Keep an explicit Agent assessment visible in the final report. Earlier
      // source failures remain in their route diagnostics; they must not erase it.
      // An unavailable cheap route is also weaker than a real Browser failure:
      // e.g. an HTTP hint must not hide the later article budget exhaustion.
      return priorFailure !== null &&
        priorFailure.unavailability == null &&
        !BROWSER_AGENT_STOP_REASONS.some(
          (reason) => delivery.code === `browser-agent-${reason}`,
        )
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
    const publicationStartedAt = performance.now();
    const timing = (phase: string) =>
      createLogger("pdf-acquisition").info("Browser publication timing", {
        article_id: literatureId,
        transfer_id: delivery.candidate.transfer_id,
        phase,
        elapsed_ms: Math.round(performance.now() - publicationStartedAt),
        bytes: delivery.candidate.size_bytes,
      });
    timing("publication-started");
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
      await request.on_source_result?.(
        parsePdfSourceResult({
          schema_version: 1,
          literature_id: literatureId,
          finished_at: new Date().toISOString(),
          result: "obtained",
          source: "browser",
          stage: "browser",
          receipt_id: publication.receipt_id,
          technical_details: { diagnostics: [] },
        }),
      );
      timing("published");
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
        timing("closing");
        await delivery.lease?.close(closeOutcome);
        timing("closed");
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

/** Backward-compatible first entry; production also passes the complete prepared list. */
export function browserStartUrl(
  observations: readonly MetadataObservation[],
  targetVersion: VersionRole,
  identifiers: readonly {
    readonly namespace: string;
    readonly value: string;
  }[] = [],
): string | null {
  return browserStartUrls(observations, targetVersion, identifiers)[0] ?? null;
}

/** The stable identifier the Browser delivery must attribute its bytes to. */
function browserIdentifier(request: PdfAcquisitionRequest): string {
  const stable = request.detail.literature.metadata.identifiers.find(
    (identifier) =>
      ["doi", "arxiv", "pmid", "pmcid"].includes(identifier.namespace),
  );
  return stable
    ? `${stable.namespace}:${stable.value}`
    : (request.detail.literature.metadata.title ?? "untitled");
}
