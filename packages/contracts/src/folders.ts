import {
  ContractValidationError,
  parseAssetId,
  parseLiteratureId,
  parseUtcTimestamp,
  parseLiteratureBibliographySummary,
  type LiteratureBibliographySummary,
} from "./index.js";
import { tagRecord, tagInteger } from "./tags.js";

export interface FolderNode {
  readonly folder_id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly position: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly own_count: number;
  readonly total_count: number;
}
export type FolderOperation =
  | { operation: "list"; request: Record<string, never> }
  | { operation: "export"; request: FolderExportRequest }
  | { operation: "delete-preview"; request: { folder_id: string } }
  | {
      operation: "create";
      request: {
        parent_id: string | null;
        name: string;
        position: number | null;
      };
    }
  | { operation: "rename"; request: { folder_id: string; name: string } }
  | {
      operation: "move";
      request: {
        folder_id: string;
        parent_id: string | null;
        position: number;
      };
    }
  | { operation: "delete"; request: { folder_id: string } }
  | {
      operation: "add" | "remove";
      request: { folder_id: string; literature_ids: readonly string[] };
    };
export interface FolderImpact {
  readonly folder_count: number;
  readonly descendant_count: number;
  readonly literature_count: number;
  readonly membership_count: number;
}
function fail(): never {
  throw new ContractValidationError();
}
function name(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 128 ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    fail();
  return value.trim().normalize("NFC");
}
export function parseFolderOperation(value: unknown): FolderOperation {
  const e = tagRecord(value, ["operation", "request"]),
    op = e.operation;
  if (op === "list")
    return {
      operation: op,
      request: tagRecord(e.request, []) as Record<string, never>,
    };
  if (op === "export")
    return { operation: op, request: parseFolderExportRequest(e.request) };
  if (op === "delete" || op === "delete-preview") {
    const r = tagRecord(e.request, ["folder_id"]);
    return { operation: op, request: { folder_id: parseAssetId(r.folder_id) } };
  }
  if (op === "rename") {
    const r = tagRecord(e.request, ["folder_id", "name"]);
    return {
      operation: op,
      request: { folder_id: parseAssetId(r.folder_id), name: name(r.name) },
    };
  }
  if (op === "create") {
    if (!e.request || typeof e.request !== "object" || Array.isArray(e.request))
      fail();
    const r = tagRecord({ parent_id: null, position: null, ...e.request }, [
      "name",
      "parent_id",
      "position",
    ]);
    return {
      operation: op,
      request: {
        name: name(r.name),
        parent_id: r.parent_id == null ? null : parseAssetId(r.parent_id),
        position: r.position == null ? null : tagInteger(r.position),
      },
    };
  }
  if (op === "move") {
    const r = tagRecord(e.request, ["folder_id", "parent_id", "position"]);
    return {
      operation: op,
      request: {
        folder_id: parseAssetId(r.folder_id),
        parent_id: r.parent_id === null ? null : parseAssetId(r.parent_id),
        position: tagInteger(r.position),
      },
    };
  }
  if (op === "add" || op === "remove") {
    const r = tagRecord(e.request, ["folder_id", "literature_ids"]);
    if (
      !Array.isArray(r.literature_ids) ||
      !r.literature_ids.length ||
      r.literature_ids.length > 1000
    )
      fail();
    return {
      operation: op,
      request: {
        folder_id: parseAssetId(r.folder_id),
        literature_ids: [...new Set(r.literature_ids.map(parseLiteratureId))],
      },
    };
  }
  return fail();
}
export function parseFolderNode(value: unknown): FolderNode {
  const r = tagRecord(value, [
    "folder_id",
    "parent_id",
    "name",
    "position",
    "created_at",
    "updated_at",
    "own_count",
    "total_count",
  ]);
  const own_count = tagInteger(r.own_count),
    total_count = tagInteger(r.total_count);
  if (total_count < own_count) fail();
  return {
    folder_id: parseAssetId(r.folder_id),
    parent_id: r.parent_id === null ? null : parseAssetId(r.parent_id),
    name: name(r.name),
    position: tagInteger(r.position),
    created_at: parseUtcTimestamp(r.created_at),
    updated_at: parseUtcTimestamp(r.updated_at),
    own_count,
    total_count,
  };
}
export function parseFolderImpact(value: unknown): FolderImpact {
  const r = tagRecord(value, [
    "folder_count",
    "descendant_count",
    "literature_count",
    "membership_count",
  ]);
  const out = {
    folder_count: tagInteger(r.folder_count, 1),
    descendant_count: tagInteger(r.descendant_count),
    literature_count: tagInteger(r.literature_count),
    membership_count: tagInteger(r.membership_count),
  };
  if (
    out.folder_count !== out.descendant_count + 1 ||
    out.membership_count < out.literature_count
  )
    fail();
  return out;
}
export function parseReadingOpen(value: unknown) {
  const r = tagRecord(value, ["literature_id"]);
  return { literature_id: parseLiteratureId(r.literature_id) };
}

