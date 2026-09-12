import { lookup } from "node:dns/promises";
import type { ConnectionDependencies } from "../network/connection.js";
import {
  createAgentTransport,
  type AgentTransportOptions,
} from "../network/http.js";
import type { Resolver } from "../network/policy.js";
import { NetworkBudgetCoordinator } from "../network/budget.js";
import type { OrdinaryConfiguration } from "../configuration/index.js";
import {
  ArxivPdfSource,
  DirectPdfSource,
  DoiLandingSource,
  ConfiguredSciHubSource,
  EuropePmcPdfSource,
  PublicAcquisitionRegistry,
  UnpaywallSource,
  type AcquisitionSourcePort,
  type PublicAcquisitionTransport,
} from "./sources/public.js";
import { AuthorizedPdfSource } from "./sources/public.js";
import {
  CoreAuthorizedPdfClient,
  ElsevierAuthorizedPdfClient,
  WileyAuthorizedPdfClient,
  type AuthorizedTransport,
  type AuthorizedProvider,
} from "./providers/authorized.js";
import {
  bundlePreview,
  issueProviderCredentialGrant,
  readProviderCredential,
  type CredentialBundle,
} from "../configuration/credentials.js";

export interface PublicAcquisitionAssemblyOptions {
  readonly resolver?: Resolver;
  readonly connection?: ConnectionDependencies;
  readonly credentials?: CredentialBundle;
  readonly authorizedTransportFactory?: (
    provider: AuthorizedProvider,
    origin: string,
  ) => AuthorizedTransport;
}

const ORIGINS = Object.freeze({
  unpaywall: "https://api.unpaywall.org",
  core: "https://api.core.ac.uk",
  elsevier: "https://api.elsevier.com",
  wiley: "https://api.wiley.com",
});

export const BUILTIN_SCI_HUB_MIRROR_URLS = Object.freeze([
  "https://sci-hub.ru",
  "https://sci-hub.kr",
] as const);

const AUTO_ACQUISITION_SOURCES = Object.freeze([
  "arxiv",
  "europe-pmc",
] as const);

function originParts(value: string): {
  readonly scheme: "https";
  readonly hostname: string;
  readonly port: number;
} {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new TypeError("acquisition source origin is invalid");
  return {
    scheme: "https",
    hostname: url.hostname,
    port: Number(url.port || 443),
  };
}

