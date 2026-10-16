import {
  ContractValidationError,
  parseArtifactRef,
  parseAssetId,
  parseEvidenceRef,
  parseLiteratureId,
  sha256,
  type ArtifactRef,
  type EvidenceRef,
} from "./index.js";
import {
  extractionCanonicalJsonBytes,
  freezeExtractionJson,
} from "./extraction.js";
import {
  parseSynthesisInputManifest,
  type SynthesisInputManifest,
} from "./synthesis-manifest.js";
import {
  normalizeKnowledgeQuestion,
  parseKnowledgeArtifact,
  type KnowledgeArtifact,
  type KnowledgeMethod,
  type KnowledgeProvenance,
} from "./knowledge.js";
import {
  parseSynthesisSelections,
  type SynthesisSelection,
} from "./synthesis-manifest.js";

export const SYNTHESIS_MAX_REQUEST_BYTES = 300 * 1024;
export const SYNTHESIS_MAX_CONTENT_BYTES = 512 * 1024;
export const SYNTHESIS_MAX_ARTIFACT_BYTES = 1200 * 1024;
export const SYNTHESIS_MAX_COVERAGE_BYTES = 64 * 1024;
export type SynthesisPolicy = "require-all" | "allow-partial";
export interface KnowledgeSynthesisRequest {
  readonly schema_version: 3;
  readonly input: SynthesisInputManifest;
  readonly purpose: "synthesis";
  readonly question: string;
  readonly policy: SynthesisPolicy;
  /** @deprecated Ignored by fixed-input processing; retained for request compatibility. */
  readonly budget?: {
    readonly max_source_bytes: number;
    readonly max_verification_bytes: number;
    readonly max_call_bytes: number;
    readonly max_total_call_bytes: number;
    readonly max_calls: number;
    readonly max_output_tokens_per_call: number;
    readonly max_total_output_tokens: number;
  };
}
export type SynthesisEvidence =
  | {
      readonly input_id: string;
      readonly target_kind: "document";
      readonly evidence: Extract<EvidenceRef, { target_kind: "document" }>;
    }
  | {
      readonly input_id: string;
      readonly target_kind: "knowledge";
      readonly source_artifact_id: string;
      readonly source_content_sha256: string;
      readonly statement_id: string;
      readonly statement_sha256: string;
    };
