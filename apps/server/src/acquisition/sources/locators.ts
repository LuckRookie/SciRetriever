export interface SourceCandidate {
  readonly source: string;
  readonly locator: string;
  readonly kind: "pdf" | "landing";
  readonly source_record_id: string | null;
  readonly version: string | null;
  readonly evidence: readonly string[];
}
export class SourceLocatorError extends Error {
  readonly code = "source-locator" as const;
  constructor() {
    super("source locator operation failed");
    this.name = "SourceLocatorError";
  }
}
function invalid(): never {
  throw new SourceLocatorError();
}

function candidate(
  source: string,
  locator: string,
  kind: "pdf" | "landing",
  version: string | null,
  evidence: readonly string[],
): SourceCandidate {
  if (!source || !locator || locator.length > 8192) invalid();
  return Object.freeze({
    source,
    locator,
    kind,
    source_record_id: null,
    version,
    evidence: Object.freeze([...evidence]),
  });
}
export function safeLocator(
  source: string,
  value: string,
  kind: "pdf" | "landing" = "pdf",
): SourceCandidate {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.hash
  )
    invalid();
  for (const key of url.searchParams.keys())
    if (/(?:token|key|secret|sig|auth|password|cookie)/iu.test(key)) invalid();
  return candidate(source, url.toString(), kind, null, ["explicit-locator"]);
}
export function arxivPdf(
  identifier: string,
  version?: string,
): SourceCandidate {
  if (!/^(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?$/iu.test(identifier))
    invalid();
  const normalizedVersion =
    version === undefined
      ? null
      : /^v\d+$/u.test(version)
        ? version
        : invalid();
  const value = identifier.replace(/v\d+$/u, "");
  return candidate(
    "arxiv",
    `https://arxiv.org/pdf/${value}${normalizedVersion ?? ""}.pdf`,
    "pdf",
    normalizedVersion,
    ["arxiv-identifier"],
  );
}
export function europePmcPdf(identifier: string): SourceCandidate {
  if (!/^(?:PMC\d+|MED\d+)$/iu.test(identifier)) invalid();
  return candidate(
    "europe-pmc",
    `https://europepmc.org/articles/${identifier}/bin/${identifier}.pdf`,
    "pdf",
    null,
    ["europe-pmc-identifier"],
  );
}
export function doiLanding(doi: string): SourceCandidate {
  if (!/^10\.\d{4,9}\/[._;()/:a-z0-9-]+$/iu.test(doi) || /[\s?#]/u.test(doi))
    invalid();
  return candidate(
    "doi-landing",
    `https://doi.org/${encodeURIComponent(doi)}`,
    "landing",
    null,
    ["doi"],
  );
}
export interface OpenLocation {
  readonly url?: string;
  readonly version?: string;
  readonly host_type?: string;
}
export function unpaywallLocations(
  locations: readonly (OpenLocation & { readonly direct_pdf?: boolean })[],
): readonly SourceCandidate[] {
  if (!Array.isArray(locations)) invalid();
  return Object.freeze(
    locations.flatMap((location) => {
      if (!location.url) return [];
      try {
        const result = safeLocator(
          "unpaywall",
          location.url,
          location.direct_pdf ? "pdf" : "landing",
        );
        return [
          Object.freeze({
            ...result,
            version: location.version ?? null,
            evidence: Object.freeze([
              "open-location",
              ...(location.host_type ? [location.host_type] : []),
            ]),
          }),
        ];
      } catch {
        return [];
      }
    }),
  );
}
export function configuredMirrors(
  enabled: boolean,
  custom: readonly string[] = [],
): readonly SourceCandidate[] {
  if (!Array.isArray(custom)) invalid();
  const values = custom.map((value) =>
    safeLocator("configured-mirror", value, "landing"),
  );
  return enabled ? Object.freeze(values) : Object.freeze([]);
}
export function authorizedLocator(
  source: "core" | "elsevier" | "wiley",
  locator: string,
  grant: { readonly origin: string; readonly allowed: boolean },
): SourceCandidate {
  const result = safeLocator(source, locator);
  if (!grant.allowed || new URL(result.locator).origin !== grant.origin)
    invalid();
  return Object.freeze({
    ...result,
    evidence: Object.freeze(["authorized-origin"]),
  });
}
