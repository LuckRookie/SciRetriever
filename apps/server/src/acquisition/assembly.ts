import { lookup } from "node:dns/promises";
import {
  bundlePreview,
  issueProviderCredentialGrant,
  readProviderCredential,
  type CredentialBundle,
  type CurrentCredentialReader,
} from "../configuration/credentials.js";
import type { OrdinaryConfiguration } from "../configuration/index.js";
import { NetworkBudgetCoordinator } from "../network/budget.js";
import type { ConnectionDependencies } from "../network/connection.js";
import {
  createAgentTransport,
  requestFollowingRedirects,
  type AgentTransportOptions,
} from "../network/http.js";
import type { Resolver } from "../network/policy.js";
import { ArxivPdfSource } from "../providers/arxiv/acquisition.js";
import { CoreAuthorizedPdfClient } from "../providers/core/acquisition.js";
import { ElsevierAuthorizedPdfClient } from "../providers/elsevier/acquisition.js";
import { EuropePmcPdfSource } from "../providers/europe-pmc/acquisition.js";
import {
  AUTO_ACQUISITION_SOURCES,
  LITERATURE_PROVIDERS,
  acquisitionService,
  publicWebService,
} from "../providers/registry.js";
import { ConfiguredSciHubSource } from "../providers/sci-hub/acquisition.js";
import { BUILTIN_SCI_HUB_MIRROR_URLS } from "../providers/sci-hub/definition.js";
import {
  AuthorizedProviderError,
  type AuthorizedProvider,
  type AuthorizedTransport,
} from "../providers/shared/authorized-pdf.js";
import { UnpaywallSource } from "../providers/unpaywall/acquisition.js";
import { WileyAuthorizedPdfClient } from "../providers/wiley/acquisition.js";
import {
  type AcquisitionSourcePort,
  type AcquisitionSourceRequest,
  type PublicAcquisitionTransport,
} from "./ports.js";
import type { SourceCandidate } from "./sources/locators.js";
import {
  AuthorizedPdfSource,
  DirectPdfSource,
  DoiLandingSource,
  PublicAcquisitionRegistry,
  type PdfDownloadTransport,
} from "./sources/public.js";
import {
  AcquisitionRouteError,
  AcquisitionUnavailableError,
} from "./tiered.js";
export { BUILTIN_SCI_HUB_MIRROR_URLS } from "../providers/sci-hub/definition.js";

export interface PublicAcquisitionAssemblyOptions {
  readonly resolver?: Resolver;
  readonly connection?: ConnectionDependencies;
  readonly credentials?: CredentialBundle;
  /** Configuration owner re-reads the selected provider credential before each API request. */
  readonly currentCredential?: CurrentCredentialReader;
  readonly authorizedTransportFactory?: (
    provider: AuthorizedProvider,
    origin: string,
  ) => AuthorizedTransport;
  /** Offline source seam for the DOI landing boundary; production uses its real adapter. */
  readonly doiLandingSource?: AcquisitionSourcePort;
  /**
   * Production controlled-Browser route admission. Only Bootstrap may supply this,
   * and only when the operator explicitly enabled Browser. It carries no credential,
   * Cookie, page, profile or process handle; the registry records the frozen state
   * without probing or launching anything.
   *
   * The locator registry keeps the Browser marker outside its runnable batch. Entry's
   * `PdfAcquisitionPort` owns the subsequent process-scoped delivery through Candidate
   * Intake and identity acceptance, so a Browser document never falls back to the
   * credential-free public transport or appears as an empty locator result that could
   * become a false durable exhaustion fact.
   */
  readonly browser_admission?: BrowserRouteAdmission;
}

/**
 * The controlled-Browser route name. It sits after every public source and
 * authorized provider API route, so the tier order stays Public -> API -> Browser.
 */
export const BROWSER_ROUTE_NAME = "browser";

/**
 * Stable reasons why the controlled-Browser route is absent from this process'
 * automatic route set. They are reported instead of silently dropping the route,
 * so a caller can tell "not wired" from "no candidate".
 */
export type BrowserRouteUnavailableReason =
  | "browser-disabled"
  | "browser-runtime-unavailable"
  | "browser-controlled-delivery-unavailable"
  | "browser-route-not-wired";

