import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  Skeleton,
} from "../../components/index.js";
import { archiveQuery, rows } from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { record } from "../../data/wire.js";
import { navigate } from "../../data/url.js";
import { processorName, errorMessage, localTime } from "../../strings.js";
export function PaperResults({
  id,
  onOpenSummary,
}: {
  id: string;
  onOpenSummary: () => void;
}) {
  const api = useApi();
  const list = useInfiniteQuery({
    queryKey: ["processors", "paper-results", id],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      archiveQuery(
        api,
        "literature-results",
        { literature_id: id, offset: pageParam, limit: 30 },
        signal,
      ).then((v) => record(v, "paper results")),
    getNextPageParam: (p) =>
      typeof p.next_offset === "number" ? p.next_offset : undefined,
  });
  return (
    <section aria-label="文献参与的全部结果" className="paper-results">
      <h2>结果</h2>
      {list.isPending ? <Skeleton /> : null}
      {list.error ? <ErrorNotice message={errorMessage(list.error)} /> : null}
      {list.data && rows(list.data.pages[0]).length ? (
        <ul className="paper-result-list">
          {list.data.pages
            .flatMap((p) => rows(p))
            .sort(
              (a, b) =>
                Number(b.processor_id === "summary") -
                Number(a.processor_id === "summary"),
            )
            .map((r) => (
              <li key={String(r.result_id)} className="paper-result">
                <div>
                  <h3>
                    {processorName(String(r.processor_id))}
                    {r.freshness === "stale" ? (
                      <Badge status="running">已过时</Badge>
                    ) : null}
                  </h3>
                  <p>
                    {localTime(r.created_at)} ·{" "}
                    {Number(r.complete) ? "完整" : "部分完成"} ·{" "}
                    {Number(r.literature_count) > 1
                      ? `${r.literature_count} 篇共同参与`
                      : "单篇"}
                  </p>
                </div>
                {r.processor_id === "summary" ? (
                  <Button onPress={onOpenSummary}>阅读总结</Button>
                ) : null}
                <Button
                  variant="text"
                  onPress={() =>
                    navigate(
                      {
                        view: "ext",
                        literature: null,
                        result: String(r.result_id),
                        resultHash: String(r.content_sha256),
                        focusLiterature: id,
                        results: "all",
                      },
                      { clearSource: true },
                    )
                  }
                >
                  结果详情
                </Button>
              </li>
            ))}
        </ul>
      ) : null}
      {list.data && !rows(list.data.pages[0]).length ? (
        <EmptyState
          title="这篇文献还没有算子结果"
          description="总结、提取、标注和综合完成后会出现在这里。"
        />
      ) : null}
      {list.hasNextPage ? (
        <Button
          isPending={list.isFetchingNextPage}
          onPress={() => list.fetchNextPage().then(() => {})}
        >
          继续查看结果
        </Button>
      ) : null}
    </section>
  );
}
