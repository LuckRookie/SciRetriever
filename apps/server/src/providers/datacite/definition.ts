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
  displayName: "DataCite",
  sourceFixture: {
    version: "v1",
    identifiers: [{ namespace: "doi", value: "10.5281/zenodo.3727209" }],
    record_id: null,
    evidence: "docs/notes/providers/datacite.md representative public response",
  },
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
