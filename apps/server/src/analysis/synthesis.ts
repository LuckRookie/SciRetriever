import { createHash } from "node:crypto";
import {
  createInputManifest,
  extractionCanonicalJsonBytes,
  parseKnowledgeSynthesisRequest,
  parseSynthesisArtifact,
  parseSynthesisContent,
  parseSynthesisExecutionReceipt,
  sha256,
  synthesisComparisonSha256,
  synthesisContentBytes,
  synthesisStatementSha256,
  type KnowledgeLongAnalysisRequest,
  type KnowledgeSynthesisRequest,
  type SynthesisContent,
  type SynthesisEvidence,
  type SynthesisExecutionReceipt,
  type SynthesisInputItem,
  type SynthesisStatement,
} from "@sciretriever/contracts";
import type { AgentRuntime } from "../agents/runtime.js";
import { AgentFailure, type AgentCall } from "../agents/protocol.js";
import type { DocumentReadService } from "../document/read.js";
import {
  analyzeLongDocument,
  longMethodParameters,
  type SharedLongCallBudget,
} from "./knowledge-long.js";
import { KnowledgeAnalysisFailure } from "./knowledge.js";
import {
  SynthesisPreparationError,
  SynthesisPreparationService,
} from "./synthesis-prepare.js";
import {
  SqliteSynthesisStorage,
  SynthesisReadError,
  type SynthesisReadSession,
} from "../storage/synthesis.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const METHOD_ID = "collection-knowledge-synthesis";
const METHOD_VERSION = "1";
const PROMPT =
  "Synthesize every supplied verified candidate for the question. Return 1-64 statements. Each candidate ID must occur exactly once across source_ids. Keep every source text verbatim in its resulting statement, preserve conditions, negation, quantities, units, epistemic status and limitations. independent_literature_ids are verified through the actual statement evidence chain; two versions or a summary of one Literature are one independent source. source_layers identify original documents and prior knowledge, including degraded source-only material. Mark consensus only when at least two distinct independent Literature IDs support compatible claims. Preserve existing disagreement categories and separate incompatible results in a disagreement group. Source IDs select already verified evidence; do not invent citations or infer an uncited fact. Return only JSON.";

export async function synthesisMethodParameters(
  budget: KnowledgeSynthesisRequest["budget"],
  bindingHash: string,
): Promise<object> {
  const localBudget: KnowledgeLongAnalysisRequest["budget"] = {
    max_source_bytes: budget.max_source_bytes,
    max_call_bytes: budget.max_call_bytes,
    max_total_call_bytes: budget.max_total_call_bytes,
    max_calls: budget.max_calls,
    max_output_tokens_per_call: budget.max_output_tokens_per_call,
    max_total_output_tokens: budget.max_total_output_tokens,
  };
  return {
    method_id: METHOD_ID,
    method_version: METHOD_VERSION,
    local_method_parameters_sha256: await sha256(
      canonical(longMethodParameters(localBudget, bindingHash), 32768),
    ),
    merge_prompt: PROMPT,
    merge_schema: responseSchema(),
    budget,
    model_binding_sha256: bindingHash,
  };
}

