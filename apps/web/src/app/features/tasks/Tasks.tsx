import { TaskRun } from "./TaskRun.js";
import { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Badge,
  Button,
  Card,
  ChipGroup,
  Disclosure,
  EmptyState,
  ErrorNotice,
  FilterChip,
  Icon,
  IconButton,
  LocalTime,
  SearchField,
  Skeleton,
  TechDetails,
  progressTone,
} from "../../components/index.js";
import { archiveQuery, rows } from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { pacedInterval } from "../../data/polling.js";
import { ApiError } from "../../data/api.js";
import { paperTitle, readLiterature } from "../../data/library.js";
import { navigate, useUrlState } from "../../data/url.js";
import { useShell } from "../../shell/context.js";
import { TaskPage } from "./TaskPage.js";
import { SourceResults } from "./SourceResults.js";
import { TaskSummary } from "./TaskSummary.js";
import {
  agentRoleName,
  errorMessage,
  skipReasons,
  statusLabels,
} from "../../strings.js";
import { jobRecord, record, type JsonRecord } from "../../data/wire.js";
import {
  acquisitionTask,
  parseTaskDetail,
  taskTitle,
  taskActions,
  taskPaperId,
  taskStateLabel,
  taskLiteratureId,
  operationLabels,
  type TaskAction,
  type TaskDetail,
} from "../../data/tasks.js";
import "./tasks.css";

const terminal = (status: unknown) =>
  ["completed", "cancelled", "failed", "paused", "interrupted"].includes(
    String(status),
  );
function isProcessor(task: TaskDetail) {
  const selector = record(task.job.selector, "selector");
  return (
    selector.schema_version === 3 &&
    record(selector.request, "request").schema_version === 2
  );
}
/**
 * A task's state badge: 进行中 turns, 已完成 is green, 失败、已中断 and
 * 等你处理 are red (someone has to act), the rest grey (rule 5).
 */
export function TaskBadge({ job }: { job: JsonRecord }) {
  const value = String(job.status);
  return (
    <Badge
      status={
        value === "running"
          ? "running"
          : value === "completed"
            ? "completed"
            : ["failed", "interrupted", "paused"].includes(value)
              ? "failed"
              : "metadata"
      }
    >
      {taskStateLabel(job)}
    </Badge>
  );
}
/**
 * The task's name, with its only paper's title once read (shared with every
 * other place that shows the paper, so the list does not read it twice).
 */
