import type {
  AuthorizedPdfClientPort,
  AcquisitionSourceRequest,
} from "../../acquisition/ports.js";
import { targetsForDefinition } from "../shared/acquisition-locators.js";
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
export class CoreAuthorizedPdfClient implements AuthorizedPdfClientPort {
  readonly provider = "core" as const;
  constructor(
    private readonly transport: AuthorizedTransport,
    private readonly apiKey: string,
    private readonly origin = services["core-v3"].endpoint,
  ) {
    if (!apiKey.trim()) throw new TypeError("CORE API key is required");
    if (new URL(origin).origin !== services["core-v3"].endpoint)
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
export function targets(
  request: AcquisitionSourceRequest,
): readonly AuthorizedLookupTarget[] {
  const targets = [...targetsForDefinition(definition, request)];
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
export function candidateUrl(locator: AuthorizedDownloadLocator): string {
  const value = encodeURIComponent(locator.value);

  const entity = locator.namespace === "core-work-pdf" ? "works" : "outputs";
  return `${services["core-v3"].endpoint}/v3/${entity}/${value}/download`;
}
