import { TaskRun } from "./TaskRun.js";
import { useState } from "react";
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
  Disclosure,
  EmptyState,
  ErrorNotice,
  ListRow,
  MasterDetail,
  MasterItem,
  PageHeader,
  SearchField,
  Skeleton,
  Tabs,
  TechDetails,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { navigate, useUrlState } from "../../data/url.js";
import { useShell } from "../../shell/context.js";
import { errorMessage, localTime } from "../../strings.js";
import { jobRecord, record, type JsonRecord } from "../../data/wire.js";
import {
  parseTaskDetail,
  taskTitle,
  taskStatusLabel,
  taskLiteratureId,
  operationLabels,
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
  if (api.kind !== "workspace")
    return (
      <EmptyState
        title="此入口不提供持久任务控制"
        description="请使用完整 Web 工作台查看运行中的任务。"
      />
    );
  return (
    <section className="tasks-page">
      <PageHeader
        title="任务"
        description="查看已启动的操作、结果与失败。已接纳的材料会保留在文献库。"
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
      <MasterDetail
        label="任务列表"
        toolbar={
          <>
            <Tabs
              label="任务状态"
              value={group}
              onChange={setGroup}
              items={[
                { id: "", label: "全部" },
                { id: "active", label: "进行中" },
                { id: "attention", label: "待处理" },
                { id: "ended", label: "已结束" },
              ]}
            />
            <SearchField
              label="筛选任务"
              value={text}
              onChange={setText}
              placeholder="任务名称或编号"
            />
            <div role="status" className="ui-description">
              已显示 {items.length} 个任务
              {text ? `，符合筛选 ${filtered.length} 个` : ""}
            </div>
          </>
        }
        list={
          <div className="tasks-list">
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
            {filtered.map((job) => (
              <div key={String(job.job_id)} data-task-id={String(job.job_id)}>
                <MasterItem
                  selected={selected === String(job.job_id)}
                  title={taskTitle(job)}
                  meta={formatDate(job.created_at)}
                  badge={<TaskBadge status={job.status} />}
                  onPress={() => navigate({ task: String(job.job_id) })}
                />
              </div>
            ))}
            {!jobs.isPending && !filtered.length ? (
              <EmptyState
                title={text ? "没有符合筛选的任务" : "当前没有任务"}
                description="从文献库选择材料并启动处理后，可以在这里查看进度。"
              />
            ) : null}
          </div>
        }
        footer={
          jobs.hasNextPage ? (
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
          ) : undefined
        }
        detail={
          selected ? (
            <section className="task-detail-pane" aria-label="任务详情">
              <TaskDetails key={selected} id={selected} />
            </section>
          ) : (
            <EmptyState
              title="选择一个任务"
              description="查看它的进度、逐篇结果与失败原因。"
            />
          )
        }
      />
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
