import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { IntakeBatch } from "@sciretriever/contracts";
import {
  Button,
  EmptyState,
  ErrorNotice,
  TextField,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import {
  renameIntakeBatch,
  useIntakeBatches,
} from "../../data/intake-batches.js";
import { initiator } from "../../data/imports.js";
import type { DeviceConnection } from "../../data/devices.js";
import { openBatch } from "../library/Folders.js";
import { navigate } from "../../data/url.js";
import { useDevices } from "../settings/Devices.js";
import { errorMessage, localTime } from "../../strings.js";
import { BatchBadge, Counts, PartsBar } from "./batch-parts.js";

/** What the batch covered, in a few words: years, direction, file, sources. */
export function requestText(batch: IntakeBatch) {
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
export function timeText(batch: IntakeBatch) {
  if (batch.kind !== "legacy") return localTime(batch.created_at);
  return `${localTime(batch.created_at).slice(0, 10)} 起`;
}
/** Who started it; the batch formed from earlier papers names that instead. */
export function startedBy(
  batch: IntakeBatch,
  devices: readonly DeviceConnection[],
) {
  return batch.kind === "legacy"
    ? "迁移前已有，没有逐次记录"
    : initiator(batch, devices);
}
/** “新增 · 已在库 · 恢复 · 冲突 · 可能重复 · 未接纳”, zeros left out. */
export const recordCounts = (c: IntakeBatch["counts"]) =>
  [
    ["新增", c.created],
    ["已在库", c.matched + c.enriched],
    ["恢复", c.restored],
    ["冲突", c.conflicts],
    ["可能重复", c.possible_duplicates],
    ["未接纳", c.rejected],
  ] as const;

/**
 * Every intake batch, one kind of row whoever started it (page specs “入库
 * 记录”), newest first a page at a time; refreshed while one is open.
 */
export function IntakeRecords({
  highlight,
  submitting = false,
}: {
  highlight: string | null;
  submitting?: boolean;
}) {
  const batches = useIntakeBatches(submitting);
  const connections = useDevices(),
    devices = connections.data ?? [];
  const items = batches.data?.pages.flatMap((page) => page.items) ?? [];
  // A batch from a connection made since the list was read reads it again,
  // once per such connection.
  const asked = useRef(new Set<string>());
  const unknown = items
    .map((batch) => batch.initiated_by)
    .filter(
      (by) =>
        by.startsWith("device:") &&
        !asked.current.has(by) &&
        !devices.some((d) => `device:${d.connection_id}` === by),
    );
  useEffect(() => {
    if (!connections.data || !unknown.length) return;
    for (const by of unknown) asked.current.add(by);
    void connections.refetch();
  }, [connections, unknown]);
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
              devices={devices}
              open={batch.batch_id === highlight}
            />
          ))}
        </ol>
      ) : (
        <EmptyState
          title="还没有入库记录"
          description="用上方的检索、文件、Zotero 或网页带进文献后，每一批都会在这里留下一条记录。"
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
    </section>
  );
}

function Record({
  batch,
  devices,
  open,
}: {
  batch: IntakeBatch;
  devices: readonly DeviceConnection[];
  open: boolean;
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
  const pdf = batch.pdf,
    hits = batch.counts.hits;
  const legacy = batch.kind === "legacy";
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
            {/* The name is the row's title and opens the batch. */}
            <button
              type="button"
              className="intake-record-name"
              aria-label={`打开批次：${batch.label}`}
              onClick={() => navigate({ session: batch.batch_id })}
            >
              {batch.label}
            </button>
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
            startedBy(batch, devices),
            ...requestText(batch),
          ].join(" · ")}
        </div>
      </div>
      <div className="intake-record-state">
        <BatchBadge batch={batch} />
      </div>
      <div className="intake-record-side">
        <div className="intake-record-counts">
          <Counts items={recordCounts(batch.counts)} />
          {batch.source_failures ? (
            <span className="quiet">
              {batch.source_failures} 个来源未完整返回
            </span>
          ) : null}
        </div>
        <PartsBar
          total={hits}
          label={`有 PDF ${pdf.has_pdf} 篇，没找到 PDF ${pdf.unavailable} 篇，待获取 ${pdf.pending} 篇`}
          parts={[
            { part: "has", tone: "pdf", value: pdf.has_pdf },
            { part: "unavailable", tone: "other", value: pdf.unavailable },
          ]}
        />
        <span className="intake-record-pdf">
          {pdf.pending === 0 && pdf.unavailable === 0 && hits > 0
            ? "全部有 PDF"
            : [
                `有 PDF ${pdf.has_pdf.toLocaleString()}`,
                pdf.unavailable
                  ? `没找到 PDF ${pdf.unavailable.toLocaleString()}`
                  : "",
                `待获取 ${pdf.pending.toLocaleString()}`,
              ]
                .filter(Boolean)
                .join(" · ")}
        </span>
        <Button size="compact" onPress={() => openBatch(batch.batch_id)}>
          在文献库查看
        </Button>
      </div>
    </li>
  );
}
