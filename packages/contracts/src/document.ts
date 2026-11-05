import {
  parsePageRegion,
  parseRawParseProfile,
  type RawParseProfile,
} from "./raw-parsing.js";
import {
  ContractValidationError,
  parseArtifactRef,
  parseAssetId,
  parseLiteratureId,
  type ArtifactRef,
  type Sha256,
} from "./index.js";

export interface DocumentMaterialRef {
  readonly literature_id: string;
  readonly asset_id: string;
  readonly asset_sha256: Sha256;
  readonly media_type: string;
  readonly byte_size: number;
  readonly artifact: ArtifactRef;
}
export interface DocumentResource {
  readonly resource_id: string;
  readonly reference: string;
  readonly relation: "image" | "table-source" | "supplement" | "other";
  readonly artifact: ArtifactRef;
}
export interface DocumentStructureV1 {
  readonly schema_version: 1;
  readonly text_encoding: "utf8";
  readonly sections: readonly {
    readonly section_id: string;
    readonly title: string;
    readonly level: number;
    readonly start_utf8: number;
    readonly end_utf8: number;
  }[];
  readonly segments: readonly {
    readonly segment_id: string;
    readonly kind: "heading" | "text" | "table" | "caption";
    readonly section_id: string | null;
    readonly start_utf8: number;
    readonly end_utf8: number;
  }[];
}
/** Corrected content is bound directly to its immutable proofread version. */
export interface ProofreadDocumentRepresentationInput {
  readonly source_material_ref: DocumentMaterialRef;
  readonly proofread_id: string;
  readonly proofread_content_sha256: Sha256;
  readonly builder_version:
    | "proofread-blocks-v1"
    | "arranged-leaves-v2"
    | "source-order-leaves-v3"
    | "source-order-leaves-v4";
  readonly locator_scheme: "utf8-segment-v1";
  readonly markdown: ArtifactRef;
  readonly structure: ArtifactRef;
  readonly resources: readonly DocumentResource[];
}
export interface ProofreadDocumentRef
  extends ProofreadDocumentRepresentationInput {
  readonly schema_version: 2;
  readonly document_id: string;
  readonly document_version_id: string;
  readonly representation_sha256: Sha256;
}
export type DocumentRepresentationInput = ProofreadDocumentRepresentationInput;
export type DocumentRef = ProofreadDocumentRef;
export type DocumentStructure =
  | DocumentStructureV1
  | import("./document-structure-v2.js").DocumentStructureV2;
export type DocumentLocator =
  | { readonly scheme: "utf8-segment-v1"; readonly segment_id: string }
  | {
      readonly scheme: "page-region-v1";
      readonly segment_id: string;
      /** Public page numbering starts at one. */ readonly page: number;
      readonly region: readonly [number, number, number, number] | null;
    };
export type PageRegionLocator = Extract<
  DocumentLocator,
  { scheme: "page-region-v1" }
>;
export function parsePageRegionLocator(value: unknown): PageRegionLocator {
  const r = exact(value, ["scheme", "segment_id", "page", "region"]);
  if (
    r.scheme !== "page-region-v1" ||
    !Number.isSafeInteger(r.page) ||
    Number(r.page) < 1
  )
    fail();
  const region = r.region === null ? null : parsePageRegion(r.region);
  return Object.freeze({
    scheme: "page-region-v1",
    segment_id: token(r.segment_id),
    page: Number(r.page),
    region,
  });
}
export type EvidenceRef =
  | {
      readonly schema_version: 1;
      readonly target_kind: "material";
      readonly locator_scheme: "material-file-v1";
      readonly material: DocumentMaterialRef;
      readonly locator: { readonly kind: "file" };
      readonly content_sha256: Sha256;
    }
  | {
      readonly schema_version: 1;
      readonly target_kind: "document";
      readonly locator_scheme: "utf8-segment-v1";
      readonly document_version_id: string;
      readonly representation_sha256: Sha256;
      readonly locator: {
        readonly kind: "segment";
        readonly segment_id: string;
      };
      readonly content_sha256: Sha256 | null;
      readonly page_region?: PageRegionLocator;
    };

