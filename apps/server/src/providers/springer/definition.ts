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
  displayName: "Springer Nature",
  sourceFixture: {
    version: "v1",
    identifiers: [{ namespace: "doi", value: "10.1038/s41586-020-2649-2" }],
    record_id: null,
    evidence:
      "https://doi.org/10.1038/s41586-020-2649-2 ; public OA record, provider notes fixtures",
  },
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
