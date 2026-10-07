import {
  MINUTE,
  provider,
  references,
  service,
  type ProviderRegistration,
} from "../contracts.js";
export const services = Object.freeze({
  "datacite-rest": service(
    "https://api.datacite.org",
    "datacite/api/rest",
    "DataCite DOI records",
    "datacite.md: unidentified 500 / 5 minutes",
    {
      minimumIntervalMs: 600,
      windows: [{ requests: 500, durationMs: 5 * MINUTE }],
    },
  ),
});
export const definition = provider({
  metadata: references,
  metadataService: "datacite-rest",
  metadataAuto: true,
  acquisition: "hints",
  credentialFields: [],
});
export const registration: ProviderRegistration = Object.freeze({
  id: "datacite",
  definition,
  services,
});
