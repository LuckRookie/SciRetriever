import { registration as arxiv } from "./arxiv/definition.js";
import {
  service,
  type ProviderDefinition,
  type ProviderRegistration,
  type ServiceDefinition,
} from "./contracts.js";
import { registration as core } from "./core/definition.js";
import { registration as crossref } from "./crossref/definition.js";
import { registration as datacite } from "./datacite/definition.js";
import { registration as elsevier } from "./elsevier/definition.js";
import { registration as europePmc } from "./europe-pmc/definition.js";
import { registration as openalex } from "./openalex/definition.js";
import { registration as opencitations } from "./opencitations/definition.js";
import { registration as plos } from "./plos/definition.js";
import { registration as sciHub } from "./sci-hub/definition.js";
import { registration as semanticScholar } from "./semantic-scholar/definition.js";
import { registration as springer } from "./springer/definition.js";
import { registration as unpaywall } from "./unpaywall/definition.js";
import { registration as webOfScience } from "./web-of-science/definition.js";
import { registration as wiley } from "./wiley/definition.js";
const registrations: readonly ProviderRegistration[] = Object.freeze([
  webOfScience,
  crossref,
  semanticScholar,
  arxiv,
  openalex,
  europePmc,
  elsevier,
  springer,
  datacite,
  core,
  opencitations,
  unpaywall,
  wiley,
  sciHub,
  plos,
]);
export const LITERATURE_PROVIDERS: Readonly<
  Record<string, ProviderDefinition>
> = Object.freeze(
  Object.fromEntries(registrations.map((p) => [p.id, p.definition])),
);
export const PROVIDER_SERVICES: Readonly<Record<string, ServiceDefinition>> =
  Object.freeze(
    Object.fromEntries(
      registrations.flatMap((p) => Object.entries(p.services)),
    ),
  );
export const METADATA_PROVIDER_NAMES = Object.freeze(
  Object.keys(LITERATURE_PROVIDERS).filter(
    (id) => LITERATURE_PROVIDERS[id]!.metadata.length,
  ),
);
export const METADATA_AUTO_PROVIDERS = Object.freeze(
  METADATA_PROVIDER_NAMES.filter(
    (id) => LITERATURE_PROVIDERS[id]!.metadataAuto,
  ),
);
export const ACQUISITION_PROVIDER_NAMES = Object.freeze([
  "arxiv",
  "crossref",
  "semantic-scholar",
  "openalex",
  "europe-pmc",
  "unpaywall",
  "elsevier",
  "springer",
  "wiley",
  "datacite",
  "core",
  "sci-hub",
]);
export const AUTO_ACQUISITION_SOURCES = Object.freeze(
  ACQUISITION_PROVIDER_NAMES.filter(
    (id) => LITERATURE_PROVIDERS[id]!.acquisitionAuto,
  ),
);
export function metadataService(
  providerName: string,
  endpoint?: string,
): ServiceDefinition {
  const registration = registrations.find((p) => p.id === providerName);
  const id =
    endpoint && registration?.metadataServiceFor
      ? registration.metadataServiceFor(endpoint)
      : registration?.definition.metadataService;
  const result = id ? registration?.services[id] : undefined;
  if (!result) throw new TypeError("metadata service is unavailable");
  return result;
}
export function acquisitionService(providerName: string): ServiceDefinition {
  const registration = registrations.find((p) => p.id === providerName);
  const id = registration?.definition.acquisitionService;
  const result = id ? registration?.services[id] : undefined;
  if (!result) throw new TypeError("acquisition service is unavailable");
  return result;
}
export function publicWebService(endpoint: string): ServiceDefinition {
  const url = new URL(endpoint);
  for (const registration of registrations) {
    const resolved = registration.webServiceFor?.(url);
    if (resolved) return resolved;
    const id = registration.webHosts?.[url.hostname];
    if (id) return registration.services[id]!;
  }
  return service(
    url.origin,
    `web/${url.host}`,
    "Public web pages and file hints",
    "project-default: no verified service-specific rule",
  );
}
