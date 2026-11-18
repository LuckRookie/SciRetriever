import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { useApi } from "../../data/query.js";
import type { ApiClient } from "../../data/api.js";
import type { JsonRecord } from "../../data/wire.js";
import { readIntakeReport, type IntakeReport } from "../../data/intake.js";
import { errorMessage } from "../../strings.js";

const reports = new WeakMap<
  ApiClient,
  { name: string; report: IntakeReport }[]
>();

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
    queries = useQueryClient();
  const [mode, setMode] = useState("topic"),
    [query, setQuery] = useState(""),
    [limit, setLimit] = useState(200),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [seed, setSeed] = useState(""),
    [direction, setDirection] = useState("references"),
    [history, setHistory] = useState(() => reports.get(api) ?? []);
  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "topic" && !query.trim())
        throw new Error("请填写研究主题或检索式。");
      if (mode === "cite" && !seed.trim())
        throw new Error("请填写种子文献 ID。");
      onRun(true, null);
      const response: JsonRecord = await api.request(
        "/api/discovery",
        mode === "cite"
          ? {
              kind: "citation",
              seed_literature_id: seed.trim(),
              direction,
              scan_limit: limit,
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
                  />
                </div>
              </Definition>
            </>
          ) : (
            <>
              <Definition term="种子文献 ID" description="从这篇文献出发扩展。">
                <TextField
                  label="种子文献 ID"
                  value={seed}
                  onChange={setSeed}
                  isRequired
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
              <Definition
                term="扫描上限"
                description="最多扫描的原始条数，不少于 1。"
              >
                <NumberField
                  label="扫描上限"
                  value={limit}
                  onChange={setLimit}
                  minValue={1}
                />
              </Definition>
            </>
          )}
        </Definitions>
        <Button
          variant="primary"
          isDisabled={mutation.isPending}
          confirm={{
            title: "确认发现文献",
            description:
              "将通过已配置的文献来源查找并接纳元数据，不会自动获取 PDF。",
            scope: `每来源最多 ${limit} 条`,
            service: "已配置的文献来源",
          }}
          // Discovery can take minutes; the dialog closes at once and the
          // batch's progress shows in the records below.
          onPress={() => {
            mutation.mutate();
          }}
        >
          {mutation.isPending ? "正在发现…" : "开始发现"}
        </Button>
        {mutation.isPending ? (
          <p role="status">
            正在查找，进度见下方入库记录；完成前请不要关闭本页。
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
            操作已结束，结果见下方入库记录；未自动启动 PDF 获取。
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
