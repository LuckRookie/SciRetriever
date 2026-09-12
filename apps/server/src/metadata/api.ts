import type { ProviderLiteratureKey } from "@sciretriever/contracts";
import { MetadataService } from "./service.js";
import type {
  MetadataBatchResult,
  MetadataLookupRequest,
  MetadataProviderInvocation,
  MetadataProviderResult,
  MetadataReferenceQueryRequest,
  TopicSearchQuery,
} from "./ports.js";

export class MetadataApi {
  constructor(private readonly service: MetadataService) {}
  searchTopic(
    providers: readonly {
      readonly provider_name: string;
      readonly scan_limit: number;
    }[],
    query: TopicSearchQuery,
    signal?: AbortSignal,
  ): Promise<MetadataBatchResult> {
    return this.service.searchTopic(providers, query, signal);
  }
  searchTopicProvider(
    provider: string,
    query: TopicSearchQuery,
    scan_limit: number,
    signal?: AbortSignal,
  ): Promise<MetadataProviderInvocation> {
    return this.service.searchTopicProvider(
      provider,
      query,
      scan_limit,
      signal,
    );
  }
  lookup(
    request: MetadataLookupRequest,
    signal?: AbortSignal,
  ): Promise<MetadataProviderResult> {
    return this.service.lookup(request, signal);
  }
  queryReferences(
    request: MetadataReferenceQueryRequest,
    signal?: AbortSignal,
  ): Promise<MetadataBatchResult> {
    return this.service.queryReferences(request, signal);
  }
  /** Explicit key helper keeps provider key construction at the API boundary. */
  static key(
    record_id: string | null,
    identifiers: readonly { namespace: string; value: string }[],
  ): ProviderLiteratureKey {
    if (record_id === null && !identifiers.length)
      throw new TypeError("metadata key is empty");
    return Object.freeze({
      record_id,
      identifiers: Object.freeze([...identifiers]),
    });
  }
}
