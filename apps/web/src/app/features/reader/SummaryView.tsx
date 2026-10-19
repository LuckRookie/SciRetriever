import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { EvidenceRef, KnowledgeArtifact } from "@sciretriever/contracts";
import {
  Button,
  EmptyState,
  ErrorNotice,
  Popover,
  Select,
  Skeleton,
  TechDetails,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { useShell } from "../../shell/context.js";
import { useUrlState } from "../../data/url.js";
import {
  readEvidencePage,
  nextEvidencePage,
  type EvidencePageCursor,
} from "../../../reading/transport.js";
import { sourceParameters, type FixedSource } from "../../../reading/source.js";
import { readingPosition } from "../../../reading/state.js";
import { markdown } from "../../../reading/markdown.js";
import { groupedStatements, loadSummaries } from "./summary-data.js";
import { errorMessage } from "../../strings.js";
import {
  readProcessorResult,
  resultReference,
} from "../../data/processor-results.js";
import { record } from "../../data/wire.js";

export function EvidencePreview({
  evidence,
  artifact,
  index,
}: {
  evidence: EvidenceRef;
  artifact?: KnowledgeArtifact;
  index: number;
}) {
  const api = useApi(),
    shell = useShell(),
    route = useUrlState();
  const result = useInfiniteQuery({
    queryKey: ["document", "evidence", evidence],
    initialPageParam: {
      continuation: null,
      expectedStart: null,
    } as EvidencePageCursor,
    retry: false,
    queryFn: ({ signal, pageParam }) =>
      readEvidencePage(
        { api, signal, root: document.body, refresh: () => {} },
        evidence,
        pageParam,
      ),
    getNextPageParam: nextEvidencePage,
  });
  const open = () => {
    const resolved = result.data?.pages[0];
    if (!resolved) return;
    const previous = Object.fromEntries(
      [
        "knowledge",
        "contentHash",
        "manifest",
        "statement",
        "statementHash",
        "from",
        "result",
        "resultHash",
        "collection",
      ].flatMap((key) =>
        route.parameters.has(key) ? [[key, route.parameters.get(key)!]] : [],
      ),
    );
    if (
      evidence.target_kind === "document" &&
      resolved.document &&
      resolved.target_range
    ) {
      const d = resolved.document;
      shell.openPaper(d.source_material_ref.literature_id, "doc", {
        ...previous,
        ...sourceParameters({
          kind: "document",
          literature_id: d.source_material_ref.literature_id,
          asset_id: d.source_material_ref.asset_id,
          asset_sha256: d.source_material_ref.asset_sha256,
          document_version_id: d.document_version_id,
          representation_sha256: d.representation_sha256,
          start_utf8: resolved.target_range!.start_utf8,
          end_utf8: resolved.target_range!.end_utf8,
        }),
        ...(artifact
          ? { artifact: artifact.artifact_id, knowledge: artifact.artifact_id }
          : {}),
      });
    } else if (evidence.target_kind === "material") {
      shell.openPaper(evidence.material.literature_id, "pdf", {
        ...previous,
        asset: evidence.material.asset_id,
        assetHash: evidence.material.asset_sha256,
        ...(artifact
          ? { artifact: artifact.artifact_id, knowledge: artifact.artifact_id }
          : {}),
      });
    }
  };
  return (
    <div className="reader-evidence-preview">
      <h3>证据 {index}</h3>
      {result.isPending ? (
        <Skeleton label="正在核对原文" rows={2} />
      ) : result.error && !result.data ? (
        <ErrorNotice
          message={errorMessage(result.error)}
          onRetry={() => {
            void result.refetch();
          }}
        />
      ) : (
        <>
          <blockquote>
            {result.data?.pages.map((page) => page.text ?? "").join("") ||
              "这份证据来自原始材料，没有可显示的解析片段。"}
          </blockquote>
          <p className="ui-description">
            {result.data?.pages[0]?.document
              ? "定位到固定文档段落；不推测 PDF 页码。"
              : "打开同一份已核验原始材料。"}
            {result.hasNextPage ? "已读取部分证据。" : "已读取完整证据。"}
          </p>
          {result.error && (
            <ErrorNotice
              message={errorMessage(result.error)}
              retained="已读取证据保留。"
            />
          )}
          {result.hasNextPage && (
            <Button
              isPending={result.isFetchingNextPage}
              onPress={() => result.fetchNextPage().then(() => {})}
            >
              继续读取证据
            </Button>
          )}
          <Button onPress={open}>在原文中核对</Button>
        </>
      )}
    </div>
  );
}
function ArtifactSummary({
  artifact,
  source,
  search,
}: {
  artifact: KnowledgeArtifact;
  source: FixedSource | null;
  search: string;
}) {
  const shell = useShell(),
    api = useApi(),
    root = useRef<HTMLDivElement>(null);
  const id = artifact.input.items[0]?.literature_id ?? "";
  const state = readingPosition(
    shell.reading,
    [
      api.workspace.catalog,
      "knowledge",
      artifact.artifact_id,
      artifact.content_ref.sha256,
    ],
    id,
  );
  useEffect(() => {
    const scroll = root.current?.closest<HTMLElement>(".reader-summary-scroll");
    if (!scroll) return;
    scroll.scrollTop = state.scroll;
    return () => {
      state.scroll = scroll.scrollTop;
    };
  }, [state]);
  const groups = groupedStatements(artifact, source),
    gaps = artifact.coverage.capability_gaps;
  let evidenceIndex = 0;
  return (
    <div ref={root} className="reader-summary reading-article">
      <header>
        <p className="reader-eyebrow">已保存的文献分析</p>
        <h1>{artifact.content.title}</h1>
        <p className="reader-coverage">
          覆盖 {artifact.coverage.covered_segments} /{" "}
          {artifact.coverage.total_segments} 段正文 ·{" "}
          {artifact.content.statements.length} 条结论
        </p>
        <p className="ui-description">
          覆盖记录描述已读材料，不代表原 PDF 的图表和解析都完整。
          {gaps.length
            ? `资料缺口：${gaps.join("；")}`
            : "每条结论可就近核对固定原文。"}
        </p>
        {artifact.question && <p>分析问题：{artifact.question}</p>}
      </header>
      <nav className="reader-summary-jumps" aria-label="总结栏目">
        {groups.map((group) => (
          <Button
            key={group.id}
            size="compact"
            variant="text"
            onPress={() =>
              root.current
                ?.querySelector(`[data-summary-group="${group.id}"]`)
                ?.scrollIntoView({ block: "start", behavior: "instant" })
            }
          >
            {group.label}
          </Button>
        ))}
      </nav>
      {groups.map((group) => (
        <section
          className="reader-summary-group"
          data-summary-group={group.id}
          key={group.id}
        >
          <h2>{group.label}</h2>
          {group.statements.map((statement) => (
            <article
              key={statement.statement_id}
              className={`reader-statement ${search && statement.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()) ? "reading-match" : ""}`}
            >
              <div
                dangerouslySetInnerHTML={{
                  __html: markdown.parse(statement.text, { async: false }),
                }}
              />
              {statement.epistemic === "inference" && (
                <p className="reader-inference">推断 · 请结合原文证据判断</p>
              )}
              {statement.quantity && (
                <p className="reader-quantity">
                  <b>
                    {statement.quantity.value} {statement.quantity.unit}
                  </b>
                  {statement.quantity.comparison_basis
                    ? ` · 比较基准：${statement.quantity.comparison_basis}`
                    : ""}
                </p>
              )}
              {statement.conditions.length > 0 && (
                <div className="reader-conditions" aria-label="适用条件">
                  {statement.conditions.map((condition, index) => (
                    <span key={index}>{condition}</span>
                  ))}
                </div>
              )}
              <div className="reader-evidence-list" aria-label="原文证据">
                {statement.evidence.map((evidence, index) => {
                  const number = ++evidenceIndex;
                  return (
                    <Popover
                      key={index}
                      label={`证据 ${number}`}
                      trigger={<span>[{number}]</span>}
                    >
                      <EvidencePreview
                        evidence={evidence}
                        artifact={artifact}
                        index={number}
                      />
                    </Popover>
                  );
                })}
              </div>
            </article>
          ))}
        </section>
      ))}
      <TechDetails
        copyText={JSON.stringify(
          {
            ...(artifact
              ? {
                  artifact: artifact.artifact_id,
                  knowledge: artifact.artifact_id,
                }
              : {}),
            method: artifact.method,
            provenance: artifact.provenance,
            input: artifact.input.manifest_sha256,
          },
          null,
          2,
        )}
      >
        <dl>
          <dt>产物</dt>
          <dd>{artifact.artifact_id}</dd>
          <dt>生成方法</dt>
          <dd>
            {artifact.method.id} · {artifact.method.version}
          </dd>
          <dt>模型</dt>
          <dd>
            {artifact.provenance.provider} / {artifact.provenance.model}
          </dd>
          <dt>输入指纹</dt>
          <dd>{artifact.input.manifest_sha256}</dd>
          <dt>内容指纹</dt>
          <dd>{artifact.content_ref.sha256}</dd>
          <dt>生成时间</dt>
          <dd>{new Date(artifact.provenance.generated_at).toLocaleString()}</dd>
        </dl>
      </TechDetails>
    </div>
  );
}
export function SummaryView({
  id,
  source,
  search,
}: {
  id: string;
  source: FixedSource | null;
  search: string;
}) {
  const api = useApi(),
    route = useUrlState(),
    [selected, setSelected] = useState("");
  const fixed = route.parameters.get("knowledge");
  const resultId = route.parameters.get("result"),
    resultHash = route.parameters.get("resultHash");
  const query = useQuery({
    queryKey: ["knowledge", id, fixed, source, resultId, resultHash],
    queryFn: async ({ signal }) => {
      let artifactId = fixed,
        expectedHash: string | null = null;
      if (resultId && !fixed) {
        const ref = resultHash
          ? resultReference({ result_id: resultId, content_sha256: resultHash })
          : resultReference(
              record(
                (await api.processors("read", { result_id: resultId }, signal))
                  .result,
                "result",
              ).ref,
            );
        const saved = await readProcessorResult(api, ref, signal);
        if (!saved.result.literature_ids.includes(id))
          throw new Error("固定处理结果不属于当前文献。");
        if (saved.result.content.kind === "knowledge") {
          artifactId = saved.result.content.artifact_id;
          expectedHash = saved.result.content.content_sha256;
        }
      }
      const artifacts = await loadSummaries(
        api,
        id,
        artifactId,
        source,
        signal,
      );
      if (expectedHash && artifacts[0]?.content_ref.sha256 !== expectedHash)
        throw new Error("总结内容与固定处理结果不一致。");
      return artifacts;
    },
  });
  const artifact =
    query.data?.find((value) => value.artifact_id === selected) ??
    query.data?.[0];
  if (query.isPending) return <Skeleton label="正在读取已保存总结" rows={5} />;
  if (query.error)
    return (
      <ErrorNotice
        message={errorMessage(query.error)}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  if (!artifact)
    return (
      <EmptyState
        title="尚无已保存总结"
        description="阅读不会自动分析文献。可以在信息栏中显式发起分析。"
      />
    );
  return (
    <>
      {query.data && query.data.length > 1 && (
        <div className="reader-summary-select">
          <Select
            label="已保存总结"
            value={artifact.artifact_id}
            onChange={setSelected}
            options={query.data.map((value, index) => ({
              value: value.artifact_id,
              label: `${value.content.title} · ${new Date(value.provenance.generated_at).toLocaleDateString()}（${index + 1}）`,
            }))}
          />
        </div>
      )}
      <ArtifactSummary
        key={artifact.artifact_id}
        artifact={artifact}
        source={source}
        search={search}
      />
    </>
  );
}
