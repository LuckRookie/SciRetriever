import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  memo,
} from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import {
  parseLibrarySearchRequest,
  type LibraryQuery,
  type LibrarySort,
  type LiteratureSearchItem,
} from "@sciretriever/contracts";
import {
  Button,
  Checkbox,
  Dialog,
  Drawer,
  EmptyState,
  ErrorNotice,
  FilterChip,
  ChipGroup,
  PageHeader,
  SearchField,
  Select,
  TextField,
  TechDetails,
} from "../../components/index.js";
import { AnimatedPanel, Presence, LayoutGroup } from "../../motion/index.js";
import type { ApiClient } from "../../data/api.js";
import { useApi } from "../../data/query.js";
import { useUrlState, navigate } from "../../data/url.js";
import { preferences } from "../../data/preferences.js";
import {
  emptyQuery,
  paperAuthors,
  paperTitle,
  readLiterature,
  searchLibrary,
  scopeIds,
} from "../../data/library.js";
import { useShell } from "../../shell/context.js";
import { randomId } from "../../../browser-platform.js";
import { errorMessage, statusLabels } from "../../strings.js";
import { OperationDialog } from "./OperationDialog.js";

const scrollPositions = new WeakMap<ApiClient, Map<string, number>>();
const rowMeasurements = new WeakMap<ApiClient, Map<string, VirtualItem[]>>();
interface SavedView {
  id: string;
  name: string;
  query: LibraryQuery;
  sort: LibrarySort;
}
function loadViews(key: string): SavedView[] {
  try {
    const values: unknown = JSON.parse(preferences.read(key) ?? "[]");
    if (!Array.isArray(values)) return [];
    return values.slice(0, 50).map((value: unknown) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("id" in value) ||
        !("name" in value) ||
        !("query" in value) ||
        !("sort" in value) ||
        typeof value.id !== "string" ||
        typeof value.name !== "string"
      )
        throw new Error("invalid saved view");
      const request = parseLibrarySearchRequest({
        query: value.query,
        sort: value.sort,
      });
      return {
        id: value.id,
        name: value.name.slice(0, 100),
        query: request.query,
        sort: request.sort,
      };
    });
  } catch {
    return [];
  }
}
export default function Library() {
  const api = useApi(),
    shell = useShell(),
    route = useUrlState();
  const queryString = JSON.stringify(route.query);
  const scrollKey = `${queryString}:${route.sort}`;
  if (!scrollPositions.has(api)) scrollPositions.set(api, new Map());
  if (!rowMeasurements.has(api)) rowMeasurements.set(api, new Map());
  const positions = scrollPositions.get(api)!;
  const measurements = rowMeasurements.get(api)!;
  const chips = Object.entries(route.query).flatMap(([key, value]) => {
    const names: Record<string, string> = {
      text: "搜索",
      author: "作者",
      venue: "期刊",
      keywords: "关键词",
      identifiers: "标识符",
      publication_year_from: "起始年份",
      publication_year_to: "结束年份",
      statuses: "状态",
      needs_manual_pdf: "无法获取",
    };
    if (
      value === null ||
      value === false ||
      (Array.isArray(value) && !value.length)
    )
      return [];
    const label =
      key === "identifiers"
        ? route.query.identifiers.map((id) => id.value).join("、")
        : key === "statuses"
          ? route.query.statuses
              .map((status) => statusLabels[status])
              .join("、")
          : Array.isArray(value)
            ? value.join("、")
            : String(value);
    return [
      {
        key,
        label: `${names[key] ?? key}：${label}`,
        clear: () =>
          updateQuery({
            ...route.query,
            [key]: Array.isArray(value) ? [] : null,
          }),
      },
    ];
  });
  const [text, setText] = useState(route.query.text ?? "");
  const [filters, setFilters] = useState(false);
  const [mobileTools, setMobileTools] = useState(false);
  const [viewName, setViewName] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const preferenceKey = `sciretriever:library-views:v1:${api.workspace.catalog ?? "unbound"}`;
  const [views, setViews] = useState(() => loadViews(preferenceKey));
  const [activeView, setActiveView] = useState("");
  const [peek, setPeek] = useState<string | null>(null);
  const [operation, setOperation] = useState<{
    ids: string[];
    kind: string;
    file?: File;
  } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [chooseOpen, setChooseOpen] = useState(false);
  const [scope, setScope] = useState<string[]>([]);
  const next = useInfiniteQuery({
    queryKey: ["library", route.query, route.sort],
    queryFn: ({ pageParam, signal }) =>
      searchLibrary(api, route.query, route.sort, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.cursor,
    placeholderData: keepPreviousData,
    enabled: api.workspace.readiness === "ready",
  });
  const items = useMemo(
    () => [
      ...new Map(
        next.data?.pages
          .flatMap((page) => page.items)
          .map((item) => [item.literature.literature_id, item]) ?? [],
      ).values(),
    ],
    [next.data],
  );
  const total = next.data?.pages[0]?.total ?? 0;
  const updateQuery = (query: LibraryQuery, sort = route.sort) =>
    navigate({ query: JSON.stringify(query), sort }, { replace: true });
  useEffect(() => {
    setText(route.query.text ?? "");
  }, [route.query.text]);
  useEffect(() => {
    if (text.trim() === (route.query.text ?? "")) return;
    const timer = setTimeout(
      () =>
        navigate(
          {
            query: JSON.stringify({
              ...route.query,
              text: text.trim() || null,
            }),
          },
          { replace: true },
        ),
      300,
    );
    return () => clearTimeout(timer);
  }, [text, route.query]);
  const toggle = useCallback(
    (id: string) => {
      const selected = new Set(shell.selected);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      shell.setSelected(selected);
    },
    [shell],
  );
  const choose = async (selected = false) => {
    if (choosing) return;
    setChoosing(true);
    try {
      const ids = selected
        ? [...shell.selected]
        : await scopeIds(api, route.query, route.sort);
      setScope(ids);
      setChooseOpen(true);
    } catch (error) {
      shell.notify(errorMessage(error));
    } finally {
      setChoosing(false);
    }
  };
  const pick = (kind: string) => {
    setChooseOpen(false);
    if (["ext", "syn"].includes(kind)) {
      shell.setSelected(new Set(scope));
      navigate({ view: kind, literature: null }, { clearSource: true });
    } else setOperation({ ids: scope, kind });
  };
  const preview = useQuery({
    queryKey: ["literature", peek],
    queryFn: ({ signal }) => readLiterature(api, peek!, signal),
    enabled: peek !== null,
  });
  const onFile = useCallback(
    (id: string, file: File) =>
      setOperation({ ids: [id], kind: "upload", file }),
    [],
  );
  const mutable = api.kind === "workspace";
  const toolbarActions = (
    <>
      <Select
        label="材料状态"
        value={
          route.query.needs_manual_pdf
            ? "failed"
            : (route.query.statuses[0] ?? "")
        }
        onChange={(value) =>
          updateQuery(
            parseLibrarySearchRequest({
              query: {
                ...route.query,
                statuses: value && value !== "failed" ? [value] : [],
                needs_manual_pdf: value === "failed" ? true : null,
              },
            }).query,
          )
        }
        options={[
          { value: "", label: "全部状态" },
          { value: "UNREVIEWED", label: "仅元数据" },
          { value: "ASSET_READY", label: "有 PDF" },
          { value: "CONTENT_READY", label: "内容已就绪" },
          { value: "failed", label: "无法获取" },
        ]}
      />
      <Button
        onPress={() => {
          setFilters(!filters);
          setMobileTools(false);
        }}
      >
        筛选{chips.length ? ` · ${chips.length}` : ""}
        {filters ? " · 收起" : ""}
      </Button>
      {mutable && (
        <Button
          isPending={choosing}
          disabledReason={
            next.isPlaceholderData
              ? "正在更新筛选结果…"
              : total > 1000
                ? `当前 ${total.toLocaleString()} 篇，超过 1,000 篇上限，请先筛选或选择。`
                : total === 0
                  ? "请先添加或选择文献。"
                  : undefined
          }
          onPress={() => {
            setMobileTools(false);
            void choose();
          }}
        >
          用这些文献做…
        </Button>
      )}
    </>
  );
  if (api.workspace.readiness !== "ready")
    return (
      <section className="library-page">
        <PageHeader
          title="文献库"
          description="此入口只读取已经保存的文献材料。"
        />
        <EmptyState
          title={
            api.workspace.readiness === "not-initialized"
              ? "文献库尚未初始化"
              : "文献库暂不可用"
          }
          description="只读查询不会创建、迁移或修复数据库。请先通过显式维护准备文献库。"
        />
      </section>
    );
  return (
    <section className="library-page">
      <PageHeader
        title="文献库"
        description="从同一份材料出发，查找、阅读与使用文献。"
        action={
          mutable ? (
            <Button
              variant="primary"
              onPress={() => navigate({ view: "disc", literature: null })}
            >
              入库
            </Button>
          ) : undefined
        }
      />
      <div className="library-toolbar">
        <SearchField
          label="搜索文献"
          value={text}
          onChange={setText}
          onSubmit={(value) =>
            updateQuery({ ...route.query, text: value.trim() || null })
          }
          placeholder="按标题、作者、期刊搜索"
        />
        <div className="library-toolbar-actions">{toolbarActions}</div>
        <Button className="library-more" onPress={() => setMobileTools(true)}>
          更多操作
        </Button>
      </div>
      <div className="saved-views" aria-label="已保存的筛选">
        <FilterChip
          isSelected={!activeView && !chips.length}
          onChange={() => {
            setActiveView("");
            updateQuery(emptyQuery());
          }}
        >
          全部
        </FilterChip>
        {views.map((view) => (
          <FilterChip
            key={view.id}
            isSelected={activeView === view.id}
            onChange={() => {
              setActiveView(view.id);
              updateQuery(view.query, view.sort);
            }}
          >
            {view.name}
          </FilterChip>
        ))}
        <Button variant="text" onPress={() => setSaveOpen(true)}>
          保存当前筛选
        </Button>
        {activeView && (
          <Button
            variant="text"
            onPress={() => {
              const values = views.filter((view) => view.id !== activeView);
              setViews(values);
              preferences.write(preferenceKey, JSON.stringify(values));
              setActiveView("");
            }}
          >
            删除已保存筛选
          </Button>
        )}
      </div>
      {chips.length > 0 && (
        <ChipGroup label="当前筛选">
          {chips.map((chip) => (
            <FilterChip
              key={chip.key}
              isSelected
              onChange={chip.clear}
              onRemove={chip.clear}
            >
              {chip.label}
            </FilterChip>
          ))}
        </ChipGroup>
      )}
      <Presence>
        {filters && (
          <AnimatedPanel key="filters" preset="collapse">
            <Filters
              key={queryString}
              query={route.query}
              onApply={(query) => {
                updateQuery(query);
                setFilters(false);
              }}
            />
          </AnimatedPanel>
        )}
      </Presence>
      <LayoutGroup className="library-results-region">
        <div className="library-list-heading">
          <Checkbox
            label="选择已加载的文献"
            isIndeterminate={
              items.some((item) =>
                shell.selected.has(item.literature.literature_id),
              ) &&
              !items.every((item) =>
                shell.selected.has(item.literature.literature_id),
              )
            }
            isSelected={
              items.length > 0 &&
              items.every((item) =>
                shell.selected.has(item.literature.literature_id),
              )
            }
            onChange={(checked) => {
              const selected = new Set(shell.selected);
              for (const item of items) {
                if (checked) selected.add(item.literature.literature_id);
                else selected.delete(item.literature.literature_id);
              }
              shell.setSelected(selected);
            }}
          />
          <span role="status">
            {next.isPending
              ? "正在读取文献…"
              : `已显示 ${items.length.toLocaleString()} / 共 ${total.toLocaleString()} 篇`}
          </span>
          <Select
            label="排序"
            value={route.sort}
            onChange={(sort) =>
              updateQuery(
                route.query,
                parseLibrarySearchRequest({ query: route.query, sort }).sort,
              )
            }
            options={[
              { value: "publication-year-desc", label: "年份：新到旧" },
              { value: "publication-year-asc", label: "年份：旧到新" },
              { value: "title-asc", label: "标题：A–Z" },
              { value: "title-desc", label: "标题：Z–A" },
              { value: "relevance", label: "相关性" },
            ]}
          />
        </div>
        {next.isError && (
          <ErrorNotice
            message={errorMessage(next.error)}
            onRetry={() => void next.refetch()}
          />
        )}
        <LibraryList
          items={items}
          selected={shell.selected}
          mutable={mutable}
          scrollKey={scrollKey}
          positions={positions}
          measurements={measurements}
          pending={next.isPending}
          fetching={next.isFetching}
          failed={next.isError}
          placeholder={next.isPlaceholderData}
          hasNextPage={next.hasNextPage}
          fetchingNextPage={next.isFetchingNextPage}
          nextPageFailed={next.isFetchNextPageError}
          loadNextPage={next.fetchNextPage}
          onToggle={toggle}
          onOpen={shell.openPaper}
          onPreview={setPeek}
          onFile={onFile}
        />
      </LayoutGroup>
      <Presence>
        {shell.selected.size > 0 && (
          <AnimatedPanel
            key="selection"
            preset="toast"
            className="selection-wrap"
          >
            <div className="selection-bar" role="region" aria-label="文献选择">
              <b>已选 {shell.selected.size} 篇</b>
              {
                <Button
                  onPress={() => void choose(true)}
                  disabledReason={
                    shell.selected.size > 1000
                      ? "最多处理 1,000 篇，请减少选择。"
                      : undefined
                  }
                >
                  用这些文献做…
                </Button>
              }
              <Button
                variant="text"
                onPress={() => shell.setSelected(new Set())}
              >
                取消选择
              </Button>
            </div>
          </AnimatedPanel>
        )}
      </Presence>
      <Dialog
        title="保存筛选"
        isOpen={saveOpen}
        onOpenChange={setSaveOpen}
        footer={
          <Button
            variant="primary"
            onPress={() => {
              if (!viewName.trim()) return;
              const values = [
                ...views,
                {
                  id: randomId(),
                  name: viewName.trim().slice(0, 100),
                  query: route.query,
                  sort: route.sort,
                },
              ].slice(-50);
              setViews(values);
              preferences.write(preferenceKey, JSON.stringify(values));
              setSaveOpen(false);
              setViewName("");
            }}
          >
            保存
          </Button>
        }
      >
        <TextField label="筛选名称" value={viewName} onChange={setViewName} />
      </Dialog>
      <Dialog
        title="使用所选文献"
        isOpen={chooseOpen}
        onOpenChange={setChooseOpen}
      >
        <p>范围已固定：{scope.length} 篇文献。</p>
        <div className="action-grid">
          {[
            ["acquire", "获取 PDF"],
            ["parse", "解析"],
            ["analyze", "分析"],
            ["identity", "核验身份"],
            ["syn", "集合综合"],
            ["ext", "提取与标签"],
            ["export", "导出书目"],
          ]
            .filter(([id]) => mutable || id === "export")
            .map(([id, label]) => (
              <Button key={id} onPress={() => pick(id!)}>
                {label}
              </Button>
            ))}
        </div>
      </Dialog>
      <Drawer
        title="文献库操作"
        isOpen={mobileTools}
        onOpenChange={setMobileTools}
      >
        <div className="library-mobile-tools">{toolbarActions}</div>
      </Drawer>
      <Drawer
        title="文献预览"
        isOpen={peek !== null}
        onOpenChange={(open) => {
          if (!open) setPeek(null);
        }}
      >
        {preview.isPending ? (
          <p role="status">正在读取…</p>
        ) : preview.isError ? (
          <ErrorNotice
            message={errorMessage(preview.error)}
            onRetry={() => void preview.refetch()}
          />
        ) : (
          preview.data && (
            <>
              <h2>{paperTitle(preview.data)}</h2>
              <p>{paperAuthors(preview.data)}</p>
              <p>
                {preview.data.literature.metadata.abstract ?? "尚未提供摘要。"}
              </p>
              <Button
                onPress={() => {
                  shell.openPaper(
                    peek!,
                    "pdf",
                    undefined,
                    paperTitle(preview.data!),
                  );
                  setPeek(null);
                }}
              >
                打开阅读
              </Button>
              <TechDetails>
                <pre>{JSON.stringify(preview.data.literature, null, 2)}</pre>
              </TechDetails>
            </>
          )
        )}
      </Drawer>
      {operation && (
        <OperationDialog {...operation} onClose={() => setOperation(null)} />
      )}
    </section>
  );
}
/** Scroll-range updates belong to the list, not the page's forms and motion layout. */
const LibraryList = memo(function LibraryList({
  items,
  selected,
  mutable,
  scrollKey,
  positions,
  measurements,
  pending,
  fetching,
  failed,
  placeholder,
  hasNextPage,
  fetchingNextPage,
  nextPageFailed,
  loadNextPage,
  onToggle,
  onOpen,
  onPreview,
  onFile,
}: {
  items: readonly LiteratureSearchItem[];
  selected: ReadonlySet<string>;
  mutable: boolean;
  scrollKey: string;
  positions: Map<string, number>;
  measurements: Map<string, VirtualItem[]>;
  pending: boolean;
  fetching: boolean;
  failed: boolean;
  placeholder: boolean;
  hasNextPage: boolean;
  fetchingNextPage: boolean;
  nextPageFailed: boolean;
  loadNextPage: () => Promise<unknown>;
  onToggle: (id: string) => void;
  onOpen: ReturnType<typeof useShell>["openPaper"];
  onPreview: (id: string) => void;
  onFile: (id: string, file: File) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const getScrollElement = useCallback(() => scroll.current, []);
  const getItemKey = useCallback(
    (index: number) => items[index]!.literature.literature_id,
    [items],
  );
  const initial = useMemo(
    () => ({
      offset: positions.get(scrollKey) ?? 0,
      measurements: measurements.get(scrollKey) ?? [],
    }),
    [positions, measurements, scrollKey],
  );
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement,
    // Keep the scroll range and row positions in the same measured commit.
    directDomUpdates: true,
    estimateSize: estimateRowSize,
    overscan: 6,
    initialOffset: initial.offset,
    initialMeasurementsCache: initial.measurements,
    getItemKey,
  });
  const rows = virtual.getVirtualItems(),
    last = rows.at(-1)?.index ?? -1;
  useEffect(() => {
    if (
      last >= items.length - 6 &&
      hasNextPage &&
      !fetching &&
      !failed &&
      !placeholder
    )
      void loadNextPage();
  }, [
    last,
    items.length,
    hasNextPage,
    fetching,
    failed,
    placeholder,
    loadNextPage,
  ]);
  useLayoutEffect(() => {
    scroll.current?.scrollTo({ top: positions.get(scrollKey) ?? 0 });
  }, [scrollKey, positions]);
  const onMove = useCallback(
    (index: number) => {
      const target = Math.max(0, Math.min(items.length - 1, index));
      virtual.scrollToIndex(target);
      requestAnimationFrame(() =>
        scroll.current
          ?.querySelector<HTMLElement>(`[data-index="${target}"]`)
          ?.focus(),
      );
    },
    [virtual, items.length],
  );
  return (
    <div
      className="library-scroll"
      ref={scroll}
      aria-label="文献列表"
      tabIndex={-1}
      aria-busy={fetching}
      onScroll={(event) => {
        positions.set(scrollKey, event.currentTarget.scrollTop);
        measurements.set(scrollKey, virtual.measurementsCache.slice());
      }}
    >
      {!pending && !items.length && (
        <EmptyState
          title="没有符合条件的文献"
          description="调整筛选，或从入库添加文献。"
        />
      )}
      <div className="virtual-list" ref={virtual.containerRef}>
        {rows.map((row) => (
          <LibraryRow
            key={row.key}
            row={row}
            item={items[row.index]!}
            selected={selected.has(items[row.index]!.literature.literature_id)}
            mutable={mutable}
            measure={virtual.measureElement}
            onToggle={onToggle}
            onOpen={onOpen}
            onPreview={onPreview}
            onFile={onFile}
            onMove={onMove}
          />
        ))}
      </div>
      {fetchingNextPage && <p role="status">正在读取下一批…</p>}
      {nextPageFailed && (
        <Button onPress={() => void loadNextPage()}>重试读取下一批</Button>
      )}
    </div>
  );
});
const estimateRowSize = () => 116;

