import type { LibraryQuery } from "@sciretriever/contracts";

export interface LibraryMemberPosition {
  readonly workset_at: string | null;
  readonly literature_id: string;
}

export function libraryWorksetTimeSort(query: LibraryQuery) {
  if (query.recently_opened) return "opened-desc";
  if (
    query.folder ||
    query.intake_batch_ids.length ||
    query.discovery_run_ids.length
  )
    return "intake-desc";
  if (query.collection_scope === "collected") return "collected-desc";
  return undefined;
}

export function compareLibraryMemberPositions(
  a: LibraryMemberPosition,
  b: LibraryMemberPosition,
) {
  if (a.workset_at !== b.workset_at) {
    if (a.workset_at === null) return 1;
    if (b.workset_at === null) return -1;
    return a.workset_at > b.workset_at ? -1 : 1;
  }
  return a.literature_id < b.literature_id
    ? -1
    : a.literature_id > b.literature_id
      ? 1
      : 0;
}