export interface SynthesisStatement {
  readonly statement_id: string;
  readonly category:
    | "finding"
    | "method"
    | "result"
    | "limitation"
    | "disagreement";
  readonly epistemic: "reported" | "inference";
  readonly relation: "consensus" | "disagreement" | "single-source";
  readonly conflict_group_id: string | null;
  readonly text: string;
  readonly conditions: readonly string[];
  readonly quantity: null | {
    readonly value: string;
    readonly unit: string;
    readonly comparison_basis: string | null;
  };
  readonly evidence: readonly SynthesisEvidence[];
}
export interface SynthesisContent {
  readonly schema_version: 2;
  readonly title: string;
  readonly statements: readonly SynthesisStatement[];
}
export interface SynthesisCoverageItem {
  readonly input_id: string;
  readonly status: "included" | "degraded" | "excluded";
  readonly reason:
    | null
    | "material-missing"
    | "document-missing"
    | "document-unsupported"
    | "knowledge-missing"
    | "original-unavailable";
}
export interface SynthesisCoverage {
  readonly schema_version: 2;
  readonly status: "complete" | "partial";
  readonly policy: SynthesisPolicy;
  readonly items: readonly SynthesisCoverageItem[];
  readonly unique_literature_count: number;
}
export interface SynthesisArtifact {
  readonly schema_version: 2;
  readonly artifact_id: string;
  readonly comparison_sha256: string;
  readonly purpose: "synthesis";
  readonly question: string;
  readonly input: SynthesisInputManifest;
  readonly method: KnowledgeMethod;
  readonly content_ref: ArtifactRef;
  readonly content: SynthesisContent;
  readonly coverage: SynthesisCoverage;
  readonly provenance: KnowledgeProvenance;
  readonly compression_depth: number;
}
export interface SynthesisExecutionReceipt {
  readonly schema_version: 1;
  readonly outcome: "blocked" | "published";
  readonly input_manifest_sha256: string;
  readonly policy: SynthesisPolicy;
  readonly question: string;
  readonly gaps: readonly {
    readonly input_id: string;
    readonly code: Exclude<SynthesisCoverageItem["reason"], null>;
  }[];
  readonly artifact: SynthesisArtifact | null;
  readonly published: boolean;
}
export interface SynthesisReadResult {
  readonly artifact: SynthesisArtifact;
  /** Excluded manifest rows have no fixed source; their `missing` value does not probe present availability. */
  readonly current_source_states: readonly {
    readonly input_id: string;
    readonly state: "verified" | "source-only" | "missing";
  }[];
  readonly independent_literature_ids: readonly string[];
}
export interface SynthesisPreparationRequest {
  readonly policy: SynthesisPolicy;
  readonly inputs: readonly SynthesisSelection[];
}
export interface SynthesisPreparationResult {
  readonly manifest: SynthesisInputManifest;
  readonly policy: SynthesisPolicy;
  readonly ready: boolean;
  readonly gaps: readonly {
    readonly input_id: string;
    readonly code: string;
  }[];
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
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  )
    fail();
  return value as Record<string, unknown>;
}
function bounded(
  value: unknown,
  maxBytes: number,
  maxDepth = 32,
  maxNodes = 20480,
): unknown {
  return JSON.parse(
    new TextDecoder().decode(
      extractionCanonicalJsonBytes(value, maxBytes, {
        maxDepth,
        maxNodes,
        maxArrayLength: 20480,
      }),
    ),
  ) as unknown;
}
function string(value: unknown, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Array.from(value).some((c) => {
      const code = c.codePointAt(0)!;
      return (
        (code <= 31 && ![9, 10, 13].includes(code)) ||
        (code >= 127 && code <= 159)
      );
    }) ||
    new TextEncoder().encode(value).length > maxBytes
  )
    fail();
  return value;
}
function id(value: unknown): string {
  const v = string(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(v)) fail();
  return v;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail();
  return value;
}
function integer(value: unknown, max: number, min = 0): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    fail();
  return value as number;
}
function question(value: unknown): string {
  return normalizeKnowledgeQuestion(value);
}
function storedQuestion(value: unknown): string {
  const parsed = question(value);
  if (parsed !== value) fail();
  return parsed;
}
function method(value: unknown): KnowledgeMethod {
  const r = exact(value, [
    "id",
    "version",
    "parameters_sha256",
    "model_binding_sha256",
  ]);
  return Object.freeze({
    id: string(r.id, 128),
    version: string(r.version, 128),
    parameters_sha256: hash(r.parameters_sha256),
    model_binding_sha256: hash(r.model_binding_sha256),
  });
}
function provenance(value: unknown): KnowledgeProvenance {
  const r = exact(value, [
    "provider",
    "model",
    "generated_at",
    "input_tokens",
    "output_tokens",
  ]);
  const generated = string(r.generated_at, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(generated) ||
    !Number.isFinite(Date.parse(generated)) ||
    new Date(generated).toISOString() !== generated
  )
    fail();
  return Object.freeze({
    provider: string(r.provider, 128),
    model: string(r.model, 512),
    generated_at: generated,
    input_tokens: integer(r.input_tokens, 1_000_000_000),
    output_tokens: integer(r.output_tokens, 1_000_000_000),
  });
}
export async function parseKnowledgeSynthesisRequest(
  value: unknown,
): Promise<KnowledgeSynthesisRequest> {
  const snapshot = bounded(value, SYNTHESIS_MAX_REQUEST_BYTES, 33, 10240);
  if (!snapshot || typeof snapshot !== "object") fail();
  const r = exact(snapshot, [
    "schema_version",
    "input",
    "purpose",
    "question",
    "policy",
    ...(Object.hasOwn(snapshot, "budget") ? ["budget"] : []),
  ]);
  if (
    r.schema_version !== 3 ||
    r.purpose !== "synthesis" ||
    !["require-all", "allow-partial"].includes(r.policy as string)
  )
    fail();
  const input = await parseSynthesisInputManifest(r.input);
  const b =
    r.budget === undefined
      ? undefined
      : exact(r.budget, [
          "max_source_bytes",
          "max_verification_bytes",
          "max_call_bytes",
          "max_total_call_bytes",
          "max_calls",
          "max_output_tokens_per_call",
          "max_total_output_tokens",
        ]);
  const budget =
    b === undefined
      ? undefined
      : Object.freeze({
          max_source_bytes: integer(
            b.max_source_bytes,
            Number.MAX_SAFE_INTEGER,
            1,
          ),
          max_verification_bytes: integer(
            b.max_verification_bytes,
            Number.MAX_SAFE_INTEGER,
            1,
          ),
          max_call_bytes: integer(b.max_call_bytes, Number.MAX_SAFE_INTEGER, 1),
          max_total_call_bytes: integer(
            b.max_total_call_bytes,
            Number.MAX_SAFE_INTEGER,
            1,
          ),
          max_calls: integer(b.max_calls, Number.MAX_SAFE_INTEGER, 1),
          max_output_tokens_per_call: integer(
            b.max_output_tokens_per_call,
            Number.MAX_SAFE_INTEGER,
            1,
          ),
          max_total_output_tokens: integer(
            b.max_total_output_tokens,
            Number.MAX_SAFE_INTEGER,
            1,
          ),
        });
  return Object.freeze({
    schema_version: 3,
    input,
    purpose: "synthesis",
    question: question(r.question),
    policy: r.policy as SynthesisPolicy,
    ...(budget === undefined ? {} : { budget }),
  });
}
export function parseSynthesisContent(value: unknown): SynthesisContent {
  const r = exact(bounded(value, SYNTHESIS_MAX_CONTENT_BYTES), [
    "schema_version",
    "title",
    "statements",
  ]);
  if (
    r.schema_version !== 2 ||
    !Array.isArray(r.statements) ||
    r.statements.length < 1
  )
    fail();
  const ids = new Set<string>();
  const statements = r.statements.map((entry) => {
    const statement = parseSynthesisStatement(entry);
    if (ids.has(statement.statement_id)) fail();
    ids.add(statement.statement_id);
    return statement;
  });
  return Object.freeze({
    schema_version: 2,
    title: string(r.title, SYNTHESIS_MAX_CONTENT_BYTES),
    statements: Object.freeze(statements),
  });
}
/** Parse one indexed statement with the same content contract as publication. */
export function parseSynthesisStatement(entry: unknown): SynthesisStatement {
  // The single-statement budget is no wider than the full content budget.
  bounded(entry, SYNTHESIS_MAX_CONTENT_BYTES);
  const s = exact(entry, [
    "statement_id",
    "category",
    "epistemic",
    "relation",
    "conflict_group_id",
    "text",
    "conditions",
    "quantity",
    "evidence",
  ]);
  const statementId = id(s.statement_id);
  if (
    !["finding", "method", "result", "limitation", "disagreement"].includes(
      s.category as string,
    ) ||
    !["reported", "inference"].includes(s.epistemic as string) ||
    !["consensus", "disagreement", "single-source"].includes(
      s.relation as string,
    ) ||
    (s.relation === "disagreement") !== (s.conflict_group_id !== null) ||
    !Array.isArray(s.conditions) ||
    !Array.isArray(s.evidence) ||
    s.evidence.length < 1
  )
    fail();
  const q =
    s.quantity === null
      ? null
      : exact(s.quantity, ["value", "unit", "comparison_basis"]);
  const evidence = s.evidence.map((entry: unknown): SynthesisEvidence => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail();
    const kind = (entry as Record<string, unknown>).target_kind;
    if (kind === "document") {
      const e = exact(entry, ["input_id", "target_kind", "evidence"]);
      const parsed = parseEvidenceRef(e.evidence);
      if (parsed.target_kind !== "document") fail();
      return Object.freeze({
        input_id: id(e.input_id),
        target_kind: "document" as const,
        evidence: parsed,
      });
    }
    if (kind !== "knowledge") fail();
    const e = exact(entry, [
      "input_id",
      "target_kind",
      "source_artifact_id",
      "source_content_sha256",
      "statement_id",
      "statement_sha256",
    ]);
    return Object.freeze({
      input_id: id(e.input_id),
      target_kind: "knowledge" as const,
      source_artifact_id: String(parseAssetId(e.source_artifact_id)),
      source_content_sha256: hash(e.source_content_sha256),
      statement_id: id(e.statement_id),
      statement_sha256: hash(e.statement_sha256),
    });
  });
  return Object.freeze({
    statement_id: statementId,
    category: s.category as SynthesisStatement["category"],
    epistemic: s.epistemic as SynthesisStatement["epistemic"],
    relation: s.relation as SynthesisStatement["relation"],
    conflict_group_id:
      s.conflict_group_id === null ? null : id(s.conflict_group_id),
    text: string(s.text, SYNTHESIS_MAX_CONTENT_BYTES),
    conditions: Object.freeze(
      s.conditions.map((x) => string(x, SYNTHESIS_MAX_CONTENT_BYTES)),
    ),
    quantity:
      q === null
        ? null
        : Object.freeze({
            value: string(q.value, SYNTHESIS_MAX_CONTENT_BYTES),
            unit: string(q.unit, SYNTHESIS_MAX_CONTENT_BYTES),
            comparison_basis:
              q.comparison_basis === null
                ? null
                : string(q.comparison_basis, SYNTHESIS_MAX_CONTENT_BYTES),
          }),
    evidence: Object.freeze(evidence),
  });
}
export function synthesisContentBytes(value: SynthesisContent): Uint8Array {
  return extractionCanonicalJsonBytes(
    parseSynthesisContent(value),
    SYNTHESIS_MAX_CONTENT_BYTES,
    { maxDepth: 32, maxNodes: 20480, maxArrayLength: 20480 },
  );
}
/** The same canonical statement identity is used by producers and recursive readers. */
export async function synthesisStatementSha256(
  value: SynthesisStatement | unknown,
): Promise<string> {
  return sha256(
    extractionCanonicalJsonBytes(value, SYNTHESIS_MAX_CONTENT_BYTES, {
      maxDepth: 32,
      maxNodes: 20480,
      maxArrayLength: 20480,
    }),
  );
}
export function parseSynthesisCoverage(
  value: unknown,
  manifest: SynthesisInputManifest,
): SynthesisCoverage {
  const c = exact(bounded(value, SYNTHESIS_MAX_COVERAGE_BYTES, 8, 2048), [
    "schema_version",
    "status",
    "policy",
    "items",
    "unique_literature_count",
  ]);
  if (
    c.schema_version !== 2 ||
    !["complete", "partial"].includes(c.status as string) ||
    !["require-all", "allow-partial"].includes(c.policy as string) ||
    !Array.isArray(c.items) ||
    c.items.length !== manifest.items.length
  )
    fail();
  let usable = 0;
  const items = c.items.map((entry, index) => {
    const i = exact(entry, ["input_id", "status", "reason"]);
    const source = manifest.items[index];
    if (
      !source ||
      i.input_id !== source.input_id ||
      !["included", "degraded", "excluded"].includes(i.status as string)
    )
      fail();
    const status = i.status as SynthesisCoverageItem["status"];
    const reason = i.reason as SynthesisCoverageItem["reason"];
    if (
      (status === "included") !== (reason === null) ||
      (reason !== null &&
        ![
          "material-missing",
          "document-missing",
          "document-unsupported",
          "knowledge-missing",
          "original-unavailable",
        ].includes(reason)) ||
      (status === "degraded" &&
        (source.kind !== "knowledge" ||
          source.state !== "source-only" ||
          reason !== "original-unavailable")) ||
      (status === "included" &&
        (source.kind === "knowledge"
          ? source.state !== "verified"
          : !source.material ||
            !source.document ||
            source.gaps.length !== 0)) ||
      (status === "excluded" &&
        (source.kind === "knowledge"
          ? source.state !== "missing" || reason !== "knowledge-missing"
          : source.gaps.length === 0 ||
            !source.gaps.includes(reason as (typeof source.gaps)[number])))
    )
      fail();
    if (status !== "excluded") usable++;
    return Object.freeze({ input_id: source.input_id, status, reason });
  });
  if (
    !usable ||
    (c.status === "complete") !== items.every((i) => i.status === "included") ||
    (c.policy === "require-all" && c.status !== "complete")
  )
    fail();
  return Object.freeze({
    schema_version: 2,
    status: c.status as SynthesisCoverage["status"],
    policy: c.policy as SynthesisPolicy,
    items: Object.freeze(items),
    unique_literature_count: integer(c.unique_literature_count, 1024, 1),
  });
}
export async function synthesisComparisonSha256(input: {
  readonly manifest_sha256: string;
  readonly question: string;
  readonly policy: SynthesisPolicy;
  readonly method: KnowledgeMethod;
}): Promise<string> {
  if (!["require-all", "allow-partial"].includes(input.policy)) fail();
  return sha256(
    extractionCanonicalJsonBytes(
      {
        scope: "knowledge-synthesis-comparison-v1",
        manifest_sha256: hash(input.manifest_sha256),
        purpose: "synthesis",
        question: storedQuestion(input.question),
        policy: input.policy,
        method: method(input.method),
      },
      32768,
    ),
  );
}
function artifactId(comparisonHash: string): string {
  return `${comparisonHash.slice(0, 8)}-${comparisonHash.slice(8, 12)}-${comparisonHash.slice(12, 16)}-${comparisonHash.slice(16, 20)}-${comparisonHash.slice(20, 32)}`;
}
export async function parseSynthesisArtifact(
  value: unknown,
): Promise<SynthesisArtifact> {
  const r = exact(bounded(value, SYNTHESIS_MAX_ARTIFACT_BYTES, 33, 20480), [
    "schema_version",
    "artifact_id",
    "comparison_sha256",
    "purpose",
    "question",
    "input",
    "method",
    "content_ref",
    "content",
    "coverage",
    "provenance",
    "compression_depth",
  ]);
  if (r.schema_version !== 2 || r.purpose !== "synthesis") fail();
  const input = await parseSynthesisInputManifest(r.input);
  const parsedMethod = method(r.method);
  const coverage = parseSynthesisCoverage(r.coverage, input);
  const content = parseSynthesisContent(r.content);
  const ref = parseArtifactRef(r.content_ref);
  const bytes = synthesisContentBytes(content);
  const parsedQuestion = storedQuestion(r.question);
  const comparison = await synthesisComparisonSha256({
    manifest_sha256: input.manifest_sha256,
    question: parsedQuestion,
    policy: coverage.policy,
    method: parsedMethod,
  });
  const depth =
    1 +
    Math.max(
      0,
      ...input.items.map((item) =>
        item.kind === "knowledge" ? (item.compression_depth ?? 0) : 0,
      ),
    );
  if (
    r.comparison_sha256 !== comparison ||
    r.artifact_id !== artifactId(comparison) ||
    r.compression_depth !== depth ||
    depth > 32 ||
    ref.media_type !== "application/vnd.sciretriever.knowledge+json" ||
    ref.byte_size !== bytes.length ||
    ref.sha256 !== (await sha256(bytes))
  )
    fail();
  const byId = new Map(input.items.map((item) => [item.input_id, item]));
  const usable = new Set(
    coverage.items
      .filter((item) => item.status !== "excluded")
      .map((item) => item.input_id),
  );
  for (const statement of content.statements)
    for (const evidence of statement.evidence) {
      const item = byId.get(evidence.input_id);
      if (
        !item ||
        !usable.has(evidence.input_id) ||
        item.kind !== evidence.target_kind
      )
        fail();
      if (evidence.target_kind === "document") {
        if (
          item.kind !== "document" ||
          !item.document ||
          evidence.evidence.document_version_id !==
            item.document.document_version_id ||
          evidence.evidence.representation_sha256 !==
            item.document.representation_sha256
        )
          fail();
      } else if (
        item.kind !== "knowledge" ||
        item.source_artifact_id !== evidence.source_artifact_id ||
        item.source_content_sha256 !== evidence.source_content_sha256
      )
        fail();
    }
  return freezeExtractionJson({
    schema_version: 2 as const,
    artifact_id: String(parseAssetId(r.artifact_id)),
    comparison_sha256: comparison,
    purpose: "synthesis" as const,
    question: parsedQuestion,
    input,
    method: parsedMethod,
    content_ref: ref,
    content,
    coverage,
    provenance: provenance(r.provenance),
    compression_depth: depth,
  });
}

