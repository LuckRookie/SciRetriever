import { boundedCanonicalJsonBytes } from "./canonical-bounded.js";
import { ContractValidationError, sha256 } from "./index.js";

export const EXTRACTION_SCHEMA_URI =
  "https://json-schema.org/draft/2020-12/schema" as const;
export const EXTRACTION_MAX_SPEC_BYTES = 64 * 1024;
export const EXTRACTION_MAX_BATCH_BYTES = 1024 * 1024;
export const EXTRACTION_MAX_JSON_DEPTH = 32;
export const EXTRACTION_MAX_JSON_NODES = 8192;

export type ExtractionCapability =
  | "material-file-v1"
  | "document-segment-v1"
  | "document-text-v1"
  | "document-outline-v1"
  | "document-resources-v1";

export interface ExtractionSpec {
  readonly schema_version: 1;
  readonly spec_id: string;
  readonly spec_version: string;
  readonly spec_sha256: string;
  readonly record_meaning: string;
  readonly output_schema: Readonly<Record<string, unknown>>;
  readonly field_instructions: readonly string[];
  readonly inclusion_rules: readonly string[];
  readonly missing_value_rules: readonly string[];
  readonly evidence_policy: {
    readonly field_granularity: "file" | "segment";
    readonly required_pointers: "record-root" | "all-scalar-leaves";
    readonly cross_input_relation: "required" | "optional";
  };
  readonly required_capabilities: readonly ExtractionCapability[];
}

function fail(): never {
  throw new ContractValidationError();
}
function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\u0000") !== [...keys].sort().join("\u0000")
  )
    fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    new TextEncoder().encode(value).length > max
  )
    fail();
  return value;
}
function list(
  value: unknown,
  maxItems: number,
  itemBytes: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) fail();
  return Object.freeze(value.map((item) => text(item, itemBytes)));
}
function token(value: unknown): string {
  const candidate = text(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(candidate)) fail();
  return candidate;
}
/** Extraction comparison preserves string code points and orders object keys by Unicode scalar value. */
export function extractionCanonicalJsonBytes(
  value: unknown,
  maxBytes = EXTRACTION_MAX_BATCH_BYTES,
  limits: {
    readonly maxDepth: number;
    readonly maxNodes: number;
    /** Different consumers can admit larger arrays without changing Extraction defaults. */
    readonly maxArrayLength?: number;
  } = {
    maxDepth: EXTRACTION_MAX_JSON_DEPTH,
    maxNodes: EXTRACTION_MAX_JSON_NODES,
  },
): Uint8Array {
  if (limits.maxNodes > 20480) fail();
  return boundedCanonicalJsonBytes(value, maxBytes, limits);
}

export function freezeExtractionJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeExtractionJson(child);
    Object.freeze(value);
  }
  return value;
}

const supportedCapabilities: readonly ExtractionCapability[] = [
  "material-file-v1",
  "document-segment-v1",
  "document-text-v1",
  "document-outline-v1",
  "document-resources-v1",
];

export async function parseExtractionSpec(
  value: unknown,
): Promise<ExtractionSpec> {
  const snapshot: unknown = JSON.parse(
    new TextDecoder().decode(
      extractionCanonicalJsonBytes(value, EXTRACTION_MAX_SPEC_BYTES),
    ),
  );
  const r = exact(snapshot, [
    "schema_version",
    "spec_id",
    "spec_version",
    "spec_sha256",
    "record_meaning",
    "output_schema",
    "field_instructions",
    "inclusion_rules",
    "missing_value_rules",
    "evidence_policy",
    "required_capabilities",
  ]);
  if (
    r.schema_version !== 1 ||
    typeof r.spec_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(r.spec_sha256)
  )
    fail();
  const policy = exact(r.evidence_policy, [
    "field_granularity",
    "required_pointers",
    "cross_input_relation",
  ]);
  if (
    (policy.field_granularity !== "file" &&
      policy.field_granularity !== "segment") ||
    (policy.required_pointers !== "record-root" &&
      policy.required_pointers !== "all-scalar-leaves") ||
    (policy.cross_input_relation !== "required" &&
      policy.cross_input_relation !== "optional")
  )
    fail();
  if (
    !Array.isArray(r.required_capabilities) ||
    r.required_capabilities.length > supportedCapabilities.length ||
    r.required_capabilities.some(
      (capability) =>
        !supportedCapabilities.includes(capability as ExtractionCapability),
    ) ||
    new Set(r.required_capabilities).size !== r.required_capabilities.length
  )
    fail();
  const schema = r.output_schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) fail();
  const spec: ExtractionSpec = {
    schema_version: 1,
    spec_id: token(r.spec_id),
    spec_version: token(r.spec_version),
    spec_sha256: r.spec_sha256,
    record_meaning: text(r.record_meaning, 2048),
    output_schema: schema as Readonly<Record<string, unknown>>,
    field_instructions: list(r.field_instructions, 64, 1024),
    inclusion_rules: list(r.inclusion_rules, 32, 1024),
    missing_value_rules: list(r.missing_value_rules, 32, 1024),
    evidence_policy: {
      field_granularity: policy.field_granularity,
      required_pointers: policy.required_pointers,
      cross_input_relation: policy.cross_input_relation,
    } as ExtractionSpec["evidence_policy"],
    required_capabilities: Object.freeze([
      ...r.required_capabilities,
    ]) as readonly ExtractionCapability[],
  };
  const { spec_sha256, ...content } = spec;
  const bytes = extractionCanonicalJsonBytes(
    content,
    EXTRACTION_MAX_SPEC_BYTES,
  );
  if ((await sha256(bytes)) !== spec_sha256) fail();
  return freezeExtractionJson(spec);
}

export async function extractionSpecHash(
  value: Omit<ExtractionSpec, "spec_sha256">,
): Promise<string> {
  const full = { ...value, spec_sha256: "0".repeat(64) };
  extractionCanonicalJsonBytes(full, EXTRACTION_MAX_SPEC_BYTES);
  return sha256(extractionCanonicalJsonBytes(value, EXTRACTION_MAX_SPEC_BYTES));
}
