import {
  MINUTE,
  provider,
  service,
  type ProviderRegistration,
} from "../contracts.js";
export const services = Object.freeze({
  opencitations: service(
    "https://api.opencitations.net",
    "opencitations/api",
    "OpenCitations Meta and Index",
    "opencitations.md: conservative shared 180 / minute",
    {
      minimumIntervalMs: 334,
      windows: [{ requests: 180, durationMs: MINUTE }],
    },
  ),
});
export const definition = provider({
  displayName: "OpenCitations",
  sourceFixture: {
    version: "v1",
    identifiers: [{ namespace: "doi", value: "10.1038/s41586-020-2649-2" }],
    record_id: null,
    evidence:
      "https://doi.org/10.1038/s41586-020-2649-2 ; public OA record, provider notes fixtures",
  },
  metadata: ["lookup", "reference-query"],
  metadataService: "opencitations",
  acquisition: "none",
  credentialFields: ["access_token"],
  metadataHeaders: { access_token: "authorization" },
});
export const registration: ProviderRegistration = Object.freeze({
  id: "opencitations",
  definition,
  services,
});
