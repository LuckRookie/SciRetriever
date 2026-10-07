import {
  provider,
  search,
  service,
  type ProviderRegistration,
} from "../contracts.js";
export const services = Object.freeze({
  "arxiv-query": service(
    "https://export.arxiv.org/api/query",
    "arxiv/access",
    "arXiv records",
    "arxiv.md: API terms, one connection / 3 seconds",
    { minimumIntervalMs: 3000 },
  ),
  "arxiv-pdf": service(
    "https://arxiv.org",
    "arxiv/access",
    "arXiv identified files",
    "project-conservative: share arXiv API pacing for downloads",
    { minimumIntervalMs: 3000 },
  ),
});
export const definition = provider({
  metadata: search,
  metadataFormat: "atom",
  metadataService: "arxiv-query",
  metadataAuto: true,
  acquisition: "public",
  acquisitionService: "arxiv-pdf",
  acquisitionAuto: true,
  credentialFields: [],
});
export const registration: ProviderRegistration = Object.freeze({
  id: "arxiv",
  definition,
  services,
  webHosts: { "arxiv.org": "arxiv-pdf", "export.arxiv.org": "arxiv-pdf" },
});
