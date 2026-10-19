import {
  parseAssetId,
  parseLiteratureId,
  parseDocumentSelector,
  parseSynthesisReadSelection,
  type MaterialContextReference,
  type GeneratedKnowledgeContextItem,
} from "@sciretriever/contracts";

export type FixedDocumentSource = Extract<
  MaterialContextReference,
  { kind: "document" }
>;
export type FixedSource =
  | MaterialContextReference
  | GeneratedKnowledgeContextItem["reference"];

// Scalar URL values identify the saved source; text and result bundles remain in UI memory.
export const sourceParameterKeys = [
  "source",
  "document",
  "knowledge",
  "artifact",
  "task",
  "from",
  "asset",
  "assetHash",
  "representation",
  "start",
  "end",
  "contentHash",
  "manifest",
  "statement",
  "statementHash",
  "metadataHash",
  "metadataRevision",
  "result",
  "resultHash",
  "collection",
] as const;

export function sourceParameters(source: FixedSource): Record<string, string> {
  if (source.kind === "document")
    return {
      source: source.kind,
      document: source.document_version_id,
      asset: source.asset_id,
      assetHash: source.asset_sha256,
      representation: source.representation_sha256,
      start: String(source.start_utf8),
      end: String(source.end_utf8),
    };
  if (source.kind === "knowledge")
    return {
      source: source.kind,
      knowledge: source.artifact_id,
      contentHash: source.content_sha256,
      manifest: source.manifest_sha256,
      statement: source.statement_id,
      statementHash: source.statement_sha256,
    };
  return {
    source: source.kind,
    metadataHash: source.metadata_sha256,
    metadataRevision: String(source.metadata_revision),
  };
}

export function readFixedSource(
  parameters: URLSearchParams,
): FixedSource | null {
  const get = (key: string) => {
    const value = parameters.get(key);
    if (!value || parameters.getAll(key).length !== 1)
      throw new Error("固定来源引用不完整");
    return value;
  };
  const hash = (key: string) => {
    const value = get(key);
    if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("固定来源 hash 无效");
    return value;
  };
  const integer = (key: string) => {
    const raw = get(key),
      value = Number(raw);
    if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value))
      throw new Error("固定来源范围无效");
    return value;
  };
  switch (parameters.get("source")) {
    case null:
      return null; // Supported historical document/artifact links.
    case "document": {
      const range = parseDocumentSelector({
        kind: "range",
        start_utf8: integer("start"),
        end_utf8: integer("end"),
      });
      if (range.kind !== "range") throw new Error("固定来源范围无效");
      return {
        kind: "document",
        literature_id: parseLiteratureId(get("literature")),
        document_version_id: parseAssetId(get("document")),
        representation_sha256: hash("representation"),
        asset_id: parseAssetId(get("asset")),
        asset_sha256: hash("assetHash"),
        start_utf8: range.start_utf8,
        end_utf8: range.end_utf8,
      };
    }
    case "knowledge":
      return {
        kind: "knowledge",
        artifact_id: parseSynthesisReadSelection({
          artifact_id: get("knowledge"),
        }).artifact_id,
        content_sha256: hash("contentHash"),
        manifest_sha256: hash("manifest"),
        statement_id: get("statement"),
        statement_sha256: hash("statementHash"),
      };
    case "metadata": {
      const revision = integer("metadataRevision");
      if (revision < 1) throw new Error("元数据版本无效");
      return {
        kind: "metadata",
        literature_id: parseLiteratureId(get("literature")),
        metadata_revision: revision,
        metadata_sha256: hash("metadataHash"),
      };
    }
    default:
      throw new Error("未知固定来源类型");
  }
}
