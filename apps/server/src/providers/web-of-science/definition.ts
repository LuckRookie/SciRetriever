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
