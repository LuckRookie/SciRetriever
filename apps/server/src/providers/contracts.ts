import type { AccessRatePolicy } from "../network/budget.js";
export type MetadataCapability = "topic-search" | "lookup" | "reference-query";
export interface ServiceDefinition {
  readonly endpoint: string;
  readonly quotaGroup: string;
  readonly policy: AccessRatePolicy & { readonly maxConcurrency: number };
  readonly policyBasis: string;
  readonly coverage: string;
}
export interface ProviderDefinition {
  readonly metadata: readonly MetadataCapability[];
  readonly metadataService?: string;
  readonly metadataFormat?: "json" | "atom";
  readonly metadataAuto?: boolean;
  readonly acquisition: "public" | "authorized-api" | "hints" | "none";
  readonly acquisitionService?: string;
  readonly acquisitionAuto?: boolean;
  readonly credentialFields: readonly string[];
  readonly requiredMetadataCredential?: string;
  readonly requiredPdfCredential?: string;
  readonly pdfHeaders?: Readonly<Record<string, string>>;
  readonly metadataHeaders?: Readonly<Record<string, string>>;
  readonly metadataQuery?: Readonly<Record<string, string>>;
  readonly pdfIdentifiers?: readonly string[];
  readonly doiOrigins?: readonly string[];
}
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const DAY = 24 * 60 * MINUTE;
export const DEFAULT_POLICY = Object.freeze({
  retryAfterScope: "group" as const,
  maxConcurrency: 1,
  minimumIntervalMs: SECOND,
  rateLimitBackoffMs: 60 * SECOND,
});
export function service(
  endpoint: string,
  quotaGroup: string,
  coverage: string,
  policyBasis: string,
  policy: Partial<ServiceDefinition["policy"]> = {},
): ServiceDefinition {
  return Object.freeze({
    endpoint,
    quotaGroup,
    coverage,
    policyBasis,
    policy: Object.freeze({
      ...DEFAULT_POLICY,
      ...policy,
      ...(policy.windows
        ? {
            windows: Object.freeze(
              policy.windows.map((w) => Object.freeze({ ...w })),
            ),
          }
        : {}),
    }),
  });
}
export const search: readonly MetadataCapability[] = Object.freeze([
  "topic-search",
  "lookup",
]);
export const references: readonly MetadataCapability[] = Object.freeze([
  ...search,
  "reference-query",
]);
export function provider(value: ProviderDefinition): ProviderDefinition {
  return Object.freeze({
    ...value,
    metadata: Object.freeze([...value.metadata]),
    credentialFields: Object.freeze([...value.credentialFields]),
    ...(value.pdfHeaders
      ? { pdfHeaders: Object.freeze({ ...value.pdfHeaders }) }
      : {}),
    ...(value.metadataHeaders
      ? { metadataHeaders: Object.freeze({ ...value.metadataHeaders }) }
      : {}),
    ...(value.metadataQuery
      ? { metadataQuery: Object.freeze({ ...value.metadataQuery }) }
      : {}),
    ...(value.pdfIdentifiers
      ? { pdfIdentifiers: Object.freeze([...value.pdfIdentifiers]) }
      : {}),
    ...(value.doiOrigins
      ? { doiOrigins: Object.freeze([...value.doiOrigins]) }
      : {}),
  });
}

export interface ProviderRegistration {
  readonly id: string;
  readonly definition: ProviderDefinition;
  readonly services: Readonly<Record<string, ServiceDefinition>>;
  readonly metadataServiceFor?: (endpoint: string) => string;
  readonly webHosts?: Readonly<Record<string, string>>;
  readonly webServiceFor?: (url: URL) => ServiceDefinition | undefined;
}
