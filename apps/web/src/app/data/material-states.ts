import type {
  LibraryCounts,
  LibraryQuery,
  LiteratureSearchItem,
} from "@sciretriever/contracts";
import { statusLabels } from "../strings.js";

/**
 * The material categories of the library's quick filters and the insights'
 * “材料状态” (page specs “界面用词”): what a paper has in hand. They do not
 * overlap, so their counts add up to the total. “只有书目” and “没找到 PDF”
 * split the papers without a primary PDF by whether the automatic routes are
 * exhausted; the rest are the paper's status.
 */
export type MaterialState =
  | "READY"
  | "ASSET_READY"
  | "metadata"
  | "ARCHIVING"
  | "ARCHIVE_FAILED"
  | "unavailable"
  | "EXCLUDED";
export interface MaterialCategory {
  readonly id: MaterialState;
  readonly label: string;
  /** The status colour's state (rule 5). */
  readonly tone: string;
}
const category = (id: MaterialState, status: string): MaterialCategory => ({
  id,
  label: statusLabels[status]!,
  tone: status,
});
/** Shown as quick filters after “全部”. */
export const MAIN_MATERIAL_STATES: readonly MaterialCategory[] = [
  category("READY", "READY"),
  category("ASSET_READY", "ASSET_READY"),
  category("metadata", "UNREVIEWED"),
];
/** Kept in “更多状态”. */
export const MORE_MATERIAL_STATES: readonly MaterialCategory[] = [
  category("ARCHIVING", "ARCHIVING"),
  category("ARCHIVE_FAILED", "ARCHIVE_FAILED"),
  category("unavailable", "UNAVAILABLE"),
  category("EXCLUDED", "EXCLUDED"),
];
export const MATERIAL_STATES = [
  ...MAIN_MATERIAL_STATES,
  ...MORE_MATERIAL_STATES,
];

/** How many papers of the counted scope fall in one category. */
export function materialCount(
  counts: LibraryCounts,
  state: MaterialState,
): number {
  // Past 10,000 hits each category is counted on its own, up to 10,000.
  if (counts.material_counts) return counts.material_counts[state].count;
  switch (state) {
    case "metadata":
      return counts.statuses.UNREVIEWED - counts.unavailable_pdf;
    case "unavailable":
      return counts.unavailable_pdf;
    default:
      return counts.statuses[state];
  }
}
/**
 * Whether one category's number stopped at the 10,000 limit. Past the limit
 * every category says so for itself: one with twelve papers is twelve.
 */
export function materialCountTruncated(
  counts: LibraryCounts,
  state: MaterialState,
): boolean {
  return counts.material_counts
    ? counts.material_counts[state].truncated === true
    : counts.count_truncated === true;
}
/** The category one paper is in. */
export function itemMaterialState(item: LiteratureSearchItem): MaterialState {
  const status = item.literature.status;
  if (status === "UNREVIEWED")
    return item.needs_manual_pdf ? "unavailable" : "metadata";
  return status;
}
/** The query with one category selected, or none (“全部”); other conditions stay. */
export function materialQuery(
  query: LibraryQuery,
  state: MaterialState | "",
): LibraryQuery {
  return {
    ...query,
    statuses:
      state === "metadata"
        ? ["UNREVIEWED"]
        : state === "" || state === "unavailable"
          ? []
          : [state],
    needs_manual_pdf:
      state === "unavailable" ? true : state === "metadata" ? false : null,
    has_primary_pdf: null,
  };
}
/** The category a query selects; "" for none. */
export function queryMaterialState(query: LibraryQuery): MaterialState | "" {
  if (query.needs_manual_pdf === true) return "unavailable";
  if (
    query.statuses.length === 1 &&
    query.statuses[0] === "UNREVIEWED" &&
    query.needs_manual_pdf === false
  )
    return "metadata";
  if (query.statuses.length === 1 && query.statuses[0] !== "UNREVIEWED")
    return query.statuses[0]!;
  return "";
}
/**
 * The scope the category counts describe: the query without its category,
 * so every category has its number and switching between them changes none.
 * The library's quick filters and the insights read the same counts.
 */
export function materialCountScope(query: LibraryQuery): LibraryQuery {
  return {
    ...query,
    statuses: [],
    needs_manual_pdf: null,
    has_primary_pdf: null,
  };
}
