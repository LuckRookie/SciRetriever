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
