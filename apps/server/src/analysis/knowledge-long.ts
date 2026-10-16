import { createHash } from "node:crypto";
import {
  extractionCanonicalJsonBytes,
  parseEvidenceRef,
  parseKnowledgeContent,
  sha256,
  type EvidenceRef,
  type KnowledgeContent,
  type KnowledgeLongAnalysisRequest,
  type KnowledgeStatement,
} from "@sciretriever/contracts";
import type { AgentRuntime } from "../agents/runtime.js";
import {
  AgentFailure,
  type AgentCall,
  type AgentResult,
} from "../agents/protocol.js";
import type { DocumentReadService } from "../document/read.js";
import { KnowledgeAnalysisFailure } from "./knowledge.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const CORE_BYTES = 64 * 1024;
const CONTEXT_BYTES = 4 * 1024;
const CORE_SEGMENTS = 64;
const MERGE_FAN_IN = 16;
const LOCAL_PROMPT =
  "Analyze the core text for the requested purpose, using before/after text as context. Summarize useful findings, conditions, quantities, limitations and disagreements in your own words. Cite the supplied segment IDs supporting each statement. Return not_applicable only when this part has no relevant content. Return only JSON.";
const MERGE_PROMPT =
  "Synthesize the supplied candidates into a concise account for the requested purpose. Paraphrase, combine related findings and remove repetition. Preserve important conditions, quantities, uncertainty and disagreements in meaning; verbatim copying is not required. source_ids must name supplied candidates that support each output statement. A candidate can support more than one statement. Return only JSON.";
export const LONG_METHOD_ID = "single-document-knowledge-long";
export const LONG_METHOD_VERSION = "3";
export function longMethodParameters(
  _legacyBudget: KnowledgeLongAnalysisRequest["budget"],
  bindingHash: string,
): object {
  return {
    method_id: LONG_METHOD_ID,
    method_version: LONG_METHOD_VERSION,
    local_prompt: LOCAL_PROMPT,
    merge_prompt: MERGE_PROMPT,
    local_schema: schema("evidence"),
    merge_schema: schema("sources"),
    core_bytes: CORE_BYTES,
    context_bytes: CONTEXT_BYTES,
    core_segments: CORE_SEGMENTS,
    merge_fan_in: MERGE_FAN_IN,
    final_merge_fan_in: 64,
    merge_text_policy: "model-semantic-synthesis-v2",
    context_evidence_policy: "supplied-segment-identity-v2",
    model_binding_sha256: bindingHash,
  };
}

interface Segment {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly hash: string;
}
interface CorePart {
  readonly segment_id: string;
  readonly start_utf8: number;
  readonly end_utf8: number;
  readonly text: string;
}
interface Chunk {
  readonly start: number;
  readonly end: number;
  readonly core: readonly CorePart[];
}
interface Candidate {
  readonly id: string;
  readonly statement: KnowledgeStatement;
}
interface LongResult {
  readonly content: KnowledgeContent;
  readonly source_bytes: number;
  readonly segment_count: number;
  readonly provider: string;
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
}
interface LongNotApplicable extends Omit<LongResult, "content"> {
  readonly content: null;
}

/** Shared usage accounting only; never a processing cutoff. */
export interface SharedLongCallBudget {
  calls: number;
  canonical_call_bytes: number;
  reported_calls: number;
  reported_input_tokens: number;
  reported_output_tokens: number;
}

