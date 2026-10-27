import type {
  AssetHint,
  CandidateCapture,
  VersionRole,
} from "@sciretriever/contracts";
import type {
  BrowserTransferCollector,
  DurableCandidate,
} from "../../browser/transfer.js";
import { NetworkHttpError, type HttpResponse } from "../../network/http.js";
import { normalizeUrl } from "../../network/policy.js";
import {
  authorizedTargets,
  authorizedUrl,
} from "../../providers/acquisition.js";
import {
  isAuthorizedAcquisitionUrl,
  LITERATURE_PROVIDERS,
} from "../../providers/registry.js";
import { dedupe, values } from "../../providers/shared/acquisition-locators.js";
import {
  AuthorizedProviderError,
  type AuthorizedDownloadLocator,
  type AuthorizedDownloadResult,
  type AuthorizedProvider,
} from "../../providers/shared/authorized-pdf.js";
import { acceptPdf } from "../pdf-acceptance.js";
import type {
  AcquisitionSourcePort,
  AcquisitionSourceRequest,
  AcquisitionStage,
  AuthorizedPdfClientPort,
} from "../ports.js";
import {
  AcquisitionCandidateSkippedError,
  AcquisitionRouteError,
  AcquisitionUnavailableError,
  classifyAcquisitionFailure,
} from "../tiered.js";
import { doiLanding, safeLocator, type SourceCandidate } from "./locators.js";

