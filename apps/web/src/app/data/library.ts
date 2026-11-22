import {
  LIBRARY_COUNT_LIMIT,
  parseLibraryExactCount,
  parseLibrarySearchRequest,
  parseLibraryCounts,
  parseLiteratureSearchItem,
  parseLiteratureDetail,
  type CollectLiteraturesResult,
  type LibraryPageSort,
  type LibraryQuery,
  type LibrarySort,
  type LiteratureSearchItem,
} from "@sciretriever/contracts";
import { record } from "./wire.js";
import { titleParts, titleText, type TitlePart } from "../../reading/title.js";
import type { ApiClient } from "./api.js";
import { archiveWrite } from "./archive.js";
export const emptyQuery = () => parseLibrarySearchRequest({ query: {} }).query;
export const SORT_LABELS: Record<LibraryPageSort, string> = {
  "collected-desc": "最近收进来",
  "intake-desc": "最近入库",
  "opened-desc": "最近阅读",
  "publication-year-desc": "年份：新到旧",
  "publication-year-asc": "年份：旧到新",
  "title-asc": "标题：A–Z",
  "title-desc": "标题：Z–A",
  relevance: "相关度",
  "draft-differences-desc": "与 PDF 自带文字的差异：多到少",
  "image-only-pages-desc": "扫描页：多到少",
  "citing-results-desc": "被结果引用：多到少",
  "unfound-citations-desc": "找不到的引用：多到少",
};
/**
 * Sorts offered in the library menu (page specs “文献库”). The two sorts by
 * what processing found in drafts stay out while it does not read drafts:
 * they are 0 for every paper until then.
 */
export const LIBRARY_MENU_SORTS: readonly LibraryPageSort[] = [
  "collected-desc",
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
  sort: LibraryPageSort,
  cursor: string | null,
  signal?: AbortSignal,
  limit = 50,
) {
  const request = parseLibrarySearchRequest(
    { query, sort, cursor, limit },
    { collectedSort: true },
  );
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
  const total = Number(page.total_count);
  return {
    items: page.items.map(parseLiteratureSearchItem),
    total,
    /** Counted only to 10,000 (technical 06 2.1.2). */
    truncated: page.count_truncated === true,
    /** Ranked by relevance, only the first 1,000 can be paged to. */
    relevanceLimit:
      typeof page.relevance_limit === "number" ? page.relevance_limit : null,
    statusUpdating: page.status_updating === true,
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
/** The first author, “等” for the rest: a table column or a one-line citation. */
export function paperFirstAuthor(item: LiteratureSearchItem): string {
  const authors = item.literature.metadata.authors;
  if (authors.length <= 1) return paperAuthors(item);
  return `${paperAuthors({
    ...item,
    literature: {
      ...item.literature,
      metadata: { ...item.literature.metadata, authors: authors.slice(0, 1) },
    },
  })} 等`;
}
/** Citation expansion takes at most this many seeds (page specs “入库”). */
export const CITATION_SEED_LIMIT = 1000;
/** A paper as a person recognizes it: title · first author · year. */
export interface LiteratureChoice {
  id: string;
  title: TitlePart[];
  author: string;
  year: number | null;
}
export function literatureChoice(item: LiteratureSearchItem): LiteratureChoice {
  return {
    id: item.literature.literature_id,
    title: paperTitleParts(item),
    author: paperFirstAuthor(item),
    year: item.literature.metadata.publication_year ?? null,
  };
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
  scope: LibraryQuery,
  sort: LibraryPageSort,
  signal?: AbortSignal,
) {
  const query = pageQuery(scope);
  const items = new Map<string, LiteratureSearchItem>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    signal?.throwIfAborted();
    const page = await searchLibrary(api, query, sort, cursor, signal);
    if (page.total > 1000 || page.truncated)
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
  sort: LibraryPageSort,
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

/**
 * A library number in words (page specs “超过一万篇”): a count limited to
 * 10,000 is “1 万篇以上” with its unit, “1 万+” without one; every other
 * number as it is. Every library count on a page goes through here.
 */
export function libraryCount(
  value: number,
  truncated: boolean,
  unit?: "篇",
): string {
  if (truncated) return unit ? `1 万${unit}以上` : "1 万+";
  return unit ? `${value.toLocaleString()} ${unit}` : value.toLocaleString();
}
/** Beyond 10,000 papers only the sorts with an index remain (technical 06 2.1.2). */
export const overCountLimit = (total: number, truncated: boolean) =>
  truncated || total > LIBRARY_COUNT_LIMIT;

/**
 * What the library page shows (page specs “文献库”): search results when
 * there are search words; otherwise a working set — a folder, the recently
 * read, an intake batch — or, with none of them, the collected papers.
 */
export type LibraryView =
  | "collected"
  | "folder"
  | "recent"
  | "batch"
  | "search";
export function libraryView(query: LibraryQuery): LibraryView {
  if (query.text) return "search";
  if (query.folder) return "folder";
  if (query.recently_opened) return "recent";
  if (query.intake_batch_ids.length || query.discovery_run_ids.length)
    return "batch";
  return "collected";
}
/**
 * The query the page reads. The people's interface has no list of the whole
 * library: without search words or a working set, the page is the collected
 * papers, and says so to the service, so filters narrow them too.
 */
export function pageQuery(query: LibraryQuery): LibraryQuery {
  return libraryView(query) === "collected"
    ? { ...query, collection_scope: "collected" }
    : query;
}
/**
 * The default sort of each view, which is also the one sort left beyond
 * 10,000 papers (page specs “超过一万篇”).
 */
export function viewSort(query: LibraryQuery): LibraryPageSort {
  switch (libraryView(query)) {
    case "search":
      return "relevance";
    case "recent":
      return "opened-desc";
    case "collected":
      return "collected-desc";
    default:
      return "intake-desc";
  }
}
/**
 * Saved filters and PDF scopes take the library sorts without “最近收进来”
 * (contracts `LibrarySort`); they use “最近入库” and their dialogs name it.
 */
export const storedSort = (sort: LibraryPageSort): LibrarySort =>
  sort === "collected-desc" ? "intake-desc" : sort;

/** Registers papers as collected (user organization 7); never undone. */
export async function collectLiteratures(
  api: ApiClient,
  ids: readonly string[],
): Promise<CollectLiteraturesResult> {
  const result = record(
    await archiveWrite(api, "library-collect", {
      selector: { kind: "literatures", literature_ids: ids },
    }),
    "collect result",
  );
  if (
    !Number.isSafeInteger(result.target_count) ||
    !Number.isSafeInteger(result.newly_collected)
  )
    throw new Error("收进来的回执无效");
  return {
    target_count: Number(result.target_count),
    newly_collected: Number(result.newly_collected),
  };
}
/** The exact number of matches, counted in the background (technical 06 2.1.8). */
export async function exactSearchTotal(
  api: ApiClient,
  query: LibraryQuery,
  signal?: AbortSignal,
) {
  const value = parseLibraryExactCount(
    (
      await api.query(
        "library-exact-count",
        { kind: "search-total", query },
        signal,
      )
    ).result,
  );
  if (value.kind !== "search-total") throw new Error("准确数回执无效");
  return { total: value.total_count, at: value.snapshot_at };
}
