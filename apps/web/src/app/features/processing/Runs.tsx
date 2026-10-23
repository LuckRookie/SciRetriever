import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  SearchField,
  Select,
  Skeleton,
} from "../../components/index.js";
import { archiveQuery, rows } from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { record } from "../../data/wire.js";
import { navigate } from "../../data/url.js";
import {
  archiveStrings,
  errorMessage,
  localTime,
  processorName,
} from "../../strings.js";
export function Runs() {
  const api = useApi(),
    [processor, setProcessor] = useState(""),
    [snapshot, setSnapshot] = useState(""),
    [literature, setLiterature] = useState(""),
    [stale, setStale] = useState("all");
  const registry = useQuery({
    queryKey: ["processors", "registry"],
    queryFn: ({ signal }) =>
      api.processors("list", {}, signal).then((v) => v.result),
  });
  const snapshots = useQuery({
    queryKey: ["snapshots", "run-filter"],
    queryFn: ({ signal }) =>
      archiveQuery(
        api,
        "snapshots",
        { operation: "list", request: { after: null, limit: 100 } },
        signal,
      ),
  });
  const list = useInfiniteQuery({
    queryKey: ["processors", "runs", processor, snapshot, literature, stale],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      archiveQuery(
        api,
        "processor-runs",
        {
          limit: 30,
          offset: pageParam,
          ...(processor ? { processor_id: processor } : {}),
          ...(snapshot ? { snapshot_id: snapshot } : {}),
          ...(literature ? { literature_query: literature } : {}),
          ...(stale !== "all" ? { stale: stale === "stale" } : {}),
        },
        signal,
      ).then((v) => record(v, "runs")),
    getNextPageParam: (p) =>
      typeof p.next_offset === "number" ? p.next_offset : undefined,
  });
  return (
    <section aria-label="算子运行记录">
      <h2>运行记录</h2>
      <div className="result-toolbar">
        <Select
          label="按算子筛选"
          value={processor}
          onChange={setProcessor}
          options={[
            { value: "", label: "全部算子" },
            ...(Array.isArray(registry.data)
              ? registry.data.map((v) => {
                  const p = record(v, "processor");
                  return {
                    value: String(p.id),
                    label: processorName(String(p.id)),
                  };
                })
              : []),
          ]}
        />
        <Select
          label="按快照筛选"
          value={snapshot}
          onChange={setSnapshot}
          options={[
            { value: "", label: "全部输入" },
            ...(snapshots.data
              ? rows(snapshots.data).map((s) => ({
                  value: String(s.snapshot_id),
                  label:
                    typeof s.name === "string" && s.name
                      ? s.name
                      : `${Number(s.member_count)} 篇 · ${localTime(s.created_at)}`,
                }))
              : []),
          ]}
        />
        <Select
          label="结果版本"
          value={stale}
          onChange={setStale}
          options={[
            { value: "all", label: "全部版本" },
            { value: "current", label: "当前版本" },
            { value: "stale", label: "已过时" },
          ]}
        />
        <SearchField
          label="按来源文献筛选"
          value={literature}
          onChange={setLiterature}
          placeholder="文献标题或标识"
        />
      </div>
      {list.isPending ? <Skeleton /> : null}
      {list.error ? <ErrorNotice message={errorMessage(list.error)} /> : null}
      {list.data?.pages
        .flatMap((p) => rows(p))
        .map((run) => (
          <Card
            key={String(run.collection_id)}
            title={`${processorName(String(run.processor_id))} · ${String(run.name)}`}
          >
            <p>
              {localTime(run.created_at)} ·{" "}
              {String(run.actor_label ?? "历史记录未保存发起身份")} ·{" "}
              {run.stale ? "已过时" : "当前版本"}
            </p>
            <p>
              {rows(run, "sources")
                .slice(0, 5)
                .map((s, i) =>
                  s.kind === "snapshot" ? (
                    <Button
                      key={i}
                      variant="text"
                      onPress={() =>
                        navigate(
                          {
                            view: "snapshots",
                            snapshot: String(s.snapshot_id),
                            literature: null,
                          },
                          { clearSource: true },
                        )
                      }
                    >
                      固定快照
                    </Button>
                  ) : (
                    <span key={i}>
                      {String(s.title ?? "指定文献")}
                      {i < 4 ? " · " : ""}
                    </span>
                  ),
                )}
              {Number(run.source_count) > 5
                ? `共 ${run.source_count} 个输入`
                : ""}
            </p>
            {run.outcomes ? (
              <p>
                {Object.entries(archiveStrings.outcomes)
                  .map(
                    ([key, label]) =>
                      `${label} ${Number(record(run.outcomes, "outcomes")[key])} 篇`,
                  )
                  .join(" · ")}
              </p>
            ) : (
              <p>历史结果未保存分类计数</p>
            )}
            {Number(run.failed_targets) > 0 ? (
              <p>未形成结果 {Number(run.failed_targets)} 项</p>
            ) : null}
            <div className="form-actions">
              <Button
                onPress={() =>
                  navigate(
                    {
                      view: "ext",
                      collection: String(run.collection_id),
                      result: null,
                      resultHash: null,
                    },
                    { clearSource: true },
                  )
                }
              >
                查看结果表
              </Button>
              <Button
                onPress={() =>
                  navigate(
                    {
                      view: "task",
                      task: String(run.run_id),
                      literature: null,
                    },
                    { clearSource: true },
                  )
                }
              >
                查看运行过程
              </Button>
            </div>
          </Card>
        ))}
      {list.data && !rows(list.data.pages[0]).length ? (
        <EmptyState
          title="没有匹配的运行记录"
          description="已发布的单份或外部结果也可以从结果检索中查看。"
        />
      ) : null}
      {list.hasNextPage ? (
        <Button
          isPending={list.isFetchingNextPage}
          onPress={() => list.fetchNextPage().then(() => {})}
        >
          更早的运行记录
        </Button>
      ) : null}
    </section>
  );
}
