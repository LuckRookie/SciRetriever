import {
  ContractValidationError,
  parseAssetId,
  parseLiteratureId,
  parseDocumentMaterialRef,
  parseDocumentReadingRef,
  sha256,
  type DocumentMaterialRef,
  type DocumentReadingRef,
} from "./index.js";
import {
  extractionCanonicalJsonBytes,
  freezeExtractionJson,
  EXTRACTION_MAX_JSON_DEPTH,
  EXTRACTION_MAX_JSON_NODES,
  type ExtractionCapability,
} from "./extraction.js";

export interface InputSelection {
  readonly input_id: string;
  readonly literature_id: string;
  readonly asset_id: string | null;
  readonly asset_sha256: string | null;
  readonly document_version_id: string | null;
}
export interface InputManifestItem {
  readonly input_id: string;
  readonly literature_id: string;
  readonly material: DocumentMaterialRef | null;
  readonly document: DocumentReadingRef | null;
  readonly capabilities: readonly ExtractionCapability[];
  readonly gaps: readonly (
    | "material-missing"
    | "document-missing"
    | "document-unsupported"
  )[];
}
export interface InputManifest {
  readonly schema_version: 1;
  readonly manifest_sha256: string;
  readonly scope: "explicit-inputs-v1";
  readonly metadata_included: false;
  readonly items: readonly InputManifestItem[];
}
export const INPUT_MANIFEST_MAX_BYTES = 256 * 1024;
const MANIFEST_HASH_FIELD_MAX_BYTES = 90;
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
    Object.keys(value).sort().join("\u0000") !== [...keys].sort().join("\u0000")
  )
    fail();
  return value as Record<string, unknown>;
}
function inputId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)
  )
    fail();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail();
  return value;
}
export function parseInputSelections(
  value: unknown,
): readonly InputSelection[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) fail();
  const selections = value.map((entry) => {
    const r = exact(entry, [
      "input_id",
      "literature_id",
      "asset_id",
      "asset_sha256",
      "document_version_id",
    ]);
    if (
      (r.asset_id === null) !== (r.asset_sha256 === null) ||
      (r.asset_id === null && r.document_version_id !== null)
    )
      fail();
    return Object.freeze({
      input_id: inputId(r.input_id),
      literature_id: String(parseLiteratureId(r.literature_id)),
      asset_id: r.asset_id === null ? null : String(parseAssetId(r.asset_id)),
      asset_sha256: r.asset_sha256 === null ? null : hash(r.asset_sha256),
      document_version_id:
        r.document_version_id === null
          ? null
          : String(parseAssetId(r.document_version_id)),
    });
  });
  if (
    new Set(selections.map((item) => item.input_id)).size !== selections.length
  )
    fail();
  return Object.freeze(selections);
}
export async function createInputManifest(
  items: readonly InputManifestItem[],
): Promise<InputManifest> {
  if (!Array.isArray(items) || items.length < 1 || items.length > 128) fail();
  const validated = parseItems(items);
  const content = {
    schema_version: 1 as const,
    scope: "explicit-inputs-v1" as const,
    metadata_included: false as const,
    items: validated,
  };
  const bytes = extractionCanonicalJsonBytes(content, INPUT_MANIFEST_MAX_BYTES);
  const snapshot = JSON.parse(
    new TextDecoder().decode(bytes),
  ) as typeof content;
  const digest = await sha256(bytes);
  return freezeExtractionJson({ ...snapshot, manifest_sha256: digest });
}
export async function parseInputManifest(
  value: unknown,
): Promise<InputManifest> {
  const snapshot = JSON.parse(
    new TextDecoder().decode(
      extractionCanonicalJsonBytes(
        value,
        INPUT_MANIFEST_MAX_BYTES + MANIFEST_HASH_FIELD_MAX_BYTES,
        {
          maxDepth: EXTRACTION_MAX_JSON_DEPTH,
          maxNodes: EXTRACTION_MAX_JSON_NODES + 1,
        },
      ),
    ),
  ) as unknown;
  const r = exact(snapshot, [
    "schema_version",
    "manifest_sha256",
    "scope",
    "metadata_included",
    "items",
  ]);
  if (
    r.schema_version !== 1 ||
    r.scope !== "explicit-inputs-v1" ||
    r.metadata_included !== false ||
    !Array.isArray(r.items) ||
    r.items.length < 1 ||
    r.items.length > 128
  )
    fail();
  const suppliedHash = hash(r.manifest_sha256);
  const items = parseItems(r.items);
  const result = await createInputManifest(items);
  if (result.manifest_sha256 !== suppliedHash) fail();
  return result;
}
function parseItems(value: readonly unknown[]): readonly InputManifestItem[] {
  const items: InputManifestItem[] = value.map((entry) => {
    const item = exact(entry, [
      "input_id",
      "literature_id",
      "material",
      "document",
      "capabilities",
      "gaps",
    ]);
    const literatureId = String(parseLiteratureId(item.literature_id));
    const material =
      item.material === null ? null : parseDocumentMaterialRef(item.material);
    const document =
      item.document === null ? null : parseDocumentReadingRef(item.document);
    if (
      material?.literature_id !== undefined &&
      material.literature_id !== literatureId
    )
      fail();
    if (
      document &&
      (!material ||
        JSON.stringify(document.source_material_ref) !==
          JSON.stringify(material))
    )
      fail();
    if (
      !Array.isArray(item.capabilities) ||
      !Array.isArray(item.gaps) ||
      item.capabilities.length > 5 ||
      item.gaps.length > 3 ||
      new Set(item.capabilities).size !== item.capabilities.length ||
      new Set(item.gaps).size !== item.gaps.length ||
      item.capabilities.some(
        (capability) =>
          ![
            "material-file-v1",
            "document-segment-v1",
            "document-text-v1",
            "document-outline-v1",
            "document-resources-v1",
          ].includes(capability as string),
      ) ||
      item.gaps.some(
        (gap) =>
          ![
            "material-missing",
            "document-missing",
            "document-unsupported",
          ].includes(gap as string),
      )
    )
      fail();
    const capabilities = item.capabilities as ExtractionCapability[];
    const gaps = item.gaps as InputManifestItem["gaps"][number][];
    if (
      (material === null &&
        (document !== null ||
          capabilities.length !== 0 ||
          gaps.length !== 2 ||
          !gaps.includes("material-missing") ||
          !gaps.includes("document-missing"))) ||
      (material !== null &&
        (!capabilities.includes("material-file-v1") ||
          gaps.includes("material-missing") ||
          (document === null
            ? capabilities.length !== 1 ||
              gaps.length !== 1 ||
              (!gaps.includes("document-missing") &&
                !gaps.includes("document-unsupported"))
            : !capabilities.includes("document-segment-v1") ||
              gaps.length !== 0)))
    )
      fail();
    return Object.freeze({
      input_id: inputId(item.input_id),
      literature_id: literatureId,
      material,
      document,
      capabilities: Object.freeze([
        ...item.capabilities,
      ]) as readonly ExtractionCapability[],
      gaps: Object.freeze([...item.gaps]) as InputManifestItem["gaps"],
    });
  });
  if (new Set(items.map((item) => item.input_id)).size !== items.length) fail();
  return Object.freeze(items);
}
