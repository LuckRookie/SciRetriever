import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AcquirePdfCounts,
  AcquirePdfSelector,
  LibraryQuery,
  LibrarySort,
  LiteratureId,
} from "@sciretriever/contracts";
import {
  Button,
  Checkbox,
  Dialog,
  ErrorNotice,
  Select,
  TextField,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { previewAcquisition } from "../../data/intake-batches.js";
import { createTask } from "../../data/operations.js";
import { SORT_LABELS } from "../../data/library.js";
import { navigate } from "../../data/url.js";
import { useShell } from "../../shell/context.js";
import { randomId } from "../../../browser-platform.js";
import { errorMessage } from "../../strings.js";

/** Where the papers come from: picked rows, or a library filter taken whole. */
export type AcquireScope =
  | { kind: "literatures"; ids: readonly string[]; label: string }
  | {
      kind: "query";
      query: LibraryQuery;
      sort: LibrarySort;
      /** What the filter means to a person: batch name, terms, statuses. */
      label: string;
    };

/** “Skipped” as a sentence, leaving out the empty reasons. */
export function skippedText(counts: AcquirePdfCounts) {
  const parts = [
    counts.skipped_has_pdf ? `${counts.skipped_has_pdf} 篇已有 PDF` : "",
    counts.skipped_unavailable
      ? `${counts.skipped_unavailable} 篇已标记无法获取`
      : "",
    counts.over_limit ? `${counts.over_limit} 篇超出本次上限` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "无";
}

/** Get PDFs for a stated scope: the counts are read before anything is submitted. */
export function AcquireDialog({
  scope,
  onClose,
}: {
  scope: AcquireScope;
  onClose: () => void;
}) {
  const api = useApi(),
    shell = useShell(),
    queries = useQueryClient();
  const [key] = useState(randomId),
    [limitText, setLimitText] = useState(""),
    [limit, setLimit] = useState<number | null>(null),
    [policy, setPolicy] = useState("never"),
    [attempts, setAttempts] = useState("1000"),
    [retries, setRetries] = useState("1"),
    [start, setStart] = useState(true),
    [task, setTask] = useState<string | null>(null);
  const guard = useRef(false);
  const limitInvalid =
    limitText.trim() !== "" &&
    !(/^\d+$/.test(limitText.trim()) && Number(limitText) >= 1);
  // The preview follows the cap only after typing settles.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (limitInvalid) return;
      setLimit(limitText.trim() ? Number(limitText) : null);
    }, 300);
    return () => clearTimeout(timer);
  }, [limitText, limitInvalid]);
  const selector: AcquirePdfSelector =
    scope.kind === "query"
      ? { kind: "query", query: scope.query, sort: scope.sort, limit }
      : {
          kind: "literatures",
          literature_ids: [...new Set(scope.ids)] as LiteratureId[],
        };
  const preview = useQuery({
    queryKey: ["library", "acquire-preview", selector],
    queryFn: ({ signal }) => previewAcquisition(api, selector, signal),
    staleTime: 0,
    enabled: !task,
  });
  const counts = preview.data;
  const submit = useMutation({
    mutationFn: async () => {
      const id = await createTask(
        {
          api,
          signal: new AbortController().signal,
          notify: shell.notify,
          onTasksChanged: () => {
            void queries.invalidateQueries({ queryKey: ["tasks"] });
            void queries.invalidateQueries({ queryKey: ["library"] });
          },
        },
        {
          kind: "acquire-pdf",
          idempotency_key: key,
          selector,
          policy: {
            mode: policy,
            max_attempts: Number(attempts),
            max_retries: Number(retries),
          },
        },
        start,
      );
      return id;
    },
    onSuccess: (id) => {
      setTask(id);
      shell.notify(`已提交获取 ${counts?.process ?? ""} 篇 PDF 的任务`);
    },
    onSettled: () => {
      guard.current = false;
    },
  });
  const process = counts?.process ?? 0;
  return (
    <Dialog
      title="获取 PDF"
      isOpen
      onOpenChange={(open) => {
        if (!open && !submit.isPending) onClose();
      }}
      footer={
        task ? (
          <>
            <Button onPress={onClose}>关闭</Button>
            <Button
              variant="primary"
              onPress={() => {
                onClose();
                navigate(
                  { view: "task", task, literature: null },
                  { clearSource: true },
                );
              }}
            >
              查看任务
            </Button>
          </>
        ) : (
          <>
            <Button onPress={onClose} isDisabled={submit.isPending}>
              取消
            </Button>
            <Button
              variant="process"
              confirm={false}
              isPending={submit.isPending}
              disabledReason={
                limitInvalid
                  ? "本次最多需要填正整数，或留空表示不限。"
                  : !counts
                    ? "正在核对范围…"
                    : process === 0
                      ? "范围内没有需要获取 PDF 的文献。"
                      : undefined
              }
              onPress={() => {
                if (guard.current) return;
                guard.current = true;
                submit.mutate();
              }}
            >
              获取 {process.toLocaleString()} 篇
            </Button>
          </>
        )
      }
    >
      <dl className="acquire-scope">
        <dt>范围</dt>
        <dd>{scope.label}</dd>
        <dt>处理</dt>
        <dd role="status">
          {preview.isPending ? (
            "正在核对…"
          ) : counts ? (
            <>
              <b>{process.toLocaleString()} 篇</b>
              {scope.kind === "query" ? "还没有 PDF 的文献" : null}
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt>跳过</dt>
        <dd className="acquire-skipped">
          {counts ? skippedText(counts) : "—"}
        </dd>
      </dl>
      {preview.isError ? (
        <ErrorNotice
          message={errorMessage(preview.error)}
          onRetry={() => void preview.refetch()}
        />
      ) : null}
      {submit.isError ? (
        <ErrorNotice message={`任务未提交：${errorMessage(submit.error)}`} />
      ) : null}
      {task ? (
        <p role="status">任务已保存；执行进度与结果请查看任务。</p>
      ) : (
        <>
          {scope.kind === "query" ? (
            <div className="acquire-limit">
              <TextField
                label="本次最多"
                width="short"
                value={limitText}
                onChange={setLimitText}
                placeholder="不限"
                {...(limitInvalid
                  ? { errorMessage: "填正整数，或留空表示不限" }
                  : {})}
              />
              <span className="muted">
                篇，按“{SORT_LABELS[scope.sort]}”顺序取前面的
              </span>
            </div>
          ) : null}
          <p className="muted">
            将使用配置的文献来源获取 PDF，必要时调用 Browser
            Agent；成员在提交时固定，之后入库的文献不会加入。
          </p>
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
          <TextField
            label="尝试上限"
            width="short"
            value={attempts}
            onChange={setAttempts}
          />
          <TextField
            label="重试上限"
            width="short"
            value={retries}
            onChange={setRetries}
          />
          <Checkbox
            label="保存后立即执行"
            isSelected={start}
            onChange={setStart}
          />
        </>
      )}
    </Dialog>
  );
}
