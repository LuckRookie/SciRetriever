import { ContractValidationError, sha256 } from "./index.js";
import {
  extractionCanonicalJsonBytes,
  freezeExtractionJson,
  parseExtractionSpec,
  EXTRACTION_MAX_JSON_DEPTH,
  EXTRACTION_MAX_JSON_NODES,
  type ExtractionSpec,
} from "./extraction.js";
import { parseInputManifest, type InputManifest } from "./input-manifest.js";
import {
  parseExtractionSubmission,
  type ExtractionSubmission,
} from "./extraction-delivery.js";

export const EXTRACTION_SUBMISSION_WIRE_MAX_BYTES = 1024 * 1024 + 4096;
export const EXTRACTION_SUBMISSION_HASH_MAX_BYTES = 1024 * 1024 + 4096;
// Each of 128 pins may carry two or three 128-byte IDs and a 64-byte hash.
export const EXTRACTION_RECEIPT_MAX_BYTES = 128 * 1024;
export const EXTRACTION_ACCEPTED_MAX_BYTES =
  2 * 1024 * 1024 + EXTRACTION_RECEIPT_MAX_BYTES;
const HASH_LIMITS = {
  maxDepth: EXTRACTION_MAX_JSON_DEPTH + 1,
  maxNodes: EXTRACTION_MAX_JSON_NODES + 6,
};
// Receipt: 9 scalar fields, checks (5), two arrays, and 128 objects of each pin kind.
const ACCEPTED_LIMITS = {
  maxDepth: EXTRACTION_MAX_JSON_DEPTH + 1,
  maxNodes: EXTRACTION_MAX_JSON_NODES + 128 * (5 + 4) + 20,
};
const CREATE_LIMITS = {
  maxDepth: EXTRACTION_MAX_JSON_DEPTH + 1,
  maxNodes: 2 * EXTRACTION_MAX_JSON_NODES + 3,
};

export async function extractionSubmissionHash(
  operation: ExtractionOperationResult,
  submission: ExtractionSubmission,
): Promise<string> {
  const op = parseExtractionOperationResult(operation);
  const batch = parseExtractionSubmission(submission);
  if (op.operation_id !== batch.operation_id) fail();
  return sha256(
    extractionCanonicalJsonBytes(
      {
        caller_id: op.caller_id,
        spec_id: op.spec_id,
        spec_version: op.spec_version,
        spec_sha256: op.spec_sha256,
        manifest_sha256: op.manifest_sha256,
        submission: batch,
      },
      EXTRACTION_SUBMISSION_HASH_MAX_BYTES,
      HASH_LIMITS,
    ),
  );
}

