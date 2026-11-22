import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { sourceProblemForCode } from "@sciretriever/contracts";
import { Button, RichTitle } from "../../components/index.js";
import { sourceName } from "../../data/acquisition-wording.js";
import { paperTitleParts, readLiterature } from "../../data/library.js";
import { useApi } from "../../data/query.js";
import type { CitationSourceCooldown } from "../../data/tasks.js";
import { problemText } from "../sources/problem.js";

const count = new Intl.NumberFormat("zh-CN");
/** What a deferred query was for (page specs “获取任务详情”). */
const PURPOSES = {
  "reference-query": "查参考文献",
  lookup: "查书目",
} as const;
const minute = (value: string) =>
  new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });

/** One source's state in words; the time of the next retry is local, to the minute. */
function stateText(source: CitationSourceCooldown, now: number): string {
  switch (source.status) {
    case "cooling": {
      const at = source.next_retry_at ? Date.parse(source.next_retry_at) : NaN;
      // Past its time and not yet tried again.
      return Number.isFinite(at) && at > now
        ? `冷却中，${minute(source.next_retry_at!)} 重试（第 ${count.format(source.retries + 1)} 次）`
        : "冷却中，等待重试";
    }
    case "disabled":
      return `本任务内已停用：连续限流 ${count.format(source.retries)} 次`;
    case "recovered":
      return "已恢复";
    case "retry-ended":
      // Said the way every failure is (page specs “错误的呈现”).
      return `冷却结束，重试出错：${problemText(
        sourceProblemForCode(source.reason?.code ?? "", "metadata").display,
      )}`;
  }
}

/**
 * The rate-limited sources of a citation expansion, under the summary block
 * (page specs “获取任务详情”). Cooling down and stopping a source are not the
 * task failing: the other sources go on, and the owed queries are made in
 * this task once it recovers.
 */
export function CitationSources({
  sources,
  truncated,
  now,
}: {
  sources: readonly CitationSourceCooldown[];
  truncated: boolean;
  now: number;
}) {
  if (!sources.length) return null;
  return (
    <section className="task-papers citation-sources" aria-label="来源">
      <h3>
        来源
        {truncated ? (
          <span className="task-papers-note">
            只列出前 {count.format(sources.length)} 个来源
          </span>
        ) : null}
      </h3>
      <ul>
        {sources.map((source) => (
          <SourceRow
            key={source.source}
            source={source}
            text={stateText(source, now)}
          />
        ))}
      </ul>
    </section>
  );
}

function SourceRow({
  source,
  text,
}: {
  source: CitationSourceCooldown;
  text: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="citation-source" data-status={source.status}>
      <span className="citation-source-state">
        {sourceName(source.source)} · {text}
        {source.pending_count > 0 ? (
          <>
            {" · "}
            <Button
              variant="text"
              size="inline"
              className="citation-source-pending"
              aria-expanded={open}
              onPress={() => setOpen(!open)}
            >
              待补查 {count.format(source.pending_count)} 项
            </Button>
          </>
        ) : null}
      </span>
      {open ? (
        <ul className="citation-source-sample">
          {source.pending_sample.map((item) => (
            <PendingItem
              key={`${item.literature_id}:${item.purpose}`}
              id={item.literature_id}
              purpose={PURPOSES[item.purpose]}
            />
          ))}
          {source.pending_truncated ? (
            <li className="citation-source-more">
              只列出前 {count.format(source.pending_sample.length)} 项
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

function PendingItem({ id, purpose }: { id: string; purpose: string }) {
  const api = useApi();
  const detail = useQuery({
    queryKey: ["literature", id],
    queryFn: ({ signal }) => readLiterature(api, id, signal),
  });
  return (
    <li>
      <span className="citation-source-title">
        {detail.data ? (
          <RichTitle parts={paperTitleParts(detail.data)} />
        ) : detail.isError ? (
          "标题暂时读不到"
        ) : (
          "正在读取标题…"
        )}
      </span>
      <span className="citation-source-purpose">{purpose}</span>
    </li>
  );
}
