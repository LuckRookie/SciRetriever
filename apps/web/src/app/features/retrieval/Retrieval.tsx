import {
  parseDocumentReadRequest,
  parseDocumentReadResult,
  parseKnowledgeContextBundle,
  parseKnowledgeContextRequest,
  type KnowledgeContextItem,
  type KnowledgeContextRequest,
} from "@sciretriever/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { copyText } from "../../../browser-platform.js";
import {
  Button,
  Disclosure,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SearchField,
  Select,
  TechDetails,
  TextField,
} from "../../components/index.js";
import type { ApiClient } from "../../data/api.js";
import { paperTitle, readLiterature, scopeIds } from "../../data/library.js";
import { useApi } from "../../data/query.js";
import { sourceParameters } from "../../data/sources.js";
import { navigate, useUrlState } from "../../data/url.js";
import { useShell } from "../../shell/context.js";
import { errorMessage } from "../../strings.js";
import { download } from "../library/OperationDialog.js";
import "./retrieval.css";

interface State {
  draft: {
    query: string;
    scope: string;
    kinds: string;
    count: string;
    bytes: string;
  };
  items: readonly KnowledgeContextItem[];
  current: KnowledgeContextRequest | null;
  next: string | null;
  basket: ReadonlyMap<string, KnowledgeContextItem>;
  status: string;
  generation: number;
  technical: unknown;
}
const sessions = new WeakMap<ApiClient, State>();
const initial = (): State => ({
  draft: {
    query: "",
    scope: "library",
    kinds: "all",
    count: "10",
    bytes: "32768",
  },
  items: [],
  current: null,
  next: null,
  basket: new Map(),
  status: "输入关键词后检索已有材料。",
  generation: 0,
  technical: null,
});
const key = (item: KnowledgeContextItem) => JSON.stringify(item.reference);
const textOf = (item: KnowledgeContextItem) =>
  item.kind === "generated-result"
    ? item.text || "该结果超过本次预算，可打开完整结果。"
    : item.text;
