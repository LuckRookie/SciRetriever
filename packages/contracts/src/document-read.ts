import {
  parseLongDocumentInfo,
  type LongDocumentInfo,
} from "./long-document.js";
import { parseDocumentLayout, type DocumentLayout } from "./document-layout.js";
import { parseSectionRole, type SectionRole } from "./section-roles.js";
import type { SectionRoleSource } from "./structure-annotation.js";
import { parsePageRegion } from "./raw-parsing.js";
import {
  PROOFREAD_SEGMENT_KINDS,
  type ProofreadSegmentKind,
} from "./document-structure-v2.js";
import type { ProofreadSource } from "./proofread.js";
import {
  DRAFT_BASES,
  parseTextLevel,
  type TextLevel,
  type DraftBasis,
  type DocumentBasis,
} from "./draft-document.js";
import {
  isTranslationLanguage,
  type DocumentTranslationState,
  type DocumentTranslationSummary,
  type TranslationLanguage,
} from "./translation.js";
import {
  ContractValidationError,
  parseAssetId,
  parseLiteratureId,
  parseDocumentMaterialRef,
  parseDocumentResource,
  parseEvidenceRef,
  type DocumentMaterialRef,
  type DocumentResource,
  type EvidenceRef,
} from "./index.js";

export const DOCUMENT_READ_MAX_BYTES = 64 * 1024;
export const DOCUMENT_READ_MAX_ITEMS = 200;
export const DOCUMENT_READ_MAX_EVIDENCE = DOCUMENT_READ_MAX_ITEMS;
export const DOCUMENT_READ_MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
export const DOCUMENT_READ_MAX_TITLE_BYTES = 512;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const digestPattern = /^[0-9a-f]{64}$/;
const tokenPattern = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;
export const DRAFT_ROLE_COVERAGE_NOTE = "初稿没有章节角色，读取了整篇";
function levelKeys(value: unknown): string[] {
  return value &&
    typeof value === "object" &&
    Object.hasOwn(value, "text_level")
    ? ["text_level"]
    : [];
}
function levelFields(value: Record<string, unknown>): {
  readonly text_level?: TextLevel;
} {
  return Object.hasOwn(value, "text_level")
    ? { text_level: parseTextLevel(value.text_level) }
    : {};
}
function fail(): never {
  throw new ContractValidationError();
}
function object(
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
function uuid(value: unknown): string {
  return String(parseAssetId(value));
}
function literature(value: unknown): string {
  return String(parseLiteratureId(value));
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) fail();
  return value;
}
function token(value: unknown): string {
  if (typeof value !== "string" || !tokenPattern.test(value)) fail();
  return value;
}
function cursor(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    fail();
  return value;
}
function count(value: unknown, max: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > max
  )
    fail();
  return value as number;
}
function nonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail();
  return value as number;
}
export type DocumentSelector =
  | { readonly kind: "section"; readonly section_id: string }
  | { readonly kind: "segment"; readonly segment_id: string }
  | { readonly kind: "resource-context"; readonly resource_id: string }
  | {
      readonly kind: "range";
      readonly start_utf8: number;
      readonly end_utf8: number;
    };
export function parseDocumentSelector(value: unknown): DocumentSelector {
  const kind =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).kind
      : undefined;
  if (kind === "section") {
    const r = object(value, ["kind", "section_id"]);
    return Object.freeze({ kind, section_id: token(r.section_id) });
  }
  if (kind === "segment") {
    const r = object(value, ["kind", "segment_id"]);
    return Object.freeze({ kind, segment_id: token(r.segment_id) });
  }
  if (kind === "resource-context") {
    const r = object(value, ["kind", "resource_id"]);
    return Object.freeze({ kind, resource_id: token(r.resource_id) });
  }
  if (kind === "range") {
    const r = object(value, ["kind", "start_utf8", "end_utf8"]);
    const start = nonnegative(r.start_utf8);
    const end = nonnegative(r.end_utf8);
    if (end <= start) fail();
    return Object.freeze({ kind, start_utf8: start, end_utf8: end });
  }
  return fail();
}
export interface DocumentReadRequestMap {
  default: {
    readonly literature_id: string;
    readonly asset_id: string;
    readonly asset_sha256: string;
  };
  describe: { readonly document_version_id: string };
  outline: {
    readonly annotation_id?: string | null;
    readonly document_version_id: string;
    readonly limit: number;
    readonly cursor: string | null;
  };
  segments: {
    readonly annotation_id?: string | null;
    readonly roles?: readonly SectionRole[];
    readonly document_version_id: string;
    readonly section_id: string | null;
    readonly limit: number;
    readonly cursor: string | null;
  };
  resources: {
    readonly document_version_id: string;
    readonly limit: number;
    readonly cursor: string | null;
  };
  slice: {
    readonly document_version_id: string;
    readonly selector: DocumentSelector;
    readonly max_bytes: number;
    readonly continuation: string | null;
    /** Stored machine translation (ADR 0068); absent means original. */
    readonly text?: DocumentSliceText;
  };
  resource: {
    readonly document_version_id: string;
    readonly resource_id: string;
    readonly max_bytes: number;
    readonly continuation: string | null;
  };

