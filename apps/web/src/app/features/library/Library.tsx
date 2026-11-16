import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  memo,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import {
  ARTICLE_KIND_LABELS,
  PUBLICATION_FORM_LABELS,
  parseLibrarySearchRequest,
  type LibraryQuery,
  type LibrarySort,
  type TextLevel,
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
  Icon,
  IconButton,
  Menu,
  PageHeader,
  SearchField,
  Select,
  Switch,
  TextField,
  TechDetails,
  RichTitle,
} from "../../components/index.js";
import { AnimatedPanel, Presence, LayoutGroup } from "../../motion/index.js";
import type { ApiClient } from "../../data/api.js";
import { useApi } from "../../data/query.js";
import { useUrlState, navigate } from "../../data/url.js";
import {
  emptyQuery,
  paperAuthors,
  paperTitle,
  paperTitleParts,
  readLibraryCounts,
  readLiterature,
  searchLibrary,
  scopeIds,
  scopeItems,
  SORT_LABELS,
  LIBRARY_MENU_SORTS,
} from "../../data/library.js";
import { useIntakeBatch } from "../../data/intake-batches.js";
import { AcquireDialog, type AcquireScope } from "./AcquireDialog.js";
import { ScopeTerms } from "./ScopeTerms.js";
import { useShell } from "../../shell/context.js";
import { archiveQuery, useArchiveAction, rows } from "../../data/archive.js";
import { record } from "../../data/wire.js";
import { archiveReason, errorMessage, statusLabels } from "../../strings.js";
import { OperationDialog } from "./OperationDialog.js";
import {
  SELECTION_GROUPS,
  groupSelection,
  useRangeSelection,
  type SelectionGroup,
} from "./selection.js";
import {
  AddToFolderDialog,
  LITERATURE_DRAG,
  folderPaths,
  scopeQuery,
  useFolders,
} from "./Folders.js";
import { manageFolder } from "../../data/folders.js";
import {
  browserFilters,
  createFilter,
  deleteFilter,
  importFilters,
  listFilters,
  markBrowserFilters,
  updateFilter,
} from "../../data/saved-filters.js";
import {
  RunOperatorDialog,
  type OperatorScope,
} from "../processing/RunOperator.js";

const scrollPositions = new WeakMap<ApiClient, Map<string, number>>();
const rowMeasurements = new WeakMap<ApiClient, Map<string, VirtualItem[]>>();
/** Text levels in words (page specs “文献库”, reading-experience 3.4). */
export const TEXT_LEVEL_LABELS = {
  draft: "初稿",
  proofread: "校订稿",
} as const satisfies Record<TextLevel, string>;
/**
 * The draft mark on a row; sorted by a draft fact, followed by its count
 * (page specs “文献库”): “初稿 · 差异 12 段”, “初稿 · 扫描 3 页”.
 */
