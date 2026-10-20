import { archiveQuery, rows } from "../../data/archive.js";
import { lazy, Suspense, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseDocumentReadResult } from "@sciretriever/contracts";
import {
  Button,
  Dialog,
  Disclosure,
  ErrorNotice,
  PageHeader,
  Radio,
  RadioGroup,
  SegmentedControl,
  Select,
  Skeleton,
  Tabs,
  TechDetails,
  TextArea,
  TextField,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { readLiterature, paperTitle, scopeIds } from "../../data/library.js";
import { navigate, useUrlState } from "../../data/url.js";
import { useShell } from "../../shell/context.js";
import { jobRecord, record } from "../../data/wire.js";
import {
  FormProblem,
  getDraft,
  prepareSubmission,
  processingError,
  saveDraft,
  type FormDraft,
} from "./form.js";
import "./processing.css";
const Results = lazy(() => import("./Results.js"));
const Maintenance = lazy(() => import("../maintenance/Maintenance.js"));
export default function Processing() {
  const route = useUrlState(),
    api = useApi(),
    canCreate = api.kind === "workspace";
  const delivery = route.parameters.get("tools") === "delivery";
  const results =
    !canCreate ||
    route.parameters.has("results") ||
    route.parameters.has("result") ||
    route.parameters.has("collection");
  return (
    <section className="feature-page processing-page">
      <PageHeader
        title="提取"
        description="把已有文献中的信息整理成可核对的结果。"
      />
      <Tabs
        label="提取分区"
        value={delivery ? "delivery" : results ? "results" : "create"}
        onChange={(value) =>
          navigate({
            view: "ext",
            result: null,
            resultHash: null,
            collection: null,
            results: value === "results" ? "all" : null,
            tools: value === "delivery" ? "delivery" : null,
          })
        }
        items={[
          ...(canCreate ? [{ id: "create", label: "新建处理" }] : []),
          { id: "results", label: "已有结果" },
          { id: "delivery", label: "规范与外部交付" },
        ]}
      >
        {delivery ? (
          <Suspense fallback={<Skeleton />}>
            <Maintenance deliveryOnly />
          </Suspense>
        ) : results ? (
          <Suspense fallback={<Skeleton />}>
            <Results />
          </Suspense>
        ) : (
          <ProcessingForm />
        )}
      </Tabs>
    </section>
  );
}
function ProcessingForm() {
  const api = useApi(),
    shell = useShell(),
    route = useUrlState(),
    queries = useQueryClient();
  const [draft, setDraft] = useState<FormDraft>(() => ({
      ...getDraft(api),
      scope: shell.selected.size ? getDraft(api).scope : "query",
    })),
    [problem, setProblem] = useState<FormProblem | null>(null),
    [confirm, setConfirm] = useState(false);
  useEffect(() => saveDraft(api, draft), [api, draft]);
  const set = <K extends keyof FormDraft>(key: K, value: FormDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setProblem(null);
  };
  const selected = Array.from(shell.selected).sort(),
    snapshot = route.parameters.get("snapshot");
  const scope = useQuery({
    queryKey: [
      "processors",
      "form-scope",
      draft.scope,
      snapshot,
      selected,
      route.query,
      route.sort,
    ],
    queryFn: async ({ signal }) => {
      const frozen: string[] = [];
      if (snapshot) {
        let offset = 0;
        for (;;) {
          const page = record(
            await archiveQuery(
              api,
              "snapshots",
              {
                operation: "read",
                request: {
                  snapshot_id: snapshot,
                  offset,
                  limit: 200,
                  max_bytes: 262144,
                },
              },
              signal,
            ),
            "snapshot",
          );
          frozen.push(
            ...rows(page, "members").map((m) => String(m.literature_id)),
          );
          if (page.next_offset === null) break;
          offset = Number(page.next_offset);
        }
      }
      const ids = snapshot
        ? frozen
        : draft.scope === "selection"
          ? selected
          : await scopeIds(api, route.query, route.sort, signal);
      if (!ids.length) throw new Error("当前范围没有文献，请先从文献库选择。");
      if (ids.length > 1000)
        throw new Error("当前范围超过 1,000 篇，请缩小范围。");
      const registry = (await api.processors("list", {}, signal)).result;
      if (
        !Array.isArray(registry) ||
        !["labels", "records"].every((id) =>
          registry.some((raw) => {
            const p = record(raw, "processor");
            return p.id === id && p.version === "2";
          }),
        )
      )
        throw new Error("当前服务不支持此版本的问答标注或记录提取。");
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
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: async () => {
      if (!scope.data) throw new Error("输入范围尚未就绪。");
      const submission = prepareSubmission(draft, scope.data.ids, snapshot);
      setDraft((current) => ({ ...current, submission }));
      saveDraft(api, { ...draft, submission });
      submission.note = "正在固定输入并保存任务…";
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
            submission.note = "任务已保存并请求启动，可在任务页核对实际进度。";
          } catch {
            submission.note =
              "任务已保存，启动状态未确认。请查看任务后显式启动或继续。";
          }
        } else submission.note = "该请求已经保存，复用原任务；请查看任务进度。";
      } catch (error) {
        submission.note = processingError(error);
        throw new Error(processingError(error), { cause: error });
      } finally {
        setDraft((current) => ({ ...current, submission }));
        saveDraft(api, { ...draft, submission });
        void queries.invalidateQueries({ queryKey: ["tasks"] });
      }
    },
  });
  const validate = () => {
    try {
      if (!scope.data) throw new Error("请先读取文献范围。");
      prepareSubmission(draft, scope.data.ids, snapshot);
      setProblem(null);
      setConfirm(true);
    } catch (error) {
      setProblem(
        error instanceof FormProblem
          ? error
          : new FormProblem("form", processingError(error)),
      );
    }
  };
  const error = (field: string) =>
    problem?.field === field ? problem.message : undefined;
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
  const mutable =
    api.kind === "workspace" &&
    !!api.workspace.capabilities.tasks &&
    !!api.workspace.capabilities.maintenance;
  return (
    <>
      <div className="processor-grid">
        <form
          className="processor-form"
          onSubmit={(event) => {
            event.preventDefault();
            validate();
          }}
        >
          <SegmentedControl
            label="处理方式"
            value={draft.kind}
            onChange={(value) => set("kind", value as FormDraft["kind"])}
            items={[
              { id: "records", label: "记录提取" },
              { id: "labels", label: "问答标注" },
            ]}
          />
          {draft.kind === "records" ? (
            <>
              <TextArea
                label="每条记录代表什么"
                value={draft.meaning}
                onChange={(value) => set("meaning", value)}
                isRequired
                {...(error("meaning")
                  ? { errorMessage: error("meaning")! }
                  : {})}
                description="说明记录的粒度，保留不同实验或条件的区别。"
              />
              <TextField
                label="纳入条件（可选）"
                value={draft.inclusion}
                onChange={(value) => set("inclusion", value)}
                {...(error("inclusion")
                  ? { errorMessage: error("inclusion")! }
                  : {})}
              />
              <h2>需要哪些字段</h2>
              <p className="ui-description">
                每个值保留对应证据，没有依据时说明缺失原因。
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
                    onChange={(value) =>
                      updateField(index, "description", value)
                    }
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
                description="证据不足显示无法判断，不会默认判为否。"
                {...(error("question")
                  ? { errorMessage: error("question")! }
                  : {})}
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
                  {...(error("choices")
                    ? { errorMessage: error("choices")! }
                    : {})}
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
          {problem ? (
            <p role="alert" className="ui-error-text">
              {problem.message}
            </p>
          ) : null}
        </form>
        <aside className="processor-aside" aria-label="处理范围与提交">
          <h2>处理哪些文献</h2>
          {snapshot ? <p>使用固定快照；当前勾选和筛选不会改变成员。</p> : null}
          <Select
            label="文献范围"
            value={draft.scope}
            onChange={(value) => set("scope", value as FormDraft["scope"])}
            options={[
              {
                value: "selection",
                label: `文献库中已选的 ${shell.selected.size} 篇`,
                disabled: shell.selected.size === 0,
              },
              { value: "query", label: "当前筛选的全部文献" },
            ]}
          />
          {scope.isPending ? (
            <Skeleton rows={2} label="正在读取范围与已有材料" />
          ) : scope.isError ? (
            <ErrorNotice
              message={`${processingError(scope.error)} 尚未提交任务。`}
              retained="表单草稿已保留。"
              onRetry={() => scope.refetch().then(() => {})}
            />
          ) : (
            <>
              <p role="status">
                {scope.data.ids.length} 篇 · 提交时固定输入版本
              </p>
              {scope.data.gaps.length ? (
                <>
                  <p>{scope.data.gaps.length} 篇缺少解析正文，将保留为缺口。</p>
                  <Disclosure title="查看缺少材料的文献">
                    <ul>
                      {scope.data.gaps.map((gap) => (
                        <li key={gap}>{gap}</li>
                      ))}
                    </ul>
                  </Disclosure>
                </>
              ) : null}
            </>
          )}
          <Button
            variant="process"
            confirm={false}
            isPending={mutation.isPending}
            isDisabled={!scope.data || !mutable}
            onPress={validate}
          >
            {draft.kind === "records" ? "开始提取" : "生成问答标注"}
          </Button>
          <p className="ui-description">
            提交时固定输入，会调用已配置的模型。完整匹配的结果会复用。
          </p>
          <Button variant="text" onPress={() => navigate({ view: "set" })}>
            模型设置
          </Button>
          {draft.submission ? (
            <>
              <p role="status">{draft.submission.note}</p>
              {draft.submission.jobId ? (
                <Button
                  onPress={() =>
                    navigate({ view: "task", task: draft.submission!.jobId })
                  }
                >
                  查看任务
                </Button>
              ) : null}
            </>
          ) : null}
          {mutation.isError ? (
            <ErrorNotice message={processingError(mutation.error)} />
          ) : null}
          <Button
            variant="text"
            onPress={() => navigate({ view: "ext", tools: "delivery" })}
          >
            规范与外部交付
          </Button>
        </aside>
      </div>
      <ProcessingConfirmation
        open={confirm}
        pending={mutation.isPending}
        close={() => setConfirm(false)}
        count={scope.data?.ids.length ?? 0}
        run={() =>
          mutation.mutateAsync().then(() => {
            setConfirm(false);
          })
        }
      />
    </>
  );
}
function ProcessingConfirmation({
  open,
  close,
  count,
  run,
  pending,
}: {
  pending: boolean;
  open: boolean;
  close: () => void;
  count: number;
  run: () => Promise<void>;
}) {
  return (
    <Dialog
      title="确认处理文献"
      isOpen={open}
      isDismissable={!pending}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <p>范围：{count} 篇文献。使用已配置的分析模型，缺少材料将保留为缺口。</p>
      <Button variant="primary" isPending={pending} onPress={run}>
        确认并创建处理任务
      </Button>
      <TechDetails>
        <p>同一有效草稿重试使用原幂等标识，不重复创建任务。</p>
      </TechDetails>
    </Dialog>
  );
}
