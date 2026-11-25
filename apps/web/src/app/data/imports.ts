import {
  parseIntakeBatch,
  type IntakeBatch,
  type IntakeBatchSummary,
  type IntakeBatchItem,
  type IntakeDecision,
  type IntakeBatchResult,
  type IntakeBatchState,
  type IntakeFileStatus,
  type IntakeItemResult,
  type IntakeLookupItem,
  type IntakeLookupSummary,
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
  running: "进行中",
  finished: "已结束",
  cancelled: "已取消",
  withdrawn: "已撤回",
};
export const BATCH_RESULTS: Record<IntakeBatchResult, string> = {
  completed: "完成",
  partial: "部分完成",
  failed: "失败",
  interrupted: "中断",
};
/** A finished batch names its result; the others their state. */
export const batchStateText = (batch: IntakeBatchSummary) =>
  batch.state === "finished" && batch.result
    ? BATCH_RESULTS[batch.result]
    : BATCH_STATES[batch.state];
export const isActive = (batch: IntakeBatchSummary) =>
  batch.state === "collecting" ||
  batch.state === "awaiting-confirmation" ||
  batch.state === "running";

export type IntakeDisposition = IntakeItemResult["disposition"];
export type IntakeFileState = IntakeFileStatus["status"];
/** Why a PDF's own words could not be read (technical 03 6.4.10), as said to a reader. */
const UNREAD_REASONS: Readonly<Record<string, string>> = {
  "reader-unavailable": "服务器读不了 PDF",
  "reader-timeout": "读取超时",
  "reader-failed": "读取失败",
  "encrypted-pdf": "加密",
  "invalid-pdf": "不是有效的 PDF",
  "image-only": "扫描件",
};
export interface BatchSummary {
  records: IntakeSummary["records"];
  /**
   * PDFs whose contents were not read: they enter under their file names.
   * The reasons that occurred, with their counts; empty for a batch saved
   * before the count existed.
   */
  unread: { total: number; reasons: (readonly [string, number])[] };
  files: IntakeSummary["files"];
  annotations: { supported: number; unsupported: number; deferred: number };
  excluded: { kind: string; count: number }[];
  /** A `lookup` batch's line counts (literature materials 6.4.10); null otherwise. */
  lookup: IntakeLookupSummary | null;
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
  /** A `lookup` batch's line: its number and text as submitted. */
  line: { number: number; text: string } | null;
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

const LOOKUP_COUNTS = [
  "lines",
  "recognized",
  "existing",
  "candidates",
  "unrecognized",
  "included",
  "rejected",
  "duplicates",
  "pending",
] as const;
export function readSummary(value: unknown): BatchSummary {
  const item = record(value, "intake summary");
  const unread =
    item.records && typeof item.records === "object"
      ? (item.records as JsonRecord).clues_unread
      : undefined;
  const byReason =
    unread && typeof unread === "object"
      ? (unread as JsonRecord).by_reason
      : undefined;
  const reasons = Object.entries(UNREAD_REASONS)
    .map(
      ([reason, label]) =>
        [
          label,
          count(
            byReason && typeof byReason === "object"
              ? (byReason as JsonRecord)[reason]
              : 0,
          ),
        ] as const,
    )
    .filter(([, n]) => n > 0);
  return {
    unread: { total: reasons.reduce((sum, [, n]) => sum + n, 0), reasons },
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
    lookup:
      item.lookup && typeof item.lookup === "object"
        ? counts(item.lookup, LOOKUP_COUNTS)
        : null,
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
    line:
      item.line && typeof item.line === "object"
        ? {
            number: count((item.line as JsonRecord).number),
            text: text((item.line as JsonRecord).text),
          }
        : null,
  };
}

/** The source as the user knows it: the library's name, else the uploaded file. */
export function batchSource(batch: IntakeBatchSummary): string {
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

/**
 * Who started the batch (page specs “入库记录”): the Web, CLI or MCP, or a
 * device by its kind and connection name — “设备” for one made before
 * connections had a kind.
 */
export function initiator(
  batch: IntakeBatchSummary,
  devices: readonly DeviceConnection[] = [],
): string {
  const by = batch.initiated_by;
  if (by.startsWith("device:")) {
    const device = devices.find(
      (item) => item.connection_id === by.slice("device:".length),
    );
    if (!device) return "设备连接";
    const kind =
      device.kind === "extension"
        ? "扩展"
        : device.kind === "agent"
          ? "Agent"
          : "设备";
    return `${kind} · ${device.name}`;
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

/** File recognition during preview (literature materials 6.4.6). */
export interface Recognition {
  state: "running" | "cancelled" | "done" | "idle";
  recognized: number;
  total: number;
}
export function readRecognition(value: unknown): Recognition | null {
  if (!value || typeof value !== "object") return null;
  const item = value as JsonRecord;
  const state = ["running", "cancelled", "done", "idle"].includes(
    text(item.state),
  )
    ? (item.state as Recognition["state"])
    : "idle";
  return {
    state,
    recognized: count(item.recognized),
    total: count(item.total),
  };
}
const list = (value: unknown) => (Array.isArray(value) ? value : []);
const nullable = (value: unknown) => (typeof value === "string" ? value : null);
const year = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) ? value : null;
/** One item of a batch, as its decisions need it (literature materials 6.4.10). */
export function readItem(value: unknown): IntakeBatchItem {
  const item = record(value, "intake item");
  const recognition =
    item.recognition && typeof item.recognition === "object"
      ? (item.recognition as JsonRecord)
      : null;
  return {
    item_id: text(item.item_id),
    origin:
      item.origin === "file" || item.origin === "page" ? item.origin : "data",
    sequence: typeof item.sequence === "number" ? item.sequence : null,
    record_index:
      typeof item.record_index === "number" ? item.record_index : null,
    external_id: nullable(item.external_id),
    title: nullable(item.title),
    file_name: nullable(item.file_name),
    recognition: recognition
      ? {
          state: ([
            "pending",
            "recognized",
            "candidates",
            "unrecognized",
            "cancelled",
          ].includes(text(recognition.state))
            ? recognition.state
            : "pending") as NonNullable<
            IntakeBatchItem["recognition"]
          >["state"],
          step: null,
          literature_id: null,
          candidates: list(recognition.candidates).map((entry) => {
            const c = record(entry, "candidate");
            return {
              candidate_id: text(c.candidate_id),
              title: nullable(c.title),
              authors: list(c.authors) as never,
              publication_year: year(c.publication_year),
              identifiers: list(c.identifiers) as never,
              source_name: text(c.source_name),
              similarity: count(c.similarity),
            };
          }),
        }
      : null,
    possible_duplicates: list(item.possible_duplicates).map((entry) => {
      const d = record(entry, "possible duplicate");
      return {
        literature_id: text(d.literature_id) as never,
        title: nullable(d.title),
        first_author: nullable(d.first_author),
        publication_year: year(d.publication_year),
        similarity: count(d.similarity),
      };
    }),
    unpaired: item.unpaired === true,
    needs_decision: item.needs_decision === true,
    decision:
      item.decision && typeof item.decision === "object"
        ? (item.decision as IntakeDecision)
        : null,
    disposition: Object.hasOwn(DISPOSITIONS, text(item.disposition))
      ? (item.disposition as IntakeDisposition)
      : null,
    decided_by: nullable(item.decided_by),
    decided_at: nullable(item.decided_at),
    ...(item.lookup && typeof item.lookup === "object"
      ? { lookup: readLookup(item.lookup as JsonRecord) }
      : {}),
  };
}
const LOOKUP_KINDS = ["doi", "arxiv", "pmid", "title"] as const;
const LOOKUP_OUTCOMES = [
  "pending",
  "recognized",
  "existing",
  "candidates",
  "unrecognized",
  "rejected",
  "duplicate",
] as const;
const LOOKUP_REFUSALS = [
  "lookup-unsupported-url",
  "lookup-too-short",
  "lookup-too-long",
  "duplicate-line",
] as const;
const oneOf = <T extends string>(values: readonly T[], value: unknown) =>
  (values as readonly unknown[]).includes(value) ? (value as T) : null;
/** One submitted line of a `lookup` batch (literature materials 6.4.10). */
function readLookup(value: JsonRecord): IntakeLookupItem {
  const found =
    value.found && typeof value.found === "object"
      ? (value.found as JsonRecord)
      : null;
  return {
    line: count(value.line),
    text: text(value.text),
    kind: oneOf(LOOKUP_KINDS, value.kind),
    reason: oneOf(LOOKUP_REFUSALS, value.reason),
    outcome: oneOf(LOOKUP_OUTCOMES, value.outcome) ?? "pending",
    included: value.included === true,
    found: found
      ? {
          title: nullable(found.title),
          first_author: nullable(found.first_author),
          publication_year: year(found.publication_year),
          identifiers: list(found.identifiers) as never,
        }
      : null,
  };
}
/** The three kinds of item a person decides (page specs “批次页” 3). */
export type DecisionKind = "duplicate" | "candidate" | "unpaired";
export function decisionKind(item: IntakeBatchItem): DecisionKind | null {
  if (item.unpaired) return "unpaired";
  if (item.recognition?.state === "candidates") return "candidate";
  if (item.possible_duplicates.length) return "duplicate";
  return null;
}
export const DECISION_GROUPS: Record<DecisionKind, string> = {
  duplicate: "可能重复",
  candidate: "可能是这一篇",
  unpaired: "未配对的文件",
};
/** “Title · first author · year”, leaving out what is missing. */
export const candidateText = (c: {
  title: string | null;
  first_author?: string | null;
  authors?: readonly unknown[];
  publication_year: number | null;
}) =>
  [
    c.title ?? "无标题",
    c.first_author ?? authorName(c.authors?.[0]),
    c.publication_year ? String(c.publication_year) : "",
  ]
    .filter(Boolean)
    .join(" · ");
function authorName(author: unknown): string {
  if (!author || typeof author !== "object") return "";
  const a = author as JsonRecord;
  return text(a.display_name) || text(a.family_name);
}
export const PHASES: Record<
  NonNullable<IntakeBatch["progress"]>["phase"],
  string
> = {
  metadata: "书目入库",
  files: "等待文件",
  closing: "收尾",
};
/** “全文已取得 n / 总数 m，未取得 k（其中自动途径已试完 j）”, j left out at 0. */
export function fullTextLine(counts: IntakeBatch["full_text"]): string {
  return `全文已取得 ${counts.obtained.toLocaleString()} / 总数 ${counts.total.toLocaleString()}，未取得 ${counts.missing.toLocaleString()}${
    counts.exhausted
      ? `（其中自动途径已试完 ${counts.exhausted.toLocaleString()}）`
      : ""
  }`;
}
