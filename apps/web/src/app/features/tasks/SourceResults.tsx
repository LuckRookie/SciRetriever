import { useState } from "react";
import type {
  MetadataSourceSummary,
  PdfSourceSummary,
  SourceProblem,
  TaskSourceResults,
} from "@sciretriever/contracts";
import { SegmentedControl } from "../../components/index.js";
import { sourceName, STAGES } from "../../data/acquisition-wording.js";
import {
  metadataBars,
  namedProblems,
  pdfAttemptBars,
  pdfChannelBars,
  percent,
  type Bar,
} from "./source-bars.js";
import { ProblemLabel } from "../sources/problem.js";
import "./source-results.css";

const count = new Intl.NumberFormat("zh-CN");
/** Horizontal bars, largest first; the number sits after each bar. */
export function BarList({
  label,
  bars,
  max,
}: {
  label: string;
  bars: readonly Bar[];
  max: number;
}) {
  return (
    <figure className="source-bars">
      <figcaption>{label}</figcaption>
      <ul>
        {bars.map((bar) => (
          <li key={bar.key} data-tone={bar.tone}>
            <span className="source-bar-name">{bar.name}</span>
            <span className="source-bar-track" aria-hidden="true">
              {bar.behind ? (
                <i
                  className="source-bar-behind"
                  style={{ width: `${(bar.behind / max) * 100}%` }}
                />
              ) : null}
              <i style={{ width: `${(bar.value / max) * 100}%` }} />
            </span>
            <span className="source-bar-value">{bar.text}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** A failure is “错误”; only the three problems a person can act on get their own name. */
function Problems({ problems }: { problems: readonly SourceProblem[] }) {
  if (!problems.length) return null;
  const named = namedProblems(problems);
  return named.length ? (
    named.map((p) => <ProblemLabel key={p.display} display={p.display} />)
  ) : (
    <ProblemLabel display="error" />
  );
}

/** The stage is a hint after the name, left out where it would only repeat it. */
export function StageHint({
  source,
  stage,
}: {
  source: string;
  stage: string;
}) {
  return sourceName(source) === stage ? null : (
    <span className="source-stage">{stage}</span>
  );
}

function Mode({
  value,
  onChange,
}: {
  value: "chart" | "table";
  onChange: (value: "chart" | "table") => void;
}) {
  return (
    <SegmentedControl
      label="显示方式"
      value={value}
      onChange={(next) => onChange(next as "chart" | "table")}
      items={[
        { id: "chart", label: "图表" },
        { id: "table", label: "表格" },
      ]}
    />
  );
}

function PdfResults({ pdf }: { pdf: PdfSourceSummary }) {
  const [mode, setMode] = useState<"chart" | "table">("chart");
  return (
    <>
      <div className="source-results-head">
        <p className="source-results-summary">
          已获取 {count.format(pdf.obtained)} · 未获取{" "}
          {count.format(pdf.not_obtained)}
          {pdf.unknown ? ` · 未核实 ${count.format(pdf.unknown)}` : ""}
        </p>
        <Mode value={mode} onChange={setMode} />
      </div>
      {mode === "chart" ? (
        <>
          <BarList
            label="按渠道"
            bars={pdfChannelBars(pdf)}
            max={Math.max(1, pdf.obtained + pdf.not_obtained)}
          />
          <BarList
            label="尝试 / 命中"
            bars={pdfAttemptBars(pdf)}
            max={Math.max(1, pdf.documents)}
          />
        </>
      ) : (
        <table className="ui-data-table source-results-table">
          <thead>
            <tr>
              <th scope="col">渠道</th>
              <th scope="col">尝试</th>
              <th scope="col">拿到</th>
              <th scope="col">错误</th>
            </tr>
          </thead>
          <tbody>
            {pdf.sources.map((s) => (
              <tr key={s.source}>
                <th scope="row">
                  {sourceName(s.source)}
                  <StageHint source={s.source} stage={STAGES[s.stage]} />
                </th>
                <td>{count.format(s.attempted)}</td>
                <td>{count.format(s.obtained)}</td>
                <td>
                  {s.errors ? count.format(s.errors) : "—"}
                  <Problems problems={s.problems} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function MetadataResults({ metadata }: { metadata: MetadataSourceSummary }) {
  const [mode, setMode] = useState<"chart" | "table">("chart");
  const running = new Set(
    metadata.records.filter((r) => r.result === "running").map((r) => r.source),
  );
  const empty = metadata.sources.filter((s) => s.included === 0);
  return (
    <>
      <div className="source-results-head">
        <p className="source-results-summary">
          返回 {count.format(metadata.returned)} 条 · 新入库{" "}
          {count.format(metadata.new_literatures)} · 合并到已有{" "}
          {count.format(metadata.matched_literatures)} · 被拒{" "}
          {count.format(metadata.rejected)}
        </p>
        <Mode value={mode} onChange={setMode} />
      </div>
      {mode === "chart" ? (
        <>
          <BarList
            label="按来源"
            bars={metadataBars(metadata)}
            max={Math.max(1, metadata.merged)}
          />
          {empty.length ? (
            <ul className="source-results-empty">
              {empty.map((s) => (
                <li key={s.source}>
                  {sourceName(s.source)}{" "}
                  {running.has(s.source) ? (
                    <span className="source-running">进行中</span>
                  ) : s.problems.length ? (
                    <Problems problems={s.problems} />
                  ) : (
                    "0 条"
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <table className="ui-data-table source-results-table">
          <thead>
            <tr>
              <th scope="col">来源</th>
              <th scope="col">返回</th>
              <th scope="col">进入结果</th>
              <th scope="col">覆盖</th>
              <th scope="col">错误</th>
            </tr>
          </thead>
          <tbody>
            {metadata.sources.map((s) => (
              <tr key={s.source}>
                <th scope="row">{sourceName(s.source)}</th>
                <td>{count.format(s.returned)}</td>
                <td>{count.format(s.included)}</td>
                <td>{percent(s.coverage)}</td>
                <td>
                  {s.errors ? count.format(s.errors) : "—"}
                  <Problems problems={s.problems} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** A task's own numbers by channel or source; tasks from before per-source records say so. */
export function SourceResults({ value }: { value: TaskSourceResults }) {
  if (value.availability === "unrecorded")
    return (
      <p className="source-results-unrecorded">这个任务没有逐来源记录。</p>
    );
  return (
    <section className="source-results" aria-label="来源结果">
      {value.pdf ? <PdfResults pdf={value.pdf} /> : null}
      {value.metadata ? <MetadataResults metadata={value.metadata} /> : null}
    </section>
  );
}
