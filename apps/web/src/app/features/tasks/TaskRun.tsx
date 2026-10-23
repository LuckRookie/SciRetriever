import { useInfiniteQuery } from "@tanstack/react-query";
import { Button, Card, ErrorNotice, Skeleton } from "../../components/index.js";
import { archiveQuery, rows } from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { record } from "../../data/wire.js";
import { navigate } from "../../data/url.js";
import {
  archiveStrings,
  errorMessage,
  processorName,
  statusLabels,
  processorMapStatus,
  localTime,
} from "../../strings.js";
import { taskStatusLabel } from "../../data/tasks.js";

export function TaskRun({ id }: { id: string }) {
  const api = useApi();
  const query = useInfiniteQuery({
    queryKey: ["tasks", "run", id],
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const value = await archiveQuery(
        api,
        "task-run",
        { job_id: id, offset: pageParam, limit: 50 },
        signal,
      );
      return value === null ? null : record(value, "task run");
    },
    getNextPageParam: (p) =>
      typeof p?.next_offset === "number" ? p.next_offset : undefined,
  });
  if (query.isPending) return <Skeleton label="正在读取运行过程" />;
  if (query.error) return <ErrorNotice message={errorMessage(query.error)} />;
  const first = query.data?.pages[0];
  if (!first) return <p>找不到这次运行。</p>;
  const job = record(first.job, "job"),
    usage = record(first.usage, "usage");
  return (
    <section aria-label="逐篇运行过程" className="task-run">
      <p>
        发起会话：
        {String(job.actor_label ?? job.actor ?? "历史记录未保存身份")}
      </p>
      <p>
        {localTime(job.created_at)}
        {job.finished_at ? ` 至 ${localTime(job.finished_at)}` : " · 尚未结束"}
      </p>
      <p>
        本次累计 {Number(usage.calls)} 次调用 · 输入{" "}
        {Number(usage.input_tokens).toLocaleString()} / 输出{" "}
        {Number(usage.output_tokens).toLocaleString()} token
      </p>
      {query
        .data!.pages.flatMap((p) => (p ? rows(p) : []))
        .map((item) => {
          const literatures = rows(item, "literatures"),
            steps = rows(item, "steps"),
            sessions = rows(item, "sessions"),
            u = record(item.usage, "usage"),
            result = item.result ? record(item.result, "result") : null;
          const failure = item.failure,
            code =
              typeof failure === "string"
                ? failure
                : failure && typeof failure === "object" && "code" in failure
                  ? String(failure.code)
                  : "processing-failed";
          return (
            <Card
              key={String(item.target_id)}
              title={
                literatures[0]?.title
                  ? String(literatures[0].title)
                  : item.processor
                    ? processorName(String(item.processor))
                    : "文献处理"
              }
            >
              <p>
                {result?.reused
                  ? "复用已有结果"
                  : result
                    ? "新计算完成"
                    : (taskStatusLabel[String(item.status)] ?? "处理中")}
                {Number(item.literature_count) > 1
                  ? ` · ${item.literature_count} 篇文献`
                  : ""}
              </p>
              {item.synthesis ? (
                <MappedPapers id={id} target={String(item.target_id)} />
              ) : null}
              {item.aggregate_usage ? (
                <p className="ui-description">
                  汇总阶段：输入{" "}
                  {Number(
                    record(item.aggregate_usage, "aggregate").input_tokens,
                  ).toLocaleString()}{" "}
                  / 输出{" "}
                  {Number(
                    record(item.aggregate_usage, "aggregate").output_tokens,
                  ).toLocaleString()}{" "}
                  token
                </p>
              ) : null}
              {steps.length ? (
                <ol className="task-step-list">
                  {steps.map((s) => (
                    <li key={`${s.asset_id}:${s.step}`}>
                      <strong>
                        {archiveStrings.steps[
                          String(s.step) as keyof typeof archiveStrings.steps
                        ] ?? "处理"}
                      </strong>{" "}
                      ·{" "}
                      {s.status === "done"
                        ? "完成"
                        : s.status === "running"
                          ? "进行中"
                          : s.status === "pending"
                            ? "等待"
                            : s.status === "unavailable"
                              ? "暂不可用"
                              : "失败"}
                      {s.reason ? (
                        <p>{errorMessage(new Error(String(s.reason)))}</p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : null}
              {!item.synthesis ? (
                <p className="ui-description">
                  {Number(u.calls)} 次调用 · 输入{" "}
                  {Number(u.input_tokens).toLocaleString()} / 输出{" "}
                  {Number(u.output_tokens).toLocaleString()} token
                </p>
              ) : null}
              {sessions.slice(0, 1).map((s) => {
                const subject = record(s.subject, "subject");
                return typeof subject.page === "number" ? (
                  <p key={String(s.session_id)}>
                    校订：第 {subject.page + 1} 页
                    {typeof subject.page_count === "number"
                      ? ` / 共 ${subject.page_count} 页`
                      : ""}
                  </p>
                ) : null;
              })}
              {failure ? (
                <div>
                  <p>{errorMessage(new Error(code))}</p>
                  <Button
                    onPress={() =>
                      navigate({
                        view: /config|unconfigured/.test(code)
                          ? "set"
                          : "archive",
                        literature: null,
                      })
                    }
                  >
                    {/config|unconfigured/.test(code)
                      ? "前往设置"
                      : "查看建档问题"}
                  </Button>
                </div>
              ) : null}
              <div className="task-actions">
                {literatures.map((l) => (
                  <Button
                    key={String(l.literature_id)}
                    onPress={() =>
                      navigate(
                        {
                          view: "lib",
                          literature: String(l.literature_id),
                          reader: "doc",
                          task: id,
                        },
                        { clearSource: true },
                      )
                    }
                  >
                    {literatures.length === 1
                      ? "打开文献"
                      : String(l.title ?? "打开来源文献")}
                  </Button>
                ))}
                {result ? (
                  <Button
                    onPress={() =>
                      navigate(
                        {
                          view: "ext",
                          results: "all",
                          result: String(result.result_id),
                          resultHash: String(result.content_sha256),
                          literature: null,
                        },
                        { clearSource: true },
                      )
                    }
                  >
                    打开结果
                  </Button>
                ) : null}
                {sessions.map((s) => (
                  <Button
                    key={String(s.session_id)}
                    onPress={() =>
                      navigate(
                        {
                          view: "agent",
                          agentSession: String(s.session_id),
                          agentStatus: "all",
                          literature: null,
                        },
                        { clearSource: true },
                      )
                    }
                  >
                    查看 Agent 过程 ·{" "}
                    {statusLabels[String(s.status)] ?? "处理中"}
                  </Button>
                ))}
              </div>
            </Card>
          );
        })}
      {query.hasNextPage ? (
        <Button
          isPending={query.isFetchingNextPage}
          onPress={() => query.fetchNextPage().then(() => {})}
        >
          继续查看文献进度
        </Button>
      ) : null}
    </section>
  );
}

function MappedPapers({ id, target }: { id: string; target: string }) {
  const api = useApi();
  const query = useInfiniteQuery({
    queryKey: ["tasks", "mapped-papers", id, target],
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const response = await archiveQuery(
        api,
        "task-run",
        {
          job_id: id,
          target_id: target,
          member_offset: pageParam,
          member_limit: 20,
        },
        signal,
      );
      return response ? (rows(response)[0] ?? null) : null;
    },
    getNextPageParam: (page) =>
      typeof page?.next_member_offset === "number"
        ? page.next_member_offset
        : undefined,
  });
  return (
    <section aria-label="综合逐篇进度">
      <h3>逐篇读取</h3>
      {query.isPending ? <Skeleton rows={2} /> : null}
      {query.error ? <ErrorNotice message={errorMessage(query.error)} /> : null}
      {query.data?.pages
        .flatMap((p) => (p ? rows(p, "mapped_members") : []))
        .map((p) => {
          const usage = record(p.usage, "usage"),
            result = p.result ? record(p.result, "result") : null;
          return (
            <article key={String(p.literature_id)} className="mapped-paper">
              <strong>{String(p.title ?? "未命名文献")}</strong>
              <p>
                {processorMapStatus(String(p.status))} · 本任务此篇{" "}
                {Number(usage.calls)} 次调用 · 输入{" "}
                {Number(usage.input_tokens).toLocaleString()} / 输出{" "}
                {Number(usage.output_tokens).toLocaleString()} token
              </p>
              <div className="form-actions">
                <Button
                  onPress={() =>
                    navigate(
                      {
                        view: "lib",
                        literature: String(p.literature_id),
                        reader: "doc",
                        task: id,
                      },
                      { clearSource: true },
                    )
                  }
                >
                  打开文献
                </Button>
                {result ? (
                  <Button
                    onPress={() =>
                      navigate(
                        {
                          view: "ext",
                          literature: null,
                          result: String(result.result_id),
                          resultHash: String(result.content_sha256),
                          focusLiterature: String(p.literature_id),
                        },
                        { clearSource: true },
                      )
                    }
                  >
                    打开单篇结果
                  </Button>
                ) : null}
              </div>
            </article>
          );
        })}
      {query.hasNextPage ? (
        <Button
          isPending={query.isFetchingNextPage}
          onPress={() => query.fetchNextPage().then(() => {})}
        >
          继续查看逐篇进度
        </Button>
      ) : null}
    </section>
  );
}
