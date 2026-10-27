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
  displayName: "Europe PMC",
  sourceFixture: {
    version: "v1",
    identifiers: [{ namespace: "pmcid", value: "PMC7759461" }],
    record_id: "PMC7759461",
    evidence: "https://europepmc.org/articles/PMC7759461",
  },
  metadata: references,
  metadataService: "europe-pmc-rest",
  metadataAuto: true,
  acquisition: "public",
  acquisitionStage: "direct",
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
