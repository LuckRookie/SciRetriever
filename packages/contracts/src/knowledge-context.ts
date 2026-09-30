import {
  ContractValidationError,
  parseAssetId,
  parseEvidenceRef,
  parseLiteratureId,
} from "./index.js";
import {
  parseMaterialContextRequest,
  type MaterialContextItem,
  type MaterialContextRequest,
  type MaterialContextVersions,
} from "./retrieval-context.js";
import {
  knowledgeStatementSha256,
  normalizeKnowledgeQuestion,
  parseKnowledgeContent,
  type KnowledgePurpose,
  type KnowledgeStatement,
} from "./knowledge.js";
import {
  parseSynthesisStatement,
  synthesisStatementSha256,
  type SynthesisStatement,
} from "./synthesis.js";

const encoder = new TextEncoder();
const HASH = /^[a-f0-9]{64}$/;
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
function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) fail();
  return value;
}
function id(value: unknown): string {
  return String(parseAssetId(value));
}
function integer(value: unknown, min: number, max: number): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    fail();
  return Number(value);
}
function ids(value: unknown, max = 1000): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) fail();
  const result = value.map(id);
  if (new Set(result).size !== result.length) fail();
  return Object.freeze(result);
}
function literatureIds(value: unknown, max = 1024): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) fail();
  const result = value.map((value) => String(parseLiteratureId(value)));
  if (
    new Set(result).size !== result.length ||
    result.some((entry, index) => index > 0 && result[index - 1]! >= entry)
  )
    fail();
  return Object.freeze(result);
}
function cursor(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2048 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    fail();
  return value;
}
export type KnowledgeContextScope =
  | MaterialContextRequest["scope"]
  | { readonly kind: "artifacts"; readonly artifact_ids: readonly string[] };
