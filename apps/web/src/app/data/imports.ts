import {
  parseIntakeBatch,
  type IntakeBatch,
  type IntakeBatchResult,
  type IntakeBatchState,
  type IntakeFileStatus,
  type IntakeItemResult,
  type IntakeSummary,
} from "@sciretriever/contracts";
import { record, type JsonRecord } from "./wire.js";
import type { DeviceConnection } from "./devices.js";

/** The intake interface (ADR 0063): one batch from creation to report. */
export const intakeRoute = (id: string, action: string) =>
  `/api/v1/intake/batches/${encodeURIComponent(id)}/${action}`;
export const readBatch = (value: unknown): IntakeBatch =>
  parseIntakeBatch(value);

export const BATCH_STATES: Record<IntakeBatchState, string> = {
  collecting: "收集中",
  "awaiting-confirmation": "待确认",
  running: "入库中",
  finished: "完成",
  cancelled: "已取消",
  withdrawn: "已撤回",
};
export const BATCH_RESULTS: Record<IntakeBatchResult, string> = {
  completed: "完成",
  partial: "部分完成",
  failed: "失败",
  interrupted: "已中断",
};
/** A finished batch names its result; the others their state. */
export const batchStateText = (batch: IntakeBatch) =>
  batch.state === "finished" && batch.result
    ? BATCH_RESULTS[batch.result]
    : BATCH_STATES[batch.state];
export const isActive = (batch: IntakeBatch) =>
  batch.state === "collecting" ||
  batch.state === "awaiting-confirmation" ||
  batch.state === "running";
export const isConfirmable = (batch: IntakeBatch) =>
  batch.state === "collecting" || batch.state === "awaiting-confirmation";
/** Bibliography is in; only the files the source referred to are still owed. */
export const metadataDone = (batch: IntakeBatch) =>
  batch.state === "running" && batch.progress?.phase !== "metadata";
export const pendingFiles = (batch: IntakeBatch) =>
  batch.progress?.files.pending ?? 0;

