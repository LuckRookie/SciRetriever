import { useEffect, useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  parseDocumentReadResult,
  parseProcessorBatchRequest,
  parseProcessorReads,
} from "@sciretriever/contracts";
import {
  Button,
  Dialog,
  Disclosure,
  ErrorNotice,
  Radio,
  RadioGroup,
  Select,
  Skeleton,
  TextArea,
  TextField,
} from "../../components/index.js";
import { archiveQuery, rows } from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { navigate, useUrlState } from "../../data/url.js";
import { jobRecord, record } from "../../data/wire.js";
import { paperTitle, readLiterature, scopeIds } from "../../data/library.js";
import { useShell } from "../../shell/context.js";
import { localTime, processorName, sectionRoleNames } from "../../strings.js";
import { randomId } from "../../../browser-platform.js";
import {
  FormProblem,
  getDraft,
  prepareSubmission,
  processingError,
  saveDraft,
  type FormDraft,
} from "./form.js";
import { UsageEstimate } from "./UsageEstimate.js";

export type OperatorScope =
  | { kind: "selection" }
  | { kind: "query" }
  | { kind: "literatures"; ids: readonly string[] }
  | { kind: "snapshot"; id: string };
export type Operator = "summary" | "records" | "labels" | "knowledge-synthesis";
type Step = "scope" | "operator" | "spec" | "confirm";
export const OPERATORS: readonly { id: Operator; description: string }[] = [
  { id: "summary", description: "逐篇生成带证据的结构化总结。" },
  { id: "records", description: "按你定义的字段，从每篇抽取记录。" },
  { id: "labels", description: "对每篇回答同一个问题。" },
  {
    id: "knowledge-synthesis",
    description: "在一个快照的全部文献上综合回答一个问题。",
  },
];
const STEP_LABELS: Record<Step, string> = {
  scope: "范围",
  operator: "算子",
  spec: "规范",
  confirm: "确认",
};

/**
 * The single entry for running an operator: scope → operator → specification
 * → confirmation. A fixed scope (one paper, a selection, a snapshot) skips the
 * first step. Drafts, idempotent receipts and model calls follow the same
 * public processor contract as CLI/MCP; nothing runs before the final press.
 */