export function TaskName({ job }: { job: JsonRecord }) {
  return <>{useTaskName(job)}</>;
}
function useTaskName(job: JsonRecord): string {
  const api = useApi(),
    id = taskPaperId(job);
  const paper = useQuery({
    queryKey: ["literature", id],
    queryFn: ({ signal }) => readLiterature(api, id!, signal),
    enabled: !!id,
    staleTime: 60_000,
  });
  return taskTitle(job, paper.data ? paperTitle(paper.data) : null);
}
export default function Tasks() {
  const api = useApi(),
    queries = useQueryClient(),
    route = useUrlState();
  const [group, setGroup] = useState(""),
    [text, setText] = useState("");
  const jobs = useInfiniteQuery({
    queryKey: ["tasks", "list", group],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const value = await api.read(
        `/api/tasks?limit=100${group ? `&status_group=${encodeURIComponent(group)}` : ""}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      );
      if (!Array.isArray(value.tasks)) throw new Error("任务列表回执无效");
      return {
        items: value.tasks.map(jobRecord),
        cursor:
          typeof value.next_cursor === "string" ? value.next_cursor : null,
      };
    },
    getNextPageParam: (page) => page.cursor,
    refetchInterval: (query) => pacedInterval(query, 5000),
    enabled: api.kind === "workspace",
  });
  const items = [
    ...new Map(
      jobs.data?.pages
        .flatMap((page) => page.items)
        .map((job) => [String(job.job_id), job]),
    ).values(),
  ];
  // The search also finds a task by its paper's title, once that was read.
  const filtered = items.filter((job) => {
    const id = taskPaperId(job),
      paper = id ? queries.getQueryData(["literature", id]) : undefined;
    return `${taskTitle(job, paper ? paperTitle(paper as Parameters<typeof paperTitle>[0]) : null)} ${String(job.job_id)}`
      .toLocaleLowerCase()
      .includes(text.toLocaleLowerCase());
  });
  // “发起方” only says something when the shown tasks differ in who started them.
  const actors = new Set(
    filtered.map((job) => String(job.actor_label ?? job.actor ?? "")),
  );
  const showActor = actors.size > 1;
  const selected = route.parameters.get("task");
  if (api.kind !== "workspace")
    return (
      <EmptyState
        title="此入口不提供持久任务控制"
        description="请使用完整 Web 工作台查看运行中的任务。"
      />
    );
  return (
    <TaskPage
      tab="task"
      className="tasks-page"
      {...(selected ? { panel: "open" as const } : {})}
      action={
        <Button
          onPress={async () => {
            await jobs.refetch();
          }}
        >
          刷新任务
        </Button>
      }
    >
      <div className="tasks-toolbar">
        <ChipGroup label="任务状态">
          {[
            { id: "", label: "全部" },
            { id: "active", label: "进行中" },
            // Paused, interrupted and failed tasks: not named like “需处理”.
            { id: "attention", label: "有问题" },
            { id: "ended", label: "已结束" },
          ].map((item) => (
            <FilterChip
              key={item.id || "all"}
              isSelected={group === item.id}
              onChange={() => setGroup(item.id)}
            >
              {item.label}
            </FilterChip>
          ))}
        </ChipGroup>
        <SearchField
          label="筛选任务"
          value={text}
          onChange={setText}
          placeholder="任务名称或编号"
        />
        <span role="status" className="tasks-count">
          已显示 {items.length} 个任务
          {text ? `，符合筛选 ${filtered.length} 个` : ""}
        </span>
      </div>
      {jobs.isPending ? (
        <Skeleton label="正在读取任务" />
      ) : jobs.isError ? (
        <ErrorNotice
          message={errorMessage(jobs.error)}
          retained={items.length ? "已经显示的任务仍然保留。" : ""}
          onRetry={async () => {
            await jobs.refetch();
          }}
        />
      ) : null}
      {filtered.length ? (
        <table className="ui-data-table task-table" aria-label="任务列表">
          <thead>
            <tr>
              <th scope="col">任务</th>
              {showActor ? (
                <th scope="col" className="task-col-actor">
                  发起方
                </th>
              ) : null}
              <th scope="col" className="task-col-progress">
                进度
              </th>
              <th scope="col">状态</th>
              <th scope="col" className="task-col-time">
                开始
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((job) => {
              const id = String(job.job_id);
              return (
                <tr
                  key={id}
                  data-task-id={id}
                  data-selected={selected === id || undefined}
                  onClick={() => navigate({ task: id })}
                >
                  <td>
                    <button
                      type="button"
                      className="task-open"
                      onClick={(event) => {
                        event.stopPropagation();
                        navigate({ task: id });
                      }}
                    >
                      <TaskName job={job} />
                    </button>
                  </td>
                  {showActor ? (
                    <td className="task-col-actor">
                      {job.actor_label || job.actor ? (
                        String(job.actor_label ?? job.actor)
                      ) : (
                        <span className="task-empty">—</span>
                      )}
                    </td>
                  ) : null}
                  <td className="task-col-progress">
                    <TaskProgress job={job} />
                  </td>
                  <td>
                    <TaskBadge job={job} />
                  </td>
                  <td className="task-time task-col-time">
                    <LocalTime value={job.created_at} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : !jobs.isPending ? (
        <EmptyState
          title={text ? "没有符合筛选的任务" : "当前没有任务"}
          description="从文献库选择材料并启动处理后，可以在这里查看进度。"
          action={
            text ? undefined : (
              <Button
                onPress={() => navigate({ view: "lib", literature: null })}
              >
                去文献库
              </Button>
            )
          }
        />
      ) : null}
      {jobs.hasNextPage ? (
        <Button
          variant="text"
          size="compact"
          isPending={jobs.isFetchingNextPage}
          onPress={async () => {
            await jobs.fetchNextPage();
          }}
        >
          加载更多任务
        </Button>
      ) : null}
      {selected ? (
        <TaskPanel
          key={selected}
          id={selected}
          onClose={() => {
            navigate({ task: null });
            // Return focus to the row that opened the panel.
            requestAnimationFrame(() =>
              document
                .querySelector<HTMLButtonElement>(
                  `[data-task-id="${CSS.escape(selected)}"] .task-open`,
                )
                ?.focus(),
            );
          }}
        />
      ) : null}
    </TaskPage>
  );
}
/**
 * Non-modal detail panel: the task list stays usable, so another row can be
 * opened directly. Escape or the close button dismisses it.
 */
function TaskPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('[role="dialog"]'))
        onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      className="task-panel"
      role="region"
      aria-label="任务详情"
    >
      <header className="task-panel-header">
        <h2>任务详情</h2>
        <IconButton aria-label="关闭任务详情" onPress={onClose}>
          <Icon name="close" />
        </IconButton>
      </header>
      <TaskDetails id={id} />
    </aside>
  );
}
/**
 * Shown only when the list reports a total of more than one item; a task of
 * one item says how it went by its state alone. Without a total, the
 * processed count.
 */
function TaskProgress({ job }: { job: JsonRecord }) {
  const progress =
    job.progress && typeof job.progress === "object"
      ? (job.progress as JsonRecord)
      : null;
  const total = Number(progress?.total),
    done = Number(progress?.done);
  if (!progress || !Number.isFinite(done) || total === 1)
    return <span className="task-time task-empty">—</span>;
  if (!Number.isFinite(total) || total <= 0)
    return <span className="task-time">已处理 {done}</span>;
  return (
    <span className="task-progress">
      <span className="task-progress-track" aria-hidden="true">
        <i
          className="ui-tone-fill"
          data-tone={progressTone(String(job.status))}
          style={{ width: `${Math.min(100, (done / total) * 100)}%` }}
        />
      </span>
      <span className="task-time">
        {done}/{total}
      </span>
    </span>
  );
}
function TaskSessions({ id }: { id: string }) {
  const api = useApi();
  const sessions = useQuery({
    queryKey: ["agent-sessions", "by-task", id],
    queryFn: async ({ signal }) =>
      rows(
        record(
          await archiveQuery(
            api,
            "agent-sessions",
            { operation: "list", request: { job_id: id, limit: 30 } },
            signal,
          ),
          "sessions",
        ),
      ),
    refetchInterval: (query) => pacedInterval(query, 5000),
  });
  if (!sessions.data?.length) return null;
  return (
    <section className="task-sessions" aria-label="Agent 会话">
      <h3>Agent 会话</h3>
      <ul>
        {sessions.data.map((s) => (
          <li key={String(s.session_id)}>
            <Button
              variant="text"
              size="compact"
              onPress={() =>
                navigate({
                  view: "agent",
                  agentSession: String(s.session_id),
                  agentStatus: "all",
                  task: null,
                })
              }
            >
              {`${agentRoleName(String(record(s.subject, "subject").kind ?? s.role))} · ${String(s.title || "文献处理中")}`}
            </Button>
            <span className="task-time">
              {statusLabels[String(s.status)] ?? "处理中"} ·{" "}
              <LocalTime value={s.started_at} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
function detailsText(value: JsonRecord, task: TaskDetail): string {
  // A skipped item's own event has no reason; the operation's receipt does.
  const receipt = task.results.find((r) => r.target_id === value.target_id),
    outcome =
      receipt?.disposition === "skipped" &&
      receipt.result &&
      typeof receipt.result === "object" &&
      "outcome" in receipt.result
        ? String(receipt.result.outcome)
        : null;
  if (outcome && skipReasons[outcome]) return skipReasons[outcome];
  for (const name of ["reason", "message", "detail", "code", "kind", "status"])
    if (typeof value[name] === "string")
      return errorMessage(new Error(String(value[name])));
  return "详细信息已保留，可展开查看。";
}
/** What a refused control means, in words (31.6). */
const TASK_CONFLICTS: Readonly<Record<string, string>> = {
  "processing-terminal": "这个任务已经结束，不能再操作。已刷新它的状态。",
  "processing-resume-required": "这个任务要用“继续”恢复。已刷新它的状态。",
};
export function TaskDetails({ id }: { id: string }) {
  const api = useApi(),
    queries = useQueryClient();
  const [notice, setNotice] = useState("");
  const detail = useQuery({
    queryKey: ["tasks", "detail", id],
    queryFn: async ({ signal }) =>
      parseTaskDetail(
        await api.read(`/api/tasks/${encodeURIComponent(id)}`, signal),
      ),
    refetchInterval: (query) => {
      const task = query.state.data;
      if (!task) return pacedInterval(query, false);
      if (!terminal(task.job.status)) return pacedInterval(query, 2000);
      return pacedInterval(
        query,
        isProcessor(task) &&
          !task.collections.length &&
          query.state.dataUpdateCount < 5
          ? 2000
          : false,
      );
    },
  });
  if (detail.isPending) return <Skeleton label="正在读取任务详情" />;
  if (!detail.data)
    return (
      <ErrorNotice
        message={errorMessage(detail.error)}
        onRetry={async () => {
          await detail.refetch();
        }}
      />
    );
  const task = detail.data,
    status = String(task.job.status),
    processor = isProcessor(task);
  const actions = taskActions(
    { status, start_requested: task.start_requested },
    task.failures.length > 0 &&
      task.targets.some((target) => target.stage === "skipped"),
  );
  const labels: Record<TaskAction, string> = {
    start: "启动",
    pause: "暂停",
    resume: "继续",
    retry: "重试",
    cancel: "取消任务",
  };
  const refresh = async () => {
    await queries.invalidateQueries({ queryKey: ["tasks"] });
  };
  /**
   * The task moved on since this panel read it (another tab, the CLI, a
   * restart): say so in words and read its state again instead of failing.
   */
  const control = async (action: TaskAction) => {
    setNotice("");
    try {
      await api.request(`/api/tasks/${encodeURIComponent(id)}/${action}`, {});
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === "processing-terminal" ||
          error.code === "processing-resume-required")
      ) {
        setNotice(TASK_CONFLICTS[error.code]!);
        await refresh();
        return;
      }
      throw error;
    }
    await refresh();
  };
  const collection = task.collections.at(-1);
  return (
    <div className="task-detail">
      <header className="task-detail-header">
        <h2>
          <TaskName job={task.job} />
        </h2>
        <TaskBadge job={{ status, start_requested: task.start_requested }} />
      </header>
      {detail.isError ? (
        <ErrorNotice
          message={errorMessage(detail.error)}
          retained="上次读取的任务详情仍然保留。"
          onRetry={async () => {
            await detail.refetch();
          }}
        />
      ) : null}
      <div className="task-actions">
        {actions.map((action) => (
          <Button
            key={action}
            variant={action === "cancel" ? "danger" : "secondary"}
            {...(action === "cancel"
              ? {
                  confirm: {
                    title: "取消这个任务？",
                    description:
                      "未完成的操作将停止，已经接纳的材料和结果会保留。",
                    confirmLabel: "取消任务",
                  },
                }
              : {})}
            onPress={() => control(action)}
          >
            {labels[action]}
          </Button>
        ))}
      </div>
      {notice ? (
        <p className="task-notice" role="status">
          {notice}
        </p>
      ) : null}
      {task.runtime_failure ? (
        <ErrorNotice message={task.runtime_failure} />
      ) : null}
      {task.interventions
        .filter((item) => item.status === "open")
        .map((item) => (
          <Card key={String(item.intervention_id)} title="任务等你处理">
            <p>{detailsText(item, task)}</p>
            <div className="task-actions">
              {[
                ["continue", "继续任务"],
                ["skip", "跳过此项"],
                ["cancel", "取消任务"],
              ].map(([resolution, label]) => (
                <Button
                  key={resolution}
                  onPress={async () => {
                    await api.request(
                      `/api/v1/jobs/${encodeURIComponent(id)}/interventions/${encodeURIComponent(String(item.intervention_id))}/resolve`,
                      { resolution },
                    );
                    await refresh();
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
            <TechDetails>
              <pre>{JSON.stringify(item, null, 2)}</pre>
            </TechDetails>
          </Card>
        ))}
      <TaskSummary task={task} />
      {task.source_results && acquisitionTask(task.job) ? (
        task.source_results.pdf ? (
          <Disclosure title="渠道表现">
            <SourceResults value={task.source_results} />
          </Disclosure>
        ) : (
          <SourceResults value={task.source_results} />
        )
      ) : null}
      <TaskSessions id={id} />
      {processor &&
      collection &&
      typeof collection.collection_id === "string" ? (
        <Card title="处理结果">
          <p>
            新生成 {count(collection, "computed")} 项 / 复用{" "}
            {count(collection, "reused")} 项 · 部分覆盖{" "}
            {count(collection, "partial")} 项 · 未形成结果{" "}
            {count(collection, "failed")} 项
          </p>
          <Button
            onPress={() =>
              navigate(
                {
                  view: "ext",
                  collection: String(collection.collection_id),
                  task: id,
                },
                { clearSource: true },
              )
            }
          >
            查看本次结果
          </Button>
        </Card>
      ) : processor && terminal(status) ? (
        <p>
          {detail.isFetching
            ? "执行状态已更新，正在等待结果集合发布…"
            : "暂未取得结果集合。可刷新任务核对，已保存的逐项结果仍可读取。"}
        </p>
      ) : null}
      <TaskRun id={id} targets={!task.acquisition_traces?.length} />
      {task.partial_results.length ? (
        <Disclosure
          title={`此前尝试的部分结果 ${task.partial_results.length} 项`}
          defaultExpanded={!task.results.length}
        >
          {task.partial_results.map((result, index) => (
            <ResultLink key={index} result={result} task={task} id={id} />
          ))}
        </Disclosure>
      ) : null}
      {task.results.map((result, index) => (
        <ResultLink key={index} result={result} task={task} id={id} />
      ))}
      {[
        ["未处理", task.skipped],
        ["失败", task.failures],
      ].map(([label, values]) => {
        const list = values as readonly JsonRecord[];
        return list.length ? (
          <Disclosure
            key={String(label)}
            title={`${label} ${list.length} 项`}
            defaultExpanded={label === "失败"}
          >
            {list.map((value, index) => (
              <div key={index}>
                <p>{detailsText(value, task)}</p>
                {[
                  "knowledge-unconfigured",
                  "agent-role-unconfigured",
                  "agent-unconfigured",
                  "agent-configuration",
                ].some((code) =>
                  JSON.stringify(value).includes(`"${code}"`),
                ) ? (
                  <>
                    <p>
                      分析模型尚未配置或配置不可用。请在设置中配置模型与角色，保存并重启
                      Web 后，再回到此任务重试。直接重试不会修复配置。
                    </p>
                    <Button
                      onPress={() =>
                        navigate({ view: "set", setting: "models" })
                      }
                    >
                      前往模型设置
                    </Button>
                  </>
                ) : null}
                <TechDetails>
                  <pre>{JSON.stringify(value, null, 2)}</pre>
                </TechDetails>
              </div>
            ))}
          </Disclosure>
        ) : null;
      })}
      {!task.targets.length && !task.results.length ? (
        <EmptyState title="任务尚未形成逐项结果" />
      ) : null}
      <Disclosure
        title={`技术活动记录${task.events_truncated ? "（较早记录已省略）" : ""}`}
      >
        <ol className="task-events">
          {task.events.map((event, index) => (
            <li key={index}>
              <LocalTime value={event.created_at ?? event.timestamp} />
              <p>{String(event.kind ?? event.type)}</p>
              <TechDetails>
                <pre>{JSON.stringify(event.payload ?? event, null, 2)}</pre>
              </TechDetails>
            </li>
          ))}
        </ol>
      </Disclosure>
      <TechDetails copyText={id}>
        <p>任务编号：{id}</p>
        {!processor && task.budget && task.policy ? (
          <p>
            重试策略 {String(task.policy.mode)} · 尝试{" "}
            {String(task.budget.attempts)} / {String(task.budget.max_attempts)}{" "}
            · 模型调用 {String(task.budget.model_calls)} /{" "}
            {String(task.budget.max_model_calls)}
          </p>
        ) : null}
        <pre>{JSON.stringify(task.results, null, 2)}</pre>
      </TechDetails>
    </div>
  );
}
function count(value: JsonRecord, key: string) {
  const total = value[key];
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
    throw new Error("处理结果计数无效");
  return total;
}
function ResultLink({
  result,
  task,
  id,
}: {
  result: JsonRecord;
  task: TaskDetail;
  id: string;
}) {
  const shell = useShell(),
    saved = record(result.result, "processing result"),
    target = task.targets.find((item) => item.target_id === result.target_id),
    literature = target ? taskLiteratureId(task.job, target) : null;
  if (
    result.operation === "run-processor" &&
    typeof saved.result_id === "string" &&
    typeof saved.content_sha256 === "string"
  )
    return (
      <Button
        onPress={() =>
          navigate(
            {
              view: "ext",
              result: String(saved.result_id),
              resultHash: String(saved.content_sha256),
              task: id,
            },
            { clearSource: true },
          )
        }
      >
        打开处理结果摘要
      </Button>
    );
  const parse = result.operation === "parse-documents";
  return (
    <div>
      {parse && Array.isArray(saved.profiles) ? (
        <div>
          <p>各种解析方式的结果如下。生成全文需要另行发起。</p>
          <ul>
            {saved.profiles.map((item, i) => {
              const p = record(item, "parsing profile");
              return (
                <li key={i}>
                  {String(p.profile)}：
                  {p.status === "failed"
                    ? String(p.failure_code)
                    : p.status === "reused"
                      ? "已复用"
                      : "已保存"}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {typeof saved.artifact_id === "string" ||
      (literature && typeof saved.document_version_id === "string") ? (
        <Button
          onPress={() => {
            if (result.operation === "synthesize")
              navigate(
                { view: "syn", artifact: String(saved.artifact_id) },
                { clearSource: true },
              );
            else if (literature)
              shell.openPaper(literature, parse ? "doc" : "know", {
                task: id,
                ...(parse
                  ? { document: String(saved.document_version_id) }
                  : { knowledge: String(saved.artifact_id) }),
              });
          }}
        >
          打开{operationLabels[String(result.operation)] ?? "加工"}结果
        </Button>
      ) : null}
    </div>
  );
}
