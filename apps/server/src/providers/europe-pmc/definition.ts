import {
  provider,
  references,
  service,
  type ProviderRegistration,
} from "../contracts.js";
export const services = Object.freeze({
  "europe-pmc-rest": service(
    "https://www.ebi.ac.uk/europepmc/webservices/rest",
    "europe-pmc/access",
    "Europe PMC indexed records",
    "europe-pmc.md: project default, no verified official numeric limit",
  ),
  "europe-pmc-pdf": service(
    "https://europepmc.org",
    "europe-pmc/access",
    "Available PMC full text by PMCID",
    "europe-pmc.md: conservative shared access baseline",
  ),
});
export const definition = provider({
  metadata: references,
  metadataService: "europe-pmc-rest",
  metadataAuto: true,
  acquisition: "public",
  acquisitionService: "europe-pmc-pdf",
  acquisitionAuto: true,
  credentialFields: [],
});
export const registration: ProviderRegistration = Object.freeze({
  id: "europe-pmc",
  definition,
  services,
  webHosts: {
    "europepmc.org": "europe-pmc-pdf",
    "www.europepmc.org": "europe-pmc-pdf",
  },
});