export interface KnowledgeContextRequest {
  readonly schema_version: 2;
  readonly query: string;
  readonly scope: KnowledgeContextScope;
  readonly kinds: readonly ("metadata" | "document" | "knowledge")[];
  readonly versions: MaterialContextVersions;
  readonly knowledge: null | {
    readonly purposes: readonly KnowledgePurpose[];
    readonly question: string | null;
    readonly selection: "all" | "defaults" | "explicit";
    readonly artifact_ids: readonly string[];
  };
  readonly budget: MaterialContextRequest["budget"];
  readonly continuation: string | null;
}
export function parseKnowledgeContextRequest(
  value: unknown,
): KnowledgeContextRequest {
  const r = exact(value, [
    "schema_version",
    "query",
    "scope",
    "kinds",
    "versions",
    "knowledge",
    "budget",
    "continuation",
  ]);
  if (
    r.schema_version !== 2 ||
    !Array.isArray(r.kinds) ||
    r.kinds.length < 1 ||
    r.kinds.length > 3 ||
    r.kinds.some(
      (kind) => !["metadata", "document", "knowledge"].includes(String(kind)),
    ) ||
    new Set(r.kinds).size !== r.kinds.length
  )
    fail();
  const kinds = Object.freeze([...r.kinds]) as KnowledgeContextRequest["kinds"];
  const rawScope = r.scope as Record<string, unknown> | null;
  const artifactScope = rawScope?.kind === "artifacts";
  let scope: KnowledgeContextScope;
  if (artifactScope) {
    const s = exact(r.scope, ["kind", "artifact_ids"]);
    scope = Object.freeze({
      kind: "artifacts",
      artifact_ids: ids(s.artifact_ids),
    });
    if (kinds.length !== 1 || kinds[0] !== "knowledge") fail();
  } else {
    scope = parseMaterialContextRequest({
      query: r.query,
      scope: r.scope,
      kinds: ["metadata"],
      versions: r.versions,
      budget: r.budget,
      continuation: null,
    }).scope;
  }
  const material = parseMaterialContextRequest({
    query: r.query,
    scope: artifactScope ? { kind: "library" } : r.scope,
    kinds: kinds.filter((kind) => kind !== "knowledge").length
      ? kinds.filter((kind) => kind !== "knowledge")
      : ["metadata"],
    versions: r.versions,
    budget: r.budget,
    continuation: null,
  });
  if (artifactScope && material.versions.kind !== "default") fail();
  let knowledge: KnowledgeContextRequest["knowledge"] = null;
  if (kinds.includes("knowledge")) {
    const k = exact(r.knowledge, [
      "purposes",
      "question",
      "selection",
      "artifact_ids",
    ]);
    if (
      !Array.isArray(k.purposes) ||
      k.purposes.length < 1 ||
      k.purposes.length > 4 ||
      k.purposes.some(
        (p) =>
          !["overview", "detailed", "question", "synthesis"].includes(
            String(p),
          ),
      ) ||
      new Set(k.purposes).size !== k.purposes.length
    )
      fail();
    const purposes = Object.freeze([
      ...k.purposes,
    ]) as readonly KnowledgePurpose[];
    let question: string | null = null;
    if (k.question !== null) {
      question = normalizeKnowledgeQuestion(k.question);
      if (purposes.some((p) => p !== "question" && p !== "synthesis")) fail();
    }
    if (
      !["all", "defaults", "explicit"].includes(String(k.selection)) ||
      !Array.isArray(k.artifact_ids)
    )
      fail();
    const selection = k.selection as "all" | "defaults" | "explicit";
    const artifact_ids =
      selection === "explicit"
        ? ids(k.artifact_ids)
        : Object.freeze([] as string[]);
    if (
      (selection !== "explicit" && k.artifact_ids.length) ||
      (selection === "defaults" && purposes.includes("synthesis"))
    )
      fail();
    if (
      scope.kind === "artifacts" &&
      (selection !== "explicit" ||
        scope.artifact_ids.length !== artifact_ids.length ||
        scope.artifact_ids.some((item, index) => item !== artifact_ids[index]))
    )
      fail();
    knowledge = Object.freeze({ purposes, question, selection, artifact_ids });
  } else if (r.knowledge !== null) fail();
  return Object.freeze({
    schema_version: 2,
    query: material.query,
    scope,
    kinds,
    versions: material.versions,
    knowledge,
    budget: material.budget,
    continuation: cursor(r.continuation),
  });
}

export interface GeneratedKnowledgeContextItem {
  readonly kind: "generated-knowledge";
  readonly reference: {
    readonly kind: "knowledge";
    readonly artifact_id: string;
    readonly content_sha256: string;
    readonly manifest_sha256: string;
    readonly statement_id: string;
    readonly statement_sha256: string;
  };
  readonly purpose: KnowledgePurpose;
  readonly question: string | null;
  readonly scope_kind: "literature" | "manifest";
  readonly source_literature_ids: readonly string[];
  readonly independent_literature_ids: readonly string[];
  readonly source_state: "verified" | "source-only";
  readonly source_layers: readonly {
    readonly input_id: string;
    readonly kind: "document" | "knowledge";
    readonly state: "verified" | "source-only" | "missing";
    readonly compression_depth: number;
    readonly source_artifact_id: string | null;
  }[];
  readonly compression_depth: number;
  readonly coverage_status: "complete" | "partial";
  readonly statement: KnowledgeStatement | SynthesisStatement | null;
  readonly rank: number;
  readonly score: number;
  readonly gap: "context-too-large" | null;
}
export type KnowledgeContextItem =
  | MaterialContextItem
  | GeneratedKnowledgeContextItem;
export type KnowledgeContextGapCode =
  | "material-missing"
  | "representation-missing"
  | "knowledge-missing"
  | "source-only"
  | "source-missing"
  | "source-corrupt"
  | "coverage-partial"
  | "context-too-large"
  | "evidence-limit"
  | "candidate-limit"
  | "material-index-unavailable"
  | "material-index-corrupt"
  | "material-index-stale"
  | "knowledge-index-unavailable"
  | "knowledge-index-corrupt"
  | "knowledge-index-stale";
