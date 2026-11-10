import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  DataTable,
  Definition,
  Definitions,
  ErrorNotice,
  Select,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import type { ApiClient } from "../../data/api.js";
import { navigate } from "../../data/url.js";
import {
  detectFormat,
  DISPOSITIONS,
  excludedName,
  FILE_STATES,
  IMPORT_FILE_LIMIT,
  IMPORT_FORMATS,
  IMPORT_STATES,
  initiator,
  isActive,
  isConfirmable,
  matchFile,
  readFile,
  readResult,
  readSession,
  readSummary,
  sessionSource,
  sha256,
  type ImportFileStatus,
  type ImportSession,
  type ImportState,
} from "../../data/imports.js";
import { readDevice } from "../../data/devices.js";
import { devicesKey } from "../settings/Devices.js";
import { openBatch } from "../library/Folders.js";
import { errorMessage, localTime } from "../../strings.js";

const sessionsKey = ["import-sessions"] as const;
const route = (id: string, action: string) =>
  `/api/v1/import/sessions/${encodeURIComponent(id)}/${action}`;
/** PDF folders chosen on this page, kept until the page is reloaded. */
const folders = new Map<string, File[]>();

const BADGE: Record<
  ImportState,
  "running" | "completed" | "failed" | "partial"
> = {
  collecting: "partial",
  "awaiting-confirmation": "partial",
  importing: "running",
  completed: "completed",
  cancelled: "failed",
};
function StateBadge({ session }: { session: ImportSession }) {
  return (
    <Badge status={BADGE[session.state]}>
      {session.state === "importing" && session.pending_files > 0
        ? `导入中 · 还差 ${session.pending_files.toLocaleString()} 个文件`
        : IMPORT_STATES[session.state]}
    </Badge>
  );
}

/** Connection names for “Agent · name”; the list is optional context. */
function useDeviceNames() {
  const api = useApi();
  return useQuery({
    queryKey: [...devicesKey, "names"],
    queryFn: async ({ signal }) => {
      const page = await api.call(
        "/api/v1/device-connections",
        { cursor: null },
        signal,
      );
      return (Array.isArray(page.items) ? page.items : []).map(readDevice);
    },
    staleTime: 60_000,
  }).data;
}

function FolderPicker({
  label,
  onPick,
}: {
  label: string;
  onPick: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Folder selection is a non-standard attribute React does not type.
    input.current?.setAttribute("webkitdirectory", "");
  }, []);
  return (
    <label className="ui-field">
      <span className="ui-label">{label}</span>
      <input
        ref={input}
        className="ui-file"
        type="file"
        multiple
        onChange={(event) =>
          onPick(
            [...(event.target.files ?? [])].filter((file) =>
              file.name.toLowerCase().endsWith(".pdf"),
            ),
          )
        }
      />
    </label>
  );
}

/** Choose an export (and optionally its PDFs), then open a previewed session. */
export function ImportForm() {
  const api = useApi(),
    queries = useQueryClient();
  const [file, setFile] = useState<File | null>(null),
    [content, setContent] = useState(""),
    [format, setFormat] = useState(""),
    [folder, setFolder] = useState<File[] | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("请选择导出文件。");
      if (file.size > IMPORT_FILE_LIMIT)
        throw new Error("导出文件超过 7 MiB，请拆成几个文件分别导入。");
      const { session } = await api.call("/api/v1/import/sessions", {
        format,
        library: null,
        scope: `网页上传 ${file.name}`,
        file_name: file.name,
      });
      const id = readSession(session).session_id;
      await api.call(route(id, "data"), { sequence: 0, data: content });
      return id;
    },
    onSuccess: (id) => {
      if (folder) folders.set(id, folder);
      void queries.invalidateQueries({ queryKey: sessionsKey });
      navigate({ session: id });
    },
  });
  return (
    <div className="intake-form">
      <Definitions>
        <Definition
          term="导出文件"
          description="BibTeX、BibLaTeX、RIS 或 CSL JSON，不超过 7 MiB。"
        >
          <label className="ui-field">
            <span className="ui-label">导出文件</span>
            <input
              className="ui-file"
              type="file"
              accept=".bib,.ris,.json,.txt"
              onChange={(event) => {
                const next = event.target.files?.[0] ?? null;
                setFile(next);
                setContent("");
                setFormat("");
                if (next)
                  void next.text().then((value) => {
                    setContent(value);
                    setFormat(detectFormat(next.name, value) ?? "");
                  });
              }}
            />
          </label>
        </Definition>
        <Definition
          term="格式"
          description={
            file && content && !format
              ? "没能识别格式，请选择。"
              : "按扩展名与内容识别，可以改。"
          }
        >
          <Select
            label="格式"
            value={format}
            onChange={setFormat}
            options={[{ value: "", label: "请选择" }, ...IMPORT_FORMATS]}
          />
        </Definition>
        <Definition
          term="PDF 文件夹"
          description={
            folder
              ? `可选 · 已选 ${folder.length.toLocaleString()} 个 PDF`
              : "可选。确认导入后，按文件名匹配并逐个上传。"
          }
        >
          <FolderPicker label="PDF 文件夹" onPick={setFolder} />
        </Definition>
      </Definitions>
      <Button
        variant="primary"
        isPending={create.isPending}
        disabledReason={
          !file
            ? "请选择导出文件"
            : !content
              ? "正在读取文件"
              : !format
                ? "请选择格式"
                : undefined
        }
        onPress={() => create.mutate()}
      >
        预览导入
      </Button>
      {create.isError ? (
        <ErrorNotice
          message={errorMessage(create.error)}
          retained="所选文件已保留，可以直接重试。"
        />
      ) : null}
    </div>
  );
}