/** Bind a maintenance result to the exact fixed request, including blocked gaps. */
export async function parseSynthesisExecutionReceipt(
  value: unknown,
  request: KnowledgeSynthesisRequest,
): Promise<SynthesisExecutionReceipt> {
  const r = exact(
    bounded(value, SYNTHESIS_MAX_ARTIFACT_BYTES + 32768, 33, 20480),
    [
      "schema_version",
      "outcome",
      "input_manifest_sha256",
      "policy",
      "question",
      "gaps",
      "artifact",
      "published",
    ],
  );
  if (
    r.schema_version !== 1 ||
    (r.outcome !== "blocked" && r.outcome !== "published") ||
    r.input_manifest_sha256 !== request.input.manifest_sha256 ||
    r.policy !== request.policy ||
    r.question !== request.question ||
    typeof r.published !== "boolean" ||
    !Array.isArray(r.gaps) ||
    r.gaps.length > request.input.items.length
  )
    fail();
  const byId = new Map(
    request.input.items.map((item) => [item.input_id, item]),
  );
  const seen = new Set<string>();
  const gaps = r.gaps.map((entry: unknown) => {
    const gap = exact(entry, ["input_id", "code"]);
    const inputId = id(gap.input_id);
    const item = byId.get(inputId);
    if (!item || seen.has(inputId)) fail();
    seen.add(inputId);
    const expected =
      item.kind === "knowledge"
        ? item.state === "missing"
          ? "knowledge-missing"
          : item.state === "source-only"
            ? "original-unavailable"
            : null
        : (item.gaps[0] ?? null);
    if (gap.code !== expected || expected === null) fail();
    return Object.freeze({ input_id: inputId, code: expected });
  });
  const required = request.input.items.filter((item) =>
    item.kind === "knowledge"
      ? item.state !== "verified"
      : item.gaps.length > 0,
  );
  if (
    seen.size !== required.length ||
    required.some((item) => !seen.has(item.input_id))
  )
    fail();
  if (r.outcome === "blocked") {
    if (
      r.artifact !== null ||
      r.published !== false ||
      (request.policy === "require-all" && gaps.length === 0) ||
      (request.policy === "allow-partial" &&
        request.input.items.some((item) =>
          item.kind === "knowledge"
            ? item.state !== "missing"
            : item.material !== null && item.document !== null,
        ))
    )
      fail();
    return Object.freeze({
      schema_version: 1,
      outcome: "blocked",
      input_manifest_sha256: request.input.manifest_sha256,
      policy: request.policy,
      question: request.question,
      gaps: Object.freeze(gaps),
      artifact: null,
      published: false,
    });
  }
  if (r.artifact === null) fail();
  const artifact = await parseSynthesisArtifact(r.artifact);
  if (
    artifact.input.manifest_sha256 !== request.input.manifest_sha256 ||
    artifact.question !== request.question ||
    artifact.coverage.policy !== request.policy
  )
    fail();
  return Object.freeze({
    schema_version: 1,
    outcome: "published",
    input_manifest_sha256: request.input.manifest_sha256,
    policy: request.policy,
    question: request.question,
    gaps: Object.freeze(gaps),
    artifact,
    published: r.published,
  });
}

