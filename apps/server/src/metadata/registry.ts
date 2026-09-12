import { MetadataService } from "./service.js";
import type {
  MetadataLookupPort,
  ReferenceQueryPort,
  TopicSearchPort,
} from "./ports.js";
import type {
  OrdinaryConfiguration,
  SourceMode,
} from "../configuration/index.js";

export type MetadataCapability = "topic-search" | "lookup" | "reference-query";
export const METADATA_PROVIDER_ORDER = Object.freeze([
  "web-of-science",
  "crossref",
  "semantic-scholar",
  "arxiv",
  "openalex",
  "europe-pmc",
  "elsevier",
  "springer",
  "datacite",
  "core",
  "opencitations",
] as const);
export interface MetadataProviderStatus {
  readonly provider_name: string;
  readonly capabilities: readonly MetadataCapability[];
  readonly production_available: boolean;
  readonly ready: boolean;
  readonly failure_code: string | null;
}
export interface MetadataRegistry {
  readonly service: MetadataService;
  readonly statuses: readonly MetadataProviderStatus[];
  readonly topic_selection: readonly string[];
  readonly reference_selection: readonly string[];
}

export const METADATA_AUTO_PROVIDERS = Object.freeze([
  "crossref",
  "semantic-scholar",
  "arxiv",
  "openalex",
  "europe-pmc",
  "datacite",
  "core",
] as const);

/** Resolve source order locally; readiness and network state never rewrite it. */
export function resolveMetadataSelection(
  selection: {
    readonly mode: SourceMode;
    readonly providers: readonly string[];
  },
  capability: MetadataCapability,
  capabilities: Readonly<
    Record<string, readonly MetadataCapability[]>
  > = CAPABILITIES,
): readonly string[] {
  const values =
    selection.mode === "auto" ? METADATA_AUTO_PROVIDERS : selection.providers;
  const eligible = new Set<string>(
    METADATA_PROVIDER_ORDER.filter((provider) =>
      capabilities[provider]?.includes(capability),
    ),
  );
  return Object.freeze(values.filter((provider) => eligible.has(provider)));
}

export function configuredMetadataSelections(
  configuration: Pick<OrdinaryConfiguration, "sources">,
  capabilities: Readonly<
    Record<string, readonly MetadataCapability[]>
  > = CAPABILITIES,
): {
  readonly topic: readonly string[];
  readonly reference: readonly string[];
} {
  const topic = resolveMetadataSelection(
    configuration.sources.metadata,
    "topic-search",
    capabilities,
  );
  const reference = resolveMetadataSelection(
    configuration.sources.metadata,
    "reference-query",
    capabilities,
  );
  return Object.freeze({ topic, reference });
}

const CAPABILITIES: Readonly<Record<string, readonly MetadataCapability[]>> = {
  "web-of-science": ["topic-search", "lookup"],
  crossref: ["topic-search", "lookup"],
  "semantic-scholar": ["topic-search", "lookup", "reference-query"],
  arxiv: ["topic-search", "lookup"],
  openalex: ["topic-search", "lookup", "reference-query"],
  "europe-pmc": ["topic-search", "lookup", "reference-query"],
  elsevier: ["topic-search", "lookup"],
  springer: ["topic-search", "lookup"],
  datacite: ["topic-search", "lookup", "reference-query"],
  core: ["topic-search", "lookup", "reference-query"],
  opencitations: ["lookup", "reference-query"],
};

/**
 * Assemble only explicitly supplied adapters. Missing adapters remain visible
 * as unavailable status; registry construction never guesses a provider or
 * performs a probe/network request.
 */
export function buildMetadataRegistry(
  options: {
    readonly topic_search_ports?: readonly TopicSearchPort[];
    readonly lookup_ports?: readonly MetadataLookupPort[];
    readonly reference_query_ports?: readonly ReferenceQueryPort[];
    readonly readiness?: Readonly<Record<string, string | null>>;
    readonly capabilities?: Readonly<
      Record<string, readonly MetadataCapability[]>
    >;
  } = {},
): MetadataRegistry {
  const topicNames = new Set(
    (options.topic_search_ports ?? []).map((item) => item.provider_name),
  );
  const lookupNames = new Set(
    (options.lookup_ports ?? []).map((item) => item.provider_name),
  );
  const referenceNames = new Set(
    (options.reference_query_ports ?? []).map((item) => item.provider_name),
  );
  const capabilities = options.capabilities ?? CAPABILITIES;
  const statuses = METADATA_PROVIDER_ORDER.map((provider_name) => {
    const providerCapabilities = capabilities[provider_name] ?? [];
    const available = providerCapabilities.every((capability) =>
      capability === "topic-search"
        ? topicNames.has(provider_name)
        : capability === "lookup"
          ? lookupNames.has(provider_name)
          : referenceNames.has(provider_name),
    );
    const readinessFailure = options.readiness?.[provider_name] ?? null;
    return Object.freeze({
      provider_name,
      capabilities: Object.freeze([...providerCapabilities]),
      production_available: available,
      ready: available && readinessFailure === null,
      failure_code: !available
        ? "missing-production-adapter"
        : readinessFailure,
    });
  });
  const selection = Object.freeze({
    topic: Object.freeze(
      METADATA_AUTO_PROVIDERS.filter((provider) => topicNames.has(provider)),
    ),
    reference: Object.freeze(
      METADATA_PROVIDER_ORDER.filter((provider) =>
        referenceNames.has(provider),
      ),
    ),
  });
  return Object.freeze({
    service: new MetadataService(options),
    statuses: Object.freeze(statuses),
    topic_selection: selection.topic,
    reference_selection: selection.reference,
  });
}

export const METADATA_CAPABILITIES = CAPABILITIES;
