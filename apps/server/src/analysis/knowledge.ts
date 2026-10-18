import { createHash } from "node:crypto";
import {
  extractionCanonicalJsonBytes,
  knowledgeComparisonSha256,
  knowledgeContentBytes,
  knowledgeQuestionSha256,
  parseEvidenceRef,
  parseKnowledgeAnalysisRequest,
  parseKnowledgeLongAnalysisRequest,
  parseKnowledgeAnalysisReceipt,
  parseKnowledgeArtifact,
  parseKnowledgeContent,
  sha256,
  type KnowledgeAnalysisReceipt,
  type KnowledgeAnalysisRequest,
  type KnowledgeLongAnalysisRequest,
  type KnowledgeContent,
  type KnowledgeArtifact,
  type KnowledgeStatement,
} from "@sciretriever/contracts";
import type { AgentRuntime } from "../agents/runtime.js";
import type { AgentCall } from "../agents/protocol.js";
import { AgentFailure } from "../agents/protocol.js";
import type { DocumentReadService } from "../document/read.js";
import type { KnowledgeStoragePort } from "./knowledge-port.js";
import { WriteAdmissionError } from "../storage/write-admission.js";
import {
  analyzeLongDocument,
  LONG_METHOD_ID,
  LONG_METHOD_VERSION,
  longMethodParameters,
} from "./knowledge-long.js";

const METHOD_ID = "single-document-knowledge";
const METHOD_VERSION = "2";
const SYSTEM_PROMPT =
  "Analyze the entire supplied document for the stated purpose. Preserve source conditions, negation, quantities, units, limitations, and disagreements. Distinguish author reports from your inference. Cite only supplied segment IDs. If the document cannot answer the purpose, return not_applicable. Return only the required JSON object.";
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** The processor adapter fingerprints the same policy as the legacy entry. */
export function knowledgeMethodDefinition(): object {
  return {
    method_id: METHOD_ID,
    method_version: METHOD_VERSION,
    prompt: SYSTEM_PROMPT,
    response_schema: modelSchema(),
  };
}

export interface KnowledgeCallAccounting {
  readonly calls_dispatched: number;
  readonly canonical_call_bytes: number;
  readonly reported_calls: number;
  readonly reported_input_tokens: number;
  readonly reported_output_tokens: number;
  readonly usage_complete: boolean;
}

export class KnowledgeAnalysisFailure extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions & {
      readonly reason?: string;
      readonly retryable?: boolean;
      readonly accounting?: KnowledgeCallAccounting;
    },
  ) {
    super("knowledge analysis failed", options);
    this.reason = options?.reason ?? null;
    this.retryable = options?.retryable ?? false;
    this.accounting = options?.accounting ?? null;
  }
  readonly reason: string | null;
  readonly retryable: boolean;
  readonly accounting: KnowledgeCallAccounting | null;
}
function fail(code: string): never {
  throw new KnowledgeAnalysisFailure(code);
}
function canonical(value: unknown, maxBytes = 1024 * 1024): Uint8Array {
  return extractionCanonicalJsonBytes(value, maxBytes, {
    maxDepth: 32,
    maxNodes: 20480,
    maxArrayLength: 20480,
  });
}
function uuid(hash: string): string {
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
function shape(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail("knowledge-response");
  return value as Record<string, unknown>;
}
function modelSchema(): Record<string, unknown> {
  const string = { type: "string" };
  const nullableString = { anyOf: [string, { type: "null" }] };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      outcome: { type: "string", enum: ["completed", "not_applicable"] },
      title: string,
      statements: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            statement_id: string,
            category: {
              type: "string",
              enum: [
                "finding",
                "method",
                "result",
                "limitation",
                "disagreement",
              ],
            },
            epistemic: { type: "string", enum: ["reported", "inference"] },
            text: string,
            conditions: { type: "array", items: string },
            quantity: {
              anyOf: [
                { type: "null" },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    value: string,
                    unit: string,
                    comparison_basis: nullableString,
                  },
                  required: ["value", "unit", "comparison_basis"],
                },
              ],
            },
            evidence_segment_ids: { type: "array", items: string },
          },
          required: [
            "statement_id",
            "category",
            "epistemic",
            "text",
            "conditions",
            "quantity",
            "evidence_segment_ids",
          ],
        },
      },
    },
    required: ["outcome", "title", "statements"],
  };
}

