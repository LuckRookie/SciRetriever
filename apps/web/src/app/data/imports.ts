import { record, type JsonRecord } from "./wire.js";
import type { DeviceConnection } from "./devices.js";

export type ImportState =
  | "collecting"
  | "awaiting-confirmation"
  | "importing"
  | "completed"
  | "cancelled";
export const IMPORT_STATES: Record<ImportState, string> = {
  collecting: "收集中",
  "awaiting-confirmation": "待确认",
  importing: "导入中",
  completed: "完成",
  cancelled: "已取消",
};
export const isActive = (state: ImportState) =>
  state !== "completed" && state !== "cancelled";
export const isConfirmable = (state: ImportState) =>
  state === "collecting" || state === "awaiting-confirmation";

export interface ImportSession {
  session_id: string;
  library: { system: string; name: string; identity: string };
  format: string;
  file_name: string | null;
  state: ImportState;
  created_at: string;
  initiated_by: string;
  intake_batch_id: string | null;
  metadata_complete: boolean;
  record_count: number;
  processed_records: number;
  pending_files: number;
}
export interface ImportSummary {
  records: {
    created: number;
    enriched: number;
    matched: number;
    conflicts: number;
    rejected: number;
  };
  files: {
    upload: number;
    hash: number;
    uploaded: number;
    existing: number;
    conflicts: number;
    missing: number;
  };
  annotations: { supported: number; unsupported: number; deferred: number };
  excluded: { kind: string; count: number }[];
}
export interface ImportFileStatus {
  file_id: string;
  file_name: string;
  size_bytes: number | null;
  action: "upload" | "hash";
  status: "pending" | "uploaded" | "existing" | "conflict";
  reason: string | null;
}
export interface ImportRecordResult {
  external_id: string;
  disposition: "created" | "enriched" | "matched" | "conflict" | "rejected";
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

export function readSession(value: unknown): ImportSession {
  const item = record(value, "import session"),
    library = record(item.library, "import library");
  if (typeof item.session_id !== "string") throw new Error("invalid session");
  return {
    session_id: item.session_id,
    library: {
      system: text(library.system),
      name: text(library.name),
      identity: text(library.identity),
    },
    format: text(item.format),
    file_name: typeof item.file_name === "string" ? item.file_name : null,
    state: (Object.hasOwn(IMPORT_STATES, text(item.state))
      ? item.state
      : "cancelled") as ImportState,
    created_at: text(item.created_at),
    initiated_by: text(item.initiated_by),
    intake_batch_id:
      typeof item.intake_batch_id === "string" ? item.intake_batch_id : null,
    metadata_complete: item.metadata_complete === true,
    record_count: count(item.record_count),
    processed_records: count(item.processed_records),
    pending_files: count(item.pending_files),
  };
}
export function readSummary(value: unknown): ImportSummary {
  const item = record(value, "import summary");
  return {
    records: counts(item.records, [
      "created",
      "enriched",
      "matched",
      "conflicts",
      "rejected",
    ] as const),
    files: counts(item.files, [
      "upload",
      "hash",
      "uploaded",
      "existing",
      "conflicts",
      "missing",
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
export function readFile(value: unknown): ImportFileStatus {
  const item = record(value, "import file");
  return {
    file_id: text(item.file_id),
    file_name: text(item.file_name),
    size_bytes: typeof item.size_bytes === "number" ? item.size_bytes : null,
    action: item.action === "hash" ? "hash" : "upload",
    status: (["pending", "uploaded", "existing", "conflict"].includes(
      text(item.status),
    )
      ? item.status
      : "pending") as ImportFileStatus["status"],
    reason: typeof item.reason === "string" ? item.reason : null,
  };
}
export function readResult(value: unknown): ImportRecordResult {
  const item = record(value, "import result");
  return {
    external_id: text(item.external_id),
    disposition: (["created", "enriched", "matched", "conflict"].includes(
      text(item.disposition),
    )
      ? item.disposition
      : "rejected") as ImportRecordResult["disposition"],
    literature_id:
      typeof item.literature_id === "string" ? item.literature_id : null,
    reason: typeof item.reason === "string" ? item.reason : null,
  };
}

/** The source as the user knows it: the library's name, else the uploaded file. */
export function sessionSource(session: ImportSession): string {
  const name = session.library.name || session.file_name || "未命名来源";
  return session.library.system &&
    session.library.identity !== "adhoc" &&
    session.library.system !== "file"
    ? `${name}（${systemName(session.library.system)}）`
    : name;
}
const SYSTEMS: Record<string, string> = {
  zotero: "Zotero",
  endnote: "EndNote",
};
const systemName = (system: string) => SYSTEMS[system] ?? system;

/** Who started the session; a device shows by its connection name. */
export function initiator(
  session: ImportSession,
  devices: readonly DeviceConnection[] = [],
): string {
  const by = session.initiated_by;
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
  wanted: ImportFileStatus,
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

export const DISPOSITIONS: Record<ImportRecordResult["disposition"], string> = {
  created: "新增",
  enriched: "补全",
  matched: "已在库",
  conflict: "冲突",
  rejected: "未接纳",
};
export const FILE_STATES: Record<ImportFileStatus["status"], string> = {
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
