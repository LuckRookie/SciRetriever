import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  Select,
  Skeleton,
  SuggestField,
  Switch,
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
    [stale, setStale] = useState(false);
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
  const needle = literature.trim().toLowerCase();
  /** Snapshots offered while typing; the chosen one stays listed so its name shows. */
  const snapshotOptions = (snapshots.data ? rows(snapshots.data) : [])
    .map((s) => ({
      value: String(s.snapshot_id),
      label:
        typeof s.name === "string" && s.name
          ? s.name
          : `${Number(s.member_count)} 篇 · ${localTime(s.created_at)}`,
      description: `快照 · ${Number(s.member_count)} 篇`,
    }))
    .filter(
      (option) =>
        option.value === snapshot ||
        !needle ||
        option.label.toLowerCase().includes(needle),
    )
    .sort((a, b) => Number(b.value === snapshot) - Number(a.value === snapshot))
    .slice(0, 8);
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
          ...(stale ? { stale: true } : {}),
        },
        signal,
      ).then((v) => record(v, "runs")),
    getNextPageParam: (p) =>
      typeof p.next_offset === "number" ? p.next_offset : undefined,
  });
  return (
    <section aria-label="算子运行记录" className="run-records">
      <div className="result-toolbar run-toolbar">
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
        <SuggestField
          label="按来源筛选"
          text={literature}
          onTextChange={setLiterature}
          selected={snapshot}
          onSelect={setSnapshot}
          suggestions={snapshotOptions}
          placeholder="来源文献，或选择快照"
        />
        <Switch isSelected={stale} onChange={setStale}>
          只看过时
        </Switch>
      </div>
      {list.isPending ? <Skeleton /> : null}
      {list.error ? <ErrorNotice message={errorMessage(list.error)} /> : null}
      {list.data && rows(list.data.pages[0]).length ? (
        <ul className="run-list">
          {list.data.pages
            .flatMap((p) => rows(p))
            .map((run) => (
              <RunRow key={String(run.collection_id)} run={run} />
            ))}
        </ul>
      ) : null}
      {list.data && !rows(list.data.pages[0]).length ? (
        <EmptyState title="没有匹配的运行记录。" />
      ) : null}
      {list.hasNextPage ? (
        <Button
          variant="text"
          isPending={list.isFetchingNextPage}
          onPress={() => list.fetchNextPage().then(() => {})}
        >
          更早的运行记录
        </Button>
      ) : null}
    </section>
  );
}
/** One run: what ran on which inputs, when, by whom, and how each paper came out. */
function RunRow({ run }: { run: Record<string, unknown> }) {
  const sources = rows(run, "sources"),
    count = Number(run.source_count) || sources.length,
    first = sources[0];
  const outcomes = run.outcomes ? record(run.outcomes, "outcomes") : null;
  return (
    <li className="run-row">
      <div className="run-row-main">
        <h3>
          {processorName(String(run.processor_id))}
          <span className="run-spec">{String(run.name)}</span>
          {run.stale ? <Badge status="stale" /> : null}
        </h3>
        <p className="run-meta">
          {first?.kind === "snapshot" ? (
            <Button
              variant="text"
              size="compact"
              onPress={() =>
                navigate(
                  {
                    view: "snapshots",
                    snapshot: String(first.snapshot_id),
                    literature: null,
                  },
                  { clearSource: true },
                )
              }
            >
              固定快照
            </Button>
          ) : first ? (
            <span className="run-source">
              {String(first.title ?? "指定文献")}
            </span>
          ) : null}
          {count > 1 ? <span>等 {count} 个输入</span> : null}
          <span>{localTime(run.created_at)}</span>
          <span>{String(run.actor_label ?? "未记录发起方")}</span>
        </p>
        <p className="run-outcomes">
          {outcomes ? (
            Object.entries(archiveStrings.outcomes).map(([key, label]) => (
              <span key={key}>
                {label} <b>{Number(outcomes[key]).toLocaleString()}</b>
              </span>
            ))
          ) : (
            <span>历史结果未保存分类计数</span>
          )}
          {Number(run.failed_targets) > 0 ? (
            <span data-failed>
              未形成结果 <b>{Number(run.failed_targets)}</b>
            </span>
          ) : null}
        </p>
      </div>
      <div className="run-actions">
        <Button
          variant="text"
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
          查看结果
        </Button>
        <Button
          variant="text"
          onPress={() =>
            navigate(
              { view: "task", task: String(run.run_id), literature: null },
              { clearSource: true },
            )
          }
        >
          运行过程
        </Button>
      </div>
    </li>
  );
}