export class KnowledgeAnalysisService {
  private readonly stop = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly documents: DocumentReadService,
    private readonly agents: AgentRuntime,
    private readonly storage: KnowledgeStoragePort,
  ) {}

  analyze(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeAnalysisReceipt> {
    if (this.stop.signal.aborted)
      return Promise.reject(new KnowledgeAnalysisFailure("knowledge-closed"));
    // Own the supplied request before the first suspension, including nested arrays.
    const operation = this.execute(value, signal);
    this.active.add(operation);
    void operation
      .finally(() => this.active.delete(operation))
      .catch(() => undefined);
    return operation;
  }
  analyzeLong(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeAnalysisReceipt> {
    if (this.stop.signal.aborted)
      return Promise.reject(new KnowledgeAnalysisFailure("knowledge-closed"));
    const operation = this.executeLong(value, signal);
    this.active.add(operation);
    void operation
      .finally(() => this.active.delete(operation))
      .catch(() => undefined);
    return operation;
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.stop.abort();
      this.closing = Promise.allSettled([...this.active]).then(() => undefined);
    }
    return this.closing;
  }
  private async execute(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeAnalysisReceipt> {
    let request: KnowledgeAnalysisRequest;
    try {
      request = await parseKnowledgeAnalysisRequest(value);
    } catch (error) {
      throw new KnowledgeAnalysisFailure("knowledge-input", { cause: error });
    }
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    if (active.aborted) fail("knowledge-cancelled");
    const readiness = this.agents.readiness("analysis");
    if (!readiness.configured || readiness.missing.length)
      fail("knowledge-unconfigured");
    const binding = this.agents.effectiveIdentity("analysis");
    const bindingHash = await sha256(canonical(binding, 16384));
    const schema = modelSchema();
    const parameters = {
      method_id: METHOD_ID,
      method_version: METHOD_VERSION,
      prompt: SYSTEM_PROMPT,
      response_schema: schema,
      model_binding_sha256: bindingHash,
    };
    const parametersHash = await sha256(canonical(parameters, 32768));
    const method = {
      id: METHOD_ID,
      version: METHOD_VERSION,
      parameters_sha256: parametersHash,
      model_binding_sha256: bindingHash,
    };
    const comparisonHash = await knowledgeComparisonSha256({
      manifest_sha256: request.input.manifest_sha256,
      purpose: request.purpose,
      question: request.question,
      method,
    });
    const item = request.input.items[0]!;
    const questionHash = await knowledgeQuestionSha256(request.question);
    const existing = await this.storage.byComparison(comparisonHash, active);
    if (existing)
      return this.finish(existing, false, request, questionHash, active);
    if (active.aborted) fail("knowledge-cancelled");
    const document = item.document!;
    const material = item.material!;
    let documentInput: {
      readonly text: string;
      readonly source_bytes: Uint8Array;
      readonly segments: readonly {
        id: string;
        start: number;
        end: number;
        hash: string;
      }[];
      readonly gaps: readonly string[];
    };
    try {
      const read = await this.documents.withVerifiedVersion(
        document.document_version_id,
        async (version, bytes, structure) => {
          if (
            version.representation_sha256 !== document.representation_sha256 ||
            version.source_material_ref.asset_id !== material.asset_id ||
            version.source_material_ref.asset_sha256 !==
              material.asset_sha256 ||
            version.source_material_ref.literature_id !== item.literature_id
          )
            fail("knowledge-input-invalidated");
          const segments = await Promise.all(
            structure.segments.map(async (segment) => ({
              id: segment.segment_id,
              start: segment.start_utf8,
              end: segment.end_utf8,
              hash: await sha256(
                bytes.subarray(segment.start_utf8, segment.end_utf8),
              ),
            })),
          );
          const texts = segments.map((segment) => ({
            segment_id: segment.id,
            text: decoder.decode(bytes.subarray(segment.start, segment.end)),
          }));
          let prompt: Uint8Array;
          try {
            prompt = canonical({
              purpose: request.purpose,
              question: request.question,
              document_version_id: document.document_version_id,
              representation_sha256: document.representation_sha256,
              segments: texts,
            });
          } catch (error) {
            return { request_error: error };
          }
          return {
            text: decoder.decode(prompt),
            source_bytes: bytes,
            segments,
            gaps: [
              "table-structure-unavailable",
              "figure-caption-unavailable",
              "page-location-unavailable",
              "bbox-unavailable",
            ],
          };
        },
        active,
      );
      if ("request_error" in read)
        throw new KnowledgeAnalysisFailure("knowledge-request-limit", {
          cause: read.request_error,
        });
      documentInput = read;
    } catch (error) {
      if (error instanceof KnowledgeAnalysisFailure) throw error;
      if (active.aborted) fail("knowledge-cancelled");
      throw new KnowledgeAnalysisFailure("knowledge-input-invalidated", {
        cause: error,
      });
    }
    if (active.aborted) fail("knowledge-cancelled");
    const userBytes = encoder.encode(documentInput.text);
    const schemaBytes = canonical(schema, 32768);
    const systemBytes = encoder.encode(SYSTEM_PROMPT);
    if (
      userBytes.length > 1024 * 1024 ||
      systemBytes.length > 1024 * 1024 ||
      schemaBytes.length > 32768
    )
      fail("knowledge-request-limit");
    const call: AgentCall = {
      role: "analysis",
      required_capabilities: ["structured_text"],
      input_sha256: createHash("sha256").update(userBytes).digest("hex"),
      messages: [
        {
          role: "system",
          parts: [{ media_type: "text/plain", text: SYSTEM_PROMPT }],
        },
        {
          role: "user",
          parts: [{ media_type: "application/json", text: documentInput.text }],
        },
      ],
      response_schema: schema,
    };
    let result;
    try {
      result = await this.agents.execute(call, active);
    } catch (error) {
      if (active.aborted) fail("knowledge-cancelled");
      throw new KnowledgeAnalysisFailure("knowledge-model-failed", {
        cause: error,
        ...(error instanceof AgentFailure
          ? {
              reason: /^agent-[a-z-]{1,56}$/.test(error.code)
                ? error.code
                : "agent-internal",
              retryable: error.retryable,
            }
          : {}),
      });
    }
    if (active.aborted) fail("knowledge-cancelled");
    if (result.kind !== "structured") fail("knowledge-response");
    let response: Record<string, unknown>;
    try {
      response = shape(
        JSON.parse(
          decoder.decode(canonical(result.value, 512 * 1024)),
        ) as unknown,
        ["outcome", "title", "statements"],
      );
    } catch (error) {
      throw new KnowledgeAnalysisFailure("knowledge-response", {
        cause: error,
      });
    }
    if (response.outcome === "not_applicable") {
      if (
        typeof response.title !== "string" ||
        !response.title.trim() ||
        !Array.isArray(response.statements) ||
        response.statements.length !== 0
      )
        fail("knowledge-response");
      fail("knowledge-not-applicable");
    }
    if (
      response.outcome !== "completed" ||
      !Array.isArray(response.statements) ||
      response.statements.length < 1
    )
      fail("knowledge-response");
    const byId = new Map(
      documentInput.segments.map((segment) => [segment.id, segment]),
    );
    let content: KnowledgeContent;
    try {
      const statements: KnowledgeStatement[] = response.statements.map(
        (entry) => {
          const statement = shape(entry, [
            "statement_id",
            "category",
            "epistemic",
            "text",
            "conditions",
            "quantity",
            "evidence_segment_ids",
          ]);
          if (
            !Array.isArray(statement.evidence_segment_ids) ||
            statement.evidence_segment_ids.length < 1
          )
            fail("knowledge-invalid-evidence");
          const evidence = [...new Set(statement.evidence_segment_ids)].map(
            (id) => {
              if (typeof id !== "string") fail("knowledge-invalid-evidence");
              const segment = byId.get(id);
              if (!segment) fail("knowledge-invalid-evidence");
              return parseEvidenceRef({
                schema_version: 1,
                target_kind: "document",
                locator_scheme: "utf8-segment-v1",
                document_version_id: document.document_version_id,
                representation_sha256: document.representation_sha256,
                locator: { kind: "segment", segment_id: id },
                content_sha256: segment.hash,
              });
            },
          );
          return {
            statement_id: statement.statement_id,
            category: statement.category,
            epistemic: statement.epistemic,
            text: statement.text,
            conditions: statement.conditions,
            quantity: statement.quantity,
            evidence,
          } as KnowledgeStatement;
        },
      );
      content = parseKnowledgeContent({
        schema_version: 1,
        title: response.title,
        statements,
      });
    } catch (error) {
      if (error instanceof KnowledgeAnalysisFailure) throw error;
      throw new KnowledgeAnalysisFailure("knowledge-response", {
        cause: error,
      });
    }
    const contentBytes = knowledgeContentBytes(content);
    const contentHash = await sha256(contentBytes);
    const artifact = await parseKnowledgeArtifact({
      schema_version: 1,
      artifact_id: uuid(comparisonHash),
      comparison_sha256: comparisonHash,
      purpose: request.purpose,
      question: request.question,
      input: request.input,
      method,
      content_ref: {
        sha256: contentHash,
        byte_size: contentBytes.length,
        media_type: "application/vnd.sciretriever.knowledge+json",
      },
      content,
      coverage: {
        status: "complete",
        input_id: item.input_id,
        document_version_id: document.document_version_id,
        total_segments: documentInput.segments.length,
        covered_segments: documentInput.segments.length,
        total_utf8_bytes: documentInput.source_bytes.length,
        covered_utf8_bytes: documentInput.source_bytes.length,
        capability_gaps: documentInput.gaps,
      },
      provenance: {
        provider: result.provenance.provider,
        model: result.provenance.model,
        generated_at: new Date().toISOString(),
        input_tokens: result.provenance.usage.input_tokens,
        output_tokens: result.provenance.usage.output_tokens,
      },
    });
    let published;
    try {
      published = await this.storage.publish(artifact, active);
    } catch (error) {
      if (active.aborted) fail("knowledge-cancelled");
      throw new KnowledgeAnalysisFailure("knowledge-publication", {
        cause: error,
      });
    }
    return this.finish(
      published.artifact,
      published.published,
      request,
      questionHash,
      active,
    );
  }
  private async finish(
    artifact: KnowledgeArtifact,
    published: boolean,
    request: KnowledgeAnalysisRequest | KnowledgeLongAnalysisRequest,
    questionHash: string,
    signal: AbortSignal,
  ): Promise<KnowledgeAnalysisReceipt> {
    let defaultUpdated = false;
    let defaultRevision: number | null = null;
    let defaultFailure: KnowledgeAnalysisReceipt["default_update_failure"] =
      null;
    let outcome: KnowledgeAnalysisReceipt["default_update_outcome"] =
      request.default_update === null ? "not-requested" : "cancelled";
    if (request.default_update !== null && !signal.aborted) {
      try {
        // A dispatched SQLite write is settled from its actual result, even if
        // cancellation arrives while the worker is committing it.
        const result = await this.storage.updateDefault(
          {
            literature_id: request.input.items[0]!.literature_id,
            purpose: request.purpose,
            question_sha256: questionHash,
            artifact_id: artifact.artifact_id,
            expected_revision: request.default_update.expected_revision,
          },
          signal,
        );
        defaultUpdated = result.updated;
        defaultRevision = result.revision;
        outcome = result.updated ? "updated" : "conflict";
      } catch (error) {
        if (
          error instanceof WriteAdmissionError &&
          error.code === "write-admission-cancelled"
        ) {
          outcome = "cancelled";
        } else {
          outcome = "failed";
          defaultFailure =
            error instanceof WriteAdmissionError &&
            (error.code === "write-admission-conflict" ||
              error.code === "write-admission-closed")
              ? error.code
              : "storage-failed";
        }
      }
    }
    return parseKnowledgeAnalysisReceipt({
      schema_version: 1,
      artifact,
      published,
      default_updated: defaultUpdated,
      default_revision: defaultRevision,
      default_update_outcome: outcome,
      default_update_failure: defaultFailure,
    });
  }
  private async executeLong(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeAnalysisReceipt> {
    let request: KnowledgeLongAnalysisRequest;
    try {
      request = await parseKnowledgeLongAnalysisRequest(value);
    } catch (error) {
      throw new KnowledgeAnalysisFailure("knowledge-input", { cause: error });
    }
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    if (active.aborted) fail("knowledge-cancelled");
    const readiness = this.agents.readiness("analysis");
    if (!readiness.configured || readiness.missing.length)
      fail("knowledge-unconfigured");
    const binding = this.agents.effectiveIdentity("analysis");
    const bindingHash = await sha256(canonical(binding, 16384));
    const method = {
      id: LONG_METHOD_ID,
      version: LONG_METHOD_VERSION,
      parameters_sha256: await sha256(
        canonical(longMethodParameters(request.budget, bindingHash), 32768),
      ),
      model_binding_sha256: bindingHash,
    };
    const comparisonHash = await knowledgeComparisonSha256({
      manifest_sha256: request.input.manifest_sha256,
      purpose: request.purpose,
      question: request.question,
      method,
    });
    const questionHash = await knowledgeQuestionSha256(request.question);
    const existing = await this.storage.byComparison(comparisonHash, active);
    if (existing)
      return this.finish(existing, false, request, questionHash, active);
    if (active.aborted) fail("knowledge-cancelled");
    let analysis: Awaited<ReturnType<typeof analyzeLongDocument>>;
    try {
      analysis = await analyzeLongDocument(
        request,
        this.documents,
        this.agents,
        binding,
        active,
      );
    } catch (error) {
      if (error instanceof KnowledgeAnalysisFailure) throw error;
      if (active.aborted) fail("knowledge-cancelled");
      throw new KnowledgeAnalysisFailure("knowledge-input-invalidated", {
        cause: error,
      });
    }
    if (active.aborted) fail("knowledge-cancelled");
    const item = request.input.items[0]!;
    const document = item.document!;
    const contentBytes = knowledgeContentBytes(analysis.content);
    const artifact = await parseKnowledgeArtifact({
      schema_version: 1,
      artifact_id: uuid(comparisonHash),
      comparison_sha256: comparisonHash,
      purpose: request.purpose,
      question: request.question,
      input: request.input,
      method,
      content_ref: {
        sha256: await sha256(contentBytes),
        byte_size: contentBytes.length,
        media_type: "application/vnd.sciretriever.knowledge+json",
      },
      content: analysis.content,
      coverage: {
        status: "complete",
        input_id: item.input_id,
        document_version_id: document.document_version_id,
        total_segments: analysis.segment_count,
        covered_segments: analysis.segment_count,
        total_utf8_bytes: analysis.source_bytes,
        covered_utf8_bytes: analysis.source_bytes,
        capability_gaps: [
          "table-structure-unavailable",
          "figure-caption-unavailable",
          "page-location-unavailable",
          "bbox-unavailable",
        ],
      },
      provenance: {
        provider: analysis.provider,
        model: analysis.model,
        generated_at: new Date().toISOString(),
        input_tokens: analysis.input_tokens,
        output_tokens: analysis.output_tokens,
      },
    });
    let published;
    try {
      published = await this.storage.publish(artifact, active);
    } catch (error) {
      if (active.aborted) fail("knowledge-cancelled");
      throw new KnowledgeAnalysisFailure("knowledge-publication", {
        cause: error,
      });
    }
    return this.finish(
      published.artifact,
      published.published,
      request,
      questionHash,
      active,
    );
  }
}
