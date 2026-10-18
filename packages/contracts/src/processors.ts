import {
  ContractValidationError,
  canonicalJsonBytes,
  parseAssetId,
  parseDocumentReadingRef,
  parseDocumentMaterialRef,
  type DocumentMaterialRef,
  parseEvidenceRef,
  parseLiteratureId,
  sha256,
  type DocumentReadingRef,
  type EvidenceRef,
} from "./index.js";
import {
  extractionCanonicalJsonBytes,
  freezeExtractionJson,
} from "./extraction.js";

export type ProcessorJson =
  | null
  | boolean
  | number
  | string
  | ProcessorJson[]
  | { [key: string]: ProcessorJson };
export type ProcessorObject = { [key: string]: ProcessorJson };
export interface ProcessorIdentity {
  readonly id: string;
  readonly version: string;
}
export type ProcessorSelection =
  | { readonly kind: "literature"; readonly literature_id: string }
  | { readonly kind: "document"; readonly document_version_id: string }
  | {
      readonly kind: "result";
      readonly result_id: string;
      readonly record_ids: readonly string[] | null;
    }
  | { readonly kind: "knowledge"; readonly artifact_id: string };
export type ProcessorInput =
  | {
      readonly kind: "material";
      readonly input_id: string;
      readonly material: DocumentMaterialRef;
    }
  | {
      readonly kind: "document";
      readonly input_id: string;
      readonly document: DocumentReadingRef;
    }
  | {
      readonly kind: "missing";
      readonly input_id: string;
      readonly literature_id: string;
      readonly reason: string;
    }
  | {
      readonly kind: "result";
      readonly input_id: string;
      readonly result_id: string;
      readonly content_sha256: string;
      readonly record_ids: readonly string[] | null;
    }
  | {
      readonly kind: "knowledge";
      readonly input_id: string;
      readonly artifact_id: string;
      readonly content_sha256: string;
    };
export interface ProcessorInvocation {
  readonly schema_version: 1;
  readonly processor: ProcessorIdentity;
  readonly spec: ProcessorObject;
  readonly inputs: readonly ProcessorInput[];
  readonly execution: {
    readonly method_sha256: string;
    readonly model: ProcessorObject | null;
  };
}
export interface ProcessorBatchRequest {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly name: string;
  readonly processor: ProcessorIdentity;
  readonly spec: ProcessorObject;
  readonly inputs: readonly ProcessorSelection[];
}
export type ProcessorCitation =
  | { readonly kind: "document"; readonly evidence: EvidenceRef }
  | {
      readonly kind: "result";
      readonly result_id: string;
      readonly content_sha256: string;
      readonly record_id: string;
      readonly pointer: string;
    }
  | {
      readonly kind: "knowledge";
      readonly artifact_id: string;
      readonly content_sha256: string;
      readonly statement_id: string;
    };
export interface ProcessorRecord {
  readonly record_id: string;
  readonly payload: ProcessorObject;
  readonly evidence: readonly {
    readonly pointer: string;
    readonly sources: readonly ProcessorCitation[];
  }[];
  readonly missing: Readonly<Record<string, string>>;
}
export type ProcessorContent =
  | {
      readonly kind: "records";
      readonly schema: ProcessorObject;
      readonly records: readonly ProcessorRecord[];
    }
  | {
      readonly kind: "text";
      readonly text: string;
      readonly evidence: readonly ProcessorCitation[];
    }
  | {
      readonly kind: "knowledge";
      readonly artifact_id: string;
      readonly content_sha256: string;
    };
