import { randomId } from "../../../browser-platform.js";
import { Fragment, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ACQUISITION_STAGES,
  type CredentialFieldEdit,
  parseSourceDirectory,
  parseSourceSaveResult,
  type LiteratureSourceId,
  type SourceConfigurationField,
  type SourceDirectory as Directory,
  type SourceDirectoryRow,
  type SourcePdfCell,
  type SourceProblem,
  type SourceTestSlot,
  type SourceUseCell,
} from "@sciretriever/contracts";
import {
  Button,
  Checkbox,
  ErrorNotice,
  Icon,
  SegmentedControl,
  Select,
  Skeleton,
  TextArea,
  TextField,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { pacedInterval } from "../../data/polling.js";
import type { ApiClient } from "../../data/api.js";
import { errorMessage } from "../../strings.js";
import { STAGES, sourceName } from "../../data/acquisition-wording.js";
import { ProblemDetails, ProblemLabel } from "./problem.js";
import "./sources.css";

export const sourceDirectoryKey = ["configuration", "sources"] as const;

export async function readSourceDirectory(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<Directory> {
  return parseSourceDirectory(
    (await api.read("/api/configuration/sources", signal)).result,
  );
}

const fieldNames: Readonly<Record<string, string>> = {
  api_key: "API Key",
  institution_token: "机构 Token",
  tdm_api_token: "TDM Token",
  access_token: "Access Token",
  product: "产品",
  database: "数据库",
  edition: "版本",
  mode: "模式",
  mailto: "联系邮箱",
  contact_email: "联系邮箱",
  urls: "镜像",
};
const valueNames: Readonly<Record<string, string>> = {
  starter: "Starter",
  expanded: "Expanded",
  anonymous: "匿名",
  polite: "附联系邮箱",
};
const groupOrder = [
  "publisher-api",
  "general-api",
  "metadata",
  "public-builtin",
];
const fieldName = (f: SourceConfigurationField) =>
  fieldNames[f.field] ?? f.label;

/** Chinese and Latin runs get a space between them, as elsewhere in the interface. */
const spaced = (...parts: string[]) =>
  parts.reduce((text, part) =>
    /[A-Za-z0-9]$/.test(text) !== /^[A-Za-z0-9]/.test(part)
      ? `${text} ${part}`
      : text + part,
  );
/** The short phrase in the 配置 column: what is missing, what is set, or what could be added. */
function configurationSummary(row: SourceDirectoryRow) {
  const fields = row.configuration.fields,
    missing = fields.filter((f) => f.state === "missing"),
    configured = fields.filter((f) =>
      f.credential ? f.present : f.value_origin === "saved",
    ),
    optional = fields.filter((f) => f.state === "optional-enhancement");
  if (row.configuration.state === "missing")
    return {
      tone: "missing",
      text: spaced("缺", missing.map(fieldName).join("、")),
    };
  if (configured.length)
    return {
      tone: "configured",
      text: spaced(configured.map(fieldName).join("、"), "已配置"),
    };
  if (row.configuration.state === "optional-enhancement" && optional.length)
    return { tone: "optional", text: spaced("可加", fieldName(optional[0]!)) };
  return { tone: "none", text: "无需配置" };
}

/**
 * Without a bound runtime (CLI-like reads), the saved selection is the best
 * answer to “在用”. States are words, not circles that read as radio buttons
 * (design core rule 10).
 */
const mark = (cell: SourceUseCell | SourcePdfCell, bound: boolean) =>
  cell.state === "active" ||
  (!bound &&
    cell.state === "available" &&
    "pending_selected" in cell &&
    cell.pending_selected &&
    cell.ready)
    ? { symbol: "在用", label: "在用" }
    : cell.state === "available"
      ? { symbol: "未启用", label: "能用，未启用" }
      : cell.state === "hint"
        ? { symbol: "线索", label: "只提供 PDF 链接" }
        : { symbol: "—", label: "不提供" };

export function SourceDirectoryPanel() {
  const api = useApi(),
    queries = useQueryClient();
  const [expanded, setExpanded] = useState<LiteratureSourceId | null>(null),
    [failure, setFailure] = useState<{
      message: string;
      problem: SourceProblem | null;
    } | null>(null),
    [busy, setBusy] = useState(false);
  const directory = useQuery({
    queryKey: sourceDirectoryKey,
    queryFn: ({ signal }) => readSourceDirectory(api, signal),
    // Configuration can change outside this page; opening the directory always reads it again.
    refetchOnMount: "always",
    refetchInterval: (query) => {
      const d = query.state.data;
      const testing =
        d &&
        [
          ...d.rows.map((r) => r.test),
          ...d.builtin_tests.map((b) => b.test),
        ].some((t) => t.state === "queued" || t.state === "running");
      return pacedInterval(query, testing ? 1000 : false);
    },
  });
  const refresh = () =>
    queries.invalidateQueries({ queryKey: ["configuration"] });
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      const problem =
        error && typeof error === "object" && "problem" in error
          ? (error.problem as SourceProblem)
          : null;
      setFailure({ message: errorMessage(error), problem });
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  if (directory.isPending) return <Skeleton label="正在读取文献来源" />;
  if (directory.error || !directory.data)
    return (
      <ErrorNotice
        message={errorMessage(directory.error)}
        onRetry={() => directory.refetch().then(() => {})}
      />
    );
  const d = directory.data;
  const rows = [...d.rows].sort(
    (a, b) =>
      Number(b.configuration.state === "missing") -
        Number(a.configuration.state === "missing") ||
      groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group),
  );
  const selectSources = (
    domain: "metadata" | "pdf",
    mode: "auto" | "custom",
    providers: readonly string[],
  ) =>
    run(() =>
      api.request("/api/configuration/source-selection", {
        baseline: d.catalog_revision,
        domain,
        selection: { mode, providers: mode === "auto" ? [] : providers },
      }),
    );
  // Switching to custom keeps exactly the sources Auto uses now; toggles start from there.
  const pendingMetadata = rows
    .filter((r) =>
      [r.uses.topic_search, r.uses.lookup, r.uses.reference_query].some(
        (c) => c.state !== "not-provided" && c.pending_selected,
      ),
    )
    .map((r) => r.source);
  const pendingPdf = rows
    .filter(
      (r) => r.uses.pdf.kind === "acquisition" && r.uses.pdf.pending_selected,
    )
    .map((r) => r.source);
  const toggle = (
    domain: "metadata" | "pdf",
    source: LiteratureSourceId,
    on: boolean,
  ) => {
    const current = domain === "metadata" ? pendingMetadata : pendingPdf;
    void selectSources(
      domain,
      "custom",
      on ? [...current, source] : current.filter((s) => s !== source),
    );
  };
  const test = (source: string, revision: string) =>
    run(() =>
      api.request("/api/configuration/source-test", {
        source,
        source_revision: revision,
        request_id: randomId(),
      }),
    );
  const metadataCustom = d.saved.metadata.mode === "custom",
    pdfCustom = d.saved.pdf.mode === "custom";
  const markCell = (
    row: SourceDirectoryRow,
    cell: SourceUseCell | SourcePdfCell,
    domain: "metadata" | "pdf",
    name: string,
  ) => {
    const custom = domain === "metadata" ? metadataCustom : pdfCustom;
    const m = mark(cell, d.runtime !== null);
    if (
      custom &&
      cell.selectable &&
      "pending_selected" in cell &&
      cell.state !== "not-provided"
    )
      return (
        <td className="source-use">
          <Checkbox
            aria-label={`${row.name}：${name}`}
            isSelected={cell.pending_selected}
            isDisabled={busy}
            onChange={(on) => toggle(domain, row.source, on)}
          />
        </td>
      );
    return (
      <td className="source-use" data-state={cell.state}>
        <span aria-label={`${name}：${m.label}`} title={m.label}>
          {m.symbol}
        </span>
      </td>
    );
  };
  const routes = d.pending_pdf_routes;
  const browser = d.builtin_tests[0];
  return (
    <section className="source-directory" aria-label="文献来源">
      <div className="source-modes">
        <div className="source-mode">
          <span>元数据</span>
          <SegmentedControl
            label="元数据来源方式"
            value={d.saved.metadata.mode}
            onChange={(mode) =>
              void selectSources(
                "metadata",
                mode as "auto" | "custom",
                pendingMetadata,
              )
            }
            items={[
              { id: "auto", label: "自动" },
              { id: "custom", label: "自定义" },
            ]}
          />
        </div>
        <div className="source-mode">
          <span>PDF</span>
          <SegmentedControl
            label="PDF 来源方式"
            value={d.saved.pdf.mode}
            onChange={(mode) =>
              void selectSources("pdf", mode as "auto" | "custom", pendingPdf)
            }
            items={[
              { id: "auto", label: "自动" },
              { id: "custom", label: "自定义" },
            ]}
          />
        </div>
      </div>
      {failure ? (
        <>
          <ErrorNotice message={failure.message} />
          <ProblemDetails problem={failure.problem} />
        </>
      ) : null}
      <h3 className="source-heading">PDF 获取顺序</h3>
      <ol className="source-route-stages" aria-label="PDF 获取顺序">
        {ACQUISITION_STAGES.map((stage) => {
          const names = routes
            .filter((r) => r.stage === stage)
            .map((r) =>
              r.source === "direct" ? "直接链接" : sourceName(r.source),
            );
          return (
            <li key={stage}>
              <span className="source-stage-name">
                {stage === "browser" ? "浏览器" : STAGES[stage]}
              </span>
              {names.length ? (
                names.map((n) => <span key={n}>{n}</span>)
              ) : (
                <span className="source-stage-empty">未启用</span>
              )}
            </li>
          );
        })}
      </ol>
      <div className="source-table-heading">
        <h3 className="source-heading">来源</h3>
        <Button
          isDisabled={busy}
          onPress={() =>
            void run(() =>
              api.request("/api/configuration/source-test-all", {
                catalog_revision: d.catalog_revision,
                request_id: randomId(),
                scope: "configured",
              }),
            )
          }
        >
          全部测试
        </Button>
      </div>
      <table className="source-table">
        <thead>
          <tr className="source-table-group">
            <th />
            <th colSpan={3} scope="colgroup">
              元数据
            </th>
            <th colSpan={3} />
          </tr>
          <tr>
            <th scope="col">来源</th>
            <th scope="col">检索</th>
            <th scope="col">补全</th>
            <th scope="col">引用</th>
            <th scope="col">PDF</th>
            <th scope="col">配置</th>
            <th scope="col">测试</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const summary = configurationSummary(row),
              open = expanded === row.source;
            return (
              <Fragment key={row.source}>
                <tr
                  className="source-row"
                  data-missing={
                    row.configuration.state === "missing" || undefined
                  }
                  data-open={open || undefined}
                >
                  <th scope="row">
                    {row.name}
                    {row.egress === "proxy" ? (
                      <span className="source-egress">经代理</span>
                    ) : null}
                  </th>
                  {markCell(row, row.uses.topic_search, "metadata", "主题检索")}
                  {markCell(row, row.uses.lookup, "metadata", "补全书目")}
                  {markCell(
                    row,
                    row.uses.reference_query,
                    "metadata",
                    "引用关系",
                  )}
                  {markCell(row, row.uses.pdf, "pdf", "PDF")}
                  <td className="source-config" data-tone={summary.tone}>
                    {row.configuration.expandable ? (
                      <button
                        type="button"
                        className="source-config-toggle"
                        aria-expanded={open}
                        onClick={() => setExpanded(open ? null : row.source)}
                      >
                        {summary.text}
                        <Icon name="chevron" />
                      </button>
                    ) : (
                      summary.text
                    )}
                  </td>
                  <td className="source-test">
                    <TestCell
                      slot={row.test}
                      disabled={busy}
                      onTest={() => void test(row.source, row.source_revision)}
                    />
                  </td>
                </tr>
                {open ? (
                  <tr className="source-editor-row">
                    <td colSpan={7}>
                      <SourceEditor
                        row={row}
                        baseline={d.catalog_revision}
                        onDone={() => {
                          void refresh();
                        }}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {browser ? (
        <div className="source-builtin">
          <span>Browser Agent 运行时</span>
          <TestCell
            slot={browser.test}
            disabled={busy}
            onTest={() => void test("browser", browser.source_revision)}
          />
        </div>
      ) : null}
    </section>
  );
}

function TestCell({
  slot,
  disabled,
  onTest,
}: {
  slot: SourceTestSlot;
  disabled: boolean;
  onTest: () => void;
}) {
  if (slot.availability !== "ready") return null;
  const testing = slot.state === "queued" || slot.state === "running";
  return (
    <span className="source-test-cell">
      <Button size="compact" isDisabled={disabled || testing} onPress={onTest}>
        测试
      </Button>
      {testing ? (
        <span role="status">测试中…</span>
      ) : slot.latest ? (
        slot.latest.status === "available" ? (
          <span className="source-test-ok">
            {slot.latest.egress === "proxy" ? "可用 · 经代理" : "可用"}
          </span>
        ) : (
          <ProblemLabel display={slot.latest.status} />
        )
      ) : null}
    </span>
  );
}

/** One source's configuration: secrets are only replaced or cleared, never shown. */
function SourceEditor({
  row,
  baseline,
  onDone,
}: {
  row: SourceDirectoryRow;
  baseline: string;
  onDone: () => void;
}) {
  const api = useApi();
  const publicFields = row.configuration.fields.filter(
      (f): f is Extract<SourceConfigurationField, { credential: false }> =>
        !f.credential,
    ),
    secretFields = row.configuration.fields.filter(
      (f): f is Extract<SourceConfigurationField, { credential: true }> =>
        f.credential,
    );
  const [values, setValues] = useState<Record<string, string>>(() =>
      Object.fromEntries(
        publicFields.map((f) => [
          f.field,
          Array.isArray(f.value)
            ? f.value.join("\n")
            : typeof f.value === "string"
              ? f.value
              : "",
        ]),
      ),
    ),
    [touched, setTouched] = useState(false),
    [clear, setClear] = useState<ReadonlySet<string>>(new Set()),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState(""),
    [problem, setProblem] = useState<SourceProblem | null>(null);
  const secrets = useRef(new Map<string, HTMLInputElement>());
  const save = async () => {
    setPending(true);
    setMessage("");
    setProblem(null);
    const credentials = secretFields.flatMap((f): CredentialFieldEdit[] => {
      const input = secrets.current.get(f.field),
        value = input?.value ?? "";
      if (input) input.value = "";
      return value
        ? [{ field: f.field, action: "replace", value }]
        : clear.has(f.field)
          ? [{ field: f.field, action: "clear" }]
          : [];
    });
    const parameters =
      touched && publicFields.length
        ? {
            action: "set" as const,
            value: Object.fromEntries(
              publicFields.map((f) => {
                const v = values[f.field]?.trim() ?? "";
                return [
                  f.field,
                  f.type.kind === "string-array"
                    ? v
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean)
                    : v || null,
                ];
              }),
            ),
          }
        : { action: "keep" as const };
    try {
      const result = parseSourceSaveResult(
        (
          await api.request("/api/configuration/source-save", {
            source: row.source,
            baseline,
            parameters,
            credentials,
            test_after_save: true,
          })
        ).result,
      );
      if (result.status === "partial") {
        setMessage("只保存了部分配置，请重新核对后再保存其余项。");
        setProblem(result.problem);
      } else {
        setMessage(
          result.test_problem
            ? "已保存；自动测试没有启动，可以手动测试。"
            : "已保存，正在测试。",
        );
        setTouched(false);
        setClear(new Set());
      }
      onDone();
    } catch (error) {
      const conflict =
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "source-configuration-conflict";
      setMessage(
        conflict
          ? "配置刚被其他操作改过，已重新读取。请重新填写后再保存。"
          : `没有保存：${errorMessage(error)}`,
      );
      if (conflict) onDone();
      if (error && typeof error === "object" && "problem" in error)
        setProblem(error.problem as SourceProblem);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="source-editor">
      {secretFields.map((f) => (
        <div key={f.field} className="source-secret">
          <label>
            <span>
              {fieldName(f)}
              <span className="source-secret-state">
                {clear.has(f.field)
                  ? "将清除"
                  : f.present
                    ? "已配置"
                    : f.required
                      ? "未配置"
                      : "未配置（可选）"}
              </span>
            </span>
            <input
              ref={(el) => {
                if (el) secrets.current.set(f.field, el);
                else secrets.current.delete(f.field);
              }}
              className="ui-input"
              type="password"
              autoComplete="new-password"
              placeholder={f.present ? "填写新值以替换" : "填写后保存"}
            />
          </label>
          {f.present && f.actions.includes("clear") ? (
            <Button
              size="compact"
              variant="text"
              onPress={() =>
                setClear((prior) => {
                  const next = new Set(prior);
                  if (next.has(f.field)) next.delete(f.field);
                  else next.add(f.field);
                  return next;
                })
              }
            >
              {clear.has(f.field) ? "不清除" : "清除"}
            </Button>
          ) : null}
        </div>
      ))}
      {publicFields.map((f) => {
        const onChange = (v: string) => {
          setValues((prior) => ({ ...prior, [f.field]: v }));
          setTouched(true);
        };
        return f.type.kind === "enum" ? (
          <Select
            key={f.field}
            label={fieldName(f)}
            value={values[f.field] ?? ""}
            onChange={onChange}
            options={f.type.values.map((v) => ({
              value: v,
              label: valueNames[v] ?? v,
            }))}
          />
        ) : f.type.kind === "string-array" ? (
          <TextArea
            key={f.field}
            label={`${fieldName(f)}（每行一个）`}
            value={values[f.field] ?? ""}
            onChange={onChange}
          />
        ) : (
          <TextField
            key={f.field}
            label={fieldName(f)}
            type={f.type.format === "email" ? "email" : "text"}
            value={values[f.field] ?? ""}
            onChange={onChange}
          />
        );
      })}
      <div className="form-actions">
        <Button
          variant="primary"
          isPending={pending}
          onPress={() => void save()}
        >
          保存
        </Button>
        {message ? <span role="status">{message}</span> : null}
      </div>
      {problem ? (
        <>
          <ProblemLabel display={problem.display} />
          <ProblemDetails problem={problem} />
        </>
      ) : null}
    </div>
  );
}
