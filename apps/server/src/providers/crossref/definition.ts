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
  displayName: "Crossref",
  configurationFields: [
    {
      field: "mode",
      label: "Mode",
      type: { kind: "enum", values: ["anonymous", "polite"] },
      required: false,
      needed_for: ["topic-search", "lookup"],
      default_value: "anonymous",
    },
    {
      field: "mailto",
      label: "Contact email",
      type: { kind: "string", format: "email" },
      required: false,
      required_when: { field: "mode", equals: "polite" },
      needed_for: ["topic-search", "lookup"],
    },
  ],
  sourceFixture: {
    version: "v1",
    identifiers: [{ namespace: "doi", value: "10.1038/s41586-020-2649-2" }],
    record_id: null,
    evidence:
      "https://doi.org/10.1038/s41586-020-2649-2 ; public OA record, provider notes fixtures",
  },
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
