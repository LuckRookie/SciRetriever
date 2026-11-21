import {
  parseIndexRefreshStatus,
  type IndexRefreshStatus,
  type KnowledgeContextBundle,
} from "@sciretriever/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Button } from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { pacedInterval } from "../../data/polling.js";
import { maintain } from "../maintenance/transport.js";

/** Which index the shown results were read from. */
export type AnswerIndex = "current" | "stale" | "missing" | "corrupt";
const statusKey = ["retrieval", "index-status"] as const;
export const working = (status: IndexRefreshStatus) =>
  status.status === "scheduled" || status.status === "running";
/**
 * Mixed answers report the material index in gaps (`material-index-*`, or a
 * per-paper `index-stale`); `result-index-*` is the operator-result index
 * and is not what this line explains.
 */
export function answerIndex(bundle: KnowledgeContextBundle): AnswerIndex {
  const codes = [bundle.coverage, ...bundle.gaps.map((gap) => gap.code)].map(
    (code) => code.replace(/^material-/u, ""),
  );
  return codes.includes("index-corrupt")
    ? "corrupt"
    : codes.includes("index-unavailable")
      ? "missing"
      : codes.includes("index-stale")
        ? "stale"
        : "current";
}

/** Polls the index state while this page is open; React Query stops on unmount. */
export function useIndexStatus(answer: AnswerIndex | null) {
  const api = useApi();
  return useQuery({
    queryKey: statusKey,
    queryFn: async ({ signal }) =>
      parseIndexRefreshStatus(
        (await api.query("index-status", {}, signal)).result,
      ),
    refetchInterval: (query) => {
      const status = query.state.data;
      // An index that is catching up changes within seconds; a current one
      // only changes when something else publishes.
      return pacedInterval(
        query,
        (status && working(status)) || answer === "stale" ? 2000 : 30000,
      );
    },
    refetchOnWindowFocus: true,
  });
}
/** Queues a background rebuild and shows its accepted status at once. */
export function useRebuildIndex() {
  const api = useApi(),
    queries = useQueryClient();
  return async () => {
    queries.setQueryData(
      statusKey,
      parseIndexRefreshStatus(
        (
          await maintain(api, "rebuild-index", {
            kind: "rebuild",
            background: true,
          })
        ).result,
      ),
    );
  };
}
/** "X / Y 篇" for a running rebuild, or "" before the source count is known. */
export function rebuildProgress(status: IndexRefreshStatus) {
  return status.progress
    ? `已处理 ${status.progress.done.toLocaleString("zh-CN")} / ${status.progress.total.toLocaleString("zh-CN")} 篇`
    : "";
}
/**
 * Marks the index state an answer was read against: the server's last
 * finish time, compared as text so client clocks play no part.
 */
export function useIndexMark() {
  const queries = useQueryClient();
  return () => {
    const mark =
      queries.getQueryData<IndexRefreshStatus>(statusKey)?.finished_at ?? null;
    void queries.invalidateQueries({ queryKey: statusKey });
    return mark;
  };
}

/**
 * One line under the search box, shown only while the index is not current.
 * The result line above the results never explains the index.
 */
export function IndexLine({
  status,
  answer,
  mark,
  onSearchAgain,
}: {
  status: IndexRefreshStatus | undefined;
  /** Index of the shown results, null before the first search. */
  answer: AnswerIndex | null;
  /** `useIndexMark()` taken when the shown results arrived. */
  mark: string | null;
  onSearchAgain: () => void;
}) {
  const api = useApi(),
    queries = useQueryClient(),
    rebuild = useRebuildIndex();
  const canMaintain = !!api.workspace.capabilities.maintenance;
  // A finished update the shown results have not seen yet.
  const caughtUp = status?.status === "updated" && status.finished_at !== mark;
  // Older servers omit index_state; until the index catches up, the last
  // answer still tells missing and corrupt apart.
  const state =
    status?.index_state ??
    (caughtUp || answer === null || answer === "current" || answer === "stale"
      ? "ready"
      : answer);
  const accept = (value: unknown) => {
    queries.setQueryData(statusKey, parseIndexRefreshStatus(value));
  };
  let text: string | null = null,
    action: ReactNode = null,
    tone: "work" | "problem" | "done" = "work";
  if (status && working(status) && status.operation === "rebuild") {
    const done = rebuildProgress(status),
      progress = done && `，${done}`;
    text =
      state === "ready"
        ? `正在重建全文索引${progress}。期间照常可搜，完成后自动生效。`
        : `正在建立全文索引${progress}。可以离开本页，完成后自动生效。`;
  } else if (state === "missing") {
    tone = "problem";
    text = canMaintain
      ? "还没有全文索引，原文和元数据都搜不到。建立约需几分钟，可以离开本页。"
      : "还没有全文索引，原文和元数据都搜不到。";
    if (canMaintain)
      action = (
        <Button size="compact" onPress={rebuild}>
          建立索引
        </Button>
      );
  } else if (state === "corrupt") {
    tone = "problem";
    text = "全文索引已损坏，需要重建后才能检索。";
    if (canMaintain)
      action = (
        <Button
          size="compact"
          confirm={{
            title: "重建全文索引？",
            description:
              "将从已有材料重新建立全文索引，约需几分钟，可以离开本页。完成前原文和元数据都搜不到。",
            confirmLabel: "重建索引",
          }}
          onPress={rebuild}
        >
          重建索引
        </Button>
      );
  } else if (status && working(status)) {
    const pending = status.pending_literatures;
    text = pending
      ? `全文索引正在更新，还有 ${pending.toLocaleString("zh-CN")} 篇的最新内容暂时搜不到。`
      : "全文索引正在更新，最近变化的文献暂时搜不到最新内容。";
  } else if (status?.status === "failed") {
    tone = "problem";
    text =
      "全文索引上次更新没有完成，最近变化的文献暂时搜不到最新内容；其余内容照常可搜。";
    if (canMaintain)
      action = (
        <Button
          size="compact"
          onPress={async () =>
            accept(
              (await maintain(api, "index-refresh", { kind: "refresh" }))
                .result,
            )
          }
        >
          重试更新
        </Button>
      );
  } else if (answer === "stale" && !caughtUp) {
    // The server schedules the catch-up when it sees the gap; the next poll
    // shows it running.
    text = "全文索引正在更新，最近变化的文献暂时搜不到最新内容。";
  }
  // The index caught up after the shown results were read from an older one.
  if (!text && caughtUp && answer !== null && answer !== "current") {
    tone = "done";
    text = "全文索引已更新。";
    action = (
      <Button size="compact" onPress={onSearchAgain}>
        重新检索
      </Button>
    );
  }
  if (!text) return null;
  return (
    <p
      role="status"
      className="retrieval-index"
      data-tone={tone}
      data-testid="retrieval-index"
    >
      <span>{text}</span>
      {action}
    </p>
  );
}
