import {
  MINUTE,
  provider,
  references,
  service,
  type ProviderRegistration,
} from "../contracts.js";

// CORE redirects the slashless search route before returning metadata.
export const CORE_SEARCH_WORKS_PATH = "/v3/search/works/";

export const services = Object.freeze({
  "core-v3": service(
    "https://api.core.ac.uk",
    "core/api/v3",
    "CORE records and available files; download requires key",
    "core.md: conservative 10 / minute; token costs are not request counts",
    {
      minimumIntervalMs: 6000,
      windows: [{ requests: 10, durationMs: MINUTE }],
    },
  ),
});
export const definition = provider({
  displayName: "CORE",
  sourceFixture: {
    version: "v1",
    identifiers: [{ namespace: "core-work", value: "143262545" }],
    record_id: "143262545",
    evidence:
      "docs/notes/providers/core.md section 9; CORE aggregation service OA paper",
  },
  metadata: references,
  metadataService: "core-v3",
  metadataAuto: true,
  acquisition: "authorized-api",
  acquisitionStage: "general-api",
  pdfHeaders: { api_key: "authorization" },
  acquisitionService: "core-v3",
  credentialFields: ["api_key"],
  requiredPdfCredential: "api_key",
  metadataHeaders: { api_key: "authorization" },
  pdfIdentifiers: ["core-work", "core-output"],
});
export const registration: ProviderRegistration = Object.freeze({
  id: "core",
  definition,
  services,
});
