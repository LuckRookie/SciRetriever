import { UsageEstimate } from "../processing/UsageEstimate.js";
import { serviceMessage } from "../../strings.js";
import { Fragment, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { parseTag, parseTagListItem, type Tag } from "@sciretriever/contracts";
import {
  Button,
  Dialog,
  Disclosure,
  EmptyState,
  ErrorNotice,
  Icon,
  PageHeader,
  SearchField,
  Select,
  Skeleton,
  TextArea,
  TextField,
} from "../../components/index.js";
import { archiveQuery, rows, useArchiveAction } from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { record } from "../../data/wire.js";
import { processingTask } from "../../data/operations.js";
import { TagEditor } from "./TagEditor.js";
import { navigate, useUrlState } from "../../data/url.js";
import { useShell } from "../../shell/context.js";
import { errorMessage, archiveStrings, localTime } from "../../strings.js";
import { randomId } from "../../../browser-platform.js";
import "../archive/archive.css";
const tagName = (t: Tag) => t.name_zh || t.name_en;
export default function Tags() {
  const route = useUrlState();
  const api = useApi(),
    shell = useShell(),
    action = useArchiveAction();
  const [search, setSearch] = useState(""),
    [selected, setSelected] = useState(route.parameters.get("tag") ?? ""),
    [form, setForm] = useState(false),
    [consolidate, setConsolidate] = useState(false),
    [name, setName] = useState(""),
    [english, setEnglish] = useState(""),
    [definition, setDefinition] = useState(""),
    [excludes, setExcludes] = useState(""),
    [aliases, setAliases] = useState(""),
    [parent, setParent] = useState(""),
    [category, setCategory] = useState(""),
    [reason, setReason] = useState(""),
    [merge, setMerge] = useState(""),
    [preview, setPreview] = useState<Record<string, unknown> | null>(null),
    [undo, setUndo] = useState<Record<string, unknown> | null>(null),
    [failure, setFailure] = useState(""),
    [busy, setBusy] = useState(false);
  const query = useInfiniteQuery({
    queryKey: ["tags", "vocabulary", search],
    initialPageParam: 0,
    queryFn: async ({ signal, pageParam }) =>
      record(
        await archiveQuery(
          api,
          "tags",
          {
            operation: "list",
            request: {
              query: search,
              limit: 100,
              offset: pageParam,
              status: "active",
            },
          },
          signal,
        ),
        "tags",
      ),
    getNextPageParam: (p) =>
      typeof p.next_offset === "number" ? p.next_offset : undefined,
  });
  const vocabulary =
    query.data?.pages.flatMap((p) => rows(p).map(parseTagListItem)) ?? [];
  const uses = new Map(vocabulary.map((t) => [t.tag_id, t.uses] as const));
  const state = useQuery({
    queryKey: ["tags", "state"],
    queryFn: async ({ signal }) =>
      record(
        await archiveQuery(
          api,
          "tags",
          { operation: "state", request: {} },
          signal,
        ),
        "vocabulary state",
      ),
  });
  const detail = useQuery({
    queryKey: ["tags", "detail", selected],
    enabled: !!selected,
    queryFn: async ({ signal }) => {
      const r = record(
        await archiveQuery(
          api,
          "tags",
          { operation: "show", request: { tag_id: selected } },
          signal,
        ),
        "tag",
      );
      return {
        uses: Number(r.uses),
        uncovered_literatures: Number(r.uncovered_literatures),
        tag: parseTag(r.tag),
      };
    },
  });
  const changes = useInfiniteQuery({
    queryKey: ["tags", "changes"],
    initialPageParam: 0,
    queryFn: async ({ signal, pageParam }) => {
      const result = await archiveQuery(
        api,
        "tags",
        { operation: "changes", request: { since: pageParam, limit: 100 } },
        signal,
      );
      if (!Array.isArray(result)) throw new Error("词表日志无效");
      return result.map((v) => record(v, "change"));
    },
    getNextPageParam: (p) =>
      p.length === 100 ? Number(p.at(-1)!.version) : undefined,
  });
  const change = async (mutation: unknown, why = reason) => {
    if (!state.data) throw new Error("请先读取词表版本");
    await action.mutateAsync({
      name: "tags",
      request: {
        operation: "change",
        request: {
          mutation,
          expected_version: state.data.version,
          reason: why || "人工维护词表",
        },
      },
    });
  };
  const execute = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setFailure("");
    try {
      await work();
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const detailPanel = detail.error ? (
    <ErrorNotice message={errorMessage(detail.error)} />
  ) : detail.data ? (
    <>
      <h2>{tagName(detail.data.tag)}</h2>
      <p>{detail.data.tag.definition.includes}</p>
      {detail.data.tag.definition.excludes ? (
        <p>不包含：{detail.data.tag.definition.excludes}</p>
      ) : null}
      <p>同义词：{detail.data.tag.aliases.join("、") || "无"}</p>
      <p>
        {Number(detail.data.uses)} 篇使用 · 创建于词表第{" "}
        {detail.data.tag.created_vocab_version} 版
      </p>
      <p>{Number(detail.data.uncovered_literatures)} 篇尚未按此标签回溯</p>
      {detail.data.tag.examples.map((e) => (
        <Button
          key={e.literature_id}
          variant="text"
          onPress={() => shell.openPaper(e.literature_id)}
        >
          打开示例文献
        </Button>
      ))}
      <TagEditor
        key={`${selected}:${state.data?.version}`}
        tag={detail.data.tag}
        vocabulary={vocabulary}
        busy={busy || action.isPending}
        change={change}
      />
      <Disclosure title="合并到已有标签">
        <Select
          label="目标标签"
          value={merge}
          onChange={setMerge}
          options={[
            { value: "", label: "选择目标" },
            ...vocabulary
              .filter((t) => t.tag_id !== selected)
              .map((t) => ({ value: t.tag_id, label: tagName(t) })),
          ]}
        />
        <p>原标签会保留合并去向；人工锁定的赋值会受保护。</p>
        <Button
          isDisabled={!merge || busy}
          onPress={() =>
            void execute(() =>
              change({ op: "merge", tag_id: selected, into: merge }),
            )
          }
        >
          确认合并
        </Button>
      </Disclosure>
      <Button
        isPending={busy}
        onPress={() =>
          void execute(async () =>
            setPreview(
              record(
                await archiveQuery(api, "tags", {
                  operation: "backfill-preview",
                  request: { tag_ids: [selected] },
                }),
                "backfill preview",
              ),
            ),
          )
        }
      >
        预估回溯
      </Button>
      {preview ? (
        <>
          <UsageEstimate
            request={{
              kind: "tags",
              request: { operation: "backfill", tag_ids: [selected] },
            }}
          />
          <p role="status">
            候选 {Number(preview.candidate_count)} 篇，预计模型调用{" "}
            {Number(preview.estimated_calls)} 次。
          </p>
          <Button
            isPending={busy}
            onPress={() =>
              void execute(async () => {
                const id = await processingTask(
                  {
                    api,
                    signal: new AbortController().signal,
                    notify: shell.notify,
                    onTasksChanged: () => {},
                  },
                  [
                    {
                      operation: "backfill-tags",
                      request: { tag_ids: [selected] },
                    },
                  ],
                  randomId(),
                );
                navigate({ view: "task", literature: null, task: id });
              })
            }
          >
            确认并启动回溯
          </Button>
        </>
      ) : null}
    </>
  ) : (
    <Skeleton label="正在读取标签" />
  );
  return (
    <div className="feature-page archive-page">
      <PageHeader title={archiveStrings.vocabulary} />
      <div className="archive-toolbar vocabulary-toolbar">
        <SearchField
          label="搜索名称与同义词"
          placeholder="搜索名称与同义词"
          value={search}
          onChange={(v) => {
            setSearch(v);
            setSelected("");
          }}
        />
        <Button variant="text" onPress={() => setConsolidate(true)}>
          整理词表
        </Button>
        <Button
          icon={<Icon name="plus" />}
          onPress={() => {
            setName("");
            setEnglish("");
            setDefinition("");
            setExcludes("");
            setAliases("");
            setParent("");
            setCategory("");
            setReason("");
            setForm(true);
          }}
        >
          新建标签
        </Button>
      </div>
      {failure || action.error || query.error ? (
        <ErrorNotice
          message={failure || errorMessage(action.error ?? query.error)}
        />
      ) : null}
      <section aria-label="两层标签词表" className="vocabulary">
        {query.isPending ? (
          <Skeleton label="正在读取词表" />
        ) : !vocabulary.length ? (
          <EmptyState title="未找到标签。可更换关键词，或新建标签。" />
        ) : (
          <table className="ui-data-table vocabulary-table">
            <thead>
              <tr>
                <th scope="col">标签</th>
                <th scope="col">同义词</th>
                <th scope="col" data-numeric>
                  使用篇数
                </th>
              </tr>
            </thead>
            {[...new Set(vocabulary.map((t) => t.category ?? "未分类"))].map(
              (group) => (
                <tbody key={group}>
                  <tr className="vocabulary-group">
                    <th scope="rowgroup" colSpan={3}>
                      {group}
                    </th>
                  </tr>
                  {ordered(vocabulary, group).map(({ tag: t, depth }) => (
                    <Fragment key={t.tag_id}>
                      <tr
                        data-selected={selected === t.tag_id || undefined}
                        data-depth={depth}
                      >
                        <td>
                          <Button
                            variant="text"
                            aria-expanded={selected === t.tag_id}
                            onPress={() => {
                              setSelected(
                                selected === t.tag_id ? "" : t.tag_id,
                              );
                              setPreview(null);
                            }}
                          >
                            {tagName(t)}
                          </Button>
                        </td>
                        <td className="vocabulary-aliases">
                          {t.aliases.join("、") || "—"}
                        </td>
                        <td data-numeric>
                          {uses.get(t.tag_id)?.toLocaleString() ?? "—"}
                        </td>
                      </tr>
                      {selected === t.tag_id ? (
                        <tr className="vocabulary-detail">
                          <td colSpan={3}>
                            <section aria-label="标签详情">
                              {detailPanel}
                            </section>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              ),
            )}
          </table>
        )}
        {query.hasNextPage ? (
          <Button
            variant="text"
            onPress={() => query.fetchNextPage().then(() => {})}
          >
            加载更多标签
          </Button>
        ) : null}
      </section>
      <Disclosure title="词表变更日志">
        {changes.error ? (
          <ErrorNotice message={errorMessage(changes.error)} />
        ) : null}
        {changes.data?.pages
          .flatMap((p) => p)
          .map((c) => (
            <article
              aria-label={`词表变更 ${c.version}`}
              className="archive-field"
              key={String(c.version)}
            >
              <strong>
                第 {Number(c.version)} 版 ·{" "}
                {archiveStrings.tagOperations[
                  String(c.op) as keyof typeof archiveStrings.tagOperations
                ] ?? String(c.op)}
              </strong>
              <p>
                <time dateTime={String(c.created_at)}>
                  {localTime(c.created_at)}
                </time>
              </p>
              <p>
                {c.actor === "tagging"
                  ? serviceMessage("archive-tagging")
                  : String(c.reason)}{" "}
                ·{" "}
                {archiveStrings.tagActors[
                  String(c.actor) as keyof typeof archiveStrings.tagActors
                ] ?? String(c.actor)}{" "}
                · 影响 {Number(c.affected_literatures)} 篇
              </p>
              <Button
                isDisabled={c.undone_by !== null || c.op === "undo" || busy}
                onPress={() =>
                  void execute(async () =>
                    setUndo(
                      record(
                        await archiveQuery(api, "tags", {
                          operation: "undo-preview",
                          request: { change_version: c.version },
                        }),
                        "undo preview",
                      ),
                    ),
                  )
                }
              >
                查看撤销影响
              </Button>
            </article>
          ))}
        {changes.hasNextPage ? (
          <Button onPress={() => changes.fetchNextPage().then(() => {})}>
            加载更多变更
          </Button>
        ) : null}
      </Disclosure>
      <Dialog
        title="整理词表"
        isOpen={consolidate}
        onOpenChange={setConsolidate}
        footer={
          <Button
            isPending={action.isPending}
            onPress={() =>
              action.mutate(
                {
                  name: "tags",
                  request: { operation: "consolidate", request: {} },
                },
                { onSuccess: () => setConsolidate(false) },
              )
            }
          >
            确认整理
          </Button>
        }
      >
        <UsageEstimate
          request={
            consolidate
              ? { kind: "tags", request: { operation: "consolidate" } }
              : null
          }
        />

        <p>
          检查词表中的重复候选并整理关系；人工锁定会保留。此操作会调用模型。
        </p>
        {action.error ? (
          <ErrorNotice message={errorMessage(action.error)} />
        ) : null}
      </Dialog>
      <Dialog
        title="新建标签"
        isOpen={form}
        onOpenChange={setForm}
        footer={
          <Button
            isPending={busy}
            isDisabled={(!name.trim() && !english.trim()) || !definition.trim()}
            onPress={() =>
              void execute(async () => {
                await change({
                  op: "create",
                  tag: {
                    name_zh: name,
                    name_en: english,
                    aliases: aliases
                      .split(/[\n,，]/u)
                      .map((v) => v.trim())
                      .filter(Boolean),
                    definition: { includes: definition, excludes },
                    parent_id: parent || null,
                    category: category || null,
                    kind: "topic",
                  },
                });
                setForm(false);
              })
            }
          >
            创建标签
          </Button>
        }
      >
        <TextField label="中文名称" value={name} onChange={setName} />
        <TextField label="英文名称" value={english} onChange={setEnglish} />
        <TextArea
          label="定义（必填）"
          value={definition}
          onChange={setDefinition}
        />
        <TextArea label="不包含" value={excludes} onChange={setExcludes} />
        <TextArea
          label="同义词（每行一个）"
          value={aliases}
          onChange={setAliases}
        />
        <TextField label="类别" value={category} onChange={setCategory} />
        <Select
          label="上级标签"
          value={parent}
          onChange={setParent}
          options={[
            { value: "", label: "无上级" },
            ...vocabulary
              .filter((t) => !t.parent_id)
              .map((t) => ({ value: t.tag_id, label: tagName(t) })),
          ]}
        />
        <TextField label="创建理由" value={reason} onChange={setReason} />
      </Dialog>
      <Dialog
        title="确认撤销词表变更"
        isOpen={!!undo}
        onOpenChange={(v) => {
          if (!v) setUndo(null);
        }}
        footer={
          <Button
            isPending={busy}
            onPress={() =>
              void execute(async () => {
                if (!undo) return;
                await action.mutateAsync({
                  name: "tags",
                  request: {
                    operation: "change",
                    request: {
                      mutation: {
                        op: "undo",
                        change_version: undo.change_version,
                        cascade: true,
                      },
                      expected_version: undo.version,
                      reason: "人工确认撤销及依赖变更",
                    },
                  },
                });
                setUndo(null);
              })
            }
          >
            确认撤销
          </Button>
        }
      >
        <p>将撤销第 {Number(undo?.change_version)} 版。</p>
        <p>
          依赖链：
          {Array.isArray(undo?.dependencies) && undo.dependencies.length
            ? undo.dependencies.map((v) => `第 ${v} 版`).join(" → ")
            : "没有后续依赖"}
          。后来的人工修改不会被覆盖；发生冲突时会拒绝整个操作。
        </p>
      </Dialog>
    </div>
  );
}
/** Top-level tags of a category, each followed by its children; orphans last. */
function ordered(vocabulary: readonly Tag[], group: string) {
  const inGroup = vocabulary.filter((t) => (t.category ?? "未分类") === group);
  const ids = new Set(vocabulary.map((t) => t.tag_id));
  return [
    ...inGroup
      .filter((t) => !t.parent_id)
      .flatMap((t) => [
        { tag: t, depth: 0 },
        ...vocabulary
          .filter((c) => c.parent_id === t.tag_id)
          .map((c) => ({ tag: c, depth: 1 })),
      ]),
    ...inGroup
      .filter((t) => t.parent_id && !ids.has(t.parent_id))
      .map((t) => ({ tag: t, depth: 1 })),
  ];
}
