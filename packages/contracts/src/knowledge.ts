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
import { extractionCanonicalJsonBytes } from "./extraction.js";
import { parseInputManifest, type InputManifest } from "./input-manifest.js";

export const KNOWLEDGE_MAX_REQUEST_BYTES = 300 * 1024;
export const KNOWLEDGE_MAX_CONTENT_BYTES = 512 * 1024;
export const KNOWLEDGE_MAX_ARTIFACT_BYTES = 1200 * 1024;
export type KnowledgePurpose =
  | "overview"
  | "detailed"
  | "question"
  | "synthesis";

export interface KnowledgeAnalysisRequest {
  readonly schema_version: 1;
  readonly input: InputManifest;
  readonly purpose: "overview" | "detailed" | "question";
  readonly question: string | null;
  readonly default_update: null | { readonly expected_revision: number | null };
  /** @deprecated Accepted for existing callers; fixed-input processing does not enforce it. */
  readonly budget?: {
    readonly max_input_bytes: number;
    readonly max_output_tokens: number;
  };
}
/** Finite chunked processing of an already fixed document. */
export interface KnowledgeLongAnalysisRequest {
  readonly schema_version: 2;
  readonly input: InputManifest;
  readonly purpose: KnowledgeAnalysisRequest["purpose"];
  readonly question: string | null;
  readonly default_update: KnowledgeAnalysisRequest["default_update"];
  /** @deprecated Accepted for existing callers; fixed-input processing does not enforce it. */
  readonly budget?: {
    readonly max_source_bytes: number;
    /** Canonical AgentCall bytes, including messages and response schema. */
    readonly max_call_bytes: number;
    readonly max_total_call_bytes: number;
    readonly max_calls: number;
    readonly max_output_tokens_per_call: number;
    readonly max_total_output_tokens: number;
  };
}
export interface KnowledgeStatement {
  readonly statement_id: string;
  readonly category:
    | "finding"
    | "method"
    | "result"
    | "limitation"
    | "disagreement";
  readonly epistemic: "reported" | "inference";
  readonly text: string;
  readonly conditions: readonly string[];
  readonly quantity: null | {
    readonly value: string;
    readonly unit: string;
    readonly comparison_basis: string | null;
  };
  readonly evidence: readonly EvidenceRef[];
}
export interface KnowledgeContent {
  readonly schema_version: 1;
  readonly title: string;
  readonly statements: readonly KnowledgeStatement[];
}
export interface KnowledgeCoverage {
  readonly status: "complete";
  readonly input_id: string;
  readonly document_version_id: string;
  readonly total_segments: number;
  readonly covered_segments: number;
  readonly total_utf8_bytes: number;
  readonly covered_utf8_bytes: number;
  readonly capability_gaps: readonly string[];
}
export interface KnowledgeMethod {
  readonly id: string;
  readonly version: string;
  readonly parameters_sha256: string;
  readonly model_binding_sha256: string;
}
export interface KnowledgeProvenance {
  readonly provider: string;
  readonly model: string;
  readonly generated_at: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
}
export interface KnowledgeArtifact {
  readonly schema_version: 1;
  readonly artifact_id: string;
  readonly comparison_sha256: string;
  readonly purpose: KnowledgePurpose;
  readonly question: string | null;
  readonly input: InputManifest;
  readonly method: KnowledgeMethod;
  readonly content_ref: ArtifactRef;
  readonly content: KnowledgeContent;
  readonly coverage: KnowledgeCoverage;
  readonly provenance: KnowledgeProvenance;
}
export interface KnowledgeAnalysisReceipt {
  readonly schema_version: 1;
  readonly artifact: KnowledgeArtifact;
  readonly published: boolean;
  readonly default_updated: boolean;
  readonly default_revision: number | null;
  readonly default_update_outcome:
    | "not-requested"
    | "updated"
    | "conflict"
    | "cancelled"
    | "failed";
  readonly default_update_failure:
    | null
    | "write-admission-conflict"
    | "write-admission-closed"
    | "storage-failed";
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
function string(value: unknown, maxBytes: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return (
        (code <= 31 && ![9, 10, 13].includes(code)) ||
        (code >= 127 && code <= 159)
      );
    }) ||
    (!allowEmpty && !value.trim()) ||
    new TextEncoder().encode(value).length > maxBytes
  )
    fail();
  return value;
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
function boundedSnapshot(value: unknown, limit: number): unknown {
  return JSON.parse(
    new TextDecoder().decode(
      extractionCanonicalJsonBytes(value, limit, {
        maxDepth: 32,
        maxNodes: 20480,
        maxArrayLength: 20480,
      }),
    ),
  ) as unknown;
}
export function normalizeKnowledgeQuestion(value: unknown): string {
  if (typeof value !== "string") fail();
  return string(value.normalize("NFC").trim(), 4096);
}
function question(value: unknown, purpose: KnowledgePurpose): string | null {
  if (purpose !== "question") {
    if (value !== null) fail();
    return null;
  }
  return normalizeKnowledgeQuestion(value);
}
function storedQuestion(
  value: unknown,
  purpose: KnowledgePurpose,
): string | null {
  const parsed = question(value, purpose);
  if (parsed !== value) fail();
  return parsed;
}
export async function knowledgeComparisonSha256(input: {
  readonly manifest_sha256: string;
  readonly purpose: KnowledgeAnalysisRequest["purpose"];
  readonly question: string | null;
  readonly method: KnowledgeMethod;
}): Promise<string> {
  if (!["overview", "detailed", "question"].includes(input.purpose)) fail();
  const method = exact(input.method, [
    "id",
    "version",
    "parameters_sha256",
    "model_binding_sha256",
  ]);
  return sha256(
    extractionCanonicalJsonBytes(
      {
        scope: "knowledge-analysis-comparison-v1",
        manifest_sha256: hash(input.manifest_sha256),
        purpose: input.purpose,
        question: storedQuestion(input.question, input.purpose),
        method: {
          id: string(method.id, 128),
          version: string(method.version, 128),
          parameters_sha256: hash(method.parameters_sha256),
          model_binding_sha256: hash(method.model_binding_sha256),
        },
      },
      32768,
    ),
  );
}
function artifactId(comparisonHash: string): string {
  return `${comparisonHash.slice(0, 8)}-${comparisonHash.slice(8, 12)}-${comparisonHash.slice(12, 16)}-${comparisonHash.slice(16, 20)}-${comparisonHash.slice(20, 32)}`;
}
export async function parseKnowledgeAnalysisRequest(
  value: unknown,
): Promise<KnowledgeAnalysisRequest> {
  const snapshot = boundedSnapshot(value, KNOWLEDGE_MAX_REQUEST_BYTES);
  if (!snapshot || typeof snapshot !== "object") fail();
  const r = exact(snapshot, [
    "schema_version",
    "input",
    "purpose",
    "question",
    "default_update",
    ...(Object.hasOwn(snapshot, "budget") ? ["budget"] : []),
  ]);
  if (
    r.schema_version !== 1 ||
    !["overview", "detailed", "question"].includes(r.purpose as string)
  )
    fail();
  const purpose = r.purpose as KnowledgeAnalysisRequest["purpose"];
  const input = await parseInputManifest(r.input);
  if (
    input.items.length !== 1 ||
    !input.items[0]?.material ||
    !input.items[0].document ||
    input.items[0].gaps.length
  )
    fail();
  const defaultUpdate =
    r.default_update === null
      ? null
      : exact(r.default_update, ["expected_revision"]);
  const revision =
    defaultUpdate === null
      ? null
      : defaultUpdate.expected_revision === null
        ? null
        : integer(defaultUpdate.expected_revision, 2147483647, 1);
  const budget =
    r.budget === undefined
      ? undefined
      : exact(r.budget, ["max_input_bytes", "max_output_tokens"]);
  return Object.freeze({
    schema_version: 1 as const,
    input,
    purpose,
    question: question(r.question, purpose),
    default_update:
      defaultUpdate === null
        ? null
        : Object.freeze({ expected_revision: revision }),
    ...(budget === undefined
      ? {}
      : {
          budget: Object.freeze({
            max_input_bytes: integer(
              budget.max_input_bytes,
              Number.MAX_SAFE_INTEGER,
              1,
            ),
            max_output_tokens: integer(
              budget.max_output_tokens,
              Number.MAX_SAFE_INTEGER,
              1,
            ),
          }),
        }),
  });
}
export async function parseKnowledgeLongAnalysisRequest(
  value: unknown,
): Promise<KnowledgeLongAnalysisRequest> {
  const snapshot = boundedSnapshot(value, KNOWLEDGE_MAX_REQUEST_BYTES);
  if (!snapshot || typeof snapshot !== "object") fail();
  const r = exact(snapshot, [
    "schema_version",
    "input",
    "purpose",
    "question",
    "default_update",
    ...(Object.hasOwn(snapshot, "budget") ? ["budget"] : []),
  ]);
  if (
    r.schema_version !== 2 ||
    !["overview", "detailed", "question"].includes(r.purpose as string)
  )
    fail();
  const purpose = r.purpose as KnowledgeLongAnalysisRequest["purpose"];
  const input = await parseInputManifest(r.input);
  if (
    input.items.length !== 1 ||
    !input.items[0]?.material ||
    !input.items[0].document ||
    input.items[0].gaps.length
  )
    fail();
  const defaultUpdate =
    r.default_update === null
      ? null
      : exact(r.default_update, ["expected_revision"]);
  const revision =
    defaultUpdate === null
      ? null
      : defaultUpdate.expected_revision === null
        ? null
        : integer(defaultUpdate.expected_revision, 2147483647, 1);
  const legacy =
    r.budget === undefined
      ? undefined
      : exact(r.budget, [
          "max_source_bytes",
          "max_call_bytes",
          "max_total_call_bytes",
          "max_calls",
          "max_output_tokens_per_call",
          "max_total_output_tokens",
        ]);
  const budget =
    legacy === undefined
      ? undefined
      : Object.freeze({
          max_source_bytes: integer(
            legacy.max_source_bytes,
            Number.MAX_SAFE_INTEGER,
            1,
          ),
          max_call_bytes: integer(
            legacy.max_call_bytes,
            Number.MAX_SAFE_INTEGER,
            1,
          ),
          max_total_call_bytes: integer(
            legacy.max_total_call_bytes,
            Number.MAX_SAFE_INTEGER,
            1,
          ),
          max_calls: integer(legacy.max_calls, Number.MAX_SAFE_INTEGER, 1),
          max_output_tokens_per_call: integer(
            legacy.max_output_tokens_per_call,
            Number.MAX_SAFE_INTEGER,
            1,
          ),
          max_total_output_tokens: integer(
            legacy.max_total_output_tokens,
            Number.MAX_SAFE_INTEGER,
            1,
          ),
        });
  return Object.freeze({
    schema_version: 2 as const,
    input,
    purpose,
    question: question(r.question, purpose),
    default_update:
      defaultUpdate === null
        ? null
        : Object.freeze({ expected_revision: revision }),
    ...(budget === undefined ? {} : { budget }),
  });
}
export function parseKnowledgeContent(value: unknown): KnowledgeContent {
  const r = exact(boundedSnapshot(value, KNOWLEDGE_MAX_CONTENT_BYTES), [
    "schema_version",
    "title",
    "statements",
  ]);
  if (
    r.schema_version !== 1 ||
    !Array.isArray(r.statements) ||
    r.statements.length < 1
  )
    fail();
  const ids = new Set<string>();
  const statements: KnowledgeStatement[] = r.statements.map((entry) => {
    const s = exact(entry, [
      "statement_id",
      "category",
      "epistemic",
      "text",
      "conditions",
      "quantity",
      "evidence",
    ]);
    const id = string(s.statement_id, 128);
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id) ||
      ids.has(id) ||
      !["finding", "method", "result", "limitation", "disagreement"].includes(
        s.category as string,
      ) ||
      !["reported", "inference"].includes(s.epistemic as string) ||
      !Array.isArray(s.conditions) ||
      !Array.isArray(s.evidence) ||
      s.evidence.length < 1
    )
      fail();
    ids.add(id);
    const quantity =
      s.quantity === null
        ? null
        : exact(s.quantity, ["value", "unit", "comparison_basis"]);
    return Object.freeze({
      statement_id: id,
      category: s.category as KnowledgeStatement["category"],
      epistemic: s.epistemic as KnowledgeStatement["epistemic"],
      text: string(s.text, KNOWLEDGE_MAX_CONTENT_BYTES),
      conditions: Object.freeze(
        s.conditions.map((item) => string(item, KNOWLEDGE_MAX_CONTENT_BYTES)),
      ),
      quantity:
        quantity === null
          ? null
          : Object.freeze({
              value: string(quantity.value, KNOWLEDGE_MAX_CONTENT_BYTES),
              unit: string(quantity.unit, KNOWLEDGE_MAX_CONTENT_BYTES),
              comparison_basis:
                quantity.comparison_basis === null
                  ? null
                  : string(
                      quantity.comparison_basis,
                      KNOWLEDGE_MAX_CONTENT_BYTES,
                    ),
            }),
      evidence: Object.freeze(s.evidence.map((item) => parseEvidenceRef(item))),
    });
  });
  return Object.freeze({
    schema_version: 1,
    title: string(r.title, KNOWLEDGE_MAX_CONTENT_BYTES),
    statements: Object.freeze(statements),
  });
}
export function knowledgeContentBytes(value: KnowledgeContent): Uint8Array {
  return extractionCanonicalJsonBytes(
    parseKnowledgeContent(value),
    KNOWLEDGE_MAX_CONTENT_BYTES,
    { maxDepth: 32, maxNodes: 20480, maxArrayLength: 20480 },
  );
}
/** Canonical identity for one complete knowledge statement. */
export async function knowledgeStatementSha256(
  value: KnowledgeStatement | unknown,
): Promise<string> {
  const statement = parseKnowledgeContent({
    schema_version: 1,
    title: "Indexed knowledge",
    statements: [value],
  }).statements[0]!;
  return sha256(
    extractionCanonicalJsonBytes(statement, KNOWLEDGE_MAX_CONTENT_BYTES, {
      maxDepth: 32,
      maxNodes: 20480,
      maxArrayLength: 20480,
    }),
  );
}
export async function parseKnowledgeArtifact(
  value: unknown,
): Promise<KnowledgeArtifact> {
  const r = exact(boundedSnapshot(value, KNOWLEDGE_MAX_ARTIFACT_BYTES), [
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
  ]);
  if (
    r.schema_version !== 1 ||
    !["overview", "detailed", "question"].includes(r.purpose as string)
  )
    fail();
  const purpose = r.purpose as KnowledgePurpose;
  const input = await parseInputManifest(r.input);
  if (
    input.items.length !== 1 ||
    !input.items[0]?.material ||
    !input.items[0].document ||
    input.items[0].gaps.length
  )
    fail();
  const method = exact(r.method, [
    "id",
    "version",
    "parameters_sha256",
    "model_binding_sha256",
  ]);
  const coverage = exact(r.coverage, [
    "status",
    "input_id",
    "document_version_id",
    "total_segments",
    "covered_segments",
    "total_utf8_bytes",
    "covered_utf8_bytes",
    "capability_gaps",
  ]);
  const provenance = exact(r.provenance, [
    "provider",
    "model",
    "generated_at",
    "input_tokens",
    "output_tokens",
  ]);
  const content = parseKnowledgeContent(r.content);
  const contentRef = parseArtifactRef(r.content_ref);
  const bytes = knowledgeContentBytes(content);
  const parsedMethod = Object.freeze({
    id: string(method.id, 128),
    version: string(method.version, 128),
    parameters_sha256: hash(method.parameters_sha256),
    model_binding_sha256: hash(method.model_binding_sha256),
  });
  const parsedQuestion = storedQuestion(r.question, purpose);
  const comparisonHash = await knowledgeComparisonSha256({
    manifest_sha256: input.manifest_sha256,
    purpose: purpose as KnowledgeAnalysisRequest["purpose"],
    question: parsedQuestion,
    method: parsedMethod,
  });
  const document = input.items[0].document;
  if (
    r.comparison_sha256 !== comparisonHash ||
    r.artifact_id !== artifactId(comparisonHash) ||
    content.statements.some((statement) =>
      statement.evidence.some(
        (evidence) =>
          evidence.target_kind !== "document" ||
          evidence.document_version_id !== document.document_version_id ||
          evidence.representation_sha256 !== document.representation_sha256 ||
          evidence.locator_scheme !== document.locator_scheme,
      ),
    ) ||
    contentRef.media_type !== "application/vnd.sciretriever.knowledge+json" ||
    contentRef.byte_size !== bytes.length ||
    contentRef.sha256 !== (await sha256(bytes)) ||
    coverage.status !== "complete" ||
    !Array.isArray(coverage.capability_gaps) ||
    coverage.capability_gaps.length > 16 ||
    coverage.input_id !== input.items[0]?.input_id ||
    coverage.document_version_id !==
      input.items[0]?.document?.document_version_id ||
    coverage.total_segments !== coverage.covered_segments ||
    coverage.total_utf8_bytes !== coverage.covered_utf8_bytes
  )
    fail();
  return Object.freeze({
    schema_version: 1,
    artifact_id: String(parseAssetId(r.artifact_id)),
    comparison_sha256: comparisonHash,
    purpose,
    question: parsedQuestion,
    input,
    method: parsedMethod,
    content_ref: contentRef,
    content,
    coverage: Object.freeze({
      status: "complete" as const,
      input_id: string(coverage.input_id, 128),
      document_version_id: String(parseAssetId(coverage.document_version_id)),
      total_segments: integer(coverage.total_segments, 100000),
      covered_segments: integer(coverage.covered_segments, 100000),
      total_utf8_bytes: integer(coverage.total_utf8_bytes, 16 * 1024 * 1024),
      covered_utf8_bytes: integer(
        coverage.covered_utf8_bytes,
        16 * 1024 * 1024,
      ),
      capability_gaps: Object.freeze(
        coverage.capability_gaps.map((item) => string(item, 128)),
      ),
    }),
    provenance: Object.freeze({
      provider: string(provenance.provider, 128),
      model: string(provenance.model, 512),
      generated_at: timestamp(provenance.generated_at),
      input_tokens: integer(provenance.input_tokens, 1000000000),
      output_tokens: integer(provenance.output_tokens, 1000000000),
    }),
  });
}
function timestamp(value: unknown): string {
  const parsed = string(value, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed) ||
    !Number.isFinite(Date.parse(parsed)) ||
    new Date(parsed).toISOString() !== parsed
  )
    fail();
  return parsed;
}
export async function parseKnowledgeAnalysisReceipt(
  value: unknown,
  request?: KnowledgeAnalysisRequest | KnowledgeLongAnalysisRequest,
): Promise<KnowledgeAnalysisReceipt> {
  const r = exact(boundedSnapshot(value, KNOWLEDGE_MAX_ARTIFACT_BYTES + 1024), [
    "schema_version",
    "artifact",
    "published",
    "default_updated",
    "default_revision",
    "default_update_outcome",
    "default_update_failure",
  ]);
  if (
    r.schema_version !== 1 ||
    typeof r.published !== "boolean" ||
    typeof r.default_updated !== "boolean" ||
    !["not-requested", "updated", "conflict", "cancelled", "failed"].includes(
      r.default_update_outcome as string,
    ) ||
    r.default_updated !== (r.default_update_outcome === "updated") ||
    ((r.default_update_outcome === "not-requested" ||
      r.default_update_outcome === "cancelled" ||
      r.default_update_outcome === "failed") &&
      r.default_revision !== null) ||
    (r.default_update_outcome === "updated" && r.default_revision === null) ||
    (r.default_update_outcome === "failed"
      ? ![
          "write-admission-conflict",
          "write-admission-closed",
          "storage-failed",
        ].includes(r.default_update_failure as string)
      : r.default_update_failure !== null)
  )
    fail();
  const artifact = await parseKnowledgeArtifact(r.artifact);
  if (
    request &&
    (artifact.input.manifest_sha256 !== request.input.manifest_sha256 ||
      artifact.purpose !== request.purpose ||
      artifact.question !== request.question ||
      (request.default_update === null) !==
        (r.default_update_outcome === "not-requested"))
  )
    fail();
  return Object.freeze({
    schema_version: 1,
    artifact,
    published: r.published,
    default_updated: r.default_updated,
    default_update_outcome:
      r.default_update_outcome as KnowledgeAnalysisReceipt["default_update_outcome"],
    default_update_failure:
      r.default_update_failure as KnowledgeAnalysisReceipt["default_update_failure"],
    default_revision:
      r.default_revision === null
        ? null
        : integer(r.default_revision, 2147483647, 1),
  });
}
export function knowledgeQuestionSha256(value: string | null): Promise<string> {
  return sha256(new TextEncoder().encode(value ?? ""));
}
export function knowledgeLiteratureId(value: unknown): string {
  return String(parseLiteratureId(value));
}

