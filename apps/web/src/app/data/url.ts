import { useMemo, useSyncExternalStore } from "react";
import {
  parseLibrarySearchRequest,
  parseLiteratureId,
  type LibraryQuery,
  type LibrarySort,
} from "@sciretriever/contracts";

export const sections = [
  "lib",
  "archive",
  "tags",
  "snapshots",
  "disc",
  "ins",
  "ask",
  "syn",
  "ext",
  "task",
  "web",
  "set",
  "lab",
  "gallery",
] as const;
export type Section = (typeof sections)[number];
export type ReaderMode = "pdf" | "doc" | "know";
const eventName = "sciretriever:react-navigation";
export const sourceParameterKeys = [
  "source",
  "document",
  "task",
  "from",
  "asset",
  "assetHash",
  "representation",
  "start",
  "end",
  "metadataHash",
  "metadataRevision",
  "result",
  "resultHash",
  "record",
  "returnReader",
  "collection",
  "page",
  "region",
] as const;
export interface UrlState {
  section: Section;
  literature: string | null;
  reader: ReaderMode;
  query: LibraryQuery;
  sort: LibrarySort;
  parameters: URLSearchParams;
  error: string | null;
  warning?: string | null;
}
export function parseUrl(search: string): UrlState {
  const parameters = new URLSearchParams(search);
  const view = parameters.get("view");
  const section = sections.find((item) => item === view) ?? "lib";
  const reader = parameters.get("reader");
  let error: string | null = null,
    warning: string | null = null;
  const fallback = parseLibrarySearchRequest({
    query: {},
    sort: "publication-year-desc",
    limit: 50,
    cursor: null,
  });
  let query = fallback.query,
    sort = fallback.sort,
    literature: string | null = null;
  try {
    const raw: unknown = JSON.parse(
      parameters.get("query") ?? '{"statuses":["READY"]}',
    );
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      for (const key of ["document_type", "document_types"]) {
        if (Object.hasOwn(raw, key)) {
          delete (raw as Record<string, unknown>)[key];
          warning = "旧的文献类型筛选已忽略，请使用出版形式和文章性质。";
        }
      }
    const request = parseLibrarySearchRequest({
      query: raw,
      sort: parameters.get("sort") ?? fallback.sort,
      limit: 50,
      cursor: null,
    });
    query = request.query;
    sort = request.sort;
    if (parameters.has("literature"))
      literature = parseLiteratureId(parameters.get("literature"));
    if (view && !sections.includes(view as Section))
      throw new Error("未知页面");
    if (reader && !["pdf", "doc", "know"].includes(reader))
      throw new Error("未知阅读视图");
  } catch {
    error = "链接中的筛选或材料标识无效。请返回文献库重新选择。";
  }
  return {
    section,
    warning,
    literature,
    reader: reader === "doc" || reader === "know" ? reader : "pdf",
    query,
    sort,
    parameters,
    error,
  };
}
type NavigationGuard = () => Promise<boolean>;
const guards = new Set<NavigationGuard>();
const listeners = new Set<() => void>();
const historyIndexKey = "sciretriever:react-history-index";
let committedUrl: string | null = null;
let committedIndex = 0;
let restoreUrl: string | null = null;
let navigationSequence = 0;
let checking: Promise<boolean> | null = null;
function historyIndex(state: unknown): number | null {
  if (!state || typeof state !== "object" || !(historyIndexKey in state))
    return null;
  const index = state[historyIndexKey];
  return typeof index === "number" && Number.isSafeInteger(index)
    ? index
    : null;
}
function publish(url: string, index: number) {
  committedUrl = url;
  committedIndex = index;
  for (const listener of listeners) listener();
}
function checkGuards(): Promise<boolean> {
  if (!checking)
    checking = (async () => {
      for (const guard of guards) if (!(await guard())) return false;
      return true;
    })().finally(() => {
      checking = null;
    });
  return checking;
}
function initializeNavigation() {
  if (committedUrl !== null) return;
  committedUrl = location.href;
  committedIndex = historyIndex(history.state) ?? 0;
  history.replaceState(
    { ...history.state, [historyIndexKey]: committedIndex },
    "",
  );
  window.addEventListener("popstate", () => {
    if (restoreUrl === location.href) {
      restoreUrl = null;
      return;
    }
    restoreUrl = null;
    const target = location.href,
      index = historyIndex(history.state);
    const sequence = ++navigationSequence;
    if (!guards.size) {
      publish(target, index ?? committedIndex);
      return;
    }
    void checkGuards().then((allowed) => {
      if (sequence !== navigationSequence) return;
      if (allowed) publish(target, index ?? committedIndex);
      else if (index !== null && index !== committedIndex) {
        restoreUrl = committedUrl;
        history.go(committedIndex - index);
      } else {
        // Unmanaged same-document entries have no delta. Preserve the active
        // resource and URL instead of exposing an unconfirmed route.
        history.replaceState(
          { ...history.state, [historyIndexKey]: committedIndex },
          "",
          committedUrl,
        );
      }
    });
  });
}
/** The active Browser viewer may require a confirmed release before navigation. */
export function registerNavigationGuard(guard: NavigationGuard): () => void {
  initializeNavigation();
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}
function subscribe(listener: () => void) {
  initializeNavigation();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function navigate(
  parameters: Record<string, string | null>,
  options: { replace?: boolean; clearSource?: boolean } = {},
) {
  initializeNavigation();
  const url = new URL(committedUrl ?? location.href);
  if (options.clearSource)
    for (const key of sourceParameterKeys) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(parameters)) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  const commit = () => {
    const index = committedIndex + (options.replace ? 0 : 1);
    if (options.replace)
      history.replaceState(
        { ...history.state, [historyIndexKey]: index },
        "",
        url,
      );
    else history.pushState({ [historyIndexKey]: index }, "", url);
    publish(url.href, index);
    window.dispatchEvent(new Event(eventName));
  };
  const sequence = ++navigationSequence;
  if (!guards.size) commit();
  else
    void checkGuards().then((allowed) => {
      if (allowed && sequence === navigationSequence) commit();
    });
}
export function useUrlState(): UrlState {
  const search = useSyncExternalStore(
    subscribe,
    () => new URL(committedUrl ?? location.href).search,
  );
  return useMemo(() => parseUrl(search), [search]);
}
