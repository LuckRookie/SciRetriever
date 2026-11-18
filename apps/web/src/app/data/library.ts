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
import { titleParts, titleText, type TitlePart } from "../../reading/title.js";
import type { ApiClient } from "./api.js";
export const emptyQuery = () => parseLibrarySearchRequest({ query: {} }).query;
export const SORT_LABELS: Record<LibrarySort, string> = {
  "intake-desc": "最近入库",
  "opened-desc": "最近阅读",
  "publication-year-desc": "年份：新到旧",
  "publication-year-asc": "年份：旧到新",
  "title-asc": "标题：A–Z",
  "title-desc": "标题：Z–A",
  relevance: "相关性",
  "draft-differences-desc": "初稿差异：多到少",
  "image-only-pages-desc": "扫描页：多到少",
  "citing-results-desc": "被结果引用：多到少",
  "unfound-citations-desc": "找不到的引用：多到少",
};
/**
 * Sorts offered in the library menu (page specs “文献库”). The two sorts by
 * what processing found in drafts stay out while it does not read drafts:
 * they are 0 for every paper until then.
 */
export const LIBRARY_MENU_SORTS: readonly LibrarySort[] = [
  "intake-desc",
  "opened-desc",
  "publication-year-desc",
  "publication-year-asc",
  "title-asc",
  "title-desc",
  "relevance",
  "draft-differences-desc",
  "image-only-pages-desc",
];
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
/** Title with its inline sub/sup/italic markup, for visible headings and rows. */
export function paperTitleParts(item: LiteratureSearchItem): TitlePart[] {
  return metadataTitleParts(item.literature.metadata.title);
}
/** The same, from a stored metadata title where only the title is at hand. */
export function metadataTitleParts(title: unknown): TitlePart[] {
  const parts = titleParts(typeof title === "string" ? title : null);
  return parts.length ? parts : ["未命名文献"];
}
/** Plain title for labels, tabs and sorting. */
export function paperTitle(item: LiteratureSearchItem): string {
  return titleText(paperTitleParts(item));
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
/** One plain-text reference: authors. Title. Venue volume(issue), pages (year). DOI link. */
export function paperCitation(item: LiteratureSearchItem): string {
  const m = item.literature.metadata,
    doi = m.identifiers.find((i) => i.namespace === "doi")?.value,
    issue = m.issue ? `(${m.issue})` : "",
    source = [
      [m.venue, m.volume ? `${m.volume}${issue}` : issue]
        .filter(Boolean)
        .join(" "),
      m.pages,
    ]
      .filter(Boolean)
      .join(", ");
  return [
    `${paperAuthors(item)}.`,
    m.title ? `${paperTitle(item)}.` : "",
    `${source}${m.publication_year ? ` (${m.publication_year})` : ""}.`,
    doi ? `https://doi.org/${doi}` : "",
  ]
    .filter((part) => part && part !== ".")
    .join(" ");
}
/** Every item in the current scope, at most 1,000; used to select or act on all of it. */
export async function scopeItems(
  api: ApiClient,
  query: LibraryQuery,
  sort: LibrarySort,
  signal?: AbortSignal,
) {
  const items = new Map<string, LiteratureSearchItem>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    signal?.throwIfAborted();
    const page = await searchLibrary(api, query, sort, cursor, signal);
    if (page.total > 1000)
      throw new Error("当前范围超过 1,000 篇，请先筛选或选择。");
    for (const item of page.items)
      items.set(item.literature.literature_id, item);
    cursor = page.cursor;
    if (cursor) {
      if (cursors.has(cursor))
        throw new Error("文献续读游标重复，请重新查询。");
      cursors.add(cursor);
    }
  } while (cursor);
  return [...items.values()];
}
export async function scopeIds(
  api: ApiClient,
  query: LibraryQuery,
  sort: LibrarySort,
  signal?: AbortSignal,
) {
  return (await scopeItems(api, query, sort, signal)).map(
    (item) => item.literature.literature_id,
  );
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
