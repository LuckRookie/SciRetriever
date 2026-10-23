import { boundedCanonicalJsonBytes } from "./canonical-bounded.js";
import {
  parseProcessorValueChecks,
  type ProcessorValueCheck,
} from "./processor-value-checks.js";
import { parseArchiveInputPart, type ArchiveInputPart } from "./snapshots.js";
import { parseSectionRole, type SectionRole } from "./section-roles.js";
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
export interface ProcessorReads {
  readonly parts: "main" | "supplementary" | "all";
  readonly roles: "all" | readonly SectionRole[];
}
export interface ArchiveProcessorInput {
  readonly kind: "archive-document";
  readonly input_id: string;
  readonly literature_id: string;
  readonly parts: readonly ArchiveInputPart[];
  readonly description_version: string;
}
export interface SnapshotProcessorInput {
  readonly kind: "snapshot";
  readonly input_id: string;
  readonly snapshot_id: string;
  readonly content_sha256: string;
  readonly mapped_results: readonly {
    readonly literature_id: string;
    readonly result_id: string;
    readonly content_sha256: string;
  }[];
}
export interface ProcessorPartOutcome {
  readonly literature_id: string;
  readonly asset_id: string | null;
  readonly part: "main" | "supplementary";
  readonly outcome: "complete" | "incomplete";
  readonly read_segments: readonly string[];
  readonly gaps: readonly string[];
}
export function parseProcessorReads(value: unknown): ProcessorReads {
  const r = processorExact(value, ["parts", "roles"]);
  if (!["main", "supplementary", "all"].includes(String(r.parts)))
    processorFail();
  const roles =
    r.roles === "all" ? ("all" as const) : list(r.roles, parseSectionRole, 40);
  if (
    roles !== "all" &&
    (!roles.length || new Set(roles).size !== roles.length)
  )
    processorFail();
  return {
    parts: r.parts as ProcessorReads["parts"],
    roles: roles === "all" ? roles : [...roles].sort(),
  };
}
export type ProcessorSelection =
  | { readonly kind: "snapshot"; readonly snapshot_id: string }
  | { readonly kind: "literature"; readonly literature_id: string };
/** Retained external submissions are evidence containers, never executable inputs. */
export interface ExternalProcessorInput {
  readonly kind: "external";
  readonly input_id: string;
  readonly literature_id: string;
  readonly material: DocumentMaterialRef | null;
  readonly document: DocumentReadingRef | null;
}
export interface ProcessorRecordSource {
  readonly kind: "result";
  readonly input_id: string;
  readonly result_id: string;
  readonly content_sha256: string;
  readonly record_ids: readonly string[] | null;
}
export type ProcessorInput =
  | ArchiveProcessorInput
  | SnapshotProcessorInput
  | ExternalProcessorInput
  | {
      readonly kind: "missing";
      readonly input_id: string;
      readonly literature_id: string;
      readonly reason: string;
    };