function fail(code: string): never {
  throw new KnowledgeAnalysisFailure(code);
}
function exact(
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
function canonical(value: unknown, limit: number): Uint8Array {
  return extractionCanonicalJsonBytes(value, limit, {
    maxDepth: 32,
    maxNodes: 20480,
    maxArrayLength: 20480,
  });
}
function statementSchema(
  extra: "evidence" | "sources",
): Record<string, unknown> {
  const str = { type: "string" };
  const fields: Record<string, unknown> = {
    statement_id: str,
    category: {
      type: "string",
      enum: ["finding", "method", "result", "limitation", "disagreement"],
    },
    epistemic: { type: "string", enum: ["reported", "inference"] },
    text: str,
    conditions: {
      type: "array",
      items: str,
      description: "Relevant conditions and limitations.",
    },
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
  };
  if (extra === "evidence") {
    fields.evidence_segment_ids = {
      type: "array",
      items: str,
      description:
        "IDs of the supplied core or adjacent segments supporting this statement.",
    };
  } else
    fields.source_ids = {
      type: "array",
      items: str,
      description: "IDs of supplied candidates supporting this statement.",
    };
  return {
    type: "object",
    additionalProperties: false,
    properties: fields,
    required: Object.keys(fields),
  };
}
function schema(extra: "evidence" | "sources"): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      outcome: { type: "string", enum: ["completed", "not_applicable"] },
      title: { type: "string" },
      statements: {
        type: "array",
        items: statementSchema(extra),
        description:
          extra === "evidence"
            ? "Useful statements when completed; empty only for not_applicable."
            : "Synthesized statements supported by supplied candidates.",
      },
    },
    required: ["outcome", "title", "statements"],
  };
}
function safeStart(bytes: Uint8Array, at: number): number {
  while (at < bytes.length && (bytes[at]! & 0xc0) === 0x80) at++;
  return at;
}
function safeEnd(bytes: Uint8Array, at: number): number {
  while (at > 0 && at < bytes.length && (bytes[at]! & 0xc0) === 0x80) at--;
  return at;
}
function chunks(
  bytes: Uint8Array,
  segments: readonly Segment[],
): readonly Chunk[] {
  const result: Chunk[] = [];
  let current: CorePart[] = [];
  let start = 0;
  let end = 0;
  const flush = () => {
    if (current.length) result.push({ start, end, core: current });
    current = [];
  };
  for (const segment of segments) {
    let cursor = segment.start;
    while (cursor < segment.end) {
      if (current.length === CORE_SEGMENTS || end - start >= CORE_BYTES)
        flush();
      if (!current.length) start = cursor;
      const target = Math.min(
        segment.end,
        cursor + CORE_BYTES - (cursor - start),
      );
      const cut = target === segment.end ? target : safeEnd(bytes, target);
      if (cut <= cursor) {
        if (!current.length) fail("knowledge-input-invalidated");
        flush();
        continue;
      }
      current.push({
        segment_id: segment.id,
        start_utf8: cursor,
        end_utf8: cut,
        text: decoder.decode(bytes.subarray(cursor, cut)),
      });
      end = cut;
      cursor = cut;
    }
  }
  flush();
  let cursor = 0;
  for (const chunk of result) {
    if (chunk.start !== cursor || chunk.end <= chunk.start)
      fail("knowledge-input-invalidated");
    cursor = chunk.end;
  }
  if (cursor !== bytes.length) fail("knowledge-input-invalidated");
  return result;
}
function adjacentParts(
  bytes: Uint8Array,
  segments: readonly Segment[],
  start: number,
  end: number,
  side: "before" | "after",
): readonly CorePart[] {
  const parts: CorePart[] = [];
  for (const segment of segments) {
    const from = Math.max(start, segment.start);
    const to = Math.min(end, segment.end);
    if (from < to)
      parts.push({
        segment_id: segment.id,
        start_utf8: from,
        end_utf8: to,
        text: decoder.decode(bytes.subarray(from, to)),
      });
  }
  return side === "before"
    ? parts.slice(-CORE_SEGMENTS)
    : parts.slice(0, CORE_SEGMENTS);
}
function response(result: AgentResult): Record<string, unknown> {
  if (result.kind !== "structured") fail("knowledge-response");
  try {
    const parsed = JSON.parse(
      decoder.decode(canonical(result.value, 512 * 1024)),
    ) as unknown;
    const r = exact(parsed, ["outcome", "title", "statements"]);
    if (
      typeof r.title !== "string" ||
      !r.title.trim() ||
      !Array.isArray(r.statements)
    )
      fail("knowledge-response");
    return r;
  } catch (error) {
    if (error instanceof KnowledgeAnalysisFailure) throw error;
    throw new KnowledgeAnalysisFailure("knowledge-response", { cause: error });
  }
}

