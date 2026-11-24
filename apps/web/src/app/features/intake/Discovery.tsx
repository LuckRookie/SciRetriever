import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SourceDirectory } from "@sciretriever/contracts";
import {
  Badge,
  Button,
  Definition,
  Definitions,
  ErrorNotice,
  ListRow,
  NumberField,
  SegmentedControl,
  Select,
  TechDetails,
  TextField,
} from "../../components/index.js";
import type { LiteratureChoice } from "../../data/library.js";
import { useApi } from "../../data/query.js";
import type { ApiClient } from "../../data/api.js";
import type { JsonRecord } from "../../data/wire.js";
import { readIntakeReport, type IntakeReport } from "../../data/intake.js";
import { errorMessage } from "../../strings.js";
import { useShell } from "../../shell/context.js";
import { addSeeds, Seeds } from "./Seeds.js";
import {
  readSourceDirectory,
  sourceDirectoryKey,
} from "../sources/SourceDirectory.js";

const reports = new WeakMap<
  ApiClient,
  { name: string; report: IntakeReport }[]
>();

/**
 * “6 篇种子 · 1 层 · 不限条数”; a filled limit is written instead of
 * “不限条数”. The seed count leads when it is given.
 */
export function citationScope(
  depth: number,
  resultLimit: number,
  scanLimit: number,
  seeds?: number,
): string {
  const limits = [
    Number.isFinite(scanLimit)
      ? `每来源最多 ${scanLimit.toLocaleString()} 条`
      : null,
    Number.isFinite(resultLimit)
      ? `结果最多 ${resultLimit.toLocaleString()} 条`
      : null,
  ].filter(Boolean);
  return [
    ...(seeds === undefined ? [] : [`${seeds.toLocaleString()} 篇种子`]),
    `${depth} 层`,
    ...(limits.length ? limits : ["不限条数"]),
  ].join(" · ");
}

/**
 * The sources a discovery run will ask, by name (page specs “入库”): those in
 * use for topic search, or for citations. Without a bound runtime the saved,
 * ready selection is the best answer, as in the source directory.
 */
export function discoverySources(
  directory: SourceDirectory,
  mode: "topic" | "cite",
): string[] {
  const bound = directory.runtime !== null;
  return directory.rows
    .filter((row) => {
      const cell =
        mode === "cite" ? row.uses.reference_query : row.uses.topic_search;
      return (
        cell.state === "active" ||
        (!bound &&
          cell.state === "available" &&
          cell.pending_selected &&
          cell.ready)
      );
    })
    .map((row) => row.name);
}

/**
 * “检索” (page specs “入库”): topic discovery and citation expansion, the
 * same two forms as before. A run confirms its scope and services first;
 * its batch is followed in the intake records below.
 */
