import { outboundEgress } from "../configuration/egress.js";
import { lookup } from "node:dns/promises";
import {
  bundlePreview,
  issueProviderCredentialGrant,
  readProviderCredential,
  type CredentialBundle,
  type CurrentCredentialReader,
} from "../configuration/credentials.js";
import type { OrdinaryConfiguration } from "../configuration/index.js";
import type { NetworkBudgetCoordinator } from "../network/budget.js";
import type { ConnectionDependencies } from "../network/connection.js";
import { createAgentTransport } from "../network/http.js";
import type { Resolver } from "../network/policy.js";
import { ArxivRestAdapter } from "../providers/arxiv/metadata.js";
import { CoreRestAdapter } from "../providers/core/metadata.js";
import { CrossrefRestAdapter } from "../providers/crossref/metadata.js";
import { DataCiteRestAdapter } from "../providers/datacite/metadata.js";
import { ElsevierRestAdapter } from "../providers/elsevier/metadata.js";
import { EuropePmcRestAdapter } from "../providers/europe-pmc/metadata.js";
import { OpenAlexRestAdapter } from "../providers/openalex/metadata.js";
import { OpenCitationsRestAdapter } from "../providers/opencitations/metadata.js";
import {
  LITERATURE_PROVIDERS,
  METADATA_PROVIDER_NAMES,
  metadataService,
  PROVIDER_SERVICES,
} from "../providers/registry.js";
import { SemanticScholarRestAdapter } from "../providers/semantic-scholar/metadata.js";
import {
  METADATA_HTTP_TIMEOUT_MS,
  requestMetadataResponse,
  type MetadataTransport,
} from "../providers/shared/metadata-transport.js";
import { SpringerRestAdapter } from "../providers/springer/metadata.js";
import {
  WebOfScienceExpandedRestAdapter,
  WebOfScienceStarterRestAdapter,
} from "../providers/web-of-science/metadata.js";
import type {
  MetadataLookupPort,
  ReferenceQueryPort,
  TopicSearchPort,
} from "./ports.js";
import { MetadataProviderFailure } from "./ports.js";
import {
  buildMetadataRegistry,
  configuredMetadataSelections,
  METADATA_CAPABILITIES,
  type MetadataCapability,
  type MetadataRegistry,
} from "./registry.js";
import { hasMetadataRateLimitHandling } from "./service.js";

type ProviderName = string;

export interface MetadataAssemblyOptions {
  /** A bounded single-use owner (for example a source probe) can cancel every adapter request. */
  readonly signal?: AbortSignal;
  readonly maxRetries?: 0 | 1;
  readonly resolver?: Resolver;
  readonly connection?: ConnectionDependencies;
  /** Configuration owner re-reads the credential file before each provider request. */
  readonly currentCredential?: CurrentCredentialReader;
  /** Offline tests may inject the same bounded provider transport contract. */
  readonly transportFactory?: (
    provider: ProviderName,
    origin: string,
  ) => MetadataTransport;
}

const ORIGINS: Readonly<Record<string, string>> = Object.fromEntries(
  METADATA_PROVIDER_NAMES.filter((name) => name !== "web-of-science").map(
    (name) => [name, metadataService(name).endpoint],
  ),
);
const CREDENTIAL_HEADERS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = Object.fromEntries(
  Object.entries(LITERATURE_PROVIDERS).map(([name, value]) => [
    name,
    value.metadataHeaders ?? {},
  ]),
);
const REQUIRED_METADATA_CREDENTIALS = Object.entries(
  LITERATURE_PROVIDERS,
).flatMap(([provider, value]) =>
  value.requiredMetadataCredential
    ? [
        {
          provider,
          field: value.requiredMetadataCredential,
          header: value.metadataHeaders?.[value.requiredMetadataCredential],
        },
      ]
    : [],
);

function assertRequiredMetadataCredential(
  provider: ProviderName,
  headers: Readonly<Record<string, string>>,
  query: readonly (readonly [string, string])[],
): void {
  const required = REQUIRED_METADATA_CREDENTIALS.find(
    (item) => item.provider === provider,
  );
  if (
    !required ||
    (required.header
      ? headers[required.header] !== undefined
      : query.some(([field]) => field === required.field))
  )
    return;
  throw new MetadataProviderFailure({
    code: "metadata-provider-credential-unavailable",
    reason:
      "The metadata provider's required credential is missing or revoked.",
    action: "Restore the required provider credential and retry.",
    retryable: false,
  });
}

