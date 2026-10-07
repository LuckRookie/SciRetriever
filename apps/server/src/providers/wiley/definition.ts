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
  metadata: [],
  acquisition: "authorized-api",
  pdfHeaders: { tdm_api_token: "wiley-tdm-client-token" },
  acquisitionService: "wiley-tdm",
  credentialFields: ["tdm_api_token"],
  requiredPdfCredential: "tdm_api_token",
  pdfIdentifiers: [],
  doiOrigins: ["https://onlinelibrary.wiley.com", "https://alm.wiley.com"],
});
export const registration: ProviderRegistration = Object.freeze({
  id: "wiley",
  definition,
  services,
});
