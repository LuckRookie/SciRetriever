import type { SourceCandidate } from "./sources/locators.js";
import type {
  AcquisitionSourcePort,
  AcquisitionSourceRequest,
  PublicAcquisitionRegistry,
} from "./sources/public.js";

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
  | "source-cooldown";

export interface AcquisitionBatchFailure {
  readonly code: AcquisitionFailureCode;
  readonly source: string | null;
  readonly reason: string;
  readonly retryable: boolean;
}

export interface AcquisitionBatchItem {
  readonly key: string;
  readonly request: AcquisitionSourceRequest;
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
): AcquisitionBatchFailure {
  return Object.freeze({ code, source, reason, retryable });
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
 * Executes public/API/browser source ports in their configured order.
 * Discovery, candidate download and policy disposition remain separate so a
 * source failure cannot be mistaken for a permanent exhaustion fact.
 */
export class TieredAcquisitionService {
  private readonly cooldownUntil = new Map<string, number>();
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
          copyResult({
            key: item.key,
            disposition: "interrupted",
            source: null,
            candidate: null,
            failure: failure(
              "execution-cancelled",
              null,
              "Acquisition batch was cancelled before this target ran.",
              true,
            ),
            attempted_sources: [],
          }),
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
    let sawCandidate = false;
    for (const source of this.registry.sources) {
      if (signal.aborted)
        return copyResult({
          key: item.key,
          disposition: "interrupted",
          source: null,
          candidate: null,
          failure: failure(
            "execution-cancelled",
            null,
            "Acquisition batch was cancelled while a target was running.",
            true,
          ),
          attempted_sources: attempted,
        });
      const cooldown = this.cooldownUntil.get(source.source_name) ?? 0;
      if (cooldown > this.now()) {
        lastFailure = failure(
          "source-cooldown",
          source.source_name,
          "The source is cooling down after a bounded discovery failure.",
          true,
        );
        continue;
      }
      attempted.push(source.source_name);
      let candidates: readonly SourceCandidate[];
      try {
        candidates = await source.discover(item.request, signal);
      } catch {
        this.cooldownUntil.set(
          source.source_name,
          this.now() + this.cooldownMs,
        );
        lastFailure = failure(
          "source-discovery-failed",
          source.source_name,
          "The source did not return a valid discovery result.",
          true,
        );
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
      sawCandidate = true;
      for (const candidate of bounded) {
        if (signal.aborted)
          return copyResult({
            key: item.key,
            disposition: "interrupted",
            source: source.source_name,
            candidate: null,
            failure: failure(
              "execution-cancelled",
              source.source_name,
              "Acquisition batch was cancelled during candidate delivery.",
              true,
            ),
            attempted_sources: attempted,
          });
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
        } catch {
          lastFailure = failure(
            "candidate-download-failed",
            source.source_name,
            "The candidate failed delivery or PDF acceptance; the next candidate remains eligible.",
            true,
          );
          onProgress?.({
            key: item.key,
            source: source.source_name,
            candidate_count: bounded.length,
            disposition: "download-failed",
          });
        }
      }
    }
    if (!sawCandidate && lastFailure?.code === "source-discovery-failed")
      return this.policyResult(item.key, attempted, lastFailure);
    if (sawCandidate && lastFailure)
      return this.policyResult(item.key, attempted, lastFailure);
    return copyResult({
      key: item.key,
      disposition: "exhausted",
      source: null,
      candidate: null,
      failure: null,
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
