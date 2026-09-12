import { randomUUID } from "node:crypto";
import {
  parseReference,
  type ProviderLiteratureKey,
  type StableFailure,
} from "@sciretriever/contracts";
import {
  topicSearchQuery,
  type MetadataProviderInvocation,
} from "../metadata/ports.js";
import type { MetadataService } from "../metadata/service.js";
import type { LiteratureIdentityService } from "../literature/identity.js";
import type { ObservationRepository } from "../storage/sqlite/repositories.js";
import type { ReferenceRepository } from "../storage/sqlite/repositories.js";
import {
  type DiscoveryPublication,
  type SqliteWorker,
} from "../storage/sqlite/worker.js";

export interface TopicDiscoveryRequest {
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
  terminal: "SCAN_LIMIT_REACHED" | "FAILED" | null;
  failure: StableFailure | null;
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
    state.terminal = "FAILED";
    state.failure =
      invocation.failure ?? providerFailure("The citation provider failed.");
  } else if (
    invocation.outcome === "SCAN_LIMIT_REACHED" ||
    state.raw_item_count === state.scan_limit
  ) {
    state.terminal = "SCAN_LIMIT_REACHED";
  }
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
      let invocation: MetadataProviderInvocation;
      try {
        invocation = await this.metadata.searchTopicProvider(
          provider.provider_name,
          query,
          provider.scan_limit,
          request.signal,
        );
      } catch {
        sourceResults.push({
          provider_name: provider.provider_name,
          outcome: "FAILED",
          failure: providerFailure(
            "The metadata provider could not complete discovery.",
          ),
        });
        continue;
      }
      if (invocation.outcome === "INTERRUPTED") {
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
        const decision = await this.identity.observe(observation);
        if (decision.disposition !== "accepted" || !decision.literature_id)
          continue;
        accepted += decision.created ? 1 : 0;
        matched += decision.created ? 0 : 1;
        const literature = await this.database.getLiterature(
          decision.literature_id,
        );
        if (!literature)
          throw new Error("discovery identity refers to missing Literature");
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
        terminal: null,
        failure: null,
      });
    }
    const seeds = [...new Set(request.seed_literature_ids)];
    const frontier = new Map<string, number>(seeds.map((id) => [id, 0]));
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
        const key: ProviderLiteratureKey = {
          record_id: null,
          identifiers: source.metadata.identifiers,
        };
        for (const provider of request.providers) {
          const state = states.get(provider.provider_name)!;
          if (state.terminal !== null) continue;
          if (request.signal?.aborted) {
            interrupted = true;
            break;
          }
          let invocation: MetadataProviderInvocation;
          try {
            invocation = await this.metadata.queryReferencesProvider(
              { direction: request.direction, providers: [provider] },
              provider.provider_name,
              [key],
              state.scan_limit - state.raw_item_count,
              request.signal,
            );
          } catch {
            state.terminal = "FAILED";
            state.failure = providerFailure(
              "The citation provider could not complete expansion.",
            );
            continue;
          }
          if (invocation.outcome === "INTERRUPTED") {
            interrupted = true;
            break;
          }
          consumeCitationInvocation(state, invocation);
          for (const relation of invocation.relations) {
            await this.observations.publishProviderRelation(relation);
            const sourceMatches = relation.citing.identifiers.some((item) =>
              key.identifiers.some(
                (candidate) =>
                  candidate.namespace === item.namespace &&
                  candidate.value === item.value,
              ),
            );
            const citedMatches = relation.cited.identifiers.some((item) =>
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
            let targetLiterature = local[0] ?? null;
            if (!targetLiterature) {
              if (state.terminal !== null) continue;
              let lookup: MetadataProviderInvocation;
              try {
                lookup = await this.metadata.lookupProvider(
                  {
                    provider_name: provider.provider_name,
                    key: targetKey,
                    scan_limit: state.scan_limit - state.raw_item_count,
                  },
                  request.signal,
                );
              } catch {
                state.terminal = "FAILED";
                state.failure = providerFailure(
                  "The citation provider could not resolve a relation target.",
                );
                continue;
              }
              if (lookup.outcome === "INTERRUPTED") {
                interrupted = true;
                break;
              }
              consumeCitationInvocation(state, lookup);
              const targetObservation = lookup.observations[0];
              if (!targetObservation) continue;
              const decision = await this.identity.observe(targetObservation);
              if (
                decision.disposition !== "accepted" ||
                !decision.literature_id
              )
                continue;
              targetLiterature = await this.database.getLiterature(
                decision.literature_id,
              );
            }
            if (!targetLiterature) continue;
            const edgeSource = outgoing
              ? sourceId
              : targetLiterature.literature_id;
            const edgeTarget = outgoing
              ? targetLiterature.literature_id
              : sourceId;
            if (edgeSource === edgeTarget) continue;
            const edgeKey = `${edgeSource}\u0000${edgeTarget}`;
            if (seenEdges.has(edgeKey)) continue;
            seenEdges.add(edgeKey);
            const referenceId = randomUUID();
            await this.references.publish(
              parseReference({
                reference_id: referenceId,
                source_literature_id: edgeSource,
                target_literature_id: edgeTarget,
              }),
            );
            await this.references.supportWithProviderObservation(
              referenceId,
              relation.observation_id,
            );
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
            if (depth + 1 < request.max_depth)
              frontier.set(targetLiterature.literature_id, depth + 1);
            if (results.size >= request.result_limit) break;
          }
        }
      }
    }
    const sourceResults: Array<DiscoveryPublication["source_results"][number]> =
      request.providers.map((provider) => {
        const state = states.get(provider.provider_name)!;
        return {
          provider_name: provider.provider_name,
          outcome: state.terminal ?? "EXHAUSTED",
          failure: state.failure,
        };
      });
    const status: CitationDiscoveryReport["status"] = interrupted
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
