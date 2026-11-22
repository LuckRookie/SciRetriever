import {
  parseAcquisitionTaskTrace,
  parseTaskSourceResults,
  type AcquisitionTaskTrace,
  type TaskSourceResults,
} from "@sciretriever/contracts";
import { statusLabels } from "../strings.js";
import {
  envelopeRecord,
  jobRecord,
  jobStatus,
  listField,
  record,
  type JsonRecord as Json,
} from "./wire.js";

/** A target's stage in a task's run; its plain states read as `statusLabels`. */
const targetStageLabels: Readonly<Record<string, string>> = {
  acquisition: "获取 PDF",
  parsing: "解析材料",
  analysis: "分析材料",
  literature: "保存结果",
  open: "待处理",
  resolved: "已处理",
};
export function targetStatusLabel(status: unknown): string | undefined {
  const value = String(status);
  return targetStageLabels[value] ?? statusLabels[value];
}
/** A task that was saved and never asked to start: queued, not waiting its turn. */
export function taskNotStarted(job: {
  readonly status?: unknown;
  readonly start_requested?: unknown;
}): boolean {
  return job.status === "queued" && job.start_requested !== true;
}
/**
 * A task's state in the page specs' words: a queued task is “未启动” until
 * someone asked it to start, then “排队中” (page specs “界面用词”).
 */
export function taskStateLabel(job: {
  readonly status?: unknown;
  readonly start_requested?: unknown;
}): string {
  if (taskNotStarted(job)) return "未启动";
  const value = String(job.status);
  return statusLabels[value] ?? value;
}
export type TaskAction = "start" | "pause" | "resume" | "retry" | "cancel";
/**
 * The controls each state can use (page specs “任务与 Agent 会话”): 未启动
 * 启动、取消; 排队中 and 进行中 暂停、取消; 等你处理 and 已中断 继续、取消;
 * a failed task, or a finished one with skipped failures, 重试. An ended task
 * has nothing to cancel.
 */
export function taskActions(
  job: { readonly status?: unknown; readonly start_requested?: unknown },
  retryFinished = false,
): TaskAction[] {
  const status = String(job.status);
  if (taskNotStarted(job)) return ["start", "cancel"];
  if (status === "queued" || status === "running") return ["pause", "cancel"];
  if (status === "paused" || status === "interrupted")
    return ["resume", "cancel"];
  if (status === "failed") return ["retry"];
  if (status === "completed" && retryFinished) return ["retry"];
  return [];
}
/**
 * “n 进行中” counts the tasks actually running in an active-group answer: a
 * queued task (未启动, or 排队中 waiting for a slot) is not in progress (page specs “任务”). Lists still show both.
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
  "build-archive": "生成全文",
  "backfill-tags": "标签回溯",
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
/** The one paper an operation works on, when it names exactly one. */
function operationLiterature(item: Json): string | null {
  const request =
    item.request && typeof item.request === "object"
      ? (item.request as Json)
      : null;
  if (!request) return null;
  if (
    item.operation === "build-archive" ||
    item.operation === "parse-documents" ||
    item.operation === "assess-article-identity"
  )
    return typeof request.literature_id === "string"
      ? request.literature_id
      : null;
  if (item.operation !== "run-processor" || !Array.isArray(request.inputs))
    return null;
  if (request.inputs.length !== 1) return null;
  const source = request.inputs[0] as Json | null;
  if (!source || typeof source !== "object") return null;
  if (typeof source.literature_id === "string") return source.literature_id;
  const document = source.document as Json | undefined;
  const material = document?.source_material_ref as Json | undefined;
  return typeof material?.literature_id === "string"
    ? material.literature_id
    : null;
}
/**
 * What a task works on (page specs “任务与 Agent 会话”): its kind, then the
 * one paper it names or how many. `paper` is the task's only paper, when
 * `taskPaperId` names one and its title has been read.
 */
