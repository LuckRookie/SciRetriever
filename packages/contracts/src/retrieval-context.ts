import {
  isTranslationLanguage,
  type TranslationLanguage,
} from "./translation.js";
import { parseTextLevel, type TextLevel } from "./draft-document.js";
import {
  ContractValidationError,
  parseEvidenceRef,
  parseLiteratureId,
  type EvidenceRef,
} from "./index.js";

const utf8 = new TextEncoder();
const hashPattern = /^[0-9a-f]{64}$/;
export const RELEVANCE_RESULT_LIMIT = 1000;
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
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    fail();
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    fail();
  return value as number;
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !hashPattern.test(value)) fail();
  return value;
}
function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)
  )
    fail();
  return value;
}
function continuation(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    fail();
  return value;
}
export type MaterialContextScope =
  | { readonly kind: "library" }
  | {
      readonly kind: "literatures";
      readonly literature_ids: readonly string[];
    };
export interface RetrievalGenerationReceipt {
  readonly generation_id: string;
  readonly source_revision: number;
  readonly entry_count: number;
  readonly source_count: number;
}
export function parseRetrievalGenerationReceipt(
  value: unknown,
): RetrievalGenerationReceipt {
  const r = exact(value, [
    "generation_id",
    "source_revision",
    "entry_count",
    "source_count",
  ]);
  return Object.freeze({
    generation_id: uuid(r.generation_id),
    source_revision: integer(r.source_revision, 0, Number.MAX_SAFE_INTEGER),
    entry_count: integer(r.entry_count, 0, Number.MAX_SAFE_INTEGER),
    source_count: integer(r.source_count, 0, Number.MAX_SAFE_INTEGER),
  });
}
export type MaterialContextVersions =
  | { readonly kind: "default" }
  | {
      readonly kind: "explicit";
      readonly documents: readonly {
        readonly literature_id: string;
        readonly document_version_id: string;
        readonly representation_sha256: string;
      }[];
    };
export interface MaterialContextRequest {
  readonly query: string;
  readonly scope: MaterialContextScope;
  readonly kinds: readonly ("metadata" | "document")[];
  readonly versions: MaterialContextVersions;
  readonly budget: {
    readonly max_items: number;
    /** UTF-8 bytes of the final ContextBundle JSON, excluding any HTTP envelope. */
    readonly max_bytes: number;
    readonly token_limit: {
      readonly tokenizer: string;
      readonly max_tokens: number;
    } | null;
  };
  readonly continuation: string | null;
}
export function parseMaterialContextRequest(
  value: unknown,
): MaterialContextRequest {
  const r = exact(value, [
    "query",
    "scope",
    "kinds",
    "versions",
    "budget",
    "continuation",
  ]);
  if (typeof r.query !== "string") fail();
  const query = r.query.trim();
  if (!query || utf8.encode(query).length > 512) fail();
  const rawScope = r.scope as Record<string, unknown> | null;
  let scope: MaterialContextScope;
  if (rawScope?.kind === "library") {
    exact(r.scope, ["kind"]);
    scope = Object.freeze({ kind: "library" });
  } else if (rawScope?.kind === "literatures") {
    const s = exact(r.scope, ["kind", "literature_ids"]);
    if (
      !Array.isArray(s.literature_ids) ||
      s.literature_ids.length < 1 ||
      s.literature_ids.length > 1000
    )
      fail();
    const ids = s.literature_ids.map((id) => String(parseLiteratureId(id)));
    if (new Set(ids).size !== ids.length) fail();
    scope = Object.freeze({
      kind: "literatures",
      literature_ids: Object.freeze(ids),
    });
  } else return fail();
  if (
    !Array.isArray(r.kinds) ||
    r.kinds.length < 1 ||
    r.kinds.length > 2 ||
    r.kinds.some((kind) => kind !== "metadata" && kind !== "document") ||
    new Set(r.kinds).size !== r.kinds.length
  )
    fail();
  const kinds = Object.freeze([...r.kinds]) as readonly (
    | "metadata"
    | "document"
  )[];
  const rawVersions = r.versions as Record<string, unknown> | null;
  let versions: MaterialContextVersions;
  if (rawVersions?.kind === "default") {
    exact(r.versions, ["kind"]);
    versions = Object.freeze({ kind: "default" });
  } else if (rawVersions?.kind === "explicit") {
    const v = exact(r.versions, ["kind", "documents"]);
    if (
      !Array.isArray(v.documents) ||
      v.documents.length < 1 ||
      v.documents.length > 1000
    )
      fail();
    const documents = v.documents.map((item) => {
      const d = exact(item, [
        "literature_id",
        "document_version_id",
        "representation_sha256",
      ]);
      return Object.freeze({
        literature_id: String(parseLiteratureId(d.literature_id)),
        document_version_id: uuid(d.document_version_id),
        representation_sha256: sha(d.representation_sha256),
      });
    });
    if (
      new Set(documents.map((d) => d.document_version_id)).size !==
        documents.length ||
      (scope.kind === "literatures" &&
        documents.some((d) => !scope.literature_ids.includes(d.literature_id)))
    )
      fail();
    versions = Object.freeze({
      kind: "explicit",
      documents: Object.freeze(documents),
    });
  } else return fail();
  const b = exact(r.budget, ["max_items", "max_bytes", "token_limit"]);
  const max_items = integer(b.max_items, 1, 20);
  const max_bytes = integer(b.max_bytes, 1024, 262144);
  let token_limit: MaterialContextRequest["budget"]["token_limit"] = null;
  if (b.token_limit !== null) {
    const t = exact(b.token_limit, ["tokenizer", "max_tokens"]);
    if (
      typeof t.tokenizer !== "string" ||
      !/^[a-z][a-z0-9._-]{0,63}$/.test(t.tokenizer)
    )
      fail();
    token_limit = Object.freeze({
      tokenizer: t.tokenizer,
      max_tokens: integer(t.max_tokens, 1, 1000000),
    });
  }
  return Object.freeze({
    query,
    scope,
    kinds,
    versions,
    budget: Object.freeze({ max_items, max_bytes, token_limit }),
    continuation: continuation(r.continuation),
  });
}

