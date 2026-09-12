import { lookup } from "node:dns/promises";
import type { ConnectionDependencies } from "../network/connection.js";
import { createAgentTransport } from "../network/http.js";
import type { Resolver } from "../network/policy.js";
import type { NetworkBudgetCoordinator } from "../network/budget.js";
import type { OrdinaryConfiguration } from "../configuration/index.js";
import {
  bundlePreview,
  issueProviderCredentialGrant,
  readProviderCredential,
  type CredentialBundle,
} from "../configuration/credentials.js";
import type { MetadataTransport } from "./providers.js";
import { CrossrefRestAdapter } from "./crossref.js";
import { SemanticScholarRestAdapter } from "./semantic-scholar.js";
import { ArxivRestAdapter } from "./arxiv.js";
import { OpenAlexRestAdapter } from "./openalex.js";
import { EuropePmcRestAdapter } from "./europe-pmc.js";
import { DataCiteRestAdapter } from "./datacite.js";
import { CoreRestAdapter } from "./core.js";
import { OpenCitationsRestAdapter } from "./opencitations.js";
import { ElsevierRestAdapter } from "./elsevier.js";
import { SpringerRestAdapter } from "./springer.js";
import {
  WebOfScienceExpandedRestAdapter,
  WebOfScienceStarterRestAdapter,
} from "./web-of-science.js";
import {
  buildMetadataRegistry,
  configuredMetadataSelections,
  METADATA_CAPABILITIES,
  type MetadataCapability,
  type MetadataRegistry,
} from "./registry.js";
import type {
  MetadataLookupPort,
  ReferenceQueryPort,
  TopicSearchPort,
} from "./ports.js";

type ProviderName =
  | "web-of-science"
  | "crossref"
  | "semantic-scholar"
  | "arxiv"
  | "openalex"
  | "europe-pmc"
  | "elsevier"
  | "springer"
  | "datacite"
  | "core"
  | "opencitations";

export interface MetadataAssemblyOptions {
  readonly resolver?: Resolver;
  readonly connection?: ConnectionDependencies;
  /** Offline tests may inject the same bounded provider transport contract. */
  readonly transportFactory?: (
    provider: ProviderName,
    origin: string,
  ) => MetadataTransport;
}

const ORIGINS: Readonly<
  Record<Exclude<ProviderName, "web-of-science">, string>
> = {
  crossref: "https://api.crossref.org",
  "semantic-scholar": "https://api.semanticscholar.org/graph/v1",
  arxiv: "https://export.arxiv.org/api/query",
  openalex: "https://api.openalex.org",
  "europe-pmc": "https://www.ebi.ac.uk/europepmc/webservices/rest",
  elsevier: "https://api.elsevier.com",
  springer: "https://api.springernature.com/meta/v2/json",
  datacite: "https://api.datacite.org",
  core: "https://api.core.ac.uk",
  opencitations: "https://api.opencitations.net",
};

const CREDENTIAL_HEADERS: Readonly<
  Partial<Record<ProviderName, Readonly<Record<string, string>>>>
> = {
  "web-of-science": { api_key: "x-apikey" },
  "semantic-scholar": { api_key: "x-api-key" },
  elsevier: {
    api_key: "x-els-apikey",
    institution_token: "x-els-insttoken",
  },
  core: { api_key: "authorization" },
  opencitations: { access_token: "authorization" },
};

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
    result[header] =
      header === "authorization"
        ? `${provider === "core" ? "Bearer" : "Bearer"} ${value}`
        : value;
  }
  return result;
}

function providerCredentialQuery(
  credentials: CredentialBundle,
  provider: ProviderName,
): readonly (readonly [string, string])[] {
  if (
    provider !== "springer" ||
    !credentialFields(credentials, provider).includes("api_key")
  )
    return [];
  const grant = issueProviderCredentialGrant(credentials, provider, "api_key");
  return [
    [
      "api_key",
      readProviderCredential(credentials, grant, provider, "api_key"),
    ],
  ];
}

