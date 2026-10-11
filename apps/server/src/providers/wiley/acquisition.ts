import type {
  AuthorizedPdfClientPort,
  AcquisitionSourceRequest,
} from "../../acquisition/ports.js";
import {
  targetsForDefinition,
  articleHintTargets,
  uniqueTargets,
} from "../shared/acquisition-locators.js";
import {
  AuthorizedProviderError,
  download,
  safeIdentity,
  type AuthorizedDownloadLocator,
  type AuthorizedDownloadResult,
  type AuthorizedLookupResult,
  type AuthorizedLookupTarget,
  type AuthorizedTransport,
} from "../shared/authorized-pdf.js";
import { definition, services } from "./definition.js";
export class WileyAuthorizedPdfClient implements AuthorizedPdfClientPort {
  readonly provider = "wiley" as const;
  constructor(
    private readonly transport: AuthorizedTransport,
    private readonly tdmToken: string,
    private readonly origin = services["wiley-tdm"].endpoint,
  ) {
    if (!tdmToken.trim()) throw new TypeError("Wiley TDM token is required");
    if (new URL(origin).origin !== services["wiley-tdm"].endpoint)
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
export function targets(
  request: AcquisitionSourceRequest,
): readonly AuthorizedLookupTarget[] {
  return uniqueTargets([
    ...targetsForDefinition(definition, request),
    ...articleHintTargets(request, services["wiley-tdm"].endpoint, (path) => {
      const match = /^\/onlinelibrary\/tdm\/v1\/articles\/(.+)$/u.exec(path);
      return match
        ? {
            namespace: "doi",
            value: safeIdentity(decodeURIComponent(match[1]!)),
          }
        : null;
    }),
  ]);
}
export function candidateUrl(locator: AuthorizedDownloadLocator): string {
  const value = encodeURIComponent(locator.value);
  return `${services["wiley-tdm"].endpoint}/onlinelibrary/tdm/v1/articles/${value}`;
}
