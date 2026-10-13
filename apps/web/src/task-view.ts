import {
  envelopeRecord,
  jobRecord,
  jobStatus,
  listField,
  record,
  type JsonRecord as Json,
} from "./wire.js";

/** Shared rendering projection for task details and the overview; no business state. */
export function taskElement(
  tag: string,
  text: string,
  className?: string,
): HTMLElement {
  const value = document.createElement(tag);
  value.textContent = text;
  if (className) value.className = className;
  return value;
}

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
export const operationLabels: Readonly<Record<string, string>> = {
  "parse-documents": "解析 PDF",
  "assess-article-identity": "核验材料身份",
  analyze: "单篇知识分析",
  "analyze-long": "长文分段分析",
  synthesize: "集合综合",
};

export function taskTitle(job: Json): string {
  const selector = record(job.selector, "task selector");
  if (selector.schema_version === 3) {
    const request = record(selector.request, "processing request");
    const operations = listField(request, "operations").map((item) =>
      record(item, "operation"),
    );
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
      typeof query.text === "string" && query.text ? query.text : "全部文献";
  } else if (
    input.kind === "literatures" &&
    Array.isArray(input.literature_ids)
  ) {
    scope = `${input.literature_ids.length} 篇指定文献`;
  } else if (input.kind === "all-pending") scope = "待处理文献";
  return `${selector.goal === "pdf" ? "获取 PDF" : "文献处理"} · ${scope}`;
}

export interface TaskDetail {
  readonly job: Json;
  readonly targets: readonly Json[];
  readonly results: readonly Json[];
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
    job,
    targets: list("targets"),
    results: list("results"),
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
  if (item.operation !== "analyze" && item.operation !== "analyze-long")
    return null;
  const input = record(
    record(item.request, "analysis request").input,
    "input manifest",
  );
  const inputs = listField(input, "items");
  if (inputs.length !== 1) return null;
  const literatureId = record(inputs[0], "input item").literature_id;
  return typeof literatureId === "string" ? literatureId : null;
}