function draftNote(item: LiteratureSearchItem, sort: LibrarySort) {
  const facts = item.draft_facts;
  if (facts && sort === "draft-differences-desc")
    return `初稿 · 差异 ${facts.differs_segments} 段`;
  if (facts && sort === "image-only-pages-desc")
    return `初稿 · 扫描 ${facts.image_only_pages} 页`;
  return "初稿";
}
export default function Library() {
  const api = useApi(),
    shell = useShell(),
    route = useUrlState();
  const archiveAction = useArchiveAction();
  const queries = useQueryClient();
  const queryString = JSON.stringify(route.query);
  const scrollKey = `${queryString}:${route.sort}`;
  if (!scrollPositions.has(api)) scrollPositions.set(api, new Map());
  if (!rowMeasurements.has(api)) rowMeasurements.set(api, new Map());
  const positions = scrollPositions.get(api)!;
  const measurements = rowMeasurements.get(api)!;
  const batchId =
    route.query.intake_batch_ids.length === 1
      ? route.query.intake_batch_ids[0]!
      : null;
  const batch = useIntakeBatch(batchId);
  const chips = Object.entries(route.query).flatMap(([key, value]) => {
    const names: Record<string, string> = {
      text: "搜索",
      author: "作者",
      venue: "期刊",
      keywords: "作者关键词",
      subject_terms: "主题词",
      intake_batch_ids: "入库批次",
      identifiers: "标识符",
      publication_year_from: "起始年份",
      publication_year_to: "结束年份",
      statuses: "状态",
      publication_forms: "出版形式",
      article_kinds: "文章性质",
      tags: "标签",
      needs_manual_pdf: "无法获取",
      text_levels: "文本等级",
      has_draft_differences: "初稿与文字层有差异",
      has_image_only_pages: "含扫描页",
    };
    // Folder and "recently read" are the page's scope, shown in its title.
    if (
      key === "folder" ||
      key === "recently_opened" ||
      value === null ||
      (value === false &&
        key !== "has_draft_differences" &&
        key !== "has_image_only_pages") ||
      (Array.isArray(value) && !value.length)
    )
      return [];
    if (key === "tags" && !route.query.tags?.ids.length) return [];
    const label =
      key === "intake_batch_ids"
        ? route.query.intake_batch_ids.length === 1
          ? (batch.data?.label ?? "…")
          : `${route.query.intake_batch_ids.length} 批`
        : key === "tags"
          ? `${route.query.tags!.ids.length} 个${route.query.tags!.mode === "primary" ? "主标签" : "标签"}`
          : key === "identifiers"
            ? route.query.identifiers.map((id) => id.value).join("、")
            : key === "statuses"
              ? route.query.statuses
                  .map((status) => statusLabels[status])
                  .join("、")
              : key === "text_levels"
                ? (route.query.text_levels ?? [])
                    .map((level) => TEXT_LEVEL_LABELS[level])
                    .join("、")
                : key === "has_draft_differences" ||
                    key === "has_image_only_pages"
                  ? value
                    ? "有"
                    : "没有"
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
            [key]:
              key === "tags"
                ? { ids: [], mode: "any" }
                : Array.isArray(value)
                  ? []
                  : null,
          }),
      },
    ];
  });
  /** The current filter in words, for dialogs that act on all of it. */
  const scopeLabel = () =>
    [
      folderLabel ? `文件夹：${folderLabel}` : "",
      route.query.recently_opened ? "最近阅读" : "",
      ...chips.map((chip) => chip.label),
    ]
      .filter(Boolean)
      .join("；") || "全部文献";
  const [text, setText] = useState(route.query.text ?? "");
  const [filters, setFilters] = useState(false);
  const [mobileTools, setMobileTools] = useState(false);
  const [viewName, setViewName] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  // User organization 9.1: saved filters live in the catalog, read and
  // written through the service; this browser's old ones are only imported.
  const catalog = api.workspace.catalog;
  const savedFilters = useQuery({
    queryKey: ["filters", catalog],
    queryFn: ({ signal }) => listFilters(api, signal),
  });
  const views = savedFilters.data ?? [];
  const [activeView, setActiveView] = useState("");
  const [browserTick, setBrowserTick] = useState(0);
  const pendingImport = useMemo(
    () => (api.kind === "workspace" ? browserFilters(catalog) : []),
    // `browserTick` re-reads this browser's data after an import.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, api.kind, browserTick],
  );
  const [importReport, setImportReport] = useState<
    | {
        name: string;
        status: string;
        result: string | null;
        reason: string | null;
      }[]
    | null
  >(null);
  const refreshFilters = () =>
    void queries.invalidateQueries({ queryKey: ["filters", catalog] });
  const importBrowserFilters = async () => {
    try {
      const report: NonNullable<typeof importReport> = [];
      // At most 200 items a call (user organization 9.1).
      for (let at = 0; at < pendingImport.length; at += 200) {
        const batch = pendingImport.slice(at, at + 200);
        const results = await importFilters(
          api,
          batch.map((entry) => entry.item),
        );
        markBrowserFilters(
          catalog,
          results.map((r) => ({
            index: batch[r.index]!.index,
            status: r.status,
          })),
        );
        for (const r of results)
          report.push({
            name: batch[r.index]!.name,
            status: r.status,
            result: r.filter?.name ?? null,
            reason: r.reason,
          });
      }
      setBrowserTick((value) => value + 1);
      refreshFilters();
      setImportReport(report);
    } catch (error) {
      // Said as it is; nothing falls back to this browser's storage.
      shell.notify(errorMessage(error));
    }
  };
  const [peek, setPeek] = useState<string | null>(null);
  const [operation, setOperation] = useState<{
    ids: string[];
    kind: string;
    file?: File;
  } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [acquire, setAcquire] = useState<AcquireScope | null>(null);
  // Set when “select all N” took the whole filter; acquisition then submits the filter itself.
  const [wholeScope, setWholeScope] = useState<{
    key: string;
    size: number;
  } | null>(null);
  const [runner, setRunner] = useState<{
    scope: OperatorScope;
    label: string;
  } | null>(null);
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
  // Statuses seen in this session, so a selection made across scrolls and
  // filters can still be split into what each batch action applies to.
  const known = useRef(new Map<string, LiteratureSearchItem>()).current;
  for (const item of items) known.set(item.literature.literature_id, item);
  const range = useRangeSelection({
    items,
    selected: shell.selected,
    setSelected: shell.setSelected,
  });
  const counts = useQuery({
    queryKey: ["library", "counts", route.query],
    queryFn: ({ signal }) => readLibraryCounts(api, route.query, signal),
    placeholderData: keepPreviousData,
    enabled: api.workspace.readiness === "ready",
  });
  const countFor = (filter: string) =>
    counts.data
      ? filter === ""
        ? counts.data.total
        : filter === "failed"
          ? counts.data.unavailable_pdf
          : (counts.data.statuses[
              filter as keyof typeof counts.data.statuses
            ] ?? 0)
      : null;
  const folders = useFolders();
  const folder = route.query.folder ?? null;
  const folderLabel = folder
    ? (folderPaths(folders.data?.items ?? []).find(
        (path) => path.id === folder.id,
      )?.label ?? "文件夹")
    : null;
  const [adding, setAdding] = useState<string[] | null>(null);
  const updateQuery = (query: LibraryQuery, sort = route.sort) =>
    navigate({ query: JSON.stringify(query), sort }, { replace: true });
  const statusFilter = route.query.needs_manual_pdf
    ? "failed"
    : (route.query.statuses[0] ?? "");
  const setStatusFilter = (value: string) =>
    updateQuery(
      parseLibrarySearchRequest({
        query: {
          ...route.query,
          statuses: value && value !== "failed" ? [value] : [],
          needs_manual_pdf: value === "failed" ? true : null,
        },
      }).query,
    );
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
      if (range.handledByPress()) return;
      const selected = new Set(shell.selected);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      shell.setSelected(selected);
      range.remember(id);
    },
    [shell, range],
  );
  /** Material operations act on fixed ids: the selection, or the current results. */
  const operate = async (kind: string, selected: boolean) => {
    if (choosing) return;
    setChoosing(true);
    try {
      const ids = selected
        ? [...shell.selected]
        : await scopeIds(api, route.query, route.sort);
      setOperation({ ids, kind });
    } catch (error) {
      shell.notify(errorMessage(error));
    } finally {
      setChoosing(false);
    }
  };
  /** “Select all” beyond the loaded rows reads the whole scope once, statuses included. */
  const selectScope = async () => {
    if (choosing) return;
    setChoosing(true);
    try {
      const all = await scopeItems(api, route.query, route.sort);
      setWholeScope({ key: scrollKey, size: all.length });
      const selected = new Set(shell.selected);
      for (const item of all) {
        known.set(item.literature.literature_id, item);
        selected.add(item.literature.literature_id);
      }
      shell.setSelected(selected);
    } catch (error) {
      shell.notify(errorMessage(error));
    } finally {
      setChoosing(false);
    }
  };
  // Esc clears the selection unless a field has the key; open overlays consume
  // their own Escape before it reaches the window.
  const selectionCount = shell.selected.size;
  useEffect(() => {
    if (!selectionCount) return;
    const clear = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input:not([type=checkbox], [type=radio]), textarea, select, [contenteditable]",
        )
      )
        return;
      shell.setSelected(new Set());
    };
    window.addEventListener("keydown", clear);
    return () => window.removeEventListener("keydown", clear);
  }, [selectionCount, shell]);
  const snapshot = (definition: unknown) =>
    archiveAction.mutate(
      { name: "snapshots", request: definition },
      {
        // Open the new snapshot directly instead of leaving it to be found in a list.
        onSuccess: (v) =>
          navigate({
            view: "snapshots",
            literature: null,
            snapshot: String(record(v, "snapshot").snapshot_id),
          }),
      },
    );
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
  const onRowAction = useCallback(
    (id: string, title: string, kind: RowAction) => {
      if (kind === "run")
        setRunner({
          scope: { kind: "literatures", ids: [id] },
          label: `《${title}》`,
        });
      else if (kind === "folder") setAdding([id]);
      else if (kind === "acquire")
        setAcquire({ kind: "literatures", ids: [id], label: `《${title}》` });
      else setOperation({ ids: [id], kind });
    },
    [],
  );
  const removeFromFolder = async () => {
    if (!folder) return;
    try {
      const result = await manageFolder(api, {
        operation: "remove",
        request: { folder_id: folder.id, literature_ids: [...shell.selected] },
      });
      shell.setSelected(new Set());
      shell.notify(
        `已从「${folderLabel}」移出 ${"changed" in result ? result.changed : 0} 篇`,
      );
      void queries.invalidateQueries({ queryKey: ["folders"] });
      void queries.invalidateQueries({ queryKey: ["library"] });
    } catch (error) {
      shell.notify(errorMessage(error));
    }
  };
  // Dragging a selected row carries the whole selection to a folder.
  const selectedRef = useRef(shell.selected);
  selectedRef.current = shell.selected;
  const onDragRow = useCallback(
    (id: string, data: DataTransfer, title: string) => {
      const ids = selectedRef.current.has(id)
        ? [...selectedRef.current].slice(0, 1000)
        : [id];
      // A press on the title or its text would otherwise drag that text.
      data.clearData();
      data.setData(LITERATURE_DRAG, JSON.stringify(ids));
      data.setData("text/plain", `${ids.length} 篇文献`);
      data.effectAllowed = "copy";
      data.setDragImage(dragGhost(ids.length, title), 14, 14);
    },
    [],
  );
  const mutable = api.kind === "workspace";
  const groups = groupSelection(shell.selected, known);
  /** Each batch button counts only the papers it would actually act on. */
  const batchReason = (group: SelectionGroup, none: string) =>
    groups[group].length === 0
      ? none
      : groups[group].length > 1000
        ? "最多处理 1,000 篇，请减少选择。"
        : undefined;
  // The whole catalog is always over the limit, so the reason lives with the
  // disabled actions instead of occupying the toolbar.
  const overLimit =
    total > 1000
      ? {
          description: `当前 ${total.toLocaleString()} 篇，超过 1,000 篇上限；请先筛选或选择。`,
        }
      : {};
  const toolbarActions = (
    <>
      <Menu
        label={`筛选${
          activeView
            ? `：${views.find((view) => view.filter_id === activeView)?.name ?? ""}`
            : chips.length
              ? ` · ${chips.length}`
              : ""
        }`}
        icon={<Icon name="filter" />}
        indicator
        variant="text"
        items={[
          {
            id: "conditions",
            label: filters ? "收起筛选条件" : "筛选条件…",
            onAction: () => {
              setFilters(!filters);
              setMobileTools(false);
            },
          },
          ...views.map((view, index) => ({
            id: `view:${view.filter_id}`,
            label: view.name,
            divider: index === 0,
            // Spec “文献库”: a filter whose folder is gone says so.
            ...(view.missing_folder_id ? { description: "文件夹已删除" } : {}),
            onAction: () => {
              setActiveView(view.filter_id);
              updateQuery(view.query, view.sort);
            },
          })),
          ...(savedFilters.error
            ? [
                {
                  id: "filters-error",
                  label: "暂时无法读取保存的筛选",
                  divider: true,
                  disabled: true,
                  onAction: () => {},
                },
              ]
            : []),
          {
            id: "save",
            label: "保存当前筛选…",
            divider: views.length === 0,
            onAction: () => setSaveOpen(true),
          },
          ...(activeView
            ? [
                {
                  // Spec “文献库”: the current condition and order replace
                  // this filter's; its name stays (user organization 9.1).
                  id: "update",
                  label: "用当前条件更新这项筛选",
                  onAction: () => {
                    void updateFilter(api, activeView, {
                      query: route.query,
                      sort: route.sort,
                    })
                      .then(refreshFilters)
                      .catch((error: unknown) =>
                        shell.notify(errorMessage(error)),
                      );
                  },
                },
                {
                  id: "delete",
                  label: "删除当前筛选",
                  onAction: () => {
                    void deleteFilter(api, activeView)
                      .then(() => {
                        setActiveView("");
                        refreshFilters();
                      })
                      .catch((error: unknown) =>
                        shell.notify(errorMessage(error)),
                      );
                  },
                },
              ]
            : []),
          // User organization 9.1: while this browser has filters not yet
          // imported, the menu ends with the way to bring them over.
          ...(pendingImport.length
            ? [
                {
                  id: "import-browser",
                  label: `导入这个浏览器里保存的筛选（${pendingImport.length} 项）`,
                  divider: true,
                  onAction: () => void importBrowserFilters(),
                },
              ]
            : []),
        ]}
      />
      <Select
        label="排序"
        value={route.sort}
        onChange={(sort) =>
          updateQuery(
            route.query,
            parseLibrarySearchRequest({ query: route.query, sort }).sort,
          )
        }
        options={LIBRARY_MENU_SORTS.map((value) => ({
          value,
          label: SORT_LABELS[value],
        }))}
      />
      {(next.data?.pages[0]?.backfillPending ?? 0) > 0 ? (
        <p role="status">
          此标签还有 {next.data!.pages[0]!.backfillPending} 篇待回溯。
          <Button
            variant="text"
            onPress={() =>
              navigate({
                view: "tags",
                literature: null,
                tag: route.query.tags?.ids[0] ?? null,
              })
            }
          >
            查看回溯
          </Button>
        </p>
      ) : null}
      {archiveAction.error ? (
        <ErrorNotice message={errorMessage(archiveAction.error)} />
      ) : null}
      {mutable ? (
        <Menu
          label="用当前结果"
          indicator
          variant="text"
          items={[
            {
              id: "acquire",
              label: "获取 PDF…",
              disabled: total === 0,
              onAction: () => {
                setMobileTools(false);
                setAcquire({
                  kind: "query",
                  query: route.query,
                  sort: route.sort,
                  label: scopeLabel(),
                });
              },
            },
            {
              id: "run",
              label: "运行算子…",
              disabled: total === 0 || total > 1000,
              ...overLimit,
              onAction: () => {
                setMobileTools(false);
                setRunner({
                  scope: { kind: "query" },
                  label: `文献库当前筛选（${total.toLocaleString()} 篇）`,
                });
              },
            },
            // The current results go to archiving as a fixed scope, as the
            // selection does (page specs “文献库”).
            ...(api.workspace.capabilities.maintenance
              ? [
                  {
                    id: "archive",
                    label: "建档…",
                    disabled: total === 0,
                    onAction: () => {
                      setMobileTools(false);
                      void operate("archive", false);
                    },
                  },
                ]
              : []),
            {
              id: "snapshot",
              label: "生成快照",
              disabled: total === 0,
              onAction: () => snapshot({ kind: "query", query: route.query }),
            },
            {
              id: "export",
              label: "导出书目",
              disabled: total === 0 || total > 1000,
              ...overLimit,
              onAction: () => void operate("export", false),
            },
          ]}
        />
      ) : null}
    </>
  );
  if (api.workspace.readiness !== "ready")
    return (
      <section className="library-page">
        {route.warning ? <p role="status">{route.warning}</p> : null}
        <PageHeader title="文献库" />
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
        title={
          folderLabel ??
          (route.query.recently_opened
            ? "最近阅读"
            : batchId && batch.data
              ? batch.data.label
              : "文献库")
        }
        count={
          counts.data
            ? `${route.query.recently_opened ? "最近 30 天 · " : ""}${counts.data.total.toLocaleString()} 篇`
            : undefined
        }
        action={
          mutable ? (
            <Button
              icon={<Icon name="plus" />}
              onPress={() => navigate({ view: "disc", literature: null })}
            >
              入库
            </Button>
          ) : undefined
        }
      />
      <div className="library-controls">
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
        <div className="library-quick">
          <div className="library-status-filters" aria-label="按材料状态筛选">
            {STATUS_FILTERS.filter(
              (filter) =>
                filter.id === "" ||
                statusFilter === filter.id ||
                countFor(filter.id) !== 0,
            ).map((filter) => (
              <FilterChip
                key={filter.id}
                isSelected={statusFilter === filter.id}
                onChange={() => setStatusFilter(filter.id)}
              >
                {filter.label}
                {countFor(filter.id) !== null ? " " : null}
                {countFor(filter.id) !== null ? (
                  <span className="filter-count">
                    {countFor(filter.id)!.toLocaleString()}
                  </span>
                ) : null}
              </FilterChip>
            ))}
            {statusFilter === "EXCLUDED" ? (
              <FilterChip isSelected onChange={() => setStatusFilter("")}>
                已排除
              </FilterChip>
            ) : (
              <Menu
                label="更多状态"
                indicator
                variant="text"
                items={[
                  {
                    id: "EXCLUDED",
                    label: "已排除",
                    onAction: () => setStatusFilter("EXCLUDED"),
                  },
                ]}
              />
            )}
          </div>
          {folder ? (
            <Switch
              isSelected={!folder.include_descendants}
              onChange={(only) =>
                updateQuery({
                  ...route.query,
                  folder: { id: folder.id, include_descendants: !only },
                })
              }
            >
              只看本层
            </Switch>
          ) : null}
        </div>
        {chips.length > 0 && (
          <div className="library-applied">
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
            <Button
              variant="text"
              size="compact"
              onPress={() => {
                setActiveView("");
                updateQuery(
                  route.query.folder || route.query.recently_opened
                    ? scopeQuery(route.query)
                    : emptyQuery(),
                );
              }}
            >
              清除全部
            </Button>
          </div>
        )}
        {chips.length > 0 ? (
          <ScopeTerms query={route.query} onChange={updateQuery} />
        ) : null}
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
        <div className="library-list-heading">
          <Checkbox
            label="全选已加载"
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
          {items.length > 0 &&
            total > items.length &&
            items.every((item) =>
              shell.selected.has(item.literature.literature_id),
            ) && (
              <Button
                variant="text"
                size="compact"
                isPending={choosing}
                disabledReason={
                  total > 1000
                    ? `共 ${total.toLocaleString()} 篇，超过 1,000 篇上限。获取 PDF 可用“用当前结果 → 获取 PDF”整体提交。`
                    : undefined
                }
                onPress={selectScope}
              >
                选择全部 {total.toLocaleString()} 篇符合条件的文献
              </Button>
            )}
        </div>
      </div>
      <LayoutGroup className="library-results-region">
        {next.isError && (
          <ErrorNotice
            message={errorMessage(next.error)}
            onRetry={() => void next.refetch()}
          />
        )}
        <LibraryList
          items={items}
          sort={route.sort}
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
          onCheckPointerDown={range.onPointerDown}
          onRowPointerDown={range.onRowPointerDown}
          onCheckClickCapture={range.onClickCapture}
          selectingRange={range.dragging}
          onOpen={(...args) => {
            if (text.trim() !== (route.query.text ?? ""))
              updateQuery({ ...route.query, text: text.trim() || null });
            shell.openPaper(...args);
          }}
          onPreview={setPeek}
          onFile={onFile}
          onRowAction={onRowAction}
          onDragRow={onDragRow}
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
              <span className="selection-groups">
                {SELECTION_GROUPS.filter(
                  ({ group }) => groups[group].length > 0,
                ).map(({ group, label }) => (
                  <Button
                    key={group}
                    variant="text"
                    size="compact"
                    className="selection-group"
                    aria-label={`只保留${label}的 ${groups[group].length} 篇`}
                    onPress={() => shell.setSelected(new Set(groups[group]))}
                  >
                    {label} <span>{groups[group].length}</span>
                  </Button>
                ))}
              </span>
              {mutable ? (
                <>
                  <Button
                    variant="primary"
                    disabledReason={batchReason("no-pdf", "所选文献都已有 PDF")}
                    onPress={() =>
                      setAcquire(
                        wholeScope?.key === scrollKey &&
                          wholeScope.size === shell.selected.size
                          ? {
                              kind: "query",
                              query: route.query,
                              sort: route.sort,
                              label: scopeLabel(),
                            }
                          : {
                              kind: "literatures",
                              ids: groups["no-pdf"],
                              label:
                                groups["no-pdf"].length === shell.selected.size
                                  ? `勾选的 ${shell.selected.size.toLocaleString()} 篇`
                                  : `勾选的 ${shell.selected.size.toLocaleString()} 篇中还没有 PDF 的 ${groups["no-pdf"].length.toLocaleString()} 篇`,
                            },
                      )
                    }
                  >
                    获取 PDF <span>{groups["no-pdf"].length}</span>
                  </Button>
                  <Button
                    disabledReason={batchReason(
                      "ready",
                      "所选文献都还没有建档就绪",
                    )}
                    onPress={() =>
                      setRunner({
                        scope: { kind: "literatures", ids: groups.ready },
                        label: `已选中已就绪的 ${groups.ready.length} 篇`,
                      })
                    }
                  >
                    运行算子 <span>{groups.ready.length}</span>
                  </Button>
                  <Button
                    disabledReason={batchReason(
                      "unarchived",
                      "所选文献没有待建档的；建档需要先有 PDF",
                    )}
                    onPress={() =>
                      setOperation({ ids: groups.unarchived, kind: "archive" })
                    }
                  >
                    建档 <span>{groups.unarchived.length}</span>
                  </Button>
                  <Button
                    icon={<Icon name="folder" />}
                    disabledReason={
                      shell.selected.size > 1000
                        ? "最多一次加入 1,000 篇，请减少选择。"
                        : undefined
                    }
                    onPress={() => setAdding([...shell.selected])}
                  >
                    加入文件夹…
                  </Button>
                  <Menu
                    label="更多"
                    indicator
                    items={[
                      ...(folder
                        ? [
                            {
                              id: "remove-folder",
                              label: `移出「${folderLabel}」`,
                              disabled: shell.selected.size > 1000,
                              onAction: () => void removeFromFolder(),
                            },
                          ]
                        : []),
                      {
                        id: "identity",
                        label: "核验文章身份",
                        onAction: () => void operate("identity", true),
                      },
                      {
                        id: "snapshot",
                        label: "生成快照",
                        onAction: () =>
                          snapshot({
                            kind: "literatures",
                            literature_ids: [...shell.selected],
                          }),
                      },
                      {
                        id: "export",
                        label: "导出书目",
                        onAction: () => void operate("export", true),
                      },
                    ]}
                  />
                </>
              ) : (
                <Button onPress={() => void operate("export", true)}>
                  导出书目
                </Button>
              )}
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
              void createFilter(api, {
                name: viewName.trim(),
                query: route.query,
                sort: route.sort,
              })
                .then((saved) => {
                  setActiveView(saved.filter_id);
                  refreshFilters();
                  setSaveOpen(false);
                  setViewName("");
                })
                .catch((error: unknown) => shell.notify(errorMessage(error)));
            }}
          >
            保存
          </Button>
        }
      >
        <TextField label="筛选名称" value={viewName} onChange={setViewName} />
      </Dialog>
      <Dialog
        title="导入的筛选"
        isOpen={!!importReport}
        onOpenChange={(open) => {
          if (!open) setImportReport(null);
        }}
      >
        {importReport ? <ImportReport items={importReport} /> : null}
      </Dialog>
      {runner ? (
        <RunOperatorDialog fixed={runner} onClose={() => setRunner(null)} />
      ) : null}
      {adding ? (
        <AddToFolderDialog ids={adding} onClose={() => setAdding(null)} />
      ) : null}
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
              <h2>
                <RichTitle parts={paperTitleParts(preview.data)} />
              </h2>
              <p>{paperAuthors(preview.data)}</p>
              <p>
                {preview.data.literature.metadata.abstract ?? "尚未提供摘要。"}
              </p>
              <Button
                onPress={() => {
                  shell.openPaper(
                    peek!,
                    undefined,
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
      {acquire && (
        <AcquireDialog scope={acquire} onClose={() => setAcquire(null)} />
      )}
    </section>
  );
}
function rowTerms(item: LiteratureSearchItem) {
  const m = item.literature.metadata;
  return (m.keywords.length ? m.keywords : m.subject_terms).slice(0, ROW_TAGS);
}
const STATUS_FILTERS = [
  { id: "", label: "全部" },
  { id: "READY", label: "已就绪" },
  { id: "ASSET_READY", label: "有 PDF" },
  { id: "ARCHIVING", label: "建档中" },
  { id: "ARCHIVE_FAILED", label: "建档失败" },
  { id: "failed", label: "无法获取" },
  { id: "UNREVIEWED", label: "仅元数据" },
] as const;
/** Scroll-range updates belong to the list, not the page's forms and motion layout. */
const LibraryList = memo(function LibraryList({
  items,
  sort,
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
  onCheckPointerDown,
  onRowPointerDown,
  onCheckClickCapture,
  selectingRange,
  onOpen,
  onPreview,
  onFile,
  onRowAction,
  onDragRow,
}: {
  items: readonly LiteratureSearchItem[];
  sort: LibrarySort;
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
  onCheckPointerDown: CheckPointerDown;
  onRowPointerDown: CheckPointerDown;
  onCheckClickCapture: (event: ReactMouseEvent) => void;
  selectingRange: () => boolean;
  onOpen: ReturnType<typeof useShell>["openPaper"];
  onPreview: (id: string) => void;
  onFile: (id: string, file: File) => void;
  onRowAction: (id: string, title: string, kind: RowAction) => void;
  onDragRow: (id: string, data: DataTransfer, title: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  // The whole page scrolls; the list measures its offset inside that container.
  const scroll = useRef<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const getScrollElement = useCallback(() => scroll.current, []);
  useLayoutEffect(() => {
    const element = list.current;
    scroll.current =
      element?.closest<HTMLElement>(".workspace-content") ?? null;
    const container = scroll.current;
    if (!element || !container) return;
    const measure = () =>
      setScrollMargin(
        Math.round(
          element.getBoundingClientRect().top -
            container.getBoundingClientRect().top +
            container.scrollTop,
        ),
      );
    measure();
    const observer = new ResizeObserver(measure);
    for (const sibling of element.parentElement?.parentElement?.children ?? [])
      if (!sibling.contains(element)) observer.observe(sibling);
    return () => observer.disconnect();
  }, []);
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
    scrollMargin,
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
  // Ignore scroll events until the remembered position is back in place.
  const restored = useRef(false);
  useEffect(() => {
    // Runs after the shell resets the shared scroll container for this route.
    restored.current = false;
    const frame = requestAnimationFrame(() => {
      scroll.current?.scrollTo({ top: positions.get(scrollKey) ?? 0 });
      restored.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollKey, positions]);
  useEffect(() => {
    const container = scroll.current;
    if (!container) return;
    const remember = () => {
      if (!restored.current) return;
      positions.set(scrollKey, container.scrollTop);
      measurements.set(scrollKey, virtual.measurementsCache.slice());
    };
    container.addEventListener("scroll", remember, { passive: true });
    return () => container.removeEventListener("scroll", remember);
  }, [scrollKey, positions, measurements, virtual]);
  const onMove = useCallback(
    (index: number) => {
      const target = Math.max(0, Math.min(items.length - 1, index));
      virtual.scrollToIndex(target);
      requestAnimationFrame(() =>
        list.current
          ?.querySelector<HTMLElement>(`[data-index="${target}"]`)
          ?.focus(),
      );
    },
    [virtual, items.length],
  );
  return (
    <div
      className="library-scroll"
      ref={list}
      aria-label="文献列表"
      tabIndex={-1}
      aria-busy={fetching}
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
            offset={scrollMargin}
            item={items[row.index]!}
            sort={sort}
            selected={selected.has(items[row.index]!.literature.literature_id)}
            mutable={mutable}
            measure={virtual.measureElement}
            onToggle={onToggle}
            onCheckPointerDown={onCheckPointerDown}
            onRowPointerDown={onRowPointerDown}
            onCheckClickCapture={onCheckClickCapture}
            selectingRange={selectingRange}
            onOpen={onOpen}
            onPreview={onPreview}
            onFile={onFile}
            onRowAction={onRowAction}
            onMove={onMove}
            onDragRow={onDragRow}
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
const estimateRowSize = () => 78;
type CheckPointerDown = (
  index: number,
  event: ReactPointerEvent<HTMLElement>,
) => void;
type RowAction = "run" | "folder" | "acquire" | "archive";
/** A row shows at most three tags; the rest collapse into “+N”. */
const ROW_TAGS = 3;
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u;
/** Rows list three authors at most, the way a reference list does. */
function rowAuthors(item: LiteratureSearchItem) {
  const authors = item.literature.metadata.authors;
  if (authors.length <= 3) return paperAuthors(item);
  return `${paperAuthors({
    ...item,
    literature: {
      ...item.literature,
      metadata: { ...item.literature.metadata, authors: authors.slice(0, 3) },
    },
  })} 等`;
}
/** Journal names are italic in Latin script only; CJK has no true italic. */
function Venue({ name }: { name: string | null | undefined }) {
  if (!name) return <span className="paper-venue-missing">期刊未提供</span>;
  return CJK.test(name) ? <span>{name}</span> : <i>{name}</i>;
}

const LibraryRow = memo(function LibraryRow({
  row,
  offset,
  item,
  sort,
  selected,
  mutable,
  measure,
  onToggle,
  onCheckPointerDown,
  onRowPointerDown,
  onCheckClickCapture,
  selectingRange,
  onOpen,
  onPreview,
  onFile,
  onRowAction,
  onMove,
  onDragRow,
}: {
  row: VirtualItem;
  offset: number;
  item: LiteratureSearchItem;
  sort: LibrarySort;
  selected: boolean;
  mutable: boolean;
  measure: (element: HTMLElement | null) => void;
  onToggle: (id: string) => void;
  onCheckPointerDown: CheckPointerDown;
  onRowPointerDown: CheckPointerDown;
  onCheckClickCapture: (event: ReactMouseEvent) => void;
  selectingRange: () => boolean;
  onOpen: ReturnType<typeof useShell>["openPaper"];
  onPreview: (id: string) => void;
  onFile: (id: string, file: File) => void;
  onRowAction: (id: string, title: string, kind: RowAction) => void;
  onMove: (index: number) => void;
  onDragRow: (id: string, data: DataTransfer, title: string) => void;
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
      style={{ transform: `translateY(${row.start - offset}px)` }}
      tabIndex={0}
      aria-label={title}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === " ") {
          event.preventDefault();
          onToggle(id);
        } else if (event.key === "Enter")
          onOpen(id, undefined, undefined, title);
        else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          onMove(row.index + (event.key === "ArrowDown" ? 1 : -1));
        }
      }}
      // Selected rows are picked up and dragged to a folder; a press on any
      // other row that moves draws a marquee instead.
      draggable={mutable && selected}
      onPointerDown={(event) => onRowPointerDown(row.index, event)}
      onClickCapture={onCheckClickCapture}
      onDragStart={(event) => {
        // A press on the checkbox column selects a run; it never drags the
        // row. Anywhere else, the title included, picks the row up.
        if (
          selectingRange() ||
          (event.target as Element).closest?.(".paper-check, .paper-tools")
        )
          event.preventDefault();
        else onDragRow(id, event.dataTransfer, title);
      }}
      onDragOver={(event) => {
        // Only a dropped file belongs to the row; folder drags go to the sidebar.
        if (mutable && event.dataTransfer.types.includes("Files"))
          event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        if (mutable && file) onFile(id, file);
      }}
    >
      <span
        className="paper-check"
        onPointerDownCapture={(event) => onCheckPointerDown(row.index, event)}
        onClickCapture={onCheckClickCapture}
      >
        <Checkbox
          aria-label={`选择 ${title}`}
          isSelected={selected}
          onChange={() => onToggle(id)}
        />
      </span>
      <button
        className="paper-open"
        onClick={() => onOpen(id, undefined, undefined, title)}
      >
        <span className="paper-title">
          <RichTitle parts={paperTitleParts(item)} />
        </span>
        <span className="paper-citation">
          {rowAuthors(item)} · <Venue name={item.literature.metadata.venue} /> ·{" "}
          {item.literature.metadata.publication_year ?? "年份未提供"}
        </span>
        {item.tags?.length ? (
          <span className="paper-tags">
            {item.tags.slice(0, ROW_TAGS).map((t) => (
              <span
                key={t.tag_id}
                className={t.rank === 1 ? "paper-tag primary" : "paper-tag"}
              >
                {t.name}
              </span>
            ))}
            {item.tags.length > ROW_TAGS ? (
              <span
                className="paper-tag-more"
                title={item.tags
                  .slice(ROW_TAGS)
                  .map((t) => t.name)
                  .join("、")}
              >
                +{item.tags.length - ROW_TAGS}
              </span>
            ) : null}
          </span>
        ) : rowTerms(item).length ? (
          // Without tags, the paper's own keywords (or the source's subjects) say what it is about.
          <span className="paper-terms">{rowTerms(item).join(" · ")}</span>
        ) : null}
      </button>
      {item.literature.status === "UNREVIEWED" && !item.needs_manual_pdf ? (
        // Almost the whole catalog is metadata-only; only departures get a tag.
        <span />
      ) : (
        <span className="paper-status-cell">
          <span
            className="paper-status"
            data-state={
              item.needs_manual_pdf ? "UNAVAILABLE" : item.literature.status
            }
          >
            {item.needs_manual_pdf
              ? "无法获取"
              : statusLabels[item.literature.status]}
            {item.literature.status === "ASSET_READY" ? (
              <small>待建档</small>
            ) : null}
            {item.literature.status === "ARCHIVING" ? (
              <small>
                {item.missing_step
                  ? archiveReason(item.missing_step)
                  : "正在执行"}
              </small>
            ) : null}
            {item.literature.status === "EXCLUDED" ? (
              <small>
                {item.literature.metadata.article_kind
                  ? ARTICLE_KIND_LABELS[item.literature.metadata.article_kind]
                  : "待改判"}
              </small>
            ) : null}
            {item.literature.status === "ARCHIVE_FAILED" ? (
              <Button
                variant="text"
                size="compact"
                onPress={() => navigate({ view: "archive", literature: null })}
              >
                查看问题
              </Button>
            ) : null}
          </span>
          {/* Page specs “文献库”: under the status, in small text — a long
            document, or a primary PDF whose default text is a draft. */}
          {item.literature.status === "READY" && item.long_document ? (
            <small
              className="paper-status-note"
              title="按简化流程建档，未逐页校订；以 PDF 为准"
            >
              长文档
            </small>
          ) : null}
          {item.text_level === "draft" ? (
            <small
              className="paper-status-note"
              title="未经校订，文字可能含解析错误；以 PDF 为准"
            >
              {draftNote(item, sort)}
            </small>
          ) : null}
        </span>
      )}
      <span className="paper-tools">
        <IconButton
          className="paper-preview"
          size="compact"
          variant="text"
          aria-label="预览"
          icon={<Icon name="eye" />}
          onPress={() => onPreview(id)}
        />
        {mutable ? (
          <Menu
            label="文献操作"
            iconOnly
            items={[
              {
                id: "run",
                label: "运行算子…",
                onAction: () => onRowAction(id, title, "run"),
              },
              {
                id: "folder",
                label: "加入文件夹…",
                onAction: () => onRowAction(id, title, "folder"),
              },
              {
                id: "acquire",
                label: "获取 PDF",
                divider: true,
                onAction: () => onRowAction(id, title, "acquire"),
              },
              {
                id: "archive",
                label: "建档",
                ...(item.literature.status === "UNREVIEWED"
                  ? { disabled: true, description: "需要先有 PDF" }
                  : {}),
                onAction: () => onRowAction(id, title, "archive"),
              },
            ]}
          />
        ) : null}
      </span>
    </article>
  );
});

/** A yes/no filter that may be left open: 不限, 有, 没有. */
const FLAG_OPTIONS = [
  { value: "", label: "不限" },
  { value: "yes", label: "有" },
  { value: "no", label: "没有" },
];
const flag = (value: boolean | null | undefined) =>
  value === true ? "yes" : value === false ? "no" : "";
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
    [form, setForm] = useState(query.publication_forms[0] ?? ""),
    [kind, setKind] = useState(query.article_kinds[0] ?? ""),
    [tag, setTag] = useState(query.tags?.ids[0] ?? ""),
    [level, setLevel] = useState(
      query.text_levels?.length === 1 ? query.text_levels[0]! : "",
    ),
    [differs, setDiffers] = useState(flag(query.has_draft_differences)),
    [scanned, setScanned] = useState(flag(query.has_image_only_pages)),
    [tagMode, setTagMode] = useState(query.tags?.mode ?? "any"),
    [error, setError] = useState("");
  const api = useApi();
  const vocabulary = useQuery({
    queryKey: ["tags", "filter-options"],
    queryFn: ({ signal }) =>
      archiveQuery(
        api,
        "tags",
        { operation: "list", request: { limit: 200 } },
        signal,
      ),
  });
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
                publication_forms: form ? [form] : [],
                article_kinds: kind ? [kind] : [],
                tags: { ids: tag ? [tag] : [], mode: tagMode },
                author: author || null,
                venue: venue || null,
                keywords: keyword ? [keyword] : [],
                identifiers: doi ? [{ namespace: "doi", value: doi }] : [],
                text_levels: level ? [level] : [],
                has_draft_differences: differs ? differs === "yes" : null,
                has_image_only_pages: scanned ? scanned === "yes" : null,
              },
            }).query,
          );
        } catch (error) {
          setError(errorMessage(error));
        }
      }}
    >
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
      <Select
        label="出版形式"
        value={form}
        onChange={setForm}
        options={[
          { value: "", label: "全部" },
          ...Object.entries(PUBLICATION_FORM_LABELS).map(([value, label]) => ({
            value,
            label,
          })),
        ]}
      />
      <Select
        label="文章性质"
        value={kind}
        onChange={setKind}
        options={[
          { value: "", label: "全部" },
          ...Object.entries(ARTICLE_KIND_LABELS).map(([value, label]) => ({
            value,
            label,
          })),
        ]}
      />
      <Select
        label="文献标签（包含下级）"
        value={tag}
        onChange={setTag}
        options={[
          { value: "", label: "不限标签" },
          ...(vocabulary.data
            ? rows(vocabulary.data).map((t) => ({
                value: String(t.tag_id),
                label: String(t.name_zh || t.name_en),
              }))
            : []),
        ]}
      />
      {/* Page specs “文献库”: the primary PDF's default text. */}
      <Select
        label="文本等级"
        value={level}
        onChange={(value) => setLevel(value as TextLevel | "")}
        options={[
          { value: "", label: "全部" },
          { value: "draft", label: TEXT_LEVEL_LABELS.draft },
          { value: "proofread", label: TEXT_LEVEL_LABELS.proofread },
        ]}
      />
      <Select
        label="初稿与文字层有差异"
        value={differs}
        onChange={setDiffers}
        options={FLAG_OPTIONS}
      />
      <Select
        label="含扫描页"
        value={scanned}
        onChange={setScanned}
        options={FLAG_OPTIONS}
      />
      <Select
        label="标签范围"
        value={tagMode}
        onChange={(v) => setTagMode(v as "any" | "primary")}
        options={[
          { value: "any", label: "任一标签" },
          { value: "primary", label: "主标签" },
        ]}
      />
      <div className="library-filter-years">
        <TextField
          label="年份起"
          width="short"
          value={from}
          onChange={setFrom}
          placeholder="如 2015"
        />
        <TextField
          label="年份止"
          width="short"
          value={to}
          onChange={setTo}
          placeholder="如 2026"
        />
      </div>
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