export function parseSynthesisPreparationRequest(
  value: unknown,
): SynthesisPreparationRequest {
  const r = exact(bounded(value, SYNTHESIS_MAX_REQUEST_BYTES, 8, 2048), [
    "policy",
    "inputs",
  ]);
  if (r.policy !== "require-all" && r.policy !== "allow-partial") fail();
  return Object.freeze({
    policy: r.policy,
    inputs: parseSynthesisSelections(r.inputs),
  });
}

export async function parseSynthesisPreparationResult(
  value: unknown,
  request: SynthesisPreparationRequest,
): Promise<SynthesisPreparationResult> {
  // Manifest v2 permits 8193 nodes; the wrapper adds policy, readiness and up to 128 gaps.
  const snapshot = bounded(value, SYNTHESIS_MAX_REQUEST_BYTES, 33, 10240);
  if (!snapshot || typeof snapshot !== "object") fail();
  const r = exact(snapshot, ["manifest", "policy", "ready", "gaps"]);
  if (
    r.policy !== request.policy ||
    typeof r.ready !== "boolean" ||
    !Array.isArray(r.gaps) ||
    r.gaps.length > request.inputs.length
  )
    fail();
  const manifest = await parseSynthesisInputManifest(r.manifest);
  if (manifest.items.length !== request.inputs.length) fail();
  for (let index = 0; index < manifest.items.length; index++) {
    const item = manifest.items[index]!;
    const selection = request.inputs[index]!;
    if (
      item.kind !== selection.kind ||
      item.input_id !== selection.input_id ||
      (item.kind === "knowledge" && selection.kind === "knowledge"
        ? item.source_artifact_id !== selection.source_artifact_id
        : item.kind === "document" &&
          selection.kind === "document" &&
          (item.literature_id !== selection.literature_id ||
            (item.material?.asset_id ?? null) !== selection.asset_id ||
            (item.material?.asset_sha256 ?? null) !== selection.asset_sha256 ||
            (selection.document_version_id !== null &&
              item.document?.document_version_id !==
                selection.document_version_id)))
    )
      fail();
  }
  const expectedGaps = manifest.items.flatMap((item) =>
    item.kind === "knowledge"
      ? item.state === "verified"
        ? []
        : [
            {
              input_id: item.input_id,
              code:
                item.state === "missing"
                  ? "knowledge-missing"
                  : "original-unavailable",
            },
          ]
      : item.gaps.length
        ? [{ input_id: item.input_id, code: item.gaps[0]! }]
        : [],
  );
  const actualGaps = r.gaps.map((entry: unknown) => {
    const gap = exact(entry, ["input_id", "code"]);
    if (typeof gap.code !== "string") fail();
    return { input_id: id(gap.input_id), code: gap.code };
  });
  if (JSON.stringify(actualGaps) !== JSON.stringify(expectedGaps)) fail();
  const usable = manifest.items.some((item) =>
    item.kind === "knowledge"
      ? item.state !== "missing"
      : item.material !== null && item.document !== null,
  );
  if (
    r.ready !==
    (request.policy === "require-all" ? expectedGaps.length === 0 : usable)
  )
    fail();
  return Object.freeze({
    manifest,
    policy: request.policy,
    ready: r.ready,
    gaps: Object.freeze(actualGaps),
  });
}

