import { markdown } from "../../../reading/markdown.js";
import { valueCheckReason } from "../../strings.js";
import { ResultState } from "../archive/ResultState.js";
import { archiveWrite } from "../../data/archive.js";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  parseAssetId,
  parseProcessorBatchRequest,
  parseProcessorCollection,
  type ProcessorBatchRequest,
  type ProcessorCitation,
  type ProcessorCollection,
  type ProcessorResultRef,
} from "@sciretriever/contracts";
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  Disclosure,
  Drawer,
  EmptyState,
  ErrorNotice,
  SearchField,
  Select,
  Skeleton,
  TechDetails,
  TextArea,
  TextField,
  type DataColumn,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import type { ApiClient } from "../../data/api.js";
import { navigate, useUrlState } from "../../data/url.js";
import { paperTitle, readLiterature } from "../../data/library.js";
import {
  describeResult,
  processorExportFile,
  readProcessorResult,
  resolveProcessorEvidence,
  resultReference,
  type WebProcessorResult,
  type ResultDescription,
} from "../../data/processor-results.js";
import { useShell } from "../../shell/context.js";
import { record, listField, stringField, jobRecord } from "../../data/wire.js";
import { randomId } from "../../../browser-platform.js";
import { download } from "../library/OperationDialog.js";
import {
  display,
  fieldType,
  parseRow,
  pointerFor,
  rowKey,
  schemaFor,
  type ResultRow,
} from "./result-shape.js";
import { processingError } from "./form.js";
import { ResultEvidence } from "./Evidence.js";
interface Filter {
  field: string;
  operator: string;
  value: string | number | boolean | null;
}
interface Selection {
  ref: ProcessorResultRef;
  recordId: string;
  literatureIds: string[];
  associated: boolean;
}
interface DetailState {
  offset: number;
  pageSize: number;
  field: string;
  operator: string;
  value: string;
  direction: string;
  filters: Filter[];
  sort: { field: string; direction: string } | null;
  selected: Map<string, Selection>;
  question: string;
  policy: string;
  submission: {
    fingerprint: string;
    request: ProcessorBatchRequest;
    jobId: string | null;
    started: boolean;
    note: string;
  } | null;
}
const detailStates = new WeakMap<ApiClient, Map<string, DetailState>>();
const initial = (): DetailState => ({
  offset: 0,
  pageSize: 25,
  field: "",
  operator: "all",
  value: "",
  direction: "none",
  filters: [],
  sort: null,
  selected: new Map(),
  question: "",
  policy: "require-all",
  submission: null,
});
function savedState(api: ApiClient, key: string) {
  let states = detailStates.get(api);
  if (!states) {
    states = new Map();
    detailStates.set(api, states);
  }
  return states.get(key) ?? initial();
}
export default function Results() {
  const route = useUrlState(),
    collection = route.parameters.get("collection"),
    result = route.parameters.get("result");
  return (
    <>
      {route.parameters.get("from") === "ask" ? (
        <Button
          variant="text"
          onPress={() =>
            navigate({ view: "ask", literature: null }, { clearSource: true })
          }
        >
          返回检索
        </Button>
      ) : null}
      {collection || result ? (
        <Detail
          key={collection ?? `${result}:${route.parameters.get("resultHash")}`}
          collectionId={collection}
          resultId={result}
          resultHash={route.parameters.get("resultHash")}
        />
      ) : (
        <ResultList />
      )}
    </>
  );
}
function ResultList() {
  const api = useApi();
  const [query, setQuery] = useState(""),
    [scope, setScope] = useState("collections"),
    [stale, setStale] = useState(false),
    [applied, setApplied] = useState({ query: "", scope: "collections" }),
    [offset, setOffset] = useState(0),
    [cursors, setCursors] = useState<Record<number, string>>({});
  const data = useQuery({
    queryKey: [
      "processors",
      "list",
      applied,
      offset,
      cursors[offset] ?? "",
      stale,
    ],
    queryFn: async ({ signal }) => {
      const results = applied.scope === "results";
      const response = await api.processors(
        applied.query
          ? results
            ? "search"
            : "search-collections"
          : results
            ? "results"
            : "collections",
        applied.query
          ? { query: applied.query, limit: 20, offset }
          : results
            ? {
                limit: 20,
                ...(stale ? { stale: true } : {}),
                ...(cursors[offset] ? { after: cursors[offset] } : {}),
              }
            : { limit: 20, offset },
        signal,
      );
      const envelope = results ? record(response.result, "result list") : null;
      const rows = results ? listField(envelope!, "items") : response.result;
      if (!Array.isArray(rows)) throw new Error("结果列表回执无效。");
      return {
        rows: rows.map((value) => record(value, "result list entry")),
        next: envelope?.next_after ?? null,
      };
    },
  });
  return (
    <>
      <p className="ui-description">
        按运行查看已保存结果，或检索已有结果正文。打开结果不会启动加工。
      </p>
      <form
        className="result-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setOffset(0);
          setCursors({});
          setApplied({ query: query.trim(), scope });
        }}
      >
        <Select
          label="结果检索范围"
          value={scope}
          onChange={setScope}
          options={[
            { value: "collections", label: "集合名称与说明" },
            { value: "results", label: "结果正文" },
          ]}
        />
        <Button
          variant="text"
          aria-pressed={stale}
          onPress={() => {
            setStale((v) => !v);
            setScope("results");
            setApplied({ query: "", scope: "results" });
            setOffset(0);
            setCursors({});
          }}
        >
          只看过时结果
        </Button>
        <SearchField label="检索已有结果" value={query} onChange={setQuery} />
        <Button type="submit">检索</Button>
      </form>
      <p className="ui-description">
        {/\p{Script=Han}/u.test(applied.query)
          ? "当前按关键词做词法匹配，不会自动跨语言匹配；检索英文正文可尝试原文关键词。"
          : "关键词按词法匹配，不会自动翻译或重建索引。"}
      </p>
      {data.isPending ? (
        <Skeleton />
      ) : data.isError ? (
        <ErrorNotice
          message={processingError(data.error)}
          onRetry={() => data.refetch().then(() => {})}
        />
      ) : (
        <>
          <div className="result-list">
            {data.data.rows.map((row, index) => {
              const results = applied.scope === "results",
                ref = results ? resultReference(row) : null,
                id = results
                  ? ref!.result_id
                  : String(parseAssetId(row.collection_id));
              return (
                <article className="result-list-item" key={`${id}-${index}`}>
                  <h2>
                    {results
                      ? typeof row.processor_id === "string"
                        ? row.processor_id
                        : "正文命中"
                      : stringField(row, "name")}
                  </h2>
                  {typeof row.excerpt === "string" ? (
                    <p>{row.excerpt}</p>
                  ) : null}
                  <p className="ui-description">
                    {results
                      ? row.record_id
                        ? "记录命中"
                        : "完整结果"
                      : typeof row.processor_id === "string"
                        ? row.processor_id
                        : "已保存集合"}
                  </p>
                  {row.freshness === "stale" ? (
                    <p role="status">已过时</p>
                  ) : null}
                  <Button
                    onPress={() =>
                      navigate(
                        results
                          ? {
                              view: "ext",
                              result: id,
                              resultHash: ref!.content_sha256,
                              collection: null,
                              results: null,
                            }
                          : {
                              view: "ext",
                              collection: id,
                              result: null,
                              resultHash: null,
                              results: null,
                            },
                      )
                    }
                  >
                    {results ? "打开结果" : "打开集合"}
                  </Button>
                </article>
              );
            })}
            {!data.data.rows.length ? (
              <EmptyState
                title="没有匹配的已保存结果"
                description="调整关键词或检索范围后重试。"
              />
            ) : null}
          </div>
          <div className="result-pagination">
            <span>
              第 {offset / 20 + 1} 页 · 本页 {data.data.rows.length} 项
            </span>
            <Button
              isDisabled={offset === 0}
              onPress={() => setOffset(Math.max(0, offset - 20))}
            >
              上一页
            </Button>
            <Button
              isDisabled={
                applied.scope === "results" && !applied.query
                  ? data.data.next === null
                  : data.data.rows.length < 20
              }
              onPress={() => {
                if (typeof data.data.next === "string")
                  setCursors((current) => ({
                    ...current,
                    [offset + 20]: data.data.next as string,
                  }));
                setOffset(offset + 20);
              }}
            >
              下一页
            </Button>
          </div>
        </>
      )}
    </>
  );
}
function Detail({
  collectionId,
  resultId,
  resultHash,
}: {
  collectionId: string | null;
  resultId: string | null;
  resultHash: string | null;
}) {
  const api = useApi(),
    shell = useShell(),
    queries = useQueryClient();
  const stateKey = collectionId ?? `${resultId}:${resultHash}`;
  const [state, setState] = useState(() => savedState(api, stateKey)),
    [evidence, setEvidence] = useState<ProcessorCitation | null>(null),
    [exportRef, setExportRef] = useState<ProcessorResultRef | null>(null),
    [format, setFormat] = useState("json"),
    [selectionBusy, setSelectionBusy] = useState(false),
    [problem, setProblem] = useState(""),
    [synthesis, setSynthesis] = useState<Selection[] | null>(null);
  useEffect(() => {
    detailStates.get(api)!.set(stateKey, state);
  }, [api, stateKey, state]);
  const patch = (value: Partial<DetailState>) =>
    setState((current) => ({ ...current, ...value }));
  const returnParameters: Record<string, string> = collectionId
    ? { collection: collectionId }
    : { result: resultId!, ...(resultHash ? { resultHash } : {}) };
  const fixed = useQuery({
    queryKey: ["processors", "fixed", collectionId, resultId, resultHash],
    queryFn: async ({ signal }) => {
      const refs = new Map<string, ProcessorResultRef>();
      let collection: ProcessorCollection | null = null,
        standalone: WebProcessorResult | null = null;
      if (collectionId) {
        collection = parseProcessorCollection(
          (
            await api.processors(
              "collection",
              { collection_id: parseAssetId(collectionId) },
              signal,
            )
          ).result,
        );
        if (collection.collection_id !== collectionId)
          throw new Error("固定结果集合身份不匹配。");
        for (const member of collection.members)
          if (member.result) refs.set(member.result.result_id, member.result);
      } else {
        const id = String(parseAssetId(resultId));
        const ref = resultHash
          ? resultReference({ result_id: id, content_sha256: resultHash })
          : resultReference(
              record(
                (await api.processors("read", { result_id: id }, signal))
                  .result,
                "processor result",
              ).ref,
            );
        standalone = await readProcessorResult(api, ref, signal);
        refs.set(ref.result_id, ref);
      }
      return { refs, collection, standalone };
    },
  });
  const verified = async (id: string, signal: AbortSignal) => {
    if (fixed.data?.standalone?.ref.result_id === id)
      return fixed.data.standalone;
    const ref = fixed.data?.refs.get(id);
    if (!ref) throw new Error("查询结果不属于固定集合。");
    return queries.fetchQuery({
      queryKey: ["processors", "verified", ref],
      queryFn: () => readProcessorResult(api, ref, signal),
      staleTime: Infinity,
    });
  };
  const page = useQuery({
    queryKey: [
      "processors",
      "records",
      stateKey,
      state.offset,
      state.pageSize,
      state.filters,
      state.sort,
    ],
    enabled: !!fixed.data,
    queryFn: async ({ signal }) => {
      const response = record(
        (
          await api.processors(
            "query",
            {
              collection_id: collectionId,
              result_ids: collectionId ? [] : [...fixed.data!.refs.keys()],
              filters: state.filters,
              sort: state.sort,
              limit: state.pageSize,
              offset: state.offset,
            },
            signal,
          )
        ).result,
        "records",
      );
      const rows = listField(response, "items").map(parseRow),
        descriptions = new Map<string, ResultDescription>();
      for (const id of new Set(rows.map((row) => row.result_id)))
        descriptions.set(id, describeResult(await verified(id, signal)));
      let schema: Record<string, unknown> = {};
      const first = fixed.data!.refs.keys().next().value;
      if (first) {
        const saved =
          descriptions.get(first) ??
          describeResult(await verified(first, signal));
        descriptions.set(first, saved);
        schema = saved.schema;
      }
      const sources = new Map<string, string[]>(),
        titles = new Map<string, string>();
      let index = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, rows.length) }, async () => {
          while (index < rows.length) {
            signal.throwIfAborted();
            const row = rows[index++]!,
              ref = fixed.data!.refs.get(row.result_id)!;
            const resolved = await resolveProcessorEvidence(
              api,
              { kind: "result", ...ref, record_id: row.record_id, pointer: "" },
              signal,
            );
            sources.set(rowKey(row), resolved.literatureIds);
          }
        }),
      );
      await Promise.all(
        [
          ...new Set([...sources.values()].flatMap((ids) => ids.slice(0, 1))),
        ].map(async (id) => {
          try {
            titles.set(id, paperTitle(await readLiterature(api, id, signal)));
          } catch (error) {
            if (signal.aborted) throw error;
            titles.set(id, "书目暂不可读");
          }
        }),
      );
      const fields = listField(response, "fields").map((value) => {
        if (typeof value !== "string") throw new Error("字段回执无效。");
        return value;
      });
      const next = response.next_offset;
      if (
        next !== null &&
        (typeof next !== "number" ||
          !Number.isSafeInteger(next) ||
          next !== state.offset + state.pageSize)
      )
        throw new Error("记录分页回执无效。");
      return {
        rows,
        descriptions,
        schema,
        sources,
        titles,
        fields,
        next: next as number | null,
      };
    },
    retry: false,
  });
  const fields = page.data?.fields ?? [];
  const field = fields.includes(state.field) ? state.field : (fields[0] ?? "");
  const spec = schemaFor(page.data?.schema ?? {}, field),
    type = fieldType(spec);
  const choices =
    type === "boolean"
      ? [
          { value: "true", label: "是" },
          { value: "false", label: "否" },
        ]
      : Array.isArray(spec.enum)
        ? spec.enum
            .filter((value) => value !== null)
            .map((value) => ({ value: String(value), label: String(value) }))
        : null;
  const effectiveValue = state.value || (choices?.[0]?.value ?? "");
  const apply = () => {
    let value: string | number | boolean | null = effectiveValue;
    if (["null", "not-null"].includes(state.operator)) value = null;
    else if (state.operator !== "all" && ["number", "integer"].includes(type)) {
      if (!effectiveValue.trim() || !Number.isFinite(Number(effectiveValue))) {
        setProblem("请输入有效数值。");
        return;
      }
      value = Number(effectiveValue);
    } else if (type === "boolean") value = effectiveValue === "true";
    setProblem("");
    patch({
      offset: 0,
      filters:
        state.operator === "all"
          ? []
          : [
              {
                field,
                operator:
                  state.operator === "null"
                    ? "eq"
                    : state.operator === "not-null"
                      ? "ne"
                      : state.operator,
                value,
              },
            ],
      sort:
        state.direction === "none"
          ? null
          : { field, direction: state.direction },
    });
  };
  const selectRows = async (keys: Set<string>) => {
    if (!page.data || selectionBusy) return;
    setSelectionBusy(true);
    try {
      const selected = new Map(state.selected);
      for (const row of page.data.rows) {
        const key = rowKey(row);
        if (!keys.has(key)) {
          selected.delete(key);
          continue;
        }
        if (selected.has(key)) continue;
        const ids = page.data.sources.get(key) ?? [];
        const description = page.data.descriptions.get(row.result_id)!;
        selected.set(key, {
          ref: fixed.data!.refs.get(row.result_id)!,
          recordId: row.record_id,
          literatureIds: ids.length ? ids : [...description.literatureIds],
          associated: !ids.length,
        });
      }
      patch({ selected });
    } finally {
      setSelectionBusy(false);
    }
  };
  const columns = useMemo<DataColumn<ResultRow>[]>(() => {
    if (!page.data || !fixed.data) return [];
    const data = page.data,
      refs = fixed.data.refs;
    return [
      {
        id: "sources",
        header: "来源文献 / 记录",
        value: (row) => data.sources.get(rowKey(row))?.[0] ?? "",
        sortable: false,
        render: (row) => {
          const ids = data.sources.get(rowKey(row)) ?? [];
          return (
            <>
              <span>
                {ids[0]
                  ? (data.titles.get(ids[0]) ?? "书目暂不可读")
                  : "没有已验证来源"}
              </span>
              <p className="ui-description">
                {ids.length} 篇来源文献 · {row.record_id}
              </p>
              {ids.length > 1 ? (
                <Disclosure title="查看全部来源">
                  {ids.map((id) => (
                    <Button
                      key={id}
                      variant="text"
                      onPress={() => shell.openPaper(id)}
                    >
                      {data.titles.get(id) ?? "打开来源文献"}
                    </Button>
                  ))}
                </Disclosure>
              ) : null}
              <Button
                variant="text"
                size="compact"
                onPress={() => setExportRef(refs.get(row.result_id)!)}
              >
                完整结果
              </Button>
            </>
          );
        },
      },
      ...[...new Set(data.rows.flatMap((row) => Object.keys(row.payload)))].map(
        (name) => ({
          id: name,
          header: name,
          value: (row: ResultRow) => display(row.payload[name] ?? null),
          sortable: false,
          render: (row: ResultRow) =>
            Object.hasOwn(row.payload, name) ? (
              <>
                <Button
                  variant="text"
                  size="compact"
                  onPress={() =>
                    setEvidence({
                      kind: "result",
                      ...refs.get(row.result_id)!,
                      record_id: row.record_id,
                      pointer: pointerFor(name),
                    })
                  }
                >
                  {display(row.payload[name]!)}
                </Button>
                {row.value_checks
                  .filter(
                    (c) =>
                      c.pointer === pointerFor(name) ||
                      c.pointer.startsWith(`${pointerFor(name)}/`),
                  )
                  .map((c) => (
                    <span
                      key={c.pointer}
                      className="ui-description"
                      title={valueCheckReason(c.reason)}
                    >
                      {" "}
                      ·{" "}
                      {
                        {
                          "text-layer": "文字核对",
                          "image-checked": "图像核对",
                          uncertain: "存疑",
                        }[c.status]
                      }
                    </span>
                  ))}
                {row.missing[name] || row.missing[pointerFor(name)] ? (
                  <p className="ui-description">
                    {row.missing[name] ?? row.missing[pointerFor(name)]}
                  </p>
                ) : null}
              </>
            ) : (
              <span>无此字段</span>
            ),
        }),
      ),
      {
        id: "coverage",
        header: "覆盖",
        sortable: false,
        value: (row) =>
          data.descriptions
            .get(row.result_id)!
            .coverage.some((item) => item.status !== "complete")
            ? "partial"
            : "complete",
        render: (row) => (
          <>
            <Badge
              status={
                data.descriptions
                  .get(row.result_id)!
                  .coverage.some((item) => item.status !== "complete")
                  ? "partial"
                  : "completed"
              }
            />
            <TechDetails title="字段详情">
              <pre>
                {JSON.stringify(
                  { payload: row.payload, missing: row.missing },
                  null,
                  2,
                )}
              </pre>
            </TechDetails>
          </>
        ),
      },
    ];
  }, [page.data, fixed.data, shell]);
  const synthesize = useMutation({
    mutationFn: async () => {
      if (
        !synthesis?.length ||
        !state.question.trim() ||
        new TextEncoder().encode(state.question.trim()).length > 4096
      )
        throw new Error("请填写简短的研究问题并选择记录。");
      const fingerprint = JSON.stringify({
        ids: [...new Set(synthesis.flatMap((i) => i.literatureIds))].sort(),
        question: state.question.trim(),
        policy: state.policy,
      });
      const previous =
        state.submission?.fingerprint === fingerprint ? state.submission : null;
      const snapshot = previous
        ? {
            snapshot_id: (previous.request.inputs[0] as { snapshot_id: string })
              .snapshot_id,
          }
        : record(
            await archiveWrite(api, "snapshots", {
              kind: "literatures",
              literature_ids: [
                ...new Set(synthesis.flatMap((i) => i.literatureIds)),
              ],
            }),
            "snapshot",
          );
      const payload = {
        schema_version: 1,
        name: `文献综合 · ${state.question.trim().slice(0, 80)}`,
        processor: { id: "knowledge-synthesis", version: "2" },
        spec: { question: state.question.trim(), policy: state.policy },
        inputs: [{ kind: "snapshot", snapshot_id: snapshot.snapshot_id }],
      };
      const submission =
        state.submission?.fingerprint === fingerprint
          ? state.submission
          : {
              fingerprint,
              request: parseProcessorBatchRequest({
                ...payload,
                idempotency_key: randomId(),
              }),
              jobId: null,
              started: false,
              note: "",
            };
      patch({ submission });
      try {
        if (!submission.jobId)
          submission.jobId = String(
            jobRecord(
              (await api.submitProcessor(submission.request, false)).task,
            ).job_id,
          );
        if (!submission.started) {
          await api.request(
            `/api/tasks/${encodeURIComponent(submission.jobId)}/start`,
            {},
          );
          submission.started = true;
        }
        submission.note = "任务已保存，可到任务页核对实际进度。";
      } catch (error) {
        submission.note = submission.jobId
          ? "任务已保存，启动状态未确认；请查看任务后显式继续。"
          : `${processingError(error)} 重试同一草稿将核对原提交标识。`;
        throw error;
      } finally {
        patch({ submission: { ...submission } });
        void queries.invalidateQueries({ queryKey: ["tasks"] });
      }
    },
  });
  if (fixed.isPending) return <Skeleton label="正在核验固定结果" />;
  if (fixed.isError)
    return (
      <ErrorNotice
        message={processingError(fixed.error)}
        onRetry={() => fixed.refetch().then(() => {})}
      />
    );
  const { collection, standalone, refs } = fixed.data;
  const selectedSources = [
    ...new Set(
      [...state.selected.values()].flatMap((item) => item.literatureIds),
    ),
  ];
  return (
    <>
      <Button
        variant="text"
        onPress={() =>
          navigate({
            view: "ext",
            results: "all",
            result: null,
            resultHash: null,
            collection: null,
          })
        }
      >
        全部结果
      </Button>
      <h2>
        {collection?.name ??
          (standalone?.result.invocation.processor.id === "labels"
            ? "问答标注"
            : standalone?.result.invocation.processor.id === "summary"
              ? "文献总结"
              : standalone?.result.invocation.processor.id ===
                  "knowledge-synthesis"
                ? "文献综合"
                : "记录提取")}
      </h2>
      <p>
        {collection
          ? `${collection.members.length} 项输入 · ${collection.members.filter((item) => item.result).length} 项已有结果 · ${collection.members.filter((item) => !item.result).length} 项缺口`
          : `${describeResult(standalone!).literatureIds.length} 篇关联文献 · ${standalone!.result.coverage.some((item) => item.status !== "complete") ? "部分覆盖" : "完整覆盖"}`}
      </p>
      {standalone ? (
        <>
          <ResultState
            coverage={standalone.result.coverage}
            freshness={standalone.freshness}
          />
          {standalone.freshness.state === "stale" ? (
            <Button
              onPress={() => {
                shell.setSelected(new Set(standalone.result.literature_ids));
                navigate({
                  view: "snapshots",
                  literature: null,
                  result: null,
                  resultHash: null,
                  collection: null,
                });
              }}
            >
              基于当前文献生成新快照
            </Button>
          ) : null}
        </>
      ) : null}
      <TechDetails
        title="本次规范与缺口"
        copyText={JSON.stringify(
          collection ?? {
            ref: standalone?.ref,
            invocation: standalone?.result.invocation,
            coverage: standalone?.result.coverage,
            provenance: standalone?.result.provenance,
          },
          null,
          2,
        )}
      >
        <pre>
          {JSON.stringify(
            collection?.spec ?? standalone?.result.invocation.spec,
            null,
            2,
          )}
        </pre>
        {collection?.members.map((member, index) => (
          <p key={index}>
            {member.result ? (
              <Button
                onPress={() =>
                  navigate({
                    view: "ext",
                    result: member.result!.result_id,
                    resultHash: member.result!.content_sha256,
                    collection: null,
                  })
                }
              >
                打开结果摘要
              </Button>
            ) : (
              `未形成结果：${member.gap ?? "尚未处理"}`
            )}
          </p>
        ))}
      </TechDetails>
      {standalone?.result.content.kind === "report" ? (
        <section>
          <h3>已保存的结果正文</h3>
          <div
            className="result-text reader-prose"
            dangerouslySetInnerHTML={{
              __html: markdown.parse(
                standalone.result.content.text.slice(0, 32000),
              ),
            }}
          />
          {standalone.result.content.text.length > 32000 ? (
            <p className="ui-description">
              正文较长，此处预览前 32000 字符；下载包含完整正文与来源。
            </p>
          ) : null}
          <Button onPress={() => setExportRef(standalone.ref)}>完整结果</Button>
        </section>
      ) : null}
      <div className="result-toolbar">
        <Select
          label="筛选字段"
          value={field}
          onChange={(value) =>
            patch({
              field: value,
              operator: "all",
              direction: "none",
              value: "",
            })
          }
          options={fields.map((value) => ({ value, label: value }))}
        />
        <Select
          label="筛选操作"
          value={state.operator}
          onChange={(value) => patch({ operator: value })}
          options={[
            { value: "all", label: "全部值" },
            { value: "null", label: "空值 / 无法判断" },
            { value: "not-null", label: "有值" },
            ...(["object", "array"].includes(type)
              ? []
              : [
                  { value: "eq", label: "等于" },
                  { value: "ne", label: "不等于" },
                ]),
            ...(["number", "integer"].includes(type)
              ? [
                  { value: "gt", label: "大于" },
                  { value: "ge", label: "大于或等于" },
                  { value: "lt", label: "小于" },
                  { value: "le", label: "小于或等于" },
                ]
              : []),
          ]}
        />
        {!["all", "null", "not-null"].includes(state.operator) ? (
          choices ? (
            <Select
              label="筛选值"
              value={effectiveValue}
              onChange={(value) => patch({ value })}
              options={choices}
            />
          ) : (
            <TextField
              label="筛选值"
              value={state.value}
              onChange={(value) => patch({ value })}
            />
          )
        ) : null}
        <Select
          label="结果排序"
          value={state.direction}
          onChange={(value) => patch({ direction: value })}
          options={[
            { value: "none", label: "原顺序" },
            { value: "asc", label: "升序" },
            { value: "desc", label: "降序" },
          ]}
        />
        <Button isDisabled={!fields.length} onPress={apply}>
          应用筛选
        </Button>
      </div>
      <p role="status">
        {state.filters.length
          ? "显示已应用筛选的结果；修改条件后点击应用筛选。"
          : "显示本次固定范围的已有记录。"}
      </p>
      {problem ? <ErrorNotice message={problem} /> : null}
      {state.selected.size ? (
        <div className="result-selection">
          <span>
            已选 {state.selected.size} 条记录 · 来自 {selectedSources.length}{" "}
            篇文献（跨页保留
            {[...state.selected.values()].some((item) => item.associated)
              ? "；含无证据记录的关联输入"
              : ""}
            ）
          </span>
          <Button
            variant="process"
            confirm={false}
            isDisabled={api.kind !== "workspace"}
            onPress={() => setSynthesis([...state.selected.values()])}
          >
            按来源文献综合
          </Button>
          <Button
            onPress={() => {
              shell.setSelected(new Set(selectedSources));
              navigate({ view: "lib", scope: "selection" });
            }}
          >
            选择来源文献
          </Button>
          <Button variant="text" onPress={() => patch({ selected: new Map() })}>
            清空选择
          </Button>
        </div>
      ) : null}
      {page.isPending ? (
        <Skeleton />
      ) : page.isError ? (
        <ErrorNotice
          message={processingError(page.error)}
          retained="已有选择、草稿和完整结果仍保留。"
          onRetry={() => page.refetch().then(() => {})}
        />
      ) : (
        <>
          <DataTable
            label="提取结果"
            rows={page.data.rows}
            columns={columns}
            getRowId={rowKey}
            selected={new Set(state.selected.keys())}
            {...(!selectionBusy
              ? {
                  onSelectionChange: (keys: Set<string>) => {
                    void selectRows(keys);
                  },
                }
              : {})}
            empty="当前范围没有匹配记录；空结果不代表全文没有相关信息。"
          />
          <div className="result-pagination">
            <span>
              第 {Math.floor(state.offset / state.pageSize) + 1} 页 · 本页{" "}
              {page.data.rows.length} 条 · {refs.size} 份固定结果
            </span>
            <Select
              label="每页记录数"
              value={String(state.pageSize)}
              onChange={(value) =>
                patch({ pageSize: Number(value), offset: 0 })
              }
              options={[10, 25, 50].map((value) => ({
                value: String(value),
                label: `${value} 条 / 页`,
              }))}
            />
            <Button
              isDisabled={state.offset === 0}
              onPress={() =>
                patch({ offset: Math.max(0, state.offset - state.pageSize) })
              }
            >
              上一页
            </Button>
            <Button
              isDisabled={page.data.next === null}
              onPress={() => patch({ offset: page.data.next ?? state.offset })}
            >
              下一页
            </Button>
          </div>
        </>
      )}
      {standalone ? (
        <Button onPress={() => setExportRef(standalone.ref)}>
          导出这份完整结果
        </Button>
      ) : null}
      <Drawer
        title="字段证据"
        isOpen={evidence !== null}
        onOpenChange={(open) => {
          if (!open) setEvidence(null);
        }}
      >
        {evidence ? (
          <ResultEvidence
            key={JSON.stringify(evidence)}
            citation={evidence}
            onFollow={setEvidence}
            returnParameters={returnParameters}
          />
        ) : null}
      </Drawer>
      <Dialog
        title="导出这份完整结果"
        isOpen={exportRef !== null}
        onOpenChange={(open) => {
          if (!open) setExportRef(null);
        }}
      >
        <p>导出整份已保存产物，不受当前筛选、页码或选中项影响。</p>
        <p>
          CSV / Markdown 与覆盖、来源说明一起下载为 ZIP；JSON
          保留完整不可变结果。
        </p>
        <Select
          label="导出格式"
          value={format}
          onChange={setFormat}
          options={[
            { value: "json", label: "JSON" },
            { value: "csv", label: "CSV + 来源说明（ZIP）" },
            { value: "markdown", label: "Markdown + 来源说明（ZIP）" },
          ]}
        />
        <Button
          variant="primary"
          onPress={async () => {
            if (!exportRef) return;
            const file = await processorExportFile(
              api,
              exportRef,
              format as "json" | "csv" | "markdown",
              new AbortController().signal,
            );
            download(file.blob, file.name);
          }}
        >
          下载完整结果
        </Button>
      </Dialog>
      <Dialog
        title="按来源文献生成新综合"
        isOpen={synthesis !== null}
        onOpenChange={(open) => {
          if (!open && !synthesize.isPending) setSynthesis(null);
        }}
        isDismissable={!synthesize.isPending}
      >
        <p>确认时固定 {synthesis?.length ?? 0} 条记录，原结果保持不变。</p>
        <TextArea
          label="研究问题"
          value={state.question}
          onChange={(question) => patch({ question })}
        />
        <Select
          label="输入策略"
          value={state.policy}
          onChange={(policy) => patch({ policy })}
          options={[
            { value: "require-all", label: "全部输入有效才执行" },
            { value: "allow-partial", label: "允许部分输入，保留缺口" },
          ]}
        />
        <Button
          variant="primary"
          isPending={synthesize.isPending}
          onPress={() => synthesize.mutateAsync()}
        >
          确认并创建综合任务
        </Button>
        {state.submission ? (
          <>
            <p role="status">{state.submission.note}</p>
            {state.submission.jobId ? (
              <Button
                onPress={() =>
                  navigate({ view: "task", task: state.submission!.jobId })
                }
              >
                查看综合任务
              </Button>
            ) : null}
          </>
        ) : null}
      </Dialog>
    </>
  );
}