/** Explicit PDF parsing. It never publishes a readable document or changes defaults. */
export interface ParseDocumentRequest {
  readonly literature_id: string;
  readonly asset_id: string;
  readonly asset_sha256: Sha256;
  readonly profiles?: readonly RawParseProfile[];
  /** Re-run selected profiles even when the fixed input and configuration match. */
  readonly force: boolean;
}
export interface ParseProfileReceipt {
  readonly profile: RawParseProfile;
  readonly status: "published" | "reused" | "failed";
  readonly raw_parse_id: string | null;
  readonly result_sha256: Sha256 | null;
  readonly failure_code: string | null;
  readonly failure_source_type: string | null;
}
export interface ParseDocumentReceipt {
  readonly literature_id: string;
  readonly asset_id: string;
  readonly asset_sha256: Sha256;
  readonly profiles: readonly ParseProfileReceipt[];
}

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
function digest(value: unknown): Sha256 {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail();
  return value as Sha256;
}
function identifier(value: unknown): string {
  return String(parseLiteratureId(value));
}
function token(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(value)
  )
    fail();
  return value;
}
function logicalReference(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024) fail();
  const normalized = value.normalize("NFC");
  if (
    normalized !== value ||
    normalized.startsWith("/") ||
    /[\\:?#]/.test(normalized) ||
    Array.from(normalized).some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    }) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail();
  return normalized;
}
function artifact(value: unknown, mediaType?: string): ArtifactRef {
  const result = parseArtifactRef(value);
  if ((mediaType && result.media_type !== mediaType) || result.byte_size < 1)
    fail();
  return result;
}
export function parseDocumentMaterialRef(value: unknown): DocumentMaterialRef {
  const r = exact(value, [
    "literature_id",
    "asset_id",
    "asset_sha256",
    "media_type",
    "byte_size",
    "artifact",
  ]);
  const parsedArtifact = artifact(r.artifact);
  const assetSha = digest(r.asset_sha256);
  if (
    r.media_type !== "application/pdf" ||
    r.byte_size !== parsedArtifact.byte_size ||
    r.media_type !== parsedArtifact.media_type ||
    assetSha !== parsedArtifact.sha256
  )
    fail();
  return Object.freeze({
    literature_id: parseLiteratureId(r.literature_id),
    asset_id: parseAssetId(r.asset_id),
    asset_sha256: assetSha,
    media_type: "application/pdf",
    byte_size: parsedArtifact.byte_size,
    artifact: parsedArtifact,
  });
}
export function parseDocumentResource(value: unknown): DocumentResource {
  const r = exact(value, ["resource_id", "reference", "relation", "artifact"]);
  if (
    !["image", "table-source", "supplement", "other"].includes(
      r.relation as string,
    )
  )
    fail();
  return Object.freeze({
    resource_id: token(r.resource_id),
    reference: logicalReference(r.reference),
    relation: r.relation as DocumentResource["relation"],
    artifact: artifact(r.artifact),
  });
}
export function parseDocumentRepresentationInput(
  value: unknown,
): DocumentRepresentationInput {
  const r = exact(value, [
    "source_material_ref",
    "proofread_id",
    "proofread_content_sha256",
    "builder_version",
    "locator_scheme",
    "markdown",
    "structure",
    "resources",
  ]);
  if (r.locator_scheme !== "utf8-segment-v1" || !Array.isArray(r.resources))
    fail();
  const resources = r.resources
    .map(parseDocumentResource)
    .sort((a, b) =>
      a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0,
    );
  if (
    new Set(resources.map((item) => item.reference)).size !==
      resources.length ||
    new Set(resources.map((item) => item.resource_id)).size !== resources.length
  )
    fail();
  return Object.freeze({
    source_material_ref: parseDocumentMaterialRef(r.source_material_ref),
    proofread_id: identifier(r.proofread_id),
    proofread_content_sha256: digest(r.proofread_content_sha256),
    builder_version:
      r.builder_version === "proofread-blocks-v1" ||
      r.builder_version === "arranged-leaves-v2" ||
      r.builder_version === "source-order-leaves-v3" ||
      r.builder_version === "source-order-leaves-v4"
        ? r.builder_version
        : fail(),
    locator_scheme: "utf8-segment-v1",
    markdown: artifact(r.markdown, "text/markdown"),
    structure: artifact(r.structure, "application/json"),
    resources: Object.freeze(resources),
  });
}
export function parseDocumentRef(value: unknown): DocumentRef {
  const r = exact(value, [
    "schema_version",
    "document_id",
    "document_version_id",
    "representation_sha256",
    "source_material_ref",
    "proofread_id",
    "proofread_content_sha256",
    "builder_version",
    "locator_scheme",
    "markdown",
    "structure",
    "resources",
  ]);
  if (r.schema_version !== 2) fail();
  const representation = parseDocumentRepresentationInput({
    source_material_ref: r.source_material_ref,
    proofread_id: r.proofread_id,
    proofread_content_sha256: r.proofread_content_sha256,
    builder_version: r.builder_version,
    locator_scheme: r.locator_scheme,
    markdown: r.markdown,
    structure: r.structure,
    resources: r.resources,
  });
  const common = {
    document_id: identifier(r.document_id),
    document_version_id: identifier(r.document_version_id),
    representation_sha256: digest(r.representation_sha256),
  };
  return Object.freeze({ schema_version: 2, ...common, ...representation });
}
export function parseEvidenceRef(value: unknown): EvidenceRef {
  const kind =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).target_kind
      : undefined;
  if (kind === "material") {
    const r = exact(value, [
      "schema_version",
      "target_kind",
      "locator_scheme",
      "material",
      "locator",
      "content_sha256",
    ]);
    const material = parseDocumentMaterialRef(r.material);
    if (r.schema_version !== 1 || r.locator_scheme !== "material-file-v1")
      fail();
    if (
      exact(r.locator, ["kind"]).kind !== "file" ||
      digest(r.content_sha256) !== material.asset_sha256
    )
      fail();
    return Object.freeze({
      schema_version: 1,
      target_kind: "material",
      locator_scheme: "material-file-v1",
      material,
      locator: Object.freeze({ kind: "file" }),
      content_sha256: material.asset_sha256,
    });
  }
  if (kind === "document") {
    const hasRegion = Object.hasOwn(value as object, "page_region");
    const r = exact(value, [
      "schema_version",
      "target_kind",
      "locator_scheme",
      "document_version_id",
      "representation_sha256",
      "locator",
      "content_sha256",
      ...(hasRegion ? ["page_region"] : []),
    ]);
    if (r.schema_version !== 1 || r.locator_scheme !== "utf8-segment-v1")
      fail();
    const locator = exact(r.locator, ["kind", "segment_id"]);
    if (locator.kind !== "segment") fail();
    const pageRegion = hasRegion ? parsePageRegionLocator(r.page_region) : null;
    if (pageRegion && pageRegion.segment_id !== locator.segment_id) fail();
    return Object.freeze({
      schema_version: 1,
      target_kind: "document",
      locator_scheme: "utf8-segment-v1",
      document_version_id: identifier(r.document_version_id),
      representation_sha256: digest(r.representation_sha256),
      locator: Object.freeze({
        kind: "segment",
        segment_id: token(locator.segment_id),
      }),
      content_sha256:
        r.content_sha256 === null ? null : digest(r.content_sha256),
      ...(pageRegion ? { page_region: pageRegion } : {}),
    });
  }
  return fail();
}