export interface PdfDownloadTransport {
  request(
    url: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<HttpResponse>;
}

export const DEFAULT_PDF_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

export interface PdfDownloadOptions {
  readonly collector: BrowserTransferCollector;
  readonly transfer_id: string;
  readonly capture?: CandidateCapture | null;
  readonly max_bytes?: number;
  readonly on_landing?: (origin: string) => void;
  /** Operation-local observations only; URLs must not be persisted or logged. */
  readonly on_response?: (response: {
    readonly requested_url: string;
    readonly final_url: string;
    readonly status: number;
    readonly media_type: string | null;
  }) => void;
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

export function hasPdfHeader(response: HttpResponse): boolean {
  return /%PDF-\d\.\d/u.test(
    new TextDecoder("latin1").decode(response.body.subarray(0, 1024)),
  );
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
        const target = new URL(value.replaceAll(/&amp;/giu, "&").trim(), base);
        // PDF viewer fragments are client-side display options, never part of the
        // HTTP request. Normalize them before the credential-free locator guard;
        // path, query, origin and dispatch-time DNS checks remain unchanged.
        target.hash = "";
        const locator = safeLocator("landing-pdf", target.toString()).locator;
        // HTML can advertise paths that the stateless public transport cannot
        // admit. Reject them before they become candidates; DNS/address policy
        // is still checked at dispatch for every syntactically valid link.
        normalizeUrl(locator, {
          allowed_ports: [
            { scheme: "https", port: Number(new URL(base).port || 443) },
          ],
        });
        if (seen.has(locator) || isAuthorizedAcquisitionUrl(locator)) return [];
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
  onLanding?: (origin: string) => void,
  onResponse?: PdfDownloadOptions["on_response"],
): Promise<HttpResponse> {
  const fetch = async (url: string): Promise<HttpResponse> => {
    let response: HttpResponse;
    try {
      response = await transport.request(url, {
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (
        !signal?.aborted &&
        error instanceof NetworkHttpError &&
        error.reason === "redirect-limit" &&
        error.retry_after_ms === undefined
      )
        throw new AcquisitionUnavailableError(
          "download-unavailable",
          "Public HTTP exhausted its bounded redirects; an independent browser session may be required.",
          "http-route-unavailable",
        );
      throw error;
    }
    onResponse?.({
      requested_url: url,
      final_url: response.final_url ?? url,
      status: response.status,
      media_type: responseMediaType(response),
    });
    if (candidate.source === "doi-landing" && url === candidate.locator)
      onLanding?.(new URL(response.final_url ?? url).origin);
    // Keep a successfully delivered candidate; no further request is needed.
    // Its bytes still pass the PDF reader before publication.
    if (
      response.status >= 200 &&
      response.status < 300 &&
      hasPdfHeader(response)
    )
      return response;
    // Stop this source's requests while limited; independent sources remain eligible.
    if (
      response.status === 429 ||
      response.retry_after_ms !== undefined ||
      response.headers.some(([name]) => name.toLowerCase() === "retry-after")
    )
      throw new AcquisitionRouteError(
        "rate-limited",
        `Public HTTP returned ${response.status} with a rate limit or Retry-After; this source is deferred.${response.retry_after_ms !== undefined ? ` Retry-After: ${response.retry_after_ms} ms.` : ""}`,
        true,
        { retry_after_ms: response.retry_after_ms },
      );
    if ([204, 404, 410].includes(response.status))
      throw new AcquisitionCandidateSkippedError();
    if (response.status === 403)
      throw new AcquisitionUnavailableError(
        "download-unavailable",
        "Public HTTP returned 403; this does not establish browser or institutional entitlement.",
        "http-route-unavailable",
      );
    if (response.status < 200 || response.status >= 300)
      throw new AcquisitionRouteError(
        "http-response-failed",
        `Public HTTP returned ${response.status}; no PDF was delivered.`,
        response.status !== 401,
      );
    return response;
  };
  const first = await fetch(candidate.locator);
  // Hints and Content-Type describe expected bytes; neither overrides actual content.
  if (hasPdfHeader(first)) return first;
  const mediaType = responseMediaType(first);
  if (
    mediaType !== null &&
    mediaType !== "text/html" &&
    mediaType !== "application/xhtml+xml" &&
    !/^\s*(?:<!doctype\s+html|<html\b)/iu.test(
      new TextDecoder().decode(first.body.subarray(0, 1024)),
    )
  )
    throw new AcquisitionUnavailableError(
      "download-unavailable",
      "Public HTTP returned a non-PDF representation without a usable HTML landing.",
      "http-route-unavailable",
    );
  const locators = staticPdfLocators(
    first.final_url ?? candidate.locator,
    first.body,
  );
  if (locators.length === 0) throw new AcquisitionCandidateSkippedError();
  let pending: unknown;
  for (const locator of locators) {
    if (signal?.aborted) throw new Error("acquisition download cancelled");
    try {
      const response = await fetch(locator);
      if (hasPdfHeader(response)) return response;
    } catch (error) {
      if (error instanceof AcquisitionCandidateSkippedError) continue;
      if (
        classifyAcquisitionFailure(
          error,
          signal ?? new AbortController().signal,
        ) !== "route" ||
        (error instanceof AcquisitionRouteError &&
          error.code === "rate-limited") ||
        (error instanceof NetworkHttpError &&
          error.retry_after_ms !== undefined)
      )
        throw error;
      // Continue bounded static alternatives, but never erase an unresolved failure.
      if (!pending || pending instanceof AcquisitionUnavailableError)
        pending = error;
    }
  }
  if (pending) throw pending;
  throw new AcquisitionUnavailableError(
    "download-unavailable",
    "The static PDF links returned no PDF; a browser page flow may be required.",
    "http-route-unavailable",
  );
}

/** Download one already-admitted locator into the durable Candidate spool. */
export async function downloadPdfCandidate(
  candidate: SourceCandidate,
  transport: PdfDownloadTransport,
  options: PdfDownloadOptions,
): Promise<DurableCandidate> {
  if (!candidate || typeof candidate.locator !== "string")
    throw new Error("acquisition download candidate is invalid");
  const maxBytes = options.max_bytes ?? DEFAULT_PDF_DOWNLOAD_MAX_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 512 * 1024 * 1024 ||
    options.signal?.aborted
  )
    throw new Error("acquisition download request is invalid");
  const response = await fetchPdfResponse(
    candidate,
    transport,
    options.signal,
    options.on_landing,
    options.on_response,
  );
  if (!(response.body instanceof Uint8Array) || response.body.byteLength === 0)
    throw new Error("acquisition download body is empty");
  if (response.body.byteLength > maxBytes)
    throw new Error("acquisition download exceeds byte limit");
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
  const maxBytes = options.max_bytes ?? DEFAULT_PDF_DOWNLOAD_MAX_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 512 * 1024 * 1024 ||
    options.signal?.aborted
  )
    throw new Error("acquisition download request is invalid");
  const result = await source.download_candidate(candidate, options.signal);
  if (result?.kind === "miss")
    throw new AcquisitionCandidateSkippedError("miss");
  if (!result || result.kind !== "download")
    throw new Error("acquisition source did not return a PDF");
  if (!(result.bytes instanceof Uint8Array) || result.bytes.byteLength === 0)
    throw new Error("acquisition download body is empty");
  if (result.bytes.byteLength > maxBytes)
    throw new Error("acquisition download exceeds byte limit");
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

function hintedPdf(
  hint: AssetHint,
  targetVersion?: VersionRole,
): SourceCandidate | null {
  if (
    (hint.asset_role !== null && hint.asset_role !== "primary-pdf") ||
    (targetVersion !== undefined &&
      hint.version_role !== null &&
      hint.version_role !== targetVersion) ||
    isAuthorizedAcquisitionUrl(hint.url)
  )
    return null;
  try {
    const url = new URL(hint.url);
    const explicitPdf =
      hint.asset_role === "primary-pdf" ||
      hint.media_type?.split(";", 1)[0]?.trim().toLowerCase() ===
        "application/pdf";
    if (!explicitPdf && !/\.pdf$/iu.test(url.pathname)) return null;
    // Viewer fragments are client-side options. Retain the original path and query.
    url.hash = "";
    return safeLocator("direct", url.toString());
  } catch {
    return null;
  }
}

export class DirectPdfSource implements AcquisitionSourcePort {
  readonly source_name = "direct" as const;
  readonly acquisition_stage = "direct" as const;
  readonly ready = true;
  async discover(
    request: AcquisitionSourceRequest,
  ): Promise<readonly SourceCandidate[]> {
    return dedupe(
      (request.asset_hints ?? []).flatMap((hint) => {
        const candidate = hintedPdf(hint, request.target_version);
        return candidate ? [candidate] : [];
      }),
    );
  }
}

export class DoiLandingSource implements AcquisitionSourcePort {
  readonly source_name = "doi-landing" as const;
  readonly acquisition_stage = "public-web" as const;
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

/** Only the provider's explicit access/service outcomes become route failures. */
function rethrowAuthorizedFailure(
  error: unknown,
  provider: AuthorizedProvider,
): never {
  if (!(error instanceof AuthorizedProviderError)) throw error;
  const { code, http_status, retry_after_ms } = error.failure;
  const status = http_status === undefined ? "" : ` HTTP ${http_status}.`;
  const retryHint =
    retry_after_ms === undefined ? "" : ` Retry-After: ${retry_after_ms} ms.`;
  if (code === "quota")
    throw new AcquisitionRouteError(
      "rate-limited",
      `${provider} API reported a rate limit or quota restriction.${status}${retryHint}`,
      true,
      { cause: error, retry_after_ms },
    );
  if (
    code === "authentication" ||
    code === "entitlement" ||
    code === "access" ||
    code === "request"
  )
    throw new AcquisitionRouteError(
      "http-response-failed",
      `${provider} API reported a ${code} failure for this access route.${status}`,
      false,
      { cause: error },
    );
  if (code === "service")
    throw new AcquisitionRouteError(
      "http-response-failed",
      `${provider} API reported a service failure.${status}`,
      true,
      { cause: error },
    );
  if (
    code === "response-schema" ||
    code === "non-pdf-product" ||
    code === "ambiguous-primary-pdf"
  )
    throw new AcquisitionRouteError(
      "candidate-download-failed",
      `${provider} API did not deliver a usable PDF (${code}).${status}`,
      false,
      { cause: error },
    );
  if (code === "cancelled")
    throw new DOMException("Acquisition request cancelled", "AbortError");
  // Unrecognized internal exceptions keep their original identity.
  throw error;
}

/** Credential-bearing source that exposes only an opaque, non-secret locator. */
export class AuthorizedPdfSource implements AcquisitionSourcePort {
  readonly acquisition_tier = "authorized-api" as const;
  readonly acquisition_stage: AcquisitionStage;
  readonly source_name: AuthorizedProvider;
  readonly ready = true;
  private readonly locators = new Map<string, AuthorizedDownloadLocator>();
  constructor(private readonly client: AuthorizedPdfClientPort) {
    this.source_name = client.provider;
    this.acquisition_stage =
      LITERATURE_PROVIDERS[client.provider]!.acquisitionStage!;
  }
  async discover(
    request: AcquisitionSourceRequest,
  ): Promise<readonly SourceCandidate[]> {
    const result: SourceCandidate[] = [];
    for (const target of authorizedTargets(this.source_name, request)) {
      let lookup: ReturnType<AuthorizedPdfClientPort["lookup"]>;
      try {
        lookup = this.client.lookup(target);
      } catch (error) {
        rethrowAuthorizedFailure(error, this.source_name);
      }
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
    try {
      return await this.client.download(locator, signal);
    } catch (error) {
      rethrowAuthorizedFailure(error, this.source_name);
    }
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
  /**
   * Configuration/readiness failures for routes intentionally selected by the caller but
   * not runnable in this process. The ordinary registry keeps those routes out of its
   * locator list for compatibility; Entry's split view materializes them as fail-closed
   * route outcomes so they can never be mistaken for normal exhaustion.
   */
  readonly unavailable: Readonly<Record<string, string>>;
  constructor(
    sources: readonly AcquisitionSourcePort[],
    expectedSourceNames?: readonly string[],
    unavailable: Readonly<Record<string, string>> = {},
    readonly not_enabled: readonly {
      readonly source: string;
      readonly stage: AcquisitionStage;
    }[] = [],
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
        : [
            ...names.filter(
              (name) =>
                [
                  "direct",
                  "arxiv",
                  "europe-pmc",
                  "doi-landing",
                  "unpaywall",
                ].includes(name) || byName.has(name),
            ),
            ...[...byName.keys()].filter(
              (name) => !names.some((known) => known === name),
            ),
          ],
    );
    if (
      new Set(presentNames).size !== presentNames.length ||
      presentNames.some((name) => !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(name))
    )
      throw new TypeError("invalid acquisition source order");
    this.unavailable = Object.freeze({
      ...Object.fromEntries(
        (expectedSourceNames ?? [])
          .filter((name) => !byName.has(name))
          .map((name) => [name, "missing-source-adapter"]),
      ),
      ...unavailable,
    });
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
              : (this.unavailable[source_name] ?? "missing-source-adapter"),
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
