import type {
  AcquisitionAttempt,
  Identifier,
  MetadataObservation,
  VersionRole,
} from "@sciretriever/contracts";
import { publisherProvidersForSite } from "../providers/publisher-names.js";
import { isAuthorizedAcquisitionUrl } from "../providers/registry.js";
import type { HttpResponse } from "../network/http.js";
import {
  doiLanding,
  SourceLocatorError,
} from "../acquisition/sources/locators.js";

/** Current-operation evidence only; public failures never blacklist Browser transport. */
export interface AcquisitionContext {
  readonly attempts: AcquisitionAttempt[];
  readonly landing_origins: Set<string>;
  readonly landing_urls: string[];
  readonly attempted_locators: Set<string>;
  readonly failed_urls: Set<string>;
  doi_landing: string | null;
  doi_response: {
    readonly url: string;
    readonly response: HttpResponse;
  } | null;
}

export function createAcquisitionContext(): AcquisitionContext {
  return {
    attempts: [],
    landing_origins: new Set(),
    landing_urls: [],
    attempted_locators: new Set(),
    failed_urls: new Set(),
    doi_landing: null,
    doi_response: null,
  };
}

export function articleUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function doiStartUrl(identifiers: readonly Identifier[]): string | null {
  const values = [
    ...new Set(
      identifiers
        .filter((identifier) => identifier.namespace.toLowerCase() === "doi")
        .map((identifier) => identifier.value.trim()),
    ),
  ];
  if (values.length !== 1) return null;
  try {
    return doiLanding(values[0]!).locator;
  } catch (error) {
    if (error instanceof SourceLocatorError) return null;
    throw error;
  }
}

/** Article locators, not guesses based on a title or publisher display name. */
export function browserStartUrls(
  observations: readonly MetadataObservation[],
  targetVersion: VersionRole,
  identifiers: readonly Identifier[] = [],
  context?: AcquisitionContext,
): readonly string[] {
  const hints = observations
    .flatMap((observation) => observation.asset_hints)
    .filter(
      (hint) =>
        hint.kind === "landing-page" &&
        (hint.version_role === null || hint.version_role === targetVersion) &&
        !["supplementary", "supplementary-pdf", "xml"].includes(
          hint.asset_role ?? "",
        ),
    );
  const hintsFor = (version: VersionRole | null) =>
    hints
      .filter((hint) => hint.version_role === version)
      .map((hint) => (hint.url.includes("#") ? null : articleUrl(hint.url)))
      .filter((url): url is string => url !== null);
  const preferPublisher = (urls: readonly string[]) => [
    ...urls.filter((url) => publisherProvidersForSite(url).length > 0),
    ...urls.filter((url) => publisherProvidersForSite(url).length === 0),
  ];
  // A known platform cannot outrank an explicitly matching document version.
  const orderedHints = [
    ...preferPublisher(hintsFor(targetVersion)),
    ...preferPublisher(hintsFor(null)),
  ];
  const doi = doiStartUrl(identifiers);
  const alternatives: string[] = [];
  for (const identifier of identifiers) {
    const value = identifier.value.trim();
    const kind = identifier.namespace.toLowerCase();
    if (kind === "pmid" && /^[1-9]\d*$/u.test(value))
      alternatives.push(`https://pubmed.ncbi.nlm.nih.gov/${value}/`);
    if (kind === "pmcid" && /^PMC\d+$/iu.test(value))
      alternatives.push(
        `https://pmc.ncbi.nlm.nih.gov/articles/${value.toUpperCase()}/`,
      );
    if (
      kind === "arxiv" &&
      /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/iu.test(
        value,
      )
    )
      alternatives.push(
        `https://arxiv.org/abs/${value.split("/").map(encodeURIComponent).join("/")}`,
      );
  }
  const candidates = [
    ...(context?.landing_urls ?? []),
    ...orderedHints,
    ...(doi ? [doi] : []),
    ...alternatives,
  ];
  const unique = [
    ...new Set(
      candidates
        .map(articleUrl)
        .filter(
          (url): url is string =>
            url !== null && !isAuthorizedAcquisitionUrl(url),
        ),
    ),
  ];
  // HTTP failures lower priority only; they cannot remove the browser's opportunity.
  return Object.freeze([
    ...unique.filter((url) => !context?.failed_urls.has(url)),
    ...unique.filter((url) => context?.failed_urls.has(url)),
  ]);
}
