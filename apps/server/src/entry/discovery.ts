import {
  startIntake,
  finishIntake,
  type IntakeOrigin,
} from "../literature/intake.js";
import { randomUUID } from "node:crypto";
import { setImmediate as yieldToEvents } from "node:timers/promises";
import { writeMetadataItems } from "./metadata-write.js";
import { WriteAdmissionError } from "../storage/write-admission.js";
import {
  parseReference,
  parseLiteratureDetail,
  type IntakeBatchId,
  type MetadataObservation,
  type ProviderLiteratureKey,
  type StableFailure,
} from "@sciretriever/contracts";
import {
  topicSearchQuery,
  type MetadataProviderInvocation,
} from "../metadata/ports.js";
import {
  withMetadataRateLimitHandling,
  type MetadataService,
} from "../metadata/service.js";
import { MetadataProviderFailure } from "../metadata/ports.js";
import {
  MetadataProgressError,
  type MetadataSourceRecorder,
  type MetadataSourceRun,
} from "../application/jobs/metadata-progress.js";
import { observeNetworkRequests } from "../network/request-activity.js";
import {
  applyCitationCheckpoint,
  citationItemKey,
  lookupWorkId,
  parseCitationCheckpoint,
  pendingCitationItem,
  referenceQueryId,
  restoreCitationProgress,
  restoreCitationItem,
  type CitationCause,
  type CitationCheckpoint,
  type CitationDeferredWork,
  type CitationItem,
  type CitationProviderState,
  type CitationQueryProgress,
  type DeferredLookup,
  type DeferredReference,
} from "./citation-checkpoint.js";
import {
  citationClock,
  coolCitationSource,
  isCitationRateLimit,
  type CitationClock,
} from "./citation-cooldown.js";
import type { MetadataScanEvent } from "../metadata/ports.js";
import type { LiteratureIdentityService } from "../literature/identity.js";
import type { ObservationRepository } from "../storage/sqlite/repositories.js";
import type { ReferenceRepository } from "../storage/sqlite/repositories.js";
import { CitationProgress } from "../storage/sqlite/citation-progress.js";
import {
  METADATA_SEGMENT_ITEMS,
  type DiscoveryPublication,
  type SqliteWorker,
} from "../storage/sqlite/worker.js";

export interface TopicDiscoveryRequest {
  readonly origin?: IntakeOrigin;
  readonly source_run?: MetadataSourceRun;
  readonly query: string;
  readonly year_from?: number | null;
  readonly year_to?: number | null;
  readonly providers: readonly {
    readonly provider_name: string;
    readonly scan_limit: number;
  }[];
  readonly signal?: AbortSignal;
}
export interface TopicDiscoveryReport {
  readonly discovery_run_id: string;
  readonly intake_batch_id: import("@sciretriever/contracts").IntakeBatchId;
  readonly status: "COMPLETED" | "PARTIAL" | "FAILED" | "INTERRUPTED";
  readonly accepted_count: number;
  readonly matched_count: number;
  readonly source_results: readonly {
    readonly provider_name: string;
    readonly outcome: "EXHAUSTED" | "SCAN_LIMIT_REACHED" | "FAILED";
    readonly failure: StableFailure | null;
  }[];
}

export interface CitationDiscoveryRequest {
  readonly origin?: IntakeOrigin;
  readonly source_run?: MetadataSourceRun;
  readonly seed_literature_ids: readonly string[];
  readonly direction: "references" | "cited-by" | "both";
  readonly max_depth: number;
  readonly result_limit: number | null;
  readonly providers: readonly {
    readonly provider_name: string;
    readonly scan_limit: number | null;
  }[];
  readonly signal?: AbortSignal;
}
export interface CitationDiscoveryReport {
  readonly discovery_run_id: string;
  readonly intake_batch_id: import("@sciretriever/contracts").IntakeBatchId;
  readonly status: "COMPLETED" | "PARTIAL" | "FAILED" | "INTERRUPTED";
  readonly result_count: number;
  readonly source_results: readonly TopicDiscoveryReport["source_results"][number][];
}

const providerFailure = (reason: string): StableFailure => ({
  code: "metadata-discovery-provider",
  reason,
  action: "Retry the provider or inspect its readiness.",
  retryable: true,
});

function citationScanLimitReached(state: CitationProviderState): boolean {
  return state.scan_limit !== null && state.raw_item_count >= state.scan_limit;
}

/** A missing work or malformed record must not disable unrelated branches. */
function recordCitationFailure(
  state: CitationProviderState,
  failure: StableFailure,
): void {
  state.failure ??= failure;
  if (
    [
      "metadata-provider-authentication",
      "metadata-provider-authorization",
    ].includes(failure.code)
  )
    state.terminal = "FAILED";
}

function consumeCitationInvocation(
  state: CitationProviderState,
  invocation: MetadataProviderInvocation,
): void {
  if (
    invocation.raw_item_count < 0 ||
    (state.scan_limit !== null &&
      invocation.raw_item_count > state.scan_limit - state.raw_item_count)
  )
    throw new Error("citation provider exceeded its run scan limit");
  state.raw_item_count += invocation.raw_item_count;
  if (
    invocation.outcome === "FAILED" &&
    !isCitationRateLimit(invocation.failure)
  ) {
    recordCitationFailure(
      state,
      invocation.failure ?? providerFailure("The citation provider failed."),
    );
  }
  if (citationScanLimitReached(state)) {
    state.terminal = "SCAN_LIMIT_REACHED";
  }
}

function observationMatches(
  observation: MetadataObservation,
  provider: string,
  key: ProviderLiteratureKey,
): boolean {
  return (
    observation.provenance.source_name === provider &&
    ((key.record_id !== null &&
      observation.provenance.source_record_id === key.record_id) ||
      key.identifiers.some((identifier) =>
        observation.metadata.identifiers.some(
          (candidate) =>
            candidate.namespace === identifier.namespace &&
            candidate.value === identifier.value,
        ),
      ))
  );
}

type ReferencePage = {
  readonly items: readonly CitationItem[];
  readonly end?: Extract<MetadataScanEvent, { kind: "end" }>;
};

