import {
  MINUTE,
  provider,
  service,
  type ProviderRegistration,
} from "../contracts.js";
export const services = Object.freeze({
  "wiley-tdm": service(
    "https://api.wiley.com",
    "wiley/api/tdm",
    "Wiley TDM content covered by current token",
    "wiley.md: 3 / second and 60 / 10 minutes; single concurrency is conservative",
    {
      minimumIntervalMs: 334,
      windows: [{ requests: 60, durationMs: 10 * MINUTE }],
    },
  ),
});
export const definition = provider({
  publisherAliases: [
    "Wiley",
    "John Wiley & Sons",
    "John Wiley and Sons",
    "Wiley-Blackwell",
    "Wiley Blackwell",
  ],
  metadata: [],
  acquisition: "authorized-api",
  acquisitionStage: "publisher-api",
  pdfHeaders: { tdm_api_token: "wiley-tdm-client-token" },
  acquisitionService: "wiley-tdm",
  credentialFields: ["tdm_api_token"],
  requiredPdfCredential: "tdm_api_token",
  pdfIdentifiers: [],
  doiDomains: ["onlinelibrary.wiley.com"],
  doiOrigins: ["https://onlinelibrary.wiley.com", "https://alm.wiley.com"],
});
export const registration: ProviderRegistration = Object.freeze({
  id: "wiley",
  definition,
  services,
});

/** Official TDM delivery redirect; the opaque path is never durable provenance. */
export const downloadOrigin = "https://alm.wiley.com";
export function allowsDownloadRedirect(from: URL, to: URL): boolean {
  return (
    from.origin === services["wiley-tdm"].endpoint &&
    from.pathname.startsWith("/onlinelibrary/tdm/v1/articles/") &&
    to.origin === downloadOrigin &&
    !to.username &&
    !to.password &&
    !to.search &&
    !to.hash &&
    /^\/alm\/api\/v2\/download\/[A-Za-z0-9_%+=.-]+$/u.test(to.pathname)
  );
}