  material: { readonly literature_id: string; readonly asset_id: string };
  evidence: {
    readonly evidence: EvidenceRef;
    readonly max_bytes: number;
    readonly continuation: string | null;
  };
}
export type DocumentReadOperation = keyof DocumentReadRequestMap;
export const DOCUMENT_SLICE_TEXTS = [
  "original",
  "translation",
  "bilingual",
] as const;
export type DocumentSliceText = (typeof DOCUMENT_SLICE_TEXTS)[number];
export function parseDocumentReadRequest<K extends DocumentReadOperation>(
  kind: K,
  value: unknown,
): DocumentReadRequestMap[K] {
  let result: DocumentReadRequestMap[DocumentReadOperation];
  switch (kind) {
    case "default": {
      const r = object(value, ["literature_id", "asset_id", "asset_sha256"]);
      result = {
        literature_id: literature(r.literature_id),
        asset_id: uuid(r.asset_id),
        asset_sha256: hash(r.asset_sha256),
      };
      break;
    }
    case "describe": {
      const r = object(value, ["document_version_id"]);
      result = { document_version_id: uuid(r.document_version_id) };
      break;
    }
    case "outline":
    case "resources": {
      const annotated =
        kind === "outline" &&
        Boolean(value && typeof value === "object" && "annotation_id" in value);
      const r = object(value, [
        "document_version_id",
        "limit",
        "cursor",
        ...(annotated ? ["annotation_id"] : []),
      ]);
      result = {
        document_version_id: uuid(r.document_version_id),
        limit: count(r.limit, DOCUMENT_READ_MAX_ITEMS),
        cursor: cursor(r.cursor),
        ...(annotated
          ? {
              annotation_id:
                r.annotation_id === null ? null : hash(r.annotation_id),
            }
          : {}),
      };
      break;
    }
    case "segments": {
      const annotated = Boolean(
          value && typeof value === "object" && "annotation_id" in value,
        ),
        filtered = Boolean(
          value && typeof value === "object" && "roles" in value,
        );
      const r = object(value, [
        "document_version_id",
        "section_id",
        "limit",
        "cursor",
        ...(annotated ? ["annotation_id"] : []),
        ...(filtered ? ["roles"] : []),
      ]);
      if (
        filtered &&
        (!Array.isArray(r.roles) ||
          r.roles.length > 20 ||
          new Set(r.roles).size !== r.roles.length)
      )
        fail();
      result = {
        document_version_id: uuid(r.document_version_id),
        section_id: r.section_id === null ? null : token(r.section_id),
        limit: count(r.limit, DOCUMENT_READ_MAX_ITEMS),
        cursor: cursor(r.cursor),
        ...(annotated
          ? {
              annotation_id:
                r.annotation_id === null ? null : hash(r.annotation_id),
            }
          : {}),
        ...(filtered
          ? { roles: (r.roles as unknown[]).map((v) => parseSectionRole(v)) }
          : {}),
      };
      break;
    }
    case "slice": {
      const texted = Boolean(
        value && typeof value === "object" && Object.hasOwn(value, "text"),
      );
      const r = object(value, [
        "document_version_id",
        "selector",
        "max_bytes",
        "continuation",
        ...(texted ? ["text"] : []),
      ]);
      if (texted && !DOCUMENT_SLICE_TEXTS.includes(r.text as DocumentSliceText))
        fail();
      result = {
        document_version_id: uuid(r.document_version_id),
        selector: parseDocumentSelector(r.selector),
        max_bytes: count(r.max_bytes, DOCUMENT_READ_MAX_BYTES),
        continuation: cursor(r.continuation),
        ...(texted ? { text: r.text as DocumentSliceText } : {}),
      };
      break;
    }

    case "resource": {
      const r = object(value, [
        "document_version_id",
        "resource_id",
        "max_bytes",
        "continuation",
      ]);
      result = {
        document_version_id: uuid(r.document_version_id),
        resource_id: token(r.resource_id),
        max_bytes: count(r.max_bytes, DOCUMENT_READ_MAX_BYTES),
        continuation: cursor(r.continuation),
      };
      break;
    }

    case "material": {
      const r = object(value, ["literature_id", "asset_id"]);
      result = {
        literature_id: literature(r.literature_id),
        asset_id: uuid(r.asset_id),
      };
      break;
    }
    case "evidence": {
      const r = object(value, ["evidence", "max_bytes", "continuation"]);
      result = {
        evidence: parseEvidenceRef(r.evidence),
        max_bytes: count(r.max_bytes, DOCUMENT_READ_MAX_BYTES),
        continuation: cursor(r.continuation),
      };
      break;
    }
    default:
      return fail();
  }
  return Object.freeze(result) as DocumentReadRequestMap[K];
}

export interface DocumentMaterialBytesRequest {
  readonly literature_id: string;
  readonly asset_id: string;
  readonly asset_sha256: string;
}
export function parseDocumentMaterialBytesRequest(
  value: unknown,
): DocumentMaterialBytesRequest {
  const r = object(value, ["literature_id", "asset_id", "asset_sha256"]);
  return Object.freeze({
    literature_id: literature(r.literature_id),
    asset_id: uuid(r.asset_id),
    asset_sha256: hash(r.asset_sha256),
  });
}

export interface DocumentResourceBytesRequest {
  readonly document_version_id: string;
  readonly resource_id: string;
}
export function parseDocumentResourceBytesRequest(
  value: unknown,
): DocumentResourceBytesRequest {
  const r = object(value, ["document_version_id", "resource_id"]);
  return Object.freeze({
    document_version_id: uuid(r.document_version_id),
    resource_id: token(r.resource_id),
  });
}

export interface DocumentReadingRef {
  readonly document_id: string;
  readonly document_version_id: string;
  readonly representation_sha256: string;
  readonly source_material_ref: DocumentMaterialRef;
  readonly locator_scheme: "utf8-segment-v1";
}
export function parseDocumentReadingRef(value: unknown): DocumentReadingRef {
  const r = object(value, [
    "document_id",
    "document_version_id",
    "representation_sha256",
    "source_material_ref",
    "locator_scheme",
  ]);
  if (r.locator_scheme !== "utf8-segment-v1") fail();
  return Object.freeze({
    document_id: uuid(r.document_id),
    document_version_id: uuid(r.document_version_id),
    representation_sha256: hash(r.representation_sha256),
    source_material_ref: parseDocumentMaterialRef(r.source_material_ref),
    locator_scheme: "utf8-segment-v1",
  });
}
export interface DocumentReadCapabilities {
  readonly text: boolean;
  readonly outline: boolean;
  readonly resources: boolean;
  readonly table_context: boolean;
  readonly figure_caption: boolean;
  readonly page: boolean;
  readonly bbox: boolean;
}
export type DocumentReadGap =
  | "table-structure-unavailable"
  | "figure-caption-unavailable"
  | "page-location-unavailable"
  | "bbox-unavailable"
  | "partial-segment"
  | "evidence-page-limit"
  | "resource-context-unavailable"
  | "outline-title-truncated"
  | "field-location-unavailable";