/** Only drain records already buffered by the current provider response. */
async function* citationPages(
  stream: AsyncGenerator<MetadataScanEvent>,
  signal?: AbortSignal,
): AsyncGenerator<ReferencePage> {
  let items: CitationItem[] = [];
  try {
    for (;;) {
      if (items.length === 0) await yieldToEvents();
      signal?.throwIfAborted();
      const next = await withMetadataRateLimitHandling(
        () => stream.next(),
        signal,
      );
      signal?.throwIfAborted();
      if (next.done) return;
      const event = next.value;
      if (event.kind === "end") {
        yield { items, end: event };
        return;
      }
      items.push(event);
      if (
        !event.end_follows &&
        (!event.buffered_next ||
          event.failure ||
          items.length >= METADATA_SEGMENT_ITEMS)
      ) {
        yield { items };
        items = [];
      }
    }
  } finally {
    await stream.return(undefined);
  }
}

type CitationLookup = { readonly requested: boolean } & (
  | { readonly result: MetadataProviderInvocation }
  | { readonly error: unknown }
);
type CitationTarget = NonNullable<
  Awaited<ReturnType<SqliteWorker["getLiteratureIds"]>>
>;

// A lookup is a provider call. Roll back the provisional segment before calling
// out, then replay it using the actual receipt and the same event order.
class CitationLookupNeeded extends Error {
  constructor(
    readonly key: string,
    readonly lookup: () => Promise<MetadataProviderInvocation>,
  ) {
    super("citation lookup must run outside the catalog write");
  }
}
async function fetchCitationLookup(
  lookup: () => Promise<MetadataProviderInvocation>,
): Promise<CitationLookup> {
  let requested = false;
  try {
    const result = await observeNetworkRequests(() => {
      requested = true;
    }, lookup);
    return { requested, result };
  } catch (error) {
    return { requested, error };
  }
}
class CitationPaused extends Error {}

export class TopicDiscoveryService {
  constructor(
    private readonly metadata: Pick<MetadataService, "searchTopicProvider">,
    private readonly identity: Pick<LiteratureIdentityService, "observe">,
    private readonly observations: ObservationRepository,
    private readonly database: SqliteWorker,
  ) {}

  async run(request: TopicDiscoveryRequest): Promise<TopicDiscoveryReport> {
    const query = topicSearchQuery(
      request.query,
      request.year_from ?? null,
      request.year_to ?? null,
    );
    if (!Array.isArray(request.providers) || request.providers.length === 0)
      throw new TypeError("discovery providers must be non-empty");
    const providerNames = new Set<string>();
    for (const provider of request.providers) {
      if (
        !provider.provider_name.trim() ||
        providerNames.has(provider.provider_name)
      )
        throw new TypeError("discovery providers must have unique names");
      if (!Number.isSafeInteger(provider.scan_limit) || provider.scan_limit < 1)
        throw new TypeError("discovery scan limit must be positive");
      providerNames.add(provider.provider_name);
    }
    const runId = randomUUID();
    const batchId = await startIntake(
      this.database,
      "topic",
      query.query,
      {
        query: query.query,
        year_from: query.year_from,
        year_to: query.year_to,
        providers: request.providers.map((p) => p.provider_name),
      },
      request.origin,
    );
    let settled = false;
    try {
      const results = new Map<string, { meta_literature_id: string }>();
      const topicCauses: Array<DiscoveryPublication["topic_causes"][number]> =
        [];
      const sourceResults: Array<
        DiscoveryPublication["source_results"][number]
      > = [];
      let accepted = 0;
      let matched = 0;
      let interrupted = request.signal?.aborted ?? false;
      for (const provider of request.providers) {
        if (interrupted) break;
        const progress = await request.source_run?.begin(
          provider.provider_name,
          "topic-search",
          runId,
        );
        let invocation: MetadataProviderInvocation;
        try {
          const invoke = () =>
            this.metadata.searchTopicProvider(
              provider.provider_name,
              query,
              provider.scan_limit,
              request.signal,
              progress ? () => progress.returned(1) : undefined,
            );
          invocation = progress ? await progress.run(invoke) : await invoke();
        } catch (error) {
          if (error instanceof MetadataProgressError) throw error;
          if (request.signal?.aborted) {
            await progress?.finish("cancelled");
            interrupted = true;
            break;
          }
          const failure =
            error instanceof MetadataProviderFailure
              ? error.failure
              : providerFailure(
                  "The metadata provider could not complete discovery.",
                );
          await progress?.failure(failure.code, error);
          sourceResults.push({
            provider_name: provider.provider_name,
            outcome: "FAILED",
            failure,
          });
          continue;
        }
        if (invocation.outcome === "INTERRUPTED" || request.signal?.aborted) {
          await progress?.finish("cancelled");
          interrupted = true;
          break;
        }
        sourceResults.push({
          provider_name: provider.provider_name,
          outcome: invocation.outcome,
          failure: invocation.failure,
        });
        await writeMetadataItems(
          this.database,
          invocation.relations,
          async (relation) => {
            await this.observations.publishProviderRelation(relation);
          },
        );
        await writeMetadataItems(
          this.database,
          invocation.observations,
          async (observation) => {
            const year = observation.metadata.publication_year;
            if (
              (query.year_from !== null || query.year_to !== null) &&
              (year === null ||
                (query.year_from !== null && year < query.year_from) ||
                (query.year_to !== null && year > query.year_to))
            ) {
              await progress?.rejected();
              return;
            }
            const decision = await this.identity.observe(observation, {
              intake_batch_id: batchId,
            });
            if (
              decision.disposition !== "accepted" ||
              !decision.literature_id
            ) {
              await progress?.rejected();
              return;
            }
            accepted += decision.created ? 1 : 0;
            matched += decision.created ? 0 : 1;
            const literature = await this.database.getLiteratureIds(
              decision.literature_id,
            );
            if (!literature)
              throw new Error(
                "discovery identity refers to missing Literature",
              );
            await progress?.observed(
              literature.meta_literature_id,
              decision.created,
            );
            await progress?.included(literature.meta_literature_id);
            if (!results.has(literature.meta_literature_id)) {
              results.set(literature.meta_literature_id, {
                meta_literature_id: literature.meta_literature_id,
              });
            }
            topicCauses.push({
              meta_literature_id: literature.meta_literature_id,
              metadata_observation_id: observation.observation_id,
              actual_literature_id: literature.literature_id,
            });
          },
        );
        if (invocation.failure)
          await progress?.failure(invocation.failure.code);
        else
          await progress?.finish(
            invocation.raw_item_count > 0 ? "hit" : "miss",
          );
      }
      if (request.signal?.aborted) interrupted = true;
      const status: TopicDiscoveryReport["status"] = interrupted
        ? "INTERRUPTED"
        : sourceResults.length === 0 ||
            sourceResults.every((item) => item.outcome === "FAILED")
          ? "FAILED"
          : sourceResults.some((item) => item.outcome === "FAILED")
            ? "PARTIAL"
            : "COMPLETED";
      await this.database.putDiscovery({
        run: {
          discovery_run_id: runId,
          kind: "topic",
          status,
          started_at: new Date().toISOString(),
          query: query.query,
          year_from: query.year_from,
          year_to: query.year_to,
        },
        providers: request.providers,
        source_results: sourceResults,
        results: [...results.values()],
        topic_causes: topicCauses,
        citation_causes: [],
      });
      await finishIntake(
        this.database,
        batchId,
        status.toLowerCase() as
          | "completed"
          | "partial"
          | "failed"
          | "interrupted",
        runId,
        sourceResults.filter((s) => s.outcome !== "EXHAUSTED").length,
      );
      settled = true;
      return Object.freeze({
        intake_batch_id: batchId,
        discovery_run_id: runId,
        status,
        accepted_count: accepted,
        matched_count: matched,
        source_results: Object.freeze(sourceResults),
      });
    } finally {
      if (!settled) await finishIntake(this.database, batchId, "interrupted");
    }
  }
}