export interface BrowserRouteAdmission {
  /**
   * The operator's explicit Browser switch. It never implies the runtime is
   * available, and it never starts anything.
   */
  readonly enabled: boolean;
  /**
   * True only when the process can hand a Browser-acquired document to the durable
   * candidate spool inside the controlled Browser context. A Browser locator must
   * never fall back to the credential-free public HTTP transport: that would leak
   * the acquisition out of the admitted page session and send it outside the
   * Browser's own network stack.
   */
  readonly controlled_delivery: boolean;
  /**
   * Required whenever `enabled` is false or the runtime is unavailable. It becomes
   * the route's stable failure code in registry status reporting.
   */
  readonly unavailable_reason: BrowserRouteUnavailableReason | null;
}

/**
 * Controlled Browser acquisition handle. Delivering a Browser document is not an
 * empty route result: the tiered loop treats "no candidate" as a normal route end
 * and can then commit a durable exhaustion fact. A Browser delivery therefore has
 * to arrive as an accepted candidate (or a stable route failure) through the
 * ordinary candidate-publication boundary.
 *
 * Entry currently keeps this handle outside the locator-only tiered batch and invokes
 * the process-owned Browser session after the locator routes reach their permitted
 * terminal outcome. The type remains a narrow seam for Bootstrap/tests; no code path
 * can fake a successful delivery without Candidate Intake and identity acceptance.
 */
export interface BrowserAcquisitionHandle {
  /**
   * Run one bounded article flow inside the admitted Browser session and deliver the
   * resulting document into the durable candidate spool. Returns the transfer id
   * that the candidate acceptance path can consume.
   */
  deliverDocument(): Promise<{ readonly transfer_id: string }>;
}

/**
 * Browser tier as one more `AcquisitionSourcePort`. The route is structurally
 * incapable of claiming capability:
 *
 * 1. `ready` is always false. Controlled Browser delivery would have to arrive as an
 *    accepted candidate through the ordinary `download_candidate` path, which does not
 *    exist, so there is no state in which this tier can actually deliver.
 * 2. `discover` never contacts a Browser and never presents `[]`: an empty list reads
 *    as a normal route end and could let the caller commit a durable exhaustion fact
 *    even though an *applicable* route was never actually attempted. It fails closed
 *    with a stable non-retryable route error instead, so an enabled-but-unwired
 *    Browser tier stays an unresolved failure rather than silent exhaustion.
 *
 * Entry acquires one target per call and classifies an escaped error as that target's
 * failure, so this error never stops other targets and never becomes `exhausted`. A
 * disabled switch is a different case: the operator did not ask for the tier, so it is
 * not an applicable route and is not registered at all.
 */
class BrowserAcquisitionSource implements AcquisitionSourcePort {
  readonly source_name = BROWSER_ROUTE_NAME;
  constructor(readonly ready: boolean) {}

  async discover(
    request: AcquisitionSourceRequest,
    signal?: AbortSignal,
  ): Promise<readonly SourceCandidate[]> {
    // The Browser route ignores the request on purpose: a Browser document is not
    // expressed as a locator, so there is nothing to match against identifiers here.
    void request;
    void signal;
    throw new AcquisitionRouteError(
      "download-unavailable",
      "The controlled Browser route is unavailable in this process.",
      false,
    );
  }
}

/**
 * A selected low-risk/API route that has no runnable adapter in this process.
 *
 * `PublicAcquisitionRegistry` deliberately keeps such routes out of its ordinary
 * `sources` list so readiness/status callers can distinguish absence from a runnable
 * source. Entry's locator split must nevertheless preserve the unresolved state: if it
 * dropped the status, a target with a selected-but-unconfigured route could be reported
 * as normally exhausted and acquire a durable `needs_manual_pdf` fact. This marker is
 * therefore a non-retryable route failure, never a candidate and never a Browser-rescue
 * declaration.
 */
class UnavailableAcquisitionSource implements AcquisitionSourcePort {
  readonly ready = false;
  constructor(
    readonly source_name: string,
    private readonly reason: string,
    readonly acquisition_tier: "public" | "authorized-api" = "public",
  ) {}

  async discover(
    request: AcquisitionSourceRequest,
    signal?: AbortSignal,
  ): Promise<readonly SourceCandidate[]> {
    void request;
    void signal;
    throw new AcquisitionRouteError(
      "download-unavailable",
      `The configured ${this.source_name} route is unavailable: ${this.reason}.`,
      false,
    );
  }
}