const gapValues: readonly DocumentReadGap[] = [
  "table-structure-unavailable",
  "figure-caption-unavailable",
  "page-location-unavailable",
  "bbox-unavailable",
  "partial-segment",
  "evidence-page-limit",
  "resource-context-unavailable",
  "outline-title-truncated",
  "field-location-unavailable",
];
function gaps(value: unknown): readonly DocumentReadGap[] {
  if (
    !Array.isArray(value) ||
    value.length > 16 ||
    value.some((item) => !gapValues.includes(item as DocumentReadGap))
  )
    fail();
  return Object.freeze([...value]) as readonly DocumentReadGap[];
}
function capabilities(value: unknown): DocumentReadCapabilities {
  const r = object(value, [
    "text",
    "outline",
    "resources",
    "table_context",
    "figure_caption",
    "page",
    "bbox",
  ]);
  if (Object.values(r).some((item) => typeof item !== "boolean")) fail();
  return Object.freeze(r) as unknown as DocumentReadCapabilities;
}
function range<A extends string, B extends string>(
  value: unknown,
  start: A,
  end: B,
): Readonly<Record<A | B, number>> {
  const r = object(value, [start, end]);
  const a = nonnegative(r[start]),
    b = nonnegative(r[end]);
  if (b <= a) fail();
  return { [start]: a, [end]: b } as Record<A | B, number>;
}
export interface DocumentSegmentLocation {
  readonly block_id: string;
  /** One-based public page. */ readonly page: number;
  readonly region: import("./raw-parsing.js").PageRegion | null;
  readonly continuation_regions: readonly {
    readonly page: number;
    readonly region: import("./raw-parsing.js").PageRegion;
  }[];
  readonly source: ProofreadSource;
  readonly basis: DocumentBasis;

  readonly locate: "region" | "page";
}
export function parseDocumentSegmentLocation(
  value: unknown,
): DocumentSegmentLocation {
  return parseSegmentLocation(value, ["text-layer", "image-only", "manual"]);
}
/** Version-aware corrected reads include v5 unreviewed long-document bases.
 * The fixed builder and paired page status are verified before producing them;
 * unversioned callers keep the original corrected-only set.
 */
