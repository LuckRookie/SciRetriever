import { TaskRun } from "./TaskRun.js";
import { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueries,
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
  ListRow,
  PageHeader,
  SearchField,
  Skeleton,
  TechDetails,
  RichTitle,
} from "../../components/index.js";
import { archiveQuery, rows } from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { navigate, useUrlState } from "../../data/url.js";
import { useShell } from "../../shell/context.js";
import { RunSwitch, useActiveTaskCount } from "./RunSwitch.js";
import {
  agentRoleName,
  errorMessage,
  localTime,
  statusLabels,
} from "../../strings.js";
import { jobRecord, record, type JsonRecord } from "../../data/wire.js";
import {
  parseTaskDetail,
  taskTitle,
  taskStatusLabel,
  taskLiteratureId,
  operationLabels,
  type TaskDetail,
} from "../../data/tasks.js";
import { paperTitleParts, readLiterature } from "../../data/library.js";
import {
  attemptsDetail,
  attemptsLine,
} from "../../data/acquisition-wording.js";
import type { AcquisitionTaskTrace } from "@sciretriever/contracts";
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
export function TaskBadge({ status }: { status: unknown }) {
  const value = String(status);
  return (
    <Badge
      status={
        value === "running"
          ? "running"
          : value === "completed"
            ? "completed"
            : ["failed", "interrupted"].includes(value)
              ? "failed"
              : value === "paused"
                ? "partial"
                : "metadata"
      }
    >
      {taskStatusLabel[value] ?? value}
    </Badge>
  );
}
export function ActivityList({ onSelect }: { onSelect: (id: string) => void }) {
  const api = useApi();
  const groups = [
    { id: "active", title: "进行中" },
    { id: "attention", title: "待处理" },
    { id: "ended", title: "最近结束" },
  ];
  const results = useQueries({
    queries: groups.map((group) => ({
      queryKey: ["tasks", "activity-group", group.id],
      staleTime: 0,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const value = await api.read(
          `/api/tasks?limit=${group.id === "ended" ? 20 : 100}&status_group=${group.id}`,
          signal,
        );
        if (!Array.isArray(value.tasks)) throw new Error("任务列表回执无效");
        return value.tasks.map(jobRecord);
      },
      refetchInterval: 5000,
      enabled: api.kind === "workspace",
    })),
  });
  return (
    <div className="activity-task-list">
      {groups.map((group, index) => {
        const result = results[index]!;
        return (
          <section key={group.id}>
            <h3>{group.title}</h3>
            {result.isPending ? (
              <Skeleton rows={1} />
            ) : result.isError ? (
              <ErrorNotice
                message={errorMessage(result.error)}
                onRetry={async () => {
                  await result.refetch();
                }}
              />
            ) : null}
            {result.data?.length ? (
              result.data.map((job) => (
                <div key={String(job.job_id)} data-task-id={String(job.job_id)}>
                  <ListRow
                    title={taskTitle(job)}
                    bibliography={formatDate(job.created_at)}
                    badge={<TaskBadge status={job.status} />}
                    onPress={() => onSelect(String(job.job_id))}
                  />
                </div>
              ))
            ) : !result.isPending && !result.isError ? (
              <p className="ui-description">暂无任务</p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
export default function Tasks() {
  const api = useApi(),
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
    refetchInterval: 5000,
    enabled: api.kind === "workspace",
  });
  const items = [
    ...new Map(
      jobs.data?.pages
        .flatMap((page) => page.items)
        .map((job) => [String(job.job_id), job]),
    ).values(),
  ];
  const filtered = items.filter((job) =>
    `${taskTitle(job)} ${String(job.job_id)}`
      .toLocaleLowerCase()
      .includes(text.toLocaleLowerCase()),
  );
  const selected = route.parameters.get("task");
  const running = useActiveTaskCount();
  if (api.kind !== "workspace")
    return (
      <EmptyState
        title="此入口不提供持久任务控制"
        description="请使用完整 Web 工作台查看运行中的任务。"
      />
    );
  return (
    <section className="tasks-page" data-panel={selected ? "open" : undefined}>
      <PageHeader
        title="任务"
        count={running ? `${running} 个进行中` : undefined}
        action={
          <Button
            onPress={async () => {
              await jobs.refetch();
            }}
          >
            刷新任务
          </Button>
        }
      />
      <RunSwitch value="task" />
      <div className="tasks-toolbar">
        <ChipGroup label="任务状态">
          {[
            { id: "", label: "全部" },
            { id: "active", label: "进行中" },
            { id: "attention", label: "待处理" },
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
              <th scope="col">发起方</th>
              <th scope="col">进度</th>
              <th scope="col">状态</th>
              <th scope="col">开始</th>
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
                      {taskTitle(job)}
                    </button>
                  </td>
                  <td>
                    {job.actor_label || job.actor ? (
                      String(job.actor_label ?? job.actor)
                    ) : (
                      <span className="task-empty">—</span>
                    )}
                  </td>
                  <td>
                    <TaskProgress job={job} />
                  </td>
                  <td>
                    <TaskBadge status={job.status} />
                  </td>
                  <td className="task-time">{formatDate(job.created_at)}</td>
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
    </section>
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
/** Shown only when the list reports a total; otherwise the processed count. */
function TaskProgress({ job }: { job: JsonRecord }) {
  const progress =
    job.progress && typeof job.progress === "object"
      ? (job.progress as JsonRecord)
      : null;
  const total = Number(progress?.total),
    done = Number(progress?.done);
  if (!progress || !Number.isFinite(done))
    return <span className="task-time task-empty">—</span>;
  if (!Number.isFinite(total) || total <= 0)
    return <span className="task-time">已处理 {done}</span>;
  return (
    <span className="task-progress">
      <span className="task-progress-track" aria-hidden="true">
        <i style={{ width: `${Math.min(100, (done / total) * 100)}%` }} />
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
    refetchInterval: 5000,
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
              {localTime(s.started_at)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
function formatDate(value: unknown) {
  return localTime(value);
}
function detailsText(value: JsonRecord): string {
  for (const name of ["reason", "message", "detail", "code", "kind", "status"])
    if (typeof value[name] === "string")
      return errorMessage(new Error(String(value[name])));
  return "详细信息已保留，可展开查看。";
}
export function TaskDetails({ id }: { id: string }) {
  const api = useApi(),
    queries = useQueryClient();
  const detail = useQuery({
    queryKey: ["tasks", "detail", id],
    queryFn: async ({ signal }) =>
      parseTaskDetail(
        await api.read(`/api/tasks/${encodeURIComponent(id)}`, signal),
      ),
    refetchInterval: (query) => {
      const task = query.state.data;
      if (!task) return false;
      if (!terminal(task.job.status)) return 2000;
      return isProcessor(task) &&
        !task.collections.length &&
        query.state.dataUpdateCount < 5
        ? 2000
        : false;
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
  const actions = [
    ...(status === "queued" ? ["start"] : []),
    ...(["queued", "running"].includes(status) ? ["pause"] : []),
    ...(["paused", "interrupted"].includes(status) ? ["resume"] : []),
    ...(["failed", "interrupted"].includes(status) ||
    (status === "completed" &&
      task.failures.length > 0 &&
      task.targets.some((target) => target.stage === "skipped"))
      ? ["retry"]
      : []),
    ...(!["completed", "cancelled"].includes(status) ? ["cancel"] : []),
  ];
  const labels: Record<string, string> = {
    start: "启动",
    pause: "暂停",
    resume: "继续",
    retry: "重试",
    cancel: "取消任务",
  };
  const refresh = async () => {
    await queries.invalidateQueries({ queryKey: ["tasks"] });
  };
  const collection = task.collections.at(-1);
  return (
    <div className="task-detail">
      <h2>{taskTitle(task.job)}</h2>
      <TaskBadge status={status} />
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
            onPress={async () => {
              await api.request(
                `/api/tasks/${encodeURIComponent(id)}/${action}`,
                {},
              );
              await refresh();
            }}
          >
            {labels[action]}
          </Button>
        ))}
      </div>
      <TaskSessions id={id} />
      <p>
        {task.targets.filter((target) => target.stage === "completed").length} /{" "}
        {task.targets.length} 项已完成
      </p>
      {!processor && task.budget && task.policy ? (
        <p className="ui-description">
          策略：{String(task.policy.mode)} · 已尝试{" "}
          {String(task.budget.attempts)} / {String(task.budget.max_attempts)} ·
          模型调用 {String(task.budget.model_calls)} /{" "}
          {String(task.budget.max_model_calls)}
        </p>
      ) : null}
      {task.runtime_failure ? (
        <ErrorNotice message={task.runtime_failure} />
      ) : null}
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
      {task.interventions
        .filter((item) => item.status === "open")
        .map((item) => (
          <Card key={String(item.intervention_id)} title="任务等待处理">
            <p>{detailsText(item)}</p>
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
      <TaskRun id={id} />
      {task.acquisition_traces?.length ? (
        <Disclosure
          title={`获取经过 ${task.acquisition_traces.length} 篇${task.acquisition_traces_truncated ? "（较早记录已省略）" : ""}`}
          defaultExpanded
        >
          <ul className="task-traces">
            {task.acquisition_traces.map((trace) => (
              <TraceRow key={trace.attempt_id} trace={trace} />
            ))}
          </ul>
        </Disclosure>
      ) : null}
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
                <p>{detailsText(value)}</p>
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
              <time>{formatDate(event.created_at ?? event.timestamp)}</time>
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
/** Which sources one paper went through, in order, before it got (or missed) its PDF. */
function TraceRow({ trace }: { trace: AcquisitionTaskTrace }) {
  const api = useApi(),
    shell = useShell();
  const detail = useQuery({
    queryKey: ["literature", trace.literature_id],
    queryFn: ({ signal }) => readLiterature(api, trace.literature_id, signal),
  });
  return (
    <li>
      <Button
        variant="text"
        size="compact"
        onPress={() => shell.openPaper(trace.literature_id, "pdf")}
      >
        {detail.data ? (
          <RichTitle parts={paperTitleParts(detail.data)} />
        ) : (
          trace.literature_id
        )}
      </Button>
      <p className="task-trace-line" title={attemptsDetail(trace.attempts)}>
        {attemptsLine(trace.attempts) || "没有记录到来源尝试"}
        {trace.truncated ? " · 更早的尝试已省略" : ""}
      </p>
    </li>
  );
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
          <p>各模式的解析结果如下。建档需要另行发起。</p>
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
