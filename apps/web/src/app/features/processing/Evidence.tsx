import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  parseSynthesisReadSelection,
  parseSynthesisSourceResult,
  knowledgeStatementSha256,
  synthesisStatementSha256,
  processorJson,
  type EvidenceRef,
  type ProcessorCitation,
  type SynthesisArtifact,
  type SynthesisEvidence,
} from "@sciretriever/contracts";
import {
  Button,
  ErrorNotice,
  Skeleton,
  TechDetails,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import {
  readProcessorResult,
  resolveProcessorEvidence,
} from "../../data/processor-results.js";
import { sourceParameters } from "../../data/sources.js";
import { useShell } from "../../shell/context.js";
import { processingError } from "./form.js";
import { display } from "./result-shape.js";
import {
  readEvidencePage,
  nextEvidencePage,
  type EvidencePageCursor,
} from "../../../reading/transport.js";

/** Preserve synthesis bindings outside the narrower processor citation contract. */
export type EvidenceCitation =
  | Exclude<ProcessorCitation, { kind: "knowledge" }>
  | (Extract<ProcessorCitation, { kind: "knowledge" }> & {
      readonly fixed?: {
        readonly manifest_sha256: string;
        readonly statement_sha256: string;
      };
    });

export function synthesisEvidenceCitation(
  artifact: SynthesisArtifact,
  source: SynthesisEvidence,
): EvidenceCitation {
  if (source.target_kind === "document")
    return { kind: "document", evidence: source.evidence };
  const input = artifact.input.items.find(
    (item) => item.input_id === source.input_id,
  );
  if (
    input?.kind !== "knowledge" ||
    !input.source_manifest_sha256 ||
    input.source_artifact_id !== source.source_artifact_id ||
    input.source_content_sha256 !== source.source_content_sha256
  )
    throw new Error("来源内容或固定清单不匹配。");
  return {
    kind: "knowledge",
    artifact_id: source.source_artifact_id,
    content_sha256: source.source_content_sha256,
    statement_id: source.statement_id,
    fixed: {
      manifest_sha256: input.source_manifest_sha256,
      statement_sha256: source.statement_sha256,
    },
  };
}

export function ResultEvidence({
  citation,
  onFollow,
  returnParameters,
}: {
  citation: EvidenceCitation;
  onFollow: (next: EvidenceCitation) => void;
  returnParameters: Record<string, string>;
}) {
  const api = useApi();
  const data = useQuery({
    queryKey: ["processors", "evidence", citation],
    queryFn: async ({ signal }) => {
      const upstream: EvidenceCitation[] = [];
      let missing = "";
      if (citation.kind === "document")
        return {
          value: null,
          evidence: [citation.evidence],
          upstream,
          missing,
          sourceOnly: false,
        };
      if (citation.kind === "knowledge") {
        const request = parseSynthesisReadSelection({
          artifact_id: citation.artifact_id,
        });
        const source = await parseSynthesisSourceResult(
          (await api.query("synthesis-source", request, signal)).result,
          request,
        );
        const artifact = source.artifact;
        if (
          artifact.content_ref.sha256 !== citation.content_sha256 ||
          (citation.fixed &&
            artifact.input.manifest_sha256 !== citation.fixed.manifest_sha256)
        )
          throw new Error("来源内容或固定清单不匹配。");
        const statement = artifact.content.statements.find(
          (item) => item.statement_id === citation.statement_id,
        );
        if (!statement) throw new Error("上游知识断言不存在。");
        if (
          citation.fixed &&
          (await (artifact.schema_version === 1
            ? knowledgeStatementSha256(statement)
            : synthesisStatementSha256(statement))) !==
            citation.fixed.statement_sha256
        )
          throw new Error("来源断言内容不匹配。");
        const evidence: EvidenceRef[] = [];
        for (const entry of statement.evidence) {
          if ("schema_version" in entry) evidence.push(entry);
          else if (entry.target_kind === "document")
            evidence.push(entry.evidence);
          else if (artifact.schema_version === 2)
            upstream.push(synthesisEvidenceCitation(artifact, entry));
        }
        return {
          value: statement.text,
          evidence,
          upstream,
          missing,
          sourceOnly: source.state === "source-only",
        };
      }
      const resolved = await resolveProcessorEvidence(api, citation, signal);
      if (citation.kind === "result") {
        const saved = await readProcessorResult(api, citation, signal),
          content = saved.result.content;
        if (content.kind === "records") {
          const row = content.records.find(
            (item) => item.record_id === citation.record_id,
          );
          if (!row) throw new Error("固定原记录不存在。");
          upstream.push(
            ...row.evidence
              .filter(
                (item) =>
                  !citation.pointer ||
                  !item.pointer ||
                  citation.pointer === item.pointer ||
                  citation.pointer.startsWith(`${item.pointer}/`),
              )
              .flatMap((item) => item.sources)
              .filter((item) => item.kind !== "document"),
          );
          missing =
            row.missing[citation.pointer] ??
            row.missing[citation.pointer.slice(1)] ??
            "";
        } else if (content.kind === "text")
          upstream.push(
            ...content.evidence.filter((item) => item.kind !== "document"),
          );
        else
          upstream.push({
            kind: "knowledge",
            artifact_id: content.artifact_id,
            content_sha256: content.content_sha256,
            statement_id: citation.record_id,
          });
      }
      return { ...resolved, upstream, missing, sourceOnly: false };
    },
  });
  if (data.isPending) return <Skeleton label="正在核验固定来源" />;
  if (data.isError)
    return (
      <ErrorNotice
        message={processingError(data.error)}
        retained="固定来源未被替换。"
        onRetry={() => data.refetch().then(() => {})}
      />
    );
  return (
    <>
      {citation.kind !== "document" ? (
        <p>
          {data.data.value == null
            ? "无法判断 / 未报告。空值不表示否或零。"
            : typeof data.data.value === "string"
              ? data.data.value
              : display(processorJson(data.data.value, 8 * 1024 * 1024))}
        </p>
      ) : null}
      {data.data.sourceOnly ? (
        <p className="ui-description">仅已存来源可核对，原 PDF 未复核。</p>
      ) : null}
      {data.data.missing ? (
        <p className="ui-description">{data.data.missing}</p>
      ) : null}
      {data.data.upstream.map((source, index) => (
        <Button key={index} variant="text" onPress={() => onFollow(source)}>
          核对{source.kind === "result" ? "上游记录" : "知识断言"} {index + 1}
        </Button>
      ))}
      {data.data.evidence.length ? (
        data.data.evidence.map((evidence, index) => (
          <Passage
            key={JSON.stringify(evidence)}
            evidence={evidence}
            index={index}
            returnParameters={returnParameters}
          />
        ))
      ) : (
        <p>该字段没有可定位的原文依据，不能从缺少证据推断否定结论。</p>
      )}
      <TechDetails copyText={JSON.stringify(citation, null, 2)}>
        <pre>{JSON.stringify(citation, null, 2)}</pre>
      </TechDetails>
    </>
  );
}
function Passage({
  evidence,
  index,
  returnParameters,
}: {
  evidence: EvidenceRef;
  index: number;
  returnParameters: Record<string, string>;
}) {
  const api = useApi(),
    shell = useShell();
  const data = useInfiniteQuery({
    queryKey: ["document", "result-passage", evidence],
    initialPageParam: {
      continuation: null,
      expectedStart: null,
    } as EvidencePageCursor,
    retry: false,
    queryFn: ({ pageParam, signal }) =>
      readEvidencePage(
        { api, signal, root: document.body, refresh: () => {} },
        evidence,
        pageParam,
      ),
    getNextPageParam: nextEvidencePage,
  });
  const first = data.data?.pages[0];
  return (
    <section className="result-passage">
      <h3>原文证据 {index + 1}</h3>
      {data.isPending ? <Skeleton rows={1} /> : null}
      {data.isError ? (
        <ErrorNotice
          message={processingError(data.error)}
          retained="已读取证据保留；固定来源没有替换。"
          onRetry={() =>
            (data.hasNextPage ? data.fetchNextPage() : data.refetch()).then(
              () => {},
            )
          }
        />
      ) : null}
      {first?.granularity === "file" ? (
        <>
          <p>证据指向原始文件，没有正文片段定位。</p>
          {first.material ? (
            <Button
              onPress={() =>
                shell.openPaper(first.material!.literature_id, "pdf", {
                  ...returnParameters,
                  from: returnParameters.from ?? "ext",
                  asset: first.material!.asset_id,
                  assetHash: first.material!.asset_sha256,
                })
              }
            >
              打开固定原始 PDF
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <blockquote>
            {data.data?.pages.map((page) => page.text ?? "").join("")}
          </blockquote>
          {first ? (
            <p className="ui-description">
              {data.hasNextPage ? "已读取部分证据。" : "已读取完整证据。"}
            </p>
          ) : null}
          {data.hasNextPage ? (
            <Button
              isPending={data.isFetchingNextPage}
              onPress={() => data.fetchNextPage().then(() => {})}
            >
              继续读取证据
            </Button>
          ) : null}
          {first?.document && first.target_range ? (
            <Button
              onPress={() => {
                const document = first.document!,
                  material = document.source_material_ref;
                shell.openPaper(material.literature_id, "doc", {
                  ...returnParameters,
                  from: returnParameters.from ?? "ext",
                  ...sourceParameters({
                    kind: "document",
                    literature_id: material.literature_id,
                    asset_id: material.asset_id,
                    asset_sha256: material.asset_sha256,
                    document_version_id: document.document_version_id,
                    representation_sha256: document.representation_sha256,
                    ...first.target_range!,
                  }),
                });
              }}
            >
              打开这段原文
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