export function parseDocumentSegmentLocationForVersion(
  value: unknown,
  schemaVersion: 2 | 3,
): DocumentSegmentLocation {
  if (schemaVersion !== 2 && schemaVersion !== 3) fail();
  return parseSegmentLocation(
    value,
    schemaVersion === 3
      ? DRAFT_BASES
      : ["text-layer", "image-only", "manual", ...DRAFT_BASES],
  );
}
function parseSegmentLocation(
  value: unknown,
  bases: readonly string[],
): DocumentSegmentLocation {
  const r = object(value, [
    "block_id",
    "page",
    "region",
    "continuation_regions",
    "source",
    "basis",

    "locate",
  ]);
  const page = count(r.page, 10000),
    region = r.region === null ? null : parsePageRegion(r.region);
  if (
    !["parser", "rule", "agent", "manual"].includes(String(r.source)) ||
    !["region", "page"].includes(String(r.locate)) ||
    (r.locate === "region") !== (region !== null) ||
    !Array.isArray(r.continuation_regions) ||
    r.continuation_regions.length > 10000
  )
    fail();
  if (typeof r.basis !== "string" || !bases.includes(r.basis)) fail();
  return {
    block_id: token(r.block_id),
    page,
    region,
    source: r.source as ProofreadSource,
    basis: r.basis as DocumentBasis,

    locate: r.locate as "region" | "page",
    continuation_regions: r.continuation_regions.map((v) => {
      const p = object(v, ["page", "region"]);
      return { page: count(p.page, 10000), region: parsePageRegion(p.region) };
    }),
  };
}
function section(value: unknown, level?: TextLevel) {
  const annotated = Boolean(
    value && typeof value === "object" && "role" in value,
  );
  const r = object(value, [
    "section_id",
    "title",
    "title_truncated",
    "level",
    "start_utf8",
    "end_utf8",
    ...(annotated ? ["role", "role_source"] : []),
  ]);
  if (
    level === "draft" &&
    (!annotated || r.role !== null || r.role_source !== null)
  )
    fail();
  if (
    (r.title !== null &&
      (typeof r.title !== "string" ||
        encoder.encode(r.title).length > DOCUMENT_READ_MAX_TITLE_BYTES)) ||
    (r.title === null && r.title_truncated !== false) ||
    typeof r.title_truncated !== "boolean" ||
    !Number.isSafeInteger(r.level) ||
    (r.level as number) < 1 ||
    (r.level as number) > 6
  )
    fail();
  if (
    annotated &&
    (r.role === null
      ? r.role_source !== null
      : !["rule", "model", "fallback", "manual", "arrangement"].includes(
          String(r.role_source),
        ))
  )
    fail();
  return Object.freeze({
    ...(annotated
      ? {
          role: r.role === null ? null : parseSectionRole(r.role),
          role_source: r.role_source as SectionRoleSource | null,
        }
      : {}),
    section_id: token(r.section_id),
    title: r.title as string | null,
    title_truncated: r.title_truncated,
    level: r.level as number,
    ...range(
      { start_utf8: r.start_utf8, end_utf8: r.end_utf8 },
      "start_utf8",
      "end_utf8",
    ),
  });
}
function segment(value: unknown, level?: TextLevel) {
  const located = Boolean(
    value && typeof value === "object" && "block_id" in value,
  );
  const r = object(value, [
    "segment_id",
    "kind",
    "section_id",
    "start_utf8",
    "end_utf8",
    ...(located
      ? [
          "block_id",
          "page",
          "region",
          "continuation_regions",
          "locate",
          "source",
          "basis",
        ]
      : []),
  ]);
  if (level === "draft" && !located) fail();
  if (!PROOFREAD_SEGMENT_KINDS.includes(r.kind as ProofreadSegmentKind)) fail();
  return Object.freeze({
    ...(located
      ? parseDocumentSegmentLocationForVersion(
          {
            block_id: r.block_id,
            page: r.page,
            region: r.region,
            continuation_regions: r.continuation_regions,
            locate: r.locate,
            source: r.source,
            basis: r.basis,
          },
          level === "draft" ? 3 : 2,
        )
      : {}),
    segment_id: token(r.segment_id),
    kind: r.kind as ProofreadSegmentKind,
    section_id: r.section_id === null ? null : token(r.section_id),
    ...range(
      { start_utf8: r.start_utf8, end_utf8: r.end_utf8 },
      "start_utf8",
      "end_utf8",
    ),
  });
}
function page(
  value: unknown,
  field: "sections" | "segments" | "resources",
  parseItem: (value: unknown, level?: TextLevel) => unknown,
  limit: number,
) {
  const annotated = Boolean(
    value && typeof value === "object" && "annotation_id" in value,
  );
  const r = object(value, [
    "document",
    field,
    "total",
    "next_cursor",
    "capabilities",
    "gaps",
    ...(annotated ? ["annotation_id"] : []),
    ...levelKeys(value),
    ...(field === "segments" &&
    value &&
    typeof value === "object" &&
    Object.hasOwn(value, "coverage_note")
      ? ["coverage_note"]
      : []),
  ]);
  const level = levelFields(r);
  if (level.text_level === "draft" && r.annotation_id != null) fail();
  if (
    Object.hasOwn(r, "coverage_note") &&
    (level.text_level !== "draft" ||
      r.coverage_note !== DRAFT_ROLE_COVERAGE_NOTE)
  )
    fail();
  if (!Array.isArray(r[field]) || r[field].length > limit) fail();
  const total = nonnegative(r.total);
  if (total < r[field].length) fail();
  const next = cursor(r.next_cursor);
  return {
    ...level,
    ...(Object.hasOwn(r, "coverage_note")
      ? { coverage_note: DRAFT_ROLE_COVERAGE_NOTE }
      : {}),
    ...(annotated
      ? {
          annotation_id:
            r.annotation_id === null ? null : hash(r.annotation_id),
        }
      : {}),
    document: parseDocumentReadingRef(r.document),
    [field]: Object.freeze(r[field].map((v) => parseItem(v, level.text_level))),
    total,
    next_cursor: next,
    capabilities: capabilities(r.capabilities),
    gaps: gaps(r.gaps),
  };
}
function matchDocument(
  document: DocumentReadingRef,
  request: { readonly document_version_id: string },
) {
  if (document.document_version_id !== request.document_version_id) fail();
}
function matchPage(
  request: { readonly cursor: string | null },
  result: { readonly next_cursor: string | null },
) {
  if (request.cursor !== null && result.next_cursor === request.cursor) fail();
}
interface ReadPage {
  readonly text_level?: TextLevel;
  readonly annotation_id?: string | null;
  readonly document: DocumentReadingRef;
  readonly total: number;
  readonly next_cursor: string | null;
  readonly capabilities: DocumentReadCapabilities;
  readonly gaps: readonly DocumentReadGap[];
}
interface ReadSection {
  readonly role?: SectionRole | null;
  readonly role_source?: SectionRoleSource | null;
  readonly section_id: string;
  readonly title: string | null;
  readonly title_truncated: boolean;
  readonly level: number;
  readonly start_utf8: number;
  readonly end_utf8: number;
}
interface ReadSegment extends Partial<DocumentSegmentLocation> {
  readonly segment_id: string;
  readonly kind: ProofreadSegmentKind;
  readonly section_id: string | null;
  readonly start_utf8: number;
  readonly end_utf8: number;
}
export interface DocumentReadResultMap {
  default: {
    readonly material: DocumentMaterialRef;
    readonly default: {
      readonly document_version_id: string;
      readonly revision: number;
    } | null;
    readonly gap: "document-missing" | null;
  };
  describe: {
    readonly text_level?: TextLevel;
    readonly draft_summary?: {
      readonly differs_segments: number;
      readonly differences: number;
      readonly image_only_pages: number;
    };
    readonly long_document?: LongDocumentInfo | null;
    readonly document: DocumentReadingRef;
    readonly capabilities: DocumentReadCapabilities;
    readonly gaps: readonly DocumentReadGap[];
    readonly layout?: DocumentLayout;
    /** Stored machine translation of this version (ADR 0068). */
    readonly translation?: DocumentTranslationSummary;
    readonly section_count: number;
    readonly segment_count: number;
    readonly resource_count: number;
  };
  outline: ReadPage & { readonly sections: readonly ReadSection[] };
  segments: ReadPage & {
    readonly segments: readonly ReadSegment[];
    readonly coverage_note?: typeof DRAFT_ROLE_COVERAGE_NOTE;
  };
  resources: ReadPage & { readonly resources: readonly DocumentResource[] };
  slice: {
    readonly text_level?: TextLevel;
    readonly document: DocumentReadingRef;
    readonly selector: DocumentSelector;
    readonly locations?: readonly DocumentSegmentLocation[];
    readonly actual_range: {
      readonly start_utf8: number;
      readonly end_utf8: number;
    } | null;
    readonly text: string;
    readonly evidence: readonly EvidenceRef[];
    readonly related_resources: readonly DocumentResource[];
    readonly truncated: boolean;
    readonly continuation: string | null;
    readonly capabilities: DocumentReadCapabilities;
    readonly gaps: readonly DocumentReadGap[];
    /** Present only for `text: translation | bilingual`; such text is not evidence. */
    readonly machine_translation?: boolean;
    readonly target_language?: TranslationLanguage;
    /** Translatable units in the range that have no translation. */
    readonly untranslated_units?: number;
  };
  resource: {
    readonly text_level?: TextLevel;
    readonly document: DocumentReadingRef;
    readonly resource: DocumentResource;
    readonly bytes_base64: string | null;
    readonly actual_range: {
      readonly start_byte: number;
      readonly end_byte: number;
    } | null;
    readonly truncated: boolean;
    readonly continuation: string | null;
    readonly gap: "resource-media-unsupported" | null;
  };
  material: {
    readonly evidence: EvidenceRef;
    readonly granularity: "file";
    readonly gaps: readonly DocumentReadGap[];
  };
  evidence: {
    readonly text_level?: TextLevel;
    readonly evidence: EvidenceRef;
    readonly location?: DocumentSegmentLocation;
    readonly granularity: "file" | "segment";
    readonly gaps: readonly DocumentReadGap[];
    readonly material?: DocumentMaterialRef;
    readonly document?: DocumentReadingRef;
    readonly target_range?: {
      readonly start_utf8: number;
      readonly end_utf8: number;
    };
    readonly actual_range?: {
      readonly start_utf8: number;
      readonly end_utf8: number;
    };
    readonly text?: string;
    readonly content_sha256?: string;
    readonly truncated?: boolean;
    readonly continuation?: string | null;
  };
}
export function parseDocumentReadResult<K extends DocumentReadOperation>(
  kind: K,
  value: unknown,
  request: DocumentReadRequestMap[K],
): DocumentReadResultMap[K] {
  return parseResult(kind, value, request) as DocumentReadResultMap[K];
}
function parseResult<K extends DocumentReadOperation>(
  kind: K,
  value: unknown,
  request: DocumentReadRequestMap[K],
): unknown {
  const req = request as DocumentReadRequestMap[DocumentReadOperation];
  switch (kind) {
    case "default": {
      const r = object(value, ["material", "default", "gap"]);
      const material = parseDocumentMaterialRef(r.material);
      const expected = req as DocumentReadRequestMap["default"];
      if (
        material.literature_id !== expected.literature_id ||
        material.asset_id !== expected.asset_id ||
        material.asset_sha256 !== expected.asset_sha256
      )
        fail();
      if (r.default === null) {
        if (r.gap !== "document-missing") fail();
        return Object.freeze({
          material,
          default: null,
          gap: "document-missing" as const,
        });
      }
      const d = object(r.default, ["document_version_id", "revision"]);
      if (r.gap !== null) fail();
      return Object.freeze({
        material,
        default: Object.freeze({
          document_version_id: uuid(d.document_version_id),
          revision: count(d.revision, Number.MAX_SAFE_INTEGER),
        }),
        gap: null,
      });
    }
    case "describe": {
      const r = object(value, [
        "document",
        "capabilities",
        "gaps",
        "section_count",
        "segment_count",
        "resource_count",
        ...levelKeys(value),
        ...(value &&
        typeof value === "object" &&
        Object.hasOwn(value, "draft_summary")
          ? ["draft_summary"]
          : []),
        ...(value && typeof value === "object" && "long_document" in value
          ? ["long_document"]
          : []),
        ...(value && typeof value === "object" && "layout" in value
          ? ["layout"]
          : []),
        ...(value && typeof value === "object" && "translation" in value
          ? ["translation"]
          : []),
      ]);
      const document = parseDocumentReadingRef(r.document);
      matchDocument(document, req as DocumentReadRequestMap["describe"]);
      const level = levelFields(r);
      if ((level.text_level === "draft") !== Object.hasOwn(r, "draft_summary"))
        fail();
      const summary = Object.hasOwn(r, "draft_summary")
        ? object(r.draft_summary, [
            "differs_segments",
            "differences",
            "image_only_pages",
          ])
        : undefined;
      return Object.freeze({
        ...level,
        ...(summary
          ? {
              draft_summary: Object.freeze({
                differs_segments: nonnegative(summary.differs_segments),
                differences: nonnegative(summary.differences),
                image_only_pages: nonnegative(summary.image_only_pages),
              }),
            }
          : {}),
        document,
        capabilities: capabilities(r.capabilities),
        gaps: gaps(r.gaps),
        section_count: nonnegative(r.section_count),
        segment_count: nonnegative(r.segment_count),
        resource_count: nonnegative(r.resource_count),
        ...(r.long_document === undefined
          ? {}
          : {
              long_document:
                r.long_document === null
                  ? null
                  : parseLongDocumentInfo(r.long_document),
            }),
        ...(r.layout === undefined
          ? {}
          : { layout: parseDocumentLayout(r.layout) }),
        ...(r.translation === undefined
          ? {}
          : {
              translation: translationSummary(
                r.translation,
                level.text_level === "draft",
              ),
            }),
      });
    }
    case "outline":
    case "segments":
    case "resources": {
      const field: "sections" | "segments" | "resources" =
        kind === "outline"
          ? "sections"
          : kind === "segments"
            ? "segments"
            : "resources";
      const parsed = page(
        value,
        field,
        kind === "outline"
          ? section
          : kind === "segments"
            ? segment
            : parseDocumentResource,
        (req as DocumentReadRequestMap["outline"]).limit,
      );
      matchDocument(parsed.document, req as DocumentReadRequestMap["outline"]);
      matchPage(req as DocumentReadRequestMap["outline"], parsed);
      const pinned = req as DocumentReadRequestMap["outline"];
      if (pinned.annotation_id && parsed.annotation_id !== pinned.annotation_id)
        fail();
      if (
        kind === "segments" &&
        parsed.text_level === "draft" &&
        Boolean((req as DocumentReadRequestMap["segments"]).roles?.length) !==
          Object.hasOwn(parsed, "coverage_note")
      )
        fail();
      return Object.freeze(parsed);
    }
    case "slice": {
      const located = Boolean(
        value && typeof value === "object" && "locations" in value,
      );
      const translated =
        ((req as DocumentReadRequestMap["slice"]).text ?? "original") !==
        "original";
      const r = object(value, [
        ...(translated
          ? ["machine_translation", "target_language", "untranslated_units"]
          : []),
        "document",
        "selector",
        "actual_range",
        "text",
        "evidence",
        "related_resources",
        "truncated",
        "continuation",
        "capabilities",
        "gaps",
        ...(located ? ["locations"] : []),
        ...levelKeys(value),
      ]);
      const request = req as DocumentReadRequestMap["slice"];
      const document = parseDocumentReadingRef(r.document);
      matchDocument(document, request);
      const selector = parseDocumentSelector(r.selector);
      if (
        JSON.stringify(selector) !== JSON.stringify(request.selector) ||
        typeof r.text !== "string" ||
        encoder.encode(r.text).length > request.max_bytes ||
        typeof r.truncated !== "boolean" ||
        !Array.isArray(r.evidence) ||
        r.evidence.length > DOCUMENT_READ_MAX_EVIDENCE ||
        !Array.isArray(r.related_resources) ||
        r.related_resources.length > 1
      )
        fail();
      const evidence = Object.freeze(r.evidence.map(parseEvidenceRef));
      if (
        evidence.some(
          (item) =>
            item.target_kind !== "document" ||
            item.document_version_id !== document.document_version_id ||
            item.representation_sha256 !== document.representation_sha256,
        )
      )
        fail();
      const related_resources = Object.freeze(
        r.related_resources.map(parseDocumentResource),
      );
      const parsedGaps = gaps(r.gaps);
      const actual_range =
        r.actual_range === null
          ? null
          : range(r.actual_range, "start_utf8", "end_utf8");
      if (
        actual_range === null
          ? r.text !== "" ||
            evidence.length !== 0 ||
            r.truncated !== false ||
            r.continuation !== null ||
            selector.kind !== "resource-context" ||
            related_resources.length !== 1 ||
            related_resources[0]?.resource_id !== selector.resource_id ||
            !parsedGaps.includes("resource-context-unavailable")
          : // Translated text is rebuilt from the range; only original text matches it byte for byte.
            !translated &&
            actual_range.end_utf8 - actual_range.start_utf8 !==
              encoder.encode(r.text).length
      )
        fail();
      if (
        translated &&
        (typeof r.machine_translation !== "boolean" ||
          !isTranslationLanguage(r.target_language) ||
          evidence.length !== 0)
      )
        fail();
      const continuation = cursor(r.continuation);
      if (
        Boolean(continuation) !== r.truncated ||
        (request.continuation !== null && continuation === request.continuation)
      )
        fail();
      if (
        located &&
        (!Array.isArray(r.locations) ||
          r.locations.length > DOCUMENT_READ_MAX_EVIDENCE)
      )
        fail();
      const locations = located
        ? (r.locations as unknown[]).map((v) =>
            parseDocumentSegmentLocationForVersion(
              v,
              r.text_level === "draft" ? 3 : 2,
            ),
          )
        : null;
      return Object.freeze({
        ...levelFields(r),
        document,
        ...(locations ? { locations } : {}),
        selector,
        actual_range,
        text: r.text,
        evidence,
        related_resources,
        truncated: r.truncated,
        continuation,
        capabilities: capabilities(r.capabilities),
        gaps: parsedGaps,
        ...(translated
          ? {
              machine_translation: r.machine_translation as boolean,
              target_language: r.target_language as TranslationLanguage,
              untranslated_units: nonnegative(r.untranslated_units),
            }
          : {}),
      });
    }
    case "resource": {
      const r = object(value, [
        "document",
        "resource",
        "bytes_base64",
        "actual_range",
        "truncated",
        "continuation",
        "gap",
        ...levelKeys(value),
      ]);
      const request = req as DocumentReadRequestMap["resource"];
      const document = parseDocumentReadingRef(r.document);
      matchDocument(document, request);
      const resource = parseDocumentResource(r.resource);
      if (
        resource.resource_id !== request.resource_id ||
        typeof r.truncated !== "boolean"
      )
        fail();
      if (r.gap === "resource-media-unsupported") {
        if (
          r.bytes_base64 !== null ||
          r.actual_range !== null ||
          r.truncated ||
          r.continuation !== null
        )
          fail();
        return Object.freeze({
          ...levelFields(r),
          document,
          resource,
          bytes_base64: null,
          actual_range: null,
          truncated: false,
          continuation: null,
          gap: r.gap,
        });
      }
      if (
        r.gap !== null ||
        typeof r.bytes_base64 !== "string" ||
        r.bytes_base64.length > Math.ceil(DOCUMENT_READ_MAX_BYTES / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          r.bytes_base64,
        )
      )
        fail();
      const bytes = Uint8Array.from(atob(r.bytes_base64), (c) =>
        c.charCodeAt(0),
      );
      const actual_range = range(r.actual_range, "start_byte", "end_byte");
      if (
        bytes.length > request.max_bytes ||
        bytes.length !== actual_range.end_byte - actual_range.start_byte ||
        actual_range.end_byte > resource.artifact.byte_size ||
        (request.continuation === null && actual_range.start_byte !== 0)
      )
        fail();
      const continuation = cursor(r.continuation);
      if (
        r.truncated !== actual_range.end_byte < resource.artifact.byte_size ||
        Boolean(continuation) !== r.truncated ||
        (request.continuation !== null && continuation === request.continuation)
      )
        fail();
      return Object.freeze({
        ...levelFields(r),
        document,
        resource,
        bytes_base64: r.bytes_base64,
        actual_range,
        truncated: r.truncated,
        continuation,
        gap: null,
      });
    }
    case "material": {
      const r = object(value, ["evidence", "granularity", "gaps"]);
      const evidence = parseEvidenceRef(r.evidence);
      const request = req as DocumentReadRequestMap["material"];
      if (
        evidence.target_kind !== "material" ||
        evidence.material.literature_id !== request.literature_id ||
        evidence.material.asset_id !== request.asset_id ||
        r.granularity !== "file"
      )
        fail();
      return Object.freeze({
        evidence,
        granularity: "file" as const,
        gaps: gaps(r.gaps),
      });
    }
    case "evidence": {
      const r =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : fail();
      const request = req as DocumentReadRequestMap["evidence"];
      if (request.evidence.target_kind === "material") {
        const m = object(r, ["evidence", "material", "granularity", "gaps"]);
        const evidence = parseEvidenceRef(m.evidence);
        const material = parseDocumentMaterialRef(m.material);
        if (
          JSON.stringify(evidence) !== JSON.stringify(request.evidence) ||
          evidence.target_kind !== "material" ||
          JSON.stringify(material) !== JSON.stringify(evidence.material) ||
          m.granularity !== "file"
        )
          fail();
        return Object.freeze({
          evidence,
          material,
          granularity: "file" as const,
          gaps: gaps(m.gaps),
        });
      }
      const located = Object.hasOwn(r, "location");
      const d = object(r, [
        "evidence",
        "document",
        "granularity",
        "target_range",
        "actual_range",
        "text",
        "content_sha256",
        "truncated",
        "continuation",
        "gaps",
        ...(located ? ["location"] : []),
        ...levelKeys(r),
      ]);
      const evidence = parseEvidenceRef(d.evidence);
      const document = parseDocumentReadingRef(d.document);
      if (
        JSON.stringify(evidence) !== JSON.stringify(request.evidence) ||
        evidence.target_kind !== "document" ||
        d.granularity !== "segment" ||
        document.document_version_id !== evidence.document_version_id ||
        document.representation_sha256 !== evidence.representation_sha256 ||
        typeof d.text !== "string" ||
        encoder.encode(d.text).length > request.max_bytes ||
        typeof d.truncated !== "boolean" ||
        hash(d.content_sha256) !== (evidence.content_sha256 ?? d.content_sha256)
      )
        fail();
      const target_range = range(d.target_range, "start_utf8", "end_utf8");
      const actual_range = range(d.actual_range, "start_utf8", "end_utf8");
      if (
        actual_range.start_utf8 < target_range.start_utf8 ||
        actual_range.end_utf8 > target_range.end_utf8 ||
        actual_range.end_utf8 - actual_range.start_utf8 !==
          encoder.encode(d.text).length ||
        (request.continuation === null &&
          actual_range.start_utf8 !== target_range.start_utf8)
      )
        fail();
      const continuation = cursor(d.continuation);
      if (
        d.truncated !== actual_range.end_utf8 < target_range.end_utf8 ||
        Boolean(continuation) !== d.truncated ||
        (request.continuation !== null && continuation === request.continuation)
      )
        fail();
      return Object.freeze({
        ...levelFields(d),
        evidence,
        document,
        granularity: "segment" as const,
        ...(located
          ? {
              location: parseDocumentSegmentLocationForVersion(
                d.location,
                d.text_level === "draft" ? 3 : 2,
              ),
            }
          : {}),
        target_range,
        actual_range,
        text: d.text,
        content_sha256: d.content_sha256,
        truncated: d.truncated,
        continuation,
        gaps: gaps(d.gaps),
      });
    }
  }
}

