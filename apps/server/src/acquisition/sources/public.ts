import type {
  AssetHint,
  CandidateCapture,
  Identifier,
  MetadataObservation,
} from "@sciretriever/contracts";
import type { HttpResponse } from "../../network/http.js";
import { acceptPdf } from "../pdf-acceptance.js";
import type {
  BrowserTransferCollector,
  DurableCandidate,
} from "../../browser/transfer.js";
import {
  arxivPdf,
  doiLanding,
  europePmcPdf,
  safeLocator,
  type SourceCandidate,
  unpaywallLocations,
  configuredMirrors,
} from "./locators.js";
import type {
  AuthorizedDownloadLocator,
  AuthorizedDownloadResult,
  AuthorizedLookupTarget,
  AuthorizedProvider,
} from "../providers/authorized.js";

export interface AcquisitionSourceRequest {
  readonly identifiers: readonly Identifier[];
  readonly observations?: readonly MetadataObservation[];
  readonly asset_hints?: readonly AssetHint[];
}
export interface AcquisitionSourcePort {
  readonly source_name: string;
  readonly ready: boolean;
  discover(
    request: AcquisitionSourceRequest,
    signal?: AbortSignal,
  ): Promise<readonly SourceCandidate[]>;
  /** Optional second phase for sources whose endpoint requires a credential grant. */
  download_candidate?(
    candidate: SourceCandidate,
    signal?: AbortSignal,
  ): Promise<AuthorizedDownloadResult | null>;
}
export interface PublicAcquisitionTransport {
  request(
    url: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly headers?: Readonly<Record<string, string>>;
    },
  ): Promise<unknown>;
}

export interface PdfDownloadTransport {
  request(
    url: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<HttpResponse>;
}

export interface PdfDownloadOptions {
  readonly collector: BrowserTransferCollector;
  readonly transfer_id: string;
  readonly capture?: CandidateCapture | null;
  readonly max_bytes?: number;
  readonly signal?: AbortSignal;
}

export interface SourceDownloadOptions extends PdfDownloadOptions {
  /** Registry containing the source that produced the candidate. */
  readonly registry: PublicAcquisitionRegistry;
}

function responseMediaType(response: HttpResponse): string | null {
  const value = response.headers.find(
    ([name]) => name.toLowerCase() === "content-type",
  )?.[1];
  return value ? value.split(";", 1)[0]!.trim().toLowerCase() : null;
}

function staticPdfLocators(base: string, bytes: Uint8Array): readonly string[] {
  if (bytes.byteLength > 2 * 1024 * 1024)
    throw new Error("acquisition landing exceeds byte limit");
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("acquisition landing is invalid");
  }
  const raw: string[] = [];
  for (const pattern of [
    /<meta\b[^>]*\b(?:name|property)\s*=\s*["']citation_pdf_url["'][^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*>/giu,
    /<meta\b[^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*\b(?:name|property)\s*=\s*["']citation_pdf_url["'][^>]*>/giu,
  ])
    for (const match of html.matchAll(pattern)) raw.push(match[1]!);
  for (const pattern of [
    /<(?:a|link)\b[^>]*\bhref\s*=\s*["']([^"']+\.pdf(?:[?#][^"']*)?)["'][^>]*>/giu,
    /<(?:iframe|embed)\b[^>]*\bsrc\s*=\s*["']([^"']+\.pdf(?:[?#][^"']*)?)["'][^>]*>/giu,
  ])
    for (const match of html.matchAll(pattern)) raw.push(match[1]!);
  const seen = new Set<string>();
  return Object.freeze(
    raw.flatMap((value) => {
      try {
        const locator = safeLocator(
          "landing-pdf",
          new URL(value.replaceAll(/&amp;/giu, "&").trim(), base).toString(),
        ).locator;
        if (seen.has(locator)) return [];
        seen.add(locator);
        return [locator];
      } catch {
        return [];
      }
    }),
  );
}

async function fetchPdfResponse(
  candidate: SourceCandidate,
  transport: PdfDownloadTransport,
  signal?: AbortSignal,
): Promise<HttpResponse> {
  const first = await transport.request(candidate.locator, {
    ...(signal ? { signal } : {}),
  });
  if (first.status < 200 || first.status >= 300)
    throw new Error("acquisition download response failed");
  const mediaType = responseMediaType(first);
  if (candidate.kind === "pdf" || mediaType === "application/pdf") return first;
  if (
    mediaType !== null &&
    mediaType !== "text/html" &&
    mediaType !== "application/xhtml+xml"
  )
    throw new Error("acquisition landing media type is invalid");
  const locators = staticPdfLocators(candidate.locator, first.body);
  if (locators.length === 0)
    throw new Error("acquisition landing has no static PDF locator");
  for (const locator of locators) {
    if (signal?.aborted) throw new Error("acquisition download cancelled");
    try {
      const response = await transport.request(locator, {
        ...(signal ? { signal } : {}),
      });
      if (response.status >= 200 && response.status < 300) return response;
    } catch {
      // A failed candidate does not prevent the next ordered static locator.
    }
  }
  throw new Error("acquisition landing PDF download failed");
}

/** Download one already-admitted locator into the durable Candidate spool. */
export async function downloadPdfCandidate(
  candidate: SourceCandidate,
  transport: PdfDownloadTransport,
  options: PdfDownloadOptions,
): Promise<DurableCandidate> {
  if (!candidate || typeof candidate.locator !== "string")
    throw new Error("acquisition download candidate is invalid");
  const maxBytes = options.max_bytes ?? 64 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 512 * 1024 * 1024 ||
    options.signal?.aborted
  )
    throw new Error("acquisition download request is invalid");
  const response = await fetchPdfResponse(candidate, transport, options.signal);
  if (!(response.body instanceof Uint8Array) || response.body.byteLength === 0)
    throw new Error("acquisition download body is empty");
  if (response.body.byteLength > maxBytes)
    throw new Error("acquisition download exceeds byte limit");
  const contentType = responseMediaType(response);
  if (contentType && contentType !== "application/pdf")
    throw new Error("acquisition download media type is not PDF");
  await acceptPdf(response.body, 10_000, options.signal);
  await options.collector.begin(
    options.transfer_id,
    maxBytes,
    options.capture ?? null,
    candidate.source,
    candidate.source_record_id,
  );
  try {
    for (
      let offset = 0;
      offset < response.body.byteLength;
      offset += 1024 * 1024
    ) {
      if (options.signal?.aborted)
        throw new Error("acquisition download cancelled");
      await options.collector.append(
        options.transfer_id,
        response.body.subarray(
          offset,
          Math.min(offset + 1024 * 1024, response.body.byteLength),
        ),
      );
    }
    return await options.collector.complete(options.transfer_id);
  } catch (error) {
    await options.collector.discard(options.transfer_id).catch(() => undefined);
    throw error;
  }
}