export function Discovery({
  onRun,
}: {
  /** While a run is open, and the batch it made once it returns. */
  onRun: (running: boolean, batch: string | null) => void;
}) {
  const api = useApi(),
    queries = useQueryClient(),
    shell = useShell();
  // Seeds handed from the library open this form on 引用扩展 with them.
  const handed = shell.citationSeeds;
  const [mode, setMode] = useState(() => (handed ? "cite" : "topic")),
    [query, setQuery] = useState(""),
    [limit, setLimit] = useState(200),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [seeds, setSeeds] = useState<LiteratureChoice[]>(() =>
      addSeeds([], handed ?? []),
    ),
    [direction, setDirection] = useState("references"),
    // Citation expansion is bounded by depth; its count limits are optional
    // and left out of the request when empty, meaning no limit (ADR 0064).
    [depth, setDepth] = useState(1),
    [resultLimit, setResultLimit] = useState(Number.NaN),
    [citeScan, setCiteScan] = useState(Number.NaN),
    [history, setHistory] = useState(() => reports.get(api) ?? []);
  const directory = useQuery({
    queryKey: sourceDirectoryKey,
    queryFn: ({ signal }) => readSourceDirectory(api, signal),
    enabled: api.kind === "workspace",
    retry: false,
  });
  const sources = directory.data
    ? discoverySources(directory.data, mode === "cite" ? "cite" : "topic")
    : null;
  // Page specs “入库 · 检索”: no seeds, no expansion.
  const unseeded = mode === "cite" && !seeds.length;
  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "topic" && !query.trim())
        throw new Error("请填写研究主题或检索式。");
      if (mode === "cite" && !seeds.length) throw new Error("先选种子文献");
      onRun(true, null);
      const response: JsonRecord = await api.request(
        "/api/discovery",
        mode === "cite"
          ? {
              kind: "citation",
              seed_literature_ids: seeds.map((seed) => seed.id),
              direction,
              max_depth: depth,
              ...(Number.isFinite(resultLimit)
                ? { result_limit: resultLimit }
                : {}),
              ...(Number.isFinite(citeScan) ? { scan_limit: citeScan } : {}),
            }
          : {
              query: query.trim(),
              scan_limit: limit,
              year_from: from ? Number(from) : null,
              year_to: to ? Number(to) : null,
            },
      );
      return readIntakeReport(response.report);
    },
    onSuccess: (report) => {
      const next = [
        { name: mode === "cite" ? "引用扩展" : "主题发现", report },
        ...history,
      ].slice(0, 1);
      reports.set(api, next);
      setHistory(next);
      onRun(
        false,
        typeof report.raw.intake_batch_id === "string"
          ? report.raw.intake_batch_id
          : null,
      );
      void queries.invalidateQueries({ queryKey: ["library"] });
    },
    onError: () => onRun(false, null),
  });
  useEffect(() => {
    if (!handed) return;
    // Taken once: coming back to this page later starts empty again.
    shell.takeCitationSeeds();
    if (mutation.isPending) return;
    setMode("cite");
    setSeeds(addSeeds([], handed));
    mutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handed]);
  return (
    <div className="intake-discovery">
      <SegmentedControl
        label="检索方式"
        value={mode}
        onChange={(value) => {
          if (!mutation.isPending) {
            setMode(value);
            mutation.reset();
          }
        }}
        items={[
          { id: "topic", label: "主题发现" },
          { id: "cite", label: "引用扩展" },
        ]}
      />
      <div className="intake-form">
        <Definitions>
          {mode === "topic" ? (
            <>
              <Definition
                term="主题或检索式"
                description="按已配置的文献来源查找，只接纳元数据。"
              >
                <TextField
                  label="主题或检索式"
                  width="long"
                  value={query}
                  onChange={setQuery}
                  isRequired
                  maxLength={8192}
                />
              </Definition>
              <Definition
                term="逐来源扫描上限"
                description="每个来源最多扫描的原始条数，不少于 1。"
              >
                <NumberField
                  label="逐来源扫描上限"
                  value={limit}
                  onChange={setLimit}
                  minValue={1}
                  stepper={false}
                />
              </Definition>
              <Definition term="出版年份" description="可只填一端。">
                <div className="intake-range">
                  <NumberField
                    label="年份起"
                    value={from ? Number(from) : Number.NaN}
                    onChange={(value) =>
                      setFrom(Number.isFinite(value) ? String(value) : "")
                    }
                    minValue={1}
                    maxValue={9999}
                    placeholder="例如 2020"
                    formatOptions={{ useGrouping: false }}
                    stepper={false}
                  />
                  <span aria-hidden="true">–</span>
                  <NumberField
                    label="年份止"
                    value={to ? Number(to) : Number.NaN}
                    onChange={(value) =>
                      setTo(Number.isFinite(value) ? String(value) : "")
                    }
                    minValue={1}
                    maxValue={9999}
                    placeholder="例如 2026"
                    formatOptions={{ useGrouping: false }}
                    stepper={false}
                  />
                </div>
              </Definition>
            </>
          ) : (
            <>
              <Definition
                term="种子文献"
                description="从文献库里选，从这些文献出发扩展。"
              >
                <Seeds
                  seeds={seeds}
                  onChange={setSeeds}
                  isDisabled={mutation.isPending}
                />
              </Definition>
              <Definition term="方向">
                <Select
                  label="方向"
                  value={direction}
                  onChange={setDirection}
                  options={[
                    { value: "references", label: "参考文献" },
                    { value: "cited-by", label: "被引文献" },
                  ]}
                />
              </Definition>
              <Definition term="层数" description="从种子往外扩展几层引用。">
                <NumberField
                  label="层数"
                  value={depth}
                  onChange={(value) =>
                    setDepth(Number.isFinite(value) ? value : 1)
                  }
                  minValue={0}
                  maxValue={32}
                />
              </Definition>
              <Definition term="结果上限" description="选填，不填则不限。">
                <NumberField
                  label="结果上限"
                  value={resultLimit}
                  onChange={setResultLimit}
                  minValue={1}
                  stepper={false}
                />
              </Definition>
              <Definition
                term="扫描上限"
                description="每个来源最多扫描的原始条数。选填，不填则不限。"
              >
                <NumberField
                  label="扫描上限"
                  value={citeScan}
                  onChange={setCiteScan}
                  minValue={1}
                  stepper={false}
                />
              </Definition>
            </>
          )}
        </Definitions>
        <div className="intake-submit">
          <Button
            variant="primary"
            isDisabled={mutation.isPending || unseeded}
            confirm={{
              title: "确认发现文献",
              description:
                "将通过下列文献来源查找并接纳元数据，不会自动获取 PDF。",
              scope:
                mode === "cite"
                  ? citationScope(depth, resultLimit, citeScan, seeds.length)
                  : `每来源最多 ${limit} 条`,
              // Page specs “入库”: the sources this run will ask, by name.
              service: sources
                ? sources.length
                  ? sources.join("、")
                  : "没有在用的来源，可在“设置 · 获取 PDF”里补上配置"
                : "已配置的文献来源",
              confirmLabel: mode === "cite" ? "开始扩展" : "开始发现",
            }}
            // Discovery can take minutes; the dialog closes at once and the
            // batch's progress shows in the records below.
            onPress={() => {
              mutation.mutate();
            }}
          >
            {mutation.isPending
              ? "正在发现…"
              : mode === "cite"
                ? "开始扩展"
                : "开始发现"}
          </Button>
          {unseeded && !mutation.isPending ? (
            <span className="intake-submit-note">先选种子文献</span>
          ) : null}
        </div>
        {mutation.isPending ? (
          <p role="status">
            正在查找，进度见下方批次记录；完成前请不要关闭本页。
          </p>
        ) : null}
        {mutation.isError ? (
          <ErrorNotice
            message={errorMessage(mutation.error)}
            retained="表单已保留，尚未确认的结果请重试核对。"
          />
        ) : null}
        {mutation.isSuccess ? (
          <p role="status">
            操作已结束，结果见下方批次记录；未自动启动 PDF 获取。
          </p>
        ) : null}
      </div>
      {history[0] ? (
        <section className="intake-history" aria-label="刚才的提交">
          <div className="intake-report">
            <ListRow
              title={history[0].name}
              badge={
                <Badge status={history[0].report.status}>
                  {history[0].report.label}
                </Badge>
              }
              bibliography={history[0].report.summary}
            />
            {history[0].report.notices.length ? (
              <ul aria-label="运行提示">
                {history[0].report.notices.map((notice, i) => (
                  <li key={i}>{notice}</li>
                ))}
              </ul>
            ) : null}
            <TechDetails
              copyText={JSON.stringify(history[0].report.raw, null, 2)}
              title="运行明细"
            >
              <pre>{JSON.stringify(history[0].report.raw, null, 2)}</pre>
            </TechDetails>
          </div>
        </section>
      ) : null}
    </div>
  );
}
