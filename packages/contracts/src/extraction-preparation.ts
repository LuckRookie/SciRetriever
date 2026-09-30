import { ContractValidationError } from "./index.js";
import {
  extractionCanonicalJsonBytes,
  freezeExtractionJson,
  parseExtractionSpec,
  EXTRACTION_MAX_JSON_DEPTH,
  EXTRACTION_MAX_JSON_NODES,
  type ExtractionCapability,
  type ExtractionSpec,
} from "./extraction.js";
import {
  parseInputManifest,
  parseInputSelections,
  type InputManifest,
  type InputSelection,
} from "./input-manifest.js";

export interface ExtractionPreparationRequest {
  readonly spec: ExtractionSpec;
  readonly inputs: readonly InputSelection[];
}
export interface ExtractionPreparationResult {
  readonly schema_version: 1;
  readonly spec: ExtractionSpec;
  readonly manifest: InputManifest;
  readonly missing_required_capabilities: readonly {
    readonly input_id: string;
    readonly capabilities: readonly ExtractionCapability[];
  }[];
  readonly persistence: "requires-catalog-v5";
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
    Object.keys(value).sort().join("\u0000") !== [...keys].sort().join("\u0000")
  )
    fail();
  return value as Record<string, unknown>;
}
function snapshot(value: unknown, maxBytes = 256 * 1024): unknown {
  return JSON.parse(
    new TextDecoder().decode(
      extractionCanonicalJsonBytes(value, maxBytes, {
        maxDepth: EXTRACTION_MAX_JSON_DEPTH + 1,
        // Spec and manifest keep their own 8192-node limits after this snapshot.
        maxNodes: 2 * EXTRACTION_MAX_JSON_NODES + 128 * 8 + 20,
      }),
    ),
  ) as unknown;
}
export async function parseExtractionPreparationRequest(
  value: unknown,
): Promise<ExtractionPreparationRequest> {
  const r = exact(snapshot(value), ["spec", "inputs"]);
  const inputs = parseInputSelections(r.inputs);
  const spec = await parseExtractionSpec(r.spec);
  return Object.freeze({ spec, inputs });
}
export function requiredPreparationCapabilities(
  spec: ExtractionSpec,
): readonly ExtractionCapability[] {
  const capabilities = [...spec.required_capabilities];
  const granularity =
    spec.evidence_policy.field_granularity === "file"
      ? "material-file-v1"
      : "document-segment-v1";
  if (!capabilities.includes(granularity)) capabilities.push(granularity);
  return Object.freeze(capabilities);
}
export async function parseExtractionPreparationResult(
  value: unknown,
  request: ExtractionPreparationRequest,
): Promise<ExtractionPreparationResult> {
  const r = exact(snapshot(value, 384 * 1024), [
    "schema_version",
    "spec",
    "manifest",
    "missing_required_capabilities",
    "persistence",
  ]);
  if (r.schema_version !== 1 || r.persistence !== "requires-catalog-v5") fail();
  const [spec, manifest, expectedRequest] = await Promise.all([
    parseExtractionSpec(r.spec),
    parseInputManifest(r.manifest),
    parseExtractionPreparationRequest(request),
  ]);
  if (
    new TextDecoder().decode(extractionCanonicalJsonBytes(spec)) !==
    new TextDecoder().decode(extractionCanonicalJsonBytes(expectedRequest.spec))
  )
    fail();
  if (manifest.items.length !== expectedRequest.inputs.length) fail();
  for (let index = 0; index < expectedRequest.inputs.length; index++) {
    const input = expectedRequest.inputs[index]!;
    const item = manifest.items[index]!;
    if (
      item.input_id !== input.input_id ||
      item.literature_id !== input.literature_id ||
      (item.material?.asset_id ?? null) !== input.asset_id ||
      (item.material?.asset_sha256 ?? null) !== input.asset_sha256 ||
      (input.document_version_id !== null &&
        item.document?.document_version_id !== input.document_version_id)
    )
      fail();
  }
  const required = requiredPreparationCapabilities(spec);
  const expected = manifest.items
    .map((item) => ({
      input_id: item.input_id,
      capabilities: required.filter(
        (capability) => !item.capabilities.includes(capability),
      ),
    }))
    .filter((item) => item.capabilities.length > 0);
  if (
    !Array.isArray(r.missing_required_capabilities) ||
    new TextDecoder().decode(
      extractionCanonicalJsonBytes(r.missing_required_capabilities),
    ) !== new TextDecoder().decode(extractionCanonicalJsonBytes(expected))
  )
    fail();
  return freezeExtractionJson({
    schema_version: 1,
    spec,
    manifest,
    missing_required_capabilities: expected,
    persistence: "requires-catalog-v5",
  });
}
