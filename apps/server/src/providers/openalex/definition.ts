import {
  provider,
  references,
  service,
  type ProviderRegistration,
} from "../contracts.js";
export const services = Object.freeze({
  "openalex-works": service(
    "https://api.openalex.org",
    "openalex/api/works",
    "OpenAlex indexed works",
    "project-default: request cost depends on operation/account; no invented daily request quota",
  ),
});
export const definition = provider({
  displayName: "OpenAlex",
  sourceFixture: {
    version: "v1",
    identifiers: [{ namespace: "doi", value: "10.1038/s41586-020-2649-2" }],
    record_id: null,
    evidence:
      "https://doi.org/10.1038/s41586-020-2649-2 ; public OA record, provider notes fixtures",
  },
  metadata: references,
  metadataService: "openalex-works",
  metadataQuery: { api_key: "api_key" },
  metadataAuto: true,
  acquisition: "hints",
  credentialFields: ["api_key"],
});
export const registration: ProviderRegistration = Object.freeze({
  id: "openalex",
  definition,
  services,
});