function originParts(value: string): {
  readonly scheme: "https";
  readonly hostname: string;
  readonly port: number;
} {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new TypeError("metadata provider origin is invalid");
  return {
    scheme: "https",
    hostname: url.hostname,
    port: Number(url.port || 443),
  };
}

function credentialFields(
  credentials: CredentialBundle,
  provider: ProviderName,
): readonly string[] {
  return (
    bundlePreview(credentials).sections.find(
      (section) => section.section === provider,
    )?.fields ?? []
  ).flatMap((field) => (field.present ? [field.field] : []));
}

function providerCredentialHeaders(
  credentials: CredentialBundle,
  provider: ProviderName,
): Readonly<Record<string, string>> {
  const mapping = CREDENTIAL_HEADERS[provider] ?? {};
  const result: Record<string, string> = {};
  for (const field of credentialFields(credentials, provider)) {
    const header = mapping[field];
    if (!header) continue;
    const grant = issueProviderCredentialGrant(credentials, provider, field);
    const value = readProviderCredential(credentials, grant, provider, field);
    result[header] = header === "authorization" ? `Bearer ${value}` : value;
  }
  return result;
}

function providerCredentialQuery(
  credentials: CredentialBundle,
  provider: ProviderName,
): readonly (readonly [string, string])[] {
  const result: [string, string][] = [];
  for (const [field, parameter] of Object.entries(
    LITERATURE_PROVIDERS[provider]?.metadataQuery ?? {},
  )) {
    if (!credentialFields(credentials, provider).includes(field)) continue;
    const grant = issueProviderCredentialGrant(credentials, provider, field);
    result.push([
      parameter,
      readProviderCredential(credentials, grant, provider, field),
    ]);
  }
  return result;
}

async function currentProviderCredentialHeaders(
  provider: ProviderName,
  options: MetadataAssemblyOptions,
): Promise<Readonly<Record<string, string>>> {
  const mapping = CREDENTIAL_HEADERS[provider] ?? {};
  const result: Record<string, string> = {};
  for (const [field, header] of Object.entries(mapping)) {
    const value = await options.currentCredential?.({
      namespace: "provider",
      provider,
      field,
      origin: null,
      operation: "provider-request",
    });
    if (value !== null && value !== undefined)
      result[header] = header === "authorization" ? `Bearer ${value}` : value;
  }
  return result;
}

async function currentProviderCredentialQuery(
  provider: ProviderName,
  options: MetadataAssemblyOptions,
): Promise<readonly (readonly [string, string])[]> {
  const result: [string, string][] = [];
  for (const [field, parameter] of Object.entries(
    LITERATURE_PROVIDERS[provider]?.metadataQuery ?? {},
  )) {
    const value = await options.currentCredential?.({
      namespace: "provider",
      provider,
      field,
      origin: null,
      operation: "provider-request",
    });
    if (value !== null && value !== undefined) result.push([parameter, value]);
  }
  return result;
}

