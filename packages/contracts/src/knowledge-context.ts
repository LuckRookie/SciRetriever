import {
  ContractValidationError,
  parseAssetId,
  parseEvidenceRef,
  parseLiteratureId,
  type EvidenceRef,
} from "./index.js";
import { processorExact, processorHash, processorText } from "./processors.js";
import {
  parseMaterialContextBundle,
  parseMaterialContextRequest,
  RELEVANCE_RESULT_LIMIT,
  type MaterialContextBundle,
  type MaterialContextItem,
  type MaterialContextRequest,
} from "./retrieval-context.js";

/** Current corrected source and processor-result retrieval. Legacy knowledge artifacts are not inputs. */
export interface KnowledgeContextRequest {
  readonly schema_version: 3;
  readonly query: string;
  readonly scope: MaterialContextRequest["scope"];
  readonly kinds: readonly ("metadata" | "document" | "knowledge")[];
  readonly versions: MaterialContextRequest["versions"];
  readonly budget: MaterialContextRequest["budget"];
  readonly continuation: string | null;
}
function fail(): never {
  throw new ContractValidationError();
}
export function materialContextRequest(
  request: KnowledgeContextRequest,
  continuation: string | null = null,
): MaterialContextRequest {
  const kinds = request.kinds.filter(
    (k): k is "metadata" | "document" => k !== "knowledge",
  );
  return parseMaterialContextRequest({
    query: request.query,
    scope: request.scope,
    kinds: kinds.length ? kinds : ["metadata"],
    versions: request.versions,
    budget: request.budget,
    continuation,
  });
}
export function parseKnowledgeContextRequest(
  value: unknown,
): KnowledgeContextRequest {
  const r = processorExact(value, [
    "schema_version",
    "query",
    "scope",
    "kinds",
    "versions",
    "budget",
    "continuation",
  ]);
  if (
    r.schema_version !== 3 ||
    !Array.isArray(r.kinds) ||
    !r.kinds.length ||
    r.kinds.length > 3 ||
    new Set(r.kinds).size !== r.kinds.length ||
    r.kinds.some(
      (k) => !["metadata", "document", "knowledge"].includes(String(k)),
    )
  )
    fail();
  const base = parseMaterialContextRequest({
    query: r.query,
    scope: r.scope,
    kinds: ["metadata"],
    versions: r.versions,
    budget: r.budget,
    continuation: null,
  });
  if (
    r.continuation !== null &&
    (typeof r.continuation !== "string" ||
      r.continuation.length > 4096 ||
      !/^[A-Za-z0-9_-]+$/.test(r.continuation))
  )
    fail();
  return {
    ...base,
    schema_version: 3,
    kinds: r.kinds as KnowledgeContextRequest["kinds"],
    continuation: r.continuation as string | null,
  };
}
export interface GeneratedKnowledgeContextItem {
  readonly kind: "generated-result";
  readonly reference: {
    readonly kind: "result";
    readonly result_id: string;
    readonly content_sha256: string;
    readonly record_id: string | null;
  };
  readonly processor_id: string;
  readonly source_literature_ids: readonly string[];
  readonly text: string;
  readonly evidence: readonly EvidenceRef[];
  readonly rank: number;
  readonly score: number;
  readonly gap: "context-too-large" | "evidence-limit" | null;
}
export type KnowledgeContextItem =
  | MaterialContextItem
  | GeneratedKnowledgeContextItem;
