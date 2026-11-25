import { useEffect, useRef, useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { IntakeBatch, IntakeBatchItem } from "@sciretriever/contracts";
import {
  Button,
  DataTable,
  Definition,
  Definitions,
  ErrorNotice,
  Menu,
  TextField,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { pacedInterval } from "../../data/polling.js";
import type { ApiClient } from "../../data/api.js";
import { navigate } from "../../data/url.js";
import {
  batchSource,
  candidateText,
  decisionKind,
  DECISION_GROUPS,
  DISPOSITIONS,
  excludedName,
  FILE_STATES,
  fullTextLine,
  initiator,
  intakeRoute as route,
  isActive,
  matchFile,
  PHASES,
  readBatch,
  readFile,
  readItem,
  readRecognition,
  readResult,
  readSummary,
  sha256,
  type BatchFile,
  type BatchSummary,
  type DecisionKind,
} from "../../data/imports.js";
import {
  readIntakeBatch,
  renameIntakeBatch,
} from "../../data/intake-batches.js";
import { lookupItems, lookupParts } from "../../data/intake-lookup.js";
import { emptyQuery } from "../../data/library.js";
import { openBatch } from "../library/Folders.js";
import { AcquireDialog } from "../library/AcquireDialog.js";
import { useDevices } from "../settings/Devices.js";
import { errorMessage, shortTime } from "../../strings.js";
import { BatchBadge, Counts, PartsBar } from "./batch-parts.js";
import { unrecognized } from "./Dropzone.js";
import { ParseDialog } from "./ParseDialog.js";
import {
  LookupCounts,
  LookupDecisions,
  LookupLines,
  LookupReport,
} from "./LookupBatch.js";
import {
  WithdrawalReport,
  WithdrawDialog,
  Withdrawn,
  withdrawalReports,
} from "./Withdrawal.js";

const batchKey = (id: string) => ["library", "intake-batches", "page", id];
/**
 * Whether recognition is still under way. Named lines are read until it is
 * done, since a line already in the library is only known then.
 */
const recognitionOpen = (state: string | undefined, named: boolean) =>
  named
    ? !!state && state !== "done" && state !== "cancelled"
    : state === "running";
/** PDF folders chosen on this page, kept until the page is reloaded. */
const folders = new Map<string, File[]>();

async function pages<T>(
  read: (cursor: string | null) => Promise<{ items: T[]; next: string | null }>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  do {
    const page = await read(cursor);
    all.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return all;
}
const next = (value: Record<string, unknown>) =>
  typeof value.next_cursor === "string" ? value.next_cursor : null;
const filesOf = (
  api: ApiClient,
  id: string,
  pending: boolean,
  signal?: AbortSignal,
) =>
  pages(async (cursor) => {
    const page = await api.call(
      route(id, "files"),
      { cursor, limit: 200, pending },
      signal,
    );
    return {
      items: (Array.isArray(page.items) ? page.items : []).map(readFile),
      next: next(page),
    };
  });
/** The items to decide: possible duplicates and candidates, then unpaired files. */
async function decisionItems(api: ApiClient, id: string, signal?: AbortSignal) {
  const seen = new Map<string, IntakeBatchItem>();
  for (const needs of ["decision", "unpaired"] as const)
    for (const item of await pages(async (cursor) => {
      const page = await api.call(
        route(id, "items"),
        { cursor, limit: 200, needs },
        signal,
      );
      return {
        items: (Array.isArray(page.items) ? page.items : []).map(readItem),
        next: next(page),
      };
    }))
      seen.set(item.item_id, item);
  return [...seen.values()];
}

interface Upload {
  done: number;
  current: string | null;
  unmatched: BatchFile[];
  error: string | null;
  running: boolean;
}
/**
 * Works through the service's list of files still owed: uploads the ones
 * without a PDF in the library, reports only the hash for the rest. The list
 * is read again until bibliography intake is complete, so a reload continues
 * where it stopped and nothing already received is sent twice.
 */
function useUploader(api: ApiClient, id: string, onChange: () => void) {
  const [upload, setUpload] = useState<Upload | null>(null);
  const running = useRef(false);
  const start = async (folder: File[]) => {
    if (running.current) return;
    running.current = true;
    const tried = new Set<string>(),
      unmatched = new Map<string, BatchFile>();
    let done = 0;
    const report = (patch: Partial<Upload>) =>
      setUpload((current) => ({
        done,
        current: null,
        unmatched: [...unmatched.values()],
        error: null,
        running: true,
        ...current,
        ...patch,
      }));
    report({ done, running: true, error: null });
    try {
      for (;;) {
        let progressed = false;
        for (const wanted of await filesOf(api, id, true)) {
          if (tried.has(wanted.file_id)) continue;
          tried.add(wanted.file_id);
          const file = matchFile(folder, wanted);
          if (!file) {
            unmatched.set(wanted.file_id, wanted);
            report({ unmatched: [...unmatched.values()] });
            continue;
          }
          report({ current: wanted.file_name });
          const path = `${route(id, "files")}/${encodeURIComponent(wanted.file_id)}`;
          if (wanted.action === "hash")
            await api.call(`${path}/hash`, { sha256: await sha256(file) });
          else await api.send(`${path}/bytes`, file);
          done += 1;
          progressed = true;
          report({ done, current: null });
          onChange();
        }
        const batch = readBatch(
          (await api.call(route(id, "status"), {})).batch,
        );
        if (!isActive(batch)) break;
        if (batch.progress?.phase !== "metadata" && !progressed) break;
        if (!progressed) await new Promise((r) => setTimeout(r, 2000));
      }
      report({ running: false, current: null });
    } catch (error) {
      report({ running: false, current: null, error: errorMessage(error) });
    } finally {
      running.current = false;
      onChange();
    }
  };
  return { upload, start };
}

function FolderPicker({ onPick }: { onPick: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Folder selection is a non-standard attribute React does not type.
    input.current?.setAttribute("webkitdirectory", "");
  }, []);
  // The site's own button opens the folder chooser; no native “Choose Files”.
  return (
    <span className="ui-file-picker">
      <input
        ref={input}
        className="ui-visually-hidden"
        type="file"
        multiple
        tabIndex={-1}
        aria-label="选择文件夹"
        onChange={(event) =>
          onPick(
            [...(event.target.files ?? [])].filter((file) =>
              file.name.toLowerCase().endsWith(".pdf"),
            ),
          )
        }
      />
      <Button onPress={() => input.current?.click()}>选择文件夹</Button>
    </span>
  );
}

/** The record categories of page specs “批次页” 2, in their order. */
const recordItems = (s: BatchSummary) =>
  [
    ["新增", s.records.created],
    ["已在库", s.records.matched + s.records.enriched],
    ["恢复", s.records.restored],
    ["冲突", s.records.conflicts],
    ["可能重复", s.records.possible_duplicates],
    ["书目不全", s.records.needs_metadata],
    ["未接纳", s.records.rejected],
  ] as const;
/** The same categories from the batch alone (batches without an import report). */
const batchItems = (c: IntakeBatch["counts"]) =>
  [
    ["新增", c.created],
    ["已在库", c.matched + c.enriched],
    ["恢复", c.restored],
    ["冲突", c.conflicts],
    ["可能重复", c.possible_duplicates],
    ["书目不全", c.needs_metadata],
    ["未接纳", c.rejected],
  ] as const;

function decisionText(item: IntakeBatchItem): string | null {
  const d = item.decision;
  if (!d) return null;
  if (d.kind === "merge") {
    const target = item.possible_duplicates.find(
      (c) => c.literature_id === d.literature_id,
    );
    return `并入：${target?.title ?? "库里的一篇"}`;
  }
  if (d.kind === "candidate") {
    const target = item.recognition?.candidates.find(
      (c) => c.candidate_id === d.candidate_id,
    );
    return `采用：${target?.title ?? "所选的一项"}`;
  }
  return {
    new: "新增",
    unrecognized: "都不是",
    include: "作为单独的文献入库",
    exclude: "不入库",
  }[d.kind];
}

/** One item to decide; the decision stands at the row's end and can change. */
function DecisionRow({
  item,
  kind,
  decide,
  disabled,
}: {
  item: IntakeBatchItem;
  kind: DecisionKind;
  decide: (item: IntakeBatchItem, decision: unknown) => void;
  disabled: boolean;
}) {
  const name =
    kind === "duplicate"
      ? (item.title ?? item.external_id ?? item.file_name ?? "无标题")
      : (item.file_name ?? item.title ?? "未命名文件");
  const chosen = decisionText(item);
  return (
    <li className="intake-decision">
      <span className="intake-decision-name">{name}</span>
      <span className="intake-decision-actions">
        {kind === "duplicate" ? (
          <>
            <Menu
              label="并入"
              indicator
              items={item.possible_duplicates.slice(0, 3).map((c) => ({
                id: c.literature_id,
                label: candidateText(c),
                disabled,
                onAction: () =>
                  decide(item, {
                    kind: "merge",
                    literature_id: c.literature_id,
                  }),
              }))}
            />
            <Button
              size="compact"
              isDisabled={disabled}
              onPress={() => decide(item, { kind: "new" })}
            >
              新增
            </Button>
          </>
        ) : kind === "candidate" ? (
          <>
            <Menu
              label="采用"
              indicator
              items={(item.recognition?.candidates ?? [])
                .slice(0, 3)
                .map((c) => ({
                  id: c.candidate_id,
                  label: candidateText(c),
                  disabled,
                  onAction: () =>
                    decide(item, {
                      kind: "candidate",
                      candidate_id: c.candidate_id,
                    }),
                }))}
            />
            <Button
              size="compact"
              isDisabled={disabled}
              onPress={() => decide(item, { kind: "unrecognized" })}
            >
              都不是
            </Button>
          </>
        ) : (
          <>
            <Button
              size="compact"
              isDisabled={disabled}
              onPress={() => decide(item, { kind: "include" })}
            >
              作为单独的文献入库
            </Button>
            <Button
              size="compact"
              isDisabled={disabled}
              onPress={() => decide(item, { kind: "exclude" })}
            >
              不入库
            </Button>
          </>
        )}
      </span>
      <span className="intake-decision-chosen">{chosen ?? "待决定"}</span>
    </li>
  );
}

/**
 * One batch (page specs “批次页”): header, counts, the items to decide,
 * progress, the report and what can follow. Everything shown comes from the
 * service, so a reload shows the same; nothing networked or paid starts
 * unless its button is pressed.
 */
export function BatchPage({ id }: { id: string }) {
  const api = useApi(),
    queries = useQueryClient(),
    devices = useDevices().data ?? [];
  const status = useQuery({
    queryKey: batchKey(id),
    queryFn: ({ signal }) => readIntakeBatch(api, id, signal),
    refetchInterval: (query) =>
      pacedInterval(
        query,
        query.state.data && !isActive(query.state.data) ? false : 3000,
      ),
  });
  const batch = status.data;
  const imported = batch?.kind === "import";
  // Named lines (page specs “找文献 · 指定文献”) show line by line.
  const named = imported && batch?.request.format === "lookup";
  const awaiting = batch?.state === "awaiting-confirmation";
  const preview = useQuery({
    queryKey: [...batchKey(id), "preview"],
    queryFn: async ({ signal }) => {
      const value = await api.call(route(id, "preview"), {}, signal);
      return {
        summary: readSummary(value.summary),
        recognition: readRecognition(value.recognition),
      };
    },
    enabled: imported && awaiting,
    // The preview carries recognition on; it is read again until it is done.
    // Named lines are only known to be in the library once it is.
    refetchInterval: (query) =>
      pacedInterval(
        query,
        recognitionOpen(query.state.data?.recognition?.state, named)
          ? 3000
          : false,
      ),
  });
  const ended =
    !!batch &&
    batch.state !== "collecting" &&
    batch.state !== "awaiting-confirmation";
  const report = useQuery({
    queryKey: [...batchKey(id), "report", batch?.state],
    queryFn: async ({ signal }) => {
      const value = await api.call(route(id, "report"), { limit: 200 }, signal);
      return {
        summary: readSummary(value.summary),
        items: (Array.isArray(value.items) ? value.items : []).map(readResult),
        more: typeof value.next_cursor === "string",
      };
    },
    enabled: imported && ended && batch?.state !== "withdrawn",
    refetchInterval: (query) =>
      pacedInterval(query, batch && isActive(batch) ? 3000 : false),
  });
  const files = useQuery({
    queryKey: [...batchKey(id), "files"],
    queryFn: ({ signal }) => filesOf(api, id, false, signal),
    enabled:
      imported &&
      !!batch &&
      (batch.state === "finished" || batch.state === "cancelled"),
  });
  // Decisions: while awaiting confirmation, and later only those still pending.
  const deciding =
    imported &&
    !named &&
    !!batch &&
    (awaiting ||
      ((batch.state === "running" || batch.state === "finished") &&
        batch.counts.pending_decision > 0));
  const items = useQuery({
    // Before confirmation the preview pairs files and recognizes them, so the
    // items are read after each preview.
    queryKey: [...batchKey(id), "items", awaiting ? preview.dataUpdatedAt : 0],
    queryFn: ({ signal }) => decisionItems(api, id, signal),
    enabled: deciding && (!awaiting || !!preview.data),
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      pacedInterval(
        query,
        preview.data?.recognition?.state === "running" ? 3000 : false,
      ),
  });
  // Every line of a lookup batch, read after each preview like the items.
  const lines = useQuery({
    queryKey: [...batchKey(id), "lines", preview.dataUpdatedAt],
    queryFn: ({ signal }) => lookupItems(api, id, signal),
    enabled: named && awaiting && !!preview.data,
    placeholderData: keepPreviousData,
  });
  const refresh = () =>
    void queries.invalidateQueries({ queryKey: batchKey(id) });
  const action = useMutation({
    mutationFn: (name: "confirm" | "cancel" | "finish" | "preview/cancel") =>
      api.call(route(id, name), {}),
    onSettled: () => {
      refresh();
      void queries.invalidateQueries({ queryKey: ["library"] });
    },
  });
  const decide = useMutation({
    mutationFn: ({
      item,
      decision,
    }: {
      item: IntakeBatchItem;
      decision: unknown;
    }) =>
      api.call(
        `${route(id, "items")}/${encodeURIComponent(item.item_id)}/decide`,
        { decision },
      ),
    onSettled: refresh,
  });
  const [editing, setEditing] = useState(false),
    [name, setName] = useState("");
  const rename = useMutation({
    mutationFn: (label: string | null) => renameIntakeBatch(api, id, label),
    onSuccess: () => {
      setEditing(false);
      void queries.invalidateQueries({
        queryKey: ["library", "intake-batches"],
      });
    },
  });
  const [acquire, setAcquire] = useState(false),
    [parse, setParse] = useState(false),
    [withdrawing, setWithdrawing] = useState(false);
  const { upload, start } = useUploader(api, id, refresh);
  const folder = folders.get(id);
  useEffect(() => {
    if (batch?.state === "running" && folder && !upload) void start(folder);
  }, [batch?.state, folder, upload, start]);

  const back = (
    <Button variant="text" onPress={() => navigate({ session: null })}>
      返回找文献
    </Button>
  );
  if (status.isError)
    return (
      <section className="intake-batch">
        {back}
        <ErrorNotice
          message={errorMessage(status.error)}
          onRetry={() => void status.refetch()}
        />
      </section>
    );
  if (!batch)
    return (
      <section className="intake-batch">
        {back}
        <p role="status">正在读取这一批…</p>
      </section>
    );
  const state = batch.state;
  const withdrawn = state === "withdrawn";
  const recognizing = recognitionOpen(preview.data?.recognition?.state, named);
  const recognition = preview.data?.recognition;
  const summary = awaiting ? preview.data?.summary : report.data?.summary;
  const actual = !awaiting && state !== "collecting";
  const decidable = (deciding ? (items.data ?? []) : []).flatMap((item) => {
    const kind = decisionKind(item);
    if (!kind) return [];
    // Once confirmed, only the items left pending can still be decided.
    if (!awaiting && item.disposition !== "pending-decision") return [];
    return [{ item, kind }];
  });
  const groups = (["duplicate", "candidate", "unpaired"] as const)
    .map((kind) => ({
      kind,
      rows: decidable.filter((entry) => entry.kind === kind),
    }))
    .filter((group) => group.rows.length);
  const parts =
    named && awaiting && lines.data ? lookupParts(lines.data) : null;
  const problems = (report.data?.items ?? []).filter(
    (item) =>
      item.disposition === "conflict" ||
      item.disposition === "rejected" ||
      item.disposition === "pending-decision",
  );
  const owed = (files.data ?? []).filter(
    (file) => file.status === "conflict" || file.status === "pending",
  );
  const progress = batch.progress;
  const pending = progress?.files.pending ?? 0;
  const followUp =
    state === "running" || state === "finished" || state === "cancelled";
  const left = unrecognized.get(id) ?? [];
  const waitText = named
    ? "正在识别，完成后才能确认"
    : "正在识别文件，完成后才能确认";
  // A withdrawal or restoration done on this page shows its report.
  const known = withdrawalReports.get(id);
  return (
    <section className="intake-batch" aria-label="批次">
      {back}
      <header className="intake-batch-header">
        <div className="intake-batch-title">
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
              <Button type="submit" isPending={rename.isPending}>
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
              <Button variant="text" onPress={() => setEditing(false)}>
                取消
              </Button>
            </form>
          ) : (
            <>
              <h2>{batch.label}</h2>
              {batch.kind !== "legacy" ? (
                <Button
                  variant="text"
                  size="compact"
                  aria-label={`改名：${batch.label}`}
                  onPress={() => {
                    setName(batch.label);
                    setEditing(true);
                  }}
                >
                  改名
                </Button>
              ) : null}
            </>
          )}
          <span className="intake-batch-state">
            <BatchBadge batch={batch} />
            <Menu
              label="更多"
              iconOnly
              items={[
                {
                  id: "library",
                  label: "在文献库查看",
                  onAction: () => openBatch(batch.batch_id),
                },
                // Only an ended batch can be withdrawn; a withdrawn one is
                // restored from the line at the top instead.
                ...(state === "withdrawn"
                  ? []
                  : [
                      {
                        id: "withdraw",
                        label: "撤回这一批",
                        ...(state === "finished" || state === "cancelled"
                          ? {}
                          : {
                              disabled: true,
                              description: "入库结束后才能撤回",
                            }),
                        onAction: () => setWithdrawing(true),
                      },
                    ]),
              ]}
            />
          </span>
        </div>
        <p className="ui-description">
          {[
            `来源 ${batchSource(batch)}`,
            batch.kind === "legacy"
              ? "迁移前已有，没有逐次记录"
              : initiator(batch, devices),
            shortTime(batch.created_at),
          ].join(" · ")}
        </p>
        {rename.isError ? (
          <ErrorNotice message={errorMessage(rename.error)} />
        ) : null}
      </header>
      {withdrawn ? <Withdrawn batch={batch} /> : null}
      {!withdrawn && known?.kind === "restored" ? (
        <WithdrawalReport report={known.report} kind="restored" />
      ) : null}
      {left.length ? (
        <ul className="intake-drop-unknown" aria-label="没有识别的文件">
          {left.map((file, index) => (
            <li key={`${file}:${index}`}>没有识别出这个文件的格式：{file}</li>
          ))}
          <li className="ui-description">
            支持 PDF；BibTeX、BibLaTeX、RIS、CSL JSON
            导出文件。这些文件没有交给服务端。
          </li>
        </ul>
      ) : null}
      {action.isError ? (
        <ErrorNotice message={errorMessage(action.error)} />
      ) : null}

      <section className="intake-batch-part" aria-labelledby="batch-counts">
        <h3 id="batch-counts">
          {awaiting ? "预览（估计，确认时按当时的文献库重新判定）" : "计数"}
        </h3>
        {state === "collecting" ? (
          <p>还没有交来条目。</p>
        ) : !imported || withdrawn ? (
          <Counts items={batchItems(batch.counts)} label="书目计数" />
        ) : named && summary ? (
          <LookupCounts
            summary={summary}
            records={awaiting ? null : recordItems(summary)}
          />
        ) : summary ? (
          <Definitions>
            <Definition term="书目">
              <Counts items={recordItems(summary)} keepZero label="书目计数" />
            </Definition>
            <Definition term="文件">
              <Counts
                keepZero
                label="文件计数"
                items={
                  awaiting
                    ? [
                        ["要上传", summary.files.upload],
                        ["只核对", summary.files.hash],
                      ]
                    : [
                        ["已上传", summary.files.uploaded],
                        ["已有", summary.files.existing],
                        ["冲突", summary.files.conflicts],
                        [
                          isActive(batch) ? "待交" : "未交",
                          isActive(batch) ? pending : summary.files.missing,
                        ],
                      ]
                }
              />
            </Definition>
            <Definition term="批注">
              <Counts
                keepZero
                label="批注计数"
                items={[
                  ["可导入", summary.annotations.supported],
                  ["不能导入", summary.annotations.unsupported],
                ]}
              />
            </Definition>
            {summary.unread.total ? (
              <Definition term="没读出内容的 PDF">
                <Counts
                  label="没读出内容的 PDF 计数"
                  items={summary.unread.reasons}
                />
                <p className="intake-unread-note">
                  这些文件{awaiting ? "会" : "已"}按文件名入库，标为“书目不全”。
                  入库后在文献库里选中它们，用“更多 → 识别书目”可以再认一次；
                  扫描件要先解析全文。
                </p>
              </Definition>
            ) : null}
            {summary.excluded.length ? (
              <Definition term="不导入的内容">
                <Counts
                  label="不导入的内容计数"
                  items={summary.excluded.map(
                    (item) => [excludedName(item.kind), item.count] as const,
                  )}
                />
              </Definition>
            ) : null}
          </Definitions>
        ) : (awaiting ? preview : report).isError ? (
          <ErrorNotice
            message={errorMessage((awaiting ? preview : report).error)}
            onRetry={() => void (awaiting ? preview : report).refetch()}
          />
        ) : (
          <p role="status">正在读取…</p>
        )}
      </section>

      {parts ? (
        <LookupDecisions
          parts={parts}
          disabled={decide.isPending}
          decide={(target, decision) =>
            decide.mutate({ item: target, decision })
          }
          error={
            decide.isError ? (
              <ErrorNotice message={errorMessage(decide.error)} />
            ) : null
          }
        />
      ) : null}
      {groups.length ? (
        <section className="intake-batch-part" aria-labelledby="batch-decide">
          <h3 id="batch-decide">需要决定（{decidable.length}）</h3>
          {decide.isError ? (
            <ErrorNotice message={errorMessage(decide.error)} />
          ) : null}
          {groups.map((group) => (
            <div
              key={group.kind}
              className="intake-decision-group"
              role="group"
              aria-label={DECISION_GROUPS[group.kind]}
            >
              <h4>
                {DECISION_GROUPS[group.kind]}（{group.rows.length}）
              </h4>
              <ul>
                {group.rows.map(({ item, kind }) => (
                  <DecisionRow
                    key={item.item_id}
                    item={item}
                    kind={kind}
                    disabled={decide.isPending}
                    decide={(target, decision) =>
                      decide.mutate({ item: target, decision })
                    }
                  />
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}

      {recognizing || (state === "running" && imported) ? (
        <section className="intake-batch-part" aria-labelledby="batch-progress">
          <h3 id="batch-progress">进度</h3>
          {recognizing && recognition ? (
            <p className="intake-batch-line" role="status">
              {named ? "正在识别" : "正在识别文件"}{" "}
              {recognition.recognized.toLocaleString()} /{" "}
              {recognition.total.toLocaleString()}
              {named ? " 行" : ""}
              <Button
                size="compact"
                isDisabled={action.isPending}
                onPress={() => action.mutate("preview/cancel")}
              >
                停止识别
              </Button>
            </p>
          ) : null}
          {state === "running" && progress ? (
            <>
              <p role="status">
                {PHASES[progress.phase]} · 已处理{" "}
                {progress.processed_items.toLocaleString()} /{" "}
                {progress.total_items.toLocaleString()}
              </p>
              <PartsBar
                total={
                  progress.files.uploaded +
                  progress.files.existing +
                  progress.files.conflicts +
                  progress.files.pending
                }
                label={`文件：已上传 ${progress.files.uploaded}，已有 ${progress.files.existing}，冲突 ${progress.files.conflicts}，待交 ${pending}`}
                parts={[
                  {
                    part: "has",
                    tone: "done",
                    value: progress.files.uploaded,
                  },
                  {
                    part: "existing",
                    tone: "pdf",
                    value: progress.files.existing,
                  },
                  {
                    part: "unavailable",
                    tone: "problem",
                    value: progress.files.conflicts,
                  },
                ]}
              />
              <Counts
                keepZero
                label="文件进度"
                items={[
                  ["已上传", progress.files.uploaded],
                  ["已有", progress.files.existing],
                  ["冲突", progress.files.conflicts],
                  ["待交", pending],
                ]}
              />
            </>
          ) : null}
          {state === "running" ? (
            <div className="intake-batch-upload">
              {upload ? (
                <p role="status">
                  {upload.running
                    ? upload.current
                      ? `正在上传 ${upload.current}（已完成 ${upload.done.toLocaleString()} 个）`
                      : `已完成 ${upload.done.toLocaleString()} 个文件，正在读取清单…`
                    : `本次已交 ${upload.done.toLocaleString()} 个文件。`}
                </p>
              ) : null}
              {upload?.error ? (
                <ErrorNotice
                  message={upload.error}
                  retained="已交的文件不会重复上传，重新选择文件夹即可继续。"
                />
              ) : null}
              {pending > 0 && !upload?.running ? (
                <FolderPicker
                  onPick={(picked) => {
                    folders.set(id, picked);
                    void start(picked);
                  }}
                />
              ) : null}
              {upload?.unmatched.length ? (
                <details>
                  <summary>
                    文件夹里没找到 {upload.unmatched.length.toLocaleString()}{" "}
                    个文件
                  </summary>
                  <ul>
                    {upload.unmatched.map((file) => (
                      <li key={file.file_id}>{file.file_name}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {parts ? <LookupLines parts={parts} /> : null}

      {actual && !withdrawn ? (
        <section className="intake-batch-part" aria-labelledby="batch-report">
          <h3 id="batch-report">报告</h3>
          <p className="intake-batch-line">{fullTextLine(batch.full_text)}</p>
          {named ? (
            <LookupReport items={report.data?.items ?? []} />
          ) : problems.length ? (
            <DataTable
              label="冲突、未接纳与待决定"
              rows={problems}
              getRowId={(item) => `${item.sequence}:${item.record_index}`}
              columns={[
                {
                  id: "id",
                  header: "来源编号",
                  value: (item) => item.external_id || "—",
                },
                {
                  id: "result",
                  header: "结果",
                  value: (item) => DISPOSITIONS[item.disposition],
                },
                {
                  id: "reason",
                  header: "原因",
                  value: (item) => item.reason ?? "—",
                },
              ]}
            />
          ) : null}
          {report.data?.more ? (
            <p className="ui-description">只列出报告前 200 条中的问题。</p>
          ) : null}
          {owed.length ? (
            <DataTable
              label="冲突与未交的文件"
              rows={owed}
              getRowId={(file) => file.file_id}
              columns={[
                { id: "name", header: "文件", value: (file) => file.file_name },
                {
                  id: "state",
                  header: "结果",
                  value: (file) =>
                    file.status === "pending"
                      ? "未交"
                      : FILE_STATES[file.status],
                },
                {
                  id: "reason",
                  header: "原因",
                  value: (file) => file.reason ?? "—",
                },
              ]}
            />
          ) : null}
        </section>
      ) : null}

      {followUp ? (
        <section className="intake-batch-part" aria-labelledby="batch-next">
          <h3 id="batch-next">接着做什么</h3>
          <div className="intake-batch-next">
            <Button
              disabledReason={
                batch.estimates.acquire_pdf === 0
                  ? "这一批没有需要获取全文的文献"
                  : undefined
              }
              onPress={() => setAcquire(true)}
            >
              获取全文 {batch.estimates.acquire_pdf.toLocaleString()} 篇
            </Button>
            <Button
              disabledReason={
                batch.estimates.parse === 0
                  ? "这一批没有需要解析的 PDF"
                  : undefined
              }
              onPress={() => setParse(true)}
            >
              解析并形成未校对的全文 {batch.estimates.parse.toLocaleString()} 篇
            </Button>
            <span className="ui-description">会联网，可能花费。</span>
          </div>
        </section>
      ) : null}

      <div className="intake-batch-actions">
        {state === "running" && imported ? (
          <Button
            isDisabled={action.isPending || !!upload?.running}
            confirm={{
              title: "结束入库",
              description: "还没交来的文件记为未交，写进报告。",
              scope: batch.label,
              confirmLabel: "结束入库",
            }}
            onPress={async () => {
              await action.mutateAsync("finish");
            }}
          >
            结束入库
          </Button>
        ) : null}
        {isActive(batch) && imported ? (
          <Button
            variant="danger"
            isDisabled={action.isPending}
            confirm={{
              title: "取消这一批",
              description:
                state === "running"
                  ? "已入库的书目与 PDF 保留，余下的不再入库。"
                  : "不会写入文献库。",
              scope: batch.label,
              confirmLabel: "取消这一批",
            }}
            onPress={async () => {
              await action.mutateAsync("cancel");
            }}
          >
            取消
          </Button>
        ) : null}
        {awaiting && imported ? (
          <>
            <Button
              variant="primary"
              isDisabled={action.isPending || !preview.data}
              disabledReason={recognizing ? waitText : undefined}
              confirm={{
                title: "确认入库",
                description:
                  "只新增，不删除、不替换已有 PDF；需要决定而没有决定的条目不入库。",
                scope: batch.label,
                confirmLabel: "确认入库",
              }}
              onPress={async () => {
                await action.mutateAsync("confirm");
              }}
            >
              确认入库
            </Button>
            {recognizing ? (
              <span className="ui-description intake-batch-wait">
                {waitText}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      {acquire ? (
        <AcquireDialog
          scope={{
            kind: "query",
            query: { ...emptyQuery(), intake_batch_ids: [batch.batch_id] },
            sort: "intake-desc",
            label: `批次：${batch.label}`,
          }}
          onClose={() => setAcquire(false)}
        />
      ) : null}
      {parse ? (
        <ParseDialog batch={batch} onClose={() => setParse(false)} />
      ) : null}
      {withdrawing ? (
        <WithdrawDialog batch={batch} onClose={() => setWithdrawing(false)} />
      ) : null}
    </section>
  );
}
