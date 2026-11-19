import { UsageEstimate } from "../processing/UsageEstimate.js";
import { parseProcessorReads } from "@sciretriever/contracts";
import { useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Button,
  Disclosure,
  ErrorNotice,
  Icon,
  PageHeader,
  Dialog,
  RichTitle,
  Select,
  Skeleton,
  TextArea,
  TextField,
} from "../../components/index.js";
import { archiveQuery, rows, useArchiveAction } from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { record } from "../../data/wire.js";
import { metadataTitleParts } from "../../data/library.js";
import { navigate, useUrlState } from "../../data/url.js";
import { useShell } from "../../shell/context.js";
import { randomId } from "../../../browser-platform.js";
import {
  errorMessage,
  archiveStrings,
  processorName,
  sectionRoleNames,
  shortTime,
} from "../../strings.js";
import { readProcessorResult } from "../../data/processor-results.js";
import { renameSnapshot } from "../../data/snapshots.js";
import { RunOperatorDialog } from "../processing/RunOperator.js";
import { PaperName, SnapshotDefinition } from "./SnapshotInfo.js";
import "./archive.css";
/** The stored display name; older servers without names fall back to time and size. */
const name = (s: Record<string, unknown>) =>
  typeof s.name === "string" && s.name
    ? s.name
    : `${shortTime(s.created_at)} · ${s.member_count} 篇`;
