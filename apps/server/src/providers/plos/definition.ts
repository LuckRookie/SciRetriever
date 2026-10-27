import { provider, service, type ProviderRegistration } from "../contracts.js";
export const services = Object.freeze({
  "plos-web": service(
    "https://journals.plos.org",
    "plos/web",
    "PLOS journal pages and files",
    "plos.md: robots crawl delay 30 seconds",
    { minimumIntervalMs: 30_000 },
  ),
});
export const definition = provider({
  displayName: "PLOS",
  publisherAliases: [
    "PLOS",
    "Public Library of Science (PLoS)",
    "Public Library of Science",
  ],
  metadata: [],
  acquisition: "none",
  credentialFields: [],
});
export const registration: ProviderRegistration = Object.freeze({
  id: "plos",
  definition,
  services,
  webServiceFor: (url: URL) =>
    url.hostname === "journals.plos.org"
      ? Object.freeze({ ...services["plos-web"], endpoint: url.origin })
      : undefined,
});