/** Stored translation by unit (ADR 0068, spec 9.6), a dedicated read like draft differences. */
export interface DocumentTranslationRequest {
  readonly document_version_id: string;
  readonly section_id: string | null;
  readonly limit: number;
  readonly cursor: string | null;
}
export interface DocumentTranslationResult {
  readonly text_level?: TextLevel;
  readonly document: DocumentReadingRef;
  readonly machine_translation: true;
  readonly target_language: TranslationLanguage;
  readonly state: DocumentTranslationState;
  readonly units: readonly {
    readonly unit_id: string;
    readonly segment_ids: readonly string[];
    readonly translation: string | null;
  }[];
  readonly total: number;
  readonly next_cursor: string | null;
}
export function parseDocumentTranslationRequest(
  value: unknown,
): DocumentTranslationRequest {
  const r = object(value, [
    "document_version_id",
    "section_id",
    "limit",
    "cursor",
  ]);
  return Object.freeze({
    document_version_id: uuid(r.document_version_id),
    section_id: r.section_id === null ? null : token(r.section_id),
    limit: count(r.limit, DOCUMENT_READ_MAX_ITEMS),
    cursor: cursor(r.cursor),
  });
}
export function parseDocumentTranslationResult(
  value: unknown,
  request: DocumentTranslationRequest,
): DocumentTranslationResult {
  const r = object(value, [
    "document",
    "machine_translation",
    "target_language",
    "state",
    "units",
    "total",
    "next_cursor",
    ...levelKeys(value),
  ]);

  const document = parseDocumentReadingRef(r.document);
  matchDocument(document, request);
  if (
    r.machine_translation !== true ||
    !isTranslationLanguage(r.target_language) ||
    !TRANSLATION_STATES.includes(r.state as DocumentTranslationState) ||
    !Array.isArray(r.units) ||
    r.units.length > request.limit ||
    (["none", "stale"].includes(String(r.state)) && r.units.length)
  )
    fail();
  const units = r.units.map((item) => {
    const u = object(item, ["unit_id", "segment_ids", "translation"]);
    if (
      !Array.isArray(u.segment_ids) ||
      !u.segment_ids.length ||
      u.segment_ids.length > 10_000 ||
      (u.translation !== null && typeof u.translation !== "string")
    )
      fail();
    const ids = u.segment_ids.map(token);
    if (token(u.unit_id) !== ids[0]) fail();
    return Object.freeze({
      unit_id: ids[0]!,
      segment_ids: Object.freeze(ids),
      translation: u.translation as string | null,
    });
  });
  const total = nonnegative(r.total);
  if (total < units.length) fail();
  const next = cursor(r.next_cursor);
  matchPage(request, { next_cursor: next });
  return Object.freeze({
    ...levelFields(r),
    document,
    machine_translation: true as const,
    target_language: r.target_language,
    state: r.state as DocumentTranslationState,
    units: Object.freeze(units),
    total,
    next_cursor: next,
  });
}
const TRANSLATION_STATES: readonly DocumentTranslationState[] = [
  "none",
  "stale",
  "complete",
  "partial",
  "same-language",
];
function translationSummary(
  value: unknown,
  draft: boolean,
): DocumentTranslationSummary {
  const r = object(value, ["target_language", "state", "units", "translated"]);
  if (
    !isTranslationLanguage(r.target_language) ||
    !TRANSLATION_STATES.includes(r.state as DocumentTranslationState) ||
    (draft && r.state !== "none")
  )
    fail();
  const units = nonnegative(r.units),
    translated = nonnegative(r.translated);
  if (translated > units) fail();
  return Object.freeze({
    target_language: r.target_language,
    state: r.state as DocumentTranslationState,
    units,
    translated,
  });
}
/** Truncate only the read projection; the published structure hash is unchanged. */
export function documentReadTitle(title: string | null): {
  readonly title: string | null;
  readonly title_truncated: boolean;
} {
  if (title === null) return { title: null, title_truncated: false };
  const bytes = encoder.encode(title);
  if (bytes.length <= DOCUMENT_READ_MAX_TITLE_BYTES)
    return { title, title_truncated: false };
  let end = DOCUMENT_READ_MAX_TITLE_BYTES;
  while (end > 0) {
    try {
      return {
        title: decoder.decode(bytes.subarray(0, end)),
        title_truncated: true,
      };
    } catch {
      end--;
    }
  }
  return { title: "", title_truncated: true };
}

