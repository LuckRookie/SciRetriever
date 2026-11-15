import {
  ContractValidationError,
  canonicalJsonBytes,
  parseArtifactRef,
  parseAssetId,
  type ArtifactRef,
  type Sha256,
} from "./index.js";
import {
  parseDocumentMaterialRef,
  parseDocumentResource,
  type DocumentMaterialRef,
  type DocumentResource,
} from "./document.js";
import {
  parseArrangementSourceBlock,
  type ArrangementSourceBlock,
} from "./archive-text.js";
import type { RawParseSourceProfile } from "./raw-parsing.js";

export type TextLevel = "draft" | "proofread";
export const DRAFT_BASES = [
  "text-layer-match",
  "text-layer-differs",
  "no-text-layer",
] as const;
export type DraftBasis = (typeof DRAFT_BASES)[number];
export type DocumentBasis =
  | DraftBasis
  | import("./proofread.js").ProofreadBasis;
export const DRAFT_FAILURE_CODES = [
  "page-tools-unavailable",
  "draft-too-large",
  "needs-parse",
  "source-integrity",
  "draft-publication",
  "cancelled",
] as const;
export type DraftFailureCode = (typeof DRAFT_FAILURE_CODES)[number];
export type DraftOutcome =
  | {
      readonly status: "formed" | "reused";
      readonly raw_parse_id: string;
      readonly document_version_id: string;
      readonly representation_sha256: Sha256;
      readonly default_changed: boolean;
      readonly default_text_level: TextLevel;
    }
  | {
      readonly status: "failed";
      readonly raw_parse_id: string;
      readonly failure_code: DraftFailureCode;
    }
  | {
      readonly status: "not-formed";
      readonly reason: "profile-not-requested" | "raw-parse-failed";
    };
export interface DraftDocumentRef {
  readonly schema_version: 3;
  readonly text_level: "draft";
  readonly document_id: string;
  readonly document_version_id: string;
  readonly representation_sha256: Sha256;
  readonly source_material_ref: DocumentMaterialRef;
  readonly raw_parse_id: string;
  readonly raw_parse_result_sha256: Sha256;
  readonly page_layer_sha256: Sha256;
  readonly draft_method_sha256: Sha256;
  readonly draft_content: ArtifactRef;
  readonly builder_version: "draft-leaves-v1";
  readonly locator_scheme: "utf8-segment-v1";
  readonly markdown: ArtifactRef;
  readonly structure: ArtifactRef;
  readonly resources: readonly DocumentResource[];
}
export interface DraftDifference {
  readonly leaf_id: string;
  readonly page_index: number;
  readonly kind: "mismatch" | "elsewhere";
  readonly parsed: string;
  readonly text_layer: string;
  readonly other_page_index: number | null;
}
export interface DraftMethod {
  readonly chrome: "page-chrome-v1";
  readonly breaks: "paragraph-break-v3";
  readonly reading_order: boolean;
  readonly comparison: "draft-compare-v1";
  readonly builder: "draft-leaves-v1";
}
export type DraftOperation =
  | {
      readonly kind: "drop";
      readonly leaf_id: string;
      readonly reason: "header" | "footer";
      readonly source: "program";
      readonly rule: string;
    }
  | {
      readonly kind: "merge";
      readonly leaf_ids: readonly string[];
      readonly joiners: readonly string[];
      readonly source: "program";
      readonly rule: "paragraph-break-v3";
    };