const LibraryRow = memo(function LibraryRow({
  row,
  item,
  selected,
  mutable,
  measure,
  onToggle,
  onOpen,
  onPreview,
  onFile,
  onMove,
}: {
  row: VirtualItem;
  item: LiteratureSearchItem;
  selected: boolean;
  mutable: boolean;
  measure: (element: HTMLElement | null) => void;
  onToggle: (id: string) => void;
  onOpen: ReturnType<typeof useShell>["openPaper"];
  onPreview: (id: string) => void;
  onFile: (id: string, file: File) => void;
  onMove: (index: number) => void;
}) {
  const id = item.literature.literature_id,
    title = paperTitle(item);
  return (
    <article
      ref={measure}
      data-literature-id={id}
      data-index={row.index}
      data-selected={selected || undefined}
      className="paper-row"
      style={{ transform: `translateY(${row.start}px)` }}
      tabIndex={0}
      aria-label={title}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === " ") {
          event.preventDefault();
          onToggle(id);
        } else if (event.key === "Enter") onOpen(id, "pdf", undefined, title);
        else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          onMove(row.index + (event.key === "ArrowDown" ? 1 : -1));
        }
      }}
      onDragOver={(event) => {
        if (mutable) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        if (mutable && file) onFile(id, file);
      }}
    >
      <Checkbox
        aria-label={`选择 ${title}`}
        isSelected={selected}
        onChange={() => onToggle(id)}
      />
      <button
        className="paper-open"
        onClick={() => onOpen(id, "pdf", undefined, title)}
      >
        <span className="paper-title">{title}</span>
        <span className="paper-citation">
          {paperAuthors(item)} ·{" "}
          <i>{item.literature.metadata.venue ?? "期刊未提供"}</i> ·{" "}
          {item.literature.metadata.publication_year ?? "年份未提供"}
        </span>
      </button>
      <span className="paper-status" data-state={item.literature.status}>
        {item.needs_manual_pdf
          ? "无法获取"
          : statusLabels[item.literature.status]}
      </span>
      <Button size="compact" variant="text" onPress={() => onPreview(id)}>
        预览
      </Button>
    </article>
  );
});

