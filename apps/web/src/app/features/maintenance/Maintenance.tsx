import { UsageEstimate } from "../processing/UsageEstimate.js";
import {
  extractionSpecHash,
  parseDocumentReceipt,
  parseDocumentRequest,
  parseExtractionPreparationRequest,
  parseExtractionPreparationResult,
  parseProcessingTaskRequest,
  parseStrictJsonValue,
  type ExtractionSpec,
} from "@sciretriever/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { randomId } from "../../../browser-platform.js";
import {
  Button,
  Card,
  Checkbox,
  ErrorNotice,
  PageHeader,
  Select,
  Tabs,
  TechDetails,
  TextArea,
  TextField,
} from "../../components/index.js";
import { readLiterature, scopeIds } from "../../data/library.js";
import {
  createTask,
  processingTask,
  type OperationContext,
} from "../../data/operations.js";
import { useApi } from "../../data/query.js";
import { navigate, useUrlState } from "../../data/url.js";
import { record } from "../../data/wire.js";
import { useShell } from "../../shell/context.js";
import { errorMessage } from "../../strings.js";
import Snapshots from "../archive/Snapshots.js";
import { boundedResponseBytes, extractionTransport } from "./delivery.js";
import "./maintenance.css";
import {
  rebuildProgress,
  useIndexStatus,
  useRebuildIndex,
  working,
} from "../retrieval/IndexLine.js";
import { maintain } from "./transport.js";