export interface ExtractionCreateRequest {
  readonly caller_id: string;
  readonly spec: ExtractionSpec;
  readonly manifest: InputManifest;
}
export interface ExtractionOperationResult {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly caller_id: string;
  readonly spec_id: string;
  readonly spec_version: string;
  readonly spec_sha256: string;
  readonly manifest_sha256: string;
  readonly status: "open" | "closed" | "cancelled";
  readonly created_at: string;
  readonly accept_until: string;
  readonly closed_at: string | null;
}
export interface ExtractionChecks {
  readonly record_count: number;
  readonly relation_count: number;
  readonly evidence_count: number;
  readonly coverage_count: number;
}
export interface ExtractionReceiptResult {
  readonly schema_version: 1;
  readonly receipt_id: string;
  readonly operation_id: string;
  readonly submission_key: string;
  readonly batch_id: string;
  readonly submission_sha256: string;
  readonly accepted_at: string;
  readonly receipt_expires_at: string;
  readonly protection_expires_at: string;
  readonly checks: ExtractionChecks;
  readonly protected_materials: readonly {
    readonly input_id: string;
    readonly literature_id: string;
    readonly asset_id: string;
    readonly asset_sha256: string;
  }[];
  readonly protected_documents: readonly {
    readonly input_id: string;
    readonly document_version_id: string;
    readonly representation_sha256: string;
  }[];
}
export interface ExtractionAcceptedResult {
  readonly schema_version: 1;
  readonly receipt: ExtractionReceiptResult;
  readonly accepted_batch: ExtractionSubmission;
}
export interface ExtractionCandidateIssue {
  readonly code: string;
  readonly record_id: string | null;
  readonly pointer: string | null;
  readonly input_id: string | null;
  readonly relation_index: number | null;
  readonly keyword: string | null;
  readonly truncated: boolean;
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
function snapshot(
  value: unknown,
  limit: number,
  limits?: { readonly maxDepth: number; readonly maxNodes: number },
): unknown {
  return JSON.parse(
    new TextDecoder().decode(
      extractionCanonicalJsonBytes(value, limit, limits),
    ),
  ) as unknown;
}
function token(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
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
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail();
  return value;
}
function date(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    fail();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value)
    fail();
  return value;
}
function count(value: unknown, maximum: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  )
    fail();
  return value as number;
}
export async function parseExtractionCreateRequest(
  value: unknown,
): Promise<ExtractionCreateRequest> {
  const r = exact(snapshot(value, 384 * 1024, CREATE_LIMITS), [
    "caller_id",
    "spec",
    "manifest",
  ]);
  const caller_id = token(r.caller_id);
  const [spec, manifest] = await Promise.all([
    parseExtractionSpec(r.spec),
    parseInputManifest(r.manifest),
  ]);
  return freezeExtractionJson({ caller_id, spec, manifest });
}
export function parseExtractionOperationResult(
  value: unknown,
): ExtractionOperationResult {
  const r = exact(snapshot(value, 4096), [
    "schema_version",
    "operation_id",
    "caller_id",
    "spec_id",
    "spec_version",
    "spec_sha256",
    "manifest_sha256",
    "status",
    "created_at",
    "accept_until",
    "closed_at",
  ]);
  if (
    r.schema_version !== 1 ||
    !["open", "closed", "cancelled"].includes(String(r.status))
  )
    fail();
  const created_at = date(r.created_at);
  const accept_until = date(r.accept_until);
  const closed_at = r.closed_at === null ? null : date(r.closed_at);
  if (
    accept_until <= created_at ||
    (r.status === "open") !== (closed_at === null)
  )
    fail();
  return freezeExtractionJson({
    schema_version: 1,
    operation_id: token(r.operation_id),
    caller_id: token(r.caller_id),
    spec_id: token(r.spec_id),
    spec_version: token(r.spec_version),
    spec_sha256: hash(r.spec_sha256),
    manifest_sha256: hash(r.manifest_sha256),
    status: r.status as ExtractionOperationResult["status"],
    created_at,
    accept_until,
    closed_at,
  });
}
export function parseExtractionReceiptResult(
  value: unknown,
): ExtractionReceiptResult {
  const r = exact(
    snapshot(value, EXTRACTION_RECEIPT_MAX_BYTES, ACCEPTED_LIMITS),
    [
      "schema_version",
      "receipt_id",
      "operation_id",
      "submission_key",
      "batch_id",
      "submission_sha256",
      "accepted_at",
      "receipt_expires_at",
      "protection_expires_at",
      "checks",
      "protected_materials",
      "protected_documents",
    ],
  );
  if (r.schema_version !== 1) fail();
  const checks = exact(r.checks, [
    "record_count",
    "relation_count",
    "evidence_count",
    "coverage_count",
  ]);
  const parsedChecks = {
    record_count: count(checks.record_count, 64),
    relation_count: count(checks.relation_count, 128),
    evidence_count: count(checks.evidence_count, 256),
    coverage_count: count(checks.coverage_count, 128),
  };
  if (
    !Array.isArray(r.protected_materials) ||
    r.protected_materials.length > 128 ||
    !Array.isArray(r.protected_documents) ||
    r.protected_documents.length > 128
  )
    fail();
  const materials = r.protected_materials.map((value) => {
    const item = exact(value, [
      "input_id",
      "literature_id",
      "asset_id",
      "asset_sha256",
    ]);
    return {
      input_id: token(item.input_id),
      literature_id: token(item.literature_id),
      asset_id: token(item.asset_id),
      asset_sha256: hash(item.asset_sha256),
    };
  });
  const documents = r.protected_documents.map((value) => {
    const item = exact(value, [
      "input_id",
      "document_version_id",
      "representation_sha256",
    ]);
    return {
      input_id: token(item.input_id),
      document_version_id: token(item.document_version_id),
      representation_sha256: hash(item.representation_sha256),
    };
  });
  if (
    new Set(materials.map((item) => item.input_id)).size !== materials.length ||
    new Set(documents.map((item) => item.input_id)).size !== documents.length ||
    documents.some(
      (item) =>
        !materials.some((material) => material.input_id === item.input_id),
    )
  )
    fail();
  const accepted_at = date(r.accepted_at);
  const receipt_expires_at = date(r.receipt_expires_at);
  const protection_expires_at = date(r.protection_expires_at);
  if (receipt_expires_at <= accepted_at || protection_expires_at <= accepted_at)
    fail();
  return freezeExtractionJson({
    schema_version: 1,
    receipt_id: token(r.receipt_id),
    operation_id: token(r.operation_id),
    submission_key: token(r.submission_key),
    batch_id: token(r.batch_id),
    submission_sha256: hash(r.submission_sha256),
    accepted_at,
    receipt_expires_at,
    protection_expires_at,
    checks: parsedChecks,
    protected_materials: materials,
    protected_documents: documents,
  });
}
export function parseExtractionAcceptedResult(
  value: unknown,
  expected?: ExtractionSubmission,
  expectedHash?: string,
  expectedOperation?: ExtractionOperationResult,
  expectedManifest?: InputManifest,
): ExtractionAcceptedResult {
  const r = exact(
    snapshot(value, EXTRACTION_ACCEPTED_MAX_BYTES, ACCEPTED_LIMITS),
    ["schema_version", "receipt", "accepted_batch"],
  );
  if (r.schema_version !== 1) fail();
  const receipt = parseExtractionReceiptResult(r.receipt);
  const accepted_batch = parseExtractionSubmission(r.accepted_batch);
  if (
    receipt.operation_id !== accepted_batch.operation_id ||
    receipt.submission_key !== accepted_batch.submission_key ||
    receipt.batch_id !== accepted_batch.batch_id ||
    receipt.checks.record_count !== accepted_batch.records.length ||
    receipt.checks.relation_count !== accepted_batch.relations.length ||
    receipt.checks.coverage_count !== accepted_batch.coverage.length ||
    receipt.checks.evidence_count !==
      accepted_batch.records.reduce(
        (sum, record) =>
          sum +
          record.field_evidence.reduce(
            (fields, field) => fields + field.sources.length,
            0,
          ),
        0,
      ) +
        accepted_batch.relations.reduce(
          (sum, relation) => sum + relation.evidence.length,
          0,
        )
  )
    fail();
  if (
    expectedHash !== undefined &&
    receipt.submission_sha256 !== hash(expectedHash)
  )
    fail();
  if (
    expected &&
    new TextDecoder().decode(extractionCanonicalJsonBytes(accepted_batch)) !==
      new TextDecoder().decode(extractionCanonicalJsonBytes(expected))
  )
    fail();
  if (expectedOperation) {
    const operation = parseExtractionOperationResult(expectedOperation);
    if (
      receipt.operation_id !== operation.operation_id ||
      receipt.accepted_at < operation.created_at ||
      receipt.accepted_at > operation.accept_until
    )
      fail();
  }
  if (expectedManifest) {
    const materialItems = expectedManifest.items.filter(
      (item) => item.material !== null,
    );
    const documentItems = expectedManifest.items.filter(
      (item) => item.document !== null,
    );
    if (
      receipt.protected_materials.length !== materialItems.length ||
      receipt.protected_documents.length !== documentItems.length
    )
      fail();
    for (const item of materialItems) {
      const pin = receipt.protected_materials.find(
        (entry) => entry.input_id === item.input_id,
      );
      if (
        !pin ||
        pin.literature_id !== item.literature_id ||
        pin.asset_id !== item.material?.asset_id ||
        pin.asset_sha256 !== item.material?.asset_sha256
      )
        fail();
    }
    for (const item of documentItems) {
      const pin = receipt.protected_documents.find(
        (entry) => entry.input_id === item.input_id,
      );
      if (
        !pin ||
        pin.document_version_id !== item.document?.document_version_id ||
        pin.representation_sha256 !== item.document?.representation_sha256
      )
        fail();
    }
  }
  return freezeExtractionJson({ schema_version: 1, receipt, accepted_batch });
}
export function parseExtractionCandidateIssue(
  value: unknown,
): ExtractionCandidateIssue {
  const r = exact(snapshot(value, 4096), [
    "code",
    "record_id",
    "pointer",
    "input_id",
    "relation_index",
    "keyword",
    "truncated",
  ]);
  if (typeof r.truncated !== "boolean") fail();
  return freezeExtractionJson({
    code: token(r.code),
    record_id: r.record_id === null ? null : token(r.record_id),
    pointer: r.pointer === null ? null : pointer(r.pointer),
    input_id: r.input_id === null ? null : token(r.input_id),
    relation_index:
      r.relation_index === null ? null : count(r.relation_index, 127),
    keyword: r.keyword === null ? null : token(r.keyword),
    truncated: r.truncated,
  });
}
