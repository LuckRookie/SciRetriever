import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Menu, SearchField } from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { navigate } from "../../data/url.js";
import { emptyQuery, libraryCount } from "../../data/library.js";
import { listIntakeBatches } from "../../data/intake-batches.js";
import { listSnapshots } from "../../data/snapshots.js";
import { useIssueCount } from "../../data/archive.js";
import {
  folderPaths,
  openBatch,
  openFolder,
  openRecent,
  useFolders,
} from "./Folders.js";
import type { LibraryCounts } from "@sciretriever/contracts";

/** Searching from the band covers the whole library (page specs “搜索结果”). */
export function searchWholeLibrary(text: string) {
  const words = text.trim();
  if (!words) return;
  navigate(
    {
      view: "lib",
      literature: null,
      query: JSON.stringify({ ...emptyQuery(), text: words }),
      sort: null,
    },
    { clearSource: true },
  );
}

/** Snapshots have no total of their own; they are few, so they are counted. */
async function snapshotCount(
  api: ReturnType<typeof useApi>,
  signal: AbortSignal,
) {
  let total = 0,
    after: string | null = null;
  do {
    const page = await listSnapshots(api, after, 200, signal);
    total += page.items.length;
    after = page.next_after;
  } while (after);
  return total;
}

/**
 * The band above the collected papers (page specs “全库带”): searching the
 * whole library, its totals from the write-time counters, and the other
 * working sets. It scrolls away with the content.
 */
export function LibraryBand({ counts }: { counts: LibraryCounts | undefined }) {
  const api = useApi();
  const [text, setText] = useState("");
  const folders = useFolders();
  const issues = useIssueCount();
  const snapshots = useQuery({
    queryKey: ["snapshots", "count"],
    queryFn: ({ signal }) => snapshotCount(api, signal),
    enabled: api.kind === "workspace",
  });
  // The tasks that brought papers in: the newest topic searches and
  // citation expansions with members.
  const outputs = useQuery({
    queryKey: ["library", "intake-batches", "outputs"],
    queryFn: async ({ signal }) =>
      (await listIntakeBatches(api, 50, null, signal)).items
        .filter(
          (batch) =>
            (batch.kind === "topic" || batch.kind === "citation") &&
            batch.counts.hits > 0,
        )
        .slice(0, 5),
    enabled: api.kind === "workspace",
  });
  const collection = counts?.collection_counts;
  const paths = folderPaths(folders.data?.items ?? []);
  const recent = counts?.recently_opened ?? 0,
    issueCount = issues.data ?? 0,
    snapshotTotal = snapshots.data ?? 0;
  return (
    <section className="library-band" aria-label="整个文献库">
      <SearchField
        label="搜索整个文献库"
        placeholder="搜索整个文献库"
        value={text}
        onChange={setText}
        onSubmit={searchWholeLibrary}
      />
      {counts && collection ? (
        <p className="library-band-totals">
          全库 {libraryCount(counts.total, false, "篇")}：收进来的{" "}
          {libraryCount(collection.collected, false, "篇")}，只被发现的{" "}
          {libraryCount(collection.discovered_only, false, "篇")}
          （来自引用扩展与主题搜索）
          {counts.counts_backfill_pending ? "（正在补算）" : ""}
        </p>
      ) : null}
      <nav className="library-band-sets" aria-label="其他工作集">
        {recent > 0 ? (
          <Button variant="text" onPress={openRecent}>
            最近读过 · {libraryCount(recent, false)}
          </Button>
        ) : null}
        {paths.length > 0 ? (
          <Menu
            label={`文件夹 · ${libraryCount(paths.length, false)}`}
            variant="text"
            indicator
            items={paths.map((path) => ({
              id: path.id,
              label: path.label,
              onAction: () => openFolder(path.id),
            }))}
          />
        ) : null}
        {snapshotTotal > 0 ? (
          <Button
            variant="text"
            onPress={() =>
              navigate(
                { view: "snapshots", literature: null },
                { clearSource: true },
              )
            }
          >
            快照 · {libraryCount(snapshotTotal, false)}
          </Button>
        ) : null}
        {outputs.data?.length ? (
          <Menu
            label="任务的产出"
            variant="text"
            indicator
            items={[
              ...outputs.data.map((batch) => ({
                id: batch.batch_id,
                label: batch.label,
                onAction: () => openBatch(batch.batch_id),
              })),
              {
                id: "tasks",
                label: "全部任务",
                divider: true,
                onAction: () =>
                  navigate(
                    { view: "task", literature: null },
                    { clearSource: true },
                  ),
              },
            ]}
          />
        ) : null}
        {issueCount > 0 ? (
          <Button
            variant="text"
            onPress={() =>
              navigate(
                { view: "archive", literature: null },
                { clearSource: true },
              )
            }
          >
            需处理 · {libraryCount(issueCount, false)}
          </Button>
        ) : null}
      </nav>
    </section>
  );
}
