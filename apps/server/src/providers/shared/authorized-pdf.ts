import type { HttpResponse } from "../../network/http.js";
export type AuthorizedProvider = "core" | "elsevier" | "wiley";
export interface AuthorizedLookupTarget {
  readonly namespace: string;
  readonly value: string;
}
export interface AuthorizedDownloadLocator {
  readonly namespace: string;
  readonly value: string;
  readonly declared_media_type: "application/pdf";
  readonly source_record_id: string;
}
export interface AuthorizedLookupDownloads {
  readonly kind: "downloads";
  readonly target: AuthorizedLookupTarget;
  readonly entitlement: "granted" | "denied" | "unknown";
  readonly downloads: readonly AuthorizedDownloadLocator[];
}
export interface AuthorizedLookupMiss {
  readonly kind: "miss";
  readonly target: AuthorizedLookupTarget;
  readonly reason: "no-primary" | "http-204" | "http-404" | "http-410";
}
export type AuthorizedLookupResult =
  | AuthorizedLookupDownloads
  | AuthorizedLookupMiss;
export interface AuthorizedPdfDownload {
  readonly kind: "download";
  readonly locator: AuthorizedDownloadLocator;
  readonly bytes: Uint8Array;
  readonly media_type: string | null;
  readonly safe_source_url: string;
  readonly entitlement: "granted";
}
export interface AuthorizedClientFailure {
  readonly authentication?: "accepted" | "rejected";
  readonly fulltext_permission?: "denied";
  readonly code:
    | "access"
    | "authentication"
    | "entitlement"
    | "quota"
    | "service"
    | "request"
    | "response-schema"
    | "non-pdf-product"
    | "ambiguous-primary-pdf"
    | "cancelled";
  readonly http_status?: number;
  readonly retry_after_ms?: number;
}
export type AuthorizedDownloadResult =
  | AuthorizedPdfDownload
  | AuthorizedLookupMiss;
export interface AuthorizedTransport {
  request(
    url: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly headers?: Readonly<Record<string, string>>;
    },
  ): Promise<HttpResponse>;
}
export class AuthorizedProviderError extends Error {
  constructor(readonly failure: AuthorizedClientFailure) {
    super("authorized acquisition provider failed");
    this.name = "AuthorizedProviderError";
  }
}
export const safeIdentity = (value: string): string => {
  const hasControl = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159);
  });
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 1024 ||
    hasControl ||
    value.includes("//")
  )
    throw new AuthorizedProviderError({ code: "response-schema" });
  return value.trim();
};
export function mediaType(response: HttpResponse): string | null {
  const value = response.headers.find(
    ([name]) => name.toLowerCase() === "content-type",
  )?.[1];
  return value ? value.split(";", 1)[0]!.trim().toLowerCase() : null;
}
/** Candidate evidence only; the shared PDF reader still validates before admission. */
export function hasPdfHeader(response: HttpResponse): boolean {
  return (
    response.body instanceof Uint8Array &&
    /%PDF-\d\.\d/u.test(
      new TextDecoder("latin1").decode(response.body.subarray(0, 1024)),
    )
  );
}
export function rateLimitedResponse(response: HttpResponse): boolean {
  const deliveredPdf = response.status === 200 && hasPdfHeader(response);
  return (
    response.status === 429 ||
    (!deliveredPdf &&
      (response.retry_after_ms !== undefined ||
        response.headers.some(
          ([name]) => name.toLowerCase() === "retry-after",
        )))
  );
}
export function failHttpResponse(
  code: AuthorizedClientFailure["code"],
  response: HttpResponse,
): never {
  throw new AuthorizedProviderError({
    code,
    http_status: response.status,
    ...(response.retry_after_ms === undefined
      ? {}
      : { retry_after_ms: response.retry_after_ms }),
  });
}
export async function download(
  transport: AuthorizedTransport,
  locator: AuthorizedDownloadLocator,
  url: string,
  headers: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<AuthorizedDownloadResult> {
  if (signal?.aborted) throw new AuthorizedProviderError({ code: "cancelled" });
  const response = await transport.request(url, {
    headers,
    ...(signal ? { signal } : {}),
  });
  if (signal?.aborted) throw new AuthorizedProviderError({ code: "cancelled" });
  return interpretDownloadResponse(locator, response, url);
}
export function interpretDownloadResponse(
  locator: AuthorizedDownloadLocator,
  response: HttpResponse,
  safeSourceUrl: string,
): AuthorizedDownloadResult {
  if (rateLimitedResponse(response)) failHttpResponse("quota", response);
  if ([204, 404, 410].includes(response.status))
    return {
      kind: "miss",
      target: { namespace: locator.namespace, value: locator.value },
      reason:
        response.status === 204
          ? "http-204"
          : response.status === 410
            ? "http-410"
            : "http-404",
    };
  if (response.status === 401) failHttpResponse("authentication", response);
  if (response.status === 403) failHttpResponse("entitlement", response);
  if (response.status >= 500) failHttpResponse("service", response);
  if (response.status !== 200) failHttpResponse("request", response);
  if (!(response.body instanceof Uint8Array) || response.body.byteLength === 0)
    throw new AuthorizedProviderError({ code: "response-schema" });
  const type = mediaType(response);
  if (type !== null && type !== "application/pdf" && !hasPdfHeader(response))
    throw new AuthorizedProviderError({ code: "non-pdf-product" });
  return {
    kind: "download",
    locator,
    bytes: response.body,
    media_type: type,
    safe_source_url: safeSourceUrl,
    entitlement: "granted",
  };
}
