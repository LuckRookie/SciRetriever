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