/** What follows the pointer while papers are dragged onto a folder. */
function dragGhost(count: number, title: string): HTMLElement {
  const ghost = document.createElement("div"),
    label = document.createElement("strong"),
    name = document.createElement("span");
  ghost.className = "drag-ghost";
  if (count > 1) ghost.dataset.stack = "";
  label.textContent = `${count.toLocaleString()} 篇文献`;
  name.textContent = count > 1 ? `${title} 等` : title;
  ghost.append(label, name);
  document.body.append(ghost);
  // The browser copies the element when the drag starts; it is not kept.
  requestAnimationFrame(() => ghost.remove());
  return ghost;
}

const IMPORT_STATUS: Record<string, string> = {
  imported: "已导入",
  renamed: "已改名导入",
  skipped: "已有相同的筛选，跳过",
  invalid: "未导入",
};
const IMPORT_REASON: Record<string, string> = {
  "filter-condition-invalid": "条件不合格",
  "invalid-contract": "名称或格式不合格",
};
/** User organization 9.1: what became of each item this browser had saved. */
function ImportReport({
  items,
}: {
  items: readonly {
    name: string;
    status: string;
    result: string | null;
    reason: string | null;
  }[];
}) {
  const count = (status: string) =>
    items.filter((item) => item.status === status).length;
  return (
    <div className="saved-filter-report">
      <p>
        导入 {count("imported")} 项，改名 {count("renamed")} 项，跳过{" "}
        {count("skipped")} 项，未导入 {count("invalid")} 项。
      </p>
      <ul>
        {items.map((item, index) => (
          <li key={index} data-status={item.status}>
            <span className="saved-filter-report-name">{item.name}</span>
            <span className="ui-description">
              {IMPORT_STATUS[item.status] ?? item.status}
              {item.status === "renamed" && item.result
                ? `：${item.result}`
                : ""}
              {item.status === "invalid"
                ? `：${IMPORT_REASON[item.reason ?? ""] ?? item.reason ?? "原因不明"}`
                : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
