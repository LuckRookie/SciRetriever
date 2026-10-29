import {
  parseDocumentReadRequest,
  parseDocumentReadResult,
  parseKnowledgeContextBundle,
  parseKnowledgeContextRequest,
  type KnowledgeContextItem,
  type KnowledgeContextRequest,
} from "@sciretriever/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { copyText } from "../../../browser-platform.js";
import {
  Button,
  Disclosure,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SearchField,
  SegmentedControl,
  Select,
  Skeleton,
  TechDetails,
  TextField,
  RichTitle,
} from "../../components/index.js";
import type { ApiClient } from "../../data/api.js";
import {
  paperTitleParts,
  readLiterature,
  scopeIds,
} from "../../data/library.js";
import { useApi } from "../../data/query.js";
import { sourceParameters } from "../../data/sources.js";
import { navigate, useUrlState } from "../../data/url.js";
import { useShell } from "../../shell/context.js";
import { errorMessage } from "../../strings.js";
import { download } from "../library/OperationDialog.js";
import {
  answerIndex,
  IndexLine,
  useIndexMark,
  useIndexStatus,
  type AnswerIndex,
} from "./IndexLine.js";
import "./retrieval.css";
// Saved operator results are searched here too; the list lives with the results.
const ResultList = lazy(() =>
  import("../processing/Results.js").then((module) => ({
    default: module.ResultList,
  })),
);

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
  /** Index the last answer was read from; the index line reads it. */
  answerIndex: AnswerIndex | null;
  /** Index state the last answer was read against. */
  indexMark: string | null;
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
  answerIndex: null,
  indexMark: null,
  generation: 0,
  technical: null,
});
const key = (item: KnowledgeContextItem) => JSON.stringify(item.reference);
const textOf = (item: KnowledgeContextItem) =>
  item.kind === "generated-result"
    ? item.text || "该结果超过本次预算，可打开完整结果。"
    : item.text;