export type IntakeDisposition = IntakeItemResult["disposition"];
export type IntakeFileState = IntakeFileStatus["status"];
export interface BatchSummary {
  records: IntakeSummary["records"];
  files: IntakeSummary["files"];
  annotations: { supported: number; unsupported: number; deferred: number };
  excluded: { kind: string; count: number }[];
}
export interface BatchFile {
  file_id: string;
  file_name: string;
  size_bytes: number | null;
  action: "upload" | "hash";
  status: IntakeFileState;
  reason: string | null;
}
export interface BatchItemResult {
  sequence: number;
  record_index: number;
  external_id: string;
  disposition: IntakeDisposition;
  literature_id: string | null;
  reason: string | null;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const counts = <K extends string>(value: unknown, keys: readonly K[]) => {
  const item = value && typeof value === "object" ? (value as JsonRecord) : {};
  return Object.fromEntries(keys.map((key) => [key, count(item[key])])) as {
    [P in K]: number;
  };
};

export function readSummary(value: unknown): BatchSummary {
  const item = record(value, "intake summary");
  return {
    records: counts(item.records, [
      "created",
      "enriched",
      "matched",
      "conflicts",
      "rejected",
      "restored",
      "possible_duplicates",
      "pending_decision",
      "needs_metadata",
    ] as const),
    files: counts(item.files, [
      "upload",
      "hash",
      "uploaded",
      "existing",
      "conflicts",
      "missing",
      "unpaired",
    ] as const),
    annotations: counts(item.annotations, [
      "supported",
      "unsupported",
      "deferred",
    ] as const),
    excluded: (Array.isArray(item.excluded) ? item.excluded : []).map(
      (entry) => {
        const excluded = record(entry, "excluded");
        return { kind: text(excluded.kind), count: count(excluded.count) };
      },
    ),
  };
}
const FILE_STATUS = ["pending", "uploaded", "existing", "conflict"] as const;
export function readFile(value: unknown): BatchFile {
  const item = record(value, "intake file");
  return {
    file_id: text(item.file_id),
    file_name: text(item.file_name),
    size_bytes: typeof item.size_bytes === "number" ? item.size_bytes : null,
    action: item.action === "hash" ? "hash" : "upload",
    status: (FILE_STATUS as readonly string[]).includes(text(item.status))
      ? (item.status as IntakeFileState)
      : "pending",
    reason: typeof item.reason === "string" ? item.reason : null,
  };
}
export function readResult(value: unknown): BatchItemResult {
  const item = record(value, "intake result");
  return {
    sequence: count(item.sequence),
    record_index: count(item.record_index),
    external_id: text(item.external_id),
    disposition: Object.hasOwn(DISPOSITIONS, text(item.disposition))
      ? (item.disposition as IntakeDisposition)
      : "rejected",
    literature_id:
      typeof item.literature_id === "string" ? item.literature_id : null,
    reason: typeof item.reason === "string" ? item.reason : null,
  };
}

/** The source as the user knows it: the library's name, else the uploaded file. */
export function batchSource(batch: IntakeBatch): string {
  const source = batch.source;
  const name =
    source?.name || batch.request.file_name || batch.label || "未命名来源";
  return source &&
    source.system &&
    source.identity !== "adhoc" &&
    source.system !== "file"
    ? `${name}（${systemName(source.system)}）`
    : name;
}
const SYSTEMS: Record<string, string> = {
  zotero: "Zotero",
  endnote: "EndNote",
};
const systemName = (system: string) => SYSTEMS[system] ?? system;

/** Who started the batch; a device shows by its connection name. */
export function initiator(
  batch: IntakeBatch,
  devices: readonly DeviceConnection[] = [],
): string {
  const by = batch.initiated_by;
  if (by.startsWith("device:")) {
    const device = devices.find(
      (item) => item.connection_id === by.slice("device:".length),
    );
    return device ? `Agent · ${device.name}` : "设备连接";
  }
  return (
    { "local:web": "网页", "local:cli": "CLI", "local:mcp": "MCP" }[by] ??
    "网页"
  );
}

export const IMPORT_FORMATS = [
  { value: "bibtex", label: "BibTeX" },
  { value: "biblatex", label: "BibLaTeX" },
  { value: "ris", label: "RIS" },
  { value: "csl-json", label: "CSL JSON" },
] as const;
export const IMPORT_FILE_LIMIT = 7 * 1024 * 1024;

/** The export format from the file's name and opening content, or null when unclear. */
export function detectFormat(name: string, content: string): string | null {
  const head = content.slice(0, 4096).trimStart(),
    extension = name.toLowerCase().split(".").pop() ?? "";
  if (/^TY {2}- /mu.test(head) || extension === "ris") return "ris";
  if (head.startsWith("[") || head.startsWith("{") || extension === "json")
    return head.startsWith("[") || /"type"\s*:/u.test(head) ? "csl-json" : null;
  if (/@[a-z]+\s*[{(]/iu.test(head) || extension === "bib")
    return /@(online|mvbook|thesis|report)\s*[{(]|\b(date|journaltitle|location)\s*=/iu.test(
      content.slice(0, 65536),
    )
      ? "biblatex"
      : "bibtex";
  return null;
}

/** Files in a chosen folder by name; a size the source gave breaks ties. */
export function matchFile(
  folder: readonly File[],
  wanted: BatchFile,
): File | null {
  const candidates = folder.filter(
    (file) => file.name.toLowerCase() === wanted.file_name.toLowerCase(),
  );
  if (candidates.length <= 1) return candidates[0] ?? null;
  return (
    candidates.find((file) => file.size === wanted.size_bytes) ??
    candidates[0] ??
    null
  );
}

export async function sha256(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export const DISPOSITIONS: Record<IntakeDisposition, string> = {
  created: "新增",
  enriched: "补全",
  matched: "已在库",
  restored: "恢复",
  conflict: "冲突",
  rejected: "未接纳",
  "pending-decision": "待决定",
  excluded: "不入库",
};
export const FILE_STATES: Record<IntakeFileState, string> = {
  pending: "待交",
  uploaded: "已上传",
  existing: "已有",
  conflict: "冲突",
};
const EXCLUDED: Record<string, string> = {
  note: "笔记",
  notes: "笔记",
  "attachment-note": "附件笔记",
  "non-pdf-file": "非 PDF 附件",
  "extra-file": "其他附件",
  "linked-file": "链接文件",
};
export const excludedName = (kind: string) => EXCLUDED[kind] ?? kind;