/**
 * Download a candidate through its source-owned credential boundary and put
 * the bytes through the same durable Candidate spool used by public HTTP
 * downloads. Authorized sources never expose their credential-bearing
 * transport to callers; they return a bounded PDF result that is validated
 * before it is persisted.
 */
export async function downloadSourceCandidate(
  candidate: SourceCandidate,
  options: SourceDownloadOptions,
): Promise<DurableCandidate> {
  const source = options.registry.sources.find(
    (item) => item.source_name === candidate.source,
  );
  if (!source?.download_candidate)
    throw new Error("acquisition source download is unavailable");
  const maxBytes = options.max_bytes ?? 64 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 512 * 1024 * 1024 ||
    options.signal?.aborted
  )
    throw new Error("acquisition download request is invalid");
  const result = await source.download_candidate(candidate, options.signal);
  if (!result || result.kind !== "download")
    throw new Error("acquisition source did not return a PDF");
  if (!(result.bytes instanceof Uint8Array) || result.bytes.byteLength === 0)
    throw new Error("acquisition download body is empty");
  if (result.bytes.byteLength > maxBytes)
    throw new Error("acquisition download exceeds byte limit");
  if (
    result.media_type &&
    result.media_type.split(";", 1)[0]!.trim().toLowerCase() !==
      "application/pdf"
  )
    throw new Error("acquisition download media type is not PDF");
  await acceptPdf(result.bytes, 10_000, options.signal);
  const capture = options.capture === undefined ? null : options.capture;
  await options.collector.begin(
    options.transfer_id,
    maxBytes,
    capture,
    candidate.source,
    candidate.source_record_id,
  );
  try {
    for (
      let offset = 0;
      offset < result.bytes.byteLength;
      offset += 1024 * 1024
    ) {
      if (options.signal?.aborted)
        throw new Error("acquisition download cancelled");
      await options.collector.append(
        options.transfer_id,
        result.bytes.subarray(
          offset,
          Math.min(offset + 1024 * 1024, result.bytes.byteLength),
        ),
      );
    }
    return await options.collector.complete(options.transfer_id);
  } catch (error) {
    await options.collector.discard(options.transfer_id).catch(() => undefined);
    throw error;
  }
}

