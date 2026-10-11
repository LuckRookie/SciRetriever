import { ContractValidationError } from "@sciretriever/contracts";
import { NetworkHttpError } from "../network/http.js";
import type { SourceCandidate } from "./sources/locators.js";
import type {
  AcquisitionSourcePort,
  AcquisitionSourceRequest,
} from "./ports.js";
import type { PublicAcquisitionRegistry } from "./sources/public.js";

export type AcquisitionBatchDisposition =
  | "acquired"
  | "exhausted"
  | "failed"
  | "skipped"
  | "interrupted";

export type AcquisitionFailureCode =
  | "source-discovery-failed"
  | "candidate-download-failed"
  | "download-unavailable"
  | "assistance-skipped"
  | "assistance-required"
  | "execution-cancelled"
  | "source-cooldown"
  | "http-response-failed"
  | "rate-limited"
  | "network-failed";

/**
 * An explicitly declared, low-risk route unavailability.
 *
 * It is a declaration by the route itself — never a code pattern a caller may infer — that
 * it cannot serve this target by this access method: the source does not apply,
 * has no PDF capability, or a bounded public HTTP attempt requires a page session.
 * This is distinct from a temporary or unknown failure.
 *
 * An API entitlement/credential problem is deliberately not part of this set.
 * Public HTTP 403/HTML or a proven redirect limit only describes the stateless
 * transport's inability to serve the target; ADR 0015 §7 permits an independently
 * admitted browser to assess its own current institutional/session access.
 *
 * Ordinary public transport failures may also allow an independent fallback, but remain
 * unresolved failures if no later route delivers (ADR 0015 §7).
 */
export type AcquisitionRouteUnavailability =
  | "not-applicable"
  | "no-capability"
  | "http-route-unavailable";

export interface AcquisitionBatchFailure {
  readonly code: AcquisitionFailureCode;
  readonly source: string | null;
  readonly reason: string;
  readonly retryable: boolean;
  /**
   * Non-null only when the route explicitly declared a low-risk unavailability. Entry reads
   * this declaration, or the explicit public-outage permission below, to decide whether
   * independent routes may take over. Unknown failures never gain permission from their
   * message or retryability alone.
   */
  readonly unavailability?: AcquisitionRouteUnavailability | null;
  /** A recognized transport outage may leave the public tier, without becoming a miss. */
  readonly allows_independent_fallback?: boolean;
}

/**
 * Stable classification of one failure raised while discovering a source or
 * delivering a candidate (M7).
 *
 * Fail-closed policy (a recorded team decision, not an accident): only an
 * explicitly classified, retryable `route` failure may continue with the next
 * candidate or source. A `route` error the caller marked non-retryable is
 * surfaced as `system` instead of being swallowed by another route. `cancel`,
 * `receipt`, `storage`, `contract`, `system` and every unrecognized error also
 * leave the batch, so none of them can be degraded into an exhaustion fact.
 */
export type AcquisitionFailureKind =
  | "route"
  | "system"
  | "cancel"
  | "receipt"
  | "storage"
  | "contract";

/**
 * Explicitly marks one candidate/source outcome the batch may continue past.
 * Callers whose download step raises plain route errors wrap them once here so
 * the batch never has to guess.
 */
export class AcquisitionRouteError extends Error {
  readonly allows_independent_fallback: boolean;
  constructor(
    readonly code: AcquisitionFailureCode,
    readonly reason: string,
    readonly retryable = true,
    options: {
      readonly cause?: unknown;
      readonly allows_independent_fallback?: boolean;
    } = {},
  ) {
    super("acquisition route failed", options);
    this.name = "AcquisitionRouteError";
    this.allows_independent_fallback =
      retryable &&
      code !== "rate-limited" &&
      options.allows_independent_fallback === true;
  }
}

/**
 * An explicit low-risk unavailability raised by a route.
 *
 * Unlike `AcquisitionRouteError` it is not an unresolved failure: the route proved it
 * cannot serve this target, so the batch records it without cooling the source down and
 * Entry may hand the target to an independently admitted Browser. Ordinary public outages
 * use a separate permission and remain failures rather than low-risk declarations.
 */
export class AcquisitionUnavailableError extends Error {
  constructor(
    readonly code: AcquisitionFailureCode,
    readonly reason: string,
    readonly unavailability: AcquisitionRouteUnavailability,
  ) {
    super("acquisition route unavailable");
    this.name = "AcquisitionUnavailableError";
  }
}

