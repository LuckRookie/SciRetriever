import {
  invalid,
  safeLocator,
  type SourceCandidate,
} from "../../acquisition/sources/locators.js";
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
