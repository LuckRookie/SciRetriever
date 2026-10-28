import type {
  MetadataObservation,
  ProviderLiteratureKey,
  StableFailure,
} from "@sciretriever/contracts";
import {
  MetadataProviderFailure,
  type MetadataBatchResult,
  type MetadataLookupPort,
  type MetadataLookupRequest,
  type MetadataProviderInvocation,
  type MetadataProviderResult,
  type MetadataReferenceQueryRequest,
  type MetadataScanEvent,
  type NeutralMetadataItem,
  type ProviderRelationObservation,
  type RawItemSession,
  type ReferenceQueryContext,
  type ReferenceQueryPort,
  type TopicSearchPort,
  type TopicSearchQuery,
} from "./ports.js";

function providerName(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (!normalized) throw new TypeError("provider name must be nonblank");
  return normalized;
}
function failure(code: string): StableFailure {
  if (code === "metadata-provider-unexpected")
    return {
      code,
      reason: "The metadata provider session failed unexpectedly.",
      action: "Retry the request or inspect the provider adapter.",
      retryable: true,
    };
  return {
    code,
    reason: "The metadata provider returned an invalid record.",
    action: "Retry the request or update the provider adapter.",
    retryable: true,
  };
}
function overlap(
  left: ProviderLiteratureKey,
  right: ProviderLiteratureKey,
): boolean {
  return (
    (left.record_id !== null && left.record_id === right.record_id) ||
    left.identifiers.some((candidate) =>
      right.identifiers.some(
        (other) =>
          candidate.namespace === other.namespace &&
          candidate.value === other.value,
      ),
    )
  );
}
function relationMatches(
  relation: ProviderRelationObservation,
  query: ReferenceQueryContext,
): boolean {
  const citing = query.keys.some((key) => overlap(key, relation.citing));
  const cited = query.keys.some((key) => overlap(key, relation.cited));
  return query.direction === "references"
    ? citing
    : query.direction === "cited-by"
      ? cited
      : citing || cited;
}

async function* scanItems(
  provider_name: string,
  scan_limit: number,
  open: () => RawItemSession | Promise<RawItemSession>,
  signal?: AbortSignal,
  referenceQuery?: ReferenceQueryContext,
): AsyncGenerator<MetadataScanEvent> {
  if (!Number.isSafeInteger(scan_limit) || scan_limit < 1)
    throw new TypeError("scan_limit must be positive");
  let raw_item_count = 0;
  let firstFailure: StableFailure | null = null;
  if (signal?.aborted) {
    yield {
      kind: "end",
      provider_name,
      raw_item_count,
      outcome: "INTERRUPTED",
      failure: null,
    };
    return;
  }
  try {
    const session = await open();
    while (raw_item_count < scan_limit) {
      if (signal?.aborted) {
        yield {
          kind: "end",
          provider_name,
          raw_item_count,
          outcome: "INTERRUPTED",
          failure: null,
        };
        return;
      }
      const delivery = await session.pull_raw_item();
      if (delivery === null) break;
      raw_item_count += 1;
      try {
        const item: NeutralMetadataItem = await session.convert_raw_item(
          delivery.raw_item,
        );
        if (
          !item ||
          !Array.isArray(item.observations) ||
          !Array.isArray(item.relations)
        )
          throw new MetadataProviderFailure(
            failure("metadata-provider-protocol"),
          );
        if (
          referenceQuery &&
          item.relations.some(
            (relation) => !relationMatches(relation, referenceQuery),
          )
        )
          throw new MetadataProviderFailure(
            failure("metadata-reference-direction"),
          );
        yield { kind: "item", item, failure: null };
      } catch (error) {
        const detail =
          error instanceof MetadataProviderFailure
            ? error.failure
            : failure("metadata-record-invalid");
        firstFailure ??= detail;
        yield {
          kind: "item",
          item: { observations: [], relations: [] },
          failure: detail,
        };
      }
      if (delivery.source_exhausted_after) break;
    }
  } catch (error) {
    const detail =
      error instanceof MetadataProviderFailure
        ? error.failure
        : failure("metadata-provider-unexpected");
    yield {
      kind: "end",
      provider_name,
      raw_item_count,
      outcome: "FAILED",
      failure: detail,
    };
    return;
  }
  const normal: MetadataProviderResult["outcome"] =
    raw_item_count >= scan_limit ? "SCAN_LIMIT_REACHED" : "EXHAUSTED";
  yield {
    kind: "end",
    provider_name,
    raw_item_count,
    outcome: signal?.aborted ? "INTERRUPTED" : firstFailure ? "FAILED" : normal,
    failure: firstFailure,
  };
}

async function scan(
  ...args: Parameters<typeof scanItems>
): Promise<MetadataProviderInvocation> {
  return collectScan(scanItems(...args));
}
async function collectScan(
  stream: AsyncGenerator<MetadataScanEvent>,
  onItem?: () => Promise<void>,
): Promise<MetadataProviderInvocation> {
  const observations: MetadataObservation[] = [];
  const relations: ProviderRelationObservation[] = [];
  for await (const event of stream) {
    if (event.kind === "end") {
      return {
        provider_name: event.provider_name,
        raw_item_count: event.raw_item_count,
        outcome: event.outcome,
        failure: event.failure,
        observations,
        relations,
      };
    }
    await onItem?.();
    observations.push(...event.item.observations);
    relations.push(...event.item.relations);
  }
  throw new Error("metadata scan ended without a provider outcome");
}