/** A bounded breadth-first citation expansion using the same metadata and identity owners. */
export class CitationDiscoveryService {
  constructor(
    private readonly metadata: MetadataService,
    private readonly identity: Pick<LiteratureIdentityService, "observe">,
    private readonly observations: ObservationRepository,
    private readonly references: ReferenceRepository,
    private readonly database: SqliteWorker,
    private readonly clock: CitationClock = citationClock,
  ) {}

  async run(
    request: CitationDiscoveryRequest,
  ): Promise<CitationDiscoveryReport> {
    if (
      !Array.isArray(request.seed_literature_ids) ||
      request.seed_literature_ids.length === 0
    )
      throw new TypeError("citation seeds must be non-empty");
    if (
      !Number.isSafeInteger(request.max_depth) ||
      request.max_depth < 0 ||
      (request.result_limit !== null &&
        (!Number.isSafeInteger(request.result_limit) ||
          request.result_limit < 1))
    )
      throw new TypeError("citation bounds are invalid");
    if (!Array.isArray(request.providers) || request.providers.length === 0)
      throw new TypeError("citation providers must be non-empty");
    const states = new Map<string, CitationProviderState>();
    for (const provider of request.providers) {
      if (
        !provider.provider_name.trim() ||
        states.has(provider.provider_name) ||
        (provider.scan_limit !== null &&
          (!Number.isSafeInteger(provider.scan_limit) ||
            provider.scan_limit < 1))
      )
        throw new TypeError("citation providers are invalid");
      states.set(provider.provider_name, {
        provider_name: provider.provider_name,
        scan_limit: provider.scan_limit,
        raw_item_count: 0,
        attempted: false,
        terminal: null,
        failure: null,
      });
    }
    const seeds = [...new Set(request.seed_literature_ids)];
    const traversal = new CitationProgress<CitationDeferredWork>(
      seeds,
      request.max_depth,
      request.direction,
    );
    try {
      return await this.expand(request, seeds, states, traversal);
    } finally {
      traversal.close();
    }
  }