export interface ProcessorCoverage {
  readonly input_id: string;
  readonly status: "complete" | "partial" | "none";
  readonly read_segments: readonly string[];
  readonly gaps: readonly string[];
}
export interface ProcessorResult {
  readonly schema_version: 1;
  readonly result_id: string;
  readonly invocation: ProcessorInvocation;
  readonly comparison_sha256: string;
  readonly status: "ok" | "empty";
  readonly content: ProcessorContent;
  readonly coverage: readonly ProcessorCoverage[];
  readonly producer: "internal" | "external";
  readonly provenance: ProcessorObject;
  readonly literature_ids: readonly string[];
  readonly created_at: string;
}
export interface ProcessorResultRef {
  readonly result_id: string;
  readonly content_sha256: string;
}
export interface ProcessorCollection {
  readonly schema_version: 1;
  readonly collection_id: string;
  readonly run_id: string;
  readonly name: string;
  readonly processor: ProcessorIdentity;
  readonly spec: ProcessorObject;
  readonly members: readonly {
    readonly target_id: string;
    readonly inputs: readonly ProcessorInput[];
    readonly result: ProcessorResultRef | null;
    readonly gap: string | null;
  }[];
}
export function processorFail(): never {
  throw new ContractValidationError();
}
export function processorObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    processorFail();
  return value as Record<string, unknown>;
}
export function processorExact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const r = processorObject(value);
  if (Object.keys(r).sort().join("\0") !== [...keys].sort().join("\0"))
    processorFail();
  return r;
}
export function processorText(
  value: unknown,
  max = 4096,
  empty = false,
): string {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    new TextEncoder().encode(value).length > max
  )
    processorFail();
  return value;
}
export function processorHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    processorFail();
  return value;
}
export function processorJson(
  value: unknown,
  maxBytes = 262144,
): ProcessorObject {
  processorObject(value);
  return JSON.parse(
    new TextDecoder().decode(
      extractionCanonicalJsonBytes(value, maxBytes, {
        maxDepth: 33,
        maxNodes: 20480,
        maxArrayLength: 10000,
      }),
    ),
  ) as ProcessorObject;
}
function list<T>(
  value: unknown,
  parse: (value: unknown) => T,
  max = 10000,
): T[] {
  if (!Array.isArray(value) || value.length > max) processorFail();
  return value.map(parse);
}
function id(value: unknown): string {
  return String(parseAssetId(value));
}
function token(value: unknown): string {
  const s = processorText(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(s)) processorFail();
  return s;
}
export function parseProcessorIdentity(value: unknown): ProcessorIdentity {
  const r = processorExact(value, ["id", "version"]);
  return { id: token(r.id), version: token(r.version) };
}
function recordIds(value: unknown): string[] | null {
  if (value === null) return null;
  const ids = list(value, token);
  if (!ids.length || new Set(ids).size !== ids.length) processorFail();
  return ids;
}
export function parseProcessorInput(value: unknown): ProcessorInput {
  const r = processorObject(value);
  const input_id = token(r.input_id);
  switch (r.kind) {
    case "material":
      processorExact(r, ["kind", "input_id", "material"]);
      return {
        kind: "material",
        input_id,
        material: parseDocumentMaterialRef(r.material),
      };
    case "document": {
      processorExact(r, ["kind", "input_id", "document"]);
      return {
        kind: "document",
        input_id,
        document: parseDocumentReadingRef(r.document),
      };
    }
    case "result":
      processorExact(r, [
        "kind",
        "input_id",
        "result_id",
        "content_sha256",
        "record_ids",
      ]);
      return {
        kind: "result",
        input_id,
        result_id: id(r.result_id),
        content_sha256: processorHash(r.content_sha256),
        record_ids: recordIds(r.record_ids),
      };
    case "knowledge":
      processorExact(r, ["kind", "input_id", "artifact_id", "content_sha256"]);
      return {
        kind: "knowledge",
        input_id,
        artifact_id: id(r.artifact_id),
        content_sha256: processorHash(r.content_sha256),
      };
    case "missing":
      processorExact(r, ["kind", "input_id", "literature_id", "reason"]);
      return {
        kind: "missing",
        input_id,
        literature_id: String(parseLiteratureId(r.literature_id)),
        reason: processorText(r.reason, 512),
      };
    default:
      return processorFail();
  }
}
export function parseProcessorInvocation(value: unknown): ProcessorInvocation {
  const r = processorExact(value, [
    "schema_version",
    "processor",
    "spec",
    "inputs",
    "execution",
  ]);
  if (r.schema_version !== 1) processorFail();
  const execution = processorExact(r.execution, ["method_sha256", "model"]);
  const inputs = list(r.inputs, parseProcessorInput);
  if (
    !inputs.length ||
    new Set(inputs.map((i) => i.input_id)).size !== inputs.length
  )
    processorFail();
  const result = {
    schema_version: 1 as const,
    processor: parseProcessorIdentity(r.processor),
    spec: processorJson(r.spec),
    inputs,
    execution: {
      method_sha256: processorHash(execution.method_sha256),
      model: execution.model === null ? null : processorJson(execution.model),
    },
  };
  extractionCanonicalJsonBytes(result, 4 * 1024 * 1024, {
    maxNodes: 20480,
    maxArrayLength: 10000,
    maxDepth: 32,
  });
  return freezeExtractionJson(result);
}
export function parseProcessorBatchRequest(
  value: unknown,
): ProcessorBatchRequest {
  const r = processorExact(value, [
    "schema_version",
    "idempotency_key",
    "name",
    "processor",
    "spec",
    "inputs",
  ]);
  if (r.schema_version !== 1) processorFail();
  const inputs = list<ProcessorSelection>(r.inputs, (value) => {
    const s = processorObject(value);
    if (s.kind === "literature") {
      processorExact(s, ["kind", "literature_id"]);
      return {
        kind: "literature",
        literature_id: String(parseLiteratureId(s.literature_id)),
      };
    }
    if (s.kind === "document") {
      processorExact(s, ["kind", "document_version_id"]);
      return {
        kind: "document",
        document_version_id: id(s.document_version_id),
      };
    }
    if (s.kind === "result") {
      processorExact(s, ["kind", "result_id", "record_ids"]);
      return {
        kind: "result",
        result_id: id(s.result_id),
        record_ids: recordIds(s.record_ids),
      };
    }
    processorExact(s, ["kind", "artifact_id"]);
    if (s.kind !== "knowledge") processorFail();
    return { kind: "knowledge", artifact_id: id(s.artifact_id) };
  });
  if (!inputs.length) processorFail();
  return freezeExtractionJson({
    schema_version: 1,
    idempotency_key: processorText(r.idempotency_key, 128),
    name: processorText(r.name, 512),
    processor: parseProcessorIdentity(r.processor),
    spec: processorJson(r.spec),
    inputs,
  });
}
export function parseProcessorCitation(value: unknown): ProcessorCitation {
  const r = processorObject(value);
  if (r.kind === "document") {
    processorExact(r, ["kind", "evidence"]);
    return { kind: "document", evidence: parseEvidenceRef(r.evidence) };
  }
  if (r.kind === "result") {
    processorExact(r, [
      "kind",
      "result_id",
      "content_sha256",
      "record_id",
      "pointer",
    ]);
    return {
      kind: "result",
      result_id: id(r.result_id),
      content_sha256: processorHash(r.content_sha256),
      record_id: token(r.record_id),
      pointer: processorText(r.pointer, 1024, true),
    };
  }
  processorExact(r, ["kind", "artifact_id", "content_sha256", "statement_id"]);
  if (r.kind !== "knowledge") processorFail();
  return {
    kind: "knowledge",
    artifact_id: id(r.artifact_id),
    content_sha256: processorHash(r.content_sha256),
    statement_id: token(r.statement_id),
  };
}
export function processorPointer(
  value: ProcessorJson,
  pointer: string,
): ProcessorJson {
  if (pointer === "") return value;
  if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer)) processorFail();
  let current: ProcessorJson = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, key)
    )
      processorFail();
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) processorFail();
      current = current[Number(key)]!;
    } else current = current[key]!;
  }
  return current;
}
export function parseProcessorContent(value: unknown): ProcessorContent {
  const r = processorObject(value);
  if (r.kind === "knowledge") {
    processorExact(r, ["kind", "artifact_id", "content_sha256"]);
    return {
      kind: "knowledge",
      artifact_id: id(r.artifact_id),
      content_sha256: processorHash(r.content_sha256),
    };
  }
  if (r.kind === "text") {
    processorExact(r, ["kind", "text", "evidence"]);
    return {
      kind: "text",
      text: processorText(r.text, 1024 * 1024, true),
      evidence: list(r.evidence, parseProcessorCitation),
    };
  }
  processorExact(r, ["kind", "schema", "records"]);
  if (r.kind !== "records") processorFail();
  const records = list(r.records, (value) => {
    const item = processorExact(value, [
      "record_id",
      "payload",
      "evidence",
      "missing",
    ]);
    const payload = processorJson(item.payload, 1024 * 1024);
    const evidence = list(item.evidence, (value) => {
      const e = processorExact(value, ["pointer", "sources"]);
      const pointer = processorText(e.pointer, 1024, true);
      processorPointer(payload, pointer);
      const sources = list(e.sources, parseProcessorCitation);
      if (!sources.length) processorFail();
      return { pointer, sources };
    });
    const missing = Object.fromEntries(
      Object.entries(processorObject(item.missing)).map(([key, reason]) => {
        processorPointer(payload, key);
        return [key, processorText(reason, 512)];
      }),
    );
    if (new Set(evidence.map((e) => e.pointer)).size !== evidence.length)
      processorFail();
    return { record_id: token(item.record_id), payload, evidence, missing };
  });
  if (new Set(records.map((r) => r.record_id)).size !== records.length)
    processorFail();
  return { kind: "records", schema: processorJson(r.schema), records };
}
export async function processorComparison(
  input: ProcessorInvocation,
): Promise<string> {
  return sha256(canonicalJsonBytes(parseProcessorInvocation(input)));
}
export async function parseProcessorResult(
  value: unknown,
): Promise<ProcessorResult> {
  const r = processorExact(value, [
    "schema_version",
    "result_id",
    "invocation",
    "comparison_sha256",
    "status",
    "content",
    "coverage",
    "producer",
    "provenance",
    "literature_ids",
    "created_at",
  ]);
  if (
    r.schema_version !== 1 ||
    !["ok", "empty"].includes(String(r.status)) ||
    !["internal", "external"].includes(String(r.producer))
  )
    processorFail();
  const invocation = parseProcessorInvocation(r.invocation);
  const content = parseProcessorContent(r.content);
  const coverage = list(r.coverage, (value) => {
    const c = processorExact(value, [
      "input_id",
      "status",
      "read_segments",
      "gaps",
    ]);
    if (!["complete", "partial", "none"].includes(String(c.status)))
      processorFail();
    const status = c.status as ProcessorCoverage["status"];
    const read_segments = list(c.read_segments, token);
    const gaps = list(c.gaps, (value) => processorText(value, 512));
    if (status !== "complete" && !gaps.length) processorFail();
    if (status === "none" && read_segments.length) processorFail();
    return { input_id: token(c.input_id), status, read_segments, gaps };
  });
  if (
    coverage.length !== invocation.inputs.length ||
    coverage.some(
      (c, i) =>
        c.input_id !== invocation.inputs[i]!.input_id ||
        (invocation.inputs[i]!.kind === "missing" && c.status !== "none"),
    )
  )
    processorFail();
  if (
    r.status === "empty" &&
    (content.kind !== "records" ||
      content.records.length !== 0 ||
      coverage.some((c) => c.status !== "complete"))
  )
    processorFail();
  const comparison = await processorComparison(invocation);
  if (comparison !== r.comparison_sha256) processorFail();
  const created_at = processorText(r.created_at, 64);
  if (!Number.isFinite(Date.parse(created_at))) processorFail();
  const literature_ids = list(r.literature_ids, (value) =>
    String(parseLiteratureId(value)),
  );
  if (new Set(literature_ids).size !== literature_ids.length) processorFail();
  return freezeExtractionJson({
    schema_version: 1,
    result_id: id(r.result_id),
    invocation,
    comparison_sha256: comparison,
    status: r.status as "ok" | "empty",
    content,
    coverage,
    producer: r.producer as "internal" | "external",
    provenance: processorJson(r.provenance, 4 * 1024 * 1024),
    literature_ids,
    created_at,
  });
}

