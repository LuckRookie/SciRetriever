import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { IntakeBatch } from "@sciretriever/contracts";
import { Button, Dialog, ErrorNotice } from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { createTask } from "../../data/operations.js";
import { emptyQuery } from "../../data/library.js";
import { navigate } from "../../data/url.js";
import { useShell } from "../../shell/context.js";
import { randomId } from "../../../browser-platform.js";
import { errorMessage } from "../../strings.js";

/**
 * “解析并形成初稿” for one batch (page specs “批次页” 6): the scope is the
 * batch and the count its estimate; the task is submitted and started only
 * from the button here.
 */
export function ParseDialog({
  batch,
  onClose,
}: {
  batch: IntakeBatch;
  onClose: () => void;
}) {
  const api = useApi(),
    shell = useShell(),
    queries = useQueryClient();
  const [key] = useState(randomId),
    [task, setTask] = useState<string | null>(null);
  const guard = useRef(false);
  const count = batch.estimates.parse;
  const submit = useMutation({
    mutationFn: () =>
      createTask(
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
          kind: "parse-documents",
          idempotency_key: key,
          selector: {
            kind: "query",
            query: { ...emptyQuery(), intake_batch_ids: [batch.batch_id] },
            sort: "intake-desc",
            limit: null,
          },
        },
      ),
    onSuccess: (id) => {
      setTask(id);
      shell.notify(`已提交解析 ${count.toLocaleString()} 篇的任务`);
    },
    onSettled: () => {
      guard.current = false;
    },
  });
  return (
    <Dialog
      title="解析并形成未校对的全文"
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
                  { view: "task", task, literature: null, session: null },
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
              variant="primary"
              isPending={submit.isPending}
              disabledReason={
                count === 0 ? "这一批没有需要解析的 PDF。" : undefined
              }
              onPress={() => {
                if (guard.current) return;
                guard.current = true;
                submit.mutate();
              }}
            >
              解析 {count.toLocaleString()} 篇
            </Button>
          </>
        )
      }
    >
      <div className="acquire-form">
        <dl className="acquire-scope">
          <dt>范围</dt>
          <dd>批次：{batch.label}</dd>
          <dt>处理</dt>
          <dd role="status">
            <b>{count.toLocaleString()} 篇</b>有 PDF、还没有解析的文献（预估）
          </dd>
        </dl>
        <p className="muted">
          会把 PDF 交给 MinerU
          解析，可能花费；解析完成后自动形成未校对的全文，不调用模型。
        </p>
        {submit.isError ? (
          <ErrorNotice message={`任务未提交：${errorMessage(submit.error)}`} />
        ) : null}
        {task ? (
          <p role="status">任务已提交并开始运行；进度与结果请查看任务。</p>
        ) : null}
      </div>
    </Dialog>
  );
}
