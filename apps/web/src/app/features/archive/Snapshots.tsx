import { useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Button,
  Disclosure,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Select,
  Skeleton,
  TextArea,
} from "../../components/index.js";
import { archiveQuery, rows, useArchiveAction } from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { record } from "../../data/wire.js";
import { navigate, useUrlState } from "../../data/url.js";
import { useShell } from "../../shell/context.js";
import { randomId } from "../../../browser-platform.js";
import { errorMessage, archiveStrings } from "../../strings.js";
import "./archive.css";
const name = (s: Record<string, unknown>) =>
  `${new Date(String(s.created_at)).toLocaleString()} · ${s.member_count} 篇`;
export default function Snapshots() {
  const api = useApi(),
    shell = useShell(),
    route = useUrlState(),
    queries = useQueryClient(),
    action = useArchiveAction();
  const [selected, setSelected] = useState(
      route.parameters.get("snapshot") ?? "",
    ),
    [other, setOther] = useState(""),
    [operator, setOperator] = useState(
      route.section === "syn" ? "knowledge-synthesis" : "summary",
    ),
    [question, setQuestion] = useState(""),
    [policy, setPolicy] = useState("require-all"),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState(""),
    [difference, setDifference] = useState<Record<string, unknown> | null>(
      null,
    );
  const snapshots = useInfiniteQuery({
    queryKey: ["snapshots", "list"],
    initialPageParam: null as string | null,
    queryFn: async ({ signal, pageParam }) =>
      record(
        await archiveQuery(
          api,
          "snapshots",
          { operation: "list", request: { after: pageParam, limit: 50 } },
          signal,
        ),
        "snapshots",
      ),
    getNextPageParam: (p) =>
      typeof p.next_after === "string" ? p.next_after : undefined,
  });
  const items = snapshots.data?.pages.flatMap((p) => rows(p)) ?? [];
  const members = useInfiniteQuery({
    queryKey: ["snapshots", "read", selected],
    enabled: !!selected,
    initialPageParam: 0,
    queryFn: async ({ signal, pageParam }) =>
      record(
        await archiveQuery(
          api,
          "snapshots",
          {
            operation: "read",
            request: {
              snapshot_id: selected,
              offset: pageParam,
              limit: 50,
              max_bytes: 262144,
            },
          },
          signal,
        ),
        "snapshot",
      ),
    getNextPageParam: (p) =>
      typeof p.next_offset === "number" ? p.next_offset : undefined,
  });
  const definition = members.data?.pages[0];
  const registry = useQuery({
    queryKey: ["processors", "registry"],
    queryFn: async ({ signal }) =>
      (await api.processors("list", {}, signal)).result,
  });
  const chosen = Array.isArray(registry.data)
    ? registry.data
        .map((v) => record(v, "processor"))
        .find((p) => p.id === operator)
    : undefined;
  const run = async () => {
    setBusy(true);
    setFailure("");
    try {
      if (operator === "labels" || operator === "records") {
        navigate({
          view: "ext",
          literature: null,
          snapshot: selected,
          processor: operator,
        });
        return;
      }
      await api.submitProcessor(
        {
          schema_version: 1,
          idempotency_key: randomId(),
          name: operator === "summary" ? "快照文献总结" : "快照综合",
          processor: { id: operator, version: "2" },
          spec: operator === "summary" ? {} : { question, policy },
          inputs: [{ kind: "snapshot", snapshot_id: selected }],
        },
        true,
      );
      void queries.invalidateQueries({ queryKey: ["tasks"] });
      navigate({ view: "task", literature: null });
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="feature-page archive-page">
      <PageHeader
        title={archiveStrings.snapshot}
        description="固定一组就绪文献及其内容版本，独立比较和加工。创建快照不会运行模型。"
      />
      {failure || action.error || snapshots.error ? (
        <ErrorNotice
          message={failure || errorMessage(action.error ?? snapshots.error)}
        />
      ) : null}
      <div className="archive-toolbar">
        <Button
          isPending={action.isPending}
          onPress={() =>
            action.mutate(
              {
                name: "snapshots",
                request: shell.selected.size
                  ? { kind: "literatures", literature_ids: [...shell.selected] }
                  : { kind: "query", query: route.query },
              },
              {
                onSuccess: (v) =>
                  setSelected(String(record(v, "snapshot").snapshot_id)),
              },
            )
          }
        >
          {archiveStrings.createSnapshot}
        </Button>
      </div>
      {action.data ? (
        <p role="status">
          已固定 {Number(record(action.data, "snapshot").member_count)}{" "}
          篇；未就绪而排除{" "}
          {Number(record(action.data, "snapshot").excluded_count)} 篇。
        </p>
      ) : null}
      {snapshots.isPending ? (
        <Skeleton label="正在读取快照" />
      ) : !items.length ? (
        <EmptyState
          title="还没有快照"
          description="在文献库应用筛选后生成快照，也可以使用上方按钮。"
        />
      ) : null}
      <Select
        label="当前快照"
        value={selected}
        onChange={(v) => {
          setSelected(v);
          setDifference(null);
        }}
        options={[
          { value: "", label: "选择快照" },
          ...items.map((s) => ({
            value: String(s.snapshot_id),
            label: name(s),
          })),
        ]}
      />
      {snapshots.hasNextPage ? (
        <Button onPress={() => snapshots.fetchNextPage().then(() => {})}>
          加载更多快照
        </Button>
      ) : null}
      {selected ? (
        <div className="archive-split">
          <section>
            <h2>成员与版本</h2>
            {members.error ? (
              <ErrorNotice message={errorMessage(members.error)} />
            ) : null}
            {definition ? (
              <p>
                {Number(definition.member_count)} 篇就绪文献；创建时排除{" "}
                {Number(definition.excluded_count)}{" "}
                篇。快照中的版本不会随库更新。
              </p>
            ) : null}
            <ul>
              {members.data?.pages
                .flatMap((p) => rows(p, "members"))
                .map((m) => (
                  <li key={String(m.literature_id)}>
                    <Button
                      variant="text"
                      onPress={() => shell.openPaper(String(m.literature_id))}
                    >
                      {String(
                        record(m.metadata, "metadata").title ?? "无标题文献",
                      )}
                    </Button>
                  </li>
                ))}
            </ul>
            {members.hasNextPage ? (
              <Button onPress={() => members.fetchNextPage().then(() => {})}>
                加载更多成员
              </Button>
            ) : null}
            <Select
              label="对比快照"
              value={other}
              onChange={setOther}
              options={[
                { value: "", label: "选择另一个快照" },
                ...items
                  .filter((s) => s.snapshot_id !== selected)
                  .map((s) => ({
                    value: String(s.snapshot_id),
                    label: name(s),
                  })),
              ]}
            />
            <Button
              isDisabled={!other || busy}
              onPress={async () => {
                setBusy(true);
                setFailure("");
                try {
                  setDifference(
                    record(
                      await archiveQuery(api, "snapshots", {
                        operation: "diff",
                        request: { before: selected, after: other },
                      }),
                      "difference",
                    ),
                  );
                } catch (e) {
                  setFailure(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              比较快照
            </Button>
            {difference
              ? Object.entries({
                  added: "新增",
                  removed: "移除",
                  content_changed: "内容变化",
                  description_changed: "描述变化",
                }).map(([key, label]) => (
                  <Disclosure
                    key={key}
                    title={`${label} · ${Array.isArray(difference[key]) ? difference[key].length : 0}`}
                  >
                    <ul>
                      {(Array.isArray(difference[key])
                        ? difference[key]
                        : []
                      ).map((id: string) => (
                        <li key={id}>
                          <Button
                            variant="text"
                            onPress={() => shell.openPaper(id)}
                          >
                            打开对应文献
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </Disclosure>
                ))
              : null}
          </section>
          <section>
            <h2>运行算子</h2>
            <Select
              label="算子"
              value={operator}
              onChange={setOperator}
              options={[
                { value: "summary", label: "全文总结" },
                { value: "labels", label: "问答标注" },
                { value: "records", label: "记录提取" },
                { value: "knowledge-synthesis", label: "多篇综合" },
              ]}
            />
            <p>
              读取：正文 · 全部章节
              {operator === "labels" || operator === "records"
                ? "（下一步可调整）"
                : ""}
            </p>
            {chosen?.map ? (
              <p>
                逐篇步骤：
                {String(
                  record(record(chosen.map, "map").processor, "processor").id,
                )}
                ；已有结果会复用。
              </p>
            ) : null}
            {operator === "knowledge-synthesis" ? (
              <>
                <TextArea
                  label="综合问题"
                  value={question}
                  onChange={setQuestion}
                />
                <Select
                  label="覆盖要求"
                  value={policy}
                  onChange={setPolicy}
                  options={[
                    { value: "require-all", label: "全部成员完整后综合" },
                    { value: "allow-partial", label: "带缺口综合" },
                  ]}
                />
              </>
            ) : null}
            <Button
              isPending={busy}
              isDisabled={
                operator === "knowledge-synthesis" && !question.trim()
              }
              onPress={() => void run()}
            >
              {operator === "labels" || operator === "records"
                ? "填写提取规范"
                : "确认启动"}
            </Button>
            <Button
              variant="text"
              onPress={() =>
                action.mutate(
                  { name: "snapshots", request: definition?.definition },
                  {
                    onSuccess: (v) => {
                      setOther(String(record(v, "snapshot").snapshot_id));
                    },
                  },
                )
              }
              isDisabled={!definition || action.isPending}
            >
              按原条件生成新快照
            </Button>
          </section>
        </div>
      ) : null}
    </div>
  );
}
