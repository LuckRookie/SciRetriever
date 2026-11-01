import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { IntakeBatch } from "@sciretriever/contracts";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  TextField,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import {
  BATCH_KINDS,
  BATCH_ORIGINS,
  renameIntakeBatch,
  useIntakeBatches,
} from "../../data/intake-batches.js";
import { emptyQuery } from "../../data/library.js";
import { openBatch } from "../library/Folders.js";
import { AcquireDialog, type AcquireScope } from "../library/AcquireDialog.js";
import { errorMessage, localTime } from "../../strings.js";

const STATUS: Partial<
  Record<
    IntakeBatch["status"],
    { badge: "running" | "partial" | "failed"; label: string }
  >
> = {
  running: { badge: "running", label: "进行中" },
  partial: { badge: "partial", label: "部分完成" },
  interrupted: { badge: "partial", label: "已中断" },
  failed: { badge: "failed", label: "失败" },
};

/** What the person asked for, in a few words: years, sources, file. */
function requestText(batch: IntakeBatch) {
  const r = batch.request;
  const years =
    r.year_from || r.year_to ? `${r.year_from ?? ""}–${r.year_to ?? ""}` : "";
  return [
    years,
    r.direction ? (r.direction === "references" ? "参考文献" : "被引文献") : "",
    r.file_name ?? "",
    r.providers?.length ? r.providers.join("、") : "",
  ].filter(Boolean);
}
function timeText(batch: IntakeBatch) {
  if (batch.kind !== "legacy") return localTime(batch.created_at);
  return `${localTime(batch.created_at).slice(0, 10)} 起`;
}

export function IntakeRecords({ highlight }: { highlight: string | null }) {
  const batches = useIntakeBatches();
  const [acquire, setAcquire] = useState<AcquireScope | null>(null);
  const items = batches.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="intake-records" aria-labelledby="intake-records-title">
      <h2 id="intake-records-title">入库记录</h2>
      {batches.isError ? (
        <ErrorNotice
          message={errorMessage(batches.error)}
          onRetry={() => void batches.refetch()}
        />
      ) : batches.isPending ? (
        <p role="status">正在读取入库记录…</p>
      ) : items.length ? (
        <ol className="intake-record-list">
          {items.map((batch) => (
            <Record
              key={batch.batch_id}
              batch={batch}
              open={batch.batch_id === highlight}
              onAcquire={() =>
                setAcquire({
                  kind: "query",
                  query: {
                    ...emptyQuery(),
                    intake_batch_ids: [batch.batch_id],
                  },
                  sort: "intake-desc",
                  label: `入库批次：${batch.label}`,
                })
              }
            />
          ))}
        </ol>
      ) : (
        <EmptyState
          title="还没有入库记录"
          description="用上方的主题发现、引用扩展或导入书目带进文献后，每一次都会在这里留下一条记录。"
        />
      )}
      {batches.hasNextPage ? (
        <Button
          variant="text"
          isPending={batches.isFetchingNextPage}
          onPress={() => void batches.fetchNextPage()}
        >
          加载更早的记录
        </Button>
      ) : null}
      {acquire ? (
        <AcquireDialog scope={acquire} onClose={() => setAcquire(null)} />
      ) : null}
    </section>
  );
}