export interface ProcessorInvocation {
  readonly schema_version: 1;
  readonly processor: ProcessorIdentity;
  readonly spec: ProcessorObject;
  readonly inputs: readonly ProcessorInput[];
  readonly execution: {
    readonly reads: ProcessorReads;
    readonly uses_description: boolean;
    readonly map: {
      readonly processor: ProcessorIdentity;
      readonly spec: ProcessorObject;
    } | null;
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
  | {
      readonly kind: "snapshot";
      readonly snapshot_id: string;
      readonly content_sha256: string;
      readonly literature_id: string | null;
      readonly pointer: string;
    }
  | { readonly kind: "document"; readonly evidence: EvidenceRef }
  | {
      readonly kind: "result";
      readonly result_id: string;
      readonly content_sha256: string;
      readonly record_id: string;
      readonly pointer: string;
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
      readonly kind: "report";
      readonly text: string;
      readonly claims: readonly {
        readonly record_id: string;
        readonly text: string;
        readonly sources: readonly ProcessorCitation[];
      }[];
    }
  | {
      readonly kind: "records";
      readonly schema: ProcessorObject;
      readonly records: readonly ProcessorRecord[];
    };
export interface ProcessorCoverage {
  readonly parts: readonly ProcessorPartOutcome[];
  readonly input_id: string;
  readonly status: "complete" | "partial" | "none";
  readonly read_segments: readonly string[];
  readonly gaps: readonly string[];
}
export interface ProcessorResult {
  readonly value_checks: readonly ProcessorValueCheck[];
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
export function parseProcessorInput(value: unknown): ProcessorInput {
  const r = processorObject(value);
  const input_id = token(r.input_id);
  switch (r.kind) {
    case "archive-document": {
      processorExact(r, [
        "kind",
        "input_id",
        "literature_id",
        "parts",
        "description_version",
      ]);
      const parts = list(r.parts, parseArchiveInputPart, 1000);
      if (new Set(parts.map((p) => p.asset_id)).size !== parts.length)
        processorFail();
      return {
        kind: r.kind,
        input_id,
        literature_id: String(parseLiteratureId(r.literature_id)),
        parts,
        description_version: processorHash(r.description_version),
      };
    }
    case "snapshot": {
      processorExact(r, [
        "kind",
        "input_id",
        "snapshot_id",
        "content_sha256",
        "mapped_results",
      ]);
      const mapped_results = list(r.mapped_results, (v) => {
        const x = processorExact(v, [
          "literature_id",
          "result_id",
          "content_sha256",
        ]);
        return {
          literature_id: String(parseLiteratureId(x.literature_id)),
          result_id: id(x.result_id),
          content_sha256: processorHash(x.content_sha256),
        };
      });
      if (
        new Set(mapped_results.map((m) => m.literature_id)).size !==
        mapped_results.length
      )
        processorFail();
      return {
        kind: r.kind,
        input_id,
        snapshot_id: id(r.snapshot_id),
        content_sha256: processorHash(r.content_sha256),
        mapped_results,
      };
    }
    case "external": {
      processorExact(r, [
        "kind",
        "input_id",
        "literature_id",
        "material",
        "document",
      ]);
      const material =
        r.material === null ? null : parseDocumentMaterialRef(r.material);
      const document =
        r.document === null ? null : parseDocumentReadingRef(r.document);
      const literature_id = String(parseLiteratureId(r.literature_id));
      if (material && material.literature_id !== literature_id) processorFail();
      if (
        document &&
        (!material ||
          JSON.stringify(document.source_material_ref) !==
            JSON.stringify(material))
      )
        processorFail();
      return { kind: r.kind, input_id, literature_id, material, document };
    }
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
  const execution = processorExact(r.execution, [
    "method_sha256",
    "model",
    "reads",
    "uses_description",
    "map",
  ]);
  if (typeof execution.uses_description !== "boolean") processorFail();
  const map =
    execution.map === null
      ? null
      : processorExact(execution.map, ["processor", "spec"]);
  const inputs = list(r.inputs, parseProcessorInput);
  if (
    !inputs.length ||
    new Set(inputs.map((i) => i.input_id)).size !== inputs.length
  )
    processorFail();
  if (
    inputs.some((i) => i.kind === "external") &&
    (processorObject(r.processor).id !== "external-extraction" ||
      processorObject(r.processor).version !== "2")
  )
    processorFail();
  const result = {
    schema_version: 1 as const,
    processor: parseProcessorIdentity(r.processor),
    spec: processorJson(r.spec),
    inputs,
    execution: {
      reads: parseProcessorReads(execution.reads),
      uses_description: execution.uses_description,
      map: map
        ? {
            processor: parseProcessorIdentity(map.processor),
            spec: processorJson(map.spec),
          }
        : null,
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
    if (s.kind === "snapshot") {
      processorExact(s, ["kind", "snapshot_id"]);
      return { kind: "snapshot", snapshot_id: id(s.snapshot_id) };
    }
    if (s.kind === "literature") {
      processorExact(s, ["kind", "literature_id"]);
      return {
        kind: "literature",
        literature_id: String(parseLiteratureId(s.literature_id)),
      };
    }
    return processorFail();
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
  if (r.kind === "snapshot") {
    processorExact(r, [
      "kind",
      "snapshot_id",
      "content_sha256",
      "literature_id",
      "pointer",
    ]);
    return {
      kind: r.kind,
      snapshot_id: id(r.snapshot_id),
      content_sha256: processorHash(r.content_sha256),
      literature_id:
        r.literature_id === null
          ? null
          : String(parseLiteratureId(r.literature_id)),
      pointer: processorText(r.pointer, 1024, true),
    };
  }
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
  return processorFail();
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
  if (r.kind === "report") {
    processorExact(r, ["kind", "text", "claims"]);
    const claims = list(r.claims, (v) => {
      const c = processorExact(v, ["record_id", "text", "sources"]);
      const sources = list(c.sources, parseProcessorCitation);
      if (!sources.length) processorFail();
      return {
        record_id: token(c.record_id),
        text: processorText(c.text, 65536),
        sources,
      };
    });
    if (new Set(claims.map((c) => c.record_id)).size !== claims.length)
      processorFail();
    return {
      kind: r.kind,
      text: processorText(r.text, 1024 * 1024, true),
      claims,
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
  const invocation = parseProcessorInvocation(input);
  return sha256(
    canonicalJsonBytes({
      ...invocation,
      inputs: invocation.inputs.map((i) =>
        i.kind === "archive-document"
          ? {
              kind: i.kind,
              literature_id: i.literature_id,
              parts: i.parts
                .map((p) => ({
                  asset_id: p.asset_id,
                  part: p.part,
                  content_version: p.content_version,
                  available: p.available,
                }))
                .sort((a, b) => a.asset_id.localeCompare(b.asset_id)),
            }
          : i,
      ),
    }),
  );
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
    "value_checks",
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
    const raw = processorObject(value);
    const c = processorExact(raw, [
      "parts",
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
    const parts = list(c.parts, (v) => {
      const p = processorExact(v, [
        "literature_id",
        "asset_id",
        "part",
        "outcome",
        "read_segments",
        "gaps",
      ]);
      if (
        !["main", "supplementary"].includes(String(p.part)) ||
        !["complete", "incomplete"].includes(String(p.outcome))
      )
        processorFail();
      return {
        literature_id: String(parseLiteratureId(p.literature_id)),
        asset_id: p.asset_id === null ? null : id(p.asset_id),
        part: p.part as ProcessorPartOutcome["part"],
        outcome: p.outcome as ProcessorPartOutcome["outcome"],
        read_segments: list(p.read_segments, token),
        gaps: list(p.gaps, (v) => processorText(v, 512)),
      };
    });
    return { input_id: token(c.input_id), status, read_segments, gaps, parts };
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
    (content.kind === "report"
      ? content.claims.length !== 0
      : content.kind !== "records" || content.records.length !== 0)
  )
    processorFail();
  if (
    r.status === "empty" &&
    coverage.some(
      (c) =>
        c.status !== "complete" ||
        c.parts.some((p) => p.outcome === "incomplete"),
    )
  )
    processorFail();
  if (
    invocation.inputs.some((i) => i.kind === "external") &&
    r.producer !== "external"
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
    value_checks: parseProcessorValueChecks(r.value_checks, content),
    coverage,
    producer: r.producer as "internal" | "external",
    provenance: processorJson(r.provenance, 4 * 1024 * 1024),
    literature_ids,
    created_at,
  });
}

export function processorResultBytes(result: ProcessorResult): Uint8Array {
  // Every JSON node consumes at least one byte; the existing byte ceiling
  // also bounds traversal without a smaller, unrelated Extraction node cap.
  return boundedCanonicalJsonBytes(result, 8 * 1024 * 1024, {
    maxNodes: 8 * 1024 * 1024,
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
