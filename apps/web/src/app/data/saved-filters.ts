import {
  parseSavedFilter,
  type FilterInput,
  type FilterImportItem,
  type SavedFilter,
} from "@sciretriever/contracts";
import type { ApiClient } from "./api.js";
import { archiveQuery, archiveWrite } from "./archive.js";
import { preferences } from "./preferences.js";
import { record } from "./wire.js";

/**
 * Saved filters (user organization 9.1): kept in the catalog, read and
 * written through the service, never in this browser. The types are the
 * contracts'; this module only calls and checks.
 */
export async function listFilters(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<SavedFilter[]> {
  const r = record(
    await archiveQuery(
      api,
      "filters",
      { operation: "list", request: {} },
      signal,
    ),
    "filters",
  );
  if (!Array.isArray(r.items)) throw new Error("筛选列表回执无效");
  return r.items.map(parseSavedFilter);
}
export async function createFilter(api: ApiClient, input: FilterInput) {
  return parseSavedFilter(
    await archiveWrite(api, "filters", {
      operation: "create",
      request: input,
    }),
  );
}
/** Replaces a filter's condition and order with these; its name stays. */
export async function updateFilter(
  api: ApiClient,
  filter_id: string,
  condition: { query: FilterInput["query"]; sort: FilterInput["sort"] },
) {
  const saved = parseSavedFilter(
    await archiveWrite(api, "filters", {
      operation: "update",
      request: { filter_id, ...condition },
    }),
  );
  if (saved.filter_id !== filter_id) throw new Error("更新筛选的回执无效");
  return saved;
}
export async function deleteFilter(api: ApiClient, filter_id: string) {
  const r = record(
    await archiveWrite(api, "filters", {
      operation: "delete",
      request: { filter_id },
    }),
    "filter delete",
  );
  if (r.filter_id !== filter_id) throw new Error("删除筛选的回执无效");
}
export async function importFilters(
  api: ApiClient,
  items: readonly unknown[],
): Promise<FilterImportItem[]> {
  const r = record(
    await archiveWrite(api, "filters", {
      operation: "import",
      request: { items },
    }),
    "filter import",
  );
  if (!Array.isArray(r.items)) throw new Error("导入筛选的回执无效");
  return r.items.map((value: unknown) => {
    const v = record(value, "filter import item");
    const status = v.status;
    if (
      !Number.isSafeInteger(v.index) ||
      (status !== "imported" &&
        status !== "renamed" &&
        status !== "skipped" &&
        status !== "invalid")
    )
      throw new Error("导入筛选的回执无效");
    return {
      index: Number(v.index),
      status,
      filter: v.filter === null ? null : parseSavedFilter(v.filter),
      reason: typeof v.reason === "string" ? v.reason : null,
    };
  });
}

/**
 * The filters this browser saved before they moved to the catalog (user
 * organization 9.1 “浏览器中已有筛选的导入”). Read item by item — one bad
 * item never empties the rest; the data stays, each item marked once sent.
 */
export interface BrowserFilter {
  /** Its place in the stored array. */
  index: number;
  name: string;
  /** What `import` receives: the name, condition and order, as stored. */
  item: unknown;
}
export const browserFiltersKey = (catalog: string | null) =>
  `sciretriever:library-views:v1:${catalog ?? "unbound"}`;
function storedArray(key: string): unknown[] {
  try {
    const value: unknown = JSON.parse(preferences.read(key) ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
/** The items not yet imported. */
export function browserFilters(catalog: string | null): BrowserFilter[] {
  return storedArray(browserFiltersKey(catalog)).flatMap((value, index) => {
    if (value && typeof value === "object" && "imported" in value) return [];
    const v = (value ?? {}) as Record<string, unknown>;
    const item =
      value && typeof value === "object"
        ? { name: v.name, query: v.query, sort: v.sort }
        : value;
    return [
      {
        index,
        name: typeof v.name === "string" ? v.name : `第 ${index + 1} 项`,
        item,
      },
    ];
  });
}
/** Marks the items sent as imported, with their result; nothing is removed. */
export function markBrowserFilters(
  catalog: string | null,
  results: readonly { index: number; status: string }[],
) {
  const key = browserFiltersKey(catalog);
  const values = storedArray(key);
  for (const { index, status } of results) {
    const value = values[index];
    values[index] =
      value && typeof value === "object"
        ? { ...value, imported: status }
        : { value, imported: status };
  }
  preferences.write(key, JSON.stringify(values));
}
