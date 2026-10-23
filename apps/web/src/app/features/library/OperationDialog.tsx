import { UsageEstimate } from "../processing/UsageEstimate.js";
import { jobRecord } from "../../data/wire.js";
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  parseDocumentRequest,
  type ProcessingOperation,
} from "@sciretriever/contracts";
import {
  Button,
  Checkbox,
  Dialog,
  Select,
  TextArea,
  TextField,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { archiveWrite } from "../../data/archive.js";
import { readLiterature } from "../../data/library.js";
import {
  createTask,
  identityOperation,
  processingTask,
  type OperationContext,
} from "../../data/operations.js";
import { navigate } from "../../data/url.js";
import { useShell } from "../../shell/context.js";
import { randomId } from "../../../browser-platform.js";
import { errorMessage } from "../../strings.js";

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const labels: Record<string, string> = {
  acquire: "获取 PDF",
  parse: "解析 PDF",
  analyze: "生成总结",
  archive: "建立文献档案",
  identity: "核验文章身份",
  export: "导出书目",
  upload: "补充 PDF",
};
export function OperationDialog({
  ids,
  kind,
  file,
  onClose,
}: {
  ids: readonly string[];
  kind: string;
  file?: File;
  onClose: () => void;
}) {
  const api = useApi(),
    shell = useShell(),
    queries = useQueryClient();
  const [key] = useState(randomId),
    [purpose, setPurpose] = useState("overview"),
    [question, setQuestion] = useState(""),
    [format, setFormat] = useState("bibtex"),
    [policy, setPolicy] = useState("never"),
    [attempts, setAttempts] = useState("1000"),
    [retries, setRetries] = useState("1"),
    [start, setStart] = useState(true),
    [selectedFile, setSelectedFile] = useState<File | null>(file ?? null);
  const [status, setStatus] = useState(""),
    [skipped, setSkipped] = useState<string[]>([]),
    [tasks, setTasks] = useState<string[]>([]),
    [done, setDone] = useState(false);
  const guard = useRef(false);
  const controller = useRef(new AbortController());
  const changed = () => {
    for (const queryKey of [
      ["tasks"],
      ["library"],
      ["literature"],
      ["knowledge"],
      ["processors"],
    ])
      void queries.invalidateQueries({ queryKey });
  };
  const operationContext: OperationContext = {
    api,
    signal: controller.current.signal,
    notify: shell.notify,
    onTasksChanged: changed,
  };
  const mutation = useMutation({
    mutationFn: async () => {
      setStatus("正在核对输入…");
      setSkipped([]);
      const unique = [...new Set(ids)];
      if (!unique.length || unique.length > 1000)
        throw new Error("请选择 1–1,000 篇文献。");
      if (kind === "export") {
        const parts: string[] = [];
        for (const id of unique) {
          const response = await api.fetch("/api/library/bibliography", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ literature_id: id, format }),
          });
          if (!response.ok) throw new Error(`导出未完成（${response.status}）`);
          parts.push(await response.text());
        }
        download(
          new Blob([parts.join("\n")], { type: "text/plain;charset=utf-8" }),
          `sciretriever.${format === "ris" ? "ris" : "bib"}`,
        );
        return `已导出 ${unique.length} 篇文献`;
      }
      if (kind === "upload") {
        if (
          !selectedFile ||
          selectedFile.size < 1 ||
          selectedFile.size > 16 * 1024 * 1024
        )
          throw new Error("请选择不超过 16 MiB 的非空 PDF。");
        const response = await api.fetch("/api/v1/maintenance/ingest-pdf", {
          method: "POST",
          headers: {
            "Content-Type": "application/pdf",
            "X-Sciretriever-Protocol-Version": "1",
            "X-Sciretriever-Csrf": api.csrf,
            "X-Literature-Id": unique[0]!,
          },
          body: selectedFile,
        });
        await api.json(response);
        return "PDF 已接纳，原有材料已保留。";
      }
      if (kind === "acquire") {
        const id = await createTask(
          operationContext,
          {
            kind: "acquire-pdf",
            idempotency_key: key,
            selector: { kind: "literatures", literature_ids: unique },
            policy: {
              mode: policy,
              max_attempts: Number(attempts),
              max_retries: Number(retries),
            },
          },
          start,
        );
        setTasks([id]);
        return "任务已保存；执行进度与结果请查看任务。";
      }
      if (kind === "archive") {
        await archiveWrite(
          api,
          "archive",
          {
            operation: "build",
            request: {
              selector: { kind: "literatures", literature_ids: unique },
              mode: "full",
              from_step: null,
              idempotency_key: key,
            },
          },
          controller.current.signal,
        );
        return "建档任务已提交；不会重新调用解析服务。";
      }
      if (kind === "analyze") {
        const response = await api.submitProcessor(
          {
            schema_version: 1,
            idempotency_key: key,
            name: "文献总结",
            processor: { id: "summary", version: "2" },
            spec: {
              purpose,
              question: purpose === "question" ? question : null,
            },
            inputs: unique.map((literature_id) => ({
              kind: "literature",
              literature_id,
            })),
          },
          true,
          controller.current.signal,
        );
        setTasks([String(jobRecord(response.task).job_id)]);
        return "总结任务已提交；未就绪文献将作为缺口显示。";
      }
      const operations: ProcessingOperation[] = [],
        missing: string[] = [];
      for (const id of unique) {
        try {
          if (kind === "identity")
            operations.push(await identityOperation(operationContext, id));
          else if (kind === "parse") {
            const detail = await readLiterature(
                api,
                id,
                controller.current.signal,
              ),
              asset = detail.primary_pdf?.asset;
            if (!asset) throw new Error("缺少 PDF");
            const source = {
              literature_id: id,
              asset_id: asset.asset_id,
              asset_sha256: asset.sha256,
            };
            operations.push({
              operation: "parse-documents",
              request: parseDocumentRequest({
                ...source,
                force: false,
              }),
            });
          } else throw new Error("不支持的操作");
        } catch (error) {
          missing.push(`${id}：${errorMessage(error)}`);
        }
      }
      setSkipped(missing);
      const submitted: string[] = [];
      for (let offset = 0; offset < operations.length; offset += 100) {
        const id = await processingTask(
          operationContext,
          operations.slice(offset, offset + 100),
          `${key}-${offset}`,
        );
        submitted.push(id);
        setTasks([...submitted]);
      }
      return `已提交 ${operations.length} 项，${missing.length} 篇未提交。`;
    },
    onSuccess: (message) => {
      setStatus(message);
      setDone(true);
      changed();
      shell.notify(message);
    },
    onError: (error) => setStatus(`操作未完成：${errorMessage(error)}`),
    onSettled: () => {
      guard.current = false;
    },
  });
  const submit = () => {
    if (guard.current || done) return;
    guard.current = true;
    mutation.mutate();
  };
  return (
    <Dialog
      title={labels[kind] ?? "处理文献"}
      isOpen
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onClose();
      }}
      footer={
        <>
          <Button onPress={onClose} isDisabled={mutation.isPending}>
            {done ? "关闭" : "取消"}
          </Button>
          {!done && (
            <Button
              variant={kind === "export" ? "primary" : "process"}
              confirm={false}
              isPending={mutation.isPending}
              onPress={submit}
            >
              {kind === "export"
                ? "导出"
                : kind === "upload"
                  ? "确认上传"
                  : "确认启动"}
            </Button>
          )}
        </>
      }
    >
      {(kind === "archive" || kind === "analyze") && !done ? (
        <UsageEstimate
          request={
            kind === "archive"
              ? {
                  kind: "archive",
                  request: {
                    selector: {
                      kind: "literatures",
                      literature_ids: [...new Set(ids)],
                    },
                  },
                }
              : {
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
                    inputs: [...new Set(ids)].map((literature_id) => ({
                      kind: "literature",
                      literature_id,
                    })),
                  },
                }
          }
        />
      ) : null}

      <p>范围已固定：{ids.length} 篇文献。</p>
      <p className="muted">
        {kind === "export"
          ? "导出已有书目信息，不改动文献库。"
          : kind === "acquire"
            ? "将使用配置的文献来源获取 PDF，必要时调用 Browser Agent；不会等待人工帮助。"
            : kind === "parse"
              ? "将调用配置的解析服务。已接纳的 PDF 和旧解析版本会保留。"
              : kind === "upload"
                ? "将文件接纳到所选文献，现有主 PDF 不会被覆盖。"
                : "将使用配置的模型处理已有材料；缺少的输入逐项说明，不自动生成前序材料。"}
      </p>
      {kind === "export" && (
        <Select
          label="导出格式"
          value={format}
          onChange={setFormat}
          options={[
            { value: "bibtex", label: "BibTeX" },
            { value: "ris", label: "RIS" },
          ]}
        />
      )}
      {kind === "upload" && (
        <label className="file-field">
          PDF 文件
          <input
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) =>
              setSelectedFile(event.target.files?.[0] ?? null)
            }
          />
          {selectedFile && <span>{selectedFile.name}</span>}
        </label>
      )}
      {kind === "analyze" && (
        <>
          <Select
            label="分析用途"
            value={purpose}
            onChange={setPurpose}
            options={[
              { value: "overview", label: "概览" },
              { value: "detailed", label: "详细分析" },
              { value: "question", label: "围绕问题" },
            ]}
          />
          {purpose === "question" && (
            <TextArea
              label="研究问题"
              value={question}
              onChange={setQuestion}
            />
          )}
          <p className="muted">
            DSH 在同一会话中阅读原文、图像与证据后提交结果。
          </p>
        </>
      )}
      {kind === "acquire" && (
        <>
          <Select
            label="受阻时"
            value={policy}
            onChange={setPolicy}
            options={[
              { value: "never", label: "自动处理" },
              { value: "notify", label: "通知并继续" },
              { value: "pause", label: "暂停等待人工" },
            ]}
          />
          <TextField label="尝试上限" value={attempts} onChange={setAttempts} />
          <TextField label="重试上限" value={retries} onChange={setRetries} />
          <Checkbox
            label="保存后立即执行"
            isSelected={start}
            onChange={setStart}
          />
        </>
      )}
      <p role={mutation.isError ? "alert" : "status"}>{status}</p>
      {skipped.length > 0 && (
        <details>
          <summary>{skipped.length} 篇未提交</summary>
          <ul>
            {skipped.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      )}
      {tasks.map((id) => (
        <Button
          key={id}
          onPress={() => {
            onClose();
            navigate(
              { view: "task", task: id, literature: null },
              { clearSource: true },
            );
          }}
        >
          查看任务
        </Button>
      ))}
    </Dialog>
  );
}