/** One operation-local candidate was already rejected; try the next without cooling the route. */
export class AcquisitionCandidateSkippedError extends Error {
  constructor() {
    super("acquisition candidate already attempted");
    this.name = "AcquisitionCandidateSkippedError";
  }
}

function failureCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error))
    return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Classifies a failure without importing every emitting module. Only explicitly
 * recognized route classes may continue with another route, and only a
 * retryable route failure is one of them. Cancellation and the
 * storage/admission/receipt/contract/system classes are recognized exactly;
 * every unrecognized error (including an unknown exception escaping a source's
 * `discover`) is `system`, so it can never trigger a cross-version fallback or
 * become a durable exhaustion fact (requirements R8).
 */
export function classifyAcquisitionFailure(
  error: unknown,
  signal: AbortSignal,
  context: "discovery" | "delivery" = "delivery",
): AcquisitionFailureKind {
  const name = error instanceof Error ? error.name : "";
  const code = failureCodeOf(error);
  if (
    name === "AbortError" ||
    code === "queue-interrupted" ||
    code === "write-admission-cancelled" ||
    code === "candidate-cancelled"
  )
    return "cancel";
  if (
    code?.startsWith("write-admission") ||
    name === "BrowserTransferError" ||
    name === "SqliteWorkerError" ||
    // Filesystem/SQLite errno shapes are never a provider route outcome.
    /^(?:E[A-Z]{2,}|SQLITE_)/u.test(code ?? "")
  )
    return "storage";
  if (
    code === "candidate-receipt-conflict" ||
    code === "candidate-publication" ||
    name === "CandidatePublicationError"
  )
    return "receipt";
  // A stop signal cannot erase a known persistence/publication failure, including
  // one raised while discarding a receipt. Ordinary aborted I/O remains a cancel.
  if (signal.aborted) return "cancel";
  // Only a retryable route failure may continue with another route; a route
  // error the caller marked non-retryable (for example a resolution that needs
  // operator action) leaves the batch like any other failure.
  if (error instanceof AcquisitionRouteError)
    return error.retryable ? "route" : "system";
  // An explicit low-risk unavailability is a route outcome by declaration: it never leaves
  // the batch, and callers that special-case it (the runner, then Entry) still treat it as
  // route-local rather than as an unresolved system failure.
  if (error instanceof AcquisitionUnavailableError) return "route";
  if (error instanceof ContractValidationError || error instanceof TypeError)
    return "contract";
  if (
    name === "NetworkBudgetError" ||
    code === "literature-stale" ||
    code === "candidate-misattributed" ||
    code === "primary-asset-conflict" ||
    code === "candidate-command-invalid"
  )
    return "system";
  if (name === "CandidateAcceptanceError") return "route";
  if (
    code === "candidate-rejected" ||
    code === "candidate-uncertain" ||
    code === "candidate-not-found" ||
    code === "literature-not-found" ||
    name === "PdfAcceptanceError" ||
    name === "NetworkHttpError" ||
    name === "NetworkConnectionError" ||
    name === "NetworkPolicyError"
  )
    return "route";
  // `downloadPdfCandidate`/`downloadSourceCandidate` describe a rejected
  // candidate (empty body, byte limit, media type, unavailable source) with a
  // plain acquisition error; anything else escaping delivery is not a route.
  if (
    context === "delivery" &&
    error instanceof Error &&
    /^acquisition /u.test(error.message)
  )
    return "route";
  // Unknown errors are system failures in both contexts: no fallback, no fact.
  return "system";
}

export interface AcquisitionBatchItem {
  readonly key: string;
  readonly request: AcquisitionSourceRequest;
  /** Ordering preference only: every configured source keeps its own admission. */
  readonly preferred_sources?: readonly string[];
}

export interface AcquisitionBatchResult {
  readonly key: string;
  readonly disposition: AcquisitionBatchDisposition;
  readonly source: string | null;
  readonly candidate: SourceCandidate | null;
  readonly failure: AcquisitionBatchFailure | null;
  readonly attempted_sources: readonly string[];
}

export interface AcquisitionBatchProgress {
  readonly key: string;
  readonly source: string;
  readonly candidate_count: number;
  readonly disposition: "discovered" | "download-failed" | "acquired";
}

