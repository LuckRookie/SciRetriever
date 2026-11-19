import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  parseIntakeBatch,
  parseIntakeRestorePreview,
  parseIntakeWithdrawalPreview,
  parseIntakeWithdrawalReport,
  type IntakeBatch,
  type IntakeWithdrawalCounts,
  type IntakeWithdrawalPreview,
  type IntakeWithdrawalReason,
  type IntakeWithdrawalReport,
} from "@sciretriever/contracts";
import {
  Button,
  Dialog,
  Disclosure,
  ErrorNotice,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { ApiError } from "../../data/api.js";
import { intakeRoute as route } from "../../data/imports.js";
import { errorMessage, shortTime } from "../../strings.js";
import { Counts } from "./batch-parts.js";

/** The reasons a paper stays (literature materials 6.4.11), in the spec's words. */
export const KEEP_REASONS: Record<IntakeWithdrawalReason, string> = {
  "pre-existing": "入库前已在库",
  "hit-by-later-batch": "之后被别的批次命中",
  "folder-changed": "加入过别的文件夹",
  annotated: "有批注",
  opened: "打开过",
  processed: "加工过",
  "metadata-edited": "改过书目",
  "identity-merged": "与别的文献合并",
};
const UNREGISTERED = "本批在登记之前形成，文件夹与批注不在撤回范围内。";
const countItems = (c: IntakeWithdrawalCounts) =>
  [
    ["文献", c.literatures],
    ["文件", c.file_relations],
    ["文件夹", c.folders],
    ["文件夹成员", c.folder_members],
    ["批注", c.marks],
  ] as const;

/**
 * A restoration done on this page: its report shows once; the service keeps
 * only the withdrawal's record to read back.
 */
export const withdrawalReports = new Map<
  string,
  { kind: "restored"; report: IntakeWithdrawalReport }
>();

/** The papers that stay, by reason, then one by one with every reason. */
function Kept({ value }: { value: Omit<IntakeWithdrawalPreview, "remove"> }) {
  const reasons = Object.entries(value.keep.by_reason) as [
    IntakeWithdrawalReason,
    number,
  ][];
  return (
    <div className="intake-withdraw-keep">
      <p>
        保留文献 <b>{value.keep.literatures.toLocaleString()}</b> 篇
      </p>
      {reasons.length ? (
        <ul aria-label="保留的原因">
          {reasons.map(([reason, n]) => (
            <li key={reason}>
              {KEEP_REASONS[reason]} {n.toLocaleString()} 篇
            </li>
          ))}
        </ul>
      ) : null}
      {value.kept_items.length ? (
        <Disclosure
          title={`逐篇列出（${value.kept_items.length.toLocaleString()} 篇${
            value.keep.literatures > value.kept_items.length
              ? `，共 ${value.keep.literatures.toLocaleString()} 篇`
              : ""
          }）`}
        >
          <ul className="intake-withdraw-items" aria-label="保留的文献">
            {value.kept_items.map((item) => (
              <li key={item.literature_id}>
                <span className="intake-withdraw-title">
                  {item.title ?? "无标题"}
                </span>
                <span className="ui-description">
                  {item.reasons.map((r) => KEEP_REASONS[r]).join("、")}
                </span>
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
      {value.registered ? null : (
        <p className="ui-description">{UNREGISTERED}</p>
      )}
    </div>
  );
}

/** A withdrawal or restoration report: what went (or came back), what stayed. */
export function WithdrawalReport({
  report,
  kind,
}: {
  report: IntakeWithdrawalReport;
  kind: "withdrawn" | "restored";
}) {
  const changed = "restore" in report ? report.restore : report.remove;
  return (
    <section
      className="intake-batch-part"
      aria-labelledby="batch-withdrawal-report"
    >
      <h3 id="batch-withdrawal-report">
        {kind === "withdrawn" ? "撤回报告" : "恢复报告"}
      </h3>
      <div className="intake-withdraw-change">
        <span>{kind === "withdrawn" ? "移除" : "恢复"}</span>
        <Counts
          items={countItems(changed)}
          keepZero
          label={kind === "withdrawn" ? "移除" : "恢复"}
        />
      </div>
      <Kept value={report} />
    </section>
  );
}

/**
 * “撤回这一批” (page specs “批次页” 7): the estimate first, then the
 * withdrawal. With a task working on the batch, no button to withdraw.
 */
export function WithdrawDialog({
  batch,
  onClose,
}: {
  batch: IntakeBatch;
  onClose: () => void;
}) {
  const api = useApi(),
    queries = useQueryClient();
  const guard = useRef(false);
  const preview = useQuery({
    queryKey: ["intake-withdrawal", batch.batch_id, "preview"],
    queryFn: async ({ signal }) =>
      parseIntakeWithdrawalPreview(
        (
          await api.call(
            route(batch.batch_id, "withdrawal/preview"),
            {},
            signal,
          )
        ).withdrawal,
      ),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const withdraw = useMutation({
    mutationFn: async () => {
      const value = await api.call(route(batch.batch_id, "withdraw"), {});
      return {
        batch: parseIntakeBatch(value.batch),
        report: parseIntakeWithdrawalReport(value.withdrawal),
      };
    },
    onSuccess: ({ batch: next, report }) => {
      // The record the page reads next, as the withdrawal returned it.
      queries.setQueryData(
        ["intake-withdrawal", next.batch_id, "record"],
        report,
      );
      queries.setQueryData(
        ["library", "intake-batches", "page", next.batch_id],
        next,
      );
      void queries.invalidateQueries({ queryKey: ["library"] });
      onClose();
    },
    onSettled: () => {
      guard.current = false;
    },
  });
  const busy =
    preview.error instanceof ApiError &&
    preview.error.code === "intake-batch-busy";
  return (
    <Dialog
      title="撤回这一批"
      isOpen
      onOpenChange={(open) => {
        if (!open && !withdraw.isPending) onClose();
      }}
      footer={
        <>
          <Button onPress={onClose} isDisabled={withdraw.isPending}>
            取消
          </Button>
          {preview.data ? (
            <Button
              variant="danger"
              isPending={withdraw.isPending}
              onPress={() => {
                if (guard.current) return;
                guard.current = true;
                withdraw.mutate();
              }}
            >
              撤回
            </Button>
          ) : null}
        </>
      }
    >
      <div className="intake-withdraw">
        <p className="ui-description">入库批次：{batch.label}</p>
        {preview.isPending ? (
          <p role="status">正在核对将移除与将保留的内容…</p>
        ) : busy ? (
          <p role="alert">
            这一批有文献正在被任务处理，请等任务结束或取消后再撤回。
          </p>
        ) : preview.isError ? (
          <ErrorNotice
            message={errorMessage(preview.error)}
            onRetry={() => void preview.refetch()}
          />
        ) : (
          <>
            <div className="intake-withdraw-change">
              <span>将移除</span>
              <Counts
                items={countItems(preview.data.remove)}
                keepZero
                label="将移除"
              />
            </div>
            <Kept value={preview.data} />
            <p>撤回只是从文献库中移除，可以恢复；文件不会被删除。</p>
          </>
        )}
        {withdraw.isError ? (
          <ErrorNotice message={`没有撤回：${errorMessage(withdraw.error)}`} />
        ) : null}
      </div>
    </Dialog>
  );
}

/** The restoration said first (page specs “批次页” 7), then done. */
function RestoreDialog({
  batch,
  onClose,
}: {
  batch: IntakeBatch;
  onClose: () => void;
}) {
  const api = useApi(),
    queries = useQueryClient();
  const guard = useRef(false);
  const preview = useQuery({
    queryKey: ["intake-withdrawal", batch.batch_id, "restore"],
    queryFn: async ({ signal }) =>
      parseIntakeRestorePreview(
        (await api.call(route(batch.batch_id, "restore/preview"), {}, signal))
          .restore,
      ),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const restore = useMutation({
    mutationFn: async () => {
      const value = await api.call(route(batch.batch_id, "restore"), {});
      return {
        batch: parseIntakeBatch(value.batch),
        report: parseIntakeWithdrawalReport(value.restoration),
      };
    },
    onSuccess: ({ batch: next, report }) => {
      withdrawalReports.set(next.batch_id, { kind: "restored", report });
      queries.setQueryData(
        ["library", "intake-batches", "page", next.batch_id],
        next,
      );
      void queries.invalidateQueries({ queryKey: ["library"] });
      // Its withdrawal record and restore estimate no longer apply.
      queries.removeQueries({
        queryKey: ["intake-withdrawal", next.batch_id],
      });
      onClose();
    },
    onSettled: () => {
      guard.current = false;
    },
  });
  const already = preview.data?.already_restored.literatures ?? 0;
  return (
    <Dialog
      title="恢复这一批"
      isOpen
      onOpenChange={(open) => {
        if (!open && !restore.isPending) onClose();
      }}
      footer={
        <>
          <Button onPress={onClose} isDisabled={restore.isPending}>
            取消
          </Button>
          {preview.data ? (
            <Button
              variant="primary"
              isPending={restore.isPending}
              onPress={() => {
                if (guard.current) return;
                guard.current = true;
                restore.mutate();
              }}
            >
              恢复
            </Button>
          ) : null}
        </>
      }
    >
      <div className="intake-withdraw">
        <p className="ui-description">入库批次：{batch.label}</p>
        {preview.isPending ? (
          <p role="status">正在核对将恢复的内容…</p>
        ) : preview.isError ? (
          <ErrorNotice
            message={errorMessage(preview.error)}
            onRetry={() => void preview.refetch()}
          />
        ) : (
          <>
            <div className="intake-withdraw-change">
              <span>将恢复</span>
              <Counts
                items={countItems(preview.data.restore)}
                keepZero
                label="将恢复"
              />
            </div>
            {already ? (
              <p>已被后来的入库恢复的 {already.toLocaleString()} 篇不计。</p>
            ) : null}
            <p>恢复之后，批次回到撤回之前的状态。</p>
          </>
        )}
        {restore.isError ? (
          <ErrorNotice message={`没有恢复：${errorMessage(restore.error)}`} />
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * A withdrawn batch (page specs “批次页” 7): when it was withdrawn and its
 * report, read from the service, and the way back.
 */
export function Withdrawn({ batch }: { batch: IntakeBatch }) {
  const api = useApi();
  const [restoring, setRestoring] = useState(false);
  const record = useQuery({
    queryKey: ["intake-withdrawal", batch.batch_id, "record"],
    queryFn: async ({ signal }) => {
      const value = await api.call(
        route(batch.batch_id, "withdrawal"),
        {},
        signal,
      );
      return value.withdrawal === null
        ? null
        : parseIntakeWithdrawalReport(value.withdrawal);
    },
  });
  const report = record.data;
  return (
    <>
      <div className="intake-withdrawn" role="status">
        <span>
          {report ? `这一批已于 ${shortTime(report.at)} 撤回` : "这一批已撤回"}
        </span>
        <Button onPress={() => setRestoring(true)}>恢复这一批</Button>
      </div>
      {record.isError ? (
        <ErrorNotice
          message={errorMessage(record.error)}
          onRetry={() => void record.refetch()}
        />
      ) : null}
      {report ? <WithdrawalReport report={report} kind="withdrawn" /> : null}
      {restoring ? (
        <RestoreDialog batch={batch} onClose={() => setRestoring(false)} />
      ) : null}
    </>
  );
}