export function parseDocumentRequest(value: unknown): ParseDocumentRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).some(
      (k) =>
        ![
          "literature_id",
          "asset_id",
          "asset_sha256",
          "profiles",
          "force",
        ].includes(k),
    )
  )
    fail();
  const profiles = r.profiles === undefined ? null : r.profiles;
  if (
    profiles !== null &&
    (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 2)
  )
    fail();
  const selected =
    profiles === null
      ? null
      : (profiles as unknown[]).map(parseRawParseProfile);
  if (
    (selected !== null && new Set(selected).size !== selected.length) ||
    (r.force !== undefined && typeof r.force !== "boolean")
  )
    fail();
  return Object.freeze({
    literature_id: parseLiteratureId(r.literature_id),
    asset_id: parseAssetId(r.asset_id),
    asset_sha256: digest(r.asset_sha256),
    ...(selected === null ? {} : { profiles: Object.freeze(selected) }),
    force: r.force === true,
  });
}
export function parseDocumentReceipt(value: unknown): ParseDocumentReceipt {
  const r = exact(value, [
    "literature_id",
    "asset_id",
    "asset_sha256",
    "profiles",
  ]);
  if (
    !Array.isArray(r.profiles) ||
    r.profiles.length < 1 ||
    r.profiles.length > 2
  )
    fail();
  const profiles = r.profiles.map((value): ParseProfileReceipt => {
    const p = exact(value, [
      "profile",
      "status",
      "raw_parse_id",
      "result_sha256",
      "failure_code",
      "failure_source_type",
    ]);
    if (!["published", "reused", "failed"].includes(String(p.status))) fail();
    const failed = p.status === "failed";
    if ((p.raw_parse_id === null) !== (p.result_sha256 === null)) fail();
    if (
      !failed &&
      (p.raw_parse_id === null ||
        p.failure_code !== null ||
        p.failure_source_type !== null)
    )
      fail();
    if (
      failed &&
      (typeof p.failure_code !== "string" ||
        !/^parser-[a-z-]{1,64}$/u.test(p.failure_code))
    )
      fail();
    if (
      p.failure_source_type !== null &&
      (typeof p.failure_source_type !== "string" ||
        !/^[a-z][a-z0-9_-]{0,63}$/u.test(p.failure_source_type))
    )
      fail();
    return Object.freeze({
      profile: parseRawParseProfile(p.profile),
      status: p.status as ParseProfileReceipt["status"],
      raw_parse_id: p.raw_parse_id === null ? null : identifier(p.raw_parse_id),
      result_sha256: p.result_sha256 === null ? null : digest(p.result_sha256),
      failure_code: p.failure_code as string | null,
      failure_source_type: p.failure_source_type as string | null,
    });
  });
  if (new Set(profiles.map((p) => p.profile)).size !== profiles.length) fail();
  return Object.freeze({
    literature_id: parseLiteratureId(r.literature_id),
    asset_id: parseAssetId(r.asset_id),
    asset_sha256: digest(r.asset_sha256),
    profiles: Object.freeze(profiles),
  });
}