export interface DocumentDraftDifferencesRequest {
  readonly document_version_id: string;
  readonly segment_id: string;
  readonly max_bytes: number;
  readonly continuation: string | null;
}

export interface DocumentDraftDifferencesResult {
  readonly document: DocumentReadingRef;
  readonly segment_id: string;
  readonly location: DocumentSegmentLocation;
  readonly text_level: "draft";
  readonly basis: DraftBasis;
  readonly encoding: "json-utf8";
  readonly text: string;
  readonly actual_range: {
    readonly start_utf8: number;
    readonly end_utf8: number;
  };
  readonly total_bytes: number;
  readonly continuation: string | null;
}

/** Dedicated audit contract, like corrections; ordinary Web read operations stay closed. */
export function parseDocumentDraftDifferencesRequest(
  value: unknown,
): DocumentDraftDifferencesRequest {
  const r = object(value, [
    "document_version_id",
    "segment_id",
    "max_bytes",
    "continuation",
  ]);
  return Object.freeze({
    document_version_id: uuid(r.document_version_id),
    segment_id: token(r.segment_id),
    max_bytes: count(r.max_bytes, DOCUMENT_READ_MAX_BYTES),
    continuation: cursor(r.continuation),
  });
}
export function parseDocumentDraftDifferencesResult(
  value: unknown,
  request: DocumentDraftDifferencesRequest,
): DocumentDraftDifferencesResult {
  const r = object(value, [
    "document",
    "segment_id",
    "location",
    "text_level",
    "basis",
    "encoding",
    "text",
    "actual_range",
    "total_bytes",
    "continuation",
  ]);
  const expected = request;
  const document = parseDocumentReadingRef(r.document);
  matchDocument(document, expected);
  const location = parseDocumentSegmentLocationForVersion(r.location, 3);
  const actual_range = range(r.actual_range, "start_utf8", "end_utf8");
  const total_bytes = count(r.total_bytes, 16 * 1024 * 1024);
  const continuation = cursor(r.continuation);
  if (
    r.text_level !== "draft" ||
    r.segment_id !== expected.segment_id ||
    location.block_id !== r.segment_id ||
    r.encoding !== "json-utf8" ||
    r.basis !== location.basis ||
    !DRAFT_BASES.includes(r.basis as DraftBasis) ||
    typeof r.text !== "string" ||
    encoder.encode(r.text).length > expected.max_bytes ||
    encoder.encode(r.text).length !==
      actual_range.end_utf8 - actual_range.start_utf8 ||
    actual_range.end_utf8 > total_bytes ||
    (expected.continuation === null && actual_range.start_utf8 !== 0) ||
    Boolean(continuation) !== actual_range.end_utf8 < total_bytes ||
    (expected.continuation !== null && continuation === expected.continuation)
  )
    fail();
  return Object.freeze({
    document,
    segment_id: token(r.segment_id),
    location,
    text_level: "draft",
    basis: r.basis as DraftBasis,
    encoding: "json-utf8",
    text: r.text,
    actual_range,
    total_bytes,
    continuation,
  });
}
