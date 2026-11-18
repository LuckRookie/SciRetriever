import {
  parseAcquisitionTaskTrace,
  parseTaskSourceResults,
  type AcquisitionTaskTrace,
  type TaskSourceResults,
} from "@sciretriever/contracts";
import {
  envelopeRecord,
  jobRecord,
  jobStatus,
  listField,
  record,
  type JsonRecord as Json,
} from "./wire.js";

export const taskStatusLabel: Readonly<Record<string, string>> = {
  queued: "等待执行",
  running: "执行中",
  paused: "等待处理",
  cancelled: "已取消",
  completed: "已完成",
  failed: "执行失败",
  interrupted: "上次运行中断",
  skipped: "已跳过",
  acquisition: "获取 PDF",
  parsing: "解析材料",
  analysis: "分析材料",
  literature: "保存结果",
  pending: "等待执行",
  open: "待处理",
  resolved: "已处理",
};
/**
 * “n 进行中” counts the tasks actually running in an active-group answer: a
 * queued task (saved and never started, or waiting for a slot) is “等待执行”,
 * not in progress (page specs “任务”). Lists still show both.
 */
export function runningTaskCount(answer: unknown): number {
  const tasks = (answer as { tasks?: unknown } | null | undefined)?.tasks;
  return Array.isArray(tasks)
    ? tasks.filter(
        (task: unknown) =>
          !!task &&
          typeof task === "object" &&
          (task as { status?: unknown }).status === "running",
      ).length
    : 0;
}
/** Beside 任务: “2 进行中 · 12 需处理”, a zero left out, nothing when both are. */
export function taskCountText(running: number, issues: number): string {
  return [
    running > 0 ? `${running.toLocaleString()} 进行中` : "",
    issues > 0 ? `${issues.toLocaleString()} 需处理` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
export const operationLabels: Readonly<Record<string, string>> = {
  "acquire-metadata": "获取元数据",
  "parse-documents": "解析 PDF",
  "assess-article-identity": "核验材料身份",
  synthesize: "集合综合",
  "run-processor": "知识处理",
};

/** The range a scoped PDF task fixed at creation: on the job in lists, inside its selector in detail. */
export function taskScope(job: {
  readonly scope?: unknown;
  readonly selector?: unknown;
}) {
  if (job.scope !== undefined && job.scope !== null) return job.scope;
  const selector = job.selector;
  return selector && typeof selector === "object" && "scope" in selector
    ? ((selector as { scope?: unknown }).scope ?? null)
    : null;
}
export function taskTitle(job: Json): string {
  const selector = record(job.selector, "task selector");
  if (selector.schema_version === 3) {
    const request = record(selector.request, "processing request");
    const operations = listField(request, "operations").map((item) =>
      record(item, "operation"),
    );
    const metadata =
      operations.length === 1 ? metadataTitle(operations[0]!) : null;
    if (metadata) return metadata;
    if (
      request.schema_version === 2 &&
      typeof request.collection_name === "string"
    )
      return `${request.collection_name} · ${operations.length} 项`;
    const names = [
      ...new Set(
        operations.map(
          (item) => operationLabels[String(item.operation)] ?? "材料加工",
        ),
      ),
    ];
    return `${names.join("、")} · ${operations.length} 项`;
  }
  const input = record(selector.selector ?? {}, "literature selector");
  let scope = "文献批次";
  if (input.kind === "query") {
    const query = record(input.query, "task query");
    scope =
      Array.isArray(query.intake_batch_ids) && query.intake_batch_ids.length
        ? "入库批次"
        : typeof query.text === "string" && query.text
          ? query.text
          : "按筛选";
    const fixed = taskScope(job);
    const counts = fixed ? record(fixed, "task scope").counts : null;
    if (counts) scope += ` ${record(counts, "scope counts").process} 篇`;
  } else if (
    input.kind === "literatures" &&
    Array.isArray(input.literature_ids)
  ) {
    scope = `${input.literature_ids.length} 篇指定文献`;
  } else if (input.kind === "all-pending") scope = "待处理文献";
  return `${selector.goal === "pdf" ? "获取 PDF" : "文献处理"} · ${scope}`;
}

/** Only PDF acquisition and metadata tasks carry per-source results worth showing. */
export function acquisitionTask(job: Json): boolean {
  const selector = record(job.selector, "task selector");
  if (selector.schema_version !== 3) return selector.goal === "pdf";
  return listField(record(selector.request, "processing request"), "operations")
    .map((item) => record(item, "operation"))
    .some((item) => item.operation === "acquire-metadata");
}

/** Topic discovery, citation expansion and bibliography lookup read as what they are. */
function metadataTitle(operation: Json): string | null {
  if (operation.operation !== "acquire-metadata") return null;
  const request = record(operation.request, "metadata request");
  if (request.kind === "topic") return `主题发现 · “${String(request.query)}”`;
  if (request.kind === "citation")
    return `引用扩展 · ${listField(request, "seed_literature_ids").length} 篇`;
  if (request.kind === "lookup")
    return `补全书目 · ${listField(request, "literature_ids").length} 篇`;
  return null;
}

export interface TaskDetail {
  readonly acquisition_traces?: readonly AcquisitionTaskTrace[];
  readonly acquisition_traces_truncated?: boolean;
  /** Per-source counts; absent on older servers, "unrecorded" on tasks from before them. */
  readonly source_results?: TaskSourceResults;
  readonly job: Json;
  readonly targets: readonly Json[];
  readonly results: readonly Json[];
  readonly partial_results: readonly Json[];
  readonly collections: readonly Json[];
  readonly skipped: readonly Json[];
  readonly failures: readonly Json[];
  readonly events: readonly Json[];
  readonly interventions: readonly Json[];
  readonly policy: Json | null;
  readonly budget: Json | null;
  readonly runtime_failure: string | null;
  readonly events_truncated: boolean;
}

export function parseTaskDetail(value: unknown): TaskDetail {
  const task = envelopeRecord(value, "task");
  const job = jobRecord(task.job);
  jobStatus(job);
  const list = (name: string) =>
    listField(task, name).map((item) => record(item, name));
  return {
    ...(task.acquisition_traces === undefined
      ? {}
      : {
          acquisition_traces: listField(task, "acquisition_traces").map(
            parseAcquisitionTaskTrace,
          ),
          acquisition_traces_truncated:
            task.acquisition_traces_truncated === true,
        }),
    ...(task.source_results == null
      ? {}
      : { source_results: parseTaskSourceResults(task.source_results) }),
    job,
    targets: list("targets"),
    results: list("results"),
    partial_results:
      task.partial_results == null ? [] : list("partial_results"),
    collections: task.collections == null ? [] : list("collections"),
    skipped: list("skipped"),
    failures: list("failures"),
    events: list("events"),
    interventions: list("interventions"),
    events_truncated: task.events_truncated === true,
    policy: task.policy == null ? null : record(task.policy, "task policy"),
    budget: task.budget == null ? null : record(task.budget, "task budget"),
    runtime_failure:
      typeof task.runtime_failure === "string" ? task.runtime_failure : null,
  };
}

/** Analysis targets derive their single literature from the frozen input manifest. */
export function taskLiteratureId(job: Json, target: Json): string | null {
  if (typeof target.literature_id === "string") return target.literature_id;
  const selector = record(job.selector, "task selector");
  if (selector.schema_version !== 3) return null;
  const request = record(selector.request, "processing request");
  const operation = listField(request, "operations")[Number(target.ordinal)];
  if (!operation) return null;
  const item = record(operation, "processing operation");
  if (item.operation === "run-processor") {
    const inputs = listField(
      record(item.request, "processor invocation"),
      "inputs",
    );
    if (inputs.length !== 1) return null;
    const source = record(inputs[0], "processor input");
    if (source.kind === "missing" || source.kind === "archive-document")
      return typeof source.literature_id === "string"
        ? source.literature_id
        : null;
    if (source.kind !== "document") return null;
    const material = record(
      record(source.document, "processor document").source_material_ref,
      "processor material",
    );
    return typeof material.literature_id === "string"
      ? material.literature_id
      : null;
  }
  return null;
}