export interface KnowledgeContextBundle {
  readonly schema_version: 3;
  readonly score_rule: "sources-then-results-v1";
  readonly items: readonly KnowledgeContextItem[];
  /** Relevance window of the material branch, when that branch was capped. */
  readonly relevance_limit?: typeof RELEVANCE_RESULT_LIMIT;
  readonly coverage: MaterialContextBundle["coverage"];
  readonly gaps: readonly {
    readonly code: string;
    readonly literature_id: string | null;
  }[];
  readonly usage: MaterialContextBundle["usage"];
  readonly truncated: boolean;
  readonly continuation: string | null;
}
export function parseKnowledgeContextBundle(
  value: unknown,
  request: KnowledgeContextRequest,
): KnowledgeContextBundle {
  const r = processorExact(value, [
    "schema_version",
    "score_rule",
    "items",
    "coverage",
    "gaps",
    "usage",
    "truncated",
    "continuation",
    ...(value &&
    typeof value === "object" &&
    Object.hasOwn(value, "relevance_limit")
      ? ["relevance_limit"]
      : []),
  ]);
  if (
    r.schema_version !== 3 ||
    (Object.hasOwn(r, "relevance_limit") &&
      (r.relevance_limit !== RELEVANCE_RESULT_LIMIT ||
        request.kinds.every((kind) => kind === "knowledge"))) ||
    r.score_rule !== "sources-then-results-v1" ||
    !Array.isArray(r.items) ||
    r.items.length > request.budget.max_items ||
    ![
      "complete",
      "partial",
      "index-unavailable",
      "index-corrupt",
      "index-stale",
    ].includes(String(r.coverage)) ||
    typeof r.truncated !== "boolean" ||
    !Array.isArray(r.gaps) ||
    r.gaps.length > 32
  )
    fail();
  const items = r.items.map((raw, index): KnowledgeContextItem => {
    if (raw && typeof raw === "object" && raw.kind === "generated-result") {
      if (!request.kinds.includes("knowledge")) fail();
      const item = processorExact(raw, [
          "kind",
          "reference",
          "processor_id",
          "source_literature_ids",
          "text",
          "evidence",
          "rank",
          "score",
          "gap",
        ]),
        ref = processorExact(item.reference, [
          "kind",
          "result_id",
          "content_sha256",
          "record_id",
        ]);
      if (
        ref.kind !== "result" ||
        !Array.isArray(item.source_literature_ids) ||
        item.source_literature_ids.length > 10000 ||
        !Array.isArray(item.evidence) ||
        item.evidence.length > 32 ||
        item.rank !== index + 1 ||
        !Number.isFinite(item.score) ||
        ![null, "context-too-large", "evidence-limit"].includes(
          item.gap as null,
        )
      )
        fail();
      const ids = item.source_literature_ids.map((v) =>
        String(parseLiteratureId(v)),
      );
      if (
        new Set(ids).size !== ids.length ||
        (request.scope.kind === "literatures" &&
          !ids.some(
            (id) =>
              request.scope.kind === "literatures" &&
              request.scope.literature_ids.includes(id),
          ))
      )
        fail();
      return {
        kind: "generated-result",
        reference: {
          kind: "result",
          result_id: String(parseAssetId(ref.result_id)),
          content_sha256: processorHash(ref.content_sha256),
          record_id:
            ref.record_id === null ? null : processorText(ref.record_id, 256),
        },
        processor_id: processorText(item.processor_id, 128),
        source_literature_ids: ids,
        text: processorText(item.text, request.budget.max_bytes, true),
        evidence: item.evidence.map(parseEvidenceRef),
        rank: index + 1,
        score: Number(item.score),
        gap: item.gap as GeneratedKnowledgeContextItem["gap"],
      };
    }
    const single = {
      score_rule: "weighted-term-frequency-v1",
      items: [{ ...raw, rank: 1 }],
      coverage: "complete",
      generation_id: null,
      source_revision: null,
      gaps: [],
      usage: { items: 1, bytes: 0, tokens: null, tokenizer: null },
      truncated: false,
      continuation: null,
    };
    // The source validator checks identity, fixed hashes, evidence and requested scope.
    let bytes = 0;
    for (let i = 0; i < 10; i++) {
      single.usage.bytes = bytes;
      const next = new TextEncoder().encode(JSON.stringify(single)).length;
      if (next === bytes) break;
      bytes = next;
    }
    const parsed = parseMaterialContextBundle(single, {
      ...materialContextRequest(request),
      budget: {
        max_items: request.budget.max_items,
        max_bytes: Math.max(4096, request.budget.max_bytes),
        token_limit: null,
      },
    }).items[0]!;
    if (raw.rank !== index + 1) fail();
    return { ...parsed, rank: index + 1 };
  });
  const gaps = r.gaps.map((raw) => {
    const g = processorExact(raw, ["code", "literature_id"]);
    return {
      code: processorText(g.code, 128),
      literature_id:
        g.literature_id === null
          ? null
          : String(parseLiteratureId(g.literature_id)),
    };
  });
  const u = processorExact(r.usage, ["items", "bytes", "tokens", "tokenizer"]),
    byteLength = new TextEncoder().encode(JSON.stringify(value)).length;
  if (
    u.items !== items.length ||
    u.bytes !== byteLength ||
    byteLength > request.budget.max_bytes ||
    u.tokens !== null ||
    u.tokenizer !== null
  )
    fail();
  const continuation = parseKnowledgeContextRequest({
    ...request,
    continuation: r.continuation,
  }).continuation;
  if (
    r.truncated !== (continuation !== null) ||
    (gaps.some((g) => g.code === "material-index-stale") &&
      request.kinds.every((kind) => kind === "knowledge")) ||
    r.coverage !==
      (gaps.some((g) => g.code === "material-index-stale")
        ? "index-stale"
        : gaps.length || r.truncated
          ? "partial"
          : "complete")
  )
    fail();
  return {
    schema_version: 3,
    score_rule: "sources-then-results-v1",
    ...(r.relevance_limit === RELEVANCE_RESULT_LIMIT
      ? { relevance_limit: RELEVANCE_RESULT_LIMIT }
      : {}),
    items,
    coverage: r.coverage as KnowledgeContextBundle["coverage"],
    gaps,
    usage: {
      items: items.length,
      bytes: byteLength,
      tokens: null,
      tokenizer: null,
    },
    truncated: r.truncated,
    continuation,
  };
}