export default function Snapshots() {
  const api = useApi(),
    shell = useShell(),
    route = useUrlState(),
    queries = useQueryClient(),
    action = useArchiveAction();
  // The open snapshot lives in the URL, so back returns to the list.
  const selected = route.parameters.get("snapshot") ?? "";
  const [other, setOther] = useState(""),
    [operator, setOperator] = useState(
      route.parameters.get("processor") ??
        (route.section === "syn" ? "knowledge-synthesis" : "summary"),
    ),
    [question, setQuestion] = useState(""),
    [policy, setPolicy] = useState("require-all"),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState(""),
    [difference, setDifference] = useState<Record<string, unknown> | null>(
      null,
    ),
    [renaming, setRenaming] = useState<string | null>(null),
    [running, setRunning] = useState(false);
  const rename = async (value: string | null) => {
    setBusy(true);
    setFailure("");
    try {
      await renameSnapshot(api, { snapshot_id: selected, name: value });
      void queries.invalidateQueries({ queryKey: ["snapshots"] });
      setRenaming(null);
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const open = (id: string) => {
    setDifference(null);
    setOther("");
    navigate({ snapshot: id || null });
  };
  const rerunId = route.parameters.get("rerun"),
    rerunHash = route.parameters.get("rerunHash");
  const rerun = useQuery({
    queryKey: ["processors", "rerun", rerunId, rerunHash],
    enabled: !!rerunId && !!rerunHash,
    queryFn: async ({ signal }) => {
      const saved = await readProcessorResult(
        api,
        { result_id: rerunId!, content_sha256: rerunHash! },
        signal,
      );
      const input = saved.result.invocation.inputs.find(
        (i) => i.kind === "snapshot",
      );
      const definition =
        input?.kind === "snapshot"
          ? record(
              await archiveQuery(
                api,
                "snapshots",
                {
                  operation: "read",
                  request: {
                    snapshot_id: input.snapshot_id,
                    offset: 0,
                    limit: 1,
                    max_bytes: 262144,
                  },
                },
                signal,
              ),
              "snapshot",
            ).definition
          : {
              kind: "literatures",
              literature_ids: saved.result.literature_ids,
            };
      return { saved, definition };
    },
  });
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
  const processors = Array.isArray(registry.data)
    ? registry.data.map((v) => record(v, "processor"))
    : [];
  const chosen = processors.find((p) => p.id === operator);
  const reads = chosen ? parseProcessorReads(chosen.reads) : null;
  const run = async () => {
    setBusy(true);
    setFailure("");
    try {
      if (!rerunId && (operator === "labels" || operator === "records")) {
        navigate({
          view: "ext",
          literature: null,
          snapshot: selected,
          processor: operator,
        });
        return;
      }
      if (!chosen) throw new Error("请先选择可用算子。");
      if (
        rerunId &&
        (!rerun.data ||
          rerun.data.saved.result.invocation.processor.version !==
            chosen.version)
      )
        throw new Error("原算子版本不可用，请重新选择算子与规范。");
      await api.submitProcessor(
        {
          schema_version: 1,
          idempotency_key: randomId(),
          name: operator === "summary" ? "快照文献总结" : "快照综合",
          processor: { id: operator, version: String(chosen.version) },
          spec:
            rerun.data?.saved.result.invocation.spec ??
            (operator === "summary" ? {} : { question, policy }),
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
      {selected ? (
        <>
          <Button
            variant="text"
            className="snapshot-back"
            icon={<Icon name="arrow" />}
            onPress={() => open("")}
          >
            返回快照列表
          </Button>
          <PageHeader
            title={definition ? name(definition) : archiveStrings.snapshot}
            {...(definition
              ? {
                  description: `${shortTime(definition.created_at)} 创建 · ${
                    definition.name_source === "manual"
                      ? "名称已手动修改"
                      : "名称按定义自动生成"
                  }`,
                }
              : {})}
            action={
              definition ? (
                <Button onPress={() => setRenaming(name(definition))}>
                  重命名
                </Button>
              ) : undefined
            }
          />
          <Dialog
            title="重命名快照"
            isOpen={renaming !== null}
            onOpenChange={(value) => {
              if (!value) setRenaming(null);
            }}
            footer={
              <>
                {definition?.name_source === "manual" ? (
                  <Button
                    variant="text"
                    isDisabled={busy}
                    onPress={() => void rename(null)}
                  >
                    恢复默认名称
                  </Button>
                ) : null}
                <Button
                  variant="primary"
                  isPending={busy}
                  disabledReason={
                    renaming?.trim() ? undefined : "请输入快照名称。"
                  }
                  onPress={() => void rename(renaming!.trim())}
                >
                  保存
                </Button>
              </>
            }
          >
            <p>名称只用于显示，不改变快照的成员和内容版本。</p>
            <TextField
              label="快照名称"
              value={renaming ?? ""}
              onChange={setRenaming}
            />
          </Dialog>
        </>
      ) : (
        <PageHeader
          title={route.section === "syn" ? "综合" : archiveStrings.snapshot}
          count={
            snapshots.data && !snapshots.hasNextPage
              ? `${items.length} 个`
              : undefined
          }
          action={
            <Button
              isPending={action.isPending}
              isDisabled={!!rerunId && !rerun.data}
              onPress={() =>
                action.mutate(
                  {
                    name: "snapshots",
                    request:
                      rerun.data?.definition ??
                      (shell.selected.size
                        ? {
                            kind: "literatures",
                            literature_ids: [...shell.selected],
                          }
                        : { kind: "query", query: route.query }),
                  },
                  {
                    onSuccess: (v) =>
                      open(String(record(v, "snapshot").snapshot_id)),
                  },
                )
              }
            >
              {rerunId
                ? "按原结果范围生成新快照"
                : archiveStrings.createSnapshot}
            </Button>
          }
        />
      )}
      {failure || action.error || snapshots.error || rerun.error ? (
        <ErrorNotice
          message={
            failure ||
            errorMessage(action.error ?? snapshots.error ?? rerun.error)
          }
        />
      ) : null}
      {rerunId ? (
        <p>
          沿用原结果的算子规范；先生成当前版本的新快照，再确认启动。旧结果保持不变。
        </p>
      ) : null}
      {action.data ? (
        <p role="status">
          已固定 {Number(record(action.data, "snapshot").member_count)}{" "}
          篇；未就绪而排除{" "}
          {Number(record(action.data, "snapshot").excluded_count)} 篇。
        </p>
      ) : null}
      {selected ? (
        <div className="snapshot-detail">
          <section className="snapshot-detail-section">
            <h2>成员与版本</h2>
            {members.error ? (
              <ErrorNotice message={errorMessage(members.error)} />
            ) : null}
            {definition ? (
              <>
                <SnapshotDefinition value={definition.definition} />
                <p>
                  {Number(definition.member_count)} 篇就绪文献；创建时排除{" "}
                  {Number(definition.excluded_count)}{" "}
                  篇。快照中的版本不会随库更新。
                </p>
              </>
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
                      <RichTitle
                        parts={metadataTitleParts(
                          record(m.metadata, "metadata").title,
                        )}
                      />
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
                            <PaperName id={id} />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </Disclosure>
                ))
              : null}
          </section>
          <section className="snapshot-detail-section">
            <h2>运行算子</h2>
            {rerunId ? null : (
              <>
                <p>以这个快照的固定成员为范围，选择算子、填写规范并确认。</p>
                <div className="form-actions">
                  <Button
                    variant="primary"
                    isDisabled={!definition}
                    onPress={() => setRunning(true)}
                  >
                    运行算子…
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
                </div>
                {running && definition ? (
                  <RunOperatorDialog
                    fixed={{
                      scope: { kind: "snapshot", id: selected },
                      label: name(definition),
                    }}
                    onClose={() => setRunning(false)}
                  />
                ) : null}
              </>
            )}
          </section>
          {rerunId ? (
            <section className="snapshot-detail-section">
              <h2>按原规范重新运行</h2>
              <Select
                label="算子"
                isDisabled={!!rerunId}
                value={operator}
                onChange={setOperator}
                options={processors.map((p) => ({
                  value: String(p.id),
                  label: processorName(String(p.id)),
                }))}
              />
              {registry.error ? (
                <ErrorNotice message={errorMessage(registry.error)} />
              ) : null}
              {reads ? (
                <p>
                  读取：
                  {
                    {
                      main: "正文",
                      supplementary: "补充材料",
                      all: "正文与补充材料",
                    }[reads.parts]
                  }{" "}
                  ·{" "}
                  {reads.roles === "all"
                    ? "全部章节"
                    : reads.roles
                        .map((r) => sectionRoleNames[r] ?? "其他章节")
                        .join("、")}
                  {chosen?.spec_schema &&
                  Object.hasOwn(
                    record(
                      record(chosen.spec_schema, "specification").properties,
                      "properties",
                    ),
                    "reading",
                  )
                    ? "（下一步可调整）"
                    : ""}
                </p>
              ) : (
                <p>正在读取算子声明…</p>
              )}
              {chosen?.map ? (
                <p>
                  逐篇步骤：
                  {processorName(
                    String(
                      record(record(chosen.map, "map").processor, "processor")
                        .id,
                    ),
                  )}
                  ；已有结果会复用。
                </p>
              ) : null}
              {operator === "knowledge-synthesis" && !rerunId ? (
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
              {chosen &&
              (rerunId || !["labels", "records"].includes(operator)) ? (
                <UsageEstimate
                  request={{
                    kind: "processor",
                    request: {
                      schema_version: 1,
                      idempotency_key: "estimate",
                      name: "快照处理",
                      processor: {
                        id: operator,
                        version: String(chosen.version),
                      },
                      spec:
                        rerun.data?.saved.result.invocation.spec ??
                        (operator === "summary" ? {} : { question, policy }),
                      inputs: [{ kind: "snapshot", snapshot_id: selected }],
                    },
                  }}
                />
              ) : null}
              <Button
                isPending={busy}
                isDisabled={
                  !chosen ||
                  (!rerunId &&
                    operator === "knowledge-synthesis" &&
                    !question.trim())
                }
                onPress={() => void run()}
              >
                {!rerunId && (operator === "labels" || operator === "records")
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
          ) : null}
        </div>
      ) : (
        <section className="snapshot-list" aria-label="快照列表">
          {snapshots.isPending ? <Skeleton label="正在读取快照" /> : null}
          {items.length ? (
            <table className="ui-data-table snapshot-table">
              <thead>
                <tr>
                  <th scope="col">名称</th>
                  <th scope="col" data-numeric>
                    篇数
                  </th>
                  <th scope="col" data-numeric>
                    创建时排除
                  </th>
                  <th scope="col">创建时间</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={String(item.snapshot_id)}
                    onClick={() => open(String(item.snapshot_id))}
                  >
                    <td>
                      <button
                        type="button"
                        className="snapshot-open"
                        onClick={(event) => {
                          event.stopPropagation();
                          open(String(item.snapshot_id));
                        }}
                      >
                        {name(item)}
                      </button>
                    </td>
                    <td data-numeric>
                      {Number(item.member_count).toLocaleString()}
                    </td>
                    <td data-numeric>
                      {Number(item.excluded_count)
                        ? Number(item.excluded_count).toLocaleString()
                        : "—"}
                    </td>
                    <td className="snapshot-time">
                      {shortTime(item.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {!snapshots.isPending && !items.length ? (
            <p className="snapshot-empty">
              还没有快照。在文献库应用筛选后，从“批量操作”生成快照。
            </p>
          ) : null}
          {snapshots.hasNextPage ? (
            <Button
              variant="text"
              onPress={() => snapshots.fetchNextPage().then(() => {})}
            >
              加载更多快照
            </Button>
          ) : null}
        </section>
      )}
    </div>
  );
}
