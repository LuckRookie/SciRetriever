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
function hasLoneSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    value,
  );
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
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(limits.maxDepth) ||
    limits.maxDepth < 0 ||
    limits.maxDepth > EXTRACTION_MAX_JSON_DEPTH + 1 ||
    !Number.isSafeInteger(limits.maxNodes) ||
    limits.maxNodes < 1 ||
    limits.maxNodes > 20480 ||
    (limits.maxArrayLength !== undefined &&
      (!Number.isSafeInteger(limits.maxArrayLength) ||
        limits.maxArrayLength < 1 ||
        limits.maxArrayLength > 20480))
  )
    fail();
  const encoder = new TextEncoder();
  let budget = maxBytes;
  let nodes = 0;
  const consume = (size: number) => {
    budget -= size;
    if (budget < 0) fail();
  };
  const compareKeys = (left: string, right: string): number => {
    const a = Array.from(left);
    const b = Array.from(right);
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
      if (difference) return difference;
    }
    return a.length - b.length;
  };
  const visit = (item: unknown, depth: number): string => {
    if (depth > limits.maxDepth || ++nodes > limits.maxNodes) fail();
    if (item === null || typeof item === "boolean") {
      const serialized = JSON.stringify(item);
      consume(serialized.length);
      return serialized;
    }
    if (typeof item === "string") {
      if (hasLoneSurrogate(item) || item.length > maxBytes) fail();
      const serialized = JSON.stringify(item);
      consume(encoder.encode(serialized).length);
      return serialized;
    }
    if (typeof item === "number") {
      if (
        !Number.isFinite(item) ||
        (Number.isInteger(item) && !Number.isSafeInteger(item))
      )
        fail();
      const serialized = JSON.stringify(item);
      consume(serialized.length);
      return serialized;
    }
    if (Array.isArray(item)) {
      if (item.length > (limits.maxArrayLength ?? 256)) fail();
      const ownKeys = Reflect.ownKeys(item);
      if (
        ownKeys.length !== item.length + 1 ||
        ownKeys.some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" ||
              !/^(0|[1-9][0-9]*)$/.test(key) ||
              Number(key) >= item.length),
        )
      )
        fail();
      consume(item.length > 0 ? item.length + 1 : 2);
      const parts: string[] = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value")) fail();
        parts.push(visit(descriptor.value, depth + 1));
      }
      return `[${parts.join(",")}]`;
    }
    if (
      !item ||
      typeof item !== "object" ||
      Object.getPrototypeOf(item) !== Object.prototype
    )
      fail();
    const record = item as Record<string, unknown>;
    const keys: string[] = [];
    for (const key in record) {
      if (!Object.hasOwn(record, key)) continue;
      keys.push(key);
      if (keys.length > 256) fail();
    }
    const ownKeys = Reflect.ownKeys(record);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some(
        (key) =>
          typeof key !== "string" ||
          !Object.getOwnPropertyDescriptor(record, key)?.enumerable,
      )
    )
      fail();
    keys.sort(compareKeys);
    if (new Set(keys.map((key) => key.normalize("NFC"))).size !== keys.length)
      fail();
    consume(keys.length > 0 ? keys.length + 1 : 2);
    const parts: string[] = [];
    for (const key of keys) {
      if (hasLoneSurrogate(key) || key.length > maxBytes) fail();
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) fail();
      const serializedKey = JSON.stringify(key);
      consume(encoder.encode(serializedKey).length + 1);
      parts.push(`${serializedKey}:${visit(descriptor.value, depth + 1)}`);
    }
    return `{${parts.join(",")}}`;
  };
  const bytes = encoder.encode(visit(value, 0));
  if (bytes.length > maxBytes) fail();
  return bytes;
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