/** Download public candidates and their redirects/static links through Network admission. */
export function assemblePublicPdfDownloadTransport(
  candidate: SourceCandidate,
  coordinator: NetworkBudgetCoordinator,
  options: Pick<
    PublicAcquisitionAssemblyOptions,
    "resolver" | "connection"
  > = {},
): PdfDownloadTransport {
  const target = new URL(candidate.locator);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.hash
  )
    throw new TypeError("public PDF candidate must use a safe HTTPS URL");
  const policy = {
    allowed_schemes: ["https"] as const,
    allowed_classes: ["public"] as const,
    allowed_ports: [
      { scheme: "https" as const, port: Number(target.port || 443) },
    ],
  };
  const resolver: Resolver =
    options.resolver ??
    (async (hostname) =>
      (await lookup(hostname, { all: true })).map((item) => item.address));
  const limits = {
    maxConcurrency: 1,
    maxHostConcurrency: 1,
    maxResponseBytes: 64 * 1024 * 1024,
    maxRedirects: 5,
    maxRetries: 0,
  };
  return {
    request: (url, requestOptions = {}) => {
      return requestFollowingRedirects(url, resolver, policy, {
        headers: [["accept", "application/pdf,text/html;q=0.8"]],
        body: new Uint8Array(),
        timeoutMs: 30_000,
        maxResponseBytes: limits.maxResponseBytes,
        maxRedirects: limits.maxRedirects,
        maxRetries: limits.maxRetries,
        ...(options.connection ? { connection: options.connection } : {}),
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        budget: {
          coordinator,
          scope: publicWebService(candidate.locator).quotaGroup,
          resolveAccess: (url) => {
            const service = publicWebService(url);
            return { scope: service.quotaGroup, limits: service.policy };
          },
          limits,
        },
      });
    },
  };
}

