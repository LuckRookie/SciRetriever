import { ContractValidationError, parseAssetId, sha256 } from "./index.js";
import {
  extractionCanonicalJsonBytes,
  freezeExtractionJson,
} from "./extraction.js";
import {
  createInputManifest,
  parseInputSelections,
  type InputManifestItem,
  type InputSelection,
} from "./input-manifest.js";

export type SynthesisSelection =
  | (InputSelection & { readonly kind: "document" })
  | {
      readonly kind: "knowledge";
      readonly input_id: string;
      readonly source_artifact_id: string;
    };
export function parseSynthesisSelections(
  value: unknown,
): readonly SynthesisSelection[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) fail();
  const docs: InputSelection[] = [];
  const ordered: (
    | { kind: "document"; input_id: string }
    | SynthesisSelection
  )[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail();
    const kind = (entry as Record<string, unknown>).kind;
    if (kind === "document") {
      const r = exact(entry, [
        "kind",
        "input_id",
        "literature_id",
        "asset_id",
        "asset_sha256",
        "document_version_id",
      ]);
      const input = {
        input_id: r.input_id,
        literature_id: r.literature_id,
        asset_id: r.asset_id,
        asset_sha256: r.asset_sha256,
        document_version_id: r.document_version_id,
      } as InputSelection;
      docs.push(input);
      ordered.push({ kind: "document", input_id: inputId(r.input_id) });
    } else if (kind === "knowledge") {
      const r = exact(entry, ["kind", "input_id", "source_artifact_id"]);
      ordered.push({
        kind: "knowledge",
        input_id: inputId(r.input_id),
        source_artifact_id: String(parseAssetId(r.source_artifact_id)),
      });
    } else fail();
  }
  const normalized = docs.length ? parseInputSelections(docs) : [];
  if (new Set(ordered.map((entry) => entry.input_id)).size !== ordered.length)
    fail();
  const byId = new Map(normalized.map((entry) => [entry.input_id, entry]));
  return Object.freeze(
    ordered.map((entry) =>
      entry.kind === "knowledge"
        ? entry
        : Object.freeze({
            kind: "document" as const,
            ...byId.get(entry.input_id)!,
          }),
    ),
  );
}

export type SynthesisDocumentInput = InputManifestItem & {
  readonly kind: "document";
};
export interface SynthesisKnowledgeInput {
  readonly kind: "knowledge";
  readonly input_id: string;
  readonly source_artifact_id: string;
  readonly source_content_sha256: string | null;
  readonly source_manifest_sha256: string | null;
  readonly compression_depth: number | null;
  /** A verified source can still lack its original document evidence. */
  readonly state: "verified" | "source-only" | "missing";
}
export type SynthesisInputItem =
  | SynthesisDocumentInput
  | SynthesisKnowledgeInput;
export interface SynthesisInputManifest {
  readonly schema_version: 2;
  readonly manifest_sha256: string;
  readonly scope: "explicit-inputs-v2";
  readonly metadata_included: false;
  readonly items: readonly SynthesisInputItem[];
}

