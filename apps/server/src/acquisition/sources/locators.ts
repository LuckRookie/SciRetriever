export interface SourceCandidate {
  readonly source: string;
  readonly requester?: string;
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
export function invalid(): never {
  throw new SourceLocatorError();
}

export function candidate(
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

export function doiLanding(doi: string): SourceCandidate {
  if (!/^10\.\d{4,9}\/[^\s?#]+$/iu.test(doi)) invalid();
  return candidate(
    "doi-landing",
    `${DOI_RESOLVER_ORIGIN}/${doi.split("/").map(encodeURIComponent).join("/")}`,
    "landing",
    null,
    ["doi"],
  );
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

export const DOI_RESOLVER_ORIGIN = "https://doi.org";
