import { LITERATURE_PROVIDERS } from "./registry.js";

export type PublisherAliases = Readonly<Record<string, readonly string[]>>;

/** Only deterministic spelling differences; never infer corporate ownership. */
export function normalizePublisherName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function publisherProviderIds(): readonly string[] {
  return Object.keys(LITERATURE_PROVIDERS)
    .filter((id) => LITERATURE_PROVIDERS[id]!.publisherAliases?.length)
    .sort();
}

/** Multiple results are an unresolved conflict, not permission to select an API. */
export function resolvePublisherNames(
  name: string,
  aliases: PublisherAliases = {},
): readonly string[] {
  const normalized = normalizePublisherName(name);
  if (!normalized) return [];
  return publisherProviderIds().filter((id) =>
    [
      id,
      ...LITERATURE_PROVIDERS[id]!.publisherAliases!,
      ...(aliases[id] ?? []),
    ].some((alias) => normalizePublisherName(alias) === normalized),
  );
}

/** Existing site evidence only: no requests, DOI-prefix inference or arbitrary URLs. */
export function publisherProvidersForSite(value: string): readonly string[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [];
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password)
    return [];
  return publisherProviderIds().filter((id) => {
    const definition = LITERATURE_PROVIDERS[id]!;
    return (
      definition.doiOrigins?.includes(url.origin) ||
      definition.doiDomains?.some(
        (domain) =>
          url.hostname === domain || url.hostname.endsWith(`.${domain}`),
      )
    );
  });
}