function providerTransport(
  provider: ProviderName,
  baseUrl: string,
  credentials: CredentialBundle,
  coordinator: NetworkBudgetCoordinator,
  options: MetadataAssemblyOptions,
  network: OrdinaryConfiguration["network"],
): MetadataTransport {
  const expectedOrigin = new URL(baseUrl).origin;
  const injected = options.transportFactory?.(provider, expectedOrigin);
  const raw = injected
    ? null
    : createAgentTransport({
        egress: outboundEgress(
          network,
          { kind: "source", id: provider },
          credentials,
          options.currentCredential,
        ),
        resolver:
          options.resolver ??
          (async (hostname) =>
            (await lookup(hostname, { all: true })).map(
              (item) => item.address,
            )),
        policy: {
          allowed_schemes: ["https"],
          allowed_classes: ["public"],
          allowed_origins: [originParts(expectedOrigin)],
          allowed_ports: [
            { scheme: "https", port: Number(new URL(baseUrl).port || 443) },
          ],
        },
        coordinator,
        scope: metadataService(provider, baseUrl).quotaGroup,
        resolveAccess: (url) => {
          const service = metadataService(provider, url);
          return { scope: service.quotaGroup, limits: service.policy };
        },
        limits: {
          ...metadataService(provider, baseUrl).policy,
          maxHostConcurrency: 2,
          maxResponseBytes: 4_194_304,
          maxRedirects: 0,
          maxRetries: options.maxRetries ?? 1,
        },
        ...(options.connection ? { connection: options.connection } : {}),
      });
  return {
    async request(url, requestOptions = {}) {
      if (new URL(url).origin !== expectedOrigin)
        throw new Error("metadata provider changed origin");
      const signal =
        options.signal && requestOptions.signal
          ? AbortSignal.any([options.signal, requestOptions.signal])
          : (options.signal ?? requestOptions.signal);
      const headers = {
        ...(requestOptions.headers ?? {}),
        ...(options.currentCredential
          ? await currentProviderCredentialHeaders(provider, options)
          : providerCredentialHeaders(credentials, provider)),
      };
      const credentialQuery = options.currentCredential
        ? await currentProviderCredentialQuery(provider, options)
        : providerCredentialQuery(credentials, provider);
      assertRequiredMetadataCredential(provider, headers, credentialQuery);
      if (injected)
        return injected.request(
          credentialQuery.length
            ? (() => {
                const target = new URL(url);
                for (const [name, value] of credentialQuery)
                  target.searchParams.append(name, value);
                return target.toString();
              })()
            : url,
          {
            ...requestOptions,
            headers,
            ...(signal ? { signal } : {}),
          },
        );
      return requestMetadataResponse(
        raw!,
        {
          endpoint: url,
          method: "GET",
          timeout_ms: METADATA_HTTP_TIMEOUT_MS,
          ...(hasMetadataRateLimitHandling()
            ? { retry_rate_limited: false as const }
            : {}),
          headers: Object.entries({
            accept:
              LITERATURE_PROVIDERS[provider]?.metadataFormat === "atom"
                ? "application/atom+xml"
                : "application/json",
            ...headers,
          }),
          body: new Uint8Array(),
          ...(credentialQuery.length
            ? { credential_query: credentialQuery }
            : {}),
          ...(signal ? { signal } : {}),
        },
        LITERATURE_PROVIDERS[provider]?.metadataFormat === "atom"
          ? "atom"
          : "json",
        metadataService(provider, url).policy.quotaHeaders,
      );
    },
  };
}

