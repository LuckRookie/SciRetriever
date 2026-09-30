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
const MAX_SEGMENTS = 8192;
const MERGE_FAN_IN = 16;
const LOCAL_PROMPT =
  "Analyze the core ranges for the requested purpose. Before/after are bounded adjacent context with segment and byte-range identity; they do not count as covered core. Return not_applicable only if the core has no relevant assertion. Return 1-8 statements when completed, each with 1-8 cited ranges and at least one core range; additional before/after citations may support conditions. Use at most 8 conditions per statement. Preserve conditions, negation, quantities with units, limitations and disagreements. For every cited range return its region, segment ID and an exact nonempty quote present in that supplied range. Do not invent evidence. Return only JSON.";
const MERGE_PROMPT =
  "Integrate every supplied candidate into 1-64 statements. Each output has 1-16 source_ids; every supplied candidate ID must appear exactly once across all source_ids, whether retained or combined. Each output must fit at most 8 inherited evidence references and 8 conditions. Preserve the complete text of each source candidate verbatim within the merged statement; identical text may be shared and short linking words may be added. Preserve conditions, quantities with units, epistemic status, limitations and disagreements; keep incompatible facts separate. Evidence is inherited from source_ids, never invented. Return only JSON.";
export const LONG_METHOD_ID = "single-document-knowledge-long";
export const LONG_METHOD_VERSION = "2";
export function longMethodParameters(
  budget: KnowledgeLongAnalysisRequest["budget"],
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
    max_segments: MAX_SEGMENTS,
    merge_fan_in: MERGE_FAN_IN,
    final_merge_fan_in: 64,
    final_statement_limit: 64,
    evidence_per_statement_limit: 8,
    merge_text_policy: "retain-each-source-text-verbatim-v1",
    context_evidence_policy: "core-required-context-optional-v1",
    budget,
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

/** Optional shared accounting for a multi-document caller; v2 single-document
 * execution continues to use its original local budget semantics. */
export interface SharedLongCallBudget {
  calls: number;
  canonical_call_bytes: number;
  reserved_output_tokens: number;
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
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  )
    fail("knowledge-response");
  return value as Record<string, unknown>;
}
function canonical(value: unknown, limit: number): Uint8Array {
  return extractionCanonicalJsonBytes(value, limit);
}
function responseQuantity(value: unknown): string {
  try {
    return decoder.decode(canonical(value, 1024));
  } catch (error) {
    throw new KnowledgeAnalysisFailure("knowledge-response", { cause: error });
  }
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
      description: "At most 8 conditions; preserve all source conditions.",
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
        "1-8 segment IDs, aligned with evidence_quotes and evidence_regions; at least one core citation.",
    };
    fields.evidence_quotes = {
      type: "array",
      items: str,
      description: "1-8 exact nonempty quotes, one per cited segment range.",
    };
    fields.evidence_regions = {
      type: "array",
      items: { type: "string", enum: ["core", "before", "after"] },
      description:
        "1-8 regions aligned with segment IDs and quotes; at least one core.",
    };
  } else
    fields.source_ids = {
      type: "array",
      items: str,
      description:
        "1-16 candidate IDs; each input candidate occurs exactly once across all output statements.",
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
            ? "1-8 statements when completed; empty only for not_applicable."
            : "1-64 statements when completed; every input candidate must be mapped.",
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
      encoder.encode(r.title).length > 512 ||
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
      if (
        bytes.length > request.budget.max_source_bytes ||
        structure.segments.length > MAX_SEGMENTS
      )
        return { budget_exhausted: true as const };
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
  if ("budget_exhausted" in source) fail("knowledge-budget-exhausted");
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
      if (
        request.budget.max_output_tokens_per_call > binding.max_output_tokens ||
        calls >= request.budget.max_calls ||
        outputTokens + request.budget.max_output_tokens_per_call >
          request.budget.max_total_output_tokens ||
        (shared !== undefined &&
          (shared.calls >= request.budget.max_calls ||
            shared.reported_output_tokens +
              shared.reserved_output_tokens +
              request.budget.max_output_tokens_per_call >
              request.budget.max_total_output_tokens))
      )
        fail("knowledge-budget-exhausted");
      let user: string;
      let call: AgentCall;
      let bytes: Uint8Array;
      try {
        user = decoder.decode(
          canonical(payload, request.budget.max_call_bytes),
        );
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
          max_output_tokens: request.budget.max_output_tokens_per_call,
        };
        bytes = canonical(call, request.budget.max_call_bytes);
      } catch (error) {
        throw new KnowledgeAnalysisFailure("knowledge-budget-exhausted", {
          cause: error,
        });
      }
      if (
        totalBytes + bytes.length > request.budget.max_total_call_bytes ||
        (shared !== undefined &&
          shared.canonical_call_bytes + bytes.length >
            request.budget.max_total_call_bytes)
      )
        fail("knowledge-budget-exhausted");
      calls++;
      totalBytes += bytes.length;
      if (shared) {
        shared.calls++;
        shared.canonical_call_bytes += bytes.length;
        shared.reserved_output_tokens +=
          request.budget.max_output_tokens_per_call;
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
        shared.reserved_output_tokens -=
          request.budget.max_output_tokens_per_call;
      }
      if (
        result.provenance.usage.output_tokens >
          request.budget.max_output_tokens_per_call ||
        outputTokens > request.budget.max_total_output_tokens ||
        (shared !== undefined &&
          shared.reported_output_tokens >
            request.budget.max_total_output_tokens)
      )
        fail("knowledge-budget-exhausted");
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
      if (
        r.outcome !== "completed" ||
        !(r.statements as unknown[]).length ||
        (r.statements as unknown[]).length > 8
      )
        fail("knowledge-response");
      title = r.title as string;
      const byRegion = { core: chunk.core, before, after } as const;
      for (const entry of r.statements as unknown[]) {
        const s = exact(entry, [
          "statement_id",
          "category",
          "epistemic",
          "text",
          "conditions",
          "quantity",
          "evidence_segment_ids",
          "evidence_quotes",
          "evidence_regions",
        ]);
        if (
          !Array.isArray(s.evidence_segment_ids) ||
          !Array.isArray(s.evidence_quotes) ||
          !Array.isArray(s.evidence_regions) ||
          s.evidence_segment_ids.length < 1 ||
          s.evidence_segment_ids.length > 8 ||
          s.evidence_quotes.length !== s.evidence_segment_ids.length ||
          s.evidence_regions.length !== s.evidence_segment_ids.length ||
          !s.evidence_regions.includes("core")
        )
          fail("knowledge-invalid-evidence");
        const evidence = new Map<string, EvidenceRef>();
        for (let index = 0; index < s.evidence_segment_ids.length; index++) {
          const id = s.evidence_segment_ids[index];
          const quote = s.evidence_quotes[index];
          const region: unknown = s.evidence_regions[index];
          if (
            typeof id !== "string" ||
            typeof quote !== "string" ||
            (region !== "core" && region !== "before" && region !== "after") ||
            !quote.trim() ||
            encoder.encode(quote).length > 2048 ||
            !byRegion[region].some(
              (part) => part.segment_id === id && part.text.includes(quote),
            )
          )
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
      if (
        r.outcome !== "completed" ||
        !(r.statements as unknown[]).length ||
        (r.statements as unknown[]).length > 64
      )
        fail("knowledge-response");
      const byId = new Map(group.map((candidate) => [candidate.id, candidate]));
      const used = new Set<string>();
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
        if (
          !Array.isArray(s.source_ids) ||
          !s.source_ids.length ||
          s.source_ids.length > MERGE_FAN_IN
        )
          fail("knowledge-response");
        const sources: Candidate[] = [];
        for (const id of s.source_ids) {
          if (typeof id !== "string" || used.has(id) || !byId.has(id))
            fail("knowledge-response");
          used.add(id);
          sources.push(byId.get(id)!);
        }
        const requiredConditions = new Set(
          sources.flatMap((source) => source.statement.conditions),
        );
        const categories = new Set(
          sources.map((source) => source.statement.category),
        );
        if (
          categories.has("disagreement")
            ? s.category !== "disagreement"
            : categories.size === 1
              ? s.category !== sources[0]!.statement.category &&
                s.category !== "disagreement"
              : s.category !== "disagreement"
        )
          fail("knowledge-response");
        const text = s.text;
        if (
          typeof text !== "string" ||
          sources.some((source) => !text.includes(source.statement.text))
        )
          fail("knowledge-response");
        const conditions = s.conditions;
        if (
          !Array.isArray(conditions) ||
          [...requiredConditions].some(
            (condition) => !conditions.includes(condition),
          )
        )
          fail("knowledge-response");
        const quantity = responseQuantity(sources[0]!.statement.quantity);
        if (
          sources.some(
            (source) =>
              source.statement.epistemic !== s.epistemic ||
              responseQuantity(source.statement.quantity) !== quantity,
          ) ||
          responseQuantity(s.quantity) !== quantity
        )
          fail("knowledge-response");
        const evidence = [
          ...new Map(
            sources
              .flatMap((source) => source.statement.evidence)
              .map((item) => [JSON.stringify(item), item]),
          ).values(),
        ];
        if (evidence.length > 8 || requiredConditions.size > 8)
          fail("knowledge-content-limit");
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
      if (used.size !== group.length) fail("knowledge-response");
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
      if (next.length >= current.length) fail("knowledge-content-limit");
      current = next;
    }
    if (allChunks.length > 1 || current.length !== candidates.length) {
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
