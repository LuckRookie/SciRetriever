import {
  extractionCanonicalJsonBytes,
  knowledgeComparisonSha256,
  knowledgeContentBytes,
  knowledgeQuestionSha256,
  parseKnowledgeAnalysisRequest,
  parseKnowledgeLongAnalysisRequest,
  parseKnowledgeAnalysisReceipt,
  parseKnowledgeArtifact,
  sha256,
  type KnowledgeAnalysisReceipt,
  type KnowledgeAnalysisRequest,
  type KnowledgeLongAnalysisRequest,
  type KnowledgeArtifact,
} from "@sciretriever/contracts";
import type { DshAgentRuntime } from "../agents/dsh/runtime.js";
import type { DocumentReadService } from "../document/read.js";
import type { KnowledgeStoragePort } from "./knowledge-port.js";
import { WriteAdmissionError } from "../storage/write-admission.js";
import {
  analyzeDocumentSession,
  documentAnalysisParameters,
  DOCUMENT_ANALYSIS_METHOD,
  DOCUMENT_ANALYSIS_VERSION,
} from "./knowledge-session.js";
export function knowledgeMethodDefinition(): object {
  return documentAnalysisParameters(undefined, "bound-separately");
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
export function knowledgeResponseSchema(): Record<string, unknown> {
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
    private readonly agents: DshAgentRuntime,
    private readonly storage: KnowledgeStoragePort,
  ) {}
  analyze(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeAnalysisReceipt> {
    return this.start(value, false, signal);
  }
  analyzeLong(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeAnalysisReceipt> {
    return this.start(value, true, signal);
  }
  private start(value: unknown, long: boolean, signal?: AbortSignal) {
    if (this.stop.signal.aborted)
      return Promise.reject(new KnowledgeAnalysisFailure("knowledge-closed"));
    const operation = this.execute(value, long, signal);
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
    long: boolean,
    signal?: AbortSignal,
  ): Promise<KnowledgeAnalysisReceipt> {
    let request: KnowledgeAnalysisRequest | KnowledgeLongAnalysisRequest;
    try {
      request = long
        ? await parseKnowledgeLongAnalysisRequest(value)
        : await parseKnowledgeAnalysisRequest(value);
    } catch (error) {
      throw new KnowledgeAnalysisFailure("knowledge-input", { cause: error });
    }
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    if (active.aborted) fail("knowledge-cancelled");
    const readiness = this.agents.readiness("analysis");
    if (
      !readiness.configured ||
      readiness.missing.length ||
      !this.agents.supports("analysis", "tool_decision")
    )
      fail("knowledge-unconfigured");
    const binding = this.agents.effectiveIdentity("analysis");
    const bindingHash = await sha256(
      canonical(
        {
          ...binding,
          image_input: this.agents.supports("analysis", "image_input"),
        },
        16384,
      ),
    );
    const method = {
      id: DOCUMENT_ANALYSIS_METHOD,
      version: DOCUMENT_ANALYSIS_VERSION,
      parameters_sha256: await sha256(
        canonical(documentAnalysisParameters(undefined, bindingHash), 32768),
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
    const analysis = await analyzeDocumentSession(
      request,
      this.documents,
      this.agents,
      binding,
      active,
    );
    if (active.aborted) fail("knowledge-cancelled");
    if (!analysis.content) fail("knowledge-not-applicable");
    const item = request.input.items[0]!,
      document = item.document!,
      contentBytes = knowledgeContentBytes(analysis.content);
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
        capability_gaps: analysis.gaps,
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
}
