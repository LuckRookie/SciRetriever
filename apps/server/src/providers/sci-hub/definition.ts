import { provider, type ProviderRegistration } from "../contracts.js";
export const BUILTIN_SCI_HUB_MIRROR_URLS = Object.freeze([
  "https://sci-hub.ru",
] as const);
export const services = Object.freeze({});
export const definition = provider({
  displayName: "Sci-Hub",
  configurationFields: [
    {
      field: "urls",
      label: "Mirrors",
      type: {
        kind: "string-array",
        format: "mirror-https",
        min_items: 1,
        max_items: 8,
      },
      required: false,
      needed_for: ["pdf"],
      default_value: BUILTIN_SCI_HUB_MIRROR_URLS,
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
  acquisitionAuto: true,
  acquisitionStage: "public-web",
  credentialFields: [],
});
export const registration: ProviderRegistration = Object.freeze({
  id: "sci-hub",
  definition,
  services,
});
