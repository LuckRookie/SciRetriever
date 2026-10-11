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