export default function Retrieval() {
  const api = useApi(),
    shell = useShell(),
    route = useUrlState(),
    queries = useQueryClient();
  const [state, setState] = useState(() => sessions.get(api) ?? initial()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null),
    serial = useRef(0);
  useEffect(() => {
    sessions.set(api, state);
  }, [api, state]);
  useEffect(
    () => () => {
      serial.current++;
      if (active.current) {
        active.current.abort();
        const saved = sessions.get(api);
        if (saved)
          sessions.set(api, {
            ...saved,
            status: "检索已中止；保留上次结果，可重新检索。",
          });
      }
    },
    [api],
  );
  const draft = (patch: Partial<State["draft"]>) =>
    setState((value) => ({ ...value, draft: { ...value.draft, ...patch } }));
  const run = async (append = false) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const version = ++serial.current;
    setBusy(true);
    setError(null);
    try {
      const ids =
        state.draft.scope === "selection"
          ? [...shell.selected]
          : state.draft.scope === "query"
            ? await scopeIds(api, route.query, route.sort, controller.signal)
            : [];
      const request =
        append && state.current && state.next
          ? parseKnowledgeContextRequest({
              ...state.current,
              continuation: state.next,
            })
          : parseKnowledgeContextRequest({
              schema_version: 3,
              query: state.draft.query,
              scope:
                state.draft.scope === "library"
                  ? { kind: "library" }
                  : { kind: "literatures", literature_ids: ids },
              kinds:
                state.draft.kinds === "source"
                  ? ["metadata", "document"]
                  : state.draft.kinds === "knowledge"
                    ? ["knowledge"]
                    : ["metadata", "document", "knowledge"],
              versions: { kind: "default" },
              budget: {
                max_items: Number(state.draft.count),
                max_bytes: Number(state.draft.bytes),
                token_limit: null,
              },
              continuation: null,
            });
      const bundle = await queries.fetchQuery({
        queryKey: ["retrieval", request],
        queryFn: async ({ signal }) => {
          const combined = AbortSignal.any([signal, controller.signal]);
          return parseKnowledgeContextBundle(
            (await api.query("knowledge-context", request, combined)).result,
            request,
          );
        },
        staleTime: 0,
      });
      if (version !== serial.current || controller.signal.aborted) return;
      const codes = [bundle.coverage, ...bundle.gaps.map((gap) => gap.code)];
      const issue = (
        [
          ["index-unavailable", "检索索引尚未建立"],
          ["index-stale", "检索索引已过期"],
          ["index-corrupt", "检索索引不可用"],
        ] as const
      )
        .filter(([code]) => codes.some((value) => value.endsWith(code)))
        .map(([, text]) => text)
        .join("；");
      setState((value) => {
        const items = append ? [...value.items, ...bundle.items] : bundle.items;
        return {
          ...value,
          current: request,
          next: bundle.continuation,
          items,
          generation: append ? value.generation : value.generation + 1,
          status: `${items.length} 条结果${issue ? ` · ${issue}。请在设置的高级工具中显式重建相应索引；当前结果不代表完整检索。` : !items.length ? " · 未匹配当前关键词，可尝试原文用词或调整范围。" : bundle.truncated ? " · 当前结果包含部分片段，可以继续读取。" : ""}`,
          technical: {
            coverage: bundle.coverage,
            gaps: bundle.gaps,
            usage: bundle.usage,
          },
        };
      });
    } catch (error) {
      if (version === serial.current && !controller.signal.aborted)
        setError(errorMessage(error));
    } finally {
      if (version === serial.current && !controller.signal.aborted) {
        setBusy(false);
        active.current = null;
      }
    }
  };
  const toggle = (item: KnowledgeContextItem) =>
    setState((value) => {
      const basket = new Map(value.basket);
      if (basket.has(key(item))) basket.delete(key(item));
      else basket.set(key(item), item);
      return { ...value, basket };
    });
  const open = (item: KnowledgeContextItem) => {
    const parameters = { ...sourceParameters(item.reference), from: "ask" };
    if (item.kind === "generated-result")
      navigate(
        {
          view: "ext",
          result: item.reference.result_id,
          resultHash: item.reference.content_sha256,
          from: "ask",
        },
        { clearSource: true },
      );
    else shell.openPaper(item.literature_id, "doc", parameters);
  };
  return (
    <div className="retrieval-page">
      <section className="retrieval-main">
        <PageHeader
          title="检索"
          description="在已保存的正文和知识里查找材料，随时返回原文核对。"
        />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <div className="retrieval-query">
            <SearchField
              label="问题或关键词"
              value={state.draft.query}
              onChange={(query) => draft({ query })}
              placeholder="输入要查找的问题或关键词"
            />
            <Button variant="primary" type="submit" isPending={busy}>
              检索
            </Button>
          </div>
          <p className="muted">
            按文献所用的语言检索。多个关键词须同时命中，不自动翻译或扩展含义。
          </p>
          {/\p{Script=Han}/u.test(state.draft.query) && (
            <p role="note">
              当前不会自动跨语言匹配；英文文献可尝试英文关键词。中文按连续词串匹配，子词不保证命中。
            </p>
          )}
          <Disclosure title="高级检索选项">
            <div className="retrieval-options">
              <Select
                label="范围"
                value={state.draft.scope}
                onChange={(scope) => draft({ scope })}
                options={[
                  { value: "library", label: "全部文献" },
                  {
                    value: "selection",
                    label: `已选 ${shell.selected.size} 篇`,
                    disabled: !shell.selected.size,
                  },
                  { value: "query", label: "当前筛选结果" },
                ]}
              />
              <Select
                label="内容"
                value={state.draft.kinds}
                onChange={(kinds) => draft({ kinds })}
                options={[
                  { value: "source", label: "仅原文" },
                  { value: "all", label: "原文与知识" },
                  { value: "knowledge", label: "仅知识" },
                ]}
              />
              <Select
                label="每页结果"
                value={state.draft.count}
                onChange={(count) => draft({ count })}
                options={[
                  { value: "5", label: "5 条" },
                  { value: "10", label: "10 条" },
                  { value: "20", label: "20 条" },
                ]}
              />
              <Select
                label="上下文长度"
                value={state.draft.bytes}
                onChange={(bytes) => draft({ bytes })}
                options={[
                  { value: "8192", label: "简短" },
                  { value: "32768", label: "标准" },
                  { value: "65536", label: "较长" },
                  { value: "262144", label: "最长" },
                ]}
              />
              <TextField
                label="精确传输预算"
                value={state.draft.bytes}
                onChange={(bytes) => draft({ bytes })}
                description="高级选项：1,024–262,144 UTF-8 字节，包含引用信息。"
              />
            </div>
          </Disclosure>
        </form>
        <p role="status" data-testid="retrieval-status">
          {busy ? "正在检索已有材料与知识…" : state.status}
        </p>
        {error && (
          <ErrorNotice
            message={`检索未完成：${error}`}
            retained="保留上一次结果与已选择的上下文。"
            onRetry={() => run()}
          />
        )}
        <div className="retrieval-results" role="region" aria-label="检索结果">
          {state.items.map((item, index) => (
            <Result
              key={`${state.generation}:${key(item)}:${index}`}
              item={item}
              selected={state.basket.has(key(item))}
              onToggle={() => toggle(item)}
              onOpen={() => open(item)}
            />
          ))}
          {!state.items.length && !busy && state.current && !error && (
            <EmptyState
              title="当前没有可显示的片段"
              description="可调整关键词或范围；索引状态见上方说明。"
            />
          )}
        </div>
        {state.next && (
          <Button isPending={busy} onPress={() => void run(true)}>
            继续查找
          </Button>
        )}
        <TechDetails>
          <pre>{JSON.stringify(state.technical, null, 2)}</pre>
        </TechDetails>
      </section>
      <aside className="context-basket" aria-label="上下文">
        <h2>上下文</h2>
        <p>
          {state.basket.size
            ? `已选择 ${state.basket.size} 条片段`
            : "尚未选择片段"}
        </p>
        <ol>
          {[...state.basket.values()].map((item) => (
            <li key={key(item)}>
              <p>{textOf(item).slice(0, 180)}</p>
              <Button
                variant="text"
                size="compact"
                onPress={() => toggle(item)}
              >
                移除片段
              </Button>
            </li>
          ))}
        </ol>
        <div className="context-actions">
          <Button
            disabledReason={
              !state.basket.size ? "请先将片段加入上下文。" : undefined
            }
            onPress={() =>
              void copyText(
                [...state.basket.values()]
                  .map(
                    (item) =>
                      `${textOf(item)}\n\n来源：\`${JSON.stringify(item.reference)}\``,
                  )
                  .join("\n\n---\n\n"),
              ).then(
                () => shell.notify("上下文已复制"),
                (error: unknown) => shell.notify(errorMessage(error)),
              )
            }
          >
            复制为 Markdown
          </Button>
          <Button
            disabledReason={
              !state.basket.size ? "请先将片段加入上下文。" : undefined
            }
            onPress={() =>
              download(
                new Blob(
                  [
                    JSON.stringify(
                      {
                        query: state.current,
                        items: [...state.basket.values()],
                      },
                      null,
                      2,
                    ),
                  ],
                  { type: "application/json" },
                ),
                "sciretriever-context.json",
              )
            }
          >
            导出 JSON
          </Button>
        </div>
        <p className="muted">保留固定版本和证据引用，可交给 Agent 使用。</p>
      </aside>
    </div>
  );
}
function Result({
  item,
  selected,
  onToggle,
  onOpen,
}: {
  item: KnowledgeContextItem;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const api = useApi();
  const id =
    item.kind === "generated-result"
      ? item.source_literature_ids[0]
      : item.literature_id;
  const literature = useQuery({
    queryKey: ["literature", id],
    queryFn: ({ signal }) => readLiterature(api, id!, signal),
    enabled: !!id,
  });
  const [expanded, setExpanded] = useState(false);
  return (
    <article className="retrieval-result" data-testid="retrieval-result">
      <p data-testid="retrieval-text">{textOf(item)}</p>
      <div className="retrieval-source">
        <span data-testid="retrieval-kind">
          {item.kind === "generated-result"
            ? item.processor_id === "knowledge-synthesis"
              ? "综合"
              : "知识"
            : item.kind === "metadata"
              ? "元数据"
              : "原文"}
        </span>
        <Button variant="text" data-testid="retrieval-source" onPress={onOpen}>
          {literature.data
            ? paperTitle(literature.data)
            : item.kind === "generated-result" &&
                item.processor_id === "knowledge-synthesis"
              ? "打开综合来源"
              : "打开来源文献"}
        </Button>
        <Button variant="text" onPress={() => setExpanded(!expanded)}>
          固定来源
        </Button>
        <Button
          data-testid="retrieval-basket"
          variant={selected ? "secondary" : "text"}
          onPress={onToggle}
        >
          {selected ? "已加入上下文" : "加入上下文"}
        </Button>
      </div>
      {expanded && <FixedSource item={item} onOpen={onOpen} />}
    </article>
  );
}
function FixedSource({
  item,
  onOpen,
}: {
  item: KnowledgeContextItem;
  onOpen: () => void;
}) {
  const api = useApi(),
    [next, setNext] = useState<string | null>(null),
    [requestNumber, setRequestNumber] = useState(0),
    [text, setText] = useState("");
  const fixed = item.reference;
  const read = useQuery({
    queryKey: ["retrieval-evidence", fixed, requestNumber],
    enabled: fixed.kind === "document",
    queryFn: async ({ signal }) => {
      if (fixed.kind !== "document") throw new Error("未知文档来源");
      const request = parseDocumentReadRequest("slice", {
        document_version_id: fixed.document_version_id,
        selector: {
          kind: "range",
          start_utf8: fixed.start_utf8,
          end_utf8: fixed.end_utf8,
        },
        max_bytes: 65536,
        continuation: next,
      });
      const result = parseDocumentReadResult(
        "slice",
        (await api.query("document-slice", request, signal)).result,
        request,
      );
      const expectedStart =
        fixed.start_utf8 + new TextEncoder().encode(text).byteLength;
      if (
        result.document.document_version_id !== fixed.document_version_id ||
        result.document.representation_sha256 !== fixed.representation_sha256 ||
        result.document.source_material_ref.literature_id !==
          fixed.literature_id ||
        result.document.source_material_ref.asset_id !== fixed.asset_id ||
        result.document.source_material_ref.asset_sha256 !==
          fixed.asset_sha256 ||
        !result.actual_range ||
        result.actual_range.start_utf8 !== expectedStart ||
        result.actual_range.end_utf8 > fixed.end_utf8 ||
        result.truncated !== result.actual_range.end_utf8 < fixed.end_utf8
      )
        throw new Error("固定来源版本或连续范围不匹配");
      return result;
    },
    refetchOnMount: false,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (read.data) {
      setText((current) => current + read.data!.text);
      setNext(read.data.continuation);
    }
  }, [read.data]);
  return (
    <div className="fixed-source">
      {fixed.kind === "document" && (
        <>
          {read.isPending ? <p role="status">正在读取固定范围…</p> : null}
          {read.isError && (
            <ErrorNotice
              message={errorMessage(read.error)}
              onRetry={() => void read.refetch()}
            />
          )}
          <p className="fixed-quote">{text}</p>
          {next && (
            <Button onPress={() => setRequestNumber((value) => value + 1)}>
              继续读取固定范围
            </Button>
          )}
        </>
      )}
      <Button variant="text" onPress={onOpen}>
        在原文核对
      </Button>
      <TechDetails>
        <pre>{JSON.stringify(item.reference, null, 2)}</pre>
      </TechDetails>
    </div>
  );
}
