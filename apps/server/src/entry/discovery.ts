import { randomUUID } from "node:crypto";
import {
  parseReference,
  parseLiteratureDetail,
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
import type { MetadataScanEvent } from "../metadata/ports.js";
import type { LiteratureIdentityService } from "../literature/identity.js";
import type { ObservationRepository } from "../storage/sqlite/repositories.js";
import type { ReferenceRepository } from "../storage/sqlite/repositories.js";
import {
  type DiscoveryPublication,
  type SqliteWorker,
} from "../storage/sqlite/worker.js";

export interface TopicDiscoveryRequest {
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
  readonly source_run?: MetadataSourceRun;
  readonly seed_literature_ids: readonly string[];
  readonly direction: "references" | "cited-by" | "both";
  readonly max_depth: number;
  readonly result_limit: number;
  readonly providers: readonly {
    readonly provider_name: string;
    readonly scan_limit: number;
  }[];
  readonly signal?: AbortSignal;
}
export interface CitationDiscoveryReport {
  readonly discovery_run_id: string;
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

interface CitationProviderState {
  readonly provider_name: string;
  readonly scan_limit: number;
  raw_item_count: number;
  attempted: boolean;
  terminal: "SCAN_LIMIT_REACHED" | "FAILED" | null;
  failure: StableFailure | null;
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
  const remaining = state.scan_limit - state.raw_item_count;
  if (invocation.raw_item_count < 0 || invocation.raw_item_count > remaining)
    throw new Error("citation provider exceeded its run scan limit");
  state.raw_item_count += invocation.raw_item_count;
  if (invocation.outcome === "FAILED") {
    recordCitationFailure(
      state,
      invocation.failure ?? providerFailure("The citation provider failed."),
    );
  }
  if (state.raw_item_count === state.scan_limit) {
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

export class TopicDiscoveryService {
  constructor(
    private readonly metadata: MetadataService,
    private readonly identity: LiteratureIdentityService,
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
    const results = new Map<string, { meta_literature_id: string }>();
    const topicCauses: Array<DiscoveryPublication["topic_causes"][number]> = [];
    const sourceResults: Array<DiscoveryPublication["source_results"][number]> =
      [];
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
      for (const relation of invocation.relations) {
        await this.observations.publishProviderRelation(relation);
      }
      for (const observation of invocation.observations) {
        const year = observation.metadata.publication_year;
        if (
          (query.year_from !== null || query.year_to !== null) &&
          (year === null ||
            (query.year_from !== null && year < query.year_from) ||
            (query.year_to !== null && year > query.year_to))
        ) {
          await progress?.rejected();
          continue;
        }
        const decision = await this.identity.observe(observation);
        if (decision.disposition !== "accepted" || !decision.literature_id) {
          await progress?.rejected();
          continue;
        }
        accepted += decision.created ? 1 : 0;
        matched += decision.created ? 0 : 1;
        const literature = await this.database.getLiterature(
          decision.literature_id,
        );
        if (!literature)
          throw new Error("discovery identity refers to missing Literature");
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
      }
      if (invocation.failure) await progress?.failure(invocation.failure.code);
      else
        await progress?.finish(invocation.raw_item_count > 0 ? "hit" : "miss");
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
    return Object.freeze({
      discovery_run_id: runId,
      status,
      accepted_count: accepted,
      matched_count: matched,
      source_results: Object.freeze(sourceResults),
    });
  }
}

/** A bounded breadth-first citation expansion using the same metadata and identity owners. */
export class CitationDiscoveryService {
  constructor(
    private readonly metadata: MetadataService,
    private readonly identity: LiteratureIdentityService,
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
      !Number.isSafeInteger(request.result_limit) ||
      request.result_limit < 1
    )
      throw new TypeError("citation bounds are invalid");
    if (!Array.isArray(request.providers) || request.providers.length === 0)
      throw new TypeError("citation providers must be non-empty");
    const states = new Map<string, CitationProviderState>();
    for (const provider of request.providers) {
      if (
        !provider.provider_name.trim() ||
        states.has(provider.provider_name) ||
        !Number.isSafeInteger(provider.scan_limit) ||
        provider.scan_limit < 1
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
    const frontier = new Map<string, number>(seeds.map((id) => [id, 0]));
    const visited = new Set(seeds);
    const runId = randomUUID();
    const seenEdges = new Set<string>();
    const results = new Map<string, { meta_literature_id: string }>();
    const causes: Array<DiscoveryPublication["citation_causes"][number]> = [];
    let interrupted = request.signal?.aborted ?? false;
    while (
      frontier.size &&
      !interrupted &&
      results.size < request.result_limit
    ) {
      const current = [...frontier.entries()];
      frontier.clear();
      for (const [sourceId, depth] of current) {
        if (depth >= request.max_depth || results.size >= request.result_limit)
          continue;
        const source = await this.database.getLiterature(sourceId);
        if (!source) throw new Error("citation seed Literature was not found");
        // Provider-native record IDs can be required even when a DOI is known
        // (for example, a provider's reverse-citation query). Keep both forms.
        const snapshot = await this.database.literatureDetailSnapshot(sourceId);
        const sourceObservations = snapshot
          ? (await parseLiteratureDetail(snapshot.detail)).metadata_observations
          : [];
        for (const provider of request.providers) {
          if (results.size >= request.result_limit || interrupted) break;
          const state = states.get(provider.provider_name)!;
          if (state.terminal !== null) continue;
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
          let sourceFailure: StableFailure | null = null,
            referenceListProvided = false;
          let complete = false;
          let usableRelations = 0;
          let incomplete = false;
          let stream: AsyncGenerator<MetadataScanEvent>;
          state.attempted = true;
          try {
            stream = this.metadata.streamReferencesProvider(
              request.direction,
              provider.provider_name,
              [key],
              state.scan_limit - state.raw_item_count,
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
            await progress?.failure(failure.code, error);
            recordCitationFailure(state, failure);
            continue;
          }
          for await (const event of progress
            ? progress.stream(stream)
            : stream) {
            if (event.kind === "end") {
              if (event.outcome === "INTERRUPTED" || request.signal?.aborted)
                interrupted = true;
              if (event.failure && !interrupted) {
                sourceFailure ??= event.failure;
                recordCitationFailure(state, event.failure);
                incomplete = true;
              }
              complete = event.outcome === "EXHAUSTED";
              break;
            }
            state.raw_item_count += 1;
            await progress?.returned(1);
            if (request.signal?.aborted) {
              interrupted = true;
              break;
            }
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
                  const accepted = await this.database.getLiterature(
                    decision.literature_id,
                  );
                  if (accepted)
                    await progress?.observed(
                      accepted.meta_literature_id,
                      decision.created,
                    );
                }
              }
            for (const relation of event.item.relations) {
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
                ? await this.database.findLiteratureByIdentifiers(
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
              const inline = event.item.observations.filter((observation) =>
                observationMatches(
                  observation,
                  provider.provider_name,
                  targetKey,
                ),
              );
              for (const observation of inline) {
                const decision = await this.identity.observe(observation);
                if (
                  decision.disposition === "accepted" &&
                  decision.literature_id
                ) {
                  targetLiterature = await this.database.getLiterature(
                    decision.literature_id,
                  );
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
                    lookupState.raw_item_count >= lookupState.scan_limit
                  )
                    continue;
                  const lookupKey =
                    candidate === provider
                      ? targetKey
                      : { record_id: null, identifiers: targetKey.identifiers };
                  if (!lookupKey.record_id && !lookupKey.identifiers.length)
                    continue;
                  let lookup: MetadataProviderInvocation;
                  const lookupProgress = await request.source_run?.begin(
                    candidate.provider_name,
                    "lookup",
                    sourceId + ":" + relation.observation_id,
                    "supporting",
                  );
                  lookupState.attempted = true;
                  try {
                    const invoke = () =>
                      this.metadata.lookupProvider(
                        {
                          provider_name: candidate.provider_name,
                          key: lookupKey,
                          scan_limit: 1,
                        },
                        request.signal,
                      );
                    lookup = lookupProgress
                      ? await lookupProgress.run(invoke)
                      : await invoke();
                  } catch (error) {
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
                  const decision =
                    await this.identity.observe(targetObservation);
                  if (
                    decision.disposition !== "accepted" ||
                    !decision.literature_id
                  ) {
                    await lookupProgress?.rejected();
                    await lookupProgress?.finish("hit");
                    continue;
                  }
                  targetLiterature = await this.database.getLiterature(
                    decision.literature_id,
                  );
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
                if (state.raw_item_count < state.scan_limit)
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
              if (seenEdges.has(edgeKey)) continue;
              seenEdges.add(edgeKey);
              if (seeds.includes(targetLiterature.literature_id)) continue;
              results.set(targetLiterature.meta_literature_id, {
                meta_literature_id: targetLiterature.meta_literature_id,
              });
              causes.push({
                meta_literature_id: targetLiterature.meta_literature_id,
                source_literature_id: edgeSource,
                target_literature_id: edgeTarget,
                actual_literature_id: targetLiterature.literature_id,
                depth: depth + 1,
              });
              if (
                depth + 1 < request.max_depth &&
                !visited.has(targetLiterature.literature_id)
              ) {
                visited.add(targetLiterature.literature_id);
                frontier.set(targetLiterature.literature_id, depth + 1);
              }
              if (results.size >= request.result_limit) break;
            }
            if (
              state.raw_item_count >= state.scan_limit &&
              state.terminal === null
            )
              state.terminal = "SCAN_LIMIT_REACHED";
            if (
              interrupted ||
              state.terminal !== null ||
              results.size >= request.result_limit
            )
              break;
          }
          if (interrupted) await progress?.finish("cancelled");
          else if (sourceFailure) await progress?.failure(sourceFailure.code);
          else await progress?.finish(referenceListProvided ? "hit" : "miss");
          // Exhaust this source's pages first. Empty, partial or unresolved
          // responses fall through; success short-circuits only this node.
          if (complete && usableRelations > 0 && !incomplete) break;
        }
      }
    }
    if (request.signal?.aborted) interrupted = true;
    const sourceResults: Array<DiscoveryPublication["source_results"][number]> =
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
    const status: CitationDiscoveryReport["status"] = interrupted
      ? "INTERRUPTED"
      : sourceResults.length > 0 &&
          results.size === 0 &&
          sourceResults.every((item) => item.outcome === "FAILED")
        ? "FAILED"
        : sourceResults.some((item) => item.outcome === "FAILED")
          ? "PARTIAL"
          : "COMPLETED";
    await this.database.putDiscovery({
      run: {
        discovery_run_id: runId,
        kind: "citation",
        status,
        started_at: new Date().toISOString(),
        direction: request.direction,
        max_depth: request.max_depth,
        result_limit: request.result_limit,
        seed_literature_ids: seeds,
      },
      providers: request.providers,
      source_results: sourceResults,
      results: [...results.values()],
      topic_causes: [],
      citation_causes: causes,
    });
    return Object.freeze({
      discovery_run_id: runId,
      status,
      result_count: results.size,
      source_results: Object.freeze(sourceResults),
    });
  }
}
