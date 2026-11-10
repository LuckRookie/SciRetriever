import {
  ContractValidationError,
  parseLiteratureMetadata,
  type LiteratureMetadata,
} from "./index.js";

export const IMPORT_LIMITS = {
  request_bytes: 8 * 1024 * 1024,
  session_bytes: 256 * 1024 * 1024,
  records: 50_000,
  parts: 1024,
  groups: 10_000,
  page_items: 200,
  disk_reserve_bytes: 256 * 1024 * 1024,
  expiry_ms: 7 * 24 * 60 * 60 * 1000,
} as const;
export type ImportSessionState =
  | "collecting"
  | "awaiting-confirmation"
  | "importing"
  | "completed"
  | "cancelled";
export interface ImportLibrary {
  readonly system: string;
  readonly library_id: string;
  readonly identity: "global" | "local" | "adhoc";
  readonly name: string;
}
export interface ImportGroup {
  readonly external_id: string;
  readonly parent_external_id: string | null;
  readonly name: string;
}
export interface ImportFile {
  readonly external_id: string;
  readonly file_name: string;
  readonly media_type: string;
  readonly preferred: boolean;
  readonly size_bytes: number | null;
  readonly sha256: string | null;
}
export interface ImportAnnotation {
  readonly external_id: string;
  readonly file_external_id: string;
  readonly kind: "highlight" | "underline" | "region" | "note" | "text" | "ink";
  readonly quote: string;
  readonly note: string;
  readonly color: string | null;
  readonly page_index: number | null;
  readonly coordinate_space: "pdf-bottom-left" | "normalized-top-left";
  readonly rects: readonly (readonly [number, number, number, number])[];
}
export interface ImportRecord {
  readonly external_id: string;
  readonly metadata: LiteratureMetadata;
  readonly source_type: string | null;
  readonly groups: readonly string[];
  readonly user_tags: readonly string[];
  readonly files: readonly ImportFile[];
  readonly annotations: readonly ImportAnnotation[];
}
export interface ImportExcluded {
  readonly kind: string;
  readonly count: number;
}
export interface ImportData {
  readonly records: readonly ImportRecord[];
  readonly groups: readonly ImportGroup[];
  readonly excluded: readonly ImportExcluded[];
}
export interface ImportAdapterItem {
  readonly external_id?: string;
  readonly record_index: number;
  readonly record: ImportRecord | null;
  readonly reason: string | null;
}
export interface ImportAdapterResult {
  readonly items: readonly ImportAdapterItem[];
  readonly groups: readonly ImportGroup[];
  readonly excluded: readonly ImportExcluded[];
}
/** Pure conversion only. No I/O, randomness, clock, database or network. */
export interface ImportAdapter {
  readonly format: string;
  decode(data: unknown, sequence: number): ImportAdapterResult;
}
export interface ImportSession {
  readonly session_id: string;
  readonly library_key: string;
  readonly library: ImportLibrary;
  readonly format: string;
  readonly scope: string;
  readonly file_name: string | null;
  readonly import_user_tags: boolean;
  readonly state: ImportSessionState;
  readonly created_at: string;
  readonly updated_at: string;
  readonly confirmed_at: string | null;
  readonly finished_at: string | null;
  readonly last_file_at: string | null;
  readonly initiated_by: string;
  readonly intake_batch_id: string | null;
  readonly metadata_complete: boolean;
  readonly record_count: number;
  readonly processed_records: number;
  readonly pending_files: number;
}
export interface ImportRecordResult {
  readonly sequence: number;
  readonly record_index: number;
  readonly external_id: string;
  readonly disposition:
    | "created"
    | "enriched"
    | "matched"
    | "conflict"
    | "rejected";
  readonly literature_id: string | null;
  readonly meta_literature_id: string | null;
  readonly reason: string | null;
}
export interface ImportFileStatus {
  readonly file_id: string;
  readonly external_id: string;
  readonly record_external_id: string;
  readonly literature_id: string;
  readonly file_name: string;
  readonly size_bytes: number | null;
  readonly expected_sha256: string | null;
  readonly action: "upload" | "hash";
  readonly status: "pending" | "uploaded" | "existing" | "conflict";
  readonly sha256: string | null;
  readonly reason: string | null;
}
export interface ImportSummary {
  readonly records: {
    readonly created: number;
    readonly enriched: number;
    readonly matched: number;
    readonly conflicts: number;
    readonly rejected: number;
  };
  readonly files: {
    readonly upload: number;
    readonly hash: number;
    readonly uploaded: number;
    readonly existing: number;
    readonly conflicts: number;
    readonly missing: number;
  };
  readonly annotations: {
    readonly supported: number;
    readonly unsupported: number;
    readonly imported: 0;
    readonly deferred: number;
  };
  readonly excluded: readonly ImportExcluded[];
}
export interface ImportPreview {
  readonly session: ImportSession;
  readonly estimated: true;
  readonly summary: ImportSummary;
}
export interface ImportReport {
  readonly session: ImportSession;
  readonly estimated: false;
  readonly summary: ImportSummary;
  readonly items: readonly ImportRecordResult[];
  readonly next_cursor: string | null;
}
export interface ExternalObjectMapping {
  readonly library_key: string;
  readonly object_kind: "record" | "group" | "file" | "annotation";
  readonly external_id: string;
  readonly internal_id: string;
  readonly content_sha256: string | null;
  readonly observation_id: string | null;
}
export function importObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractValidationError();
  const r = value as Record<string, unknown>;
  if (
    required.some((k) => !Object.hasOwn(r, k)) ||
    Object.keys(r).some((k) => !required.includes(k) && !optional.includes(k))
  )
    throw new ContractValidationError();
  return r;
}
export function importString(value: unknown, max = 1024): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  )
    throw new ContractValidationError();
  return value.trim();
}
export function importHash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
    throw new ContractValidationError();
  return value;
}
export function importInteger(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    throw new ContractValidationError();
  return value;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new ContractValidationError();
  return value;
}
function fileReference(value: unknown) {
  const reference = importString(value);
  if (
    /^(?:[/\\]|[a-zA-Z]:[/\\])/u.test(reference) ||
    reference.split(/[/\\]/u).some((v) => v === "." || v === "..")
  )
    throw new ContractValidationError();
  return reference;
}
export function parseImportCreate(value: unknown) {
  const r = importObject(
    value,
    ["format", "library", "scope"],
    ["import_user_tags", "file_name"],
  );
  if (
    r.import_user_tags !== undefined &&
    typeof r.import_user_tags !== "boolean"
  )
    throw new ContractValidationError();
  let library: {
    system: string;
    library_id: string;
    identity: "global" | "local";
    name: string;
  } | null = null;
  if (r.library !== null) {
    const l = importObject(r.library, [
      "system",
      "library_id",
      "identity",
      "name",
    ]);
    if (!["global", "local"].includes(String(l.identity)))
      throw new ContractValidationError();
    const system = importString(l.system, 64);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(system))
      throw new ContractValidationError();
    library = {
      system,
      library_id: importString(l.library_id),
      identity: l.identity as "global" | "local",
      name: importString(l.name, 1024),
    };
  }
  return {
    format: importString(r.format, 64),
    library,
    scope: importString(r.scope, 8192),
    file_name:
      r.file_name === undefined || r.file_name === null
        ? null
        : importString(r.file_name, 1024),
    import_user_tags: r.import_user_tags !== false,
  };
}
export function parseImportData(value: unknown): ImportData {
  const r = importObject(value, ["records"], ["groups", "excluded"]);
  const groups = array(r.groups ?? [], IMPORT_LIMITS.groups).map((value) => {
    const g = importObject(value, [
      "external_id",
      "parent_external_id",
      "name",
    ]);
    return {
      external_id: importString(g.external_id),
      parent_external_id:
        g.parent_external_id === null
          ? null
          : importString(g.parent_external_id),
      name: importString(g.name, 4096),
    };
  });
  const excluded = array(r.excluded ?? [], 128).map((value) => {
    const e = importObject(value, ["kind", "count"]);
    const kind = importString(e.kind, 64);
    if (!/^[a-z][a-z0-9-]*$/u.test(kind)) throw new ContractValidationError();
    return { kind, count: importInteger(e.count) };
  });
  const records = array(r.records, IMPORT_LIMITS.records).map((value) => {
    const v = importObject(
      value,
      ["external_id", "metadata"],
      ["source_type", "groups", "user_tags", "files", "annotations"],
    );
    const files = array(v.files ?? [], 100).map((value) => {
      const f = importObject(
        value,
        ["external_id", "file_name", "media_type", "preferred"],
        ["size_bytes", "sha256"],
      );
      if (typeof f.preferred !== "boolean") throw new ContractValidationError();
      const file_name = importString(f.file_name);
      if (/[/\\]/u.test(file_name) || file_name === "." || file_name === "..")
        throw new ContractValidationError();
      return {
        external_id: fileReference(f.external_id),
        file_name,
        media_type: importString(f.media_type, 128),
        preferred: f.preferred,
        size_bytes:
          f.size_bytes === null || f.size_bytes === undefined
            ? null
            : importInteger(f.size_bytes),
        sha256:
          f.sha256 === null || f.sha256 === undefined
            ? null
            : importHash(f.sha256),
      };
    });
    if (files.filter((f) => f.preferred).length > 1)
      throw new ContractValidationError();
    const annotations = array(v.annotations ?? [], 10000).map((value) => {
      const a = importObject(
        value,
        ["external_id", "file_external_id", "kind"],
        ["quote", "note", "color", "page_index", "coordinate_space", "rects"],
      );
      if (
        !["highlight", "underline", "region", "note", "text", "ink"].includes(
          String(a.kind),
        ) ||
        (a.quote !== undefined && typeof a.quote !== "string") ||
        (a.note !== undefined && typeof a.note !== "string") ||
        (a.coordinate_space !== undefined &&
          !["pdf-bottom-left", "normalized-top-left"].includes(
            String(a.coordinate_space),
          ))
      )
        throw new ContractValidationError();
      const rects = array(a.rects ?? [], 128).map((rect) => {
        const v = array(rect, 4);
        if (
          v.length !== 4 ||
          v.some((n) => typeof n !== "number" || !Number.isFinite(n))
        )
          throw new ContractValidationError();
        return v as [number, number, number, number];
      });
      return {
        external_id: importString(a.external_id),
        file_external_id: importString(a.file_external_id),
        kind: a.kind as ImportAnnotation["kind"],
        quote: (a.quote ?? "") as string,
        note: (a.note ?? "") as string,
        color:
          a.color === null || a.color === undefined
            ? null
            : importString(a.color, 64),
        page_index:
          a.page_index === null || a.page_index === undefined
            ? null
            : importInteger(a.page_index),
        coordinate_space: (a.coordinate_space ??
          "pdf-bottom-left") as ImportAnnotation["coordinate_space"],
        rects,
      };
    });
    return {
      external_id: importString(v.external_id),
      metadata: parseLiteratureMetadata(v.metadata),
      source_type:
        v.source_type === null || v.source_type === undefined
          ? null
          : importString(v.source_type, 128),
      groups: array(v.groups ?? [], 1000).map((v) => importString(v)),
      user_tags: array(v.user_tags ?? [], 1000).map((v) =>
        importString(v, 4096),
      ),
      files,
      annotations,
    };
  });
  return { records, groups, excluded };
}