const MAX_BYTES = 256 * 1024;
const HASH_ALLOWANCE = 90;
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
function snapshot(value: unknown, bytes: number, nodes = 8192): unknown {
  return JSON.parse(
    new TextDecoder().decode(
      extractionCanonicalJsonBytes(value, bytes, {
        maxDepth: 32,
        maxNodes: nodes,
      }),
    ),
  ) as unknown;
}
function parseItems(value: unknown): readonly SynthesisInputItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) fail();
  const documents: InputManifestItem[] = [];
  const entries: (
    | SynthesisKnowledgeInput
    | { kind: "document"; input_id: string }
  )[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail();
    const kind = (entry as Record<string, unknown>).kind;
    if (kind === "document") {
      const r = exact(entry, [
        "kind",
        "input_id",
        "literature_id",
        "material",
        "document",
        "capabilities",
        "gaps",
      ]);
      const id = inputId(r.input_id);
      documents.push({
        input_id: id,
        literature_id: r.literature_id as string,
        material: r.material as InputManifestItem["material"],
        document: r.document as InputManifestItem["document"],
        capabilities: r.capabilities as InputManifestItem["capabilities"],
        gaps: r.gaps as InputManifestItem["gaps"],
      });
      entries.push({ kind: "document", input_id: id });
      continue;
    }
    if (kind !== "knowledge") fail();
    const r = exact(entry, [
      "kind",
      "input_id",
      "source_artifact_id",
      "source_content_sha256",
      "source_manifest_sha256",
      "compression_depth",
      "state",
    ]);
    const state = r.state;
    const missing = state === "missing";
    if (
      !["verified", "source-only", "missing"].includes(state as string) ||
      (r.source_content_sha256 === null) !== missing ||
      (r.source_manifest_sha256 === null) !== missing ||
      (r.compression_depth === null) !== missing ||
      (!missing &&
        (!Number.isSafeInteger(r.compression_depth) ||
          (r.compression_depth as number) < 1 ||
          (r.compression_depth as number) > 32))
    )
      fail();
    entries.push(
      Object.freeze({
        kind: "knowledge" as const,
        input_id: inputId(r.input_id),
        source_artifact_id: String(parseAssetId(r.source_artifact_id)),
        source_content_sha256: missing ? null : hash(r.source_content_sha256),
        source_manifest_sha256: missing ? null : hash(r.source_manifest_sha256),
        compression_depth: missing ? null : (r.compression_depth as number),
        state: state as SynthesisKnowledgeInput["state"],
      }),
    );
  }
  if (new Set(entries.map((item) => item.input_id)).size !== entries.length)
    fail();
  return Object.freeze(
    entries.map((entry) => {
      if (entry.kind === "knowledge") return entry;
      const item = documents.shift();
      if (!item || item.input_id !== entry.input_id) fail();
      return { kind: "document" as const, ...item };
    }),
  );
}
export async function createSynthesisInputManifest(
  items: readonly SynthesisInputItem[],
): Promise<SynthesisInputManifest> {
  const copied = snapshot(items, MAX_BYTES);
  const validated = await normalizeItems(copied);
  const core = {
    schema_version: 2 as const,
    scope: "explicit-inputs-v2" as const,
    metadata_included: false as const,
    items: validated,
  };
  const bytes = extractionCanonicalJsonBytes(core, MAX_BYTES);
  const canonical = JSON.parse(new TextDecoder().decode(bytes)) as typeof core;
  return freezeExtractionJson({
    ...canonical,
    manifest_sha256: await sha256(bytes),
  });
}
async function normalizeItems(
  value: unknown,
): Promise<readonly SynthesisInputItem[]> {
  const items = parseItems(value);
  const documents = items.filter(
    (item): item is SynthesisDocumentInput => item.kind === "document",
  );
  if (!documents.length) return items;
  const normalized = (
    await createInputManifest(
      documents.map(
        ({
          input_id,
          literature_id,
          material,
          document,
          capabilities,
          gaps,
        }) => ({
          input_id,
          literature_id,
          material,
          document,
          capabilities,
          gaps,
        }),
      ),
    )
  ).items;
  const byId = new Map(normalized.map((item) => [item.input_id, item]));
  return Object.freeze(
    items.map((item) =>
      item.kind === "knowledge"
        ? item
        : Object.freeze({
            kind: "document" as const,
            ...byId.get(item.input_id)!,
          }),
    ),
  );
}
export async function parseSynthesisInputManifest(
  value: unknown,
): Promise<SynthesisInputManifest> {
  const r = exact(snapshot(value, MAX_BYTES + HASH_ALLOWANCE, 8193), [
    "schema_version",
    "manifest_sha256",
    "scope",
    "metadata_included",
    "items",
  ]);
  if (
    r.schema_version !== 2 ||
    r.scope !== "explicit-inputs-v2" ||
    r.metadata_included !== false
  )
    fail();
  const supplied = hash(r.manifest_sha256);
  const created = await createSynthesisInputManifest(
    r.items as SynthesisInputItem[],
  );
  if (created.manifest_sha256 !== supplied) fail();
  return created;
}
