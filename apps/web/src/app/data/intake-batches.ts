import {
  parseAcquirePdfCounts,
  parseIntakeBatch,
  parseIntakeBatchSummaryPage,
  parseLibraryFacets,
  type AcquirePdfSelector,
  type IntakeBatch,
  type LibraryQuery,
} from "@sciretriever/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { ApiClient } from "./api.js";
import { archiveWrite } from "./archive.js";
import { useApi } from "./query.js";
import { pacedInterval } from "./polling.js";

const OPEN_STATES = new Set<IntakeBatch["state"]>([
  "collecting",
  "awaiting-confirmation",
  "running",
]);
// Batches live under the library key: any material change refreshes their PDF counts.
const batchKey = ["library", "intake-batches"] as const;

export async function listIntakeBatches(
  api: ApiClient,
  limit: number,
  cursor: string | null,
  signal?: AbortSignal,
) {
  // The list's rows without the two counts only a batch's own page shows
  // (full text, what can be parsed): those read every member of a batch.
  const value = await api.query(
    "intake-batches",
    { operation: "list-summary", request: { limit, cursor } },
    signal,
  );
  return parseIntakeBatchSummaryPage(value.result);
}
export async function readIntakeBatch(
  api: ApiClient,
  batchId: string,
  signal?: AbortSignal,
) {
  const value = await api.query(
    "intake-batches",
    { operation: "get", request: { batch_id: batchId } },
    signal,
  );
  return parseIntakeBatch(value.result);
}
export async function renameIntakeBatch(
  api: ApiClient,
  batchId: string,
  label: string | null,
) {
  return parseIntakeBatch(
    await archiveWrite(api, "intake-batch-rename", {
      batch_id: batchId,
      label,
    }),
  );
}
export async function readLibraryFacets(
  api: ApiClient,
  query: LibraryQuery,
  limit: number,
  signal?: AbortSignal,
  windowCursor: string | null = null,
) {
  const value = await api.query(
    "library-facets",
    { query, limit, ...(windowCursor ? { window_cursor: windowCursor } : {}) },
    signal,
  );
  return parseLibraryFacets(value.result);
}
export async function previewAcquisition(
  api: ApiClient,
  selector: AcquirePdfSelector,
  signal?: AbortSignal,
) {
  const value = await api.query("acquire-pdf-preview", { selector }, signal);
  return parseAcquirePdfCounts(value.result);
}

/**
 * Every batch, newest first, a page at a time; refreshed every 3 s while one
 * is collecting, awaiting confirmation or running, or a submission is open.
 */
export function useIntakeBatches(submitting = false) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: [...batchKey, "all"],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      listIntakeBatches(api, 20, pageParam, signal),
    getNextPageParam: (page) => page.next_cursor,
    refetchInterval: (query) =>
      pacedInterval(
        query,
        submitting ||
          query.state.data?.pages.some((page) =>
            page.items.some((batch) => OPEN_STATES.has(batch.state)),
          )
          ? 3000
          : false,
      ),
  });
}
/** One batch by id, for titles and filter chips. */
export function useIntakeBatch(batchId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: [...batchKey, "one", batchId],
    queryFn: ({ signal }) => readIntakeBatch(api, batchId!, signal),
    enabled: batchId !== null,
    staleTime: 60_000,
  });
}
