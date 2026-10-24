import "../processing/processing.css";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseDiscoveryRunId } from "@sciretriever/contracts";
import {
  Button,
  Definition,
  Definitions,
  Badge,
  EmptyState,
  ErrorNotice,
  NumberField,
  ListRow,
  PageHeader,
  Select,
  Tabs,
  TechDetails,
  TextField,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import type { ApiClient } from "../../data/api.js";
import { navigate, useUrlState } from "../../data/url.js";
import { OperationDialog } from "../library/OperationDialog.js";
import type { JsonRecord } from "../../data/wire.js";
import { readIntakeReport, type IntakeReport } from "../../data/intake.js";
import { errorMessage } from "../../strings.js";
const reports = new WeakMap<
  ApiClient,
  { name: string; report: IntakeReport }[]
>();
export default function Intake() {
  const api = useApi(),
    queries = useQueryClient(),
    route = useUrlState();
  const [mode, setMode] = useState("topic"),
    [query, setQuery] = useState(""),
    [limit, setLimit] = useState(200),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [seed, setSeed] = useState(""),
    [direction, setDirection] = useState("references"),
    [format, setFormat] = useState("bibtex"),
    [file, setFile] = useState<File | null>(null),
    [literature, setLiterature] = useState(""),
    [upload, setUpload] = useState(false),
    [history, setHistory] = useState(() => reports.get(api) ?? []);
  const mutation = useMutation({
    mutationFn: async () => {
      let response: JsonRecord;
      if (mode === "bib") {
        if (!file || file.size < 1 || file.size > 768 * 1024)
          throw new Error("请选择不超过 768 KiB 的书目文件。");
        response = await api.request("/api/import", {
          format,
          content: await file.text(),
        });
      } else {
        if (mode === "topic" && !query.trim())
          throw new Error("请填写研究主题或检索式。");
        if (mode === "cite" && !seed.trim())
          throw new Error("请填写种子文献 ID。");
        response = await api.request(
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
      }
      return readIntakeReport(response.report);
    },
    onSuccess: (report) => {
      const next = [
        {
          name:
            mode === "bib"
              ? "书目导入"
              : mode === "cite"
                ? "引用扩展"
                : "主题发现",
          report,
        },
        ...history,
      ].slice(0, 30);
      reports.set(api, next);
      setHistory(next);
      void queries.invalidateQueries({ queryKey: ["library"] });
    },
  });
  if (api.kind !== "workspace")
    return (
      <EmptyState
        title="此入口不提供发现与入库"
        description="请从完整工作台启动发现、书目导入或 PDF 上传。"
      />
    );
  return (
    <section className="feature-page intake-page">
      <PageHeader title="入库" />
      <Tabs
        label="入库方式"
        value={mode}
        onChange={(value) => {
          if (!mutation.isPending) {
            setMode(value);
            setFile(null);
            mutation.reset();
          }
        }}
        items={[
          { id: "topic", label: "主题发现" },
          { id: "cite", label: "引用扩展" },
          { id: "bib", label: "导入书目" },
          { id: "pdf", label: "上传 PDF" },
        ]}
      >
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
                    value={query}
                    onChange={setQuery}
                    isRequired
                    maxLength={8192}
                  />
                </Definition>
                <Definition term="逐来源扫描上限" description="1–10,000 条">
                  <NumberField
                    label="逐来源扫描上限"
                    value={limit}
                    onChange={setLimit}
                    minValue={1}
                    maxValue={10000}
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
            ) : mode === "cite" ? (
              <>
                <Definition
                  term="种子文献 ID"
                  description="从这篇文献出发扩展。"
                >
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
                <Definition term="扫描上限" description="1–10,000 条">
                  <NumberField
                    label="扫描上限"
                    value={limit}
                    onChange={setLimit}
                    minValue={1}
                    maxValue={10000}
                  />
                </Definition>
              </>
            ) : mode === "bib" ? (
              <>
                <Definition
                  term="书目文件"
                  description="BibTeX、RIS 或 CSL JSON。"
                >
                  <label className="ui-field">
                    <span className="ui-label">书目文件</span>
                    <input
                      type="file"
                      accept=".bib,.ris,.json"
                      onChange={(event) =>
                        setFile(event.target.files?.[0] ?? null)
                      }
                    />
                  </label>
                </Definition>
                <Definition term="书目格式">
                  <Select
                    label="书目格式"
                    value={format}
                    onChange={setFormat}
                    options={[
                      { value: "bibtex", label: "BibTeX" },
                      { value: "biblatex", label: "BibLaTeX" },
                      { value: "ris", label: "RIS" },
                      { value: "csl-json", label: "CSL JSON" },
                    ]}
                  />
                </Definition>
              </>
            ) : (
              <>
                <Definition
                  term="目标文献 ID"
                  description="PDF 会接纳到这篇文献。"
                >
                  <TextField
                    label="目标文献 ID"
                    value={literature}
                    onChange={setLiterature}
                  />
                </Definition>
                <Definition term="PDF 文件">
                  <label className="ui-field">
                    <span className="ui-label">PDF 文件</span>
                    <input
                      type="file"
                      accept="application/pdf"
                      onChange={(event) =>
                        setFile(event.target.files?.[0] ?? null)
                      }
                    />
                  </label>
                </Definition>
              </>
            )}
          </Definitions>
          {mode === "pdf" ? (
            <Button
              variant="primary"
              isDisabled={!literature.trim() || !file}
              onPress={() => setUpload(true)}
            >
              选择并上传
            </Button>
          ) : (
            <Button
              variant="primary"
              isPending={mutation.isPending}
              confirm={{
                title: mode === "bib" ? "导入书目" : "确认发现文献",
                description:
                  mode === "bib"
                    ? "读取所选书目并接纳元数据，不会自动获取 PDF。"
                    : "将通过已配置的文献来源查找并接纳元数据，不会自动获取 PDF。",
                scope:
                  mode === "bib"
                    ? (file?.name ?? "尚未选择文件")
                    : `每来源最多 ${limit} 条`,
                service: mode === "bib" ? "本地书目导入" : "已配置的文献来源",
              }}
              onPress={() => mutation.mutateAsync().then(() => {})}
            >
              {mode === "bib" ? "导入" : "开始发现"}
            </Button>
          )}
          {mutation.isError ? (
            <ErrorNotice
              message={errorMessage(mutation.error)}
              retained="表单已保留，尚未确认的结果请重试核对。"
            />
          ) : null}
          {mutation.isSuccess ? (
            <p role="status">
              操作已结束，逐项结果见下方；未自动启动 PDF 获取。
            </p>
          ) : null}
        </div>
      </Tabs>
      <section className="intake-history">
        <h2>本次会话的运行结果</h2>
        {history.length ? (
          history.map((item, index) => (
            <div className="intake-report" key={index}>
              <ListRow
                title={item.name}
                badge={
                  <Badge status={item.report.status}>{item.report.label}</Badge>
                }
                bibliography={item.report.summary}
              />
              {item.report.notices.length ? (
                <ul aria-label="运行提示">
                  {item.report.notices.map((notice, i) => (
                    <li key={i}>{notice}</li>
                  ))}
                </ul>
              ) : null}
              {typeof item.report.raw.discovery_run_id === "string" ? (
                <Button
                  onPress={() =>
                    navigate({
                      view: "lib",
                      query: JSON.stringify({
                        ...route.query,
                        discovery_run_ids: [
                          parseDiscoveryRunId(item.report.raw.discovery_run_id),
                        ],
                      }),
                    })
                  }
                >
                  在文献库查看本次发现
                </Button>
              ) : null}
              <TechDetails
                copyText={JSON.stringify(item.report.raw, null, 2)}
                title="运行明细"
              >
                <pre>{JSON.stringify(item.report.raw, null, 2)}</pre>
              </TechDetails>
            </div>
          ))
        ) : (
          <p className="ui-description">尚未执行发现或导入。</p>
        )}
      </section>
      {upload && file ? (
        <OperationDialog
          ids={[literature.trim()]}
          kind="upload"
          file={file}
          onClose={() => setUpload(false)}
        />
      ) : null}
    </section>
  );
}