/** Active and recent sessions from every entry, Agents included. */
export function ImportSessions() {
  const api = useApi(),
    devices = useDeviceNames();
  const sessions = useQuery({
    queryKey: sessionsKey,
    queryFn: async ({ signal }) => {
      const page = await api.call(
        "/api/v1/import/sessions/list",
        { cursor: null, limit: 50 },
        signal,
      );
      return (Array.isArray(page.items) ? page.items : []).map(readSession);
    },
    refetchInterval: 3000,
  });
  return (
    <section className="intake-import-sessions" aria-label="导入会话">
      <h2>导入会话</h2>
      {sessions.isError ? (
        <ErrorNotice
          message={errorMessage(sessions.error)}
          onRetry={() => void sessions.refetch()}
        />
      ) : (
        <DataTable
          label="导入会话"
          rows={sessions.data ?? []}
          getRowId={(session) => session.session_id}
          empty={
            sessions.isPending
              ? "正在读取导入会话…"
              : "还没有导入会话。上传导出文件，或让 Agent 经设备连接导入。"
          }
          columns={[
            {
              id: "source",
              header: "来源",
              value: sessionSource,
              render: (session) => (
                <Button
                  size="inline"
                  variant="text"
                  onPress={() => navigate({ session: session.session_id })}
                >
                  {sessionSource(session)}
                </Button>
              ),
            },
            {
              id: "by",
              header: "发起",
              value: (session) => initiator(session, devices),
              // Rendered each time: the table caches values per row.
              render: (session) => initiator(session, devices),
            },
            {
              id: "state",
              header: "状态",
              value: (session) => IMPORT_STATES[session.state],
              render: (session) => <StateBadge session={session} />,
            },
            {
              id: "created",
              header: "创建",
              value: (session) => session.created_at,
              render: (session) => localTime(session.created_at),
            },
          ]}
        />
      )}
    </section>
  );
}

async function pages<T>(
  read: (cursor: string | null) => Promise<{
    items: T[];
    next: string | null;
  }>,
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
      next: typeof page.next_cursor === "string" ? page.next_cursor : null,
    };
  });

interface Upload {
  done: number;
  current: string | null;
  unmatched: ImportFileStatus[];
  error: string | null;
  running: boolean;
}
/**
 * Works through the owner's list of files still owed: uploads the ones without a
 * PDF in the library, reports only the hash for the rest. The list is read again
 * until bibliography intake is complete, so a reload continues where it stopped.
 */