export interface TieredAcquisitionOptions {
  readonly assistance?: "never" | "notify" | "pause";
  readonly cooldown_ms?: number;
  readonly max_items?: number;
  readonly max_candidates_per_source?: number;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly on_progress?: (progress: AcquisitionBatchProgress) => void;
}

export type AcquisitionCandidateDownloader = (
  item: AcquisitionBatchItem,
  source: AcquisitionSourcePort,
  candidate: SourceCandidate,
  signal: AbortSignal,
) => Promise<unknown>;

function failure(
  code: AcquisitionFailureCode,
  source: string | null,
  reason: string,
  retryable: boolean,
  unavailability: AcquisitionRouteUnavailability | null = null,
  allowsIndependentFallback = false,
): AcquisitionBatchFailure {
  return Object.freeze({
    code,
    source,
    reason,
    retryable,
    unavailability,
    ...(allowsIndependentFallback ? { allows_independent_fallback: true } : {}),
  });
}

/**
 * Records one explicit low-risk unavailability. It is deliberately non-retryable and never
 * cools the source down: there is nothing to retry, and the target may still be served by
 * another route or by the independently admitted Browser.
 */
function unavailableFailure(
  error: AcquisitionUnavailableError,
  source: string | null,
): AcquisitionBatchFailure {
  return failure(error.code, source, error.reason, false, error.unavailability);
}

/** Keep transport facts in the operation report without exposing URLs or remote text. */
export function routeFailure(
  error: unknown,
  source: string,
  fallback: AcquisitionBatchFailure,
): AcquisitionBatchFailure {
  if (error instanceof AcquisitionRouteError)
    return failure(
      error.code,
      source,
      error.reason,
      error.retryable,
      null,
      error.allows_independent_fallback,
    );
  if (error instanceof NetworkHttpError)
    return failure(
      error.retry_after_ms !== undefined ? "rate-limited" : "network-failed",
      source,
      `HTTP transport failed (${error.reason}).${error.retry_after_ms !== undefined ? ` Retry-After: ${error.retry_after_ms} ms.` : ""}`,
      true,
      null,
      error.retry_after_ms === undefined &&
        ["timeout", "request-failed", "response-incomplete"].includes(
          error.reason,
        ),
    );
  if (
    error instanceof Error &&
    ["NetworkConnectionError", "NetworkPolicyError"].includes(error.name)
  )
    return failure(
      "network-failed",
      source,
      `${error.name}: request could not be completed.`,
      true,
      null,
      error.name === "NetworkConnectionError",
    );
  return fallback;
}

function copyResult(
  result: Omit<AcquisitionBatchResult, "attempted_sources"> & {
    readonly attempted_sources: readonly string[];
  },
): AcquisitionBatchResult {
  return Object.freeze({
    ...result,
    attempted_sources: Object.freeze([...result.attempted_sources]),
  });
}

/**
 * Executes source ports in their configured order, with optional per-item preferences.
 * Discovery, candidate download and policy disposition remain separate so a
 * source failure cannot be mistaken for a permanent exhaustion fact.
 *
 * Fallback is fail-closed: a source that wants its provider failure treated as
 * a continuable route must raise `AcquisitionRouteError` (or a known network
 * rejection). Unknown exceptions stay system failures and are surfaced, not
 * retried on another route.
 */
export class TieredAcquisitionService {
  private readonly cooldowns = new Map<
    string,
    {
      readonly until: number;
      readonly failure: AcquisitionBatchFailure;
    }
  >();
  private readonly assistance: "never" | "notify" | "pause";
  private readonly cooldownMs: number;
  private readonly maxItems: number;
  private readonly maxCandidatesPerSource: number;
  private readonly now: () => number;

