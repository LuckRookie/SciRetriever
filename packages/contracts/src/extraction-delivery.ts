import {
  ContractValidationError,
  parseEvidenceRef,
  type EvidenceRef,
} from "./index.js";
import {
  extractionCanonicalJsonBytes,
  freezeExtractionJson,
  EXTRACTION_MAX_BATCH_BYTES,
} from "./extraction.js";

export type ExtractionCoverageStatus =
  | "processed-with-records"
  | "processed-no-records"
  | "not-processed"
  | "unreadable"
  | "unsupported"
  | "failed"
  | "cancelled";
export interface ExtractionEvidenceSource {
  readonly input_id: string;
  readonly evidence: EvidenceRef;
}
export interface ExtractionSubmission {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly submission_key: string;
  readonly batch_id: string;
  readonly records: readonly {
    readonly record_id: string;
    readonly payload: unknown;
    readonly field_evidence: readonly {
      readonly pointer: string;
      readonly sources: readonly ExtractionEvidenceSource[];
    }[];
  }[];
  readonly relations: readonly {
    readonly relation_type: string;
    readonly from: { readonly record_id: string; readonly pointer: string };
    readonly to: { readonly record_id: string; readonly pointer: string };
    readonly evidence: readonly ExtractionEvidenceSource[];
  }[];
  readonly coverage: readonly {
    readonly input_id: string;
    readonly status: ExtractionCoverageStatus;
    readonly reason: string | null;
  }[];
  readonly producer: {
    readonly method_id: string;
    readonly method_version: string | null;
    readonly usage: Readonly<Record<string, number>>;
  };
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
function token(value: unknown, max = 128): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  )
    fail();
  return value;
}
function pointer(value: unknown): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).length > 1024 ||
    (value !== "" && !value.startsWith("/")) ||
    /~(?![01])/.test(value)
  )
    fail();
  return value;
}
function source(value: unknown): ExtractionEvidenceSource {
  const r = exact(value, ["input_id", "evidence"]);
  return {
    input_id: token(r.input_id),
    evidence: parseEvidenceRef(r.evidence),
  };
}
function sources(value: unknown): readonly ExtractionEvidenceSource[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) fail();
  const result = value.map(source);
  if (
    new Set(
      result.map(
        (item) => `${item.input_id}\u0000${JSON.stringify(item.evidence)}`,
      ),
    ).size !== result.length
  )
    fail();
  return result;
}
function endpoint(value: unknown): {
  readonly record_id: string;
  readonly pointer: string;
} {
  const r = exact(value, ["record_id", "pointer"]);
  return { record_id: token(r.record_id), pointer: pointer(r.pointer) };
}

/** Copies the complete candidate before any asynchronous validation or hashing. */
export function parseExtractionSubmission(
  value: unknown,
): ExtractionSubmission {
  const snapshot: unknown = JSON.parse(
    new TextDecoder().decode(
      extractionCanonicalJsonBytes(value, EXTRACTION_MAX_BATCH_BYTES),
    ),
  );
  const r = exact(snapshot, [
    "schema_version",
    "operation_id",
    "submission_key",
    "batch_id",
    "records",
    "relations",
    "coverage",
    "producer",
  ]);
  if (
    r.schema_version !== 1 ||
    !Array.isArray(r.records) ||
    r.records.length > 64 ||
    !Array.isArray(r.relations) ||
    r.relations.length > 128 ||
    !Array.isArray(r.coverage) ||
    r.coverage.length < 1 ||
    r.coverage.length > 128
  )
    fail();
  const records = r.records.map((value) => {
    const item = exact(value, ["record_id", "payload", "field_evidence"]);
    if (!Array.isArray(item.field_evidence) || item.field_evidence.length > 128)
      fail();
    const fieldEvidence = item.field_evidence.map((value) => {
      const entry = exact(value, ["pointer", "sources"]);
      return {
        pointer: pointer(entry.pointer),
        sources: sources(entry.sources),
      };
    });
    if (
      new Set(fieldEvidence.map((entry) => entry.pointer)).size !==
      fieldEvidence.length
    )
      fail();
    return {
      record_id: token(item.record_id),
      payload: item.payload,
      field_evidence: fieldEvidence,
    };
  });
  if (new Set(records.map((item) => item.record_id)).size !== records.length)
    fail();
  const relations = r.relations.map((value) => {
    const item = exact(value, ["relation_type", "from", "to", "evidence"]);
    return {
      relation_type: token(item.relation_type),
      from: endpoint(item.from),
      to: endpoint(item.to),
      evidence: sources(item.evidence),
    };
  });
  const evidenceCount =
    records.reduce(
      (total, record) =>
        total +
        record.field_evidence.reduce(
          (sum, field) => sum + field.sources.length,
          0,
        ),
      0,
    ) +
    relations.reduce((total, relation) => total + relation.evidence.length, 0);
  if (evidenceCount > 256) fail();
  const statuses: readonly string[] = [
    "processed-with-records",
    "processed-no-records",
    "not-processed",
    "unreadable",
    "unsupported",
    "failed",
    "cancelled",
  ];
  const coverage = r.coverage.map((value) => {
    const item = exact(value, ["input_id", "status", "reason"]);
    if (
      !statuses.includes(String(item.status)) ||
      (item.reason !== null &&
        (typeof item.reason !== "string" ||
          !item.reason.trim() ||
          new TextEncoder().encode(item.reason).length > 512))
    )
      fail();
    return {
      input_id: token(item.input_id),
      status: item.status as ExtractionCoverageStatus,
      reason: item.reason as string | null,
    };
  });
  if (new Set(coverage.map((item) => item.input_id)).size !== coverage.length)
    fail();
  const producer = exact(r.producer, ["method_id", "method_version", "usage"]);
  const usage = producer.usage;
  if (
    !usage ||
    typeof usage !== "object" ||
    Array.isArray(usage) ||
    Object.keys(usage).length > 16
  )
    fail();
  for (const [key, amount] of Object.entries(usage)) {
    token(key, 64);
    if (
      !Number.isSafeInteger(amount) ||
      (amount as number) < 0 ||
      (amount as number) > 1_000_000_000_000
    )
      fail();
  }
  return freezeExtractionJson({
    schema_version: 1,
    operation_id: token(r.operation_id),
    submission_key: token(r.submission_key),
    batch_id: token(r.batch_id),
    records,
    relations,
    coverage,
    producer: {
      method_id: token(producer.method_id),
      method_version:
        producer.method_version === null
          ? null
          : token(producer.method_version),
      usage: usage as Readonly<Record<string, number>>,
    },
  } as const);
}
