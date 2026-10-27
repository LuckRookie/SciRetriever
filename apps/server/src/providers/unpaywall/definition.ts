import {
  DAY,
  provider,
  service,
  type ProviderRegistration,
} from "../contracts.js";
export const services = Object.freeze({
  unpaywall: service(
    "https://api.unpaywall.org",
    "unpaywall/api",
    "DOIs with available OA locations",
    "unpaywall.md: recommended 100000 / day; concurrency/interval project defaults",
    { windows: [{ requests: 100000, durationMs: DAY }] },
  ),
});
export const definition = provider({
  displayName: "Unpaywall",
  configurationFields: [
    {
      field: "contact_email",
      label: "Contact email",
      type: { kind: "string", format: "email" },
      required: true,
      needed_for: ["pdf"],
    },
  ],
  sourceFixture: {
    version: "v1",
    identifiers: [{ namespace: "doi", value: "10.1038/s41586-020-2649-2" }],
    record_id: null,
    evidence:
      "https://doi.org/10.1038/s41586-020-2649-2 ; public OA record, provider notes fixtures",
  },
  metadata: [],
  acquisition: "public",
  acquisitionStage: "general-api",
  acquisitionService: "unpaywall",
  credentialFields: [],
});
export const registration: ProviderRegistration = Object.freeze({
  id: "unpaywall",
  definition,
  services,
});
