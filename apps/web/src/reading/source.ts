import {
  parseAssetId,
  parseDocumentSelector,
  parseLiteratureId,
  type GeneratedKnowledgeContextItem,
  type MaterialContextReference,
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
  "task",
  "from",
  "asset",
  "assetHash",
  "representation",
  "start",
  "end",
  "metadataHash",
  "metadataRevision",
  "result",
  "resultHash",
  "record",
  "returnReader",
  "collection",
  "page",
  "region",
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
  if (source.kind === "result")
    return {
      source: "result",
      result: source.result_id,
      resultHash: source.content_sha256,
      ...(source.record_id ? { record: source.record_id } : {}),
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
      return null;
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
    case "result":
      return {
        kind: "result",
        result_id: String(parseAssetId(get("result"))),
        content_sha256: hash("resultHash"),
        record_id: parameters.get("record"),
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
