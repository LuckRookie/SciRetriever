import {
  knowledgeStatementSha256,
  parseKnowledgeListResult,
  parseKnowledgeListSelection,
  parseKnowledgeReadResult,
  parseKnowledgeReadSelection,
  type KnowledgeArtifact,
  type KnowledgeStatement,
} from "@sciretriever/contracts";
import type { ApiClient } from "../../data/api.js";
import type { FixedSource } from "../../../reading/source.js";

export const summaryGroups: readonly {
  id: KnowledgeStatement["category"];
  label: string;
}[] = [
  { id: "finding", label: "主要发现" },
  { id: "method", label: "方法与条件" },
  { id: "result", label: "结果数值" },
  { id: "limitation", label: "局限与资料缺口" },
  { id: "disagreement", label: "分歧与不一致" },
];
export function groupedStatements(
  artifact: KnowledgeArtifact,
  source: FixedSource | null,
) {
  return summaryGroups
    .map((group) => ({
      ...group,
      statements: artifact.content.statements.filter(
        (statement) =>
          statement.category === group.id &&
          (source?.kind !== "knowledge" ||
            statement.statement_id === source.statement_id),
      ),
    }))
    .filter((group) => group.statements.length);
}
export async function loadSummaries(
  api: ApiClient,
  id: string,
  artifactId: string | null,
  source: FixedSource | null,
  signal: AbortSignal,
): Promise<readonly KnowledgeArtifact[]> {
  let artifacts: readonly KnowledgeArtifact[];
  if (artifactId) {
    const request = parseKnowledgeReadSelection({ artifact_id: artifactId });
    artifacts = [
      await parseKnowledgeReadResult(
        (await api.query("knowledge-read", request, signal)).result,
        request,
      ),
    ];
  } else {
    const request = parseKnowledgeListSelection({
      literature_id: id,
      limit: 20,
    });
    artifacts = await parseKnowledgeListResult(
      (await api.query("knowledge-list", request, signal)).result,
      request,
    );
  }
  for (const artifact of artifacts) {
    if (!artifact.input.items.some((input) => input.literature_id === id))
      throw new Error("总结不属于当前文献，未替换为其他结果。");
    if (source?.kind === "knowledge") {
      const statement = artifact.content.statements.find(
        (statement) => statement.statement_id === source.statement_id,
      );
      if (
        artifact.artifact_id !== source.artifact_id ||
        artifact.content_ref.sha256 !== source.content_sha256 ||
        artifact.input.manifest_sha256 !== source.manifest_sha256 ||
        !statement ||
        (await knowledgeStatementSha256(statement)) !== source.statement_sha256
      )
        throw new Error("固定总结或断言与来源不匹配，请返回来源重新打开。");
    }
  }
  signal.throwIfAborted();
  return artifacts;
}
