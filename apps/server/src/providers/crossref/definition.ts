import {
  provider,
  search,
  SECOND,
  service,
  type ProviderRegistration,
} from "../contracts.js";
export const services = Object.freeze({
  "crossref-rest": service(
    "https://api.crossref.org",
    "crossref/api/rest",
    "Crossref registered works",
    "crossref.md: public pool; conservative for polite",
    {
      minimumIntervalMs: 200,
      windows: [{ requests: 5, durationMs: SECOND }],
    },
  ),
});
export const definition = provider({
  metadata: search,
  metadataService: "crossref-rest",
  metadataAuto: true,
  acquisition: "hints",
  credentialFields: [],
});
export const registration: ProviderRegistration = Object.freeze({
  id: "crossref",
  definition,
  services,
});