function Record({
  batch,
  open,
  onAcquire,
}: {
  batch: IntakeBatch;
  open: boolean;
  onAcquire: () => void;
}) {
  const api = useApi(),
    queries = useQueryClient();
  const [editing, setEditing] = useState(false),
    [name, setName] = useState(batch.label);
  const rename = useMutation({
    mutationFn: (label: string | null) =>
      renameIntakeBatch(api, batch.batch_id, label),
    onSuccess: () => {
      setEditing(false);
      void queries.invalidateQueries({
        queryKey: ["library", "intake-batches"],
      });
    },
  });
  const c = batch.counts,
    pdf = batch.pdf;
  const status = STATUS[batch.status];
  const legacy = batch.kind === "legacy";
  const share = (n: number) => (c.hits ? `${(n / c.hits) * 100}%` : "0%");
  return (
    <li className="intake-record" data-open={open || undefined}>
      <div className="intake-record-main">
        {editing ? (
          <form
            className="intake-record-rename"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) rename.mutate(name.trim());
            }}
          >
            <TextField
              label="批次名称"
              value={name}
              onChange={setName}
              maxLength={120}
            />
            <Button
              type="submit"
              variant="primary"
              isPending={rename.isPending}
            >
              保存
            </Button>
            {batch.renamed ? (
              <Button
                variant="text"
                isDisabled={rename.isPending}
                onPress={() => rename.mutate(null)}
              >
                恢复默认名
              </Button>
            ) : null}
            <Button
              variant="text"
              onPress={() => {
                setName(batch.label);
                setEditing(false);
              }}
            >
              取消
            </Button>
          </form>
        ) : (
          <div className="intake-record-title">
            {batch.label !== BATCH_KINDS[batch.kind] ? (
              <span className="intake-record-kind">
                {BATCH_KINDS[batch.kind]}
              </span>
            ) : null}
            <span className="intake-record-name">{batch.label}</span>
            {status ? (
              <Badge status={status.badge}>{status.label}</Badge>
            ) : null}
            {!legacy ? (
              <Button
                variant="text"
                size="compact"
                className="intake-record-edit"
                aria-label={`改名：${batch.label}`}
                onPress={() => setEditing(true)}
              >
                改名
              </Button>
            ) : null}
          </div>
        )}
        {rename.isError ? (
          <ErrorNotice message={errorMessage(rename.error)} />
        ) : null}
        <div className="intake-record-meta">
          {[
            timeText(batch),
            legacy ? "迁移前已有，没有逐次记录" : BATCH_ORIGINS[batch.origin],
            ...requestText(batch),
          ].join(" · ")}
        </div>
        <div className="intake-record-counts">
          <span>
            命中 <b>{c.hits.toLocaleString()}</b>
          </span>
          {legacy ? null : (
            <>
              <span>新增 {c.created.toLocaleString()}</span>
              {c.enriched ? (
                <span>补充 {c.enriched.toLocaleString()}</span>
              ) : null}
              <span>已在库 {c.matched.toLocaleString()}</span>
              {c.rejected ? (
                <span className="quiet">
                  未接纳 {c.rejected.toLocaleString()} 条
                </span>
              ) : null}
              {batch.source_failures ? (
                <span className="quiet">
                  {batch.source_failures} 个来源未完整返回
                </span>
              ) : null}
            </>
          )}
        </div>
      </div>
      <div className="intake-record-side">
        <div
          className="intake-record-bar"
          role="img"
          aria-label={`有 PDF ${pdf.has_pdf} 篇，无法获取 ${pdf.unavailable} 篇，待获取 ${pdf.pending} 篇`}
        >
          <i data-part="has" style={{ width: share(pdf.has_pdf) }} />
          <i
            data-part="unavailable"
            style={{ width: share(pdf.unavailable) }}
          />
        </div>
        <span className="intake-record-pdf">
          {pdf.pending === 0 && pdf.unavailable === 0 && c.hits > 0
            ? "全部有 PDF"
            : [
                `有 PDF ${pdf.has_pdf.toLocaleString()}`,
                pdf.unavailable
                  ? `无法获取 ${pdf.unavailable.toLocaleString()}`
                  : "",
                `待获取 ${pdf.pending.toLocaleString()}`,
              ]
                .filter(Boolean)
                .join(" · ")}
        </span>
        <div className="intake-record-actions">
          <Button onPress={() => openBatch(batch.batch_id)}>
            在文献库查看
          </Button>
          {pdf.pending > 0 && batch.status !== "running" ? (
            <Button variant="primary" onPress={onAcquire}>
              获取 PDF <span>{pdf.pending.toLocaleString()}</span>
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}