export type MaterialContextReference =
  | {
      readonly kind: "metadata";
      readonly literature_id: string;
      readonly metadata_revision: number;
      readonly metadata_sha256: string;
    }
  | {
      readonly kind: "document";
      readonly literature_id: string;
      readonly document_version_id: string;
      readonly representation_sha256: string;
      readonly asset_id: string;
      readonly asset_sha256: string;
      readonly start_utf8: number;
      readonly end_utf8: number;
    };
export interface MaterialContextItem {
  readonly text_level?: TextLevel;
  readonly kind: "metadata" | "source-text";
  readonly literature_id: string;
  readonly meta_literature_id: string;
  readonly reference: MaterialContextReference;
  readonly section_title: string | null;
  readonly text: string;
  readonly evidence: readonly EvidenceRef[];
  readonly rank: number;
  /** Weighted lexical term frequency v1; lower ranks first, not confidence. */
  readonly score: number;
  readonly gap: "context-too-large" | "evidence-limit" | null;
  /**
   * Present when the stored translation of the unit matched, not its original
   * (document spec 9.7): `text` is the translation, while `reference` and
   * `evidence` stay the original unit's range and segments.
   */
  readonly matched?: "translation";
  readonly language?: TranslationLanguage;
}
export interface MaterialContextBundle {
  readonly maintenance_hint?: "rebuild-index";
  /** Present when relevance ranking limits the results available to paginate. */
  readonly relevance_limit?: typeof RELEVANCE_RESULT_LIMIT;
  readonly score_rule: "weighted-term-frequency-v1";
  readonly items: readonly MaterialContextItem[];
  readonly coverage:
    | "complete"
    | "partial"
    | "index-unavailable"
    | "index-corrupt"
    | "index-stale";
  readonly generation_id: string | null;
  readonly source_revision: number | null;
  /** Active index watermark; source_revision is the current source counter. */
  readonly indexed_revision?: number | null;
  readonly gaps: readonly {
    readonly code:
      | "material-missing"
      | "representation-missing"
      | "context-too-large"
      | "evidence-limit"
      | "candidate-limit"
      | "index-stale";
    readonly literature_id: string | null;
  }[];
  readonly usage: {
    readonly bytes: number;
    readonly items: number;
    readonly tokens: number | null;
    readonly tokenizer: string | null;
  };
  readonly truncated: boolean;
  readonly continuation: string | null;
}
export function parseMaterialContextBundle(
  value: unknown,
  request: MaterialContextRequest,
): MaterialContextBundle {
  const r = exact(value, [
    "score_rule",
    "items",
    "coverage",
    "generation_id",
    "source_revision",
    "gaps",
    "usage",
    "truncated",
    "continuation",
    ...(value &&
    typeof value === "object" &&
    Object.hasOwn(value, "indexed_revision")
      ? ["indexed_revision"]
      : []),
    ...(value &&
    typeof value === "object" &&
    Object.hasOwn(value, "maintenance_hint")
      ? ["maintenance_hint"]
      : []),
    ...(value &&
    typeof value === "object" &&
    Object.hasOwn(value, "relevance_limit")
      ? ["relevance_limit"]
      : []),
  ]);
  if (
    r.score_rule !== "weighted-term-frequency-v1" ||
    !Array.isArray(r.items) ||
    r.items.length > request.budget.max_items ||
    ![
      "complete",
      "partial",
      "index-unavailable",
      "index-corrupt",
      "index-stale",
    ].includes(String(r.coverage)) ||
    !Array.isArray(r.gaps) ||
    r.gaps.length > 32 ||
    typeof r.truncated !== "boolean"
  )
    fail();
  const generation_id = r.generation_id === null ? null : uuid(r.generation_id);
  if (
    Object.hasOwn(r, "maintenance_hint") &&
    (r.coverage !== "index-corrupt" || r.maintenance_hint !== "rebuild-index")
  )
    fail();
  const source_revision =
    r.source_revision === null
      ? null
      : integer(r.source_revision, 0, Number.MAX_SAFE_INTEGER);
  const indexed = Object.hasOwn(r, "indexed_revision")
    ? {
        indexed_revision:
          r.indexed_revision === null
            ? null
            : integer(r.indexed_revision, 0, Number.MAX_SAFE_INTEGER),
      }
    : {};
  const items = r.items.map((raw) => {
    const item = exact(raw, [
      "kind",
      ...(raw && typeof raw === "object" && Object.hasOwn(raw, "text_level")
        ? ["text_level"]
        : []),
      "literature_id",
      "meta_literature_id",
      "reference",
      "section_title",
      "text",
      "evidence",
      "rank",
      "score",
      "gap",
      ...(raw && typeof raw === "object" && Object.hasOwn(raw, "matched")
        ? ["matched", "language"]
        : []),
    ]);
    if (item.kind !== "metadata" && item.kind !== "source-text") fail();
    const translated = Object.hasOwn(item, "matched");
    if (
      translated &&
      (item.kind !== "source-text" ||
        item.matched !== "translation" ||
        !isTranslationLanguage(item.language))
    )
      fail();
    if (item.kind === "metadata" && Object.hasOwn(item, "text_level")) fail();
    const literature_id = String(parseLiteratureId(item.literature_id));
    const meta_literature_id = String(
      parseLiteratureId(item.meta_literature_id),
    );
    const ref = item.reference as Record<string, unknown> | null;
    let reference: MaterialContextReference;
    if (item.kind === "metadata" && ref?.kind === "metadata") {
      const m = exact(item.reference, [
        "kind",
        "literature_id",
        "metadata_revision",
        "metadata_sha256",
      ]);
      reference = {
        kind: "metadata",
        literature_id: String(parseLiteratureId(m.literature_id)),
        metadata_revision: integer(
          m.metadata_revision,
          1,
          Number.MAX_SAFE_INTEGER,
        ),
        metadata_sha256: sha(m.metadata_sha256),
      };
    } else if (item.kind === "source-text" && ref?.kind === "document") {
      const d = exact(item.reference, [
        "kind",
        "literature_id",
        "document_version_id",
        "representation_sha256",
        "asset_id",
        "asset_sha256",
        "start_utf8",
        "end_utf8",
      ]);
      const start_utf8 = integer(d.start_utf8, 0, Number.MAX_SAFE_INTEGER);
      const end_utf8 = integer(d.end_utf8, 1, Number.MAX_SAFE_INTEGER);
      if (end_utf8 <= start_utf8) fail();
      reference = {
        kind: "document",
        literature_id: String(parseLiteratureId(d.literature_id)),
        document_version_id: uuid(d.document_version_id),
        representation_sha256: sha(d.representation_sha256),
        asset_id: uuid(d.asset_id),
        asset_sha256: sha(d.asset_sha256),
        start_utf8,
        end_utf8,
      };
    } else return fail();
    if (
      reference.literature_id !== literature_id ||
      (item.section_title !== null && typeof item.section_title !== "string") ||
      typeof item.text !== "string" ||
      !Array.isArray(item.evidence) ||
      item.evidence.length > 32 ||
      !Number.isFinite(item.score) ||
      (item.gap !== null &&
        item.gap !== "context-too-large" &&
        item.gap !== "evidence-limit")
    )
      fail();
    const evidence = item.evidence.map(parseEvidenceRef);
    if (item.kind === "metadata" && evidence.length) fail();
    if (item.kind === "metadata" && item.gap === "evidence-limit") fail();
    if (item.kind === "source-text" && item.gap === null && !evidence.length)
      fail();
    if (
      request.scope.kind === "literatures" &&
      !request.scope.literature_ids.includes(literature_id)
    )
      fail();
    if (
      !request.kinds.includes(
        item.kind === "metadata" ? "metadata" : "document",
      )
    )
      fail();
    if (reference.kind === "document") {
      // A translation is shown in place of the original unit's bytes.
      if (
        item.gap === null &&
        !translated &&
        utf8.encode(item.text).length !==
          reference.end_utf8 - reference.start_utf8
      )
        fail();
      if (item.gap !== null && (item.text !== "" || evidence.length)) fail();
      if (
        request.versions.kind === "explicit" &&
        !request.versions.documents.some(
          (document) =>
            document.literature_id === literature_id &&
            document.document_version_id === reference.document_version_id &&
            document.representation_sha256 === reference.representation_sha256,
        )
      )
        fail();
      if (
        evidence.some(
          (entry) =>
            entry.target_kind !== "document" ||
            entry.document_version_id !== reference.document_version_id ||
            entry.representation_sha256 !== reference.representation_sha256,
        )
      )
        fail();
    }
    return {
      ...(Object.hasOwn(item, "text_level")
        ? { text_level: parseTextLevel(item.text_level) }
        : {}),
      kind: item.kind,
      literature_id,
      meta_literature_id,
      reference,
      section_title: item.section_title,
      text: item.text,
      evidence,
      rank: integer(item.rank, 1, request.budget.max_items),
      score: item.score as number,
      gap: item.gap,
      ...(translated
        ? {
            matched: "translation" as const,
            language: item.language as TranslationLanguage,
          }
        : {}),
    } as MaterialContextItem;
  });
  if (items.some((item, index) => item.rank !== index + 1)) fail();
  const gaps = r.gaps.map((raw) => {
    const gap = exact(raw, ["code", "literature_id"]);
    if (
      ![
        "material-missing",
        "representation-missing",
        "context-too-large",
        "evidence-limit",
        "candidate-limit",
        "index-stale",
      ].includes(String(gap.code))
    )
      fail();
    return {
      code: gap.code,
      literature_id:
        gap.literature_id === null
          ? null
          : String(parseLiteratureId(gap.literature_id)),
    };
  }) as MaterialContextBundle["gaps"];
  const usage = exact(r.usage, ["bytes", "items", "tokens", "tokenizer"]);
  if (
    usage.items !== items.length ||
    usage.tokens !== null ||
    usage.tokenizer !== null
  )
    fail();
  const bytes = integer(usage.bytes, 0, request.budget.max_bytes);
  if (bytes !== utf8.encode(JSON.stringify(value)).length) fail();
  if (
    (r.coverage === "index-unavailable" || r.coverage === "index-corrupt") &&
    (items.length !== 0 ||
      gaps.length !== 0 ||
      r.truncated ||
      Object.hasOwn(r, "relevance_limit") ||
      r.continuation !== null)
  )
    fail();
  if (
    Object.hasOwn(r, "relevance_limit") &&
    r.relevance_limit !== RELEVANCE_RESULT_LIMIT
  )
    fail();
  if (r.truncated && r.continuation === null) fail();
  if (!r.truncated && r.continuation !== null) fail();
  if (r.coverage === "complete" && (gaps.length !== 0 || r.truncated)) fail();
  if (r.coverage === "partial" && gaps.length === 0 && !r.truncated) fail();
  return Object.freeze({
    score_rule: "weighted-term-frequency-v1",
    items: Object.freeze(items),
    coverage: r.coverage as MaterialContextBundle["coverage"],
    generation_id,
    source_revision,
    ...indexed,
    ...(r.relevance_limit === RELEVANCE_RESULT_LIMIT
      ? { relevance_limit: RELEVANCE_RESULT_LIMIT }
      : {}),
    gaps: Object.freeze(gaps),
    usage: { bytes, items: items.length, tokens: null, tokenizer: null },
    truncated: r.truncated as boolean,
    continuation: continuation(r.continuation),
    ...(r.maintenance_hint === "rebuild-index"
      ? { maintenance_hint: "rebuild-index" as const }
      : {}),
  });
}