  constructor(
    private readonly registry: PublicAcquisitionRegistry,
    options: TieredAcquisitionOptions = {},
  ) {
    this.assistance = options.assistance ?? "never";
    this.cooldownMs = options.cooldown_ms ?? 30_000;
    this.maxItems = options.max_items ?? 10_000;
    this.maxCandidatesPerSource = options.max_candidates_per_source ?? 32;
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.cooldownMs) ||
      this.cooldownMs < 0 ||
      this.cooldownMs > 86_400_000 ||
      !Number.isSafeInteger(this.maxItems) ||
      this.maxItems < 1 ||
      this.maxItems > 100_000 ||
      !Number.isSafeInteger(this.maxCandidatesPerSource) ||
      this.maxCandidatesPerSource < 1 ||
      this.maxCandidatesPerSource > 1_000
    )
      throw new TypeError("acquisition batch bounds are invalid");
  }

  async run(
    items: readonly AcquisitionBatchItem[],
    download: AcquisitionCandidateDownloader,
    options: Pick<TieredAcquisitionOptions, "signal" | "on_progress"> = {},
  ): Promise<readonly AcquisitionBatchResult[]> {
    if (
      !Array.isArray(items) ||
      items.length > this.maxItems ||
      typeof download !== "function"
    )
      throw new TypeError("acquisition batch request is invalid");
    const keys = new Set<string>();
    for (const item of items) {
      if (
        !item ||
        typeof item.key !== "string" ||
        !/^[a-zA-Z0-9._:-]{1,128}$/u.test(item.key) ||
        keys.has(item.key) ||
        !item.request
      )
        throw new TypeError("acquisition batch item is invalid");
      keys.add(item.key);
    }
    const signal = options.signal ?? new AbortController().signal;
    const results: AcquisitionBatchResult[] = [];
    for (const item of items) {
      if (signal.aborted) {
        results.push(
          this.interrupted(
            item.key,
            [],
            null,
            "Acquisition batch was cancelled before this target ran.",
          ),
        );
        continue;
      }
      results.push(
        await this.runItem(item, download, signal, options.on_progress),
      );
    }
    return Object.freeze(results);
  }

  private async runItem(
    item: AcquisitionBatchItem,
    download: AcquisitionCandidateDownloader,
    signal: AbortSignal,
    onProgress?: (progress: AcquisitionBatchProgress) => void,
  ): Promise<AcquisitionBatchResult> {
    const attempted: string[] = [];
    let lastFailure: AcquisitionBatchFailure | null = null;
    const remember = (next: AcquisitionBatchFailure): void => {
      // Keep unresolved failures above misses, and never let a later ordinary outage
      // erase a failure that prohibits independent fallback.
      const priority = (value: AcquisitionBatchFailure) =>
        value.unavailability != null
          ? 0
          : value.allows_independent_fallback
            ? 1
            : 2;
      if (!lastFailure || priority(next) > priority(lastFailure))
        lastFailure = next;
    };
    const preferred = new Set(item.preferred_sources ?? []);
    const sources = [
      ...this.registry.sources.filter((source) =>
        preferred.has(source.source_name),
      ),
      ...this.registry.sources.filter(
        (source) => !preferred.has(source.source_name),
      ),
    ];
    for (const source of sources) {
      if (signal.aborted)
        return this.interrupted(
          item.key,
          attempted,
          null,
          "Acquisition batch was cancelled while a target was running.",
        );
      const cooldown = this.cooldowns.get(source.source_name);
      if (cooldown && cooldown.until > this.now()) {
        const detail = Object.freeze({
          ...cooldown.failure,
          code: "source-cooldown" as const,
          reason: `The source is cooling down after a discovery failure: ${cooldown.failure.reason}`,
        });
        remember(detail);
        if (cooldown.failure.code === "rate-limited")
          return this.policyResult(item.key, attempted, detail);
        continue;
      }
      this.cooldowns.delete(source.source_name);
      attempted.push(source.source_name);
      let candidates: readonly SourceCandidate[];
      try {
        candidates = await source.discover(item.request, signal);
      } catch (error) {
        // A discovery failure is one route outcome; an explicitly classified
        // storage/receipt/contract/system failure leaves the batch untouched.
        // An explicit low-risk unavailability is not a failure at all: it is recorded
        // as-is (non-retryable, no cooldown) so Entry can decide with its own admission.
        if (error instanceof AcquisitionUnavailableError) {
          remember(unavailableFailure(error, source.source_name));
          continue;
        }
        const kind = classifyAcquisitionFailure(error, signal, "discovery");
        if (kind === "cancel")
          return this.interrupted(
            item.key,
            attempted,
            null,
            "Acquisition batch was cancelled while a source was being discovered.",
          );
        if (kind !== "route") throw error;
        const detail = routeFailure(
          error,
          source.source_name,
          failure(
            "source-discovery-failed",
            source.source_name,
            "The source did not return a valid discovery result.",
            true,
          ),
        );
        this.cooldowns.set(source.source_name, {
          until: this.now() + this.cooldownMs,
          failure: detail,
        });
        remember(detail);
        if (detail.code === "rate-limited")
          return this.policyResult(item.key, attempted, detail);
        continue;
      }
      const bounded = candidates.slice(0, this.maxCandidatesPerSource);
      onProgress?.({
        key: item.key,
        source: source.source_name,
        candidate_count: bounded.length,
        disposition: "discovered",
      });
      if (bounded.length === 0) continue;
      for (const candidate of bounded) {
        if (signal.aborted)
          return this.interrupted(
            item.key,
            attempted,
            source.source_name,
            "Acquisition batch was cancelled during candidate delivery.",
          );
        try {
          await download(item, source, candidate, signal);
          onProgress?.({
            key: item.key,
            source: source.source_name,
            candidate_count: bounded.length,
            disposition: "acquired",
          });
          return copyResult({
            key: item.key,
            disposition: "acquired",
            source: source.source_name,
            candidate,
            failure: null,
            attempted_sources: attempted,
          });
        } catch (error) {
          // Only a route failure continues with the next candidate. A
          // cancellation stops this target; storage, receipt, contract and
          // system failures leave the batch instead of being swallowed.
          // HTTP capability is candidate-local; a separate public locator may work.
          // Other declarations concern the whole route/target.
          if (error instanceof AcquisitionUnavailableError) {
            remember(unavailableFailure(error, source.source_name));
            if (error.unavailability === "http-route-unavailable") continue;
            break;
          }
          if (error instanceof AcquisitionCandidateSkippedError) continue;
          const kind = classifyAcquisitionFailure(error, signal, "delivery");
          if (kind === "cancel")
            return this.interrupted(
              item.key,
              attempted,
              source.source_name,
              "Acquisition batch was cancelled during candidate delivery.",
            );
          if (kind !== "route") throw error;
          const detail = routeFailure(
            error,
            source.source_name,
            failure(
              "candidate-download-failed",
              source.source_name,
              "The candidate failed delivery or PDF acceptance; the next candidate remains eligible.",
              true,
            ),
          );
          remember(detail);
          if (detail.code === "rate-limited")
            return this.policyResult(item.key, attempted, detail);
          onProgress?.({
            key: item.key,
            source: source.source_name,
            candidate_count: bounded.length,
            disposition: "download-failed",
          });
        }
      }
    }
    // `exhausted` requires that every applicable route ended normally: any
    // unresolved failure (discovery error, cooldown after one, failed delivery)
    // is a route outcome and must never be reported as a normal exhaustion.
    // This is the only value Entry may turn into a durable exhaustion fact.
    if (lastFailure) return this.policyResult(item.key, attempted, lastFailure);
    return copyResult({
      key: item.key,
      disposition: "exhausted",
      source: null,
      candidate: null,
      failure: null,
      attempted_sources: attempted,
    });
  }

  private interrupted(
    key: string,
    attempted: readonly string[],
    source: string | null,
    reason: string,
  ): AcquisitionBatchResult {
    return copyResult({
      key,
      disposition: "interrupted",
      source,
      candidate: null,
      failure: failure("execution-cancelled", source, reason, true),
      attempted_sources: attempted,
    });
  }

  private policyResult(
    key: string,
    attempted: readonly string[],
    lastFailure: AcquisitionBatchFailure,
  ): AcquisitionBatchResult {
    if (this.assistance === "pause")
      return copyResult({
        key,
        disposition: "interrupted",
        source: lastFailure.source,
        candidate: null,
        failure: failure(
          "assistance-required",
          lastFailure.source,
          "The frozen policy paused this target for operator assistance.",
          false,
        ),
        attempted_sources: attempted,
      });
    if (this.assistance === "notify")
      return copyResult({
        key,
        disposition: "skipped",
        source: lastFailure.source,
        candidate: null,
        failure: failure(
          "assistance-skipped",
          lastFailure.source,
          "The target was skipped after a non-terminal failure; notification is advisory only.",
          false,
        ),
        attempted_sources: attempted,
      });
    return copyResult({
      key,
      disposition: "failed",
      source: lastFailure.source,
      candidate: null,
      failure: lastFailure,
      attempted_sources: attempted,
    });
  }
}