export class MetadataService {
  private readonly readiness: Readonly<Record<string, string | null>>;
  private readonly topics: ReadonlyMap<string, TopicSearchPort>;
  private readonly lookups: ReadonlyMap<string, MetadataLookupPort>;
  private readonly references: ReadonlyMap<string, ReferenceQueryPort>;
  constructor(
    options: {
      readonly topic_search_ports?: readonly TopicSearchPort[];
      readonly lookup_ports?: readonly MetadataLookupPort[];
      readonly reference_query_ports?: readonly ReferenceQueryPort[];
      readonly readiness?: Readonly<Record<string, string | null>>;
    } = {},
  ) {
    this.readiness = options.readiness ?? {};
    this.topics = this.index(options.topic_search_ports ?? []);
    this.lookups = this.index(options.lookup_ports ?? []);
    this.references = this.index(options.reference_query_ports ?? []);
  }
  private requirePort<T>(provider: string, port: T | undefined): T {
    const missing = this.readiness[provider];
    if (missing || !port)
      throw new MetadataProviderFailure({
        code: missing
          ? `metadata-source-${missing}`
          : "metadata-source-unavailable",
        reason: "The selected metadata source is unavailable in this process.",
        action: "Review the source configuration and adapter readiness.",
        retryable: false,
      });
    return port;
  }
  private index<T extends { readonly provider_name: string }>(
    values: readonly T[],
  ): ReadonlyMap<string, T> {
    const result = new Map<string, T>();
    for (const value of values) {
      const name = providerName(value.provider_name);
      if (result.has(name)) throw new TypeError("duplicate provider port");
      result.set(name, value);
    }
    return result;
  }
  async searchTopicProvider(
    provider: string,
    query: TopicSearchQuery,
    scan_limit: number,
    signal?: AbortSignal,
    onItem?: () => Promise<void>,
  ): Promise<MetadataProviderInvocation> {
    const port = this.requirePort(
      providerName(provider),
      this.topics.get(providerName(provider)),
    );
    return collectScan(
      scanItems(
        providerName(provider),
        scan_limit,
        () => port.open_topic_search(query),
        signal,
      ),
      onItem,
    );
  }
  async searchTopic(
    providers: readonly {
      readonly provider_name: string;
      readonly scan_limit: number;
    }[],
    query: TopicSearchQuery,
    signal?: AbortSignal,
  ): Promise<MetadataBatchResult> {
    const results: MetadataProviderResult[] = [];
    for (const item of providers) {
      const invocation = await this.searchTopicProvider(
        item.provider_name,
        query,
        item.scan_limit,
        signal,
      );
      if (invocation.outcome === "INTERRUPTED")
        throw new Error("metadata batch was interrupted");
      results.push(invocation as MetadataProviderResult);
    }
    return Object.freeze({ providers: Object.freeze(results) });
  }
  async lookupProvider(
    request: MetadataLookupRequest,
    signal?: AbortSignal,
    onItem?: () => Promise<void>,
  ): Promise<MetadataProviderInvocation> {
    const provider = providerName(request.provider_name);
    const port = this.requirePort(provider, this.lookups.get(provider));
    return collectScan(
      scanItems(
        provider,
        request.scan_limit,
        () => port.open_lookup(request.key),
        signal,
      ),
      onItem,
    );
  }
  async lookup(
    request: MetadataLookupRequest,
    signal?: AbortSignal,
  ): Promise<MetadataProviderResult> {
    const result = await this.lookupProvider(request, signal);
    if (result.outcome === "INTERRUPTED")
      throw new Error("metadata lookup was interrupted");
    return result as MetadataProviderResult;
  }
  async queryReferencesProvider(
    request: MetadataReferenceQueryRequest,
    provider: string,
    keys: readonly ProviderLiteratureKey[],
    scan_limit: number,
    signal?: AbortSignal,
  ): Promise<MetadataProviderInvocation> {
    const name = providerName(provider);
    const port = this.requirePort(name, this.references.get(name));
    const context: ReferenceQueryContext = {
      keys,
      direction: request.direction,
    };
    return scan(
      name,
      scan_limit,
      () => port.open_reference_query(context),
      signal,
      context,
    );
  }
  /** Keep conversion/counting here while Entry admits each relation before requesting more. */
  streamReferencesProvider(
    direction: ReferenceQueryContext["direction"],
    provider: string,
    keys: readonly ProviderLiteratureKey[],
    scan_limit: number,
    signal?: AbortSignal,
  ): AsyncGenerator<MetadataScanEvent> {
    const name = providerName(provider);
    const port = this.requirePort(name, this.references.get(name));
    const context: ReferenceQueryContext = { keys, direction };
    return scanItems(
      name,
      scan_limit,
      () => port.open_reference_query(context),
      signal,
      context,
    );
  }
  async queryReferences(
    request: MetadataReferenceQueryRequest,
    signal?: AbortSignal,
  ): Promise<MetadataBatchResult> {
    if (!request.providers.length)
      throw new TypeError("providers must be non-empty");
    const results: MetadataProviderResult[] = [];
    for (const item of request.providers) {
      const result = await this.queryReferencesProvider(
        request,
        item.provider_name,
        item.keys,
        item.scan_limit,
        signal,
      );
      if (result.outcome === "INTERRUPTED")
        throw new Error("metadata batch was interrupted");
      results.push(result as MetadataProviderResult);
    }
    return Object.freeze({ providers: Object.freeze(results) });
  }
}