interface TaskSubject {
  readonly name: string;
  readonly paper: string | null;
  readonly scope: string;
}
function taskSubject(job: Json): TaskSubject | string {
  const selector = record(job.selector, "task selector");
  if (selector.schema_version === 3) {
    const request = record(selector.request, "processing request");
    const operations = listField(request, "operations").map((item) =>
      record(item, "operation"),
    );
    const metadata =
      operations.length === 1 ? metadataTitle(operations[0]!) : null;
    if (metadata) return metadata;
    const name =
      request.schema_version === 2 &&
      typeof request.collection_name === "string"
        ? request.collection_name
        : [
            ...new Set(
              operations.map(
                (item) => operationLabels[String(item.operation)] ?? "材料加工",
              ),
            ),
          ].join("、");
    const papers = operations.map(operationLiterature);
    if (operations.length && papers.every(Boolean)) {
      const distinct = new Set(papers);
      return distinct.size === 1
        ? { name, paper: papers[0]!, scope: "1 篇" }
        : { name, paper: null, scope: `${distinct.size} 篇` };
    }
    return { name, paper: null, scope: `${operations.length} 项` };
  }
  const input = record(selector.selector ?? {}, "literature selector");
  const name = selector.goal === "pdf" ? "获取 PDF" : "文献处理";
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
    const distinct = new Set(input.literature_ids.map(String));
    return distinct.size === 1
      ? { name, paper: [...distinct][0]!, scope: "1 篇" }
      : { name, paper: null, scope: `${distinct.size} 篇` };
  } else if (input.kind === "all-pending") scope = "待处理文献";
  return { name, paper: null, scope };
}
/** The task's only paper, whose title the task's name carries. */
export function taskPaperId(job: Json): string | null {
  const subject = taskSubject(job);
  return typeof subject === "string" ? null : subject.paper;
}
/**
 * “生成全文 · 文献标题” for one paper, “获取 PDF · 10 篇” for several; until
 * the one paper's title is read, “1 篇”.
 */
export function taskTitle(job: Json, paperTitle?: string | null): string {
  const subject = taskSubject(job);
  if (typeof subject === "string") return subject;
  return `${subject.name} · ${subject.paper && paperTitle ? paperTitle : subject.scope}`;
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

/**
 * One source of a citation expansion that was rate limited (technical 02
 * “来源冷却”): its state now, and the work it still owes this task.
 */
export interface CitationSourceCooldown {
  readonly source: string;
  readonly status: "cooling" | "disabled" | "recovered" | "retry-ended";
  /** Retries already made; the next one is number `retries + 1`. */
  readonly retries: number;
  readonly next_retry_at: string | null;
  readonly reason: { readonly code: string; readonly reason: string } | null;
  readonly pending_count: number;
  readonly pending_sample: readonly {
    readonly literature_id: string;
    readonly purpose: "reference-query" | "lookup";
  }[];
  readonly pending_truncated: boolean;
}
const COOLDOWN_STATES = [
  "cooling",
  "disabled",
  "recovered",
  "retry-ended",
] as const;
function parseCitationCooldown(value: unknown): CitationSourceCooldown {
  const r = record(value, "citation source");
  const count = (key: string) => {
    const n = r[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
      throw new Error(`invalid ${key}`);
    return n;
  };
  const status = COOLDOWN_STATES.find((s) => s === r.status);
  if (typeof r.source !== "string" || !status)
    throw new Error("invalid citation source");
  const reason = r.reason == null ? null : record(r.reason, "source reason");
  return {
    source: r.source,
    status,
    retries: count("retries"),
    next_retry_at: typeof r.next_retry_at === "string" ? r.next_retry_at : null,
    reason: reason
      ? { code: String(reason.code ?? ""), reason: String(reason.reason ?? "") }
      : null,
    pending_count: count("pending_count"),
    pending_sample: listField(r, "pending_sample").map((item) => {
      const sample = record(item, "pending item");
      if (
        typeof sample.literature_id !== "string" ||
        (sample.purpose !== "reference-query" && sample.purpose !== "lookup")
      )
        throw new Error("invalid pending item");
      return { literature_id: sample.literature_id, purpose: sample.purpose };
    }),
    pending_truncated: r.pending_truncated === true,
  };
}

export interface TaskDetail {
  readonly acquisition_traces?: readonly AcquisitionTaskTrace[];
  readonly acquisition_traces_truncated?: boolean;
  /** Per-source counts; absent on older servers, "unrecorded" on tasks from before them. */
  readonly source_results?: TaskSourceResults;
  readonly job: Json;
  /** Someone asked the task to start (31.1); false on servers and tasks from before it. */
  readonly start_requested: boolean;
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
  /** Present only once a source was rate limited (technical 02 “来源冷却”). */
  readonly citation_source_cooldowns: readonly CitationSourceCooldown[];
  readonly citation_source_cooldowns_truncated: boolean;
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
    start_requested: task.start_requested === true,
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
    citation_source_cooldowns:
      task.citation_source_cooldowns == null
        ? []
        : listField(task, "citation_source_cooldowns").map(
            parseCitationCooldown,
          ),
    citation_source_cooldowns_truncated:
      task.citation_source_cooldowns_truncated === true,
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