export function parseSynthesisReadSelection(value: unknown): {
  readonly artifact_id: string;
} {
  const r = exact(bounded(value, 4096, 4, 16), ["artifact_id"]);
  return Object.freeze({ artifact_id: String(parseAssetId(r.artifact_id)) });
}
export function parseSynthesisListSelection(value: unknown): {
  readonly manifest_sha256: string | null;
  readonly limit: number;
} {
  const r = exact(bounded(value, 4096, 4, 16), ["manifest_sha256", "limit"]);
  return Object.freeze({
    manifest_sha256:
      r.manifest_sha256 === null ? null : hash(r.manifest_sha256),
    limit: integer(r.limit, 20, 1),
  });
}
export async function parseSynthesisReadResult(
  value: unknown,
  selection: { readonly artifact_id: string },
): Promise<SynthesisReadResult> {
  const r = exact(
    bounded(value, SYNTHESIS_MAX_ARTIFACT_BYTES + 32768, 33, 20480),
    ["artifact", "current_source_states", "independent_literature_ids"],
  );
  const artifact = await parseSynthesisArtifact(r.artifact);
  if (
    artifact.artifact_id !== selection.artifact_id ||
    !Array.isArray(r.current_source_states) ||
    r.current_source_states.length !== artifact.input.items.length ||
    !Array.isArray(r.independent_literature_ids) ||
    r.independent_literature_ids.length !==
      artifact.coverage.unique_literature_count
  )
    fail();
  const states = r.current_source_states.map((entry: unknown, index) => {
    const state = exact(entry, ["input_id", "state"]);
    if (
      state.input_id !== artifact.input.items[index]!.input_id ||
      !["verified", "source-only", "missing"].includes(state.state as string)
    )
      fail();
    return Object.freeze({
      input_id: state.input_id as string,
      state: state.state as "verified" | "source-only" | "missing",
    });
  });
  const ids = r.independent_literature_ids.map((item: unknown) =>
    String(parseLiteratureId(item)),
  );
  if (
    new Set(ids).size !== ids.length ||
    JSON.stringify(ids) !== JSON.stringify([...ids].sort())
  )
    fail();
  return Object.freeze({
    artifact,
    current_source_states: Object.freeze(states),
    independent_literature_ids: Object.freeze(ids),
  });
}
export async function parseSynthesisListResult(
  value: unknown,
  selection: {
    readonly manifest_sha256: string | null;
    readonly limit: number;
  },
): Promise<readonly SynthesisReadResult[]> {
  if (!Array.isArray(value) || value.length > selection.limit) fail();
  const seen = new Set<string>();
  const result: SynthesisReadResult[] = [];
  for (const entry of value) {
    const candidate = entry as { artifact?: { artifact_id?: string } };
    const id = String(parseAssetId(candidate?.artifact?.artifact_id));
    if (seen.has(id)) fail();
    seen.add(id);
    const parsed = await parseSynthesisReadResult(entry, { artifact_id: id });
    if (
      selection.manifest_sha256 !== null &&
      parsed.artifact.input.manifest_sha256 !== selection.manifest_sha256
    )
      fail();
    result.push(parsed);
  }
  return Object.freeze(result);
}
export async function parseSynthesisSourceResult(
  value: unknown,
  selection: { readonly artifact_id: string },
): Promise<{
  readonly artifact: KnowledgeArtifact | SynthesisArtifact;
  readonly state: "verified" | "source-only";
}> {
  const r = exact(
    bounded(value, SYNTHESIS_MAX_ARTIFACT_BYTES + 4096, 33, 20480),
    ["artifact", "state"],
  );
  if (r.state !== "verified" && r.state !== "source-only") fail();
  const raw = r.artifact as { schema_version?: unknown };
  const artifact =
    raw?.schema_version === 1
      ? await parseKnowledgeArtifact(r.artifact)
      : await parseSynthesisArtifact(r.artifact);
  if (artifact.artifact_id !== selection.artifact_id) fail();
  return Object.freeze({ artifact, state: r.state });
}