export function parseKnowledgeReadSelection(value: unknown): {
  readonly artifact_id: string;
} {
  const r = exact(boundedSnapshot(value, 8192), ["artifact_id"]);
  return Object.freeze({ artifact_id: String(parseAssetId(r.artifact_id)) });
}
export function parseKnowledgeListSelection(value: unknown): {
  readonly literature_id: string;
  readonly limit: number;
} {
  const r = exact(boundedSnapshot(value, 8192), ["literature_id", "limit"]);
  return Object.freeze({
    literature_id: String(parseLiteratureId(r.literature_id)),
    limit: integer(r.limit, 20, 1),
  });
}
export async function parseKnowledgeReadResult(
  value: unknown,
  selection: { readonly artifact_id: string },
): Promise<KnowledgeArtifact> {
  const artifact = await parseKnowledgeArtifact(value);
  if (artifact.artifact_id !== selection.artifact_id) fail();
  return artifact;
}
export async function parseKnowledgeListResult(
  value: unknown,
  selection: { readonly literature_id: string; readonly limit: number },
): Promise<readonly KnowledgeArtifact[]> {
  if (!Array.isArray(value) || value.length > selection.limit) fail();
  const artifacts = await Promise.all(
    value.map((item) => parseKnowledgeArtifact(item)),
  );
  if (
    new Set(artifacts.map((item) => item.artifact_id)).size !==
      artifacts.length ||
    artifacts.some(
      (item) => item.input.items[0]?.literature_id !== selection.literature_id,
    )
  )
    fail();
  return Object.freeze(artifacts);
}
export async function parseKnowledgeDefaultResult(
  value: unknown,
  selection: ReturnType<typeof parseKnowledgeDefaultSelection>,
): Promise<{
  readonly revision: number;
  readonly artifact: KnowledgeArtifact;
}> {
  const r = exact(boundedSnapshot(value, KNOWLEDGE_MAX_ARTIFACT_BYTES + 1024), [
    "revision",
    "artifact",
  ]);
  const artifact = await parseKnowledgeArtifact(r.artifact);
  if (
    artifact.input.items[0]?.literature_id !== selection.literature_id ||
    artifact.purpose !== selection.purpose ||
    artifact.question !== selection.question
  )
    fail();
  return Object.freeze({
    revision: integer(r.revision, 2147483647, 1),
    artifact,
  });
}

export function parseKnowledgeDefaultSelection(value: unknown): {
  readonly literature_id: string;
  readonly purpose: "overview" | "detailed" | "question";
  readonly question: string | null;
} {
  const r = exact(boundedSnapshot(value, 8192), [
    "literature_id",
    "purpose",
    "question",
  ]);
  if (!["overview", "detailed", "question"].includes(r.purpose as string))
    fail();
  const purpose = r.purpose as "overview" | "detailed" | "question";
  return Object.freeze({
    literature_id: String(parseLiteratureId(r.literature_id)),
    purpose,
    question: question(r.question, purpose),
  });
}