export function analyzeLongDocument(
  request: KnowledgeLongAnalysisRequest,
  documents: DocumentReadService,
  agents: AgentRuntime,
  binding: {
    readonly provider: string;
    readonly model: string;
    readonly max_output_tokens: number;
  },
  signal: AbortSignal,
  shared?: SharedLongCallBudget,
): Promise<LongResult>;
export function analyzeLongDocument(
  request: KnowledgeLongAnalysisRequest,
  documents: DocumentReadService,
  agents: AgentRuntime,
  binding: {
    readonly provider: string;
    readonly model: string;
    readonly max_output_tokens: number;
  },
  signal: AbortSignal,
  shared: SharedLongCallBudget,
  allowNotApplicable: true,
): Promise<LongResult | LongNotApplicable>;
export async function analyzeLongDocument(
  request: KnowledgeLongAnalysisRequest,
  documents: DocumentReadService,
  agents: AgentRuntime,
  binding: {
    readonly provider: string;
    readonly model: string;
    readonly max_output_tokens: number;
  },
  signal: AbortSignal,
  shared?: SharedLongCallBudget,
  allowNotApplicable = false,
): Promise<LongResult | LongNotApplicable> {
  const item = request.input.items[0]!;
  const document = item.document!;
  const material = item.material!;
  const source = await documents.withVerifiedVersion(
    document.document_version_id,
    async (version, bytes, structure) => {
      if (
        version.representation_sha256 !== document.representation_sha256 ||
        version.source_material_ref.asset_id !== material.asset_id ||
        version.source_material_ref.asset_sha256 !== material.asset_sha256 ||
        version.source_material_ref.literature_id !== item.literature_id
      )
        fail("knowledge-input-invalidated");
      let cursor = 0;
      const segments: Segment[] = [];
      for (const segment of structure.segments) {
        if (
          segment.start_utf8 !== cursor ||
          segment.end_utf8 <= cursor ||
          segment.end_utf8 > bytes.length
        )
          fail("knowledge-input-invalidated");
        segments.push({
          id: segment.segment_id,
          start: cursor,
          end: segment.end_utf8,
          hash: await sha256(bytes.subarray(cursor, segment.end_utf8)),
        });
        cursor = segment.end_utf8;
      }
      if (cursor !== bytes.length) fail("knowledge-input-invalidated");
      return { bytes, segments };
    },
    signal,
  );
  let calls = 0;
  let totalBytes = 0;
  let reportedCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let nextId = 1;
  try {
    const allChunks = chunks(source.bytes, source.segments);
    const bySegment = new Map(
      source.segments.map((segment) => [segment.id, segment]),
    );
    const invoke = async (
      prompt: string,
      payload: unknown,
      responseSchema: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      if (signal.aborted) fail("knowledge-cancelled");
      let user: string;
      let call: AgentCall;
      let bytes: Uint8Array;
      try {
        user = decoder.decode(canonical(payload, 1024 * 1024));
        const userBytes = encoder.encode(user);
        call = {
          role: "analysis",
          required_capabilities: ["structured_text"],
          input_sha256: createHash("sha256").update(userBytes).digest("hex"),
          messages: [
            {
              role: "system",
              parts: [{ media_type: "text/plain", text: prompt }],
            },
            {
              role: "user",
              parts: [{ media_type: "application/json", text: user }],
            },
          ],
          response_schema: responseSchema,
        };
        bytes = canonical(call, 2 * 1024 * 1024);
      } catch (error) {
        throw new KnowledgeAnalysisFailure("knowledge-request-limit", {
          cause: error,
        });
      }
      calls++;
      totalBytes += bytes.length;
      if (shared) {
        shared.calls++;
        shared.canonical_call_bytes += bytes.length;
      }
      let result: AgentResult;
      try {
        result = await agents.execute(call, signal);
      } catch (error) {
        if (signal.aborted) fail("knowledge-cancelled");
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
      if (signal.aborted) fail("knowledge-cancelled");
      if (
        !Number.isSafeInteger(result.provenance.usage.input_tokens) ||
        !Number.isSafeInteger(result.provenance.usage.output_tokens) ||
        result.provenance.usage.input_tokens < 0 ||
        result.provenance.usage.output_tokens < 0
      )
        fail("knowledge-response");
      reportedCalls++;
      inputTokens += result.provenance.usage.input_tokens;
      outputTokens += result.provenance.usage.output_tokens;
      if (shared) {
        shared.reported_calls++;
        shared.reported_input_tokens += result.provenance.usage.input_tokens;
        shared.reported_output_tokens += result.provenance.usage.output_tokens;
      }
      if (
        result.provenance.provider !== binding.provider ||
        result.provenance.model !== binding.model
      )
        fail("knowledge-response");
      return response(result);
    };
    const candidates: Candidate[] = [];
    let title = "";
    for (const chunk of allChunks) {
      const beforeStart = safeStart(
        source.bytes,
        Math.max(0, chunk.start - CONTEXT_BYTES),
      );
      const afterEnd = safeEnd(
        source.bytes,
        Math.min(source.bytes.length, chunk.end + CONTEXT_BYTES),
      );
      const before = adjacentParts(
        source.bytes,
        source.segments,
        beforeStart,
        chunk.start,
        "before",
      );
      const after = adjacentParts(
        source.bytes,
        source.segments,
        chunk.end,
        afterEnd,
        "after",
      );
      const r = await invoke(
        LOCAL_PROMPT,
        {
          purpose: request.purpose,
          question: request.question,
          document_version_id: document.document_version_id,
          core_start_utf8: chunk.start,
          core_end_utf8: chunk.end,
          before,
          core: chunk.core,
          after,
        },
        schema("evidence"),
      );
      if (r.outcome === "not_applicable") {
        if ((r.statements as unknown[]).length) fail("knowledge-response");
        continue;
      }
      if (r.outcome !== "completed" || !(r.statements as unknown[]).length)
        fail("knowledge-response");
      title = r.title as string;
      const availableSegments = new Set(
        [...chunk.core, ...before, ...after].map((part) => part.segment_id),
      );
      for (const entry of r.statements as unknown[]) {
        const s = exact(entry, [
          "statement_id",
          "category",
          "epistemic",
          "text",
          "conditions",
          "quantity",
          "evidence_segment_ids",
        ]);
        if (
          !Array.isArray(s.evidence_segment_ids) ||
          !s.evidence_segment_ids.length
        )
          fail("knowledge-invalid-evidence");
        const evidence = new Map<string, EvidenceRef>();
        for (const id of s.evidence_segment_ids) {
          if (typeof id !== "string" || !availableSegments.has(id))
            fail("knowledge-invalid-evidence");
          const segment = bySegment.get(id)!;
          evidence.set(
            id,
            parseEvidenceRef({
              schema_version: 1,
              target_kind: "document",
              locator_scheme: "utf8-segment-v1",
              document_version_id: document.document_version_id,
              representation_sha256: document.representation_sha256,
              locator: { kind: "segment", segment_id: id },
              content_sha256: segment.hash,
            }),
          );
        }
        try {
          const id = `c${nextId++}`;
          const parsed = parseKnowledgeContent({
            schema_version: 1,
            title: r.title,
            statements: [
              {
                statement_id: id,
                category: s.category,
                epistemic: s.epistemic,
                text: s.text,
                conditions: s.conditions,
                quantity: s.quantity,
                evidence: [...evidence.values()],
              },
            ],
          });
          candidates.push({ id, statement: parsed.statements[0]! });
        } catch (error) {
          throw new KnowledgeAnalysisFailure("knowledge-response", {
            cause: error,
          });
        }
      }
    }
    if (!candidates.length) {
      if (!allowNotApplicable) fail("knowledge-not-applicable");
      return {
        content: null,
        source_bytes: source.bytes.length,
        segment_count: source.segments.length,
        provider: binding.provider,
        model: binding.model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      };
    }
    let current = candidates;
    const merge = async (
      group: readonly Candidate[],
    ): Promise<{ title: string; candidates: Candidate[] }> => {
      const r = await invoke(
        MERGE_PROMPT,
        {
          purpose: request.purpose,
          question: request.question,
          candidates: group.map((candidate) => ({
            id: candidate.id,
            category: candidate.statement.category,
            epistemic: candidate.statement.epistemic,
            text: candidate.statement.text,
            conditions: candidate.statement.conditions,
            quantity: candidate.statement.quantity,
            evidence_segment_ids: candidate.statement.evidence.map((e) =>
              e.target_kind === "document" ? e.locator.segment_id : "",
            ),
          })),
        },
        schema("sources"),
      );
      if (r.outcome !== "completed" || !(r.statements as unknown[]).length)
        fail("knowledge-response");
      const byId = new Map(group.map((candidate) => [candidate.id, candidate]));
      const merged: Candidate[] = [];
      for (const entry of r.statements as unknown[]) {
        const s = exact(entry, [
          "statement_id",
          "category",
          "epistemic",
          "text",
          "conditions",
          "quantity",
          "source_ids",
        ]);
        if (!Array.isArray(s.source_ids) || !s.source_ids.length)
          fail("knowledge-response");
        const sources: Candidate[] = [];
        for (const id of s.source_ids) {
          if (typeof id !== "string" || !byId.has(id))
            fail("knowledge-response");
          sources.push(byId.get(id)!);
        }
        const evidence = [
          ...new Map(
            sources
              .flatMap((source) => source.statement.evidence)
              .map((item) => [JSON.stringify(item), item]),
          ).values(),
        ];
        try {
          const id = `c${nextId++}`;
          const parsed = parseKnowledgeContent({
            schema_version: 1,
            title: r.title,
            statements: [
              {
                statement_id: id,
                category: s.category,
                epistemic: s.epistemic,
                text: s.text,
                conditions: s.conditions,
                quantity: s.quantity,
                evidence,
              },
            ],
          });
          merged.push({ id, statement: parsed.statements[0]! });
        } catch (error) {
          throw new KnowledgeAnalysisFailure("knowledge-response", {
            cause: error,
          });
        }
      }
      return { title: r.title as string, candidates: merged };
    };
    while (current.length > 64) {
      const next: Candidate[] = [];
      for (let offset = 0; offset < current.length; offset += MERGE_FAN_IN) {
        const result = await merge(
          current.slice(offset, offset + MERGE_FAN_IN),
        );
        title = result.title;
        next.push(...result.candidates);
      }
      // A non-shrinking summary is still usable; never repeat the same reduction indefinitely.
      const reduced = next.length < current.length;
      current = next;
      if (!reduced) break;
    }
    if (
      current.length <= 64 &&
      (allChunks.length > 1 || current.length !== candidates.length)
    ) {
      const result = await merge(current);
      title = result.title;
      current = result.candidates;
    }
    let content: KnowledgeContent;
    try {
      content = parseKnowledgeContent({
        schema_version: 1,
        title,
        statements: current.map((candidate) => candidate.statement),
      });
    } catch (error) {
      throw new KnowledgeAnalysisFailure("knowledge-content-limit", {
        cause: error,
      });
    }
    return {
      content,
      source_bytes: source.bytes.length,
      segment_count: source.segments.length,
      provider: binding.provider,
      model: binding.model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    };
  } catch (error) {
    if (error instanceof KnowledgeAnalysisFailure)
      throw new KnowledgeAnalysisFailure(error.code, {
        cause: error,
        ...(error.reason === null ? {} : { reason: error.reason }),
        retryable: error.retryable,
        accounting: {
          calls_dispatched: calls,
          canonical_call_bytes: totalBytes,
          reported_calls: reportedCalls,
          reported_input_tokens: inputTokens,
          reported_output_tokens: outputTokens,
          usage_complete: reportedCalls === calls,
        },
      });
    throw error;
  }
}