export const FOLDERS_EXPORT_FORMAT = "sciretriever-folders";
export interface FolderExportRequest {
  readonly cursor: string | null;
  readonly limit: number;
}
export interface FolderExportNode {
  readonly folder_id: string;
  readonly name: string;
  readonly parent_id: string | null;
  readonly position: number;
}
export interface FolderExportMember extends LiteratureBibliographySummary {
  readonly folder_id: string;
}
export interface FolderExportPage {
  readonly format: typeof FOLDERS_EXPORT_FORMAT;
  readonly version: 1;
  readonly exported_at: string;
  readonly folders: readonly FolderExportNode[] | null;
  readonly members: readonly FolderExportMember[];
  readonly next_cursor: string | null;
}
export interface FoldersExportFile {
  readonly format: typeof FOLDERS_EXPORT_FORMAT;
  readonly version: 1;
  readonly exported_at: string;
  readonly folders: readonly (FolderExportNode & {
    readonly members: readonly LiteratureBibliographySummary[];
  })[];
}
function cursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.length || value.length > 8192) fail();
  return value;
}
export function parseFolderExportRequest(value: unknown): FolderExportRequest {
  const r = tagRecord(value, ["cursor", "limit"]),
    limit = tagInteger(r.limit, 1);
  if (limit > 1000) fail();
  return { cursor: cursor(r.cursor), limit };
}
export function parseFolderExportNode(value: unknown): FolderExportNode {
  const r = tagRecord(value, ["folder_id", "name", "parent_id", "position"]);
  return {
    folder_id: parseAssetId(r.folder_id),
    name: name(r.name),
    parent_id: r.parent_id === null ? null : parseAssetId(r.parent_id),
    position: tagInteger(r.position),
  };
}
export function parseFolderExportMember(value: unknown): FolderExportMember {
  const r = tagRecord(value, [
    "folder_id",
    "literature_id",
    "identifiers",
    "title",
    "year",
  ]);
  const { folder_id, ...summary } = r;
  const parsed = parseLiteratureBibliographySummary(summary);
  if (
    parsed.identifiers.some(
      (id) => !["doi", "arxiv", "pmid", "pmcid"].includes(id.namespace),
    )
  )
    fail();
  return { folder_id: parseAssetId(folder_id), ...parsed };
}
function header(
  r: Record<string, unknown>,
): Pick<FolderExportPage, "format" | "version" | "exported_at"> {
  if (r.format !== FOLDERS_EXPORT_FORMAT || r.version !== 1) fail();
  return {
    format: FOLDERS_EXPORT_FORMAT,
    version: 1 as const,
    exported_at: parseUtcTimestamp(r.exported_at),
  };
}
export function parseFolderExportPage(value: unknown): FolderExportPage {
  const r = tagRecord(value, [
    "format",
    "version",
    "exported_at",
    "folders",
    "members",
    "next_cursor",
  ]);
  if (
    (r.folders !== null && !Array.isArray(r.folders)) ||
    !Array.isArray(r.members) ||
    r.members.length > 1000
  )
    fail();
  return {
    ...header(r),
    folders:
      r.folders === null
        ? null
        : (r.folders as unknown[]).map(parseFolderExportNode),
    members: r.members.map(parseFolderExportMember),
    next_cursor: cursor(r.next_cursor),
  };
}
export function parseFoldersExportFile(value: unknown): FoldersExportFile {
  const r = tagRecord(value, ["format", "version", "exported_at", "folders"]);
  if (!Array.isArray(r.folders)) fail();
  const folders = r.folders.map((value) => {
    const row = tagRecord(value, [
      "folder_id",
      "name",
      "parent_id",
      "position",
      "members",
    ]);
    const { members, ...node } = row;
    if (!Array.isArray(members)) fail();
    const folder = parseFolderExportNode(node);
    return {
      ...folder,
      members: members.map((member) => {
        const item = tagRecord(member, [
          "literature_id",
          "identifiers",
          "title",
          "year",
        ]);
        const { folder_id: _, ...summary } = parseFolderExportMember({
          folder_id: folder.folder_id,
          ...item,
        });
        void _;
        return summary;
      }),
    };
  });
  const parents = new Map(
    folders.map((folder) => [folder.folder_id, folder.parent_id]),
  );
  if (parents.size !== folders.length) fail();
  for (const folder of folders) {
    const seen = new Set<string>();
    let id: string | null = folder.folder_id;
    while (id !== null) {
      if (seen.has(id) || !parents.has(id)) fail();
      seen.add(id);
      id = parents.get(id)!;
    }
  }
  return { ...header(r), folders };
}