function providerTransport(
  provider: ProviderName,
  baseUrl: string,
  credentials: CredentialBundle,
  coordinator: NetworkBudgetCoordinator,
  options: MetadataAssemblyOptions,
): MetadataTransport {
  const expectedOrigin = new URL(baseUrl).origin;
  const injected = options.transportFactory?.(provider, expectedOrigin);
  const raw = injected
    ? null
    : createAgentTransport({
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
        scope: `metadata-${provider}`,
        limits: {
          maxConcurrency: 2,
          maxHostConcurrency: 2,
          maxResponseBytes: 4_194_304,
          maxRedirects: 0,
          maxRetries: 1,
        },
        ...(options.connection ? { connection: options.connection } : {}),
      });
  return {
    async request(url, requestOptions = {}) {
      if (new URL(url).origin !== expectedOrigin)
        throw new Error("metadata provider changed origin");
      const headers = {
        ...(requestOptions.headers ?? {}),
        ...providerCredentialHeaders(credentials, provider),
      };
      const credentialQuery = providerCredentialQuery(credentials, provider);
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
          },
        );
      const response = await raw!({
        endpoint: url,
        headers: Object.entries({
          accept:
            provider === "arxiv" ? "application/atom+xml" : "application/json",
          ...headers,
        }),
        body: new Uint8Array(),
        ...(credentialQuery.length
          ? { credential_query: credentialQuery }
          : {}),
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
      if (response.status < 200 || response.status >= 300)
        throw new Error("metadata HTTP request failed");
      if (provider === "arxiv") return response.body;
      try {
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(response.body),
        ) as unknown;
      } catch {
        throw new Error("metadata JSON response is invalid");
      }
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
    providerTransport(provider, base, credentials, coordinator, options);

  const crossref = configuration.sources.metadata.crossref as {
    readonly mode?: string;
    readonly mailto?: string | null;
  } | null;
  add(
    new CrossrefRestAdapter({
      transport: transport("crossref", ORIGINS.crossref),
      origin: ORIGINS.crossref,
      mailto: crossref?.mode === "polite" ? (crossref.mailto ?? null) : null,
    }),
  );
  add(
    new SemanticScholarRestAdapter({
      transport: transport("semantic-scholar", ORIGINS["semantic-scholar"]),
      origin: ORIGINS["semantic-scholar"],
    }),
    true,
  );
  add(
    new ArxivRestAdapter({
      transport: transport("arxiv", ORIGINS.arxiv),
      origin: ORIGINS.arxiv,
    }),
  );
  add(
    new OpenAlexRestAdapter({
      transport: transport("openalex", ORIGINS.openalex),
      origin: ORIGINS.openalex,
    }),
    true,
  );
  add(
    new EuropePmcRestAdapter({
      transport: transport("europe-pmc", ORIGINS["europe-pmc"]),
      origin: ORIGINS["europe-pmc"],
    }),
    true,
  );
  add(
    new DataCiteRestAdapter({
      transport: transport("datacite", ORIGINS.datacite),
      origin: ORIGINS.datacite,
    }),
    true,
  );
  add(
    new CoreRestAdapter({
      transport: transport("core", ORIGINS.core),
      origin: ORIGINS.core,
    }),
    true,
  );
  lookups.push(
    new OpenCitationsRestAdapter({
      transport: transport("opencitations", ORIGINS.opencitations),
      origin: ORIGINS.opencitations,
    }),
  );
  references.push(
    new OpenCitationsRestAdapter({
      transport: transport("opencitations", ORIGINS.opencitations),
      origin: ORIGINS.opencitations,
    }),
  );
  add(
    new ElsevierRestAdapter({
      transport: transport("elsevier", ORIGINS.elsevier),
      origin: ORIGINS.elsevier,
    }),
  );
  add(
    new SpringerRestAdapter({
      transport: transport("springer", ORIGINS.springer),
      origin: ORIGINS.springer,
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
        ? "https://wos-api.clarivate.com/api/wos"
        : "https://api.clarivate.com/apis/wos-starter/v2";
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
  for (const provider of ["elsevier", "springer", "web-of-science"] as const)
    if (!credentialFields(credentials, provider).includes("api_key"))
      readiness[provider] = "credential-missing";
  const capabilities: Record<string, readonly MetadataCapability[]> = {
    ...METADATA_CAPABILITIES,
  };
  if (web?.product === "expanded")
    capabilities["web-of-science"] = [
      ...(METADATA_CAPABILITIES["web-of-science"] ?? []),
      "reference-query",
    ];
  const registry = buildMetadataRegistry({
    topic_search_ports: topics,
    lookup_ports: lookups,
    reference_query_ports: references,
    readiness,
    capabilities,
  });
  const selected = configuredMetadataSelections(configuration, capabilities);
  return Object.freeze({
    ...registry,
    topic_selection: selected.topic,
    reference_selection: selected.reference,
  });
}
