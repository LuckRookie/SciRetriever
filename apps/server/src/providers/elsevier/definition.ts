import {
  DAY,
  provider,
  search,
  service,
  type ProviderRegistration,
} from "../contracts.js";
export const services = Object.freeze({
  "elsevier-search": service(
    "https://api.elsevier.com",
    "elsevier/api/scopus-search",
    "Scopus indexed works across publishers",
    "elsevier.md: 9 / second and 20000 / week; conservative rolling window",
    {
      minimumIntervalMs: 125,
      windows: [{ requests: 20000, durationMs: 7 * DAY }],
    },
  ),
  "elsevier-abstract": service(
    "https://api.elsevier.com",
    "elsevier/api/abstract-retrieval",
    "Scopus record retrieval",
    "elsevier.md: 9 / second and 10000 / week; conservative rolling window",
    {
      minimumIntervalMs: 125,
      windows: [{ requests: 10000, durationMs: 7 * DAY }],
    },
  ),
  "elsevier-article": service(
    "https://api.elsevier.com",
    "elsevier/api/article-retrieval-object",
    "Elsevier content-service articles with entitlement",
    "elsevier.md: article/object conservative shared 10 / second, 50000 / week",
    {
      minimumIntervalMs: 100,
      windows: [{ requests: 50000, durationMs: 7 * DAY }],
    },
  ),
});
export const definition = provider({
  publisherAliases: [
    "Elsevier",
    "Elsevier BV",
    "Elsevier B.V.",
    "Elsevier Ltd",
    "Elsevier Inc.",
  ],
  metadata: search,
  metadataService: "elsevier-search",
  acquisition: "authorized-api",
  acquisitionStage: "publisher-api",
  pdfHeaders: { api_key: "x-els-apikey", institution_token: "x-els-insttoken" },
  acquisitionService: "elsevier-article",
  credentialFields: ["api_key", "institution_token"],
  requiredMetadataCredential: "api_key",
  requiredPdfCredential: "api_key",
  metadataHeaders: {
    api_key: "x-els-apikey",
    institution_token: "x-els-insttoken",
  },
  pdfIdentifiers: ["pii", "elsevier-article-eid"],
  doiOrigins: [
    "https://www.sciencedirect.com",
    "https://linkinghub.elsevier.com",
    "https://pdf.sciencedirectassets.com",
  ],
});
export const registration: ProviderRegistration = Object.freeze({
  id: "elsevier",
  definition,
  services,
  metadataServiceFor: (endpoint: string) =>
    new URL(endpoint).pathname.startsWith("/content/abstract/")
      ? "elsevier-abstract"
      : "elsevier-search",
});