export default function Maintenance({
  deliveryOnly = false,
}: {
  deliveryOnly?: boolean;
}) {
  const api = useApi(),
    shell = useShell(),
    route = useUrlState();
  const [tab, setTab] = useState(deliveryOnly ? "delivery" : "materials");
  return (
    <section className="maintenance-page">
      <PageHeader title={deliveryOnly ? "规范与交付" : "高级维护"} />
      {!deliveryOnly && api.kind !== "query" ? (
        <Tabs
          label="维护功能"
          value={tab}
          onChange={setTab}
          items={[
            { id: "materials", label: "材料与分析" },
            { id: "delivery", label: "规范与交付" },
            { id: "indexes", label: "索引与请求" },
          ]}
        />
      ) : null}
      {api.kind === "query" || tab === "delivery" ? (
        <Delivery
          onUseSelected={async () => {
            const ids = shell.selected.size
              ? [...shell.selected]
              : await scopeIds(api, route.query, route.sort);
            const inputs = [];
            for (const [index, id] of ids.entries()) {
              const detail = await readLiterature(api, id);
              inputs.push({
                input_id: `source-${index + 1}`,
                literature_id: id,
                asset_id: detail.primary_pdf?.asset.asset_id ?? null,
                asset_sha256: detail.primary_pdf?.asset.sha256 ?? null,
                document_version_id: null,
              });
            }
            return JSON.stringify(inputs, null, 2);
          }}
        />
      ) : tab === "materials" ? (
        <Materials />
      ) : (
        <Indexes />
      )}
    </section>
  );
}
function Delivery({ onUseSelected }: { onUseSelected: () => Promise<string> }) {
  const api = useApi(),
    transport = useMemo(() => extractionTransport(api), [api]);
  const [spec, setSpec] = useState(""),
    [inputs, setInputs] = useState(""),
    [prepared, setPrepared] = useState(""),
    [caller, setCaller] = useState(""),
    [operation, setOperation] = useState(""),
    [batch, setBatch] = useState(""),
    [receipt, setReceipt] = useState(""),
    [status, setStatus] = useState(""),
    [output, setOutput] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    write = api.kind !== "query";
  const change = (set: (value: string) => void) => (value: string) => {
    set(value);
    setOutput(null);
    setStatus("输入已修改；请重新校验或读取所选历史回执。");
    setError("");
  };
  const run = async (action: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setOutput(null);
    setStatus("正在检查并处理请求…");
    try {
      const result = await action();
      setOutput(result);
      if (result === null) {
        setStatus("未知或已过期；无法恢复历史候选载荷。");
        return;
      }
      const value = record(result, "extraction result");
      if (typeof value.operation_id === "string")
        setOperation(value.operation_id);
      const resultReceipt =
        typeof value.receipt_id === "string"
          ? value.receipt_id
          : value.receipt &&
              typeof value.receipt === "object" &&
              "receipt_id" in value.receipt
            ? value.receipt.receipt_id
            : null;
      if (typeof resultReceipt === "string") setReceipt(resultReceipt);
      setStatus("请求已完成；请保存当前回执。");
    } catch (failure) {
      setError(errorMessage(failure));
      setStatus("请求失败，已接纳的材料不受影响。");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const post = (path: string, request: unknown) => {
    transport.setPreparation(prepared);
    return transport.post(path, request);
  };
  return (
    <div className="maintenance-grid">
      <Card title="准备提取输入">
        <p>这里只读取已经接纳的资料。缺少的能力会作为缺口返回。</p>
        <Button
          isDisabled={busy}
          onPress={async () => change(setInputs)(await onUseSelected())}
        >
          使用库中选定范围
        </Button>
        <TextArea
          label="规范 JSON"
          width="full"
          description="可省略 spec_sha256，由本页计算。规范与领域含义由调用方负责。"
          value={spec}
          onChange={change(setSpec)}
          rows={8}
          isDisabled={busy}
        />
        <TextArea
          label="显式输入 JSON 数组"
          width="full"
          value={inputs}
          onChange={change(setInputs)}
          rows={5}
          isDisabled={busy}
        />
        <Button
          isDisabled={
            busy ||
            !spec.trim() ||
            !inputs.trim() ||
            api.workspace.readiness !== "ready"
          }
          onPress={() =>
            run(async () => {
              const raw = record(parseStrictJsonValue(spec), "extraction spec");
              const fixed = Object.hasOwn(raw, "spec_sha256")
                ? raw
                : {
                    ...raw,
                    spec_sha256: await extractionSpecHash(
                      raw as unknown as Omit<ExtractionSpec, "spec_sha256">,
                    ),
                  };
              const request = await parseExtractionPreparationRequest({
                spec: fixed,
                inputs: parseStrictJsonValue(inputs),
              });
              const response = await api.fetch(
                "/api/v1/query/extraction-prepare",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ protocol_version: 1, request }),
                },
              );
              const envelope = record(
                parseStrictJsonValue(
                  await boundedResponseBytes(response, 512 * 1024),
                ),
                "extraction preparation",
              );
              if (!response.ok)
                throw new Error(String(envelope.code ?? "准备失败"));
              if (envelope.protocol_version !== 1)
                throw new Error("准备回执无效");
              const result = await parseExtractionPreparationResult(
                envelope.result,
                request,
              );
              setPrepared(JSON.stringify(result, null, 2));
              return result;
            })
          }
        >
          检查规范并固定输入
        </Button>
      </Card>
      {write ? (
        <Card title="提取候选交付">
          <p>
            回执保留检查摘要和证据保护；领域接纳由下游负责，不托管历史候选载荷。
          </p>
          <TextField
            label="调用方 namespace"
            value={caller}
            onChange={change(setCaller)}
            placeholder="local.research-agent"
            isDisabled={busy}
          />
          <TextArea
            label="输入准备结果 JSON"
            width="full"
            value={prepared}
            onChange={change(setPrepared)}
            rows={6}
            isDisabled={busy}
          />
          <Button
            isDisabled={busy || !caller || !prepared}
            confirm={{
              title: "创建交付操作？",
              description:
                "将固定调用方、提取规范和输入版本，建立候选交付记录。",
              confirmLabel: "创建 operation",
            }}
            onPress={() =>
              run(async () => {
                const fixed = record(
                  parseStrictJsonValue(prepared),
                  "preparation",
                );
                return post("operation", {
                  caller_id: caller.trim(),
                  spec: fixed.spec,
                  manifest: fixed.manifest,
                });
              })
            }
          >
            创建 operation
          </Button>
          <TextField
            label="Operation ID"
            value={operation}
            onChange={change(setOperation)}
            isDisabled={busy}
          />
          <TextArea
            label="候选批次 JSON"
            width="full"
            value={batch}
            onChange={change(setBatch)}
            rows={8}
            isDisabled={busy}
          />
          <div className="maintenance-actions">
            <Button
              isDisabled={busy || !batch || !operation}
              confirm={{
                title: "提交候选批次？",
                description:
                  "将核对规范、固定输入与字段证据，接纳后返回交付回执。",
                confirmLabel: "提交候选批次",
              }}
              onPress={() =>
                run(async () => {
                  const value = record(
                    parseStrictJsonValue(batch),
                    "submission",
                  );
                  if (value.operation_id !== operation.trim())
                    throw new Error("批次 operation_id 与当前选择不一致");
                  return post("submit", value);
                })
              }
            >
              提交候选批次
            </Button>
            {(
              [
                ["close", "关闭 operation"],
                ["cancel", "取消 operation"],
              ] as const
            ).map(([action, label]) => (
              <Button
                key={action}
                isDisabled={busy || !operation}
                confirm={{
                  title: `${label}？`,
                  description: "已有回执与证据保护按现有交付合同保留。",
                  confirmLabel: label,
                }}
                onPress={() =>
                  run(() => post(action, { operation_id: operation.trim() }))
                }
              >
                {label}
              </Button>
            ))}
          </div>
          <TextField
            label="Receipt ID"
            value={receipt}
            onChange={change(setReceipt)}
            isDisabled={busy}
          />
          <Button
            isDisabled={busy || !receipt}
            onPress={() =>
              run(() => post("receipt", { receipt_id: receipt.trim() }))
            }
          >
            读取回执与保护
          </Button>
          <Button
            isDisabled={busy}
            confirm={{
              title: "清理过期交付记录？",
              description:
                "只按现有到期规则清理，最多 100 项，不删除仍受保护的文献材料。",
              confirmLabel: "清理过期记录",
            }}
            onPress={() => run(() => post("cleanup", { limit: 100 }))}
          >
            清理最多 100 项过期记录
          </Button>
        </Card>
      ) : null}
      <div className="maintenance-output" data-testid="delivery-feedback">
        <p role="status">{status}</p>
        {error ? <ErrorNotice message={error} /> : null}
        {output !== null ? (
          <TechDetails
            title="回执与固定输入"
            copyText={JSON.stringify(output, null, 2)}
          >
            <pre data-testid="delivery-result">
              {JSON.stringify(output, null, 2)}
            </pre>
          </TechDetails>
        ) : null}
      </div>
    </div>
  );
}
function useOperationContext(): OperationContext {
  const api = useApi(),
    shell = useShell(),
    queries = useQueryClient();
  const lifecycle = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    return () => controller.abort();
  }, []);
  return {
    api,
    get signal() {
      return lifecycle.current.signal;
    },
    notify: shell.notify,
    onTasksChanged: () => {
      for (const key of ["tasks", "library", "knowledge", "document"])
        void queries.invalidateQueries({ queryKey: [key] });
    },
  };
}
function Materials() {
  const api = useApi(),
    context = useOperationContext();
  const [literature, setLiterature] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [mode, setMode] = useState("reuse-current"),
    [material, setMaterial] = useState<{
      literature_id: string;
      asset_id: string;
      asset_sha256: string;
    } | null>(null),
    [status, setStatus] = useState(""),
    [purpose, setPurpose] = useState("overview"),
    [question, setQuestion] = useState("");
  const submission = useRef<{ draft: string; key: string } | null>(null);
  const [active, setActive] = useState<AbortController | null>(null),
    [result, setResult] = useState<unknown>(null);
  const lock = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      request.current?.abort();
      request.current = null;
    },
    [],
  );
  const run = async (action: (signal: AbortSignal) => Promise<string>) => {
    if (lock.current) return;
    lock.current = true;
    const controller = new AbortController();
    request.current = controller;
    setActive(controller);
    setStatus("正在处理…");
    try {
      const message = await action(controller.signal);
      if (!controller.signal.aborted) setStatus(message);
    } catch (error) {
      if (!controller.signal.aborted) {
        setStatus("请求失败；已经保存的材料和结果仍保留。");
        throw error;
      }
    } finally {
      lock.current = false;
      if (request.current === controller) {
        request.current = null;
        setActive(null);
      }
    }
  };
  return (
    <div className="maintenance-grid">
      <Card title="接纳与解析材料">
        <TextField
          label="文献编号"
          value={literature}
          onChange={(value) => {
            setLiterature(value);
            setMaterial(null);
          }}
          isDisabled={!!active}
        />
        <label className="ui-label" htmlFor="maintenance-pdf">
          PDF 文件
        </label>
        <input
          id="maintenance-pdf"
          className="ui-file"
          type="file"
          accept="application/pdf,.pdf"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          disabled={!!active}
        />
        <Button
          isDisabled={!!active || !file || !literature}
          confirm={{
            title: "接纳这个 PDF？",
            description: "文件将接纳到选定文献，已有资产保留。",
            confirmLabel: "接纳 PDF",
          }}
          onPress={() =>
            run(async (signal) => {
              // In the workspace the PDF goes through intake (product
              // interface 2.4.2): streamed, no size limit, into the day's
              // “补充文件” batch. The independent maintenance entry has no
              // intake routes and keeps its own route and limit.
              if (api.kind === "workspace") {
                if (!file || file.size < 1)
                  throw new Error("请选择一个非空的 PDF。");
                const result = await api.send(
                  `/api/v1/intake/literatures/${encodeURIComponent(literature.trim())}/pdf`,
                  file,
                  signal,
                  { "X-Sciretriever-File-Name": encodeURIComponent(file.name) },
                );
                context.onTasksChanged();
                const status =
                  result.file && typeof result.file === "object"
                    ? (result.file as { status?: unknown }).status
                    : null;
                return status === "existing"
                  ? "库里已有相同的 PDF，没有重复保存。"
                  : status === "conflict"
                    ? "这篇文献已有另一份 PDF，没有替换。"
                    : "PDF 已上传，归入今天的“补充文件”批次；原有材料保留。";
              }
              if (!file || file.size < 1 || file.size > 16 * 1024 * 1024)
                throw new Error("请选择不超过 16 MiB 的非空 PDF。");
              const session = await api.read(
                "/api/v1/maintenance/session",
                signal,
              );
              if (typeof session.csrf !== "string")
                throw new Error("维护会话无效");
              const response = await api.fetch(
                "/api/v1/maintenance/ingest-pdf",
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/pdf",
                    "X-Sciretriever-Protocol-Version": "1",
                    "X-Sciretriever-Csrf": session.csrf,
                    "X-Literature-Id": literature.trim(),
                  },
                  body: file,
                  signal,
                },
              );
              await api.json(response);
              context.onTasksChanged();
              return "PDF 已接纳，原有材料保留。";
            })
          }
        >
          接纳 PDF
        </Button>
        <Button
          isDisabled={!!active || !literature}
          onPress={() =>
            run(async (signal) => {
              const detail = await readLiterature(
                  api,
                  literature.trim(),
                  signal,
                ),
                asset = detail.primary_pdf?.asset;
              if (!asset) throw new Error("该文献没有已接纳的主 PDF");
              setMaterial({
                literature_id: literature.trim(),
                asset_id: asset.asset_id,
                asset_sha256: asset.sha256,
              });
              return "已选择当前 PDF。";
            })
          }
        >
          从文献库读取当前 PDF
        </Button>
        {material ? (
          <TechDetails>
            <p>PDF：{material.asset_id}</p>
            <p>SHA-256：{material.asset_sha256}</p>
          </TechDetails>
        ) : null}
        <Select
          label="解析方式"
          value={mode}
          onChange={setMode}
          isDisabled={!!active}
          options={[
            { value: "reuse-current", label: "补齐解析（复用已有结果）" },
            { value: "reparse", label: "明确重解析" },
          ]}
        />
        <Button
          isDisabled={!!active || !material}
          confirm={{
            title: mode === "reparse" ? "重新解析这个 PDF？" : "解析这个 PDF？",
            description:
              mode === "reparse"
                ? "将调用已配置的解析服务，并保留已有解析版本。"
                : "复用已有成功结果，只调用解析服务补齐缺失模式。完成后可另行发起建档。",
            confirmLabel: "解析 PDF",
          }}
          onPress={() =>
            run(async (signal) => {
              if (!material || material.literature_id !== literature.trim())
                throw new Error("请重新选择当前材料");
              const request = parseDocumentRequest({
                literature_id: material.literature_id,
                asset_id: material.asset_id,
                asset_sha256: material.asset_sha256,
                force: mode === "reparse",
              });
              if (api.kind === "workspace") {
                const id = await processingTask({ ...context, signal }, [
                  { operation: "parse-documents", request },
                ]);
                return `任务已提交：${id}`;
              }
              const receipt = parseDocumentReceipt(
                (await maintain(api, "parse-document", request, signal))
                  .receipt,
              );
              if (
                receipt.literature_id !== request.literature_id ||
                receipt.asset_sha256 !== request.asset_sha256
              )
                throw new Error("解析回执与当前材料不匹配");
              setResult(receipt);
              context.onTasksChanged();
              return receipt.profiles
                .map(
                  (p) =>
                    `${p.profile}：${p.status === "failed" ? p.failure_code : p.status === "reused" ? "已复用" : "已保存"}`,
                )
                .join("；");
            })
          }
        >
          解析 PDF
        </Button>
      </Card>
      <Card title="DSH 单篇分析">
        <p>
          使用所选文献的已建档校订稿。DSH
          持续读取正文和图片；调用模型必须显式确认。
        </p>
        <Select
          label="总结用途"
          value={purpose}
          onChange={setPurpose}
          isDisabled={!!active}
          options={[
            { value: "overview", label: "概览" },
            { value: "detailed", label: "详细分析" },
            { value: "question", label: "针对问题" },
          ]}
        />
        <TextArea
          label="分析问题"
          value={question}
          onChange={setQuestion}
          isDisabled={!!active || purpose !== "question"}
        />
        <UsageEstimate
          request={
            literature.trim()
              ? {
                  kind: "processor",
                  request: {
                    schema_version: 1,
                    idempotency_key: "estimate",
                    name: "文献总结",
                    processor: { id: "summary", version: "2" },
                    spec: {
                      purpose,
                      question: purpose === "question" ? question : null,
                    },
                    inputs: [
                      { kind: "literature", literature_id: literature.trim() },
                    ],
                  },
                }
              : null
          }
        />
        <Button
          isDisabled={!!active || !literature}
          confirm={{
            title: "启动 DSH 分析？",
            description:
              "将读取固定文档和图片，调用已配置的模型并发布有证据的分析结果。",
            confirmLabel: "启动分析",
          }}
          onPress={() =>
            run(async (signal) => {
              const draft = JSON.stringify([
                literature.trim(),
                purpose,
                purpose === "question" ? question : null,
              ]);
              if (submission.current?.draft !== draft)
                submission.current = { draft, key: randomId() };
              const receipt = await api.submitProcessor(
                {
                  schema_version: 1,
                  idempotency_key: submission.current.key,
                  name: "文献总结",
                  processor: { id: "summary", version: "2" },
                  spec: {
                    purpose,
                    question: purpose === "question" ? question : null,
                  },
                  inputs: [
                    { kind: "literature", literature_id: literature.trim() },
                  ],
                },
                true,
                signal,
              );
              setResult(receipt);
              context.onTasksChanged();
              return "总结任务已提交，使用已建档校订稿，进度可在任务页查看。";
            })
          }
        >
          启动单篇分析
        </Button>
      </Card>
      <Snapshots />
      <div className="maintenance-output">
        <p role="status">{status}</p>
        {active ? (
          <Button
            onPress={() => {
              active.abort();
              setStatus(
                "当前请求已取消；已经提交的材料或产物仍保留，请在文献库核对。",
              );
            }}
          >
            取消当前请求
          </Button>
        ) : null}
        {result ? (
          <TechDetails copyText={JSON.stringify(result, null, 2)}>
            <pre>{JSON.stringify(result, null, 2)}</pre>
          </TechDetails>
        ) : null}
      </div>
    </div>
  );
}
/** The rebuild runs on the server; the card only reads and queues it. */
function IndexCard() {
  const index = useIndexStatus(null).data,
    rebuild = useRebuildIndex();
  // The finish time seen when this page asked for a rebuild, so an older
  // finished rebuild is not reported as this one.
  const [asked, setAsked] = useState<string | null | undefined>(undefined);
  const rebuilding = !!index && working(index) && index.operation === "rebuild";
  let text = "";
  if (rebuilding) {
    const done = rebuildProgress(index);
    text = `正在重建全文索引${done && `，${done}`}。期间照常可搜，可以离开本页。`;
  } else if (index && working(index)) text = "全文索引正在更新最近变化的文献。";
  else if (
    asked !== undefined &&
    index?.operation === "rebuild" &&
    index.finished_at !== asked
  )
    text =
      index.status === "failed"
        ? "重建没有完成，旧索引仍照常可搜。可以重试。"
        : `全文索引已重建${index.last_refresh_ms ? `，用时 ${Math.max(1, Math.round(index.last_refresh_ms / 1000))} 秒` : ""}。`;
  else if (index?.index_state === "missing") text = "还没有全文索引。";
  else if (index?.index_state === "corrupt")
    text = "全文索引已损坏，需要重建。";
  return (
    <Card title="全文索引">
      <p>
        从已保存的元数据和原文重新建立全文索引，不下载
        PDF、解析材料或调用模型。平时索引会随文献变化自动更新，只在索引缺失、损坏或检索结果明显不对时需要重建。
      </p>
      <Button
        isDisabled={rebuilding}
        confirm={{
          title: "重建全文索引？",
          description:
            "约需几分钟，在后台进行，期间旧索引照常可搜。可以离开本页，完成后自动生效。",
          confirmLabel: "重建全文索引",
        }}
        onPress={async () => {
          setAsked(index?.finished_at ?? null);
          await rebuild();
        }}
      >
        重建全文索引
      </Button>
      <p role="status">{text}</p>
    </Card>
  );
}