function values(
  request: AcquisitionSourceRequest,
  namespace: string,
): readonly string[] {
  return request.identifiers
    .filter((item) => item.namespace.toLowerCase() === namespace)
    .map((item) => item.value.trim())
    .filter(Boolean);
}

function dedupe(
  candidates: readonly SourceCandidate[],
): readonly SourceCandidate[] {
  const seen = new Set<string>();
  return Object.freeze(
    candidates.filter((candidate) => {
      if (seen.has(candidate.locator)) return false;
      seen.add(candidate.locator);
      return true;
    }),
  );
}

function hintedPdf(hint: AssetHint): SourceCandidate | null {
  if (
    hint.kind !== "direct-file" ||
    hint.media_type?.toLowerCase() !== "application/pdf"
  )
    return null;
  try {
    return safeLocator("direct", hint.url);
  } catch {
    return null;
  }
}

export class DirectPdfSource implements AcquisitionSourcePort {
  readonly source_name = "direct" as const;
  readonly ready = true;
  async discover(
    request: AcquisitionSourceRequest,
  ): Promise<readonly SourceCandidate[]> {
    return dedupe(
      (request.asset_hints ?? []).flatMap((hint) => {
        const candidate = hintedPdf(hint);
        return candidate ? [candidate] : [];
      }),
    );
  }
}

export class ArxivPdfSource implements AcquisitionSourcePort {
  readonly source_name = "arxiv" as const;
  readonly ready = true;
  async discover(
    request: AcquisitionSourceRequest,
  ): Promise<readonly SourceCandidate[]> {
    return dedupe(
      values(request, "arxiv").flatMap((identifier) => {
        try {
          return [arxivPdf(identifier)];
        } catch {
          return [];
        }
      }),
    );
  }
}

export class EuropePmcPdfSource implements AcquisitionSourcePort {
  readonly source_name = "europe-pmc" as const;
  readonly ready = true;
  async discover(
    request: AcquisitionSourceRequest,
  ): Promise<readonly SourceCandidate[]> {
    return dedupe(
      [...values(request, "pmcid"), ...values(request, "pmid")].flatMap(
        (identifier) => {
          try {
            return [europePmcPdf(identifier)];
          } catch {
            return [];
          }
        },
      ),
    );
  }
}

export class DoiLandingSource implements AcquisitionSourcePort {
  readonly source_name = "doi-landing" as const;
  readonly ready = true;
  async discover(
    request: AcquisitionSourceRequest,
  ): Promise<readonly SourceCandidate[]> {
    return dedupe(
      values(request, "doi").flatMap((identifier) => {
        try {
          return [doiLanding(identifier)];
        } catch {
          return [];
        }
      }),
    );
  }
}

/** Explicitly configured mirror source. It is never enabled by auto selection. */
export class ConfiguredSciHubSource implements AcquisitionSourcePort {
  readonly source_name = "sci-hub" as const;
  readonly ready = true;
  private readonly mirrors: readonly SourceCandidate[];
  constructor(urls: readonly string[]) {
    this.mirrors = configuredMirrors(true, urls);
  }
  async discover(
    request: AcquisitionSourceRequest,
  ): Promise<readonly SourceCandidate[]> {
    const doi = values(request, "doi")[0];
    if (!doi) return [];
    return dedupe(
      this.mirrors.flatMap((mirror) => {
        try {
          const url = new URL(mirror.locator);
          url.pathname = `${url.pathname.replace(/\/$/u, "")}/${encodeURIComponent(doi)}`;
          return [safeLocator(this.source_name, url.toString(), "landing")];
        } catch {
          return [];
        }
      }),
    );
  }
}

function email(value: string): string {
  const normalized = value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(normalized))
    throw new TypeError("Unpaywall email is invalid");
  return normalized;
}