const ORIGINS = Object.freeze({
  unpaywall: acquisitionService("unpaywall").endpoint,
  core: acquisitionService("core").endpoint,
  elsevier: acquisitionService("elsevier").endpoint,
  wiley: acquisitionService("wiley").endpoint,
});

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
    scope: acquisitionService("unpaywall").quotaGroup,
    limits: {
      ...acquisitionService("unpaywall").policy,
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
      const endpoint = new URL(url);
      const contacts = endpoint.searchParams.getAll("email");
      if (contacts.length !== 1 || !contacts[0])
        throw new TypeError("Unpaywall contact email is required");
      endpoint.searchParams.delete("email");
      const response = await request({
        endpoint: endpoint.toString(),
        credential_query: [["email", contacts[0]]],
        method: "GET",
        headers: [
          ["accept", "application/json"],
          ...Object.entries(requestOptions.headers ?? {}),
        ],
        body: new Uint8Array(),
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
      const retryHint =
        response.retry_after_ms === undefined
          ? ""
          : ` Retry-After: ${response.retry_after_ms} ms.`;
      if (
        response.status === 429 ||
        response.retry_after_ms !== undefined ||
        response.headers.some(([name]) => name.toLowerCase() === "retry-after")
      )
        throw new AcquisitionRouteError(
          "rate-limited",
          `Unpaywall HTTP returned ${response.status} with a rate limit or Retry-After.${retryHint}`,
        );
      if ([204, 404, 410].includes(response.status))
        throw new AcquisitionUnavailableError(
          "download-unavailable",
          `Unpaywall HTTP returned ${response.status}; this DOI has no lookup entry.`,
          "not-applicable",
        );
      if (response.status < 200 || response.status >= 300)
        throw new AcquisitionRouteError(
          "http-response-failed",
          `Unpaywall HTTP returned ${response.status}; no location lookup was delivered.`,
          ![401, 403].includes(response.status),
        );
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
  const request = injected
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
          allowed_origins: [originParts(origin)],
          allowed_ports: [{ scheme: "https", port: 443 }],
        },
        coordinator,
        scope: acquisitionService(provider).quotaGroup,
        limits: {
          ...acquisitionService(provider).policy,
          maxHostConcurrency: 1,
          maxResponseBytes: 64 * 1024 * 1024,
          maxRedirects: 0,
          maxRetries: 1,
        },
        ...(options.connection ? { connection: options.connection } : {}),
      });
  const send: AuthorizedTransport = injected ?? {
    request: async (url, requestOptions = {}) => {
      const response = await request!({
        endpoint: url,
        method: "GET",
        headers: Object.entries(requestOptions.headers ?? {}),
        body: new Uint8Array(),
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
      return response;
    },
  };
  if (!options.currentCredential) return send;
  return {
    request: async (url, requestOptions = {}) => {
      if (new URL(url).origin !== new URL(origin).origin)
        throw new AuthorizedProviderError({ code: "response-schema" });
      const headers = { ...(requestOptions.headers ?? {}) };
      const definition = LITERATURE_PROVIDERS[provider]!;
      const mapping = definition.pdfHeaders ?? {};
      for (const name of Object.values(mapping))
        for (const key of Object.keys(headers))
          if (key.toLowerCase() === name) delete headers[key];
      try {
        for (const [field, header] of Object.entries(mapping)) {
          const value = await options.currentCredential!({
            namespace: "provider",
            provider,
            field,
            origin: null,
            operation: "provider-request",
          });
          if (value === null && field === definition.requiredPdfCredential)
            throw new AuthorizedProviderError({ code: "authentication" });
          if (value !== null)
            headers[header] =
              header === "authorization" ? `Bearer ${value}` : value;
        }
      } catch (error) {
        if (error instanceof AuthorizedProviderError) throw error;
        throw new AuthorizedProviderError({ code: "authentication" });
      }
      return send.request(url, {
        ...requestOptions,
        headers,
      });
    },
  };
}

const REQUEST_CREDENTIAL_PLACEHOLDER = "credential-resolved-at-dispatch";

function hasSourceCredential(
  credentials: CredentialBundle,
  provider: AuthorizedProvider,
  field: string,
): boolean {
  return (
    bundlePreview(credentials)
      .sections.find((section) => section.section === provider)
      ?.fields.some((item) => item.field === field && item.present) ?? false
  );
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
      const field = LITERATURE_PROVIDERS[name]!.requiredPdfCredential!;
      const available = hasSourceCredential(credentials, name, field);
      if (!available) {
        unavailable[name] = "missing-credential";
        continue;
      }
      const credential = options.currentCredential
        ? REQUEST_CREDENTIAL_PLACEHOLDER
        : sourceCredential(credentials, name, field)!;
      const institutionToken =
        name === "elsevier" && options.currentCredential
          ? hasSourceCredential(credentials, name, "institution_token")
            ? REQUEST_CREDENTIAL_PLACEHOLDER
            : null
          : name === "elsevier"
            ? sourceCredential(credentials, name, "institution_token")
            : null;
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
                institutionToken,
              )
            : new WileyAuthorizedPdfClient(
                authorizedTransport(name, ORIGINS.wiley, coordinator, options),
                credential,
              );
      sources.push(new AuthorizedPdfSource(client));
    } else unavailable[name] = "missing-source-adapter";
  }
  sources.push(options.doiLandingSource ?? new DoiLandingSource());
  // The controlled-Browser tier is last: every public source and authorized API route
  // is attempted first. The locator registry deliberately does not execute the Browser
  // source itself: Browser delivery is owned by Entry and returns through the durable
  // Candidate Intake/identity-acceptance boundary. Keeping the throwing marker source
  // out of the locator batch prevents an empty Browser result from being mistaken for
  // normal exhaustion while preserving the admission state for Entry escalation.
  const order = ["direct", ...selected, "doi-landing"];
  if (options.browser_admission) {
    order.push(BROWSER_ROUTE_NAME);
    if (options.browser_admission.enabled) {
      // An enabled Browser is an *applicable* route even when it is not ready, so it
      // must stay in the runnable list. Excluding it would let an unavailable tier be
      // silently converted into exhaustion for a target whose applicable routes never
      // all completed. A locator caller therefore still fails closed; Entry never runs
      // this source and escalates to the owned session instead.
      const ready =
        options.browser_admission.controlled_delivery &&
        options.browser_admission.unavailable_reason === null;
      sources.push(new BrowserAcquisitionSource(ready));
      if (!ready)
        unavailable[BROWSER_ROUTE_NAME] =
          options.browser_admission.unavailable_reason ??
          "browser-controlled-delivery-unavailable";
    } else {
      // A disabled switch is not an applicable route: the operator did not ask for the
      // tier, so it is reported but never run, and it cannot block exhaustion.
      unavailable[BROWSER_ROUTE_NAME] =
        options.browser_admission.unavailable_reason ?? "browser-disabled";
    }
  } else unavailable[BROWSER_ROUTE_NAME] = "browser-route-not-wired";
  return new PublicAcquisitionRegistry(sources, order, unavailable);
}

