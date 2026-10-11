import {
  DAY,
  MINUTE,
  provider,
  search,
  service,
  type ProviderRegistration,
} from "../contracts.js";
export const services = Object.freeze({
  "springer-meta": service(
    "https://api.springernature.com/meta/v2/json",
    "springer/api/meta-v2",
    "Springer Nature metadata product",
    "springer-nature.md: Basic 100 / minute, 500 / day",
    {
      minimumIntervalMs: 600,
      windows: [
        { requests: 100, durationMs: MINUTE },
        { requests: 500, durationMs: DAY },
      ],
    },
  ),
});
export const definition = provider({
  publisherAliases: [
    "Springer",
    "Springer Nature",
    "Springer Science and Business Media LLC",
    "Springer Science+Business Media",
    "Springer Science and Business Media",
  ],
  metadata: search,
  metadataService: "springer-meta",
  metadataQuery: { api_key: "api_key" },
  acquisition: "hints",
  credentialFields: ["api_key", "api_metric"],
  requiredMetadataCredential: "api_key",
});
export const registration: ProviderRegistration = Object.freeze({
  id: "springer",
  definition,
  services,
});
