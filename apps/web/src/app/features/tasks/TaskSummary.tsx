import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  AcquisitionAttempt,
  AcquisitionTaskTrace,
} from "@sciretriever/contracts";
import { Button, RichTitle } from "../../components/index.js";
import {
  attemptsDetail,
  attemptsLine,
  sourceName,
} from "../../data/acquisition-wording.js";
import { paperTitleParts, readLiterature } from "../../data/library.js";
import { useApi } from "../../data/query.js";
import {
  taskNotStarted,
  taskScope,
  type TaskDetail,
} from "../../data/tasks.js";
import { useShell } from "../../shell/context.js";
import { localTime, shortTime } from "../../strings.js";
import { problemText } from "../sources/problem.js";
import { CitationScope, TaskScope } from "./TaskScope.js";
import { CitationSources } from "./CitationSources.js";

const count = new Intl.NumberFormat("zh-CN");
const TERMINAL = ["completed", "cancelled", "failed", "interrupted"];

/** “38 秒”, “4 分 7 秒”, “1 小时 3 分”: as precise as a person needs. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 1) return "不到 1 秒";
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} 分 ${s % 60} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
}
const time = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
};
/**
 * “11月19日 13:27 – 13:31” by rule 6, with the date written once when both
 * ends share it; the full times on hover.
 */