export function RunOperatorDialog({
  fixed,
  initialOperator,
  onClose,
}: {
  fixed?: { scope: OperatorScope; label: string };
  initialOperator?: Operator;
  onClose: () => void;
}) {
  const api = useApi(),
    shell = useShell(),
    route = useUrlState(),
    queries = useQueryClient();
  const steps: Step[] = fixed
    ? ["operator", "spec", "confirm"]
    : ["scope", "operator", "spec", "confirm"];
  const [step, setStep] = useState<Step>(
    initialOperator && fixed ? "spec" : steps[0]!,
  );
  const [scope, setScope] = useState<OperatorScope>(
    fixed?.scope ??
      (shell.selected.size ? { kind: "selection" } : { kind: "query" }),
  );
  const [draft, setDraftState] = useState<FormDraft>(() => getDraft(api));
  // Reopening continues a record or label draft that already has content.
  const [operator, setOperator] = useState<Operator>(
    initialOperator ??
      (draft.meaning.trim() || draft.question.trim() || draft.submission
        ? draft.kind
        : "summary"),
  );
  const [purpose, setPurpose] = useState("overview"),
    [summaryQuestion, setSummaryQuestion] = useState(""),
    [synthesisQuestion, setSynthesisQuestion] = useState(""),
    [policy, setPolicy] = useState("require-all"),
    [problem, setProblem] = useState<FormProblem | null>(null),
    [receipt, setReceipt] = useState<{ fingerprint: string; key: string }>({
      fingerprint: "",
      key: randomId(),
    });
  const setDraft = (next: FormDraft) => {
    setDraftState(next);
    saveDraft(api, next);
  };
  const set = <K extends keyof FormDraft>(key: K, value: FormDraft[K]) => {
    setDraft({ ...draft, [key]: value });
    setProblem(null);
  };
  useEffect(() => {
    if (operator === "records" || operator === "labels")
      setDraftState((current) =>
        current.kind === operator ? current : { ...current, kind: operator },
      );
  }, [operator]);
  const snapshotId = scope.kind === "snapshot" ? scope.id : null;
  const selected = useMemo(
    () => Array.from(shell.selected).sort(),
    [shell.selected],
  );
  const snapshots = useQuery({
    queryKey: ["snapshots", "operator-scope"],
    enabled: !fixed,
    queryFn: ({ signal }) =>
      archiveQuery(
        api,
        "snapshots",
        { operation: "list", request: { after: null, limit: 50 } },
        signal,
      ).then((v) => rows(v)),
  });
  const registry = useQuery({
    queryKey: ["processors"],
    // A failed read is shown with an explicit retry instead of silent retries.
    retry: false,
    queryFn: ({ signal }) =>
      api.processors("list", {}, signal).then((v) => {
        if (!Array.isArray(v.result)) throw new Error("算子注册表无效");
        return v.result.map((raw) => record(raw, "processor"));
      }),
  });
  const version = (id: Operator) =>
    registry.data?.find((p) => p.id === id)?.version;
  const resolved = useQuery({
    queryKey: [
      "processors",
      "operator-scope",
      scope,
      selected,
      route.query,
      route.sort,
    ],
    retry: false,
    queryFn: async ({ signal }) => {
      let ids: string[] = [];
      if (scope.kind === "snapshot") {
        let offset = 0;
        for (;;) {
          const page = record(
            await archiveQuery(
              api,
              "snapshots",
              {
                operation: "read",
                request: {
                  snapshot_id: scope.id,
                  offset,
                  limit: 200,
                  max_bytes: 262144,
                },
              },
              signal,
            ),
            "snapshot",
          );
          ids.push(
            ...rows(page, "members").map((m) => String(m.literature_id)),
          );
          if (page.next_offset === null) break;
          offset = Number(page.next_offset);
        }
      } else
        ids =
          scope.kind === "literatures"
            ? [...scope.ids]
            : scope.kind === "selection"
              ? selected
              : await scopeIds(api, route.query, route.sort, signal);
      if (!ids.length) throw new Error("当前范围没有文献，请先从文献库选择。");
      if (ids.length > 1000)
        throw new Error("当前范围超过 1,000 篇，请缩小范围。");
      const gaps: string[] = [];
      let index = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, ids.length) }, async () => {
          while (index < ids.length) {
            signal.throwIfAborted();
            const id = ids[index++]!,
              paper = await readLiterature(api, id, signal),
              asset = paper.primary_pdf?.asset;
            if (paper.literature.status !== "READY") {
              gaps.push(`${paperTitle(paper)} · 未建档就绪`);
              continue;
            }
            if (!asset) {
              gaps.push(`${paperTitle(paper)} · 无 PDF`);
              continue;
            }
            const request = {
              literature_id: id,
              asset_id: asset.asset_id,
              asset_sha256: asset.sha256,
            };
            const result = parseDocumentReadResult(
              "default",
              (await api.query("document-default", request, signal)).result,
              request,
            );
            if (!result.default) gaps.push(`${paperTitle(paper)} · 未解析`);
          }
        }),
      );
      return { ids, gaps };
    },
  });
  /** The request the final press submits; the same content keeps the same idempotency key. */
  const request = (key = receipt.key): unknown => {
    const ids = resolved.data?.ids ?? [];
    if (operator === "records" || operator === "labels")
      return prepareSubmission(draft, ids, snapshotId).request;
    const inputs = snapshotId
      ? [{ kind: "snapshot", snapshot_id: snapshotId }]
      : ids.map((literature_id) => ({ kind: "literature", literature_id }));
    const payload = {
      schema_version: 1,
      name:
        operator === "summary"
          ? snapshotId
            ? "快照文献总结"
            : "文献总结"
          : "快照综合",
      processor: { id: operator, version: String(version(operator) ?? "2") },
      spec:
        operator === "summary"
          ? snapshotId
            ? {}
            : {
                purpose,
                question: purpose === "question" ? summaryQuestion : null,
              }
          : { question: synthesisQuestion.trim(), policy },
      inputs,
    };
    return parseProcessorBatchRequest({ ...payload, idempotency_key: key });
  };
  const validate = (at: Step): boolean => {
    try {
      if (at === "scope" || at === "operator") {
        if (!resolved.data)
          throw new FormProblem("scope", "请先读取文献范围。");
      }
      if (at === "operator") {
        if (!version(operator))
          throw new FormProblem("operator", "当前服务不支持所选算子。");
        if (operator === "knowledge-synthesis" && !snapshotId)
          throw new FormProblem("operator", "多篇综合需要以快照为范围。");
      }
      if (at === "spec") {
        if (operator === "records" || operator === "labels")
          prepareSubmission(draft, resolved.data?.ids ?? [], snapshotId);
        else if (
          operator === "knowledge-synthesis" &&
          !synthesisQuestion.trim()
        )
          throw new FormProblem("synthesisQuestion", "请填写综合问题。");
        else if (
          operator === "summary" &&
          purpose === "question" &&
          !summaryQuestion.trim()
        )
          throw new FormProblem("summaryQuestion", "请填写研究问题。");
      }
      setProblem(null);
      return true;
    } catch (error) {
      setProblem(
        error instanceof FormProblem
          ? error
          : new FormProblem("form", processingError(error)),
      );
      return false;
    }
  };
  const mutable =
    api.kind === "workspace" &&
    !!api.workspace.capabilities.tasks &&
    !!api.workspace.capabilities.maintenance;
  const [outcome, setOutcome] = useState<{
    jobId: string | null;
    note: string;
  } | null>(null);
  const submit = useMutation({
    mutationFn: async () => {
      if (!resolved.data) throw new Error("输入范围尚未就绪。");
      if (operator === "records" || operator === "labels") {
        // Records and labels keep their two-phase receipt: save once, then start.
        const submission = prepareSubmission(
          draft,
          resolved.data.ids,
          snapshotId,
        );
        setDraft({ ...draft, submission });
        try {
          if (!submission.jobId) {
            submission.jobId = String(
              jobRecord(
                (await api.submitProcessor(submission.request, false)).task,
              ).job_id,
            );
            submission.note = "任务已保存。";
          }
          if (!submission.started) {
            try {
              await api.request(
                `/api/tasks/${encodeURIComponent(submission.jobId)}/start`,
                {},
              );
              submission.started = true;
              submission.note =
                "任务已保存并请求启动，可在任务页核对实际进度。";
            } catch {
              submission.note =
                "任务已保存，启动状态未确认。请查看任务后显式启动或继续。";
            }
          } else
            submission.note = "该请求已经保存，复用原任务；请查看任务进度。";
        } catch (error) {
          submission.note = processingError(error);
          throw new Error(processingError(error), { cause: error });
        } finally {
          setDraft({ ...draft, submission });
          setOutcome({ jobId: submission.jobId, note: submission.note });
          void queries.invalidateQueries({ queryKey: ["tasks"] });
        }
        return;
      }
      const fingerprint = JSON.stringify(request("fingerprint"));
      const key =
        receipt.fingerprint === fingerprint || !receipt.fingerprint
          ? receipt.key
          : randomId();
      setReceipt({ fingerprint, key });
      const response = await api.submitProcessor(request(key), true);
      void queries.invalidateQueries({ queryKey: ["tasks"] });
      setOutcome({
        jobId: String(jobRecord(response.task).job_id),
        note: "任务已保存并启动；未就绪文献将作为缺口显示。",
      });
    },
  });
  const index = steps.indexOf(step);
  const next = () => {
    if (!validate(step)) return;
    setStep(steps[index + 1]!);
  };
  const error = (field: string) =>
    problem?.field === field ? problem.message : undefined;
  const scopeLabel = fixed
    ? fixed.label
    : scope.kind === "snapshot"
      ? `快照「${String(
          snapshots.data?.find((s) => s.snapshot_id === scope.id)?.name ??
            localTime(
              snapshots.data?.find((s) => s.snapshot_id === scope.id)
                ?.created_at,
            ),
        )}」`
      : scope.kind === "selection"
        ? `已选的 ${selected.length} 篇`
        : "文献库当前筛选";
  const busy = submit.isPending;
  return (
    <Dialog
      title="运行算子"
      isOpen
      isDismissable={!busy}
      className="run-operator"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        outcome && !submit.isError ? (
          <>
            {outcome.jobId ? (
              <Button
                onPress={() => {
                  onClose();
                  navigate({
                    view: "task",
                    literature: null,
                    task: outcome.jobId,
                  });
                }}
              >
                查看任务
              </Button>
            ) : null}
            <Button variant="primary" onPress={onClose}>
              完成
            </Button>
          </>
        ) : (
          <>
            {index > 0 ? (
              <Button
                isDisabled={busy}
                onPress={() => {
                  setProblem(null);
                  setStep(steps[index - 1]!);
                }}
              >
                上一步
              </Button>
            ) : null}
            {step === "confirm" ? (
              <Button
                variant="primary"
                isPending={busy}
                isDisabled={!mutable || !resolved.data}
                onPress={() => void submit.mutateAsync().catch(() => {})}
              >
                开始运行
              </Button>
            ) : (
              <Button
                variant="primary"
                isDisabled={step !== "spec" && !resolved.data}
                onPress={next}
              >
                下一步
              </Button>
            )}
          </>
        )
      }
    >
      <ol className="run-operator-steps" aria-label="运行步骤">
        {steps.map((value, i) => (
          <li
            key={value}
            aria-current={value === step ? "step" : undefined}
            data-done={i < index || undefined}
          >
            <span>{i + 1}</span>
            {STEP_LABELS[value]}
          </li>
        ))}
      </ol>
      {step === "scope" ? (
        <div className="run-operator-body">
          <RadioGroup
            label="文献范围"
            value={scope.kind}
            onChange={(value) =>
              setScope(
                value === "snapshot"
                  ? {
                      kind: "snapshot",
                      id: String(snapshots.data?.[0]?.snapshot_id ?? ""),
                    }
                  : { kind: value as "selection" | "query" },
              )
            }
          >
            <Radio value="selection" isDisabled={!selected.length}>
              文献库中已选的 {selected.length} 篇
            </Radio>
            <Radio value="query">文献库当前筛选的全部文献</Radio>
            <Radio value="snapshot" isDisabled={!snapshots.data?.length}>
              一个快照
            </Radio>
          </RadioGroup>
          {scope.kind === "snapshot" && snapshots.data?.length ? (
            <Select
              label="快照"
              value={scope.id}
              onChange={(id) => setScope({ kind: "snapshot", id })}
              options={snapshots.data.map((s) => ({
                value: String(s.snapshot_id),
                label: `${String(s.name ?? localTime(s.created_at))} · ${Number(s.member_count)} 篇`,
              }))}
            />
          ) : null}
          <ScopeStatus resolved={resolved} />
        </div>
      ) : null}
      {step === "operator" ? (
        <div className="run-operator-body">
          <p className="run-operator-scope">范围：{scopeLabel}</p>
          <RadioGroup
            label="算子"
            value={operator}
            onChange={(value) => {
              setOperator(value as Operator);
              setProblem(null);
            }}
          >
            {OPERATORS.map((item) => (
              <Radio
                key={item.id}
                value={item.id}
                isDisabled={
                  !version(item.id) ||
                  (item.id === "knowledge-synthesis" && !snapshotId)
                }
              >
                <span className="run-operator-choice">
                  <b>{processorName(item.id)}</b>
                  <span>
                    {item.description}
                    {item.id === "knowledge-synthesis" && !snapshotId
                      ? " 当前范围不是快照。"
                      : ""}
                  </span>
                </span>
              </Radio>
            ))}
          </RadioGroup>
          {registry.error ? (
            <ErrorNotice
              message={`${processingError(registry.error)} 尚未提交任务。`}
              retained="已填写的内容已保留。"
              onRetry={() => registry.refetch().then(() => {})}
            />
          ) : null}
          {resolved.isError ? <ScopeStatus resolved={resolved} /> : null}
        </div>
      ) : null}
      {step === "spec" ? (
        <div className="run-operator-body">
          <p className="run-operator-scope">
            范围：{scopeLabel} · 算子：{processorName(operator)}
          </p>
          {readsLabel(registry.data?.find((p) => p.id === operator)?.reads)}
          {operator === "summary" ? (
            snapshotId ? (
              <p>快照中的每篇文献按默认规范生成总结，已有结果会复用。</p>
            ) : (
              <>
                <Select
                  label="分析用途"
                  value={purpose}
                  onChange={setPurpose}
                  options={[
                    { value: "overview", label: "概览" },
                    { value: "detailed", label: "详细分析" },
                    { value: "question", label: "围绕问题" },
                  ]}
                />
                {purpose === "question" ? (
                  <TextArea
                    label="研究问题"
                    value={summaryQuestion}
                    onChange={setSummaryQuestion}
                    {...(error("summaryQuestion")
                      ? { errorMessage: error("summaryQuestion")! }
                      : {})}
                  />
                ) : null}
              </>
            )
          ) : operator === "knowledge-synthesis" ? (
            <>
              <TextArea
                label="综合问题"
                value={synthesisQuestion}
                onChange={setSynthesisQuestion}
                {...(error("synthesisQuestion")
                  ? { errorMessage: error("synthesisQuestion")! }
                  : {})}
              />
              <Select
                label="覆盖要求"
                value={policy}
                onChange={setPolicy}
                options={[
                  { value: "require-all", label: "全部成员完整后综合" },
                  { value: "allow-partial", label: "带缺口综合" },
                ]}
              />
            </>
          ) : (
            <SpecFields draft={draft} set={set} error={error} />
          )}
        </div>
      ) : null}
      {step === "confirm" ? (
        <div className="run-operator-body">
          <dl className="run-operator-summary">
            <div>
              <dt>范围</dt>
              <dd>
                {scopeLabel}
                {resolved.data ? ` · ${resolved.data.ids.length} 篇` : ""}
              </dd>
            </div>
            <div>
              <dt>算子</dt>
              <dd>{processorName(operator)}</dd>
            </div>
            <div>
              <dt>规范</dt>
              <dd>
                {operator === "records"
                  ? `${draft.meaning.trim()} · ${draft.fields.length} 个字段`
                  : operator === "labels"
                    ? draft.question.trim()
                    : operator === "knowledge-synthesis"
                      ? synthesisQuestion.trim()
                      : snapshotId
                        ? "默认规范"
                        : purpose === "question"
                          ? summaryQuestion.trim()
                          : { overview: "概览", detailed: "详细分析" }[purpose]}
              </dd>
            </div>
            <div>
              <dt>输入</dt>
              <dd>
                {resolved.data
                  ? `${resolved.data.ids.length} 篇 · 提交时固定输入版本`
                  : resolved.isPending
                    ? "正在读取范围与已有材料…"
                    : "未能读取"}
              </dd>
            </div>
            {resolved.data?.gaps.length ? (
              <div>
                <dt>缺口</dt>
                <dd>{resolved.data.gaps.length} 篇缺少解析正文，保留为缺口</dd>
              </div>
            ) : null}
          </dl>
          <ScopeStatus resolved={resolved} listOnly />
          {!outcome ? (
            <UsageEstimate request={confirmRequest(request)} />
          ) : null}
          <p className="ui-description">
            开始后会调用已配置的模型；完整匹配的已有结果会复用，缺少材料的文献保留为缺口。
          </p>
          {outcome ? <p role="status">{outcome.note}</p> : null}
          {submit.isError ? (
            <ErrorNotice
              message={processingError(submit.error)}
              retained="规范已保留，可直接重试。"
            />
          ) : null}
        </div>
      ) : null}
      {problem ? (
        <p role="alert" className="ui-error-text">
          {problem.message}
        </p>
      ) : null}
    </Dialog>
  );
}
function confirmRequest(build: () => unknown) {
  try {
    return { kind: "processor", request: build() };
  } catch {
    return null;
  }
}
function ScopeStatus({
  resolved,
  listOnly = false,
}: {
  resolved: UseQueryResult<{ ids: string[]; gaps: string[] }>;
  /** The confirm step shows the counts in its summary table. */
  listOnly?: boolean;
}) {
  if (resolved.isPending)
    return listOnly ? null : (
      <Skeleton rows={2} label="正在读取范围与已有材料" />
    );
  if (resolved.isError)
    return (
      <ErrorNotice
        message={`${processingError(resolved.error)} 尚未提交任务。`}
        retained="已填写的内容已保留。"
        onRetry={() => resolved.refetch().then(() => {})}
      />
    );
  return (
    <>
      {listOnly ? null : (
        <p role="status">{resolved.data.ids.length} 篇 · 提交时固定输入版本</p>
      )}
      {resolved.data.gaps.length ? (
        <>
          {listOnly ? null : (
            <p>{resolved.data.gaps.length} 篇缺少解析正文，将保留为缺口。</p>
          )}
          <Disclosure title="查看缺少材料的文献">
            <ul>
              {resolved.data.gaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          </Disclosure>
        </>
      ) : null}
    </>
  );
}
/** Record and label specifications; chunking is defined by the operator, not here. */
function SpecFields({
  draft,
  set,
  error,
}: {
  draft: FormDraft;
  set: <K extends keyof FormDraft>(key: K, value: FormDraft[K]) => void;
  error: (field: string) => string | undefined;
}) {
  const updateField = (
    index: number,
    key: "name" | "description" | "type" | "unit",
    value: string,
  ) =>
    set(
      "fields",
      draft.fields.map((field, i) =>
        i === index ? { ...field, [key]: value } : field,
      ),
    );
  return (
    <div className="processor-form">
      {draft.kind === "records" ? (
        <>
          <TextArea
            label="每条记录代表什么"
            value={draft.meaning}
            onChange={(value) => set("meaning", value)}
            isRequired
            description="说明记录的粒度，保留不同实验或条件的区别。"
            {...(error("meaning") ? { errorMessage: error("meaning")! } : {})}
          />
          <TextField
            label="纳入条件（可选）"
            value={draft.inclusion}
            onChange={(value) => set("inclusion", value)}
            {...(error("inclusion")
              ? { errorMessage: error("inclusion")! }
              : {})}
          />
          <h3>需要哪些字段</h3>
          <p className="ui-description">
            每个值保留对应证据；没有依据时值为空。
          </p>
          {draft.fields.map((field, index) => (
            <section className="processor-field" key={index}>
              <TextField
                label={`字段 ${index + 1} 名称`}
                value={field.name}
                onChange={(value) => updateField(index, "name", value)}
                placeholder="field_name"
                {...(error(`field-${index}-name`)
                  ? { errorMessage: error(`field-${index}-name`)! }
                  : {})}
              />
              <TextArea
                label={`字段 ${index + 1} 说明`}
                value={field.description}
                onChange={(value) => updateField(index, "description", value)}
                {...(error(`field-${index}-description`)
                  ? { errorMessage: error(`field-${index}-description`)! }
                  : {})}
              />
              <Select
                label={`字段 ${index + 1} 类型`}
                value={field.type}
                onChange={(value) => updateField(index, "type", value)}
                options={[
                  { value: "string", label: "文字" },
                  { value: "number", label: "数值" },
                  { value: "boolean", label: "是 / 否" },
                ]}
              />
              {field.type === "number" ? (
                <TextField
                  label={`字段 ${index + 1} 单位说明`}
                  value={field.unit}
                  onChange={(value) => updateField(index, "unit", value)}
                  description="保留原文单位，不自动换算。"
                  {...(error(`field-${index}-unit`)
                    ? { errorMessage: error(`field-${index}-unit`)! }
                    : {})}
                />
              ) : null}
              <Button
                variant="text"
                size="compact"
                aria-label={`删除字段 ${index + 1}`}
                onPress={() =>
                  set(
                    "fields",
                    draft.fields.filter((_, i) => i !== index),
                  )
                }
              >
                删除字段
              </Button>
            </section>
          ))}
          <Button
            isDisabled={draft.fields.length >= 64}
            onPress={() =>
              set("fields", [
                ...draft.fields,
                { name: "", description: "", type: "string", unit: "" },
              ])
            }
          >
            添加字段
          </Button>
        </>
      ) : (
        <>
          <TextArea
            label="对每篇文献问一个问题"
            value={draft.question}
            onChange={(value) => set("question", value)}
            isRequired
            description="证据不足时值为空，不会默认判为否。"
            {...(error("question") ? { errorMessage: error("question")! } : {})}
          />
          <Select
            label="答案类型"
            value={draft.answerType}
            onChange={(value) =>
              set("answerType", value as FormDraft["answerType"])
            }
            options={[
              { value: "boolean", label: "是 / 否" },
              { value: "string", label: "简短文字" },
              { value: "enum", label: "指定选项" },
            ]}
          />
          {draft.answerType === "enum" ? (
            <TextArea
              label="可选答案"
              value={draft.choices}
              onChange={(value) => set("choices", value)}
              description="每行一个选项。"
              {...(error("choices") ? { errorMessage: error("choices")! } : {})}
            />
          ) : null}
        </>
      )}
      <Select
        label="读取部分"
        value={draft.readsPart ?? "main"}
        onChange={(v) =>
          set("readsPart", v as "main" | "supplementary" | "all")
        }
        options={[
          { value: "main", label: "正文" },
          { value: "supplementary", label: "补充材料" },
          { value: "all", label: "正文与补充材料" },
        ]}
      />
      <Select
        label="章节角色"
        value={draft.readsRole ?? "all"}
        onChange={(v) => set("readsRole", v)}
        options={[
          { value: "all", label: "全部章节" },
          { value: "abstract", label: "摘要" },
          { value: "methods", label: "实验方法" },
          { value: "results", label: "结果" },
          { value: "discussion", label: "讨论" },
          { value: "conclusion", label: "结论" },
          { value: "si-methods", label: "补充实验" },
          { value: "si-characterization", label: "补充表征" },
          { value: "si-computation", label: "补充计算" },
        ]}
      />
      <RadioGroup
        label="读取范围"
        value={draft.reading}
        onChange={(value) => set("reading", value as FormDraft["reading"])}
      >
        <Radio value="full">全部可读正文</Radio>
        <Radio value="search">仅与关键词匹配的片段</Radio>
      </RadioGroup>
      {draft.reading === "search" ? (
        <TextField
          label="片段关键词"
          value={draft.readingQuery}
          onChange={(value) => set("readingQuery", value)}
          description="仅处理匹配片段，未匹配内容不据此判定为没有信息。"
          {...(error("readingQuery")
            ? { errorMessage: error("readingQuery")! }
            : {})}
        />
      ) : null}
      <p className="ui-description">
        仅使用就绪校订稿，不自动获取或解析前序材料。
      </p>
    </div>
  );
}
/** The registered reading declaration, as the operator itself states it. */
function readsLabel(value: unknown) {
  if (value === undefined) return null;
  try {
    const reads = parseProcessorReads(value);
    return (
      <p>
        读取：
        {
          {
            main: "正文",
            supplementary: "补充材料",
            all: "正文与补充材料",
          }[reads.parts]
        }{" "}
        ·{" "}
        {reads.roles === "all"
          ? "全部章节"
          : reads.roles
              .map((r) => sectionRoleNames[r] ?? "其他章节")
              .join("、")}
      </p>
    );
  } catch {
    return null;
  }
}