function unpaywallTransport(
  coordinator: NetworkBudgetCoordinator,
  options: PublicAcquisitionAssemblyOptions,
): PublicAcquisitionTransport {
  const origin = ORIGINS.unpaywall;
  const transportOptions: AgentTransportOptions = {
    resolver:
      options.resolver ??
      (async (hostname) =>
        (await lookup(hostname, { all: true })).map((item) => item.address)),
    policy: {
      allowed_schemes: ["https"],
      allowed_classes: ["public"],
      allowed_origins: [originParts(origin)],
      allowed_ports: [{ scheme: "https", port: 443 }],
    },
    coordinator,
    scope: "acquisition-unpaywall",
    limits: {
      maxConcurrency: 1,
      maxHostConcurrency: 1,
      maxResponseBytes: 2 * 1024 * 1024,
      maxRedirects: 0,
      maxRetries: 1,
    },
    ...(options.connection ? { connection: options.connection } : {}),
  };
  const request = createAgentTransport(transportOptions);
  return {
    async request(url, requestOptions = {}) {
      const response = await request({
        endpoint: url,
        headers: [
          ["accept", "application/json"],
          ...Object.entries(requestOptions.headers ?? {}),
        ],
        body: new Uint8Array(),
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
      if (response.status < 200 || response.status >= 300)
        throw new Error("acquisition source request failed");
      try {
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(response.body),
        ) as unknown;
      } catch {
        throw new Error("acquisition source response is invalid");
      }
    },
  };
}

function authorizedTransport(
  provider: AuthorizedProvider,
  origin: string,
  coordinator: NetworkBudgetCoordinator,
  options: PublicAcquisitionAssemblyOptions,
): AuthorizedTransport {
  const injected = options.authorizedTransportFactory?.(provider, origin);
  if (injected) return injected;
  const request = createAgentTransport({
    resolver:
      options.resolver ??
      (async (hostname) =>
        (await lookup(hostname, { all: true })).map((item) => item.address)),
    policy: {
      allowed_schemes: ["https"],
      allowed_classes: ["public"],
      allowed_origins: [originParts(origin)],
      allowed_ports: [{ scheme: "https", port: 443 }],
    },
    coordinator,
    scope: `acquisition-${provider}`,
    limits: {
      maxConcurrency: 1,
      maxHostConcurrency: 1,
      maxResponseBytes: 64 * 1024 * 1024,
      maxRedirects: 0,
      maxRetries: 1,
    },
    ...(options.connection ? { connection: options.connection } : {}),
  });
  return {
    request: async (url, requestOptions = {}) =>
      request({
        endpoint: url,
        headers: Object.entries(requestOptions.headers ?? {}),
        body: new Uint8Array(),
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      }),
  };
}

function sourceCredential(
  credentials: CredentialBundle,
  provider: AuthorizedProvider,
  field: string,
): string | null {
  const section = bundlePreview(credentials).sections.find(
    (item) => item.section === provider,
  );
  if (!section?.fields.some((item) => item.field === field && item.present))
    return null;
  const grant = issueProviderCredentialGrant(credentials, provider, field);
  return readProviderCredential(credentials, grant, provider, field);
}

/** Assemble the public locator sources without probing or enabling sci-hub. */
export function assemblePublicAcquisitionRegistry(
  configuration: Pick<OrdinaryConfiguration, "sources">,
  coordinator: NetworkBudgetCoordinator,
  options: PublicAcquisitionAssemblyOptions = {},
): PublicAcquisitionRegistry {
  const selection = configuration.sources.acquisition;
  const selected =
    selection.mode === "auto" ? AUTO_ACQUISITION_SOURCES : selection.providers;
  const sources: AcquisitionSourcePort[] = [new DirectPdfSource()];
  const unavailable: Record<string, string> = {};
  const credentials = options.credentials;
  for (const name of selected) {
    if (name === "arxiv") sources.push(new ArxivPdfSource());
    else if (name === "europe-pmc") sources.push(new EuropePmcPdfSource());
    else if (name === "unpaywall") {
      const configured = configuration.sources.acquisition.unpaywall;
      if (!configured) unavailable[name] = "missing-ordinary-parameter";
      else {
        const contact = configured.contact_email;
        if (typeof contact !== "string")
          throw new TypeError("Unpaywall contact email is invalid");
        sources.push(
          new UnpaywallSource(unpaywallTransport(coordinator, options), {
            email: contact,
          }),
        );
      }
    } else if (name === "sci-hub") {
      const configured = configuration.sources.acquisition.sci_hub;
      const urls = configured?.urls ?? BUILTIN_SCI_HUB_MIRROR_URLS;
      if (!Array.isArray(urls) || urls.some((item) => typeof item !== "string"))
        throw new TypeError("configured sci-hub URLs are invalid");
      sources.push(new ConfiguredSciHubSource(urls as readonly string[]));
    } else if (name === "core" || name === "elsevier" || name === "wiley") {
      if (!credentials) {
        unavailable[name] = "missing-credential";
        continue;
      }
      const field = name === "wiley" ? "tdm_api_token" : "api_key";
      const credential = sourceCredential(credentials, name, field);
      if (!credential) {
        unavailable[name] = "missing-credential";
        continue;
      }
      const client =
        name === "core"
          ? new CoreAuthorizedPdfClient(
              authorizedTransport(name, ORIGINS.core, coordinator, options),
              credential,
            )
          : name === "elsevier"
            ? new ElsevierAuthorizedPdfClient(
                authorizedTransport(
                  name,
                  ORIGINS.elsevier,
                  coordinator,
                  options,
                ),
                credential,
                sourceCredential(credentials, name, "institution_token"),
              )
            : new WileyAuthorizedPdfClient(
                authorizedTransport(name, ORIGINS.wiley, coordinator, options),
                credential,
              );
      sources.push(new AuthorizedPdfSource(client));
    } else unavailable[name] = "missing-source-adapter";
  }
  sources.push(new DoiLandingSource());
  return new PublicAcquisitionRegistry(
    sources,
    ["direct", ...selected, "doi-landing"],
    unavailable,
  );
}