/** Build all production adapters once; selection remains a separate local fact. */
export function assembleMetadataRegistry(
  configuration: OrdinaryConfiguration,
  credentials: CredentialBundle,
  coordinator: NetworkBudgetCoordinator,
  options: MetadataAssemblyOptions = {},
): MetadataRegistry {
  const topics: TopicSearchPort[] = [];
  const lookups: MetadataLookupPort[] = [];
  const references: ReferenceQueryPort[] = [];
  const add = (
    adapter: TopicSearchPort & MetadataLookupPort & Partial<ReferenceQueryPort>,
    includeReference = false,
  ) => {
    topics.push(adapter);
    lookups.push(adapter);
    if (includeReference && typeof adapter.open_reference_query === "function")
      references.push(adapter as ReferenceQueryPort);
  };
  const transport = (provider: ProviderName, base: string) =>
    providerTransport(
      provider,
      base,
      credentials,
      coordinator,
      options,
      configuration.network,
    );

  const crossref = configuration.sources.metadata.crossref as {
    readonly mode?: string;
    readonly mailto?: string | null;
  } | null;
  add(
    new CrossrefRestAdapter({
      transport: transport("crossref", metadataService("crossref").endpoint),
      origin: metadataService("crossref").endpoint,
      mailto: crossref?.mode === "polite" ? (crossref.mailto ?? null) : null,
    }),
  );
  add(
    new SemanticScholarRestAdapter({
      transport: transport(
        "semantic-scholar",
        metadataService("semantic-scholar").endpoint,
      ),
      origin: metadataService("semantic-scholar").endpoint,
    }),
    true,
  );
  add(
    new ArxivRestAdapter({
      transport: transport("arxiv", metadataService("arxiv").endpoint),
      origin: metadataService("arxiv").endpoint,
    }),
  );
  add(
    new OpenAlexRestAdapter({
      transport: transport("openalex", metadataService("openalex").endpoint),
      origin: metadataService("openalex").endpoint,
    }),
    true,
  );
  add(
    new EuropePmcRestAdapter({
      transport: transport(
        "europe-pmc",
        metadataService("europe-pmc").endpoint,
      ),
      origin: metadataService("europe-pmc").endpoint,
    }),
    true,
  );
  add(
    new DataCiteRestAdapter({
      transport: transport("datacite", metadataService("datacite").endpoint),
      origin: metadataService("datacite").endpoint,
    }),
    true,
  );
  add(
    new CoreRestAdapter({
      transport: transport("core", metadataService("core").endpoint),
      origin: metadataService("core").endpoint,
    }),
    true,
  );
  lookups.push(
    new OpenCitationsRestAdapter({
      transport: transport(
        "opencitations",
        metadataService("opencitations").endpoint,
      ),
      origin: metadataService("opencitations").endpoint,
    }),
  );
  references.push(
    new OpenCitationsRestAdapter({
      transport: transport(
        "opencitations",
        metadataService("opencitations").endpoint,
      ),
      origin: metadataService("opencitations").endpoint,
    }),
  );
  add(
    new ElsevierRestAdapter({
      transport: transport("elsevier", metadataService("elsevier").endpoint),
      origin: metadataService("elsevier").endpoint,
    }),
  );
  add(
    new SpringerRestAdapter({
      transport: transport("springer", metadataService("springer").endpoint),
      origin: metadataService("springer").endpoint,
    }),
  );

  const web = configuration.sources.metadata.web_of_science as {
    readonly product?: "starter" | "expanded";
    readonly database?: string;
    readonly edition?: string | null;
  } | null;
  if (web) {
    const base =
      web.product === "expanded"
        ? PROVIDER_SERVICES["wos-expanded"]!.endpoint
        : PROVIDER_SERVICES["wos-starter"]!.endpoint;
    const webOptions = {
      transport: transport("web-of-science", base),
      origin: base,
      ...(web.database ? { database: web.database } : {}),
      ...(web.edition ? { edition: web.edition } : {}),
    };
    add(
      web.product === "expanded"
        ? new WebOfScienceExpandedRestAdapter(webOptions)
        : new WebOfScienceStarterRestAdapter(webOptions),
      web.product === "expanded",
    );
  }

  const readiness: Record<string, string | null> = {};
  if (!web) readiness["web-of-science"] = "configuration-missing";
  for (const { provider, field } of REQUIRED_METADATA_CREDENTIALS)
    if (!credentialFields(credentials, provider).includes(field))
      readiness[provider] = "credential-missing";
  const capabilities: Record<string, readonly MetadataCapability[]> = {
    ...METADATA_CAPABILITIES,
  };
  if (web?.product === "expanded")
    capabilities["web-of-science"] = [
      ...(METADATA_CAPABILITIES["web-of-science"] ?? []),
      "reference-query",
    ];
  // The origins above are the only endpoints an explicit read-only probe may
  // report; an unconfigured Web of Science stays null instead of guessing.
  const endpoints: Record<string, string | null> = { ...ORIGINS };
  endpoints["web-of-science"] =
    web?.product === "expanded"
      ? PROVIDER_SERVICES["wos-expanded"]!.endpoint
      : web
        ? PROVIDER_SERVICES["wos-starter"]!.endpoint
        : null;
  const registry = buildMetadataRegistry({
    topic_search_ports: topics,
    lookup_ports: lookups,
    reference_query_ports: references,
    readiness,
    endpoints,
    capabilities,
  });
  const selected = configuredMetadataSelections(
    configuration,
    capabilities,
    Object.keys(capabilities).filter((provider) =>
      LITERATURE_PROVIDERS[provider]?.requiredMetadataCredential
        ? credentialFields(credentials, provider).includes(
            LITERATURE_PROVIDERS[provider]!.requiredMetadataCredential!,
          )
        : credentialFields(credentials, provider).length > 0,
    ),
  );
  return Object.freeze({
    ...registry,
    topic_selection: selected.topic,
    reference_selection: selected.reference,
    lookup_selection: selected.lookup,
  });
}