export class SynthesisExecutionFailure extends Error {
  constructor(
    readonly code:
      | "synthesis-invalid"
      | "synthesis-stale-binding"
      | "synthesis-budget-exhausted"
      | "synthesis-model-failed"
      | "synthesis-response"
      | "synthesis-not-applicable"
      | "synthesis-publication"
      | "synthesis-integrity"
      | "synthesis-cancelled"
      | "synthesis-closed"
      | "synthesis-unconfigured",
    options?: ErrorOptions & {
      readonly reason?: string;
      readonly retryable?: boolean;
    },
  ) {
    super("synthesis execution failed", options);
    this.reason = options?.reason ?? null;
    this.retryable = options?.retryable ?? false;
  }
  readonly reason: string | null;
  readonly retryable: boolean;
}
function fail(code: SynthesisExecutionFailure["code"]): never {
  throw new SynthesisExecutionFailure(code);
}
function canonical(value: unknown, limit: number): Uint8Array {
  return extractionCanonicalJsonBytes(value, limit);
}
function uuid(hash: string): string {
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
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
    fail("synthesis-response");
  return value as Record<string, unknown>;
}
function responseSchema(): Record<string, unknown> {
  const str = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      title: str,
      statements: {
        type: "array",
        description:
          "1-64 statements; every candidate ID appears exactly once across source_ids.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            statement_id: str,
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
            relation: {
              type: "string",
              enum: ["consensus", "disagreement", "single-source"],
            },
            conflict_group_id: { anyOf: [str, { type: "null" }] },
            text: str,
            conditions: { type: "array", items: str },
            quantity: {
              anyOf: [
                { type: "null" },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    value: str,
                    unit: str,
                    comparison_basis: { anyOf: [str, { type: "null" }] },
                  },
                  required: ["value", "unit", "comparison_basis"],
                },
              ],
            },
            source_ids: { type: "array", items: str },
          },
          required: [
            "statement_id",
            "category",
            "epistemic",
            "relation",
            "conflict_group_id",
            "text",
            "conditions",
            "quantity",
            "source_ids",
          ],
        },
      },
    },
    required: ["title", "statements"],
  };
}
interface Candidate {
  readonly id: string;
  readonly category: SynthesisStatement["category"];
  readonly epistemic: SynthesisStatement["epistemic"];
  readonly text: string;
  readonly conditions: readonly string[];
  readonly quantity: SynthesisStatement["quantity"];
  readonly evidence: readonly SynthesisEvidence[];
}
interface AnnotatedCandidate extends Candidate {
  readonly independent_literature_ids: readonly string[];
  readonly source_layers: readonly {
    readonly input_id: string;
    readonly kind: "document" | "knowledge";
    readonly state: "verified" | "source-only";
    readonly compression_depth: number;
  }[];
}
interface Ledger extends SharedLongCallBudget {
  source_bytes: number;
}
function selections(items: readonly SynthesisInputItem[]) {
  return items.map((item) =>
    item.kind === "knowledge"
      ? {
          kind: "knowledge" as const,
          input_id: item.input_id,
          source_artifact_id: item.source_artifact_id,
        }
      : {
          kind: "document" as const,
          input_id: item.input_id,
          literature_id: item.literature_id,
          asset_id: item.material?.asset_id ?? null,
          asset_sha256: item.material?.asset_sha256 ?? null,
          document_version_id: item.document?.document_version_id ?? null,
        },
  );
}
function coverageItems(input: readonly SynthesisInputItem[]) {
  return input.map((item) => {
    const reason =
      item.kind === "knowledge"
        ? item.state === "missing"
          ? ("knowledge-missing" as const)
          : item.state === "source-only"
            ? ("original-unavailable" as const)
            : null
        : (item.gaps[0] ?? null);
    return {
      input_id: item.input_id,
      status:
        reason === null
          ? ("included" as const)
          : reason === "original-unavailable"
            ? ("degraded" as const)
            : ("excluded" as const),
      reason,
    };
  });
}
function sameQuantity(
  left: SynthesisStatement["quantity"],
  right: unknown,
): boolean {
  if (left === null) return right === null;
  if (!right || typeof right !== "object" || Array.isArray(right)) return false;
  const value = right as Record<string, unknown>;
  return (
    Object.keys(value).sort().join("\0") ===
      ["comparison_basis", "unit", "value"].join("\0") &&
    value.value === left.value &&
    value.unit === left.unit &&
    value.comparison_basis === left.comparison_basis
  );
}

