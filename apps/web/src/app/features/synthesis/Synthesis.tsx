import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  parseSynthesisListSelection,
  parseSynthesisListResult,
  parseSynthesisReadSelection,
  parseSynthesisReadResult,
  parseSynthesisPreparationRequest,
  parseSynthesisPreparationResult,
  parseKnowledgeSynthesisRequest,
  synthesisStatementSha256,
  type SynthesisPreparationResult,
} from "@sciretriever/contracts";
import {
  Badge,
  Button,
  Dialog,
  Disclosure,
  Drawer,
  EmptyState,
  ErrorNotice,
  Icon,
  IconButton,
  PageHeader,
  Select,
  Skeleton,
  TechDetails,
  TextArea,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import type { ApiClient } from "../../data/api.js";
import { navigate, useUrlState } from "../../data/url.js";
import { readFixedSource } from "../../data/sources.js";
import { scopeIds, readLiterature } from "../../data/library.js";
import { processingTask } from "../../data/operations.js";
import { useShell } from "../../shell/context.js";
import { randomId } from "../../../browser-platform.js";
import { download } from "../library/OperationDialog.js";
import {
  ResultEvidence,
  synthesisEvidenceCitation,
  type EvidenceCitation,
} from "../processing/Evidence.js";
import { processingError } from "../processing/form.js";
import "../processing/processing.css";
interface Draft {
  open: boolean;
  question: string;
  policy: string;
  prepared: SynthesisPreparationResult | null;
  scopeKey: string;
  key: string;
  fingerprint: string;
}
const drafts = new WeakMap<ApiClient, Draft>();
export default function Synthesis() {
  const api = useApi(),
    route = useUrlState(),
    shell = useShell(),
    queries = useQueryClient();
  const [draft, setDraft] = useState<Draft>(
    () =>
      drafts.get(api) ?? {
        open: false,
        question: "",
        policy: "require-all",
        prepared: null,
        scopeKey: "",
        key: randomId(),
        fingerprint: "",
      },
  );
  useEffect(() => {
    drafts.set(api, draft);
  }, [api, draft]);
  const patch = (value: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...value }));
  const selection = [...shell.selected].sort(),
    scopeKey = JSON.stringify(selection.length ? selection : route.query),
    artifactId = route.parameters.get("artifact"),
    [evidence, setEvidence] = useState<EvidenceCitation | null>(null);
  const list = useQuery({
    queryKey: ["knowledge", "syntheses"],
    queryFn: async ({ signal }) => {
      const request = parseSynthesisListSelection({
        manifest_sha256: null,
        limit: 20,
      });
      return parseSynthesisListResult(
        (await api.query("synthesis-list", request, signal)).result,
        request,
      );
    },
    enabled: !artifactId,
  });
  const current = useQuery({
    queryKey: [
      "knowledge",
      "synthesis",
      artifactId,
      route.parameters.toString(),
    ],
    enabled: !!artifactId,
    queryFn: async ({ signal }) => {
      const request = parseSynthesisReadSelection({ artifact_id: artifactId });
      const result = await parseSynthesisReadResult(
        (await api.query("synthesis-read", request, signal)).result,
        request,
      );
      const fixed = readFixedSource(route.parameters);
      if (fixed?.kind === "knowledge") {
        const statement = result.artifact.content.statements.find(
          (item) => item.statement_id === fixed.statement_id,
        );
        if (
          result.artifact.artifact_id !== fixed.artifact_id ||
          result.artifact.content_ref.sha256 !== fixed.content_sha256 ||
          result.artifact.input.manifest_sha256 !== fixed.manifest_sha256 ||
          !statement ||
          (await synthesisStatementSha256(statement)) !== fixed.statement_sha256
        )
          throw new Error("固定综合断言与检索来源不匹配。");
      }
      return result;
    },
  });
  const scope = useQuery({
    queryKey: ["synthesis", "scope", scopeKey, route.sort],
    enabled: draft.open,
    queryFn: ({ signal }) =>
      selection.length
        ? Promise.resolve(selection)
        : scopeIds(api, route.query, route.sort, signal),
    retry: false,
  });
  const preparation = useMutation({
    mutationFn: async () => {
      if (!scope.data?.length) throw new Error("当前范围没有文献。");
      const inputs = [];
      for (const [index, id] of scope.data.entries()) {
        const paper = await readLiterature(api, id),
          asset = paper.primary_pdf?.asset;
        inputs.push({
          kind: "document",
          input_id: `source-${index + 1}`,
          literature_id: id,
          asset_id: asset?.asset_id ?? null,
          asset_sha256: asset?.sha256 ?? null,
          document_version_id: null,
        });
      }
      const request = parseSynthesisPreparationRequest({
        policy: draft.policy,
        inputs,
      });
      const result = await parseSynthesisPreparationResult(
        (await api.query("synthesis-prepare", request)).result,
        request,
      );
      patch({ prepared: result, scopeKey });
      return result;
    },
  });
  const ready =
    draft.prepared?.ready &&
    draft.scopeKey === scopeKey &&
    draft.prepared.policy === draft.policy;
  const submit = useMutation({
    mutationFn: async () => {
      if (!ready || !draft.prepared)
        throw new Error("请先固定当前范围的输入。");
      const request = await parseKnowledgeSynthesisRequest({
        schema_version: 3,
        input: draft.prepared.manifest,
        purpose: "synthesis",
        question: draft.question,
        policy: draft.prepared.policy,
      });
      const fingerprint = JSON.stringify(request),
        key = draft.fingerprint === fingerprint ? draft.key : randomId();
      patch({ key, fingerprint });
      const id = await processingTask(
        {
          api,
          signal: new AbortController().signal,
          notify: shell.notify,
          onTasksChanged: () => {
            void queries.invalidateQueries({ queryKey: ["tasks"] });
          },
        },
        [{ operation: "synthesize", request }],
        key,
      );
      patch({ open: false });
      navigate({ view: "task", task: id, artifact: null });
    },
  });
  return (
    <section className="feature-page synthesis-page">
      <PageHeader
        title="综合"
        description="围绕明确范围，比较共识、分歧、条件与局限。"
        action={
          <div className="synthesis-header-actions">
            <IconButton
              aria-label="刷新综合"
              isPending={list.isFetching || current.isFetching}
              onPress={() =>
                (artifactId ? current.refetch() : list.refetch()).then(() => {})
              }
            >
              <Icon name="refresh" />
            </IconButton>
            {api.kind === "workspace" ? (
              <Button variant="primary" onPress={() => patch({ open: true })}>
                新建综合
              </Button>
            ) : null}
          </div>
        }
      />
      {artifactId ? (
        <>
          {current.isPending ? (
            <Skeleton />
          ) : current.isError ? (
            <ErrorNotice
              message={processingError(current.error)}
              onRetry={() => current.refetch().then(() => {})}
            />
          ) : (
            <>
              <div className="result-toolbar">
                <Button
                  variant="text"
                  onPress={() =>
                    navigate({
                      view:
                        route.parameters.get("from") === "ask" ? "ask" : "syn",
                      artifact: null,
                      source: null,
                      knowledge: null,
                      contentHash: null,
                      manifest: null,
                      statement: null,
                      statementHash: null,
                    })
                  }
                >
                  {route.parameters.get("from") === "ask"
                    ? "返回检索"
                    : "返回全部综合"}
                </Button>
                <Button
                  onPress={() =>
                    download(
                      new Blob([JSON.stringify(current.data, null, 2)], {
                        type: "application/json",
                      }),
                      `${artifactId}.json`,
                    )
                  }
                >
                  导出综合
                </Button>
              </div>
              <article className="synthesis-reading">
                <h2>{current.data.artifact.content.title}</h2>
                <p>{current.data.artifact.question}</p>
                <p className="ui-description">
                  实际独立支持文献{" "}
                  {current.data.independent_literature_ids.length} 篇 ·{" "}
                  {current.data.artifact.coverage.status === "complete"
                    ? "完整覆盖"
                    : "部分覆盖"}
                </p>
                <Disclosure title="覆盖与当前来源">
                  {current.data.artifact.coverage.items.map((item, index) => (
                    <p key={item.input_id}>
                      {item.input_id}：{item.status}
                      {item.reason ? ` · ${item.reason}` : ""} ·{" "}
                      {item.status === "excluded"
                        ? "本次未纳入，未查询当前可用性"
                        : current.data.current_source_states[index]?.state ===
                            "source-only"
                          ? "仅已存来源可核对，原 PDF 未复核"
                          : `当前来源：${current.data.current_source_states[index]?.state ?? "未知"}`}
                    </p>
                  ))}
                </Disclosure>
                {current.data.artifact.content.statements
                  .filter(
                    (statement) =>
                      !route.parameters.get("statement") ||
                      statement.statement_id ===
                        route.parameters.get("statement"),
                  )
                  .map((statement) => (
                    <section
                      className="synthesis-statement"
                      key={statement.statement_id}
                    >
                      <h3>
                        {(
                          {
                            consensus: "共识",
                            disagreement: "分歧",
                            "single-source": "单篇来源",
                            independent: "独立发现",
                          } as Record<string, string>
                        )[statement.relation] ?? statement.relation}
                      </h3>
                      <p>{statement.text}</p>
                      {statement.conditions.length ? (
                        <p className="ui-description">
                          条件：{statement.conditions.join("；")}
                        </p>
                      ) : null}
                      {statement.quantity ? (
                        <p>
                          {statement.quantity.value} {statement.quantity.unit}
                          {statement.quantity.comparison_basis
                            ? ` · ${statement.quantity.comparison_basis}`
                            : ""}
                        </p>
                      ) : null}
                      <div className="result-evidence-links">
                        {statement.evidence.map((source, index) => (
                          <Button
                            variant="text"
                            size="compact"
                            key={index}
                            onPress={() =>
                              setEvidence(
                                synthesisEvidenceCitation(
                                  current.data.artifact,
                                  source,
                                ),
                              )
                            }
                          >
                            证据 [{index + 1}]
                          </Button>
                        ))}
                      </div>
                    </section>
                  ))}
                <TechDetails copyText={JSON.stringify(current.data, null, 2)}>
                  <pre>
                    {JSON.stringify(
                      {
                        artifact_id: current.data.artifact.artifact_id,
                        content: current.data.artifact.content_ref,
                        input: current.data.artifact.input,
                        compression_depth:
                          current.data.artifact.compression_depth,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </TechDetails>
              </article>
            </>
          )}
        </>
      ) : list.isPending ? (
        <Skeleton />
      ) : list.isError ? (
        <ErrorNotice
          message={processingError(list.error)}
          onRetry={() => list.refetch().then(() => {})}
        />
      ) : list.data.length ? (
        <div className="synthesis-cards">
          {list.data.map(({ artifact }) => (
            <article
              className="synthesis-card"
              key={artifact.artifact_id}
              tabIndex={0}
              onKeyDown={(event) => {
                if (
                  event.target === event.currentTarget &&
                  event.key === "Enter"
                )
                  navigate({ view: "syn", artifact: artifact.artifact_id });
              }}
            >
              <h2 title={artifact.content.title}>{artifact.content.title}</h2>
              <p>{artifact.question}</p>
              <div className="synthesis-card-footer">
                <Badge
                  status={
                    artifact.coverage.status === "complete"
                      ? "completed"
                      : "partial"
                  }
                >
                  {artifact.coverage.status === "complete"
                    ? "完成"
                    : "部分完成"}{" "}
                  · {artifact.coverage.unique_literature_count} 篇
                </Badge>
                <Button
                  onPress={() =>
                    navigate({ view: "syn", artifact: artifact.artifact_id })
                  }
                >
                  打开综合
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title="尚无已发布的综合结果"
          description="先选择文献范围，再显式发起综合。"
        />
      )}
      <Dialog
        title="新建综合"
        isOpen={draft.open}
        onOpenChange={(open) => patch({ open })}
        isDismissable={!preparation.isPending && !submit.isPending}
      >
        <TextArea
          label="研究问题"
          value={draft.question}
          onChange={(question) => patch({ question })}
          isRequired
        />
        <Select
          label="缺口策略"
          value={draft.policy}
          onChange={(policy) => patch({ policy, prepared: null })}
          options={[
            { value: "require-all", label: "全部输入就绪后执行" },
            { value: "allow-partial", label: "允许部分覆盖，明确记录缺口" },
          ]}
        />
        {scope.isPending ? (
          <Skeleton rows={1} />
        ) : scope.isError ? (
          <ErrorNotice
            message="范围预读未完成，尚未提交任务。"
            retained="问题与策略草稿已保留。"
            onRetry={() => scope.refetch().then(() => {})}
          />
        ) : (
          <p>
            输入范围：{scope.data.length}{" "}
            篇文献。准备阶段固定当前文档版本，不自动获取或解析。
          </p>
        )}
        <div className="result-toolbar">
          <Button
            isPending={preparation.isPending}
            isDisabled={!scope.data?.length}
            onPress={() => preparation.mutateAsync().then(() => {})}
          >
            固定输入
          </Button>
          <Button
            variant="process"
            isDisabled={!ready}
            isPending={submit.isPending}
            confirm={{
              title: "确认集合综合",
              description:
                "使用固定输入调用已配置的分析模型，已有材料和结果保持不变。",
              scope: `${scope.data?.length ?? 0} 篇文献`,
              service: "DSH 分析模型",
            }}
            onPress={() => submit.mutateAsync().then(() => {})}
          >
            开始综合
          </Button>
        </div>
        {draft.prepared ? (
          <p role="status">
            {draft.scopeKey !== scopeKey
              ? "范围已变化，请重新固定输入。"
              : `已固定 ${draft.prepared.manifest.items.length} 项 · ${ready ? "可以综合" : "输入不足"}`}
          </p>
        ) : null}
        {draft.prepared?.gaps.length ? (
          <Disclosure title="输入缺口">
            <ul>
              {draft.prepared.gaps.map((gap, index) => (
                <li key={index}>
                  {gap.input_id}：{gap.code}
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}
        {preparation.isError ? (
          <ErrorNotice message={processingError(preparation.error)} />
        ) : null}
        {submit.isError ? (
          <ErrorNotice message={processingError(submit.error)} />
        ) : null}
      </Dialog>
      <Drawer
        title="综合证据"
        isOpen={!!evidence}
        onOpenChange={(open) => {
          if (!open) setEvidence(null);
        }}
      >
        {evidence ? (
          <ResultEvidence
            citation={evidence}
            onFollow={setEvidence}
            returnParameters={{ from: "syn", artifact: artifactId ?? "" }}
          />
        ) : null}
      </Drawer>
    </section>
  );
}