function Filters({
  query,
  onApply,
}: {
  query: LibraryQuery;
  onApply: (query: LibraryQuery) => void;
}) {
  const [from, setFrom] = useState(String(query.publication_year_from ?? "")),
    [to, setTo] = useState(String(query.publication_year_to ?? "")),
    [author, setAuthor] = useState(query.author ?? ""),
    [venue, setVenue] = useState(query.venue ?? ""),
    [keyword, setKeyword] = useState(query.keywords[0] ?? ""),
    [doi, setDoi] = useState(
      query.identifiers.find((id) => id.namespace === "doi")?.value ?? "",
    ),
    [error, setError] = useState("");
  return (
    <form
      className="library-filters"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          onApply(
            parseLibrarySearchRequest({
              query: {
                ...query,
                publication_year_from: from ? Number(from) : null,
                publication_year_to: to ? Number(to) : null,
                author: author || null,
                venue: venue || null,
                keywords: keyword ? [keyword] : [],
                identifiers: doi ? [{ namespace: "doi", value: doi }] : [],
              },
            }).query,
          );
        } catch (error) {
          setError(errorMessage(error));
        }
      }}
    >
      <TextField
        label="年份起"
        value={from}
        onChange={setFrom}
        placeholder="如 2015"
      />
      <TextField
        label="年份止"
        value={to}
        onChange={setTo}
        placeholder="如 2026"
      />
      <TextField
        label="作者"
        value={author}
        onChange={setAuthor}
        placeholder="作者姓名"
      />
      <TextField
        label="期刊"
        value={venue}
        onChange={setVenue}
        placeholder="期刊或会议名称"
      />
      <TextField
        label="关键词"
        value={keyword}
        onChange={setKeyword}
        placeholder="文献关键词"
      />
      <TextField label="DOI" value={doi} onChange={setDoi} placeholder="10.…" />
      {error && <p role="alert">{error}</p>}
      <div className="form-actions">
        <Button variant="text" onPress={() => onApply(emptyQuery())}>
          清除筛选
        </Button>
        <Button type="submit">应用筛选</Button>
      </div>
    </form>
  );
}
