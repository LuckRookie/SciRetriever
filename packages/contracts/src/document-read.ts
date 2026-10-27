import { parseSectionRole, type SectionRole } from "./section-roles.js";
import type { SectionRoleSource } from "./structure-annotation.js";
import { parsePageRegion } from "./raw-parsing.js";
import {
  PROOFREAD_SEGMENT_KINDS,
  type ProofreadSegmentKind,
} from "./document-structure-v2.js";
import type { ProofreadSource, ProofreadBasis } from "./proofread.js";
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
export const DOCUMENT_READ_MAX_EVIDENCE = 32;
export const DOCUMENT_READ_MAX_TITLE_BYTES = 512;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const digestPattern = /^[0-9a-f]{64}$/;
const tokenPattern = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;
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
      const r = object(value, [
        "document_version_id",
        "selector",
        "max_bytes",
        "continuation",
      ]);
      result = {
        document_version_id: uuid(r.document_version_id),
        selector: parseDocumentSelector(r.selector),
        max_bytes: count(r.max_bytes, DOCUMENT_READ_MAX_BYTES),
        continuation: cursor(r.continuation),
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
  readonly basis: ProofreadBasis;

  readonly locate: "region" | "page";
}
export function parseDocumentSegmentLocation(
  value: unknown,
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
  if (!["text-layer", "image-only", "manual"].includes(String(r.basis))) fail();
  return {
    block_id: token(r.block_id),
    page,
    region,
    source: r.source as ProofreadSource,
    basis: r.basis as ProofreadBasis,

    locate: r.locate as "region" | "page",
    continuation_regions: r.continuation_regions.map((v) => {
      const p = object(v, ["page", "region"]);
      return { page: count(p.page, 10000), region: parsePageRegion(p.region) };
    }),
  };
}
function section(value: unknown) {
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
    typeof r.title !== "string" ||
    encoder.encode(r.title).length > DOCUMENT_READ_MAX_TITLE_BYTES ||
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
    title: r.title,
    title_truncated: r.title_truncated,
    level: r.level as number,
    ...range(
      { start_utf8: r.start_utf8, end_utf8: r.end_utf8 },
      "start_utf8",
      "end_utf8",
    ),
  });
}
function segment(value: unknown) {
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
  if (!PROOFREAD_SEGMENT_KINDS.includes(r.kind as ProofreadSegmentKind)) fail();
  return Object.freeze({
    ...(located
      ? parseDocumentSegmentLocation({
          block_id: r.block_id,
          page: r.page,
          region: r.region,
          continuation_regions: r.continuation_regions,
          locate: r.locate,
          source: r.source,
          basis: r.basis,
        })
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
  parseItem: (value: unknown) => unknown,
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
  ]);
  if (!Array.isArray(r[field]) || r[field].length > limit) fail();
  const total = nonnegative(r.total);
  if (total < r[field].length) fail();
  const next = cursor(r.next_cursor);
  return {
    ...(annotated
      ? {
          annotation_id:
            r.annotation_id === null ? null : hash(r.annotation_id),
        }
      : {}),
    document: parseDocumentReadingRef(r.document),
    [field]: Object.freeze(r[field].map(parseItem)),
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
  readonly title: string;
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
    readonly document: DocumentReadingRef;
    readonly capabilities: DocumentReadCapabilities;
    readonly gaps: readonly DocumentReadGap[];
    readonly section_count: number;
    readonly segment_count: number;
    readonly resource_count: number;
  };
  outline: ReadPage & { readonly sections: readonly ReadSection[] };
  segments: ReadPage & { readonly segments: readonly ReadSegment[] };
  resources: ReadPage & { readonly resources: readonly DocumentResource[] };
  slice: {
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
  };
  resource: {
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
      ]);
      const document = parseDocumentReadingRef(r.document);
      matchDocument(document, req as DocumentReadRequestMap["describe"]);
      return Object.freeze({
        document,
        capabilities: capabilities(r.capabilities),
        gaps: gaps(r.gaps),
        section_count: nonnegative(r.section_count),
        segment_count: nonnegative(r.segment_count),
        resource_count: nonnegative(r.resource_count),
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
      return Object.freeze(parsed);
    }
    case "slice": {
      const located = Boolean(
        value && typeof value === "object" && "locations" in value,
      );
      const r = object(value, [
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
          : actual_range.end_utf8 - actual_range.start_utf8 !==
            encoder.encode(r.text).length
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
        ? (r.locations as unknown[]).map(parseDocumentSegmentLocation)
        : null;
      return Object.freeze({
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
        evidence,
        document,
        granularity: "segment" as const,
        ...(located
          ? { location: parseDocumentSegmentLocation(d.location) }
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

/** Truncate only the read projection; the published structure hash is unchanged. */
export function documentReadTitle(title: string): {
  readonly title: string;
  readonly title_truncated: boolean;
} {
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
