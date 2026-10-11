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

export function requestHints(request: AcquisitionSourceRequest) {
  return [
    ...(request.asset_hints ?? []),
    ...(request.observations ?? []).flatMap((item) => item.asset_hints),
  ].filter(
    (hint) =>
      !["supplementary", "supplementary-pdf"].includes(hint.asset_role ?? "") &&
      (request.target_version === undefined ||
        hint.version_role === null ||
        hint.version_role === request.target_version),
  );
}
function requestOrigins(
  request: AcquisitionSourceRequest,
): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of [
    ...requestHints(request).map((hint) => hint.url),
    ...(request.landing_origins ?? []),
  ]) {
    try {
      const url = new URL(value);
      if (
        url.protocol === "https:" &&
        !url.port &&
        !url.username &&
        !url.password
      )
        origins.add(url.origin);
    } catch {
      // Invalid hints cannot establish provider applicability.
    }
  }
  return origins;
}
/** A provider's documented article API may supply typed targets, never arbitrary URLs. */
export function articleHintTargets(
  request: AcquisitionSourceRequest,
  origin: string,
  parsePath: (path: string) => AuthorizedLookupTarget | null,
): readonly AuthorizedLookupTarget[] {
  const targets: AuthorizedLookupTarget[] = [];
  const dois = new Set(
    values(request, "doi").map((value) => value.toLowerCase()),
  );
  for (const hint of requestHints(request)) {
    try {
      const url = new URL(hint.url);
      if (url.origin !== origin || url.username || url.password) continue;
      const target = parsePath(url.pathname);
      if (!target || !target.value) continue;
      if (
        target.namespace === "doi" &&
        (dois.size !== 1 || !dois.has(target.value.toLowerCase()))
      )
        continue;
      targets.push(target);
    } catch {
      // A malformed vendor locator is not routing evidence.
    }
  }
  return targets;
}
export function uniqueTargets(
  targets: readonly AuthorizedLookupTarget[],
): readonly AuthorizedLookupTarget[] {
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
export function targetsForDefinition(
  definition: ProviderDefinition,
  request: AcquisitionSourceRequest,
): readonly AuthorizedLookupTarget[] {
  const origins = requestOrigins(request);
  const allowsDoi =
    new Set(values(request, "doi").map((value) => value.toLowerCase())).size ===
      1 &&
    [...origins].some(
      (origin) =>
        definition.doiOrigins?.includes(origin) ||
        definition.doiDomains?.some(
          (domain) =>
            new URL(origin).hostname === domain ||
            new URL(origin).hostname.endsWith(`.${domain}`),
        ),
    );
  const targets: AuthorizedLookupTarget[] = [];
  for (const identifier of request.identifiers) {
    const namespace = identifier.namespace.toLowerCase();
    const supported =
      definition.pdfIdentifiers?.includes(namespace) ||
      (namespace === "doi" && allowsDoi);
    if (supported) targets.push({ namespace, value: identifier.value.trim() });
  }
  return uniqueTargets(targets);
}
