import type { ReaderMode } from "../data/url.js";

/**
 * The reader's paper tabs (reading-experience 1.8.3): which tab is current
 * after a close, which a batch close leaves, the record of closed tabs and
 * the list kept in this browser tab's session storage. Pure, so the rules
 * can be checked without a browser (spec 8.1 “标签页”).
 */
export interface PaperTab {
  id: string;
  title: string;
  /** Unset until the reader has picked the view (spec 6.4). */
  mode: ReaderMode | undefined;
  source: Record<string, string>;
}
export type CloseKind = "one" | "others" | "right" | "all";
/** The tabs a close takes, counted from the tab it was asked on. */
export function tabsToClose(
  tabs: readonly PaperTab[],
  kind: CloseKind,
  on: string,
): string[] {
  const at = tabs.findIndex((tab) => tab.id === on);
  if (at < 0) return [];
  switch (kind) {
    case "one":
      return [on];
    case "others":
      return tabs.filter((tab) => tab.id !== on).map((tab) => tab.id);
    case "right":
      return tabs.slice(at + 1).map((tab) => tab.id);
    case "all":
      return tabs.map((tab) => tab.id);
  }
}
/** A batch close leaves tabs with unsaved edits open; closing one alone asks instead. */
export function keepUnsaved(
  kind: CloseKind,
  ids: readonly string[],
  unsaved: ReadonlySet<string>,
) {
  const kept = kind === "one" ? [] : ids.filter((id) => unsaved.has(id));
  return { closing: ids.filter((id) => !kept.includes(id)), kept };
}
/**
 * The tab current after `closing` go: the current one if it stays; else the
 * one last used; else the right neighbour, else the left; null when none is left.
 */
export function currentAfterClose(
  tabs: readonly PaperTab[],
  used: readonly string[],
  closing: ReadonlySet<string>,
  current: string | null,
): string | null {
  const left = tabs.filter((tab) => !closing.has(tab.id));
  if (!left.length) return null;
  if (current && !closing.has(current)) return current;
  for (let i = used.length - 1; i >= 0; i--)
    if (left.some((tab) => tab.id === used[i])) return used[i]!;
  const at = tabs.findIndex((tab) => tab.id === current);
  for (let i = at + 1; i < tabs.length; i++)
    if (!closing.has(tabs[i]!.id)) return tabs[i]!.id;
  for (let i = at - 1; i >= 0; i--)
    if (!closing.has(tabs[i]!.id)) return tabs[i]!.id;
  return left[0]!.id;
}
/** The order tabs were used in, most recent last, without repeats. */
export function usedOrder(used: readonly string[], id: string): string[] {
  return [...used.filter((value) => value !== id), id].slice(-50);
}
/** One close, as the record keeps it: each tab with its place in the row. */
export interface ClosedTabs {
  tabs: { tab: PaperTab; index: number }[];
  /** The tab that was current before the close. */
  current: string | null;
}
export const CLOSED_LIMIT = 10;
export function recordClose(
  records: readonly ClosedTabs[],
  record: ClosedTabs,
): ClosedTabs[] {
  return record.tabs.length
    ? [...records, record].slice(-CLOSED_LIMIT)
    : [...records];
}
/** The tabs of the last close back in their places; those open meanwhile stay. */
export function reopenTabs(
  tabs: readonly PaperTab[],
  record: ClosedTabs,
): PaperTab[] {
  const next = tabs.filter(
    (tab) => !record.tabs.some((closed) => closed.tab.id === tab.id),
  );
  for (const { tab, index } of [...record.tabs].sort(
    (a, b) => a.index - b.index,
  ))
    next.splice(Math.min(index, next.length), 0, tab);
  return next;
}
/** The tab `step` places on, round the row. */
export function cycleTab(
  tabs: readonly PaperTab[],
  current: string | null,
  step: 1 | -1,
): string | null {
  if (!tabs.length) return null;
  const at = tabs.findIndex((tab) => tab.id === current);
  return tabs[(Math.max(at, 0) + step + tabs.length) % tabs.length]!.id;
}

/** Papers whose proofread text has unsaved edits: a batch close leaves them open. */
export const unsavedPapers = new Set<string>();

const SESSION_KEY = "sciretriever:reader:tabs:v1";
/** Spec 1.8.3 “刷新之后”: the open tabs and their order, for this browser tab only. */
export function saveTabs(tabs: readonly PaperTab[], storage = sessionStore()) {
  try {
    storage?.setItem(SESSION_KEY, JSON.stringify(tabs));
  } catch {
    /* Session storage is optional. */
  }
}
export function loadTabs(storage = sessionStore()): PaperTab[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(SESSION_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const { id, title, mode, source } = item as Record<string, unknown>;
      if (typeof id !== "string" || !id || typeof title !== "string") return [];
      const parameters =
        source && typeof source === "object"
          ? Object.fromEntries(
              Object.entries(source).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === "string",
              ),
            )
          : {};
      return [
        {
          id,
          title,
          mode: typeof mode === "string" ? (mode as ReaderMode) : undefined,
          source: parameters,
        },
      ];
    });
  } catch {
    return [];
  }
}
function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}
