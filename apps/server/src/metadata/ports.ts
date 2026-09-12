import type {
  MetadataObservation,
  ProviderLiteratureKey,
  StableFailure,
} from "@sciretriever/contracts";

export type ReferenceQueryDirection = "references" | "cited-by" | "both";
export type ProviderOutcome = "EXHAUSTED" | "SCAN_LIMIT_REACHED" | "FAILED";
export type ProviderInvocationOutcome = ProviderOutcome | "INTERRUPTED";

export interface TopicSearchQuery {
  readonly query: string;
  readonly year_from: number | null;
  readonly year_to: number | null;
}
export interface MetadataLookupRequest {
  readonly provider_name: string;
  readonly key: ProviderLiteratureKey;
  readonly scan_limit: number;
}
export interface ProviderReferenceQuery {
  readonly provider_name: string;
  readonly keys: readonly ProviderLiteratureKey[];
  readonly scan_limit: number;
}
export interface MetadataReferenceQueryRequest {
  readonly direction: ReferenceQueryDirection;
  readonly providers: readonly ProviderReferenceQuery[];
}
export interface ReferenceQueryContext {
  readonly keys: readonly ProviderLiteratureKey[];
  readonly direction: ReferenceQueryDirection;
}

export interface ProviderRelationEndpoint {
  readonly record_id: string | null;
  readonly identifiers: readonly { namespace: string; value: string }[];
}
export interface ProviderRelationObservation {
  readonly observation_id: string;
  readonly provenance: MetadataObservation["provenance"];
  readonly citing: ProviderRelationEndpoint;
  readonly cited: ProviderRelationEndpoint;
}
export interface NeutralMetadataItem {
  readonly observations: readonly MetadataObservation[];
  readonly relations: readonly ProviderRelationObservation[];
  readonly empty_reason?: string;
}
export interface RawItemDelivery {
  readonly raw_item: unknown;
  readonly source_exhausted_after: boolean;
}
export interface RawItemSession {
  pull_raw_item(): RawItemDelivery | null | Promise<RawItemDelivery | null>;
  convert_raw_item(
    raw_item: unknown,
  ): NeutralMetadataItem | Promise<NeutralMetadataItem>;
}
export interface TopicSearchPort {
  readonly provider_name: string;
  open_topic_search(
    query: TopicSearchQuery,
  ): RawItemSession | Promise<RawItemSession>;
}
export interface MetadataLookupPort {
  readonly provider_name: string;
  open_lookup(
    key: ProviderLiteratureKey,
  ): RawItemSession | Promise<RawItemSession>;
}
export interface ReferenceQueryPort {
  readonly provider_name: string;
  open_reference_query(
    query: ReferenceQueryContext,
  ): RawItemSession | Promise<RawItemSession>;
}

export class MetadataProviderFailure extends Error {
  readonly code = "metadata-provider" as const;
  constructor(readonly failure: StableFailure) {
    super("metadata provider call failed");
    this.name = "MetadataProviderFailure";
  }
}

export interface MetadataProviderInvocation {
  readonly provider_name: string;
  readonly observations: readonly MetadataObservation[];
  readonly relations: readonly ProviderRelationObservation[];
  readonly raw_item_count: number;
  readonly outcome: ProviderInvocationOutcome;
  readonly failure: StableFailure | null;
}
export interface MetadataProviderResult
  extends Omit<MetadataProviderInvocation, "outcome"> {
  readonly outcome: ProviderOutcome;
}
export interface MetadataBatchResult {
  readonly providers: readonly MetadataProviderResult[];
}

export function topicSearchQuery(
  query: string,
  year_from: number | null = null,
  year_to: number | null = null,
): TopicSearchQuery {
  const normalized = query.normalize("NFC").trim();
  if (
    !normalized ||
    (year_from !== null &&
      (!Number.isSafeInteger(year_from) ||
        year_from < 1 ||
        year_from > 9999)) ||
    (year_to !== null &&
      (!Number.isSafeInteger(year_to) || year_to < 1 || year_to > 9999)) ||
    (year_from !== null && year_to !== null && year_from > year_to)
  )
    throw new TypeError("invalid topic search query");
  return Object.freeze({ query: normalized, year_from, year_to });
}
