import type {
  SourcePublicFieldSchema,
  SourcePurpose,
} from "@sciretriever/contracts";
import type { AcquisitionStage } from "../acquisition/ports.js";
import type { AccessRatePolicy } from "../network/budget.js";
export type MetadataCapability = "topic-search" | "lookup" | "reference-query";
export interface ServiceDefinition {
  readonly endpoint: string;
  readonly quotaGroup: string;
  readonly policy: AccessRatePolicy & { readonly maxConcurrency: number };
  readonly policyBasis: string;
  readonly coverage: string;
}
export interface ProviderSourceField {
  readonly field: string;
  readonly label: string;
  readonly type: SourcePublicFieldSchema;
  readonly required: boolean;
  readonly needed_for: readonly SourcePurpose[];
  readonly required_when?: { readonly field: string; readonly equals: string };
  readonly default_value?: string | readonly string[];
}
export interface ProviderSourceFixture {
  readonly version: "v1";
  readonly identifiers: readonly {
    readonly namespace: string;
    readonly value: string;
  }[];
  readonly record_id: string | null;
  readonly evidence: string;
}
export interface ProviderDefinition {
  readonly displayName?: string;
  readonly configurationFields?: readonly ProviderSourceField[];
  readonly sourceFixture?: ProviderSourceFixture;
  readonly metadata: readonly MetadataCapability[];
  readonly metadataService?: string;
  readonly metadataFormat?: "json" | "atom";
  readonly metadataAuto?: boolean;
  readonly acquisition: "public" | "authorized-api" | "hints" | "none";
  readonly acquisitionStage?: AcquisitionStage;
  readonly publisherAliases?: readonly string[];
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
  /** Publisher-owned domains including their subdomains, HTTPS on the default port. */
  readonly doiDomains?: readonly string[];
}
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const DAY = 24 * 60 * MINUTE;
export const DEFAULT_POLICY = Object.freeze({
  retryAfterScope: "group" as const,
  maxConcurrency: 1,
  minimumIntervalMs: SECOND,
  rateLimitBackoffMs: 60 * SECOND,
  serverErrorBackoffMs: 30 * SECOND,
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
    ...(value.configurationFields
      ? {
          configurationFields: Object.freeze(
            value.configurationFields.map((field) =>
              Object.freeze({
                ...field,
                needed_for: Object.freeze([...field.needed_for]),
                type: Object.freeze({
                  ...field.type,
                  ...(field.type.kind === "enum"
                    ? { values: Object.freeze([...field.type.values]) }
                    : {}),
                }),
              }),
            ),
          ),
        }
      : {}),
    ...(value.sourceFixture
      ? {
          sourceFixture: Object.freeze({
            ...value.sourceFixture,
            identifiers: Object.freeze(
              value.sourceFixture.identifiers.map((id) =>
                Object.freeze({ ...id }),
              ),
            ),
          }),
        }
      : {}),
    metadata: Object.freeze([...value.metadata]),
    credentialFields: Object.freeze([...value.credentialFields]),
    ...(value.publisherAliases
      ? { publisherAliases: Object.freeze([...value.publisherAliases]) }
      : {}),
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
    ...(value.doiDomains
      ? { doiDomains: Object.freeze([...value.doiDomains]) }
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