function span(start: string, end: string | null) {
  const a = new Date(start),
    b = end ? new Date(end) : null;
  if (Number.isNaN(a.getTime())) return null;
  if (!b || Number.isNaN(b.getTime()))
    return { text: `${shortTime(start)} 开始`, full: localTime(start) };
  return {
    text:
      a.toDateString() === b.toDateString()
        ? `${shortTime(start)} – ${time(end!)}`
        : `${shortTime(start)} – ${shortTime(end)}`,
    full: `${localTime(start)} – ${localTime(end)}`,
  };
}
/** A running task's elapsed time moves once a second; a finished one stays still. */
function useNow(running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

interface PaperOutcome {
  readonly trace: AcquisitionTaskTrace;
  readonly source: string | null;
  readonly reason: string | null;
  readonly ms: number;
}
/** What one paper ended with: the source that delivered it, or why nothing did. */
function outcome(trace: AcquisitionTaskTrace): PaperOutcome {
  const attempts = trace.attempts;
  const hit = attempts.find((a) => a.result === "hit");
  const started = Math.min(...attempts.map((a) => Date.parse(a.started_at))),
    finished = Math.max(...attempts.map((a) => Date.parse(a.finished_at)));
  const failure = [...attempts]
    .reverse()
    .find(
      (a: AcquisitionAttempt) => a.problem && a.problem.display !== "error",
    );
  return {
    trace,
    source: hit ? hit.source : null,
    reason: hit
      ? null
      : failure?.problem
        ? problemText(failure.problem.display)
        : attempts.length
          ? "各渠道都没有拿到"
          : "没有记录到尝试",
    ms: attempts.length ? finished - started : NaN,
  };
}
/** Channels as ink shades, darkest for the one that delivered most. */
const SHADES = [0.72, 0.52, 0.38, 0.28, 0.2];

/**
 * The first thing a task's details answer: how it went, how long it took and
 * where the results came from. Process detail follows below it.
 */
export function TaskSummary({ task }: { task: TaskDetail }) {
  const status = String(task.job.status),
    // A task nobody started has not used any time yet (page specs “任务”).
    idle = taskNotStarted({ status, start_requested: task.start_requested }),
    running = !idle && !TERMINAL.includes(status);
  const now = useNow(running);
  const created = String(task.job.created_at ?? ""),
    finished =
      typeof task.job.finished_at === "string" ? task.job.finished_at : null;
  const elapsed = (finished ? Date.parse(finished) : now) - Date.parse(created);
  const when = created ? span(created, finished) : null;
  const pdf =
    task.source_results?.availability !== "unrecorded"
      ? task.source_results?.pdf
      : undefined;
  const papers = (task.acquisition_traces ?? []).map(outcome);
  const done = task.targets.filter((t) => t.stage === "completed").length,
    failed = task.targets.filter((t) => t.stage === "failed").length,
    skipped = task.targets.filter((t) => t.stage === "skipped").length,
    total = task.targets.length;
  return (
    <section className="task-summary" aria-label="本次任务">
      <p className="task-summary-time">
        {idle ? (
          <>
            未启动
            {created ? (
              <span title={localTime(created)}>
                {" "}
                · {shortTime(created)} 创建
              </span>
            ) : null}
          </>
        ) : (
          <>
            {running
              ? `已用时 ${duration(elapsed)}`
              : `用时 ${duration(elapsed)}`}
            {when ? <span title={when.full}> · {when.text}</span> : null}
          </>
        )}
      </p>
      <TaskScope value={taskScope(task.job)} />
      <CitationScope selector={task.job.selector} />
      <div className="ui-block task-summary-block">
        {pdf ? (
          <PdfSummary pdf={pdf} papers={papers} running={running} />
        ) : (
          <p className="task-summary-headline">
            {idle
              ? total > 1
                ? `共 ${count.format(total)} 项，还没有开始`
                : "还没有开始"
              : running && total <= 1
                ? "正在处理"
                : running
                  ? `已处理 ${count.format(done + failed + skipped)} / ${count.format(total)} 项`
                  : [
                      `完成 ${count.format(done)} 项`,
                      failed ? `失败 ${count.format(failed)} 项` : null,
                      skipped ? `未处理 ${count.format(skipped)} 项` : null,
                    ]
                      .filter(Boolean)
                      .join("，")}
          </p>
        )}
        {running && total > 1 ? (
          <span className="task-summary-progress" aria-hidden="true">
            <i
              style={{ width: `${((done + failed + skipped) / total) * 100}%` }}
            />
          </span>
        ) : null}
      </div>
      <CitationSources
        sources={task.citation_source_cooldowns}
        truncated={task.citation_source_cooldowns_truncated}
        now={now}
      />
      {papers.length ? (
        <section className="task-papers" aria-label="逐篇结果">
          <h3>
            逐篇结果
            {task.acquisition_traces_truncated ? (
              <span className="task-papers-note">较早的记录已省略</span>
            ) : null}
          </h3>
          <ul>
            {papers.map((paper) => (
              <PaperRow key={paper.trace.attempt_id} paper={paper} />
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

function PdfSummary({
  pdf,
  papers,
  running,
}: {
  pdf: NonNullable<NonNullable<TaskDetail["source_results"]>["pdf"]>;
  papers: readonly PaperOutcome[];
  running: boolean;
}) {
  const channels = pdf.sources
    .filter((s) => s.obtained > 0)
    .sort((a, b) => b.obtained - a.obtained);
  const total = Math.max(1, pdf.obtained + pdf.not_obtained);
  const timed = papers.filter((p) => Number.isFinite(p.ms));
  const average = timed.length
    ? timed.reduce((sum, p) => sum + p.ms, 0) / timed.length
    : null;
  const slowest = timed.reduce<PaperOutcome | null>(
    (worst, p) => (!worst || p.ms > worst.ms ? p : worst),
    null,
  );
  const reasons = new Map<string, number>();
  for (const p of papers)
    if (p.reason) reasons.set(p.reason, (reasons.get(p.reason) ?? 0) + 1);
  return (
    <>
      <p className="task-summary-headline">
        {running ? "目前" : ""}拿到 {count.format(pdf.obtained)} 篇 PDF
        {pdf.not_obtained
          ? `，没拿到 ${count.format(pdf.not_obtained)} 篇`
          : ""}
        {pdf.unknown ? `，${count.format(pdf.unknown)} 篇未核实` : ""}
      </p>
      <div
        className="task-split"
        role="img"
        aria-label={[
          ...channels.map((c) => `${sourceName(c.source)} ${c.obtained} 篇`),
          pdf.not_obtained ? `未获取 ${pdf.not_obtained} 篇` : null,
        ]
          .filter(Boolean)
          .join("，")}
      >
        {channels.map((c, i) => (
          <i
            key={c.source}
            style={{
              width: `${(c.obtained / total) * 100}%`,
              opacity: SHADES[Math.min(i, SHADES.length - 1)],
            }}
          />
        ))}
        {pdf.not_obtained ? (
          <i
            data-missed=""
            style={{ width: `${(pdf.not_obtained / total) * 100}%` }}
          />
        ) : null}
      </div>
      <ul className="task-split-legend">
        {channels.map((c, i) => (
          <li key={c.source}>
            <i style={{ opacity: SHADES[Math.min(i, SHADES.length - 1)] }} />
            {sourceName(c.source)} <span>{count.format(c.obtained)}</span>
          </li>
        ))}
        {pdf.not_obtained ? (
          <li>
            <i data-missed="" />
            未获取 <span>{count.format(pdf.not_obtained)}</span>
          </li>
        ) : null}
      </ul>
      {average !== null || reasons.size ? (
        <dl className="task-summary-facts">
          {average !== null ? (
            <>
              <dt>平均每篇</dt>
              <dd>{duration(average)}</dd>
            </>
          ) : null}
          {slowest && timed.length > 1 ? (
            <>
              <dt>最慢一篇</dt>
              <dd>
                {duration(slowest.ms)}
                {slowest.source ? ` · ${sourceName(slowest.source)}` : ""}
              </dd>
            </>
          ) : null}
          {reasons.size ? (
            <>
              <dt>没拿到的原因</dt>
              <dd>
                {[...reasons.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, n]) => `${reason} ${n} 篇`)
                  .join("，")}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </>
  );
}

function PaperRow({ paper }: { paper: PaperOutcome }) {
  const api = useApi(),
    shell = useShell();
  const detail = useQuery({
    queryKey: ["literature", paper.trace.literature_id],
    queryFn: ({ signal }) =>
      readLiterature(api, paper.trace.literature_id, signal),
  });
  return (
    <li className="task-paper" data-missed={paper.source ? undefined : ""}>
      <Button
        variant="text"
        className="task-paper-title"
        onPress={() => shell.openPaper(paper.trace.literature_id, "pdf")}
      >
        {detail.data ? (
          <RichTitle parts={paperTitleParts(detail.data)} />
        ) : (
          "正在读取标题…"
        )}
      </Button>
      <span className="task-paper-outcome">
        {paper.source ? (
          <>已获取 · {sourceName(paper.source)}</>
        ) : (
          <span className="problem-label">未获取 · {paper.reason}</span>
        )}
      </span>
      <span className="task-paper-time">
        {Number.isFinite(paper.ms) ? duration(paper.ms) : ""}
      </span>
      <p
        className="task-paper-path"
        title={attemptsDetail(paper.trace.attempts)}
      >
        {attemptsLine(paper.trace.attempts) || "没有记录到来源尝试"}
        {paper.trace.truncated ? " · 更早的尝试已省略" : ""}
      </p>
    </li>
  );
}
