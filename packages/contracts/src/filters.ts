import {
  ContractValidationError,
  parseAssetId,
  parseLibrarySearchRequest,
  parseUtcTimestamp,
  type LibraryQuery,
  type LibrarySort,
} from "./index.js";
import { tagRecord } from "./tags.js";

export interface SavedFilter {
  readonly filter_id: string;
  readonly name: string;
  readonly query: LibraryQuery;
  readonly sort: LibrarySort;
  readonly missing_folder_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}
export type FilterOperation =
  | { operation: "list"; request: Record<string, never> }
  | { operation: "create"; request: FilterInput }
  | { operation: "rename"; request: { filter_id: string; name: string } }
  | {
      operation: "update";
      request: { filter_id: string; query: LibraryQuery; sort: LibrarySort };
    }
  | { operation: "delete"; request: { filter_id: string } }
  | { operation: "import"; request: { items: readonly unknown[] } };
export interface FilterInput {
  readonly name: string;
  readonly query: LibraryQuery;
  readonly sort: LibrarySort;
}
export interface FilterImportItem {
  readonly index: number;
  readonly status: "imported" | "renamed" | "skipped" | "invalid";
  readonly filter: SavedFilter | null;
  readonly reason: string | null;
}
export interface FilterImportResult {
  readonly items: readonly FilterImportItem[];
}
export function truncateFilterName(name: string, max = 128): string {
  const prefix = name.slice(0, max);
  const last = prefix.charCodeAt(prefix.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? prefix.slice(0, -1) : prefix;
}
export function parseFilterName(value: unknown, truncate = false): string {
  if (typeof value !== "string" || /[\p{Cc}\p{Cf}]/u.test(value))
    throw new ContractValidationError();
  let name = value.trim().normalize("NFC");
  if (truncate) name = truncateFilterName(name);
  if (!name || name.length > 128) throw new ContractValidationError();
  return name;
}
function condition(query: unknown, sort: unknown) {
  try {
    const parsed = parseLibrarySearchRequest({ query, sort });
    return { query: parsed.query, sort: parsed.sort };
  } catch (error) {
    if (!(error instanceof ContractValidationError)) throw error;
    throw new ContractValidationError(["filter-condition"]);
  }
}
export function parseFilterImportInput(value: unknown): FilterInput {
  const r = tagRecord(value, ["name", "query", "sort"]);
  return { name: parseFilterName(r.name, true), ...condition(r.query, r.sort) };
}
export function parseFilterOperation(value: unknown): FilterOperation {
  const e = tagRecord(value, ["operation", "request"]);
  const operation = e.operation;
  if (operation === "list")
    return {
      operation,
      request: tagRecord(e.request, []) as Record<string, never>,
    };
  if (operation === "import") {
    const r = tagRecord(e.request, ["items"]);
    if (!Array.isArray(r.items) || r.items.length < 1 || r.items.length > 200)
      throw new ContractValidationError();
    return { operation, request: { items: structuredClone(r.items) } };
  }
  if (operation === "delete") {
    const r = tagRecord(e.request, ["filter_id"]);
    return { operation, request: { filter_id: parseAssetId(r.filter_id) } };
  }
  if (operation === "rename") {
    const r = tagRecord(e.request, ["filter_id", "name"]);
    return {
      operation,
      request: {
        filter_id: parseAssetId(r.filter_id),
        name: parseFilterName(r.name),
      },
    };
  }
  if (operation === "create" || operation === "update") {
    const r = tagRecord(e.request, [
      operation === "create" ? "name" : "filter_id",
      "query",
      "sort",
    ]);
    return operation === "create"
      ? {
          operation,
          request: {
            name: parseFilterName(r.name),
            ...condition(r.query, r.sort),
          },
        }
      : {
          operation,
          request: {
            filter_id: parseAssetId(r.filter_id),
            ...condition(r.query, r.sort),
          },
        };
  }
  throw new ContractValidationError();
}
export function parseSavedFilter(value: unknown): SavedFilter {
  const r = tagRecord(value, [
    "filter_id",
    "name",
    "query",
    "sort",
    "missing_folder_id",
    "created_at",
    "updated_at",
  ]);
  return {
    filter_id: parseAssetId(r.filter_id),
    name: parseFilterName(r.name),
    ...condition(r.query, r.sort),
    missing_folder_id:
      r.missing_folder_id === null ? null : parseAssetId(r.missing_folder_id),
    created_at: parseUtcTimestamp(r.created_at),
    updated_at: parseUtcTimestamp(r.updated_at),
  };
}