/** Execution owns one fixed collection, never publishes per-document intermediates. */
export class KnowledgeSynthesisService {
  private readonly stop = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly documents: DocumentReadService,
    private readonly agents: AgentRuntime,
    private readonly preparation: SynthesisPreparationService,
    private readonly storage: SqliteSynthesisStorage,
  ) {}
  synthesize(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<SynthesisExecutionReceipt> {
    if (this.stop.signal.aborted)
      return Promise.reject(new SynthesisExecutionFailure("synthesis-closed"));
    // The shared request parser snapshots nested caller values before its first await.
    const operation = this.execute(value, signal);
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
  ): Promise<SynthesisExecutionReceipt> {
    let request: KnowledgeSynthesisRequest;
    try {
      request = await parseKnowledgeSynthesisRequest(value);
    } catch (error) {
      throw new SynthesisExecutionFailure("synthesis-invalid", {
        cause: error,
      });
    }
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    if (active.aborted) fail("synthesis-cancelled");
    let prepared;
    try {
      prepared = await this.preparation.prepare(
        { policy: request.policy, inputs: selections(request.input.items) },
        active,
        request.budget.max_verification_bytes,
      );
    } catch (error) {
      if (active.aborted) fail("synthesis-cancelled");
      if (error instanceof SynthesisPreparationError) {
        const code =
          error.code === "synthesis-limit"
            ? "synthesis-budget-exhausted"
            : error.code;
        throw new SynthesisExecutionFailure(code, { cause: error });
      }
      throw new SynthesisExecutionFailure("synthesis-integrity", {
        cause: error,
      });
    }
    if (prepared.manifest.manifest_sha256 !== request.input.manifest_sha256)
      fail("synthesis-stale-binding");
    const coverage = coverageItems(request.input.items);
    const gaps = coverage.flatMap((item) =>
      item.reason === null
        ? []
        : [{ input_id: item.input_id, code: item.reason }],
    );
    if (!prepared.ready) {
      return parseSynthesisExecutionReceipt(
        {
          schema_version: 1,
          outcome: "blocked",
          input_manifest_sha256: request.input.manifest_sha256,
          policy: request.policy,
          question: request.question,
          gaps,
          artifact: null,
          published: false,
        },
        request,
      );
    }
    const readiness = this.agents.readiness("analysis");
    if (!readiness.configured || readiness.missing.length)
      fail("synthesis-unconfigured");
    const binding = this.agents.effectiveIdentity("analysis");
    const bindingHash = await sha256(canonical(binding, 16384));
    const schema = responseSchema();
    const method = {
      id: METHOD_ID,
      version: METHOD_VERSION,
      parameters_sha256: await sha256(
        canonical(
          await synthesisMethodParameters(request.budget, bindingHash),
          32768,
        ),
      ),
      model_binding_sha256: bindingHash,
    };
    const comparison = await synthesisComparisonSha256({
      manifest_sha256: request.input.manifest_sha256,
      question: request.question,
      policy: request.policy,
      method,
    });
    const existing = await this.storage.byComparison(comparison, active);
    if (existing)
      return parseSynthesisExecutionReceipt(
        {
          schema_version: 1,
          outcome: "published",
          input_manifest_sha256: request.input.manifest_sha256,
          policy: request.policy,
          question: request.question,
          gaps,
          artifact: existing.artifact,
          published: false,
        },
        request,
      );
    const ledger: Ledger = {
      source_bytes: 0,
      calls: 0,
      canonical_call_bytes: 0,
      reserved_output_tokens: 0,
      reported_calls: 0,
      reported_input_tokens: 0,
      reported_output_tokens: 0,
    };
    let content: SynthesisContent;
    let literatureIds: readonly string[];
    try {
      ({ content, literatureIds } = await this.storage.withReadSession(
        (session) =>
          this.generate(request, session, binding, schema, ledger, active),
        request.budget.max_verification_bytes,
        active,
      ));
    } catch (error) {
      if (error instanceof SynthesisExecutionFailure) throw error;
      if (active.aborted) fail("synthesis-cancelled");
      if (error instanceof KnowledgeAnalysisFailure) {
        const code =
          error.code === "knowledge-budget-exhausted" ||
          error.code === "knowledge-content-limit"
            ? "synthesis-budget-exhausted"
            : error.code === "knowledge-model-failed"
              ? "synthesis-model-failed"
              : error.code === "knowledge-input-invalidated"
                ? "synthesis-stale-binding"
                : "synthesis-response";
        throw new SynthesisExecutionFailure(code, {
          cause: error,
          ...(error.reason === null
            ? {}
            : { reason: error.reason, retryable: error.retryable }),
        });
      }
      if (error instanceof SynthesisReadError) {
        const code =
          error.code === "synthesis-limit"
            ? "synthesis-budget-exhausted"
            : error.code === "synthesis-invalid" ||
                error.code === "synthesis-kind-unsupported"
              ? "synthesis-stale-binding"
              : error.code;
        throw new SynthesisExecutionFailure(code, { cause: error });
      }
      throw new SynthesisExecutionFailure("synthesis-integrity", {
        cause: error,
      });
    }
    if (active.aborted) fail("synthesis-cancelled");
    const bytes = synthesisContentBytes(content);
    const artifact = await parseSynthesisArtifact({
      schema_version: 2,
      artifact_id: uuid(comparison),
      comparison_sha256: comparison,
      purpose: "synthesis",
      question: request.question,
      input: request.input,
      method,
      content_ref: {
        sha256: await sha256(bytes),
        byte_size: bytes.length,
        media_type: "application/vnd.sciretriever.knowledge+json",
      },
      content,
      coverage: {
        schema_version: 2,
        status: coverage.every((item) => item.status === "included")
          ? "complete"
          : "partial",
        policy: request.policy,
        items: coverage,
        unique_literature_count: literatureIds.length,
      },
      provenance: {
        provider: binding.provider,
        model: binding.model,
        generated_at: new Date().toISOString(),
        input_tokens: ledger.reported_input_tokens,
        output_tokens: ledger.reported_output_tokens,
      },
      compression_depth:
        1 +
        Math.max(
          0,
          ...request.input.items.map((item) =>
            item.kind === "knowledge" ? (item.compression_depth ?? 0) : 0,
          ),
        ),
    });
    let committed;
    try {
      committed = await this.storage.publish(artifact, active);
    } catch (error) {
      if (active.aborted) fail("synthesis-cancelled");
      throw new SynthesisExecutionFailure("synthesis-publication", {
        cause: error,
      });
    }
    // A committed SQL result is authoritative even if cancellation arrives now.
    return parseSynthesisExecutionReceipt(
      {
        schema_version: 1,
        outcome: "published",
        input_manifest_sha256: request.input.manifest_sha256,
        policy: request.policy,
        question: request.question,
        gaps,
        artifact: committed.artifact,
        published: committed.published,
      },
      request,
    );
  }
  private async generate(
    request: KnowledgeSynthesisRequest,
    session: SynthesisReadSession,
    binding: {
      readonly provider: string;
      readonly model: string;
      readonly max_output_tokens: number;
    },
    schema: Record<string, unknown>,
    ledger: Ledger,
    signal: AbortSignal,
  ): Promise<{ content: SynthesisContent; literatureIds: readonly string[] }> {
    const candidates: Candidate[] = [];
    const seen = new Map<
      string,
      { readonly indices: readonly number[]; readonly primaryInputId: string }
    >();
    for (const item of request.input.items) {
      if (signal.aborted) fail("synthesis-cancelled");
      if (item.kind === "knowledge") {
        if (item.state === "missing") continue;
        const key = `k:${item.source_artifact_id}`;
        const earlier = seen.get(key);
        if (earlier) {
          for (const index of earlier.indices) {
            const candidate = candidates[index]!;
            candidates[index] = {
              ...candidate,
              evidence: [
                ...candidate.evidence,
                ...candidate.evidence
                  .filter(
                    (evidence) => evidence.input_id === earlier.primaryInputId,
                  )
                  .map((evidence) => ({
                    ...evidence,
                    input_id: item.input_id,
                  })),
              ],
            };
          }
          continue;
        }
        const firstIndex = candidates.length;
        const source = await session.sourceById(item.source_artifact_id);
        if (
          !source ||
          source.state !== item.state ||
          source.artifact.content_ref.sha256 !== item.source_content_sha256 ||
          source.artifact.input.manifest_sha256 !==
            item.source_manifest_sha256 ||
          (source.artifact.schema_version === 1
            ? 1
            : source.artifact.compression_depth) !== item.compression_depth
        )
          fail("synthesis-stale-binding");
        ledger.source_bytes += source.artifact.content_ref.byte_size;
        if (ledger.source_bytes > request.budget.max_source_bytes)
          fail("synthesis-budget-exhausted");
        for (const statement of source.artifact.content.statements)
          candidates.push({
            id: `c${candidates.length + 1}`,
            category: statement.category,
            epistemic: statement.epistemic,
            text: statement.text,
            conditions: statement.conditions,
            quantity: statement.quantity,
            evidence: [
              {
                input_id: item.input_id,
                target_kind: "knowledge",
                source_artifact_id: item.source_artifact_id,
                source_content_sha256: item.source_content_sha256!,
                statement_id: statement.statement_id,
                statement_sha256: await synthesisStatementSha256(statement),
              },
            ],
          });
        seen.set(key, {
          indices: candidates
            .slice(firstIndex)
            .map((_, index) => firstIndex + index),
          primaryInputId: item.input_id,
        });
        continue;
      }
      if (!item.document || !item.material) continue;
      const key = `d:${item.literature_id}:${item.material.asset_id}:${item.material.asset_sha256}:${item.document.document_version_id}:${item.document.representation_sha256}`;
      const earlier = seen.get(key);
      if (earlier) {
        for (const index of earlier.indices) {
          const candidate = candidates[index]!;
          candidates[index] = {
            ...candidate,
            evidence: [
              ...candidate.evidence,
              ...candidate.evidence
                .filter(
                  (evidence) => evidence.input_id === earlier.primaryInputId,
                )
                .map((evidence) => ({ ...evidence, input_id: item.input_id })),
            ],
          };
        }
        continue;
      }
      const firstIndex = candidates.length;
      const verified = await session.documentById(
        item.document.document_version_id,
      );
      if (
        !verified ||
        verified.state !== "verified" ||
        verified.literature_id !== item.literature_id ||
        verified.asset_id !== item.material.asset_id ||
        verified.asset_sha256 !== item.material.asset_sha256 ||
        verified.representation_sha256 !== item.document.representation_sha256
      )
        fail("synthesis-stale-binding");
      if (ledger.source_bytes >= request.budget.max_source_bytes)
        fail("synthesis-budget-exhausted");
      const single = await createInputManifest([
        {
          input_id: item.input_id,
          literature_id: item.literature_id,
          material: item.material,
          document: item.document,
          capabilities: item.capabilities,
          gaps: item.gaps,
        },
      ]);
      const longRequest: KnowledgeLongAnalysisRequest = {
        schema_version: 2,
        input: single,
        purpose: "question",
        question: request.question,
        default_update: null,
        budget: {
          max_source_bytes:
            request.budget.max_source_bytes - ledger.source_bytes,
          max_call_bytes: request.budget.max_call_bytes,
          max_total_call_bytes: request.budget.max_total_call_bytes,
          max_calls: request.budget.max_calls,
          max_output_tokens_per_call: request.budget.max_output_tokens_per_call,
          max_total_output_tokens: request.budget.max_total_output_tokens,
        },
      };
      const analyzed = await analyzeLongDocument(
        longRequest,
        this.documents,
        this.agents,
        binding,
        signal,
        ledger,
        true,
      );
      ledger.source_bytes += analyzed.source_bytes;
      if (analyzed.content === null) {
        seen.set(key, { indices: [], primaryInputId: item.input_id });
        continue;
      }
      for (const statement of analyzed.content.statements)
        candidates.push({
          id: `c${candidates.length + 1}`,
          category: statement.category,
          epistemic: statement.epistemic,
          text: statement.text,
          conditions: statement.conditions,
          quantity: statement.quantity,
          evidence: statement.evidence.map((evidence) => {
            if (evidence.target_kind !== "document") fail("synthesis-response");
            return {
              input_id: item.input_id,
              target_kind: "document" as const,
              evidence,
            };
          }),
        });
      seen.set(key, {
        indices: candidates
          .slice(firstIndex)
          .map((_, index) => firstIndex + index),
        primaryInputId: item.input_id,
      });
    }
    if (!candidates.length) fail("synthesis-not-applicable");
    const byInput = new Map(
      request.input.items.map((item) => [item.input_id, item]),
    );
    const annotated: AnnotatedCandidate[] = [];
    for (const candidate of candidates) {
      const literatureIds = await session.independentLiteratureIdsForEvidence(
        candidate.evidence,
        request.input.items,
      );
      if (!literatureIds.length) fail("synthesis-stale-binding");
      const sourceLayers = [
        ...new Set(candidate.evidence.map((evidence) => evidence.input_id)),
      ].map((inputId) => {
        const item = byInput.get(inputId);
        if (!item) fail("synthesis-stale-binding");
        if (item.kind === "knowledge") {
          if (item.state === "missing") fail("synthesis-stale-binding");
          return {
            input_id: inputId,
            kind: "knowledge" as const,
            state: item.state,
            compression_depth: item.compression_depth!,
          };
        }
        return {
          input_id: inputId,
          kind: "document" as const,
          state: "verified" as const,
          compression_depth: 0,
        };
      });
      annotated.push({
        ...candidate,
        independent_literature_ids: literatureIds,
        source_layers: sourceLayers,
      });
    }
    const content = await this.integrate(
      request,
      annotated,
      binding,
      schema,
      ledger,
      signal,
    );
    const literatureIds = await session.independentLiteratureIds(
      content,
      request.input.items,
    );
    if (!literatureIds.length) fail("synthesis-response");
    return { content, literatureIds };
  }
  private async integrate(
    request: KnowledgeSynthesisRequest,
    candidates: readonly AnnotatedCandidate[],
    binding: {
      readonly provider: string;
      readonly model: string;
      readonly max_output_tokens: number;
    },
    schema: Record<string, unknown>,
    ledger: Ledger,
    signal: AbortSignal,
  ): Promise<SynthesisContent> {
    if (
      signal.aborted ||
      request.budget.max_output_tokens_per_call > binding.max_output_tokens ||
      ledger.calls >= request.budget.max_calls ||
      ledger.reported_output_tokens +
        ledger.reserved_output_tokens +
        request.budget.max_output_tokens_per_call >
        request.budget.max_total_output_tokens
    )
      fail(
        signal.aborted ? "synthesis-cancelled" : "synthesis-budget-exhausted",
      );
    let call: AgentCall;
    let bytes: Uint8Array;
    try {
      const user = decoder.decode(
        canonical(
          {
            question: request.question,
            candidates: candidates.map((candidate) => ({
              id: candidate.id,
              category: candidate.category,
              epistemic: candidate.epistemic,
              text: candidate.text,
              conditions: candidate.conditions,
              quantity: candidate.quantity,
              independent_literature_ids: candidate.independent_literature_ids,
              source_layers: candidate.source_layers,
            })),
          },
          request.budget.max_call_bytes,
        ),
      );
      const userBytes = encoder.encode(user);
      call = {
        role: "analysis",
        required_capabilities: ["structured_text"],
        input_sha256: createHash("sha256").update(userBytes).digest("hex"),
        messages: [
          {
            role: "system",
            parts: [{ media_type: "text/plain", text: PROMPT }],
          },
          {
            role: "user",
            parts: [{ media_type: "application/json", text: user }],
          },
        ],
        response_schema: schema,
        max_output_tokens: request.budget.max_output_tokens_per_call,
      };
      bytes = canonical(call, request.budget.max_call_bytes);
    } catch (error) {
      throw new SynthesisExecutionFailure("synthesis-budget-exhausted", {
        cause: error,
      });
    }
    if (
      ledger.canonical_call_bytes + bytes.length >
      request.budget.max_total_call_bytes
    )
      fail("synthesis-budget-exhausted");
    ledger.calls++;
    ledger.canonical_call_bytes += bytes.length;
    ledger.reserved_output_tokens += request.budget.max_output_tokens_per_call;
    let result;
    try {
      result = await this.agents.execute(call, signal);
    } catch (error) {
      if (signal.aborted) fail("synthesis-cancelled");
      throw new SynthesisExecutionFailure("synthesis-model-failed", {
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
    if (signal.aborted) fail("synthesis-cancelled");
    const usage = result.provenance.usage;
    if (
      !Number.isSafeInteger(usage.input_tokens) ||
      usage.input_tokens < 0 ||
      !Number.isSafeInteger(usage.output_tokens) ||
      usage.output_tokens < 0 ||
      result.provenance.provider !== binding.provider ||
      result.provenance.model !== binding.model
    )
      fail("synthesis-response");
    ledger.reported_calls++;
    ledger.reported_input_tokens += usage.input_tokens;
    ledger.reported_output_tokens += usage.output_tokens;
    ledger.reserved_output_tokens -= request.budget.max_output_tokens_per_call;
    if (
      usage.output_tokens > request.budget.max_output_tokens_per_call ||
      ledger.reported_output_tokens > request.budget.max_total_output_tokens
    )
      fail("synthesis-budget-exhausted");
    if (result.kind !== "structured") fail("synthesis-response");
    let response: Record<string, unknown>;
    try {
      response = exact(
        JSON.parse(
          decoder.decode(canonical(result.value, 512 * 1024)),
        ) as unknown,
        ["title", "statements"],
      );
    } catch (error) {
      throw new SynthesisExecutionFailure("synthesis-response", {
        cause: error,
      });
    }
    if (
      !Array.isArray(response.statements) ||
      response.statements.length < 1 ||
      response.statements.length > 64
    )
      fail("synthesis-response");
    const byId = new Map(
      candidates.map((candidate) => [candidate.id, candidate]),
    );
    const used = new Set<string>();
    const statements = response.statements.map((entry) => {
      const r = exact(entry, [
        "statement_id",
        "category",
        "epistemic",
        "relation",
        "conflict_group_id",
        "text",
        "conditions",
        "quantity",
        "source_ids",
      ]);
      if (
        !Array.isArray(r.source_ids) ||
        r.source_ids.length < 1 ||
        r.source_ids.length > 128
      )
        fail("synthesis-response");
      const sources: AnnotatedCandidate[] = [];
      for (const id of r.source_ids) {
        if (typeof id !== "string" || used.has(id) || !byId.has(id))
          fail("synthesis-response");
        used.add(id);
        sources.push(byId.get(id)!);
      }
      if (typeof r.text !== "string") fail("synthesis-response");
      const categories = new Set(sources.map((source) => source.category));
      if (
        categories.has("disagreement")
          ? r.category !== "disagreement"
          : categories.size === 1
            ? r.category !== sources[0]!.category &&
              r.category !== "disagreement"
            : r.category !== "disagreement"
      )
        fail("synthesis-response");
      if (
        r.relation === "consensus" &&
        new Set(sources.flatMap((source) => source.independent_literature_ids))
          .size < 2
      )
        fail("synthesis-response");
      const text = r.text;
      if (
        sources.some((source) => !text.includes(source.text)) ||
        sources.some((source) => source.epistemic !== r.epistemic) ||
        sources.some((source) => !sameQuantity(source.quantity, r.quantity)) ||
        sources.some((source) =>
          source.conditions.some(
            (condition) =>
              !Array.isArray(r.conditions) || !r.conditions.includes(condition),
          ),
        )
      )
        fail("synthesis-response");
      const evidence = [
        ...new Map(
          sources
            .flatMap((source) => source.evidence)
            .map((item) => [JSON.stringify(item), item]),
        ).values(),
      ];
      if (evidence.length > 128) fail("synthesis-budget-exhausted");
      return {
        statement_id: r.statement_id,
        category: r.category,
        epistemic: r.epistemic,
        relation: r.relation,
        conflict_group_id: r.conflict_group_id,
        text: r.text,
        conditions: r.conditions,
        quantity: r.quantity,
        evidence,
      };
    });
    if (used.size !== candidates.length) fail("synthesis-response");
    try {
      return parseSynthesisContent({
        schema_version: 2,
        title: response.title,
        statements,
      });
    } catch (error) {
      throw new SynthesisExecutionFailure("synthesis-response", {
        cause: error,
      });
    }
  }
}