  private async expand(
    request: CitationDiscoveryRequest,
    seeds: readonly string[],
    states: Map<string, CitationProviderState>,
    traversal: CitationProgress<CitationDeferredWork>,
  ): Promise<CitationDiscoveryReport> {
    const { signal } = request;
    const paused = (error: unknown) =>
      error instanceof CitationPaused ||
      (signal?.aborted &&
        (error === signal.reason ||
          (error instanceof WriteAdmissionError &&
            error.code === "write-admission-cancelled")));
    const tail = await request.source_run?.latestCheckpoint();
    const latest = tail ? parseCitationCheckpoint(tail.payload) : undefined;
    const resume =
      latest?.closed === "FAILED" &&
      !latest.providers.some((state) => state.cooldown?.until === null)
        ? undefined
        : latest;
    const runId = resume?.run_id ?? randomUUID();
    const startedAt = resume?.started_at ?? new Date().toISOString();
    let batchId: IntakeBatchId;
    if (resume) {
      if (
        resume.providers.length !== states.size ||
        resume.providers.some(
          (state) =>
            states.get(state.provider_name)?.scan_limit !== state.scan_limit,
        )
      )
        throw new Error(
          "citation checkpoint does not match the saved providers",
        );
      for (const state of resume.providers)
        states.set(state.provider_name, { ...state });
    }
    const restore = async () => {
      if (request.source_run && tail)
        await restoreCitationProgress(
          request.source_run,
          resume,
          tail.sequence,
          traversal,
          signal,
        );
    };
    const sourceResults = (
      interrupted = false,
    ): CitationDiscoveryReport["source_results"] =>
      request.providers
        .filter((provider) => {
          const state = states.get(provider.provider_name)!;
          return state.attempted && (!interrupted || state.terminal !== null);
        })
        .map((provider) => {
          const state = states.get(provider.provider_name)!;
          return {
            provider_name: provider.provider_name,
            outcome: state.failure ? "FAILED" : (state.terminal ?? "EXHAUSTED"),
            failure: state.failure,
          };
        });
    const report = (
      status: CitationDiscoveryReport["status"],
    ): CitationDiscoveryReport =>
      Object.freeze({
        intake_batch_id: batchId,
        discovery_run_id: runId,
        status,
        result_count: traversal.resultCount,
        source_results: Object.freeze(sourceResults(status === "INTERRUPTED")),
      });
    type CheckpointFields = Partial<
      Omit<
        CitationCheckpoint,
        | "version"
        | "run_id"
        | "batch_id"
        | "started_at"
        | "providers"
        | "results_published"
      >
    >;
    const save = async (fields: CheckpointFields = {}) => {
      const checkpoint: CitationCheckpoint = {
        version: 1,
        run_id: runId,
        batch_id: batchId,
        started_at: startedAt,
        providers: [...states.values()],
        source_id: null,
        checked: false,
        next_provider: 0,
        active_query: null,
        raw_provider: -1,
        raw_items: [],
        causes: [],
        results_published: true,
        closed: null,
        ...fields,
      };
      if (request.source_run) {
        const describe = (
          work: CitationDeferredWork,
          action: "queued" | "settled",
        ) => ({
          action,
          work_id: work.id,
          source: work.provider_name,
          purpose: work.kind,
          literature_id: work.source_id,
          ...(work.kind === "lookup" ? { relation_id: work.relation_id } : {}),
        });
        const changes =
          fields.deferred?.added
            .filter((work) => !traversal.deferred(work.id))
            .map((work) => describe(work, "queued")) ?? [];
        if (fields.deferred?.completed) {
          const work = traversal.deferred(fields.deferred.completed);
          if (!work) throw new Error("citation deferred work is missing");
          changes.push(describe(work, "settled"));
        }
        if (changes.length)
          await request.source_run.citationSourceDeferred({
            run_id: runId,
            changes,
          });
        await request.source_run.checkpoint({ ...checkpoint });
      }
      return checkpoint;
    };
    const commit = async (
      write: (expired: () => boolean) => Promise<CheckpointFields>,
    ) => {
      const checkpoint = await this.database.writeMetadataSegment(
        async (expired) => {
          signal?.throwIfAborted();
          return save(await write(expired));
        },
        signal,
      );
      await applyCitationCheckpoint(traversal, checkpoint, signal);
    };
    const rateLimit = async (
      state: CitationProviderState,
      failure: StableFailure,
      retryAfter: number | undefined,
    ) => {
      const transition = coolCitationSource(
        state,
        failure,
        retryAfter,
        this.clock.now(),
      );
      await request.source_run?.citationSourceCooldown({
        run_id: runId,
        source: state.provider_name,
        ...transition,
      });
    };
    const unresolvedTargetFailure = providerFailure(
      "A citation target could not be identified within the selected sources and limits.",
    );
    const finishRetry = async (
      state: CitationProviderState,
      previous: CitationProviderState["cooldown"],
      failure: StableFailure | null,
    ) => {
      if (!previous || state.cooldown !== previous) return;
      // A completed invocation confirms the quota rejection ended. An
      // unrelated error follows the normal failure path and keeps the count.
      if (failure && previous.until === undefined) return;
      const retries = failure ? previous.retries + 1 : 0;
      if (failure) state.cooldown = { retries, failure: previous.failure };
      else delete state.cooldown;
      await request.source_run?.citationSourceCooldown({
        run_id: runId,
        source: state.provider_name,
        status: failure ? "retry-ended" : "recovered",
        retries,
        next_retry_at: null,
        reason: failure,
      });
    };
    const publication = {
      run: {
        discovery_run_id: runId,
        kind: "citation",
        status: "RUNNING",
        started_at: startedAt,
        direction: request.direction,
        max_depth: request.max_depth,
        result_limit: request.result_limit,
        seed_literature_ids: seeds,
      },
      providers: request.providers,
    } as const;
    if (resume) {
      batchId = resume.batch_id;
      if (resume.closed) {
        await restore();
        return report(resume.closed);
      }
      await this.database.writeMetadataSegment(async () => {
        await this.database.startCitationDiscovery(publication, true);
        await this.database.writeIntake({
          operation: "resume-citation",
          batch_id: batchId,
          discovery_run_id: runId,
          owner_pid: process.pid,
        });
      });
    } else {
      const seedTitle =
        (await this.database.getLiterature(seeds[0]!))?.metadata.title ??
        seeds[0]!;
      batchId = await this.database.writeMetadataSegment(async () => {
        await this.database.startCitationDiscovery(publication, false);
        batchId = await startIntake(
          this.database,
          "citation",
          seedTitle + " · " + request.direction,
          {
            ...(seeds.length === 1 ? { seed_literature_id: seeds[0]! } : {}),
            ...(request.direction === "both"
              ? {}
              : { direction: request.direction }),
            providers: request.providers.map((p) => p.provider_name),
          },
          request.origin,
          runId,
        );
        await save();
        return batchId;
      });
    }
    const settle = (
      status: CitationDiscoveryReport["status"],
      outcomes: CitationDiscoveryReport["source_results"],
    ) =>
      this.database.writeMetadataSegment(async () => {
        await this.database.finishCitationDiscovery(runId, status, outcomes);
        await finishIntake(
          this.database,
          batchId,
          status.toLowerCase() as Lowercase<CitationDiscoveryReport["status"]>,
          runId,
          outcomes.filter((s) => s.outcome !== "EXHAUSTED").length,
        );
        if (status !== "INTERRUPTED") await save({ closed: status });
      });
    let settled = false;
    let interrupted = request.signal?.aborted ?? false;
    const partMetas = new Set<string>();
    const resultLimitReached = () =>
      request.result_limit !== null &&
      traversal.resultCount + partMetas.size >= request.result_limit;
    const lookup = (state: CitationProviderState, key: ProviderLiteratureKey) =>
      withMetadataRateLimitHandling(
        () =>
          this.metadata.lookupProvider(
            {
              provider_name: state.provider_name,
              key,
              scan_limit: 1,
            },
            request.signal,
          ),
        signal,
      );
    const acceptLookup = async (
      answer: CitationLookup,
      state: CitationProviderState,
      key: ProviderLiteratureKey,
      unitId: string,
      defer: () => void,
    ): Promise<CitationTarget | null> => {
      const progress = await request.source_run?.begin(
        state.provider_name,
        "lookup",
        unitId,
        "supporting",
      );
      const previous = state.cooldown;
      state.attempted = true;
      if (answer.requested) await progress?.dispatched();
      if ("error" in answer && answer.error instanceof MetadataProgressError)
        throw answer.error;
      if (
        request.signal?.aborted ||
        ("result" in answer && answer.result.outcome === "INTERRUPTED")
      ) {
        await progress?.finish("cancelled");
        throw new CitationPaused();
      }
      if ("error" in answer) {
        const error = answer.error;
        const failure =
          error instanceof MetadataProviderFailure
            ? error.failure
            : providerFailure(
                "The citation provider could not resolve a relation target.",
              );
        await progress?.failure(failure.code, error);
        if (isCitationRateLimit(failure)) {
          await rateLimit(
            state,
            failure,
            error instanceof MetadataProviderFailure
              ? error.retry_after_ms
              : undefined,
          );
          defer();
        } else {
          recordCitationFailure(state, failure);
          await finishRetry(state, previous, failure);
        }
        return null;
      }
      const result = answer.result;
      await progress?.returned(result.raw_item_count);
      consumeCitationInvocation(state, result);
      if (result.failure && isCitationRateLimit(result.failure)) {
        await rateLimit(state, result.failure, result.retry_after_ms);
        defer();
      } else {
        await finishRetry(state, previous, result.failure);
      }
      const observation = result.observations.find((item) =>
        observationMatches(item, state.provider_name, key),
      );
      let target: CitationTarget | null = null;
      if (observation) {
        const decision = await this.identity.observe(observation, {
          intake_batch_id: batchId,
          intake_exclude_ids: seeds,
        });
        if (decision.disposition === "accepted" && decision.literature_id) {
          target = await this.database.getLiteratureIds(decision.literature_id);
          if (target)
            await progress?.observed(
              target.meta_literature_id,
              decision.created,
            );
        } else {
          await progress?.rejected();
          await progress?.finish("hit");
          return null;
        }
      }
      if (result.failure) await progress?.failure(result.failure.code);
      else await progress?.finish(observation ? "hit" : "miss");
      return target;
    };
    const partEdges = new Set<string>();
    const partCauses: CitationCause[] = [];
    const clearSegment = () => {
      partEdges.clear();
      partCauses.length = 0;
      partMetas.clear();
    };
    const publishEdge = async (
      sourceId: string,
      depth: number,
      relationId: string,
      outgoing: boolean,
      target: CitationTarget,
      intakeMemberRecorded: boolean,
      progress: MetadataSourceRecorder | undefined,
    ) => {
      const edgeSource = outgoing ? sourceId : target.literature_id;
      const edgeTarget = outgoing ? target.literature_id : sourceId;
      if (edgeSource === edgeTarget) return false;
      await this.references.publishWithProviderObservation(
        parseReference({
          reference_id: randomUUID(),
          source_literature_id: edgeSource,
          target_literature_id: edgeTarget,
        }),
        relationId,
      );
      if (!seeds.includes(target.literature_id))
        await progress?.included(target.meta_literature_id);
      const edgeKey = `${edgeSource}\u0000${edgeTarget}`;
      if (
        traversal.hasEdge(edgeSource, edgeTarget) ||
        partEdges.has(edgeKey) ||
        seeds.includes(target.literature_id)
      )
        return true;
      partEdges.add(edgeKey);
      if (!intakeMemberRecorded)
        await this.database.writeIntake({
          operation: "member",
          member: {
            batch_id: batchId,
            literature_id: target.literature_id,
            disposition: "matched",
          },
        });
      if (!traversal.hasResult(target.meta_literature_id))
        partMetas.add(target.meta_literature_id);
      const cause = {
        meta_literature_id: target.meta_literature_id,
        source_literature_id: edgeSource,
        target_literature_id: edgeTarget,
        actual_literature_id: target.literature_id,
        depth: depth + 1,
      };
      await this.database.appendCitationCause(runId, cause);
      partCauses.push(cause);
      return true;
    };
    const readAnchor = async (sourceId: string) => {
      const source = await this.database.getLiterature(sourceId);
      if (!source) throw new Error("citation seed Literature was not found");
      const snapshot = await this.database.literatureDetailSnapshot(sourceId);
      const observations = snapshot
        ? (await parseLiteratureDetail(snapshot.detail)).metadata_observations
        : [];
      // Provider-native record IDs can be required even when a DOI is known.
      return (providerName: string): ProviderLiteratureKey => ({
        record_id:
          observations.find(
            (item) => item.provenance.source_name === providerName,
          )?.provenance.source_record_id ?? null,
        identifiers: source.metadata.identifiers,
      });
    };
    const referenceWork = (
      sourceId: string,
      depth: number,
      providerName: string,
      activeQuery: CitationQueryProgress | null,
    ): DeferredReference => ({
      id: referenceQueryId(sourceId, providerName),
      source_id: sourceId,
      depth,
      provider_name: providerName,
      kind: "reference-query",
      active_query: activeQuery,
    });
    const runReference = async (
      work: DeferredReference,
      key: ProviderLiteratureKey,
      providerIndex: number,
      backfill = false,
    ): Promise<boolean> => {
      const { source_id: sourceId, active_query: activeQuery } = work;
      const depth = traversal.depthOf(sourceId) ?? work.depth;
      const provider = request.providers[providerIndex]!;
      const state = states.get(work.provider_name)!;
      const startCooldown = state.cooldown;
      const pendingWork = new Map<string, CitationDeferredWork>();
      let sourceChecked = false;
      signal?.throwIfAborted();
      const progress = await request.source_run?.begin(
        provider.provider_name,
        "reference-query",
        sourceId,
      );
      let sourceFailure = activeQuery?.failure ?? null,
        referenceListProvided = activeQuery?.returnedRelations ?? false;
      let complete = false;
      let usableRelations = activeQuery?.usableRelations ?? 0;
      let incomplete = activeQuery?.incomplete ?? false;
      const pendingItem = activeQuery?.pending_item ?? null;
      let pendingMatched = pendingItem === null;
      const replayCount =
        (pendingItem ? 1 : 0) +
        (activeQuery ? traversal.beginReplay(work.id) : 0);
      const retryWork = (active_query: CitationQueryProgress | null) => ({
        ...work,
        active_query,
      });
      let stream: AsyncGenerator<MetadataScanEvent>;
      state.attempted = true;
      try {
        signal?.throwIfAborted();
        stream = this.metadata.streamReferencesProvider(
          request.direction,
          provider.provider_name,
          [key],
          state.scan_limit === null
            ? null
            : state.scan_limit - state.raw_item_count + replayCount,
          request.signal,
        );
      } catch (error) {
        if (error instanceof MetadataProgressError) throw error;
        if (request.signal?.aborted) {
          await progress?.finish("cancelled");
          interrupted = true;
          return false;
        }
        const failure =
          error instanceof MetadataProviderFailure
            ? error.failure
            : providerFailure(
                "The citation provider could not complete expansion.",
              );
        await commit(async () => {
          await progress?.failure(failure.code, error);
          const limited = isCitationRateLimit(failure);
          if (limited)
            await rateLimit(
              state,
              failure,
              error instanceof MetadataProviderFailure
                ? error.retry_after_ms
                : undefined,
            );
          else {
            recordCitationFailure(state, failure);
            await finishRetry(state, startCooldown, failure);
          }
          return {
            source_id: sourceId,
            next_provider: providerIndex + 1,
            ...(activeQuery ? { raw_provider: providerIndex } : {}),
            ...(limited || backfill
              ? {
                  deferred: {
                    added: limited ? [work] : [],
                    completed: !limited && backfill ? work.id : null,
                  },
                }
              : {}),
          };
        });
        return false;
      }
      const lookups = new Map<string, CitationLookup>();
      let wroteLookup = false;
      const applyItem = async (
        event: CitationItem,
        nextRelation: number | null,
        expired: () => boolean,
      ): Promise<number | null> => {
        if (nextRelation === null) {
          state.raw_item_count += 1;
          await progress?.returned(1);
          if (request.signal?.aborted) throw new CitationPaused();
          if (event.failure) {
            await progress?.rejected();
            // Metadata ends this invocation immediately on a rate error.
            // The terminal receipt carries the rate signal once.
            if (!isCitationRateLimit(event.failure)) {
              sourceFailure ??= event.failure;
              recordCitationFailure(state, event.failure);
              incomplete = true;
            }
          }
          if (event.item.relations.length > 0) referenceListProvided = true;
          // Raw reference text about the anchor remains available even when no
          // related work can yet be identified.
          for (const observation of event.item.observations) {
            signal?.throwIfAborted();
            if (observationMatches(observation, provider.provider_name, key)) {
              const decision = await this.identity.observe(observation);
              if (decision.disposition === "accepted") {
                const accepted = await this.database.getLiteratureIds(
                  decision.literature_id,
                );
                if (accepted)
                  await progress?.observed(
                    accepted.meta_literature_id,
                    decision.created,
                  );
              }
            }
          }
        }
        const firstRelation = nextRelation ?? 0;
        for (let i = firstRelation; i < event.item.relations.length; i++) {
          if (request.signal?.aborted) throw new CitationPaused();
          if (i > firstRelation && (wroteLookup || expired())) return i;
          const relation = event.item.relations[i]!;
          await this.observations.publishProviderRelation(relation);
          const sourceMatches =
            (key.record_id !== null &&
              key.record_id === relation.citing.record_id) ||
            relation.citing.identifiers.some((item) =>
              key.identifiers.some(
                (candidate) =>
                  candidate.namespace === item.namespace &&
                  candidate.value === item.value,
              ),
            );
          const citedMatches =
            (key.record_id !== null &&
              key.record_id === relation.cited.record_id) ||
            relation.cited.identifiers.some((item) =>
              key.identifiers.some(
                (candidate) =>
                  candidate.namespace === item.namespace &&
                  candidate.value === item.value,
              ),
            );
          const outgoing =
            sourceMatches &&
            (request.direction === "references" ||
              request.direction === "both");
          const incoming =
            citedMatches &&
            (request.direction === "cited-by" || request.direction === "both");
          const targetKey = outgoing
            ? relation.cited
            : incoming
              ? relation.citing
              : null;
          if (!targetKey) continue;
          const targetIdentifiers = targetKey.identifiers;
          const local = targetIdentifiers.length
            ? await this.database.findLiteratureIdsByIdentifiers(
                targetIdentifiers,
              )
            : [];
          if (local.length > 1) {
            incomplete = true;
            recordCitationFailure(
              state,
              providerFailure(
                "A citation target matched multiple local literatures.",
              ),
            );
            continue;
          }
          let targetLiterature = local[0] ?? null;
          let intakeMemberRecorded = false;
          const deferredLookups: DeferredLookup[] = [];
          const inline = event.item.observations.filter((observation) =>
            observationMatches(observation, provider.provider_name, targetKey),
          );
          for (const observation of inline) {
            signal?.throwIfAborted();
            const decision = await this.identity.observe(observation, {
              intake_batch_id: batchId,
              intake_exclude_ids: seeds,
            });
            if (decision.disposition === "accepted" && decision.literature_id) {
              targetLiterature = await this.database.getLiteratureIds(
                decision.literature_id,
              );
              intakeMemberRecorded = targetLiterature !== null;
              if (targetLiterature)
                await progress?.observed(
                  targetLiterature.meta_literature_id,
                  decision.created,
                );
            }
          }
          if (!targetLiterature) {
            // Native record IDs belong to the relation's provider. Only
            // neutral identifiers can cross into a fallback provider.
            const lookupProviders = [
              provider,
              ...request.providers.filter(
                (candidate) =>
                  candidate.provider_name !== provider.provider_name,
              ),
            ];
            for (const candidate of lookupProviders) {
              if (request.signal?.aborted) {
                interrupted = true;
                break;
              }
              const lookupState = states.get(candidate.provider_name)!;
              if (
                (lookupState.terminal !== null &&
                  lookupState.cooldown?.until !== null) ||
                citationScanLimitReached(lookupState)
              )
                continue;
              const lookupKey =
                candidate === provider
                  ? targetKey
                  : {
                      record_id: null,
                      identifiers: targetKey.identifiers,
                    };
              if (!lookupKey.record_id && !lookupKey.identifiers.length)
                continue;
              const cacheKey = lookupWorkId(
                relation.observation_id,
                candidate.provider_name,
              );
              const defer = () => {
                deferredLookups.push({
                  id: cacheKey,
                  kind: "lookup",
                  provider_name: candidate.provider_name,
                  source_id: sourceId,
                  depth,
                  relation_id: relation.observation_id,
                  reference_provider: provider.provider_name,
                  outgoing,
                  unresolved: true,
                });
              };
              if (lookupState.cooldown?.until !== undefined) {
                defer();
                continue;
              }
              const answer = lookups.get(cacheKey);
              if (!answer)
                throw new CitationLookupNeeded(cacheKey, () =>
                  lookup(lookupState, lookupKey),
                );
              wroteLookup = true;
              targetLiterature = await acceptLookup(
                answer,
                lookupState,
                lookupKey,
                sourceId + ":" + relation.observation_id,
                defer,
              );
              intakeMemberRecorded = targetLiterature !== null;
              if (targetLiterature) break;
            }
          }
          if (interrupted) break;
          for (const deferred of deferredLookups)
            pendingWork.set(deferred.id, {
              ...deferred,
              unresolved: targetLiterature === null,
            });
          if (!targetLiterature) {
            incomplete = true;
            if (!deferredLookups.length && !citationScanLimitReached(state))
              recordCitationFailure(state, unresolvedTargetFailure);
            continue;
          }
          if (
            await publishEdge(
              sourceId,
              depth,
              relation.observation_id,
              outgoing,
              targetLiterature,
              intakeMemberRecorded,
              progress,
            )
          )
            usableRelations++;
          if (resultLimitReached()) break;
        }
        if (citationScanLimitReached(state) && state.terminal === null)
          state.terminal = "SCAN_LIMIT_REACHED";
        if (interrupted || request.signal?.aborted) throw new CitationPaused();
        return null;
      };
      let ended = false;
      try {
        for await (const page of citationPages(
          progress ? progress.stream(stream) : stream,
          signal,
        )) {
          // The pending item already consumed its raw scan slot. The
          // replay allowance cannot pay for a different item.
          const replayOnly =
            pendingItem !== null && citationScanLimitReached(state);
          const fresh = page.items.flatMap<{
            event: CitationItem;
            key: string;
            nextRelation: number | null;
          }>((event) => {
            signal?.throwIfAborted();
            const key = citationItemKey(event);
            if (activeQuery && traversal.consumeRawItem(work.id, key)) {
              return [];
            }
            if (!pendingMatched && pendingItem && key === pendingItem.key) {
              pendingMatched = true;
              return [
                {
                  event: restoreCitationItem(event, pendingItem),
                  key,
                  nextRelation: pendingItem.next_relation,
                },
              ];
            }
            return replayOnly ? [] : [{ event, key, nextRelation: null }];
          });
          let offset = 0;
          let nextRelation: number | null = null;
          while ((offset < fresh.length || page.end) && !ended) {
            if (request.signal?.aborted) throw new CitationPaused();
            const start = offset;
            const relationStart: number | null = nextRelation;
            const before: {
              states: CitationProviderState[];
              sourceFailure: StableFailure | null;
              referenceListProvided: boolean;
              usableRelations: number;
              incomplete: boolean;
              complete: boolean;
              ended: boolean;
              sourceChecked: boolean;
            } = {
              states: [...states.values()].map((item) => ({ ...item })),
              sourceFailure,
              referenceListProvided,
              usableRelations,
              incomplete,
              complete,
              ended,
              sourceChecked,
            };
            clearSegment();
            pendingWork.clear();
            wroteLookup = false;
            try {
              await commit(async (expired) => {
                while (
                  offset < fresh.length &&
                  (offset === start || !expired()) &&
                  (state.terminal === null ||
                    nextRelation !== null ||
                    fresh[offset]!.nextRelation !== null) &&
                  !resultLimitReached()
                ) {
                  if (request.signal?.aborted) throw new CitationPaused();
                  const item = fresh[offset]!;
                  nextRelation = await applyItem(
                    item.event,
                    nextRelation ?? item.nextRelation,
                    expired,
                  );
                  if (nextRelation !== null) break;
                  offset++;
                  if (wroteLookup) break;
                }
                ended =
                  (state.terminal !== null && nextRelation === null) ||
                  resultLimitReached();
                const atEnd =
                  page.end && offset === fresh.length ? page.end : undefined;
                const limited =
                  atEnd?.failure && isCitationRateLimit(atEnd.failure)
                    ? atEnd.failure
                    : null;
                const suspended =
                  !atEnd &&
                  offset === fresh.length &&
                  state.cooldown?.until !== undefined &&
                  state.cooldown !== startCooldown;
                if (limited) {
                  await rateLimit(state, limited, atEnd?.retry_after_ms);
                  ended = true;
                } else if ((!ended && atEnd) || suspended) {
                  ended = true;
                  if (
                    atEnd?.outcome === "INTERRUPTED" ||
                    request.signal?.aborted
                  )
                    throw new CitationPaused();
                  if (atEnd?.failure) {
                    sourceFailure ??= atEnd.failure;
                    recordCitationFailure(state, atEnd.failure);
                    incomplete = true;
                  }
                  complete = atEnd?.outcome === "EXHAUSTED";
                }
                const deferReference = limited !== null || suspended;
                const query: CitationQueryProgress = {
                  failure: sourceFailure,
                  returnedRelations: referenceListProvided,
                  usableRelations,
                  incomplete,
                  pending_item:
                    nextRelation !== null
                      ? pendingCitationItem(
                          fresh[offset]!.event,
                          fresh[offset]!.key,
                          nextRelation,
                        )
                      : deferReference && !pendingMatched
                        ? pendingItem
                        : null,
                };
                if (deferReference || (backfill && !ended))
                  pendingWork.set(work.id, retryWork(query));
                if (ended) {
                  if (!deferReference)
                    await finishRetry(state, startCooldown, sourceFailure);
                  if (
                    !deferReference &&
                    pendingItem &&
                    !pendingMatched &&
                    page.end?.outcome !== "INTERRUPTED"
                  ) {
                    if (
                      state.terminal === null &&
                      citationScanLimitReached(state)
                    )
                      state.terminal = "SCAN_LIMIT_REACHED";
                    await request.source_run?.citationResponseReplaced(
                      sourceId,
                      provider.provider_name,
                      pendingItem.next_relation,
                    );
                  }
                  const failure = limited ?? sourceFailure;
                  if (failure) await progress?.failure(failure.code);
                  else if (suspended)
                    await progress?.finish(
                      "error",
                      "metadata-provider-rate-limited",
                    );
                  else
                    await progress?.finish(
                      referenceListProvided ? "hit" : "miss",
                    );
                  sourceChecked =
                    !backfill &&
                    ((complete && usableRelations > 0 && !incomplete) ||
                      resultLimitReached() ||
                      !request.providers
                        .slice(providerIndex + 1)
                        .some(
                          (p) =>
                            states.get(p.provider_name)!.terminal === null ||
                            states.get(p.provider_name)!.cooldown?.until ===
                              null,
                        ));
                }
                const completed =
                  backfill && ended && !deferReference ? work.id : null;
                return {
                  source_id: sourceId,
                  checked: sourceChecked,
                  next_provider: ended ? providerIndex + 1 : providerIndex,
                  active_query: ended ? null : query,
                  raw_provider: providerIndex,
                  raw_items: fresh.slice(start, offset).map(({ key }) => key),
                  causes: partCauses,
                  ...(pendingWork.size || completed
                    ? {
                        deferred: {
                          added: [...pendingWork.values()],
                          completed,
                        },
                      }
                    : {}),
                };
              });
            } catch (error) {
              partMetas.clear();
              for (const item of before.states) {
                const current = states.get(item.provider_name)!;
                delete current.cooldown;
                Object.assign(current, item);
              }
              ({
                sourceFailure,
                referenceListProvided,
                usableRelations,
                incomplete,
                complete,
                ended,
                sourceChecked,
              } = before);
              offset = start;
              nextRelation = relationStart;
              if (!(error instanceof CitationLookupNeeded)) throw error;
              signal?.throwIfAborted();
              const answer = await fetchCitationLookup(error.lookup);
              lookups.set(error.key, answer);
              continue;
            }
            // The checkpoint above carries enqueue order and checked state
            // in the same commit as all accepted results in this segment.
            partMetas.clear();
          }
          lookups.clear();
          if (ended) break;
        }
      } catch (error) {
        partMetas.clear();
        if (!paused(error)) throw error;
        await progress?.finish("cancelled");
        interrupted = true;
        return false;
      }
      return sourceChecked;
    };
    const runDeferredLookup = async (work: DeferredLookup) => {
      const relation = await this.observations.getProviderRelation(
        work.relation_id,
      );
      if (!relation)
        throw new Error("deferred citation relation was not found");
      const target = work.outgoing ? relation.cited : relation.citing;
      const key =
        work.provider_name === work.reference_provider
          ? target
          : { record_id: null, identifiers: target.identifiers };
      const state = states.get(work.provider_name)!;
      signal?.throwIfAborted();
      const answer = await fetchCitationLookup(() => lookup(state, key));
      clearSegment();
      await commit(async () => {
        let limited = false;
        const resolved = await acceptLookup(
          answer,
          state,
          key,
          work.source_id + ":" + work.relation_id,
          () => {
            limited = true;
          },
        );
        const related = traversal.relatedWork(work.relation_id, work.id);
        let added: CitationDeferredWork[] = [];
        const referenceState = states.get(work.reference_provider)!;
        if (resolved) {
          // Attribute the edge to the source that provided it. This record
          // resumes inclusion only and has no new primary Network dispatch.
          const progress = await request.source_run?.begin(
            work.reference_provider,
            "reference-query",
            work.source_id,
          );
          await publishEdge(
            work.source_id,
            traversal.depthOf(work.source_id) ?? work.depth,
            work.relation_id,
            work.outgoing,
            resolved,
            true,
            progress,
          );
          await progress?.finish("hit");
          added = related.flatMap((other) =>
            other.kind === "lookup" && other.unresolved
              ? [{ ...other, unresolved: false }]
              : [],
          );
          if (limited && work.unresolved)
            added.push({ ...work, unresolved: false });
        } else if (
          !limited &&
          work.unresolved &&
          !related.length &&
          !citationScanLimitReached(referenceState)
        ) {
          recordCitationFailure(referenceState, unresolvedTargetFailure);
        }
        return {
          causes: partCauses,
          deferred: { added, completed: limited ? null : work.id },
        };
      });
      partMetas.clear();
    };
    const nextDeferred = () => {
      let wake = Infinity;
      if (!traversal.hasDeferredWork) return { work: undefined, wake };
      let next: ReturnType<typeof traversal.oldestDeferred>;
      const now = this.clock.now();
      for (const state of states.values()) {
        if (
          state.cooldown?.until === null ||
          (state.terminal !== null && state.terminal !== "SCAN_LIMIT_REACHED")
        )
          continue;
        const head = traversal.oldestDeferred(state.provider_name);
        if (
          !head ||
          (state.terminal === "SCAN_LIMIT_REACHED" &&
            (head.work.kind !== "reference-query" ||
              !head.work.active_query?.pending_item))
        )
          continue;
        const until = state.cooldown?.until ?? 0;
        if (until > now) wake = Math.min(wake, until);
        else if (!next || head.ordinal < next.ordinal) next = head;
      }
      return { work: next?.work, wake };
    };
    try {
      await restore();
      // Old checkpoints can contain a committed prefix that was never published.
      // Reapply it idempotently, including after recovery marked the run interrupted.
      if (resume && !resume.results_published)
        await writeMetadataItems(
          this.database,
          traversal.publicationCauses(),
          (cause) => this.database.appendCitationCause(runId, cause),
          signal,
        );
      while (
        !interrupted &&
        !request.signal?.aborted &&
        !resultLimitReached()
      ) {
        await yieldToEvents();
        signal?.throwIfAborted();
        const anchor = traversal.pending();
        const sourceResume =
          resume?.source_id === anchor?.[0] && !resume?.checked
            ? resume
            : undefined;
        const { work, wake } = nextDeferred();
        if (work && !sourceResume) {
          try {
            if (work.kind === "lookup") await runDeferredLookup(work);
            else {
              const readKey = await readAnchor(work.source_id);
              const index = request.providers.findIndex(
                (provider) => provider.provider_name === work.provider_name,
              );
              await runReference(
                work,
                readKey(work.provider_name),
                index,
                true,
              );
            }
          } catch (error) {
            if (!paused(error)) throw error;
            interrupted = true;
          }
          continue;
        }
        if (!anchor) {
          if (!Number.isFinite(wake)) break;
          try {
            const remaining = wake - this.clock.now();
            if (remaining > 0) await this.clock.wait(remaining, request.signal);
          } catch (error) {
            if (!request.signal?.aborted) throw error;
            interrupted = true;
          }
          continue;
        }
        const [sourceId, depth] = anchor;
        let checked = false;
        if (depth < request.max_depth) {
          const readKey = await readAnchor(sourceId);
          for (
            let i = sourceResume?.next_provider ?? 0;
            i < request.providers.length &&
            !interrupted &&
            !request.signal?.aborted &&
            !resultLimitReached();
            i++
          ) {
            const provider = request.providers[i]!;
            const state = states.get(provider.provider_name)!;
            const query =
              sourceResume?.next_provider === i
                ? sourceResume.active_query
                : null;
            const work = referenceWork(
              sourceId,
              depth,
              provider.provider_name,
              query,
            );
            if (
              state.terminal !== null &&
              state.cooldown?.until !== null &&
              !query?.pending_item
            )
              continue;
            if (state.cooldown?.until !== undefined) {
              await commit(async () => ({
                source_id: sourceId,
                next_provider: i + 1,
                deferred: { added: [work], completed: null },
              }));
            } else {
              checked = await runReference(
                work,
                readKey(provider.provider_name),
                i,
              );
              if (checked) break;
            }
          }
        }
        if (!interrupted && !request.signal?.aborted && !checked) {
          const checkpoint = await save({ source_id: sourceId, checked: true });
          await applyCitationCheckpoint(traversal, checkpoint, signal);
        }
      }
      if (request.signal?.aborted) interrupted = true;
      const outcomes = sourceResults(interrupted);
      const status: CitationDiscoveryReport["status"] = interrupted
        ? "INTERRUPTED"
        : outcomes.length > 0 &&
            traversal.resultCount === 0 &&
            outcomes.every((item) => item.outcome === "FAILED")
          ? "FAILED"
          : outcomes.some((item) => item.outcome === "FAILED")
            ? "PARTIAL"
            : "COMPLETED";
      await settle(status, outcomes);
      settled = true;
      return report(status);
    } catch (error) {
      if (!paused(error)) throw error;
      await settle("INTERRUPTED", sourceResults(true));
      settled = true;
      return report("INTERRUPTED");
    } finally {
      if (!settled) await settle("INTERRUPTED", []);
    }
  }
}