export interface KnowledgeContextBundle {
  readonly schema_version: 2;
  readonly score_rule: "weighted-term-frequency-v1";
  readonly items: readonly KnowledgeContextItem[];
  readonly coverage:
    | "complete"
    | "partial"
    | "index-unavailable"
    | "index-corrupt"
    | "index-stale";
  readonly generations: {
    readonly material: {
      readonly generation_id: string;
      readonly source_revision: number;
    } | null;
    readonly knowledge: {
      readonly generation_id: string;
      readonly source_revision: number;
    } | null;
  };
  readonly gaps: readonly {
    readonly code: KnowledgeContextGapCode;
    readonly literature_id: string | null;
    readonly artifact_id: string | null;
  }[];
  readonly usage: {
    readonly bytes: number;
    readonly items: number;
    readonly tokens: null;
    readonly tokenizer: null;
  };
  readonly truncated: boolean;
  readonly continuation: string | null;
}
export async function parseKnowledgeContextBundle(
  value: unknown,
  request: KnowledgeContextRequest,
): Promise<KnowledgeContextBundle> {
  const r = exact(value, [
    "schema_version",
    "score_rule",
    "items",
    "coverage",
    "generations",
    "gaps",
    "usage",
    "truncated",
    "continuation",
  ]);
  if (
    r.schema_version !== 2 ||
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
  const gs = exact(r.generations, ["material", "knowledge"]);
  const generation = (value: unknown) => {
    if (value === null) return null;
    const v = exact(value, ["generation_id", "source_revision"]);
    return {
      generation_id: id(v.generation_id),
      source_revision: integer(v.source_revision, 0, Number.MAX_SAFE_INTEGER),
    };
  };
  const generations = {
    material: generation(gs.material),
    knowledge: generation(gs.knowledge),
  };
  const parsed: KnowledgeContextItem[] = [];
  for (const raw of r.items) {
    const item = raw as Record<string, unknown>;
    if (item?.kind === "generated-knowledge") {
      const k = exact(raw, [
        "kind",
        "reference",
        "purpose",
        "question",
        "scope_kind",
        "source_literature_ids",
        "independent_literature_ids",
        "source_state",
        "source_layers",
        "compression_depth",
        "coverage_status",
        "statement",
        "rank",
        "score",
        "gap",
      ]);
      const ref = exact(k.reference, [
        "kind",
        "artifact_id",
        "content_sha256",
        "manifest_sha256",
        "statement_id",
        "statement_sha256",
      ]);
      if (
        ref.kind !== "knowledge" ||
        typeof ref.statement_id !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(ref.statement_id) ||
        !request.kinds.includes("knowledge") ||
        !request.knowledge?.purposes.includes(k.purpose as KnowledgePurpose) ||
        !["literature", "manifest"].includes(String(k.scope_kind)) ||
        !["verified", "source-only"].includes(String(k.source_state)) ||
        !["complete", "partial"].includes(String(k.coverage_status)) ||
        (k.gap !== null && k.gap !== "context-too-large") ||
        !Number.isFinite(k.score)
      )
        fail();
      const artifact_id = id(ref.artifact_id),
        source_literature_ids = literatureIds(k.source_literature_ids),
        independent_literature_ids = literatureIds(
          k.independent_literature_ids,
        );
      const requestedScope = request.scope;
      if (
        independent_literature_ids.some(
          (lit) => !source_literature_ids.includes(lit),
        ) ||
        (requestedScope.kind === "literatures" &&
          source_literature_ids.some(
            (lit) => !requestedScope.literature_ids.includes(lit),
          )) ||
        (requestedScope.kind === "artifacts" &&
          !requestedScope.artifact_ids.includes(artifact_id)) ||
        (k.scope_kind === "literature" && source_literature_ids.length !== 1) ||
        (request.knowledge.selection === "explicit" &&
          !request.knowledge.artifact_ids.includes(artifact_id))
      )
        fail();
      const question =
        k.question === null
          ? null
          : typeof k.question === "string"
            ? normalizeKnowledgeQuestion(k.question)
            : fail();
      if (question !== k.question) fail();
      if (
        (request.knowledge.question !== null &&
          question !== request.knowledge.question) ||
        (k.purpose === "question" || k.purpose === "synthesis") !==
          (question !== null) ||
        (k.purpose === "synthesis" && k.scope_kind !== "manifest") ||
        (k.purpose !== "synthesis" && k.scope_kind !== "literature") ||
        (k.purpose !== "synthesis" && k.coverage_status !== "complete") ||
        (k.purpose !== "synthesis" && k.compression_depth !== 1)
      )
        fail();
      if (
        !Array.isArray(k.source_layers) ||
        k.source_layers.length < 1 ||
        k.source_layers.length > 128
      )
        fail();
      const source_layers = k.source_layers.map((raw) => {
        const layer = exact(raw, [
          "input_id",
          "kind",
          "state",
          "compression_depth",
          "source_artifact_id",
        ]);
        if (
          typeof layer.input_id !== "string" ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(layer.input_id) ||
          !["document", "knowledge"].includes(String(layer.kind)) ||
          !["verified", "source-only", "missing"].includes(String(layer.state))
        )
          fail();
        const depth = integer(layer.compression_depth, 0, 32);
        if (
          (layer.kind === "document" &&
            (layer.source_artifact_id !== null || depth !== 0)) ||
          (layer.kind === "knowledge" && layer.source_artifact_id === null)
        )
          fail();
        return {
          input_id: layer.input_id,
          kind: layer.kind as "document" | "knowledge",
          state: layer.state as "verified" | "source-only" | "missing",
          compression_depth: depth,
          source_artifact_id:
            layer.source_artifact_id === null
              ? null
              : id(layer.source_artifact_id),
        };
      });
      if (
        new Set(source_layers.map((layer) => layer.input_id)).size !==
        source_layers.length
      )
        fail();
      // Publication coverage is historical; these layers describe what can
      // be read now. A partial artifact can have only verified current inputs,
      // and a complete artifact can lose original material later.
      if (
        source_layers.some(
          (layer) => layer.compression_depth >= Number(k.compression_depth),
        )
      )
        fail();
      let statement: KnowledgeStatement | SynthesisStatement | null = null;
      if (k.gap === null) {
        if (k.statement === null) fail();
        statement =
          k.purpose === "synthesis"
            ? parseSynthesisStatement(k.statement)
            : parseKnowledgeContent({
                schema_version: 1,
                title: "Indexed knowledge",
                statements: [k.statement],
              }).statements[0]!;
        if (
          statement.statement_id !== ref.statement_id ||
          (await (k.purpose === "synthesis"
            ? synthesisStatementSha256(statement)
            : knowledgeStatementSha256(statement))) !== ref.statement_sha256
        )
          fail();
      } else if (k.statement !== null) fail();
      parsed.push({
        kind: "generated-knowledge",
        reference: {
          kind: "knowledge",
          artifact_id,
          content_sha256: hash(ref.content_sha256),
          manifest_sha256: hash(ref.manifest_sha256),
          statement_id: String(ref.statement_id),
          statement_sha256: hash(ref.statement_sha256),
        },
        purpose: k.purpose as KnowledgePurpose,
        question,
        scope_kind: k.scope_kind as "literature" | "manifest",
        source_literature_ids,
        independent_literature_ids,
        source_state: k.source_state as "verified" | "source-only",
        source_layers,
        compression_depth: integer(k.compression_depth, 1, 32),
        coverage_status: k.coverage_status as "complete" | "partial",
        statement,
        rank: integer(k.rank, 1, request.budget.max_items),
        score: Number(k.score),
        gap: k.gap as "context-too-large" | null,
      });
    } else {
      const m = exact(raw, [
        "kind",
        "literature_id",
        "meta_literature_id",
        "reference",
        "section_title",
        "text",
        "evidence",
        "rank",
        "score",
        "gap",
      ]);
      if (
        !["metadata", "source-text"].includes(String(m.kind)) ||
        typeof m.text !== "string" ||
        (m.section_title !== null && typeof m.section_title !== "string") ||
        !Array.isArray(m.evidence) ||
        m.evidence.length > 32 ||
        (m.gap !== null &&
          m.gap !== "context-too-large" &&
          m.gap !== "evidence-limit") ||
        !Number.isFinite(m.score)
      )
        fail();
      const literature_id = String(parseLiteratureId(m.literature_id));
      if (
        request.scope.kind === "artifacts" ||
        (request.scope.kind === "literatures" &&
          !request.scope.literature_ids.includes(literature_id)) ||
        !request.kinds.includes(m.kind === "metadata" ? "metadata" : "document")
      )
        fail();
      const ref = exact(
        m.reference,
        m.kind === "metadata"
          ? ["kind", "literature_id", "metadata_revision", "metadata_sha256"]
          : [
              "kind",
              "literature_id",
              "document_version_id",
              "representation_sha256",
              "asset_id",
              "asset_sha256",
              "start_utf8",
              "end_utf8",
            ],
      );
      if (
        ref.literature_id !== literature_id ||
        ref.kind !== (m.kind === "metadata" ? "metadata" : "document")
      )
        fail();
      if (m.kind === "metadata") {
        integer(ref.metadata_revision, 1, Number.MAX_SAFE_INTEGER);
        hash(ref.metadata_sha256);
        if (m.evidence.length || m.gap !== null) fail();
      } else {
        id(ref.document_version_id);
        hash(ref.representation_sha256);
        id(ref.asset_id);
        hash(ref.asset_sha256);
        const start = integer(ref.start_utf8, 0, Number.MAX_SAFE_INTEGER),
          end = integer(ref.end_utf8, 1, Number.MAX_SAFE_INTEGER);
        if (
          end <= start ||
          (m.gap === null &&
            encoder.encode(m.text as string).length !== end - start) ||
          (m.gap !== null && (m.text !== "" || m.evidence.length))
        )
          fail();
        if (
          request.versions.kind === "explicit" &&
          !request.versions.documents.some(
            (d) =>
              d.document_version_id === ref.document_version_id &&
              d.representation_sha256 === ref.representation_sha256 &&
              d.literature_id === literature_id,
          )
        )
          fail();
      }
      const evidence = (m.evidence as unknown[]).map(parseEvidenceRef);
      if (
        m.kind === "source-text" &&
        ((m.gap === null && evidence.length === 0) ||
          evidence.some(
            (item) =>
              item.target_kind !== "document" ||
              item.document_version_id !== ref.document_version_id ||
              item.representation_sha256 !== ref.representation_sha256 ||
              item.content_sha256 === null,
          ))
      )
        fail();
      if (
        new Set(
          evidence.map((entry) =>
            entry.target_kind === "document" ? entry.locator.segment_id : "",
          ),
        ).size !== evidence.length
      )
        fail();
      parsed.push({
        ...m,
        literature_id,
        meta_literature_id: String(parseLiteratureId(m.meta_literature_id)),
        reference: ref,
        evidence,
        rank: integer(m.rank, 1, request.budget.max_items),
        score: Number(m.score),
      } as unknown as MaterialContextItem);
    }
  }
  if (parsed.some((item, index) => item.rank !== index + 1)) fail();
  const gaps = r.gaps.map((raw) => {
    const g = exact(raw, ["code", "literature_id", "artifact_id"]);
    if (
      ![
        "material-missing",
        "representation-missing",
        "knowledge-missing",
        "source-only",
        "source-missing",
        "source-corrupt",
        "coverage-partial",
        "context-too-large",
        "evidence-limit",
        "candidate-limit",
        "material-index-unavailable",
        "material-index-corrupt",
        "material-index-stale",
        "knowledge-index-unavailable",
        "knowledge-index-corrupt",
        "knowledge-index-stale",
      ].includes(String(g.code))
    )
      fail();
    return {
      code: g.code as KnowledgeContextGapCode,
      literature_id:
        g.literature_id === null
          ? null
          : String(parseLiteratureId(g.literature_id)),
      artifact_id: g.artifact_id === null ? null : id(g.artifact_id),
    };
  });
  const usage = exact(r.usage, ["bytes", "items", "tokens", "tokenizer"]);
  if (
    usage.items !== parsed.length ||
    usage.tokens !== null ||
    usage.tokenizer !== null
  )
    fail();
  const bytes = integer(usage.bytes, 0, request.budget.max_bytes);
  if (bytes !== encoder.encode(JSON.stringify(value)).length) fail();
  const continuation = cursor(r.continuation);
  const materialSelected = request.kinds.some((kind) => kind !== "knowledge");
  const knowledgeSelected = request.kinds.includes("knowledge");
  const degradedMaterial = gaps.some((gap) =>
    gap.code.startsWith("material-index-"),
  );
  const degradedKnowledge = gaps.some((gap) =>
    gap.code.startsWith("knowledge-index-"),
  );
  const sourceOnly = parsed.some(
    (item) =>
      item.kind === "generated-knowledge" &&
      item.source_state === "source-only",
  );
  const generatedPartial = parsed.some(
    (item) =>
      item.kind === "generated-knowledge" && item.coverage_status === "partial",
  );
  if (
    r.truncated !== (continuation !== null) ||
    (r.coverage === "complete" && (gaps.length || r.truncated)) ||
    (r.coverage === "partial" && !gaps.length && !r.truncated) ||
    (sourceOnly && !gaps.some((gap) => gap.code === "source-only")) ||
    (generatedPartial &&
      !gaps.some((gap) => gap.code === "coverage-partial")) ||
    (!materialSelected && generations.material !== null) ||
    (!knowledgeSelected && generations.knowledge !== null) ||
    (materialSelected &&
      !degradedMaterial &&
      generations.material === null &&
      ["complete", "partial"].includes(String(r.coverage))) ||
    (knowledgeSelected &&
      !degradedKnowledge &&
      generations.knowledge === null &&
      ["complete", "partial"].includes(String(r.coverage))) ||
    (degradedMaterial && generations.material !== null) ||
    (degradedKnowledge && generations.knowledge !== null) ||
    (degradedMaterial &&
      parsed.some((item) => item.kind !== "generated-knowledge")) ||
    (degradedKnowledge &&
      parsed.some((item) => item.kind === "generated-knowledge")) ||
    (degradedMaterial && !materialSelected) ||
    (degradedKnowledge && !knowledgeSelected) ||
    ((degradedMaterial || degradedKnowledge) && r.coverage !== "partial")
  )
    fail();
  if (
    ["index-unavailable", "index-corrupt", "index-stale"].includes(
      String(r.coverage),
    ) &&
    (parsed.length || gaps.length || r.truncated)
  )
    fail();
  return Object.freeze({
    schema_version: 2,
    score_rule: "weighted-term-frequency-v1",
    items: Object.freeze(parsed),
    coverage: r.coverage as KnowledgeContextBundle["coverage"],
    generations,
    gaps: Object.freeze(gaps),
    usage: { bytes, items: parsed.length, tokens: null, tokenizer: null },
    truncated: r.truncated as boolean,
    continuation,
  });
}
