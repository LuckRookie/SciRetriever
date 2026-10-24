import {
  parseLibrarySearchRequest,
  parseLibraryCounts,
  parseLiteratureSearchItem,
  parseLiteratureDetail,
  type LibraryQuery,
  type LibrarySort,
  type LiteratureSearchItem,
} from "@sciretriever/contracts";
import { record } from "./wire.js";
import type { ApiClient } from "./api.js";
export const emptyQuery = () => parseLibrarySearchRequest({ query: {} }).query;
export async function searchLibrary(
  api: ApiClient,
  query: LibraryQuery,
  sort: LibrarySort,
  cursor: string | null,
  signal?: AbortSignal,
  limit = 50,
) {
  const request = parseLibrarySearchRequest({ query, sort, cursor, limit });
  const value = api.workspace.capabilities.query
    ? await api.query("search", request, signal)
    : await api.request("/api/library/search", request, signal);
  const page = record(value.page, "library page");
  if (
    !Array.isArray(page.items) ||
    !Number.isSafeInteger(page.total_count) ||
    Number(page.total_count) < 0 ||
    (page.next_cursor !== null && typeof page.next_cursor !== "string")
  )
    throw new Error("文献列表回执无效");
  return {
    items: page.items.map(parseLiteratureSearchItem),
    total: Number(page.total_count),
    backfillPending: Number(page.tag_backfill_pending ?? 0),
    cursor: page.next_cursor as string | null,
  };
}
export async function readLiterature(
  api: ApiClient,
  id: string,
  signal?: AbortSignal,
) {
  const value = api.workspace.capabilities.query
    ? await api.query("read", { literature_id: id }, signal)
    : await api.request("/api/library/detail", { literature_id: id }, signal);
  const detail = await parseLiteratureDetail(value.detail);
  if (detail.literature.literature_id !== id)
    throw new Error("文献响应与选择不一致");
  return detail;
}
export function paperTitle(item: LiteratureSearchItem): string {
  const decoder = document.createElement("textarea");
  const title = item.literature.metadata.title?.replace(
    /&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/giu,
    (entity) => {
      decoder.innerHTML = entity;
      return decoder.value;
    },
  );
  return (
    title?.replace(/<\/?(?:i|b|em|strong|sub|sup)\s*>/giu, "") || "未命名文献"
  );
}
export function paperAuthors(item: LiteratureSearchItem): string {
  return (
    item.literature.metadata.authors
      .map(
        (author) =>
          author.display_name ||
          [author.given_name, author.family_name].filter(Boolean).join(" "),
      )
      .join(", ") || "作者未提供"
  );
}
export async function scopeIds(
  api: ApiClient,
  query: LibraryQuery,
  sort: LibrarySort,
  signal?: AbortSignal,
) {
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    signal?.throwIfAborted();
    const page = await searchLibrary(api, query, sort, cursor, signal);
    if (page.total > 1000)
      throw new Error("当前范围超过 1,000 篇，请先筛选或选择。");
    for (const item of page.items) ids.add(item.literature.literature_id);
    cursor = page.cursor;
    if (cursor) {
      if (cursors.has(cursor))
        throw new Error("文献续读游标重复，请重新查询。");
      cursors.add(cursor);
    }
  } while (cursor);
  return [...ids];
}

export async function readLibraryCounts(
  api: ApiClient,
  query: LibraryQuery,
  signal?: AbortSignal,
) {
  return parseLibraryCounts(
    (await api.query("library-counts", { query }, signal)).result,
  );
}
