import type { AcquisitionSourceRequest } from "../../acquisition/ports.js";
import type { SourceCandidate } from "../../acquisition/sources/locators.js";
import type { ProviderDefinition } from "../contracts.js";
import type { AuthorizedLookupTarget } from "./authorized-pdf.js";
export function values(
  request: AcquisitionSourceRequest,
  namespace: string,
): readonly string[] {
  return request.identifiers
    .filter((item) => item.namespace.toLowerCase() === namespace)
    .map((item) => item.value.trim())
    .filter(Boolean);
}
export function dedupe(
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
export function targetsForDefinition(
  definition: ProviderDefinition,
  request: AcquisitionSourceRequest,
): readonly AuthorizedLookupTarget[] {
  const origins = requestOrigins(request);
  const allowsDoi =
    definition.doiOrigins?.some((origin) => origins.has(origin)) ?? false;
  const targets: AuthorizedLookupTarget[] = [];
  for (const identifier of request.identifiers) {
    const namespace = identifier.namespace.toLowerCase();
    const supported =
      definition.pdfIdentifiers?.includes(namespace) ||
      (namespace === "doi" && allowsDoi);
    if (supported) targets.push({ namespace, value: identifier.value.trim() });
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