export class UnpaywallSource implements AcquisitionSourcePort {
  readonly source_name = "unpaywall" as const;
  readonly ready = true;
  private readonly contact: string;
  private readonly origin: URL;
  constructor(
    private readonly transport: PublicAcquisitionTransport,
    options: { readonly email: string; readonly origin?: string },
  ) {
    this.contact = email(options.email);
    this.origin = new URL(options.origin ?? "https://api.unpaywall.org");
    if (
      this.origin.protocol !== "https:" ||
      this.origin.username ||
      this.origin.password
    )
      throw new TypeError("Unpaywall origin must be HTTPS");
  }
  async discover(
    request: AcquisitionSourceRequest,
    signal?: AbortSignal,
  ): Promise<readonly SourceCandidate[]> {
    const doi = values(request, "doi")[0];
    if (!doi) return [];
    const url = new URL(
      `${this.origin.toString().replace(/\/$/u, "")}/v2/${encodeURIComponent(doi)}`,
    );
    url.searchParams.set("email", this.contact);
    const response = await this.transport.request(url.toString(), {
      ...(signal ? { signal } : {}),
      headers: { accept: "application/json" },
    });
    if (!response || typeof response !== "object" || Array.isArray(response))
      throw new Error("Unpaywall response is invalid");
    const record = response as Record<string, unknown>;
    const locations = [
      ...(Array.isArray(record.best_oa_location)
        ? record.best_oa_location
        : record.best_oa_location
          ? [record.best_oa_location]
          : []),
      ...(Array.isArray(record.oa_locations) ? record.oa_locations : []),
    ].flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const value = item as Record<string, unknown>;
      const location = {
        ...(typeof value.url_for_pdf === "string"
          ? { url: value.url_for_pdf }
          : typeof value.url === "string"
            ? { url: value.url }
            : {}),
        ...(typeof value.version === "string"
          ? { version: value.version }
          : {}),
        ...(typeof value.host_type === "string"
          ? { host_type: value.host_type }
          : {}),
        direct_pdf: typeof value.url_for_pdf === "string",
      };
      return [location];
    });
    return unpaywallLocations(locations);
  }
}

export interface AuthorizedPdfClientPort {
  readonly provider: AuthorizedProvider;
  lookup(target: AuthorizedLookupTarget):
    | {
        readonly kind: "downloads";
        readonly downloads: readonly AuthorizedDownloadLocator[];
      }
    | { readonly kind: "miss" };
  download(
    locator: AuthorizedDownloadLocator,
    signal?: AbortSignal,
  ): Promise<AuthorizedDownloadResult>;
}

function requestOrigins(
  request: AcquisitionSourceRequest,
): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const observation of request.observations ?? [])
    for (const hint of observation.asset_hints)
      try {
        origins.add(new URL(hint.url).origin);
      } catch {
        // Invalid persisted hints are ignored at this Source boundary.
      }
  for (const hint of request.asset_hints ?? [])
    try {
      origins.add(new URL(hint.url).origin);
    } catch {
      // Invalid caller hints are ignored at this Source boundary.
    }
  return origins;
}