export default function Retrieval() {
  const route = useUrlState(),
    // `results=all` on this page means saved operator results.
    mode = route.parameters.get("results") === "all" ? "results" : "text";
  const header = (
    <>
      <PageHeader title="全文检索" />
      <SegmentedControl
        label="检索内容"
        value={mode}
        onChange={(value) =>
          navigate(
            { results: value === "results" ? "all" : null },
            { replace: true },
          )
        }
        items={[
          { id: "text", label: "全文" },
          { id: "results", label: "算子结果" },
        ]}
      />
    </>
  );
  if (mode === "results")
    return (
      <section className="retrieval-page" data-mode="results">
        <div className="retrieval-main">
          {header}
          <Suspense fallback={<Skeleton />}>
            <ResultList />
          </Suspense>
        </div>
      </section>
    );
  return <TextRetrieval header={header} />;
}
function TextRetrieval({ header }: { header: ReactNode }) {
  const api = useApi(),
    shell = useShell(),
    route = useUrlState(),
    queries = useQueryClient();
  const [state, setState] = useState(() => sessions.get(api) ?? initial()),
    [busy, setBusy] = useState(false),
    [slow, setSlow] = useState(false),
    [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null),
    serial = useRef(0);
  const index = useIndexStatus(state.answerIndex),
    indexMark = useIndexMark();
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
    setSlow(false);
    setError(null);
    const slowTimer = setTimeout(() => {
      if (version === serial.current) setSlow(true);
    }, 3000);
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
      // The index line below the search box explains an index that is not
      // current; this line only describes the results themselves.
      const answer = answerIndex(bundle),
        indexed = answer !== "missing" && answer !== "corrupt";
      const mark = indexMark();
      setState((value) => {
        const items = append ? [...value.items, ...bundle.items] : bundle.items;
        return {
          ...value,
          current: request,
          next: bundle.continuation,
          items,
          generation: append ? value.generation : value.generation + 1,
          answerIndex: answer,
          indexMark: mark,
          status: `${items.length} 条结果${!items.length && indexed ? " · 未匹配当前关键词，可尝试原文用词或调整范围。" : bundle.truncated ? " · 当前结果包含部分片段，可以继续读取。" : ""}`,
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
      clearTimeout(slowTimer);
      if (version === serial.current && !controller.signal.aborted) {
        setBusy(false);
        setSlow(false);
        active.current = null;
      }
    }
  };
  const cancel = () => {
    serial.current++;
    active.current?.abort();
    active.current = null;
    setBusy(false);
    setSlow(false);
    setState((value) => ({
      ...value,
      status: value.current ? "检索已取消，保留上次结果。" : "检索已取消。",
    }));
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
        {header}
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
          {/\p{Script=Han}/u.test(state.draft.query) && (
            <p role="note" className="retrieval-note">
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
        <IndexLine
          status={index.data}
          answer={state.answerIndex}
          mark={state.indexMark}
          onSearchAgain={() => void run()}
        />
        <p
          role="status"
          className="retrieval-status"
          data-testid="retrieval-status"
        >
          {busy
            ? slow
              ? "仍在检索…"
              : "正在检索已有材料与知识…"
            : state.status}
          {slow && (
            <Button variant="text" size="compact" onPress={cancel}>
              取消
            </Button>
          )}
        </p>
        {error && (
          <ErrorNotice
            message={`检索未完成：${error}`}
            retained="保留上一次结果与已选择的上下文。"
            onRetry={() => run()}
          />
        )}
        <div className="retrieval-results" role="region" aria-label="检索结果">
          {groups(state.items).map((group) => (
            <section
              className="retrieval-group"
              key={`${state.generation}:${group.key}`}
            >
              <GroupTitle id={group.literature} />
              {group.items.map(({ item, index }) => (
                <Result
                  key={`${state.generation}:${key(item)}:${index}`}
                  item={item}
                  terms={terms(state.current?.query ?? "")}
                  selected={state.basket.has(key(item))}
                  onToggle={() => toggle(item)}
                  onOpen={() => open(item)}
                />
              ))}
            </section>
          ))}
          {!state.items.length && !busy && state.current && !error && (
            <EmptyState title="当前没有可显示的片段。可调整关键词或范围。" />
          )}
        </div>
        {state.next && (
          <Button isPending={busy} onPress={() => void run(true)}>
            继续查找
          </Button>
        )}
        <TechDetails>
          <pre>
            {JSON.stringify(
              { results: state.technical, index: index.data ?? null },
              null,
              2,
            )}
          </pre>
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
/** Consecutive hits from the same paper sit under one title. */
function groups(items: readonly KnowledgeContextItem[]) {
  const out: {
    key: string;
    literature: string | undefined;
    items: { item: KnowledgeContextItem; index: number }[];
  }[] = [];
  items.forEach((item, index) => {
    const literature = sourceOf(item);
    const last = out[out.length - 1];
    if (last && last.literature === literature && literature)
      last.items.push({ item, index });
    else
      out.push({
        key: `${literature ?? "none"}:${index}`,
        literature,
        items: [{ item, index }],
      });
  });
  return out;
}
const sourceOf = (item: KnowledgeContextItem) =>
  item.kind === "generated-result"
    ? item.source_literature_ids[0]
    : item.literature_id;
function GroupTitle({ id }: { id: string | undefined }) {
  const api = useApi();
  const literature = useQuery({
    queryKey: ["literature", id],
    queryFn: ({ signal }) => readLiterature(api, id!, signal),
    enabled: !!id,
  });
  return (
    <h2 className="retrieval-group-title">
      {literature.data ? (
        <RichTitle parts={paperTitleParts(literature.data)} />
      ) : id ? (
        "…"
      ) : (
        "综合结果"
      )}
    </h2>
  );
}
const terms = (query: string) =>
  query
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
/** Marks every query term in the hit, in the evidence yellow; headings lose their “#”. */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  const plain = text.replace(/^#{1,6}[ \t]+/gmu, "").trimEnd();
  if (!terms.length) return <>{plain}</>;
  const pattern = new RegExp(
    `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})`,
    "giu",
  );
  return (
    <>
      {plain.split(pattern).map((part, index) =>
        index % 2 ? (
          <mark key={index} className="retrieval-hit">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}
function Result({
  item,
  terms,
  selected,
  onToggle,
  onOpen,
}: {
  item: KnowledgeContextItem;
  terms: string[];
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article className="retrieval-result" data-testid="retrieval-result">
      <p data-testid="retrieval-text">
        <Highlighted text={textOf(item)} terms={terms} />
      </p>
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
          {item.kind === "generated-result" ? "打开结果" : "在原文中查看"}
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
