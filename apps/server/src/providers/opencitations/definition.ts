import {
  MINUTE,
  provider,
  service,
  type ProviderRegistration,
} from "../contracts.js";
export const services = Object.freeze({
  opencitations: service(
    "https://api.opencitations.net",
    "opencitations/api",
    "OpenCitations Meta and Index",
    "opencitations.md: conservative shared 180 / minute",
    {
      minimumIntervalMs: 334,
      windows: [{ requests: 180, durationMs: MINUTE }],
    },
  ),
});
export const definition = provider({
  metadata: ["lookup", "reference-query"],
  metadataService: "opencitations",
  acquisition: "none",
  credentialFields: ["access_token"],
  metadataHeaders: { access_token: "authorization" },
});
export const registration: ProviderRegistration = Object.freeze({
  id: "opencitations",
  definition,
  services,
});
