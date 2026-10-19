import {
  parseAssetId,
  parseLiteratureId,
  parseDocumentSelector,
  parseSynthesisReadSelection,
  parseSynthesisSourceResult,
  knowledgeStatementSha256,
  synthesisStatementSha256,
  type KnowledgeContextItem,
  type MaterialContextReference,
  type GeneratedKnowledgeContextItem,
} from "@sciretriever/contracts";
import { renderKnowledgeArtifact } from "../knowledge.js";
import { renderSynthesisSource } from "../synthesis.js";
import type { AppContext } from "./types.js";

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

export function openContextSource(
  ctx: AppContext,
  item: KnowledgeContextItem,
): void {
  const parameters = { ...sourceParameters(item.reference), from: "ask" };
  if (item.kind === "generated-knowledge" && item.purpose === "synthesis") {
    ctx.navigate("syn", {
      ...parameters,
      artifact: item.reference.artifact_id,
    });
  } else {
    const id =
      item.kind === "generated-knowledge"
        ? item.source_literature_ids[0]
        : item.literature_id;
    if (!id) throw new Error("该来源没有可打开的文献");
    ctx.openPaper(
      id,
      item.kind === "generated-knowledge" ? "know" : "doc",
      parameters,
    );
  }
}

export async function renderFixedKnowledge(
  ctx: AppContext,
  ref: GeneratedKnowledgeContextItem["reference"],
  target: HTMLElement,
  literatureId?: string,
): Promise<void> {
  const selection = parseSynthesisReadSelection({
    artifact_id: ref.artifact_id,
  });
  const source = await parseSynthesisSourceResult(
    (await ctx.api.query("synthesis-source", selection, ctx.signal)).result,
    selection,
  );
  const artifact = source.artifact;
  const statement = artifact.content.statements.find(
    (candidate) => candidate.statement_id === ref.statement_id,
  );
  if (
    artifact.content_ref.sha256 !== ref.content_sha256 ||
    artifact.input.manifest_sha256 !== ref.manifest_sha256 ||
    (literatureId &&
      (artifact.schema_version !== 1 ||
        !artifact.input.items.some(
          (item) => item.literature_id === literatureId,
        ))) ||
    !statement ||
    (await (artifact.schema_version === 1
      ? knowledgeStatementSha256(statement)
      : synthesisStatementSha256(statement))) !== ref.statement_sha256
  )
    throw new Error("固定产物或断言与检索引用不匹配");
  if (ctx.signal.aborted || !target.isConnected) return;
  if (artifact.schema_version === 1)
    renderKnowledgeArtifact(
      artifact,
      target,
      ctx.signal,
      statement.statement_id,
    );
  else
    renderSynthesisSource(artifact, statement.statement_id, target, ctx.signal);
}
