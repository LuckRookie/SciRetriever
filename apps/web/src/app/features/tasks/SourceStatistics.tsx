import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  parseSourceStatistics,
  type AcquisitionRoute,
  type SourceProblem,
  type SourceRatio,
  type SourceStatistics as Statistics,
} from "@sciretriever/contracts";
import {
  EmptyState,
  ErrorNotice,
  PageHeader,
  SegmentedControl,
  Skeleton,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { sourceName, STAGES } from "../../data/acquisition-wording.js";
import { errorMessage } from "../../strings.js";
import { ProblemLabel } from "../sources/problem.js";
import { RunSwitch } from "./RunSwitch.js";
import { namedProblems, percent } from "./source-bars.js";
import { StageHint } from "./SourceResults.js";
import "./tasks.css";
import "./source-results.css";

const count = new Intl.NumberFormat("zh-CN");
const STAGE_ORDER: readonly AcquisitionRoute["stage"][] = [
  "direct",
  "publisher-api",
  "general-api",
  "public-web",
  "browser",
];

function Ratio({ value }: { value: SourceRatio }) {
  return (
    <span className="source-ratio">
      <span className="source-ratio-track" aria-hidden="true">
        <i style={{ width: `${(value.ratio ?? 0) * 100}%` }} />
      </span>
      <span>{percent(value)}</span>
      {/* Narrow screens drop the count columns; the ratio carries them instead. */}
      <span className="source-ratio-count">
        {count.format(value.numerator)} / {count.format(value.denominator)}
      </span>
    </span>
  );
}
/** An error rate of 5% or more reads in the failure colour. */
function ErrorRate({ value }: { value: SourceRatio }) {
  return (
    <span
      className="source-error"
      data-high={(value.ratio ?? 0) >= 0.05 || undefined}
    >
      {percent(value)}
    </span>
  );
}
function Named({ problems }: { problems: readonly SourceProblem[] }) {
  return (
    <>
      {namedProblems(problems).map((p) => (
        <ProblemLabel key={p.display} display={p.display} />
      ))}
    </>
  );
}
function Cell({ value, unit }: { value: SourceRatio | null; unit: string }) {
  if (!value) return <>—</>;
  return (
    <>
      {percent(value)}
      <span className="source-cell-basis">
        {count.format(value.denominator)} {unit}
      </span>
    </>
  );
}

function PdfTable({ pdf }: { pdf: Statistics["pdf"] }) {
  // Acquisition order: stage first, then the server's order within a stage.
  const sources = STAGE_ORDER.flatMap((stage) =>
    pdf.sources.filter((s) => s.stage === stage),
  );
  return (
    <section aria-labelledby="source-statistics-pdf">
      <div className="source-statistics-heading">
        <h2 id="source-statistics-pdf">PDF 获取</h2>
        <p>
          {count.format(pdf.documents)} 篇 · 拿到 {count.format(pdf.obtained)} ·
          未获取 {count.format(pdf.not_obtained)}
        </p>
      </div>
      {sources.length ? (
        <table className="ui-data-table source-statistics-pdf">
          <thead>
            <tr>
              <th scope="col">来源</th>
              <th scope="col">尝试</th>
              <th scope="col">拿到</th>
              <th scope="col">拿到比例</th>
              <th scope="col">错误</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.source}>
                <th scope="row">
                  {sourceName(s.source)}
                  <StageHint source={s.source} stage={STAGES[s.stage]} />
                </th>
                <td>{count.format(s.attempted)}</td>
                <td>{count.format(s.obtained)}</td>
                <td>
                  <Ratio value={s.hit_rate} />
                </td>
                <td>
                  <ErrorRate value={s.error_rate} />
                  <Named problems={s.problems} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="source-statistics-since">没有 PDF 来源记录。</p>
      )}
    </section>
  );
}

function MetadataTable({ metadata }: { metadata: Statistics["metadata"] }) {
  const sources = [...metadata.sources].sort(
    (a, b) => (b.topic_coverage?.ratio ?? -1) - (a.topic_coverage?.ratio ?? -1),
  );
  return (
    <section aria-labelledby="source-statistics-metadata">
      <div className="source-statistics-heading">
        <h2 id="source-statistics-metadata">元数据获取</h2>
        <p>
          检索 {count.format(metadata.topic_searches)} 次 · 补全{" "}
          {count.format(metadata.lookup_documents)} 篇 · 引用{" "}
          {count.format(metadata.reference_documents)} 篇
        </p>
      </div>
      {sources.length ? (
        <table className="ui-data-table source-statistics-metadata">
          <thead>
            <tr>
              <th scope="col">来源</th>
              <th scope="col">检索覆盖</th>
              <th scope="col">补全命中</th>
              <th scope="col">引用命中</th>
              <th scope="col">错误</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => {
              // A source missing its configuration has no numbers to show at all.
              const missing = s.problems.some(
                (p) => p.display === "not-configured",
              );
              return (
                <tr key={s.source}>
                  <th scope="row">{sourceName(s.source)}</th>
                  <td data-label="检索覆盖">
                    {missing ? (
                      "—"
                    ) : (
                      <Cell value={s.topic_coverage} unit="次检索" />
                    )}
                  </td>
                  <td data-label="补全命中">
                    {missing ? "—" : <Cell value={s.lookup_hit} unit="篇" />}
                  </td>
                  <td data-label="引用命中">
                    {missing ? "—" : <Cell value={s.reference_hit} unit="篇" />}
                  </td>
                  <td data-label="错误">
                    {missing ? (
                      "—"
                    ) : (
                      <>
                        <ErrorRate value={s.error_rate} />
                        <span className="source-cell-basis">
                          {count.format(s.error_rate.denominator)} 次请求
                        </span>
                      </>
                    )}
                    <Named problems={s.problems} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="source-statistics-since">没有元数据来源记录。</p>
      )}
    </section>
  );
}

/** Which sources work and which do not, from the tasks' own per-source records. */
export default function SourceStatistics() {
  const api = useApi();
  const [range, setRange] = useState<"last-30-days" | "all">("last-30-days");
  const statistics = useQuery({
    queryKey: ["tasks", "source-statistics", range],
    queryFn: async ({ signal }) =>
      parseSourceStatistics(
        (await api.query("source-statistics", { range }, signal)).result,
      ),
    enabled: api.kind === "workspace",
  });
  if (api.kind !== "workspace")
    return (
      <EmptyState
        title="此入口不提供来源统计"
        description="请使用完整 Web 工作台查看来源统计。"
      />
    );
  const value = statistics.data;
  return (
    <section className="tasks-page">
      <PageHeader title="任务" />
      <div className="source-statistics-toolbar">
        <RunSwitch value="stats" />
        <SegmentedControl
          label="时间范围"
          value={range}
          onChange={(next) => setRange(next as typeof range)}
          items={[
            { id: "last-30-days", label: "近 30 天" },
            { id: "all", label: "全部" },
          ]}
        />
      </div>
      {statistics.isPending ? (
        <Skeleton label="正在读取来源统计" />
      ) : !value ? (
        <ErrorNotice
          message={errorMessage(statistics.error)}
          onRetry={async () => {
            await statistics.refetch();
          }}
        />
      ) : (
        <div className="source-statistics">
          <p className="source-statistics-since">
            {value.recorded_since
              ? `统计起点 ${new Date(value.recorded_since).toLocaleDateString("zh-CN")}，更早的任务没有逐来源记录`
              : "还没有带逐来源记录的任务"}
          </p>
          <PdfTable pdf={value.pdf} />
          <MetadataTable metadata={value.metadata} />
        </div>
      )}
    </section>
  );
}
