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
export interface DocumentRepresentationInput {
  readonly source_material_ref: DocumentMaterialRef;
  readonly parser_result_sha256: Sha256;
  readonly builder_version: string;
  readonly locator_scheme: "utf8-segment-v1";
  readonly markdown: ArtifactRef;
  readonly structure: ArtifactRef;
  readonly resources: readonly DocumentResource[];
}
export interface DocumentRef extends DocumentRepresentationInput {
  readonly schema_version: 1;
  readonly document_id: string;
  readonly document_version_id: string;
  readonly representation_sha256: Sha256;
  readonly parser_provenance_id: string;
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
    };

export interface ParseDocumentRequest {
  readonly literature_id: string;
  readonly asset_id: string;
  readonly asset_sha256: Sha256;
  readonly mode: "reuse-current" | "reparse";
  readonly expected_default_revision: number | null;
}

export interface ParseDocumentReceipt {
  readonly document: DocumentRef;
  readonly parser_result_sha256: Sha256;
  /** Provenance fixed on the returned DocumentVersion. */
  readonly parser_provenance_id: string;
  readonly parser_mode: ParseDocumentRequest["mode"];
  readonly published: boolean;
  readonly default_updated: boolean;
  readonly default_revision: number | null;
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
    "parser_result_sha256",
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
    parser_result_sha256: digest(r.parser_result_sha256),
    builder_version: token(r.builder_version),
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
    "parser_result_sha256",
    "parser_provenance_id",
    "builder_version",
    "locator_scheme",
    "markdown",
    "structure",
    "resources",
  ]);
  if (r.schema_version !== 1) fail();
  const representation = parseDocumentRepresentationInput({
    source_material_ref: r.source_material_ref,
    parser_result_sha256: r.parser_result_sha256,
    builder_version: r.builder_version,
    locator_scheme: r.locator_scheme,
    markdown: r.markdown,
    structure: r.structure,
    resources: r.resources,
  });
  return Object.freeze({
    schema_version: 1,
    document_id: identifier(r.document_id),
    document_version_id: identifier(r.document_version_id),
    representation_sha256: digest(r.representation_sha256),
    parser_provenance_id: identifier(r.parser_provenance_id),
    ...representation,
  });
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
    const r = exact(value, [
      "schema_version",
      "target_kind",
      "locator_scheme",
      "document_version_id",
      "representation_sha256",
      "locator",
      "content_sha256",
    ]);
    if (r.schema_version !== 1 || r.locator_scheme !== "utf8-segment-v1")
      fail();
    const locator = exact(r.locator, ["kind", "segment_id"]);
    if (locator.kind !== "segment") fail();
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
    });
  }
  return fail();
}

export function parseDocumentRequest(value: unknown): ParseDocumentRequest {
  const r = exact(value, [
    "literature_id",
    "asset_id",
    "asset_sha256",
    "mode",
    "expected_default_revision",
  ]);
  if (r.mode !== "reuse-current" && r.mode !== "reparse") fail();
  if (
    r.expected_default_revision !== null &&
    (!Number.isSafeInteger(r.expected_default_revision) ||
      (r.expected_default_revision as number) < 1)
  )
    fail();
  return Object.freeze({
    literature_id: parseLiteratureId(r.literature_id),
    asset_id: parseAssetId(r.asset_id),
    asset_sha256: digest(r.asset_sha256),
    mode: r.mode,
    expected_default_revision: r.expected_default_revision as number | null,
  });
}

export function parseDocumentReceipt(value: unknown): ParseDocumentReceipt {
  const r = exact(value, [
    "document",
    "parser_result_sha256",
    "parser_provenance_id",
    "parser_mode",
    "published",
    "default_updated",
    "default_revision",
  ]);
  const document = parseDocumentRef(r.document);
  const parserHash = digest(r.parser_result_sha256);
  const provenanceId = identifier(r.parser_provenance_id);
  if (
    (r.parser_mode !== "reuse-current" && r.parser_mode !== "reparse") ||
    typeof r.published !== "boolean" ||
    typeof r.default_updated !== "boolean" ||
    (r.default_revision !== null &&
      (!Number.isSafeInteger(r.default_revision) ||
        (r.default_revision as number) < 1)) ||
    (r.default_updated === true && r.default_revision === null) ||
    parserHash !== document.parser_result_sha256 ||
    provenanceId !== document.parser_provenance_id
  )
    fail();
  return Object.freeze({
    document,
    parser_result_sha256: parserHash,
    parser_provenance_id: provenanceId,
    parser_mode: r.parser_mode,
    published: r.published,
    default_updated: r.default_updated,
    default_revision: r.default_revision as number | null,
  });
}