function useUploader(api: ApiClient, id: string, onChange: () => void) {
  const [upload, setUpload] = useState<Upload | null>(null);
  const running = useRef(false);
  const start = async (folder: File[]) => {
    if (running.current) return;
    running.current = true;
    const tried = new Set<string>(),
      unmatched = new Map<string, ImportFileStatus>();
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
        const session = readSession(
          (await api.call(route(id, "status"), {})).session,
        );
        if (!isActive(session.state)) break;
        if (session.metadata_complete && !progressed) break;
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

function Counts({ items }: { items: [string, number][] }) {
  return (
    <span className="intake-import-counts">
      {items.map(([label, value]) => (
        <span key={label}>
          {label} <strong>{value.toLocaleString()}</strong>
        </span>
      ))}
    </span>
  );
}

/** One session: preview and confirm, then file progress, then the report. */
export function ImportSessionPage({ id }: { id: string }) {
  const api = useApi(),
    queries = useQueryClient(),
    devices = useDeviceNames();
  const status = useQuery({
    queryKey: [...sessionsKey, id],
    queryFn: async ({ signal }) =>
      readSession((await api.call(route(id, "status"), {}, signal)).session),
    refetchInterval: (query) =>
      query.state.data && !isActive(query.state.data.state) ? false : 3000,
  });
  const session = status.data;
  const confirmable = !!session && isConfirmable(session.state);
  const preview = useQuery({
    queryKey: [...sessionsKey, id, "preview"],
    queryFn: async ({ signal }) =>
      readSummary((await api.call(route(id, "preview"), {}, signal)).summary),
    enabled: confirmable,
  });
  const report = useQuery({
    queryKey: [...sessionsKey, id, "report"],
    queryFn: async ({ signal }) => {
      const value = await api.call(route(id, "report"), { limit: 200 }, signal);
      return {
        summary: readSummary(value.summary),
        items: (Array.isArray(value.items) ? value.items : []).map(readResult),
      };
    },
    enabled: !!session && !confirmable,
    refetchInterval: session && isActive(session.state) ? 3000 : false,
  });
  const files = useQuery({
    queryKey: [...sessionsKey, id, "files"],
    queryFn: ({ signal }) => filesOf(api, id, false, signal),
    enabled: !!session && !isActive(session.state),
  });
  const refresh = () =>
    void queries.invalidateQueries({ queryKey: [...sessionsKey, id] });
  const action = useMutation({
    mutationFn: (name: "confirm" | "cancel" | "finish") =>
      api.call(route(id, name), {}),
    onSettled: () => {
      refresh();
      void queries.invalidateQueries({ queryKey: sessionsKey });
    },
  });
  // Confirmed and finished imports change the library and its intake records.
  const state = session?.state,
    processed = session?.processed_records;
  useEffect(() => {
    if (state && !isConfirmable(state))
      void queries.invalidateQueries({ queryKey: ["library"] });
  }, [state, processed, queries]);
  const { upload, start } = useUploader(api, id, refresh);
  const folder = folders.get(id);
  // A folder chosen with the export starts uploading once the import is confirmed.
  useEffect(() => {
    if (session?.state === "importing" && folder && !upload) void start(folder);
  }, [session?.state, folder, upload, start]);

  const back = (
    <Button variant="text" onPress={() => navigate({ session: null })}>
      返回入库
    </Button>
  );
  if (status.isError)
    return (
      <section className="intake-import-session">
        {back}
        <ErrorNotice
          message={errorMessage(status.error)}
          onRetry={() => void status.refetch()}
        />
      </section>
    );
  if (!session)
    return (
      <section className="intake-import-session">
        {back}
        <p role="status">正在读取导入会话…</p>
      </section>
    );
  const summary = confirmable ? preview.data : report.data?.summary;
  const problems = (report.data?.items ?? []).filter(
    (item) =>
      item.disposition === "conflict" || item.disposition === "rejected",
  );
  const owed = (files.data ?? []).filter(
    (file) => file.status === "conflict" || file.status === "pending",
  );
  return (
    <section className="intake-import-session" aria-label="导入会话">
      {back}
      <header className="intake-import-header">
        <h2>{sessionSource(session)}</h2>
        <StateBadge session={session} />
      </header>
      <p className="ui-description">
        {initiator(session, devices)}发起 · {localTime(session.created_at)}
        {confirmable ? " · 你或持有“导入”用途的 Agent 都可以确认" : ""}
      </p>
      {action.isError ? (
        <ErrorNotice message={errorMessage(action.error)} />
      ) : null}
      {confirmable ? (
        <h3>预览（估计，确认时按当时的文献库重新判定）</h3>
      ) : (
        <h3>{isActive(session.state) ? "进度" : "报告"}</h3>
      )}
      {preview.isError && confirmable ? (
        <ErrorNotice
          message={errorMessage(preview.error)}
          onRetry={() => void preview.refetch()}
        />
      ) : null}
      {summary ? (
        <Definitions>
          <Definition term="书目">
            <Counts
              items={
                confirmable
                  ? [
                      ["新增", summary.records.created],
                      [
                        "已在库",
                        summary.records.matched + summary.records.enriched,
                      ],
                      ["冲突", summary.records.conflicts],
                      ["未接纳", summary.records.rejected],
                    ]
                  : [
                      ["新增", summary.records.created],
                      ["补全", summary.records.enriched],
                      ["已在库", summary.records.matched],
                      ["冲突", summary.records.conflicts],
                      ["未接纳", summary.records.rejected],
                    ]
              }
            />
            {session.state === "importing" && !session.metadata_complete ? (
              <p className="ui-description">
                已处理 {session.processed_records.toLocaleString()} /{" "}
                {session.record_count.toLocaleString()}
              </p>
            ) : null}
          </Definition>
          <Definition term="文件">
            <Counts
              items={
                confirmable
                  ? [
                      ["要上传", summary.files.upload],
                      ["只核对", summary.files.hash],
                    ]
                  : [
                      ["已上传", summary.files.uploaded],
                      ["已有", summary.files.existing],
                      ["冲突", summary.files.conflicts],
                      [
                        isActive(session.state) ? "待交" : "未交",
                        session.pending_files || summary.files.missing,
                      ],
                    ]
              }
            />
          </Definition>
          <Definition term="批注">
            <Counts
              items={[
                ["可导入", summary.annotations.supported],
                ["不能导入", summary.annotations.unsupported],
              ]}
            />
          </Definition>
          {summary.excluded.length ? (
            <Definition term="不导入的内容">
              <Counts
                items={summary.excluded.map((item) => [
                  excludedName(item.kind),
                  item.count,
                ])}
              />
            </Definition>
          ) : null}
        </Definitions>
      ) : (
        <p role="status">正在读取…</p>
      )}
      {session.state === "importing" ? (
        <div className="intake-import-upload">
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
          {session.pending_files > 0 && !upload?.running ? (
            <FolderPicker
              label="选择 PDF 文件夹"
              onPick={(picked) => {
                folders.set(id, picked);
                void start(picked);
              }}
            />
          ) : null}
          {upload?.unmatched.length ? (
            <details>
              <summary>
                文件夹里没找到 {upload.unmatched.length.toLocaleString()} 个文件
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
      <div className="intake-import-actions">
        {isActive(session.state) ? (
          <Button
            variant="danger"
            isDisabled={action.isPending}
            confirm={{
              title: "取消导入会话",
              description: confirmable
                ? "不会写入文献库。"
                : "已导入的书目与 PDF 保留，余下的不再导入。",
              scope: sessionSource(session),
              confirmLabel: "取消会话",
            }}
            onPress={async () => {
              await action.mutateAsync("cancel");
            }}
          >
            取消会话
          </Button>
        ) : null}
        {session.state === "importing" && session.metadata_complete ? (
          <Button
            isDisabled={action.isPending || !!upload?.running}
            confirm={{
              title: "结束导入",
              description: "还没交来的文件记为未交，写进报告。",
              scope: sessionSource(session),
              confirmLabel: "结束导入",
            }}
            onPress={async () => {
              await action.mutateAsync("finish");
            }}
          >
            结束导入
          </Button>
        ) : null}
        {confirmable ? (
          <Button
            variant="primary"
            isDisabled={action.isPending || !preview.data}
            confirm={{
              title: "确认导入",
              description: "只新增，不删除、不替换已有 PDF。",
              scope: sessionSource(session),
              confirmLabel: "确认导入",
            }}
            onPress={async () => {
              await action.mutateAsync("confirm");
            }}
          >
            确认导入
          </Button>
        ) : null}
        {session.intake_batch_id && !confirmable ? (
          <Button onPress={() => openBatch(session.intake_batch_id!)}>
            在文献库查看
          </Button>
        ) : null}
      </div>
      {problems.length ? (
        <DataTable
          label="冲突与未接纳"
          rows={problems}
          getRowId={(item) => item.external_id}
          columns={[
            { id: "id", header: "来源编号", value: (item) => item.external_id },
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
                file.status === "pending" ? "未交" : FILE_STATES[file.status],
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
  );
}
