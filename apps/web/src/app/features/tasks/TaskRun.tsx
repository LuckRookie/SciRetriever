import { useInfiniteQuery } from "@tanstack/react-query";
import { Button, ErrorNotice, Skeleton } from "../../components/index.js";
import { archiveQuery, rows } from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { record } from "../../data/wire.js";
import { navigate } from "../../data/url.js";
import {
  archiveReason,
  archiveStrings,
  errorMessage,
  processorName,
  statusLabels,
  processorMapStatus,
  skipReasons,
} from "../../strings.js";
import { targetStatusLabel } from "../../data/tasks.js";

/**
 * Who started the run and what it cost, then each target's own progress.
 * `targets={false}` keeps only the first line, for tasks whose per-paper
 * results are already listed by the summary.
 */
export function TaskRun({
  id,
  targets = true,
}: {
  id: string;
  targets?: boolean;
}) {
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
  const calls = Number(usage.calls);
  return (
    <section aria-label="逐篇运行过程" className="task-run">
      <p className="task-run-facts">
        由「{String(job.actor_label ?? job.actor ?? "历史记录未保存身份")}」发起
        {calls
          ? ` · 模型调用 ${calls.toLocaleString()} 次，输入 ${Number(usage.input_tokens).toLocaleString()} / 输出 ${Number(usage.output_tokens).toLocaleString()} token`
          : " · 没有调用模型"}
      </p>
      {targets &&
        query
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
              <article key={String(item.target_id)} className="task-run-item">
                <h4>
                  {literatures[0]?.title
                    ? String(literatures[0].title)
                    : item.processor
                      ? processorName(String(item.processor))
                      : "文献处理"}
                </h4>
                <p>
                  {result?.reused
                    ? "复用已有结果"
                    : result
                      ? "新计算完成"
                      : (targetStatusLabel(item.status) ?? "处理中")}
                  {Number(item.literature_count) > 1
                    ? ` · ${item.literature_count} 篇文献`
                    : ""}
                </p>
                {typeof item.skipped_because === "string" ? (
                  <p className="task-run-reason">
                    {skipReasons[item.skipped_because] ??
                      archiveReason(item.skipped_because)}
                  </p>
                ) : null}
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
                {/* Archive steps are the paper's current ones; a skipped item made none. */}
                {item.archive && item.status !== "skipped" ? (
                  <ArchiveSteps value={record(item.archive, "archive steps")} />
                ) : steps.length ? (
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
                {!item.synthesis && Number(u.calls) > 0 ? (
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
                        : "查看需处理的问题"}
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
              </article>
            );
          })}
      {targets && query.hasNextPage ? (
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

const ARCHIVE_ORDER = [
  // Parsing is the first step; a part with a parse already reuses it (Owner 2026-10-30).
  "parse",
  "arrange",
  "proofread",
  "render",
  "metadata",
  "references",
  "tags",
];
const stepStatus: Readonly<Record<string, string>> = {
  done: "完成",
  running: "进行中",
  pending: "等待",
  unavailable: "暂不可用",
  failed: "停下",
};
/** Flow X steps for one paper: page progress, actual usage and why a step stopped. */
function ArchiveSteps({ value }: { value: Record<string, unknown> }) {
  const all = rows(value, "steps"),
    assets = [...new Set(all.map((s) => String(s.asset_id)))];
  return (
    <>
      {assets.map((asset, index) => (
        <ol
          key={asset}
          className="task-step-list archive-run-steps"
          aria-label={
            assets.length > 1
              ? `材料 ${index + 1} 生成全文的步骤`
              : "生成全文的步骤"
          }
        >
          {ARCHIVE_ORDER.map((step) => {
            const s = all.find((r) => r.asset_id === asset && r.step === step);
            const pages = s?.pages ? record(s.pages, "pages") : null,
              usage = s?.usage ? record(s.usage, "usage") : null,
              stop = s?.stop ? record(s.stop, "stop") : null;
            return (
              <li key={step} data-status={String(s?.status ?? "pending")}>
                <strong>
                  {
                    archiveStrings.steps[
                      step as keyof typeof archiveStrings.steps
                    ]
                  }
                </strong>{" "}
                ·{" "}
                {step === "parse" && !s && all.some((r) => r.asset_id === asset)
                  ? "复用已有解析"
                  : (stepStatus[String(s?.status ?? "pending")] ?? "停下")}
                {pages && Number(pages.unreviewed) > 0 ? (
                  <span>
                    {" "}
                    · 长文档，未逐页校对（{Number(pages.unreviewed)} 页）
                    {Number(pages.accepted)
                      ? `，${Number(pages.accepted)} 页已校对`
                      : ""}
                  </span>
                ) : pages && Number(pages.required) > 0 ? (
                  <span>
                    {" "}
                    · {Number(pages.accepted)} / {Number(pages.required)} 页
                    {Number(pages.failed)
                      ? `，${Number(pages.failed)} 页停下`
                      : ""}
                  </span>
                ) : null}
                {usage && Number(usage.calls) > 0 ? (
                  <span className="ui-description">
                    {" "}
                    · {Number(usage.calls)} 次调用 · 输入{" "}
                    {usage.input_tokens == null
                      ? "未报告"
                      : Number(usage.input_tokens).toLocaleString()}{" "}
                    / 输出{" "}
                    {usage.output_tokens == null
                      ? "未报告"
                      : Number(usage.output_tokens).toLocaleString()}{" "}
                    token
                  </span>
                ) : null}
                {stop ? <StopReason stop={stop} /> : null}
                {!stop && s?.status === "failed" && s.reason ? (
                  <p>{archiveReason(String(s.reason))}</p>
                ) : null}
              </li>
            );
          })}
        </ol>
      ))}
    </>
  );
}
function StopReason({ stop }: { stop: Record<string, unknown> }) {
  const validation = stop.validation
      ? record(stop.validation, "validation")
      : null,
    progress = stop.progress ? record(stop.progress, "progress") : null;
  return (
    <p className="archive-stop">
      停下原因：{archiveReason(String(stop.code))}
      {typeof stop.page_index === "number"
        ? `（第 ${stop.page_index + 1} 页）`
        : ""}
      {validation
        ? `。同一错误连续 ${Number(validation.consecutive)} 次，达到 ${Number(validation.threshold)} 次即停。`
        : progress
          ? `。连续 ${Number(progress.consecutive_calls)} 次调用没有进展，达到 ${Number(progress.threshold)} 次即停。`
          : "。"}
      {stop.retryable ? "可以继续生成全文。" : ""}
    </p>
  );
}