function Indexes() {
  const api = useApi(),
    context = useOperationContext();
  const [raw, setRaw] = useState(""),
    [start, setStart] = useState(false),
    [task, setTask] = useState("");
  return (
    <div className="maintenance-grid">
      <IndexCard />
      {api.kind === "workspace" ? (
        <Card title="提交加工请求 JSON">
          <p>
            高级入口遵循同一 ProcessingTaskRequest
            合同；不会绕过模型或解析的配置与校验。
          </p>
          <TextArea
            label="加工请求 JSON"
            width="full"
            value={raw}
            onChange={setRaw}
            rows={10}
          />
          <UsageEstimate
            request={(() => {
              try {
                return {
                  kind: "processing",
                  request: parseStrictJsonValue(raw),
                };
              } catch {
                return null;
              }
            })()}
          />
          <Checkbox isSelected={start} onChange={setStart}>
            保存后立即执行
          </Checkbox>
          <Button
            isDisabled={!raw.trim()}
            confirm={{
              title: "提交加工任务？",
              description: start
                ? "任务保存后立即执行，请核对请求中的操作与输入。"
                : "只保存任务，后续可在任务页显式启动。",
              confirmLabel: "提交任务",
            }}
            onPress={async () => {
              const request = await parseProcessingTaskRequest(
                parseStrictJsonValue(raw),
              );
              setTask(
                await createTask(
                  context,
                  { kind: "processing", request },
                  start,
                ),
              );
            }}
          >
            提交任务
          </Button>
          {task ? (
            <>
              <p role="status">任务已提交。</p>
              <Button onPress={() => navigate({ view: "task", task })}>
                查看任务
              </Button>
              <TechDetails copyText={task}>
                <p>{task}</p>
              </TechDetails>
            </>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