export interface DraftContent {
  readonly schema_version: 1;
  readonly format: "draft-content-v1";
  readonly differences_format: "draft-differences-v1";
  readonly raw: {
    readonly raw_parse_id: string;
    readonly result_sha256: Sha256;
    readonly profile: RawParseSourceProfile;
  };
  readonly page_layer_sha256: Sha256;
  readonly pages: readonly {
    readonly page_index: number;
    readonly kind: "text-layer" | "image-only" | "blank";
  }[];
  readonly method: DraftMethod;
  readonly draft_method_sha256: Sha256;
  readonly source_blocks: readonly ArrangementSourceBlock[];
  readonly operations: readonly DraftOperation[];
  readonly leaves: readonly {
    readonly leaf_id: string;
    readonly page_index: number;
    readonly basis: DraftBasis;
    readonly differences: readonly DraftDifference[];
  }[];
}
export const MAX_DRAFT_CONTENT_BYTES = 16 * 1024 * 1024;
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
function hash(value: unknown): Sha256 {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail();
  return value as Sha256;
}
function integer(value: unknown, max = 9999): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max)
    fail();
  return Number(value);
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) fail();
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) fail();
  return value as T;
}
function array<T>(value: unknown, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) fail();
  return value.map(parse);
}
export function parseDraftDifference(
  value: unknown,
  pageCount = 10000,
): DraftDifference {
  const r = exact(value, [
    "leaf_id",
    "page_index",
    "kind",
    "parsed",
    "text_layer",
    "other_page_index",
  ]);
  const kind = choice(r.kind, ["mismatch", "elsewhere"] as const),
    page = integer(r.page_index, pageCount - 1),
    parsed = text(r.parsed),
    layer = text(r.text_layer),
    other =
      r.other_page_index === null
        ? null
        : integer(r.other_page_index, pageCount - 1);
  if (
    (kind === "mismatch" &&
      (other !== null ||
        parsed === layer ||
        parsed.split(" ").join("") === layer.split(" ").join(""))) ||
    (kind === "elsewhere" &&
      (other === null || other === page || !parsed || layer))
  )
    fail();
  return {
    leaf_id: parseAssetId(r.leaf_id),
    page_index: page,
    kind,
    parsed,
    text_layer: layer,
    other_page_index: other,
  };
}
export function parseDraftMethod(value: unknown): DraftMethod {
  const r = exact(value, [
    "chrome",
    "breaks",
    "reading_order",
    "comparison",
    "builder",
  ]);
  if (
    r.chrome !== "page-chrome-v1" ||
    r.breaks !== "paragraph-break-v3" ||
    typeof r.reading_order !== "boolean" ||
    r.comparison !== "draft-compare-v1" ||
    r.builder !== "draft-leaves-v1"
  )
    fail();
  return {
    chrome: r.chrome,
    breaks: r.breaks,
    reading_order: r.reading_order,
    comparison: r.comparison,
    builder: r.builder,
  };
}
export function parseDraftContent(value: unknown): DraftContent {
  if (canonicalJsonBytes(value).byteLength > MAX_DRAFT_CONTENT_BYTES) fail();
  const r = exact(value, [
    "schema_version",
    "format",
    "differences_format",
    "raw",
    "page_layer_sha256",
    "pages",
    "method",
    "draft_method_sha256",
    "source_blocks",
    "operations",
    "leaves",
  ]);
  if (
    r.schema_version !== 1 ||
    r.format !== "draft-content-v1" ||
    r.differences_format !== "draft-differences-v1"
  )
    fail();
  const raw = exact(r.raw, ["raw_parse_id", "result_sha256", "profile"]);
  const pages = array(r.pages, (p) => {
    const row = exact(p, ["page_index", "kind"]);
    return {
      page_index: integer(row.page_index),
      kind: choice(row.kind, ["text-layer", "image-only", "blank"] as const),
    };
  });
  if (!pages.length || pages.some((p, i) => p.page_index !== i)) fail();
  const source_blocks = array(r.source_blocks, (b) =>
    parseArrangementSourceBlock(b, pages.length),
  );
  const rawId = parseAssetId(raw.raw_parse_id),
    resultHash = hash(raw.result_sha256);
  if (
    new Set(source_blocks.map((b) => b.root_block_id)).size !==
      source_blocks.length ||
    source_blocks.some(
      (b) => b.raw_parse_id !== rawId || b.result_sha256 !== resultHash,
    )
  )
    fail();
  const leaves = array(r.leaves, (v) => {
    const l = exact(v, ["leaf_id", "page_index", "basis", "differences"]),
      id = parseAssetId(l.leaf_id),
      page = integer(l.page_index, pages.length - 1),
      basis = choice(l.basis, DRAFT_BASES);
    const differences = array(l.differences, (d) =>
      parseDraftDifference(d, pages.length),
    );
    if (
      differences.some((d) => d.leaf_id !== id || d.page_index !== page) ||
      (basis === "text-layer-differs") !== differences.length > 0 ||
      (pages[page]!.kind !== "text-layer" && basis !== "no-text-layer")
    )
      fail();
    return { leaf_id: id, page_index: page, basis, differences };
  });
  const retained = new Set<string>(leaves.map((l) => l.leaf_id));
  if (retained.size !== leaves.length) fail();
  const claimed = new Set<string>(),
    dropped = new Set<string>();
  const operations = array(r.operations, (v): DraftOperation => {
    if (!v || typeof v !== "object" || !("kind" in v)) fail();
    if (v.kind === "drop") {
      const o = exact(v, ["kind", "leaf_id", "reason", "source", "rule"]),
        id = parseAssetId(o.leaf_id);
      if (
        retained.has(id) ||
        dropped.has(id) ||
        o.source !== "program" ||
        typeof o.rule !== "string" ||
        !/^page-chrome-v1\/[a-z-]+$/u.test(o.rule)
      )
        fail();
      dropped.add(id);
      return {
        kind: "drop",
        leaf_id: id,
        reason: choice(o.reason, ["header", "footer"] as const),
        source: "program",
        rule: o.rule,
      };
    }
    const o = exact(v, ["kind", "leaf_ids", "joiners", "source", "rule"]);
    const ids = array(o.leaf_ids, (id) => String(parseAssetId(id))),
      joiners = array(o.joiners, (j) => choice(j, ["", " "] as const));
    if (
      o.kind !== "merge" ||
      o.source !== "program" ||
      o.rule !== "paragraph-break-v3" ||
      ids.length < 2 ||
      joiners.length !== ids.length - 1 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !retained.has(id) || claimed.has(id))
    )
      fail();
    ids.forEach((id) => claimed.add(id));
    return {
      kind: "merge",
      leaf_ids: ids,
      joiners,
      source: "program",
      rule: "paragraph-break-v3",
    };
  });
  if (dropped.size + leaves.length !== source_blocks.length) fail();
  return {
    schema_version: 1,
    format: "draft-content-v1",
    differences_format: "draft-differences-v1",
    raw: {
      raw_parse_id: rawId,
      result_sha256: resultHash,
      profile: choice(raw.profile, [
        "pipeline",
        "vlm-engine",
        "vlm-engine-markdown-only",
      ] as const),
    },
    page_layer_sha256: hash(r.page_layer_sha256),
    pages,
    method: parseDraftMethod(r.method),
    draft_method_sha256: hash(r.draft_method_sha256),
    source_blocks,
    operations,
    leaves,
  };
}
export function parseDraftDocumentRef(value: unknown): DraftDocumentRef {
  const r = exact(value, [
    "schema_version",
    "text_level",
    "document_id",
    "document_version_id",
    "representation_sha256",
    "source_material_ref",
    "raw_parse_id",
    "raw_parse_result_sha256",
    "page_layer_sha256",
    "draft_method_sha256",
    "draft_content",
    "builder_version",
    "locator_scheme",
    "markdown",
    "structure",
    "resources",
  ]);
  if (
    r.schema_version !== 3 ||
    r.text_level !== "draft" ||
    r.builder_version !== "draft-leaves-v1" ||
    r.locator_scheme !== "utf8-segment-v1"
  )
    fail();
  const artifact = (v: unknown, mime: string, max: number) => {
    const a = parseArtifactRef(v);
    if (a.media_type !== mime || a.byte_size < 1 || a.byte_size > max) fail();
    return a;
  };
  if (!Array.isArray(r.resources) || r.resources.length > 4096) fail();
  const resources = array(r.resources, parseDocumentResource).sort((a, b) =>
    a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0,
  );
  if (
    new Set(resources.map((a) => a.reference)).size !== resources.length ||
    new Set(resources.map((a) => a.resource_id)).size !== resources.length ||
    resources.some(
      (r) =>
        r.relation !== "image" || !r.artifact.media_type.startsWith("image/"),
    )
  )
    fail();
  return {
    schema_version: 3,
    text_level: "draft",
    document_id: parseAssetId(r.document_id),
    document_version_id: parseAssetId(r.document_version_id),
    representation_sha256: hash(r.representation_sha256),
    source_material_ref: parseDocumentMaterialRef(r.source_material_ref),
    raw_parse_id: parseAssetId(r.raw_parse_id),
    raw_parse_result_sha256: hash(r.raw_parse_result_sha256),
    page_layer_sha256: hash(r.page_layer_sha256),
    draft_method_sha256: hash(r.draft_method_sha256),
    draft_content: artifact(
      r.draft_content,
      "application/json",
      MAX_DRAFT_CONTENT_BYTES,
    ),
    builder_version: "draft-leaves-v1",
    locator_scheme: "utf8-segment-v1",
    markdown: artifact(r.markdown, "text/markdown", 8 * 1024 * 1024),
    structure: artifact(r.structure, "application/json", 16 * 1024 * 1024),
    resources,
  };
}
export function parseDraftOutcome(value: unknown): DraftOutcome {
  if (!value || typeof value !== "object" || !("status" in value)) fail();
  if (value.status === "not-formed") {
    const r = exact(value, ["status", "reason"]);
    return {
      status: "not-formed",
      reason: choice(r.reason, [
        "profile-not-requested",
        "raw-parse-failed",
      ] as const),
    };
  }
  if (value.status === "failed") {
    const r = exact(value, ["status", "raw_parse_id", "failure_code"]);
    return {
      status: "failed",
      raw_parse_id: parseAssetId(r.raw_parse_id),
      failure_code: choice(r.failure_code, DRAFT_FAILURE_CODES),
    };
  }
  const r = exact(value, [
    "status",
    "raw_parse_id",
    "document_version_id",
    "representation_sha256",
    "default_changed",
    "default_text_level",
  ]);
  if (typeof r.default_changed !== "boolean") fail();
  return {
    status: choice(r.status, ["formed", "reused"] as const),
    raw_parse_id: parseAssetId(r.raw_parse_id),
    document_version_id: parseAssetId(r.document_version_id),
    representation_sha256: hash(r.representation_sha256),
    default_changed: r.default_changed,
    default_text_level: choice(r.default_text_level, [
      "draft",
      "proofread",
    ] as const),
  };
}
