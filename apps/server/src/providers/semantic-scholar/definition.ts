import {
  provider,
  references,
  service,
  type ProviderRegistration,
} from "../contracts.js";
export const services = Object.freeze({
  "semantic-graph": service(
    "https://api.semanticscholar.org/graph/v1",
    "semantic-scholar/api/graph",
    "Semantic Scholar indexed papers",
    "semantic-scholar.md: initial keyed rate; conservative anonymous baseline",
  ),
});
export const definition = provider({
  displayName: "Semantic Scholar",
  sourceFixture: {
    version: "v1",
    identifiers: [{ namespace: "doi", value: "10.1038/s41586-020-2649-2" }],
    record_id: null,
    evidence:
      "https://doi.org/10.1038/s41586-020-2649-2 ; public OA record, provider notes fixtures",
  },
  metadata: references,
  metadataService: "semantic-graph",
  metadataAuto: true,
  acquisition: "hints",
  credentialFields: ["api_key"],
  metadataHeaders: { api_key: "x-api-key" },
});
export const registration: ProviderRegistration = Object.freeze({
  id: "semantic-scholar",
  definition,
  services,
});