export function processorResultBytes(result: ProcessorResult): Uint8Array {
  return extractionCanonicalJsonBytes(result, 8 * 1024 * 1024, {
    maxNodes: 20480,
    maxDepth: 32,
    maxArrayLength: 10000,
  });
}

export function parseProcessorCollection(value: unknown): ProcessorCollection {
  const r = processorExact(value, [
    "schema_version",
    "collection_id",
    "run_id",
    "name",
    "processor",
    "spec",
    "members",
  ]);
  if (r.schema_version !== 1) processorFail();
  const members = list(r.members, (value) => {
    const m = processorExact(value, ["target_id", "inputs", "result", "gap"]);
    const ref =
      m.result === null
        ? null
        : processorExact(m.result, ["result_id", "content_sha256"]);
    const result = ref
      ? {
          result_id: id(ref.result_id),
          content_sha256: processorHash(ref.content_sha256),
        }
      : null;
    const gap = m.gap === null ? null : processorText(m.gap, 512);
    if (result === null && gap === null) processorFail();
    return {
      target_id: processorText(m.target_id, 256),
      inputs: list(m.inputs, parseProcessorInput),
      result,
      gap,
    };
  });
  if (
    !members.length ||
    new Set(members.map((m) => m.target_id)).size !== members.length
  )
    processorFail();
  return freezeExtractionJson({
    schema_version: 1,
    collection_id: id(r.collection_id),
    run_id: processorText(r.run_id, 256),
    name: processorText(r.name, 512),
    processor: parseProcessorIdentity(r.processor),
    spec: processorJson(r.spec),
    members,
  });
}