function authorizedTargets(
  provider: AuthorizedProvider,
  request: AcquisitionSourceRequest,
): readonly AuthorizedLookupTarget[] {
  const origins = requestOrigins(request);
  const allowsDoi =
    provider === "elsevier"
      ? [
          "https://www.sciencedirect.com",
          "https://linkinghub.elsevier.com",
          "https://pdf.sciencedirectassets.com",
        ].some((origin) => origins.has(origin))
      : provider === "wiley"
        ? ["https://onlinelibrary.wiley.com", "https://alm.wiley.com"].some(
            (origin) => origins.has(origin),
          )
        : false;
  const targets: AuthorizedLookupTarget[] = [];
  for (const identifier of request.identifiers) {
    const namespace = identifier.namespace.toLowerCase();
    const supported =
      provider === "core"
        ? namespace === "core-work" || namespace === "core-output"
        : provider === "elsevier"
          ? namespace === "pii" ||
            namespace === "elsevier-article-eid" ||
            (namespace === "doi" && allowsDoi)
          : namespace === "doi" && allowsDoi;
    if (supported) targets.push({ namespace, value: identifier.value.trim() });
  }
  if (provider === "core")
    for (const observation of request.observations ?? []) {
      const provenance = observation.provenance;
      const record = provenance.source_record_id;
      if (provenance.source_name !== "core" || !record) continue;
      if (record.startsWith("work:"))
        targets.push({ namespace: "core-work", value: record.slice(5) });
      else if (record.startsWith("output:"))
        targets.push({ namespace: "core-output", value: record.slice(7) });
    }
  const seen = new Set<string>();
  return Object.freeze(
    targets.filter((target) => {
      const key = `${target.namespace}\u0000${target.value}`;
      if (!target.value || seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

function authorizedUrl(
  provider: AuthorizedProvider,
  locator: AuthorizedDownloadLocator,
): string {
  const value = encodeURIComponent(locator.value);
  if (provider === "core") {
    const entity = locator.namespace === "core-work-pdf" ? "works" : "outputs";
    return `https://api.core.ac.uk/v3/${entity}/${value}/download`;
  }
  if (provider === "elsevier") {
    const kind = locator.namespace.endsWith("-doi")
      ? "doi"
      : locator.namespace.endsWith("-pii")
        ? "pii"
        : "eid";
    return `https://api.elsevier.com/content/article/${kind}?view=FULL&${kind}=${value}`;
  }
  return `https://api.wiley.com/onlinelibrary/tdm/v1/articles/${value}`;
}

/** Credential-bearing source that exposes only an opaque, non-secret locator. */
export class AuthorizedPdfSource implements AcquisitionSourcePort {
  readonly source_name: AuthorizedProvider;
  readonly ready = true;
  private readonly locators = new Map<string, AuthorizedDownloadLocator>();
  constructor(private readonly client: AuthorizedPdfClientPort) {
    this.source_name = client.provider;
  }
  async discover(
    request: AcquisitionSourceRequest,
  ): Promise<readonly SourceCandidate[]> {
    const result: SourceCandidate[] = [];
    for (const target of authorizedTargets(this.source_name, request)) {
      const lookup = this.client.lookup(target);
      if (lookup.kind !== "downloads") continue;
      for (const locator of lookup.downloads) {
        const candidate = safeLocator(
          this.source_name,
          authorizedUrl(this.source_name, locator),
        );
        const withEvidence = Object.freeze({
          ...candidate,
          source_record_id: locator.source_record_id,
          evidence: Object.freeze(["authorized-origin", "credential-grant"]),
        });
        this.locators.set(withEvidence.locator, locator);
        result.push(withEvidence);
      }
    }
    return dedupe(result);
  }
  async download_candidate(
    candidate: SourceCandidate,
    signal?: AbortSignal,
  ): Promise<AuthorizedDownloadResult | null> {
    if (candidate.source !== this.source_name) return null;
    const locator = this.locators.get(candidate.locator);
    if (!locator) throw new Error("authorized source locator is unknown");
    return this.client.download(locator, signal);
  }
}

export interface AcquisitionSourceStatus {
  readonly source_name: string;
  readonly ready: boolean;
  readonly failure_code: string | null;
}
export class PublicAcquisitionRegistry {
  readonly sources: readonly AcquisitionSourcePort[];
  readonly statuses: readonly AcquisitionSourceStatus[];
  constructor(
    sources: readonly AcquisitionSourcePort[],
    expectedSourceNames?: readonly string[],
    unavailable: Readonly<Record<string, string>> = {},
  ) {
    const byName = new Map<string, AcquisitionSourcePort>();
    for (const source of sources) {
      if (byName.has(source.source_name))
        throw new TypeError("duplicate acquisition source");
      byName.set(source.source_name, source);
    }
    const names = [
      "direct",
      "arxiv",
      "europe-pmc",
      "doi-landing",
      "unpaywall",
      "core",
      "elsevier",
      "wiley",
      "sci-hub",
    ] as const;
    const presentNames = Object.freeze(
      expectedSourceNames
        ? [...expectedSourceNames]
        : names.filter(
            (name) =>
              [
                "direct",
                "arxiv",
                "europe-pmc",
                "doi-landing",
                "unpaywall",
              ].includes(name) || byName.has(name),
          ),
    );
    if (
      new Set(presentNames).size !== presentNames.length ||
      presentNames.some((name) => !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(name))
    )
      throw new TypeError("invalid acquisition source order");
    this.sources = Object.freeze(
      presentNames.flatMap((name) =>
        byName.has(name) ? [byName.get(name)!] : [],
      ),
    );
    this.statuses = Object.freeze(
      presentNames.map((source_name) => {
        const source = byName.get(source_name);
        return Object.freeze({
          source_name,
          ready: source?.ready === true,
          failure_code:
            source?.ready === true
              ? null
              : (unavailable[source_name] ?? "missing-source-adapter"),
        });
      }),
    );
  }
  async discover(
    request: AcquisitionSourceRequest,
    signal?: AbortSignal,
  ): Promise<{
    readonly candidates: readonly SourceCandidate[];
    readonly failures: readonly string[];
  }> {
    const candidates: SourceCandidate[] = [];
    const failures: string[] = [];
    for (const source of this.sources) {
      try {
        candidates.push(...(await source.discover(request, signal)));
      } catch {
        failures.push(source.source_name);
      }
    }
    return {
      candidates: dedupe(candidates),
      failures: Object.freeze(failures),
    };
  }
}
