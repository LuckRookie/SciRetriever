import { useQuery } from "@tanstack/react-query";
import { archiveQuery, archiveWrite } from "./archive.js";
import type { ApiClient } from "./api.js";
import { useApi } from "./query.js";
import { record } from "./wire.js";

/** The service takes at most this many papers in one request. */
const REQUEST_LIMIT = 1000;

/**
 * Moves papers to 最近删除, or brings them back. Nothing is erased: the
 * bibliography, files, full text and marks stay, hidden from every read.
 * Returns how many papers changed state.
 */
export async function trashLiteratures(
  api: ApiClient,
  operation: "delete" | "restore",
  ids: readonly string[],
): Promise<number> {
  let changed = 0;
  for (let start = 0; start < ids.length; start += REQUEST_LIMIT) {
    const result = record(
      await archiveWrite(api, "library-trash", {
        operation,
        selector: {
          kind: "literatures",
          literature_ids: ids.slice(start, start + REQUEST_LIMIT),
        },
      }),
      "library trash result",
    );
    if (!Number.isSafeInteger(result.changed))
      throw new Error(
        operation === "delete" ? "删除的回执无效" : "恢复的回执无效",
      );
    changed += Number(result.changed);
  }
  return changed;
}
export interface TrashedLiterature {
  literature_id: string;
  title: string | null;
  year: number | null;
  deleted_at: string;
}
/** One page of 最近删除, the last deleted first. */
export async function listTrash(
  api: ApiClient,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<{ items: TrashedLiterature[]; next_cursor: string | null }> {
  const page = record(
    await archiveQuery(
      api,
      "library-trash",
      { operation: "list", request: { limit: 50, cursor } },
      signal,
    ),
    "library trash page",
  );
  if (
    !Array.isArray(page.items) ||
    (page.next_cursor !== null && typeof page.next_cursor !== "string")
  )
    throw new Error("最近删除的回执无效");
  return {
    items: page.items.map((value) => {
      const item = record(value, "library trash item"),
        literature = record(item.literature, "library trash literature");
      if (
        typeof literature.literature_id !== "string" ||
        typeof item.deleted_at !== "string"
      )
        throw new Error("最近删除的回执无效");
      return {
        literature_id: literature.literature_id,
        title: typeof literature.title === "string" ? literature.title : null,
        year: typeof literature.year === "number" ? literature.year : null,
        deleted_at: item.deleted_at,
      };
    }),
    next_cursor: page.next_cursor,
  };
}
/**
 * How many papers wait in 最近删除: the sidebar shows its entry only when
 * there are some. Under the library query prefix, so a deletion or a
 * restoration refreshes it with the lists.
 */
export function useTrashCount() {
  const api = useApi();
  return useQuery({
    queryKey: ["library", "trash", "count"],
    queryFn: async ({ signal }) =>
      Number(
        record(
          await archiveQuery(
            api,
            "library-trash",
            { operation: "count", request: {} },
            signal,
          ),
          "library trash count",
        ).total_count ?? 0,
      ),
    enabled: api.kind === "workspace" && api.workspace.readiness === "ready",
    staleTime: 30000,
  });
}
