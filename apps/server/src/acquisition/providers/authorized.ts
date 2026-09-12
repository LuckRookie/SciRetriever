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
  readonly code:
    | "access"
    | "authentication"
    | "entitlement"
    | "quota"
    | "service"
    | "response-schema"
    | "non-pdf-product"
    | "ambiguous-primary-pdf"
    | "cancelled";
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

const safeIdentity = (value: string): string => {
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

function mediaType(response: HttpResponse): string | null {
  const value = response.headers.find(
    ([name]) => name.toLowerCase() === "content-type",
  )?.[1];
  return value ? value.split(";", 1)[0]!.trim().toLowerCase() : null;
}

async function download(
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

function interpretDownloadResponse(
  locator: AuthorizedDownloadLocator,
  response: HttpResponse,
  safeSourceUrl: string,
): AuthorizedDownloadResult {
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
  if (response.status === 401)
    throw new AuthorizedProviderError({ code: "authentication" });
  if (response.status === 403)
    throw new AuthorizedProviderError({ code: "entitlement" });
  if (response.status === 429)
    throw new AuthorizedProviderError({ code: "quota" });
  if (response.status >= 500)
    throw new AuthorizedProviderError({ code: "service" });
  if (response.status !== 200)
    throw new AuthorizedProviderError({ code: "response-schema" });
  if (!(response.body instanceof Uint8Array) || response.body.byteLength === 0)
    throw new AuthorizedProviderError({ code: "response-schema" });
  const type = mediaType(response);
  if (type !== null && type !== "application/pdf")
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

function elsevierHeaders(
  apiKey: string,
  institutionToken: string | null,
  accept: string,
): Readonly<Record<string, string>> {
  return {
    accept,
    "x-els-apikey": apiKey,
    ...(institutionToken ? { "x-els-insttoken": institutionToken } : {}),
  };
}

function xmlField(block: string, name: string): string | null {
  const values = [
    ...block.matchAll(
      new RegExp(
        `<(?:[a-z][a-z0-9_.-]*:)?${name}\\b[^>]*>([^<]*)<\\/(?:[a-z][a-z0-9_.-]*:)?${name}>`,
        "giu",
      ),
    ),
  ]
    .map((match) => match[1]!.trim())
    .filter(Boolean);
  if (values.some((value) => value !== values[0]))
    throw new AuthorizedProviderError({ code: "response-schema" });
  return values[0] ?? null;
}

function elsevierMainObjects(bytes: Uint8Array): readonly string[] | null {
  if (bytes.byteLength > 4 * 1024 * 1024) return null;
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml))
    throw new AuthorizedProviderError({ code: "response-schema" });
  if (!/<(?:[a-z][a-z0-9_.-]*:)?full-text-retrieval-response\b/iu.test(xml))
    return null;
  const elementCount = [...xml.matchAll(/<[a-z][^!?/][^>]*>/giu)].length;
  if (elementCount > 10_000)
    throw new AuthorizedProviderError({ code: "response-schema" });
  const result: string[] = [];
  for (const match of xml.matchAll(
    /<(?:[a-z][a-z0-9_.-]*:)?web-pdf\b[^>]*>([\s\S]*?)<\/(?:[a-z][a-z0-9_.-]*:)?web-pdf>/giu,
  )) {
    const block = match[1]!;
    const purpose = xmlField(block, "web-pdf-purpose")?.toLowerCase();
    const extension = xmlField(block, "extension")?.toLowerCase();
    const filename = xmlField(block, "filename");
    const eid = xmlField(block, "attachment-eid");
    if (
      purpose !== "main" ||
      extension !== "pdf" ||
      !filename?.toLowerCase().endsWith(".pdf") ||
      !eid ||
      !/^[a-zA-Z0-9._()-]{1,1024}\.pdf$/u.test(eid)
    )
      continue;
    const identity = `${eid} ${filename}`.toLowerCase();
    if (
      ["supplement", "graphical", "-mmc", "_mmc"].some((marker) =>
        identity.includes(marker),
      )
    )
      continue;
    if (!result.includes(eid)) result.push(eid);
  }
  return Object.freeze(result);
}

export class CoreAuthorizedPdfClient {
  readonly provider = "core" as const;
  constructor(
    private readonly transport: AuthorizedTransport,
    private readonly apiKey: string,
    private readonly origin = "https://api.core.ac.uk",
  ) {
    if (!apiKey.trim()) throw new TypeError("CORE API key is required");
    if (new URL(origin).origin !== "https://api.core.ac.uk")
      throw new TypeError("CORE origin is fixed");
  }
  lookup(target: AuthorizedLookupTarget): AuthorizedLookupResult {
    const value = safeIdentity(target.value);
    if (target.namespace !== "core-work" && target.namespace !== "core-output")
      throw new AuthorizedProviderError({ code: "response-schema" });
    return {
      kind: "downloads",
      target: { namespace: target.namespace, value },
      entitlement: "unknown",
      downloads: [
        {
          namespace:
            target.namespace === "core-work"
              ? "core-work-pdf"
              : "core-output-pdf",
          value,
          declared_media_type: "application/pdf",
          source_record_id: `${target.namespace === "core-work" ? "work" : "output"}:${value}`,
        },
      ],
    };
  }
  download(
    locator: AuthorizedDownloadLocator,
    signal?: AbortSignal,
  ): Promise<AuthorizedDownloadResult> {
    if (
      !locator.namespace.startsWith("core-") ||
      locator.declared_media_type !== "application/pdf"
    )
      throw new AuthorizedProviderError({ code: "response-schema" });
    const entity =
      locator.namespace === "core-work-pdf"
        ? "works"
        : locator.namespace === "core-output-pdf"
          ? "outputs"
          : null;
    if (!entity) throw new AuthorizedProviderError({ code: "response-schema" });
    return download(
      this.transport,
      locator,
      `${this.origin}/v3/${entity}/${encodeURIComponent(safeIdentity(locator.value))}/download`,
      { accept: "application/pdf", authorization: `Bearer ${this.apiKey}` },
      signal,
    );
  }
}

export class ElsevierAuthorizedPdfClient {
  readonly provider = "elsevier" as const;
  constructor(
    private readonly transport: AuthorizedTransport,
    private readonly apiKey: string,
    private readonly institutionToken: string | null = null,
    private readonly origin = "https://api.elsevier.com",
  ) {
    if (!apiKey.trim()) throw new TypeError("Elsevier API key is required");
    if (new URL(origin).origin !== "https://api.elsevier.com")
      throw new TypeError("Elsevier origin is fixed");
  }
  lookup(target: AuthorizedLookupTarget): AuthorizedLookupResult {
    const value = safeIdentity(target.value);
    if (!["doi", "pii", "elsevier-article-eid"].includes(target.namespace))
      throw new AuthorizedProviderError({ code: "response-schema" });
    const namespace =
      target.namespace === "doi"
        ? "elsevier-article-pdf-doi"
        : target.namespace === "pii"
          ? "elsevier-article-pdf-pii"
          : "elsevier-article-pdf-eid";
    return {
      kind: "downloads",
      target: { namespace: target.namespace, value },
      entitlement: "unknown",
      downloads: [
        {
          namespace,
          value,
          declared_media_type: "application/pdf",
          source_record_id: value,
        },
      ],
    };
  }
  async download(
    locator: AuthorizedDownloadLocator,
    signal?: AbortSignal,
  ): Promise<AuthorizedDownloadResult> {
    const mapping: Record<string, string> = {
      "elsevier-article-pdf-doi": "doi",
      "elsevier-article-pdf-pii": "pii",
      "elsevier-article-pdf-eid": "eid",
    };
    const kind = mapping[locator.namespace];
    if (!kind && locator.namespace !== "elsevier-main-pdf-object")
      throw new AuthorizedProviderError({ code: "response-schema" });
    if (locator.namespace === "elsevier-main-pdf-object")
      return download(
        this.transport,
        locator,
        `${this.origin}/content/object/eid/${encodeURIComponent(safeIdentity(locator.value))}`,
        elsevierHeaders(this.apiKey, this.institutionToken, "application/pdf"),
        signal,
      );
    const articleUrl = `${this.origin}/content/article/${kind}?view=FULL&${kind}=${encodeURIComponent(safeIdentity(locator.value))}`;
    if (signal?.aborted)
      throw new AuthorizedProviderError({ code: "cancelled" });
    const lookup = await this.transport.request(articleUrl, {
      headers: elsevierHeaders(
        this.apiKey,
        this.institutionToken,
        "application/xml",
      ),
      ...(signal ? { signal } : {}),
    });
    if (signal?.aborted)
      throw new AuthorizedProviderError({ code: "cancelled" });
    if ([204, 404, 410].includes(lookup.status))
      return interpretDownloadResponse(locator, lookup, articleUrl);
    if (lookup.status !== 200)
      return interpretDownloadResponse(locator, lookup, articleUrl);
    const representation = mediaType(lookup);
    if (
      representation === "application/pdf" &&
      !new TextDecoder()
        .decode(lookup.body.subarray(0, 1024))
        .trimStart()
        .startsWith("<")
    )
      return interpretDownloadResponse(locator, lookup, articleUrl);
    const objects = elsevierMainObjects(lookup.body);
    if (objects?.length) {
      let normalMiss: AuthorizedDownloadResult | null = null;
      for (const value of objects) {
        const objectLocator: AuthorizedDownloadLocator = {
          namespace: "elsevier-main-pdf-object",
          value,
          declared_media_type: "application/pdf",
          source_record_id: locator.source_record_id,
        };
        const result = await this.download(objectLocator, signal);
        if (result.kind === "download") return result;
        normalMiss ??= result;
      }
      if (normalMiss) return normalMiss;
    }
    return download(
      this.transport,
      locator,
      articleUrl,
      elsevierHeaders(this.apiKey, this.institutionToken, "application/pdf"),
      signal,
    );
  }
}

export class WileyAuthorizedPdfClient {
  readonly provider = "wiley" as const;
  constructor(
    private readonly transport: AuthorizedTransport,
    private readonly tdmToken: string,
    private readonly origin = "https://api.wiley.com",
  ) {
    if (!tdmToken.trim()) throw new TypeError("Wiley TDM token is required");
    if (new URL(origin).origin !== "https://api.wiley.com")
      throw new TypeError("Wiley origin is fixed");
  }
  lookup(target: AuthorizedLookupTarget): AuthorizedLookupResult {
    if (target.namespace !== "doi")
      throw new AuthorizedProviderError({ code: "response-schema" });
    const value = safeIdentity(target.value);
    return {
      kind: "downloads",
      target: { namespace: "doi", value },
      entitlement: "unknown",
      downloads: [
        {
          namespace: "wiley-tdm-pdf",
          value,
          declared_media_type: "application/pdf",
          source_record_id: value,
        },
      ],
    };
  }
  download(
    locator: AuthorizedDownloadLocator,
    signal?: AbortSignal,
  ): Promise<AuthorizedDownloadResult> {
    if (locator.namespace !== "wiley-tdm-pdf")
      throw new AuthorizedProviderError({ code: "response-schema" });
    return download(
      this.transport,
      locator,
      `${this.origin}/onlinelibrary/tdm/v1/articles/${encodeURIComponent(safeIdentity(locator.value))}`,
      { accept: "application/pdf", "wiley-tdm-client-token": this.tdmToken },
      signal,
    );
  }
}
