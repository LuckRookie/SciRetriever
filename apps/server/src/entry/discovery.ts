import {
  startIntake,
  finishIntake,
  type IntakeOrigin,
} from "../literature/intake.js";
import { randomUUID } from "node:crypto";
import { writeMetadataItems } from "./metadata-write.js";
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
import type { MetadataService } from "../metadata/service.js";
import { MetadataProviderFailure } from "../metadata/ports.js";
import {
  MetadataProgressError,
  type MetadataSourceRun,
} from "../application/jobs/metadata-progress.js";
import { observeNetworkRequests } from "../network/request-activity.js";
import {
  citationItemKey,
  parseCitationCheckpoint,
  pendingCitationItem,
  restoreCitationProgress,
  restoreCitationItem,
  type CitationCause,
  type CitationCheckpoint,
  type CitationItem,
  type CitationProviderState,
} from "./citation-checkpoint.js";
import type { MetadataScanEvent } from "../metadata/ports.js";
import type { LiteratureIdentityService } from "../literature/identity.js";
import type { ObservationRepository } from "../storage/sqlite/repositories.js";
import type { ReferenceRepository } from "../storage/sqlite/repositories.js";
import { CitationProgress } from "../storage/sqlite/citation-progress.js";
import {
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
      "metadata-provider-rate-limited",
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
  if (invocation.outcome === "FAILED") {
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
): AsyncGenerator<ReferencePage> {
  let items: CitationItem[] = [];
  for await (const event of stream) {
    if (event.kind === "end") {
      yield { items, end: event };
      return;
    }
    items.push(event);
    if (
      !event.end_follows &&
      (!event.buffered_next || event.failure || items.length >= 128)
    ) {
      yield { items };
      items = [];
    }
  }
}

type CitationLookup = { readonly requested: boolean } & (
  | { readonly result: MetadataProviderInvocation }
  | { readonly error: unknown }
);

// A lookup is a provider call. Roll back the provisional segment before calling
// out, then replay it using the actual receipt and the same event order.
class CitationLookupNeeded extends Error {
  constructor(
    readonly key: string,
    readonly lookup: () => Promise<MetadataProviderInvocation>,
  ) {
    super("citation lookup must run outside the catalog write");
  }
  async fetch(): Promise<CitationLookup> {
    let requested = false;
    try {
      const result = await observeNetworkRequests(() => {
        requested = true;
      }, this.lookup);
      return { requested, result };
    } catch (error) {
      return { requested, error };
    }
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
    const traversal = new CitationProgress(seeds, request.max_depth);
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
    traversal: CitationProgress,
  ): Promise<CitationDiscoveryReport> {
    const tail = await request.source_run?.latestCheckpoint();
    const latest = tail ? parseCitationCheckpoint(tail.payload) : undefined;
    const resume = latest?.closed === "FAILED" ? undefined : latest;
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
    if (request.source_run && tail)
      await restoreCitationProgress(
        request.source_run,
        resume,
        tail.sequence,
        traversal,
      );
    const sourceResults = (): CitationDiscoveryReport["source_results"] =>
      request.providers
        .filter((provider) => states.get(provider.provider_name)!.attempted)
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
        source_results: Object.freeze(sourceResults()),
      });
    const save = async (
      fields: Partial<
        Omit<
          CitationCheckpoint,
          "version" | "run_id" | "batch_id" | "started_at" | "providers"
        >
      > = {},
    ) => {
      if (!request.source_run) return;
      await request.source_run.checkpoint({
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
        closed: null,
        ...fields,
      });
    };
    if (resume) {
      batchId = resume.batch_id;
      if (resume.closed) return report(resume.closed);
      await this.database.writeIntake({
        operation: "resume-citation",
        batch_id: batchId,
        discovery_run_id: runId,
        owner_pid: process.pid,
      });
    } else {
      const seedTitle =
        (await this.database.getLiterature(seeds[0]!))?.metadata.title ??
        seeds[0]!;
      batchId = await this.database.writeMetadataSegment(async () => {
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
        );
        await save();
        return batchId;
      });
    }
    let settled = false;
    let interrupted = request.signal?.aborted ?? false;
    const partMetas = new Set<string>();
    const resultLimitReached = () =>
      request.result_limit !== null &&
      traversal.resultCount + partMetas.size >= request.result_limit;
    try {
      for (const [sourceId, depth] of traversal.pending()) {
        if (interrupted || resultLimitReached()) break;
        if (depth >= request.max_depth) continue;
        const sourceResume =
          resume?.source_id === sourceId && !resume.checked ? resume : null;
        let sourceChecked = false;
        const source = await this.database.getLiterature(sourceId);
        if (!source) throw new Error("citation seed Literature was not found");
        // Provider-native record IDs can be required even when a DOI is known
        // (for example, a provider's reverse-citation query). Keep both forms.
        const snapshot = await this.database.literatureDetailSnapshot(sourceId);
        const sourceObservations = snapshot
          ? (await parseLiteratureDetail(snapshot.detail)).metadata_observations
          : [];
        for (
          let providerIndex = sourceResume?.next_provider ?? 0;
          providerIndex < request.providers.length;
          providerIndex++
        ) {
          const provider = request.providers[providerIndex]!;
          if (resultLimitReached() || interrupted) break;
          const state = states.get(provider.provider_name)!;
          if (
            state.terminal !== null &&
            !(
              sourceResume?.next_provider === providerIndex &&
              sourceResume.active_query?.pending_item
            )
          )
            continue;
          if (request.signal?.aborted) {
            interrupted = true;
            break;
          }
          const key: ProviderLiteratureKey = {
            record_id:
              sourceObservations.find(
                (item) =>
                  item.provenance.source_name === provider.provider_name,
              )?.provenance.source_record_id ?? null,
            identifiers: source.metadata.identifiers,
          };
          const progress = await request.source_run?.begin(
            provider.provider_name,
            "reference-query",
            sourceId,
          );
          const activeQuery =
            sourceResume?.next_provider === providerIndex
              ? sourceResume.active_query
              : null;
          let sourceFailure = activeQuery?.failure ?? null,
            referenceListProvided = activeQuery?.returnedRelations ?? false;
          let complete = false;
          let usableRelations = activeQuery?.usableRelations ?? 0;
          let incomplete = activeQuery?.incomplete ?? false;
          const pendingItem = activeQuery?.pending_item ?? null;
          let pendingMatched = pendingItem === null;
          const replayCount =
            (pendingItem ? 1 : 0) + (activeQuery ? traversal.replayCount : 0);
          let stream: AsyncGenerator<MetadataScanEvent>;
          state.attempted = true;
          try {
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
              break;
            }
            const failure =
              error instanceof MetadataProviderFailure
                ? error.failure
                : providerFailure(
                    "The citation provider could not complete expansion.",
                  );
            await this.database.writeMetadataSegment(async () => {
              await progress?.failure(failure.code, error);
              recordCitationFailure(state, failure);
              await save({
                source_id: sourceId,
                next_provider: providerIndex + 1,
              });
            });
            continue;
          }
          const partEdges = new Set<string>();
          const partCauses: CitationCause[] = [];
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
                sourceFailure ??= event.failure;
                await progress?.rejected();
                recordCitationFailure(state, event.failure);
                incomplete = true;
              }
              if (event.item.relations.length > 0) referenceListProvided = true;
              // Raw reference text about the anchor remains available even when no
              // related work can yet be identified.
              for (const observation of event.item.observations)
                if (
                  observationMatches(observation, provider.provider_name, key)
                ) {
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
                (request.direction === "cited-by" ||
                  request.direction === "both");
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
              const inline = event.item.observations.filter((observation) =>
                observationMatches(
                  observation,
                  provider.provider_name,
                  targetKey,
                ),
              );
              for (const observation of inline) {
                const decision = await this.identity.observe(observation, {
                  intake_batch_id: batchId,
                  intake_exclude_ids: seeds,
                });
                if (
                  decision.disposition === "accepted" &&
                  decision.literature_id
                ) {
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
                    lookupState.terminal !== null ||
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
                  const cacheKey = JSON.stringify([
                    relation.observation_id,
                    candidate.provider_name,
                    lookupKey,
                  ]);
                  const answer = lookups.get(cacheKey);
                  if (!answer)
                    throw new CitationLookupNeeded(cacheKey, () =>
                      this.metadata.lookupProvider(
                        {
                          provider_name: candidate.provider_name,
                          key: lookupKey,
                          scan_limit: 1,
                        },
                        request.signal,
                      ),
                    );
                  wroteLookup = true;
                  const lookupProgress = await request.source_run?.begin(
                    candidate.provider_name,
                    "lookup",
                    sourceId + ":" + relation.observation_id,
                    "supporting",
                  );
                  lookupState.attempted = true;
                  if (answer.requested) await lookupProgress?.dispatched();
                  if ("error" in answer) {
                    const error = answer.error;
                    if (error instanceof MetadataProgressError) throw error;
                    if (request.signal?.aborted) {
                      await lookupProgress?.finish("cancelled");
                      interrupted = true;
                      break;
                    }
                    const failure =
                      error instanceof MetadataProviderFailure
                        ? error.failure
                        : providerFailure(
                            "The citation provider could not resolve a relation target.",
                          );
                    await lookupProgress?.failure(failure.code, error);
                    recordCitationFailure(lookupState, failure);
                    continue;
                  }
                  const lookup = answer.result;
                  await lookupProgress?.returned(lookup.raw_item_count);
                  consumeCitationInvocation(lookupState, lookup);
                  if (
                    lookup.outcome === "INTERRUPTED" ||
                    request.signal?.aborted
                  ) {
                    await lookupProgress?.finish("cancelled");
                    interrupted = true;
                    break;
                  }
                  const targetObservation = lookup.observations.find(
                    (observation) =>
                      observationMatches(
                        observation,
                        candidate.provider_name,
                        lookupKey,
                      ),
                  );
                  if (!targetObservation) {
                    if (lookup.failure)
                      await lookupProgress?.failure(lookup.failure.code);
                    else await lookupProgress?.finish("miss");
                    continue;
                  }
                  const decision = await this.identity.observe(
                    targetObservation,
                    { intake_batch_id: batchId, intake_exclude_ids: seeds },
                  );
                  if (
                    decision.disposition !== "accepted" ||
                    !decision.literature_id
                  ) {
                    await lookupProgress?.rejected();
                    await lookupProgress?.finish("hit");
                    continue;
                  }
                  targetLiterature = await this.database.getLiteratureIds(
                    decision.literature_id,
                  );
                  intakeMemberRecorded = targetLiterature !== null;
                  if (targetLiterature)
                    await lookupProgress?.observed(
                      targetLiterature.meta_literature_id,
                      decision.created,
                    );
                  if (lookup.failure)
                    await lookupProgress?.failure(lookup.failure.code);
                  else await lookupProgress?.finish("hit");
                  if (targetLiterature) break;
                }
              }
              if (interrupted) break;
              if (!targetLiterature) {
                incomplete = true;
                if (!citationScanLimitReached(state))
                  recordCitationFailure(
                    state,
                    providerFailure(
                      "A citation target could not be identified within the selected sources and limits.",
                    ),
                  );
                continue;
              }
              const edgeSource = outgoing
                ? sourceId
                : targetLiterature.literature_id;
              const edgeTarget = outgoing
                ? targetLiterature.literature_id
                : sourceId;
              if (edgeSource === edgeTarget) continue;
              usableRelations += 1;
              const edgeKey = `${edgeSource}\u0000${edgeTarget}`;
              const referenceId = randomUUID();
              await this.references.publishWithProviderObservation(
                parseReference({
                  reference_id: referenceId,
                  source_literature_id: edgeSource,
                  target_literature_id: edgeTarget,
                }),
                relation.observation_id,
              );
              if (!seeds.includes(targetLiterature.literature_id))
                await progress?.included(targetLiterature.meta_literature_id);
              if (
                traversal.hasEdge(edgeSource, edgeTarget) ||
                partEdges.has(edgeKey) ||
                seeds.includes(targetLiterature.literature_id)
              )
                continue;
              partEdges.add(edgeKey);
              if (!intakeMemberRecorded)
                await this.database.writeIntake({
                  operation: "member",
                  member: {
                    batch_id: batchId,
                    literature_id: targetLiterature.literature_id,
                    disposition: "matched",
                  },
                });
              if (!traversal.hasResult(targetLiterature.meta_literature_id))
                partMetas.add(targetLiterature.meta_literature_id);
              partCauses.push({
                meta_literature_id: targetLiterature.meta_literature_id,
                source_literature_id: edgeSource,
                target_literature_id: edgeTarget,
                actual_literature_id: targetLiterature.literature_id,
                depth: depth + 1,
              });
              if (resultLimitReached()) break;
            }
            if (citationScanLimitReached(state) && state.terminal === null)
              state.terminal = "SCAN_LIMIT_REACHED";
            if (interrupted || request.signal?.aborted)
              throw new CitationPaused();
            return null;
          };
          let ended = false;
          try {
            for await (const page of citationPages(
              progress ? progress.stream(stream) : stream,
            )) {
              // The pending item already consumed its raw scan slot. The
              // replay allowance cannot pay for a different item.
              const replayOnly =
                pendingItem !== null && citationScanLimitReached(state);
              const fresh = page.items.flatMap<{
                event: CitationItem;
                key: string | null;
                nextRelation: number | null;
              }>((event) => {
                const key = request.source_run ? citationItemKey(event) : null;
                if (
                  activeQuery &&
                  key !== null &&
                  traversal.consumeRawItem(key)
                ) {
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
                partCauses.length = 0;
                partEdges.clear();
                partMetas.clear();
                wroteLookup = false;
                try {
                  await this.database.writeMetadataSegment(async (expired) => {
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
                    if (!ended && page.end && offset === fresh.length) {
                      ended = true;
                      if (
                        page.end.outcome === "INTERRUPTED" ||
                        request.signal?.aborted
                      )
                        throw new CitationPaused();
                      if (page.end.failure) {
                        sourceFailure ??= page.end.failure;
                        recordCitationFailure(state, page.end.failure);
                        incomplete = true;
                      }
                      complete = page.end.outcome === "EXHAUSTED";
                    }
                    if (ended) {
                      if (
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
                      if (sourceFailure)
                        await progress?.failure(sourceFailure.code);
                      else
                        await progress?.finish(
                          referenceListProvided ? "hit" : "miss",
                        );
                      sourceChecked =
                        (complete && usableRelations > 0 && !incomplete) ||
                        resultLimitReached() ||
                        !request.providers
                          .slice(providerIndex + 1)
                          .some(
                            (p) =>
                              states.get(p.provider_name)!.terminal === null,
                          );
                    }
                    await save({
                      source_id: sourceId,
                      checked: sourceChecked,
                      next_provider: ended ? providerIndex + 1 : providerIndex,
                      active_query: ended
                        ? null
                        : {
                            failure: sourceFailure,
                            returnedRelations: referenceListProvided,
                            usableRelations,
                            incomplete,
                            pending_item:
                              nextRelation === null || !request.source_run
                                ? null
                                : pendingCitationItem(
                                    fresh[offset]!.event,
                                    fresh[offset]!.key!,
                                    nextRelation,
                                  ),
                          },
                      raw_provider: providerIndex,
                      raw_items: fresh
                        .slice(start, offset)
                        .flatMap(({ key }) => (key === null ? [] : [key])),
                      causes: partCauses,
                    });
                  });
                } catch (error) {
                  partMetas.clear();
                  for (const item of before.states)
                    Object.assign(states.get(item.provider_name)!, item);
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
                  const answer = await error.fetch();
                  lookups.set(error.key, answer);
                  continue;
                }
                // The checkpoint above carries enqueue order and checked state
                // in the same commit as all accepted results in this segment.
                traversal.record(partCauses, sourceChecked ? sourceId : null);
                partMetas.clear();
              }
              lookups.clear();
              if (ended) break;
            }
          } catch (error) {
            partMetas.clear();
            if (!(error instanceof CitationPaused)) throw error;
            await progress?.finish("cancelled");
            interrupted = true;
            break;
          }
          if (sourceChecked) break;
        }
        if (!interrupted && !sourceChecked) {
          await save({ source_id: sourceId, checked: true });
          traversal.record([], sourceId);
        }
      }
      if (request.signal?.aborted) interrupted = true;
      const outcomes = sourceResults();
      const status: CitationDiscoveryReport["status"] = interrupted
        ? "INTERRUPTED"
        : outcomes.length > 0 &&
            traversal.resultCount === 0 &&
            outcomes.every((item) => item.outcome === "FAILED")
          ? "FAILED"
          : outcomes.some((item) => item.outcome === "FAILED")
            ? "PARTIAL"
            : "COMPLETED";
      await this.database.writeMetadataSegment(async () => {
        await this.database.putCitationDiscovery(
          {
            run: {
              discovery_run_id: runId,
              kind: "citation",
              status,
              started_at: startedAt,
              direction: request.direction,
              max_depth: request.max_depth,
              result_limit: request.result_limit,
              seed_literature_ids: seeds,
            },
            providers: request.providers,
            source_results: outcomes,
          },
          traversal.publicationPages(),
          resume !== undefined,
        );
        await finishIntake(
          this.database,
          batchId,
          status.toLowerCase() as
            | "completed"
            | "partial"
            | "failed"
            | "interrupted",
          runId,
          outcomes.filter((s) => s.outcome !== "EXHAUSTED").length,
        );
        if (status !== "INTERRUPTED") await save({ closed: status });
      });
      settled = true;
      return report(status);
    } finally {
      if (!settled) await finishIntake(this.database, batchId, "interrupted");
    }
  }
}
