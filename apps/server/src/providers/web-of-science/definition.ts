import {
  DAY,
  provider,
  search,
  service,
  type ProviderRegistration,
} from "../contracts.js";
export const services = Object.freeze({
  "wos-starter": service(
    "https://api.clarivate.com/apis/wos-starter/v2",
    "web-of-science/api/starter",
    "Configured Web of Science Starter database",
    "web-of-science.md: conservative Free Trial 1 / second, 50 / day",
    { windows: [{ requests: 50, durationMs: DAY }] },
  ),
  "wos-expanded": service(
    "https://wos-api.clarivate.com/api/wos",
    "web-of-science/api/expanded",
    "Configured Web of Science Expanded database",
    "web-of-science.md: Basic 2 / second; record allowance requires account feedback",
    { minimumIntervalMs: 500 },
  ),
});
export const definition = provider({
  displayName: "Web of Science",
  configurationFields: [
    {
      field: "product",
      label: "Product",
      type: { kind: "enum", values: ["starter", "expanded"] },
      required: true,
      needed_for: ["topic-search", "lookup", "reference-query"],
    },
    {
      field: "database",
      label: "Database",
      type: { kind: "string", format: "nonempty" },
      required: true,
      needed_for: ["topic-search", "lookup", "reference-query"],
    },
    {
      field: "edition",
      label: "Edition",
      type: { kind: "string", format: "nonempty" },
      required: false,
      needed_for: ["topic-search", "lookup", "reference-query"],
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
  metadataService: "wos-starter",
  acquisition: "none",
  credentialFields: ["api_key"],
  requiredMetadataCredential: "api_key",
  metadataHeaders: { api_key: "x-apikey" },
});
export const registration: ProviderRegistration = Object.freeze({
  id: "web-of-science",
  definition,
  services,
  metadataServiceFor: (endpoint: string) =>
    new URL(endpoint).hostname === "wos-api.clarivate.com"
      ? "wos-expanded"
      : "wos-starter",
});