/** One process' acquisition view: locator routes plus the Browser admission state. */
export interface AcquisitionRouteSplit {
  /**
   * Public and authorized API routes. Locator-based delivery only: the controlled
   * Browser is deliberately absent, because its delivery is a spooled candidate
   * rather than a URL another transport could fetch.
   */
  readonly routes: PublicAcquisitionRegistry;
  /** Credential-free and otherwise low-risk routes in their frozen order. */
  readonly public_routes: PublicAcquisitionRegistry;
  /** Credential-bearing official PDF API routes in their frozen order. */
  readonly authorized_api_routes: PublicAcquisitionRegistry;
  readonly browser: {
    /** The operator admitted the tier (a disabled switch registers no route). */
    readonly enabled: boolean;
    /** The process can actually deliver a spooled Browser candidate right now. */
    readonly ready: boolean;
    /** Stable reason why an admitted tier cannot deliver, or `null` when it can. */
    readonly unavailable_reason: string | null;
  };
}

/**
 * Split one assembled registry into the locator route view and the Browser admission
 * state. Entry runs the locator tiers to their normal end and then escalates exactly
 * once to the owned Browser session; running the throwing Browser source inside the
 * tiered service instead would abort the batch before any delivery could be attempted.
 */
export function splitAcquisitionRoutes(
  registry: PublicAcquisitionRegistry,
): AcquisitionRouteSplit {
  const browserSource =
    registry.sources.find((item) => item.source_name === BROWSER_ROUTE_NAME) ??
    null;
  const browserStatus =
    registry.statuses.find((item) => item.source_name === BROWSER_ROUTE_NAME) ??
    null;
  const sourceByName = new Map(
    registry.sources.map((item) => [item.source_name, item]),
  );
  const routeSources: AcquisitionSourcePort[] = [];
  const syntheticUnavailable: Record<string, string> = {};
  const seen = new Set<string>();
  // Preserve the frozen route order from the assembled registry. A selected route that
  // has no adapter is represented by a non-retryable marker so Entry reports a stable
  // configuration failure instead of treating the route as absent and committing normal
  // exhaustion. The Browser marker remains outside this locator view and is handled by
  // the process-owned escalation below.
  for (const status of registry.statuses) {
    if (status.source_name === BROWSER_ROUTE_NAME) continue;
    const source = sourceByName.get(status.source_name);
    if (source) {
      routeSources.push(source);
      seen.add(status.source_name);
      continue;
    }
    const reason = registry.unavailable[status.source_name];
    if (reason === undefined) continue;
    routeSources.push(
      new UnavailableAcquisitionSource(
        status.source_name,
        reason,
        ["core", "elsevier", "wiley"].includes(status.source_name)
          ? "authorized-api"
          : "public",
      ),
    );
    syntheticUnavailable[status.source_name] = reason;
    seen.add(status.source_name);
  }
  // A caller may construct a registry with a custom source name that is not represented
  // in its expected status order. Do not silently drop that runnable source.
  for (const source of registry.sources) {
    if (
      source.source_name === BROWSER_ROUTE_NAME ||
      seen.has(source.source_name)
    )
      continue;
    routeSources.push(source);
    seen.add(source.source_name);
  }
  const routes = new PublicAcquisitionRegistry(
    routeSources,
    routeSources.map((item) => item.source_name),
    syntheticUnavailable,
  );
  const registryFor = (tier: "public" | "authorized-api") => {
    const selected = routeSources.filter(
      (source) => (source.acquisition_tier ?? "public") === tier,
    );
    const selectedNames = new Set(selected.map((source) => source.source_name));
    return new PublicAcquisitionRegistry(
      selected,
      selected.map((source) => source.source_name),
      Object.fromEntries(
        Object.entries(syntheticUnavailable).filter(([name]) =>
          selectedNames.has(name),
        ),
      ),
    );
  };
  return Object.freeze({
    routes,
    public_routes: registryFor("public"),
    authorized_api_routes: registryFor("authorized-api"),
    browser: Object.freeze({
      enabled: browserSource !== null,
      ready: browserSource?.ready === true,
      unavailable_reason:
        browserSource !== null && browserSource.ready === false
          ? (browserStatus?.failure_code ??
            "browser-controlled-delivery-unavailable")
          : null,
    }),
  });
}
