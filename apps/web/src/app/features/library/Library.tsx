import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  memo,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import {
  ARTICLE_KIND_LABELS,
  LIBRARY_SORT_SCOPE_LIMIT,
  PUBLICATION_FORM_LABELS,
  parseLibrarySearchRequest,
  type LibraryCounts,
  type LibrarySort,
  type LibraryQuery,
  type TextLevel,
  type LiteratureSearchItem,
} from "@sciretriever/contracts";
import {
  Button,
  Checkbox,
  ConfirmDialog,
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
  Radio,
  RadioGroup,
  SearchField,
  SegmentedControl,
  Select,
  Switch,
  TextField,
  TechDetails,
  RichTitle,
} from "../../components/index.js";
import type { MenuOption } from "../../components/index.js";
import { AnimatedPanel, Presence, LayoutGroup } from "../../motion/index.js";
import { ApiError, type ApiClient } from "../../data/api.js";
import { useApi } from "../../data/query.js";
import { useUrlState, navigate } from "../../data/url.js";
import { preferences } from "../../data/preferences.js";
import {
  CITATION_SEED_LIMIT,
  collectLiteratures,
  emptyQuery,
  exactSearchTotal,
  libraryCount,
  libraryView,
  overCountLimit,
  pageQuery,
  scanIncompleteReason,
  viewSort,
  literatureChoice,
  metadataTitleParts,
  paperAuthors,
  paperFirstAuthor,
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
import {
  archiveQuery,
  archiveWrite,
  useArchiveAction,
  rows,
} from "../../data/archive.js";
import { record } from "../../data/wire.js";
import { archiveReason, errorMessage, statusLabels } from "../../strings.js";
import { OperationDialog, download } from "./OperationDialog.js";
import {
  BibliographyContent,
  MaterialBadge,
  Venue,
} from "../bibliography/Bibliography.js";
import {
  ContextMenu,
  type ContextMenuRequest,
} from "../reader/input/ContextMenu.js";
import { useDeletion } from "./Trash.js";
import { useLibraryRemoval } from "./Uncollect.js";
import {
  MAIN_MATERIAL_STATES,
  MORE_MATERIAL_STATES,
  materialCount,
  materialCountScope,
  materialCountTruncated,
  materialQuery,
  queryMaterialState,
  type MaterialState,
} from "../../data/material-states.js";
import {
  SELECTION_GROUPS,
  groupSelection,
  selectionPrimary,
  useRangeSelection,
  type SelectionGroup,
} from "./selection.js";
import {
  MoveToFolderDialog,
  LITERATURE_DRAG,
  folderPaths,
  openBatch,
  scopeQuery,
  useFolders,
} from "./Folders.js";
import { manageFolder } from "../../data/folders.js";
import {
  browserFilters,
  createFilter,
  deleteFilter,
  exportFilters,
  importFilters,
  listFilters,
  markBrowserFilters,
  updateFilter,
} from "../../data/saved-filters.js";
import {
  RunOperatorDialog,
  type OperatorScope,
} from "../processing/RunOperator.js";

/** The library's two displays, remembered in this browser (page specs “文献库”). */
type LibraryDisplay = "list" | "table";
const DISPLAY_KEY = "sciretriever:library:display:v1";
const readDisplay = (): LibraryDisplay =>
  preferences.read(DISPLAY_KEY) === "table" ? "table" : "list";
/**
 * Where the page was scrolled, with the list's offset at the time: content
 * above the list (the band's entries) may change height meanwhile.
 */
interface ScrollPosition {
  readonly top: number;
  readonly margin: number;
}
const scrollPositions = new WeakMap<ApiClient, Map<string, ScrollPosition>>();
/** The row the right column showed in each view, found again on coming back from a paper. */
const currentRows = new WeakMap<ApiClient, Map<string, string>>();
/** A whole-library search shows this many of the library's own hits before the candidates. */
const LIBRARY_HITS_SHOWN = 5;
/** The right column (page specs “右栏”): open or put away, remembered in this browser. */
const PREVIEW_KEY = "sciretriever:library:preview:v1";
/**
 * What stays at the top while the rows scroll: the title row alone (the
 * default), or the search box, the classes and the conditions with it.
 */
const CONTROLS_PINNED_KEY = "sciretriever:library:controls-pinned:v1";
/** Past this much scrolling, “回到顶部” is offered. */
const BACK_TO_TOP_AFTER = 600;
/** Wider than this the right column stands beside the list; narrower, the preview is a layer. */
const WIDE = "(min-width: 1101px)";
const PREVIEW_WIDTH_KEY = "sciretriever:library:preview-width:v1";
const PREVIEW_MIN_WIDTH = 320;
/** The widest the right column goes: the list keeps at least two fifths. */
const previewMaxWidth = () =>
  Math.max(
    PREVIEW_MIN_WIDTH,
    Math.min(800, Math.round(document.documentElement.clientWidth * 0.6)),
  );
const clampPreviewWidth = (width: number) =>
  Math.round(Math.min(previewMaxWidth(), Math.max(PREVIEW_MIN_WIDTH, width)));
function storedPreviewWidth(): number | null {
  const width = Number(preferences.read(PREVIEW_WIDTH_KEY));
  return Number.isFinite(width) && width >= PREVIEW_MIN_WIDTH ? width : null;
}
/**
 * The right column's left edge, to drag: the width follows the pointer
 * without drawing the list again, and is kept when the pointer lets go.
 * ← → move it by the keyboard; a double press returns the default width.
 */
function PreviewResizer({
  page,
  width,
  onCommit,
}: {
  page: RefObject<HTMLElement | null>;
  width: number | null;
  onCommit: (width: number | null) => void;
}) {
  const dragging = useRef(false);
  const shown = () =>
    page.current?.querySelector<HTMLElement>(".library-preview")?.offsetWidth ??
    width ??
    400;
  const follow = (clientX: number) => {
    const next = clampPreviewWidth(
      document.documentElement.clientWidth - clientX,
    );
    page.current?.style.setProperty("--library-preview-width", `${next}px`);
    return next;
  };
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    document.documentElement.classList.remove("library-resizing");
    onCommit(follow(event.clientX));
  };
  return (
    <div
      className="library-preview-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整右栏宽度"
      aria-valuemin={PREVIEW_MIN_WIDTH}
      aria-valuemax={previewMaxWidth()}
      {...(width === null ? {} : { "aria-valuenow": width })}
      tabIndex={0}
      title="拖动调整右栏宽度，双击恢复默认"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true;
        document.documentElement.classList.add("library-resizing");
      }}
      onPointerMove={(event) => {
        if (dragging.current) follow(event.clientX);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onCommit(null)}
      onKeyDown={(event) => {
        const step =
          event.key === "ArrowLeft" ? 16 : event.key === "ArrowRight" ? -16 : 0;
        if (!step) return;
        event.preventDefault();
        onCommit(clampPreviewWidth(shown() + step));
      }}
    />
  );
}
function useWide() {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const media = window.matchMedia(WIDE);
    const change = () => setWide(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return wide;
}
/** Searching from the library view covers the whole library (page specs “搜索框”). */
function searchWholeLibrary(text: string) {
  const words = text.trim();
  if (!words) return;
  navigate(
    {
      view: "lib",
      literature: null,
      query: JSON.stringify({ ...emptyQuery(), text: words }),
      sort: null,
    },
    { clearSource: true },
  );
}
const rowMeasurements = new WeakMap<ApiClient, Map<string, VirtualItem[]>>();
/** The draft-difference filter in words (page specs “界面用词”). */
const DIFFERS_LABEL = "全文和 PDF 自带的文字不一样";
/** Text levels in words (page specs “文献库”, reading-experience 3.4). */
export const TEXT_LEVEL_LABELS = {
  draft: "未校对",
  proofread: "已校对",
} as const satisfies Record<TextLevel, string>;
/**
 * The draft mark on a row; sorted by a draft fact, followed by its count
 * (page specs “文献库”): “未校对 · 差异 12 段”, “未校对 · 扫描 3 页”.
 */
function draftNote(item: LiteratureSearchItem, sort: LibrarySort) {
  const facts = item.draft_facts;
  if (facts && sort === "draft-differences-desc")
    return `未校对 · 差异 ${facts.differs_segments} 段`;
  if (facts && sort === "image-only-pages-desc")
    return `未校对 · 扫描 ${facts.image_only_pages} 页`;
  return "未校对";
}
export default function Library() {
  const api = useApi(),
    shell = useShell(),
    route = useUrlState();
  const archiveAction = useArchiveAction();
  const queries = useQueryClient();
  const queryString = JSON.stringify(route.query);
  const view = libraryView(route.query);
  // What the page reads: the collected papers unless a search or a working
  // set says otherwise (page specs “文献库”).
  const effective = useMemo(
    () => pageQuery(route.query),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryString],
  );
  // The list and the table keep their own scroll and row measurements.
  const [display, setDisplay] = useState<LibraryDisplay>(readDisplay);
  const chooseDisplay = (value: LibraryDisplay) => {
    setDisplay(value);
    preferences.write(DISPLAY_KEY, value);
  };
  // A whole-library text search reads the newest window of raw hits first;
  // the earlier windows it went on to, for this query and sort only (page
  // specs “搜索结果”). Kept on the page, not in the address.
  const windowKey = `${JSON.stringify(effective)}:${route.sort}`;
  const [windows, setWindows] = useState<{
    key: string;
    cursors: readonly string[];
    limit: number | null;
    side: "hits" | "members" | null;
  }>({ key: "", cursors: [], limit: null, side: null });
  const windowCursors = windows.key === windowKey ? windows.cursors : [];
  const windowCursor = windowCursors.at(-1) ?? null;
  const windowNumber = windowCursors.length + 1;
  const scopeKey = `${queryString}:${route.sort}`;
  const scrollKey = `${scopeKey}:${display}:${windowCursor ?? ""}`;
  if (!scrollPositions.has(api)) scrollPositions.set(api, new Map());
  if (!rowMeasurements.has(api)) rowMeasurements.set(api, new Map());
  if (!currentRows.has(api)) currentRows.set(api, new Map());
  const currents = currentRows.get(api)!;
  const positions = scrollPositions.get(api)!;
  const measurements = rowMeasurements.get(api)!;
  const batchId =
    route.query.intake_batch_ids.length === 1
      ? route.query.intake_batch_ids[0]!
      : null;
  const batch = useIntakeBatch(batchId);
  const conditions = Object.entries(route.query).flatMap(([key, value]) => {
    const names: Record<string, string> = {
      author: "作者",
      venue: "期刊",
      keywords: "作者关键词",
      subject_terms: "主题词",
      intake_batch_ids: "批次",
      identifiers: "标识符",
      publication_year_from: "起始年份",
      publication_year_to: "结束年份",
      statuses: "状态",
      publication_forms: "出版形式",
      article_kinds: "文章性质",
      tags: "标签",
      needs_manual_pdf: statusLabels.UNAVAILABLE!,
      has_primary_pdf: "主 PDF",
      needs_metadata: "书目不全",
      text_levels: "文本等级",
      has_draft_differences: DIFFERS_LABEL,
      has_image_only_pages: "含扫描页",
    };
    // Folder and "recently read" are the page's scope, shown in its title;
    // the search words stay in the search box (page specs “文献库”).
    if (
      key === "text" ||
      key === "folder" ||
      key === "recently_opened" ||
      key === "collection_scope" ||
      value === null ||
      (value === false &&
        key !== "has_draft_differences" &&
        key !== "has_image_only_pages" &&
        key !== "has_primary_pdf") ||
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
                    key === "has_image_only_pages" ||
                    key === "has_primary_pdf"
                  ? value
                    ? "有"
                    : "没有"
                  : key === "needs_metadata"
                    ? "是"
                    : Array.isArray(value)
                      ? value.join("、")
                      : String(value);
    return [
      {
        key,
        label: `${names[key] ?? key}：${label}`,
        clear: () => {
          // “书目待补” is present or absent, never null.
          if (key === "needs_metadata") {
            const { needs_metadata: _drop, ...rest } = route.query;
            void _drop;
            return updateQuery(rest);
          }
          updateQuery({
            ...route.query,
            [key]:
              key === "tags"
                ? { ids: [], mode: "any" }
                : Array.isArray(value)
                  ? []
                  : null,
          });
        },
      },
    ];
  });
  /**
   * The quick filter selected (“有 PDF”) shows as its selected chip alone:
   * no condition chip repeats it and “筛选 · n” does not count it, as the
   * search words stay in the search box (plan 25 block 30).
   */
  const quickFields: ReadonlySet<string> =
    typeof route.query.has_primary_pdf !== "boolean" &&
    queryMaterialState(route.query)
      ? new Set(["statuses", "needs_manual_pdf"])
      : new Set();
  const chips = conditions.filter((chip) => !quickFields.has(chip.key));
  /**
   * A filter narrows the page's scope (page specs “文献库”); the batch a
   * batch view shows is its scope, and search words make a search page.
   */
  const narrowed =
    chips.some((chip) => chip.key !== "intake_batch_ids") ||
    quickFields.size > 0;
  /** The current filter in words, for dialogs that act on all of it. */
  const scopeLabel = () =>
    [
      folderLabel ? `文件夹：${folderLabel}` : "",
      route.query.recently_opened ? "最近读过" : "",
      route.query.text ? `搜索：${route.query.text}` : "",
      route.query.text && route.query.collection_scope === "collected"
        ? "只看文献库里的"
        : "",
      ...conditions.map((chip) => chip.label),
    ]
      .filter(Boolean)
      .join("；") || "文献库";
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
  // The right column's paper. Wide, the column stands beside the list and
  // always shows the current row; narrow, a preview opens over it on request.
  const [peek, setPeekState] = useState<string | null>(null);
  const wide = useWide();
  const [previewOpen, setPreviewOpen] = useState(
    () => preferences.read(PREVIEW_KEY) !== "closed",
  );
  const docked = wide && previewOpen;
  const [controlsPinned, setControlsPinnedState] = useState(
    () => preferences.read(CONTROLS_PINNED_KEY) === "pinned",
  );
  const setControlsPinned = (pinned: boolean) => {
    setControlsPinnedState(pinned);
    preferences.write(CONTROLS_PINNED_KEY, pinned ? "pinned" : "free");
  };
  // The right column's width is the reader's own choice, kept in this browser.
  const page = useRef<HTMLElement>(null);
  const [previewWidth, setPreviewWidthState] = useState(storedPreviewWidth);
  const setPreviewWidth = (width: number | null) => {
    setPreviewWidthState(width);
    preferences.write(PREVIEW_WIDTH_KEY, width === null ? "" : String(width));
    if (width === null)
      page.current?.style.removeProperty("--library-preview-width");
  };
  // Without the column, a row's “预览” opens the current row over the list.
  const [overlay, setOverlay] = useState(false);
  const togglePreview = (open: boolean) => {
    setPreviewOpen(open);
    preferences.write(PREVIEW_KEY, open ? "open" : "closed");
  };
  const setPeek = useCallback(
    (id: string | null) => {
      setPeekState(id);
      if (id) currents.set(scopeKey, id);
    },
    [currents, scopeKey],
  );
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
  const [rowMenu, setRowMenu] = useState<ContextMenuRequest | null>(null);
  // A search started in a working set can widen to the whole library and
  // come back (page specs “搜索结果”); the set is remembered here, not in
  // the address.
  const [origin, setOrigin] = useState<SearchOrigin | null>(null);
  const next = useInfiniteQuery({
    queryKey: ["library", effective, route.sort, windowCursor],
    queryFn: ({ pageParam, signal }) =>
      searchLibrary(
        api,
        effective,
        route.sort,
        pageParam,
        signal,
        50,
        windowCursor,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.cursor,
    placeholderData: keepPreviousData,
    enabled: api.workspace.readiness === "ready",
  });
  // Papers collected on this page: their rows say “已加入” in place of
  // the button (page specs “搜索结果”).
  const [collectedNow, setCollectedNow] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const hits = useMemo(
    () => [
      ...new Map(
        next.data?.pages
          .flatMap((page) => page.items)
          .map((item) => [item.literature.literature_id, item]) ?? [],
      ).values(),
    ],
    [next.data],
  );
  // A search of the whole library lists what the library holds first, then
  // the candidates (page specs “搜索结果”): the library's own hits are read
  // on their own, a few of them, and the mixed hits keep the candidates.
  const sectioned =
    view === "search" &&
    !route.query.folder &&
    !route.query.recently_opened &&
    route.query.intake_batch_ids.length === 0 &&
    route.query.collection_scope === undefined;
  const libraryScope = useMemo(
    () => inScope(effective, "collected"),
    [effective],
  );
  const libraryHits = useQuery({
    queryKey: ["library", "search-in-library", libraryScope, route.sort],
    queryFn: ({ signal }) =>
      searchLibrary(
        api,
        libraryScope,
        route.sort,
        null,
        signal,
        LIBRARY_HITS_SHOWN,
      ),
    placeholderData: keepPreviousData,
    enabled: sectioned && api.workspace.readiness === "ready",
  });
  const libraryRows = sectioned ? libraryHits.data?.items : undefined;
  const items = useMemo(() => {
    if (!sectioned) return hits;
    const own = libraryRows ?? [];
    const shown = new Set(own.map((item) => item.literature.literature_id));
    return [
      ...own,
      ...hits.filter(
        (item) =>
          // A candidate added to the library on this page stays in its place.
          (item.collected === false ||
            collectedNow.has(item.literature.literature_id)) &&
          !shown.has(item.literature.literature_id),
      ),
    ];
  }, [sectioned, hits, libraryRows, collectedNow]);
  /** Where the candidates begin among the rows; the library's hits come before. */
  const candidatesFrom = sectioned ? (libraryRows?.length ?? 0) : null;
  // The current row: the one chosen here, else the one left for the reader;
  // beside the right column, else the first. Never a paper that is not
  // among the rows.
  const current = useMemo(() => {
    const has = (id: string | null | undefined) =>
      !!id && items.some((item) => item.literature.literature_id === id);
    const remembered = currents.get(scopeKey);
    return has(peek)
      ? peek
      : has(remembered)
        ? remembered!
        : docked
          ? (items[0]?.literature.literature_id ?? null)
          : null;
  }, [docked, peek, items, currents, scopeKey]);
  // The paper shown beside or over the list: the current row, in the right
  // column or in the preview a row's “预览” opened.
  const shownPeek = docked || overlay ? current : null;
  const firstPage = next.data?.pages[0];
  const total = firstPage?.total ?? 0,
    truncated = firstPage?.truncated ?? false;
  // The service refused the sort for a scope over 10,000 papers; it never
  // picks another one itself (page specs “超过一万篇”).
  const sortRefused =
    next.error instanceof ApiError &&
    next.error.code === LIBRARY_SORT_SCOPE_LIMIT;
  const allowedSort = viewSort(route.query);
  /**
   * A working set's own order, newest first (ADR 0065 §6.4): folders,
   * batches and task output by intake, the collected by collection, the
   * recently read by opening.
   */
  const order = route.query.recently_opened
    ? "打开"
    : route.query.collection_scope === "collected"
      ? "加入"
      : "新增";
  const worksetSort: LibrarySort = route.query.recently_opened
    ? "opened-desc"
    : route.query.collection_scope === "collected"
      ? "collected-desc"
      : "intake-desc";
  // Older raw hits wait outside this window: the count is a lower bound,
  // and only relevance can be paged (page specs “搜索结果”).
  // While another window loads, the last one's receipt is no guide to it.
  const windowPage = next.isPlaceholderData ? undefined : firstPage;
  const scanIncomplete = windowPage?.scanIncomplete ?? false;
  const windowLimit =
    windowPage?.scanLimit ?? (windowCursor ? windows.limit : null);
  const scanSide = windowPage?.scanSide ?? (windowCursor ? windows.side : null);
  const lowerBound = scanIncomplete && windowNumber === 1;
  const nextWindow = windowPage?.nextWindow ?? null;
  const continueWindow = nextWindow
    ? () =>
        setWindows({
          key: windowKey,
          cursors: [...windowCursors, nextWindow],
          limit: firstPage?.scanLimit ?? windows.limit,
          side: firstPage?.scanSide ?? windows.side,
        })
    : null;
  const firstWindow = () =>
    setWindows({
      key: windowKey,
      cursors: [],
      limit: windows.limit,
      side: windows.side,
    });
  // What a window reads, in words (page specs “搜索结果”): the newest raw
  // hits of the index, or a large working set's newest members in its own
  // order. Only the object read changes; the sentences stay the same.
  const members = scanSide === "members";
  const owner = route.query.folder
    ? "这个文件夹"
    : route.query.intake_batch_ids.length
      ? "这个批次"
      : "";
  /** “最近写入索引的 75,000 条命中”, “这个文件夹最近入库的 8,000 篇”, and their earlier batches. */
  const windowPhrase =
    windowLimit === null
      ? null
      : members
        ? `${owner}${windowNumber === 1 ? "最近" : "更早"}${order}的${windowNumber === 1 ? "" : `第 ${windowNumber} 批`} ${libraryCount(windowLimit, false)} 篇`
        : `${windowNumber === 1 ? "最近写入索引的" : `更早的第 ${windowNumber} 批`} ${libraryCount(windowLimit, false)} 条命中`;
  const continueLabel = members
    ? `在更早${order}的文献里继续找`
    : "在更早的命中里继续找";
  const firstWindowLabel = members
    ? `回到最近${order}的文献`
    : "回到最近的命中";
  /** The sorts a window can page: relevance, and a member window's own order. */
  const windowSorts: readonly LibrarySort[] = members
    ? ["relevance", worksetSort]
    : ["relevance"];
  // An empty window with older hits left: the list says so and offers the
  // way on, so the line beside the sort keeps quiet.
  const emptyWindow =
    !!windowPage &&
    windowPage.total === 0 &&
    scanIncomplete &&
    !!continueWindow;
  // A working set ranked by relevance only in part: the ranked ones first,
  // the rest in the set's own order, newest first (page specs “搜索结果”).
  const relevanceScored =
    route.sort === "relevance" ? (windowPage?.relevanceScored ?? null) : null;
  const scoredNote = (() => {
    if (relevanceScored === null) return null;
    const narrow = "；先加条件，或缩小范围，可全部按相关度排";
    if (relevanceScored === 0)
      return `没有按相关度排序，按${order}时间从近到远排列${narrow}`;
    // A count stopped at 10,000, or a lower bound, gives no remainder.
    const rest =
      truncated || scanIncomplete
        ? ""
        : ` ${libraryCount(Math.max(0, total - relevanceScored), false)} 篇`;
    return `按相关度排了最近${order}的 ${libraryCount(relevanceScored, false)} 篇，其余${rest}按${order}时间排在后面${narrow}`;
  })();
  const sortLimited = firstPage
    ? overCountLimit(total, truncated) || scanIncomplete || windowNumber > 1
    : sortRefused;
  // Statuses seen in this session, so a selection made across scrolls and
  // filters can still be split into what each batch action applies to.
  const known = useRef(new Map<string, LiteratureSearchItem>()).current;
  for (const item of items) known.set(item.literature.literature_id, item);
  const range = useRangeSelection({
    items,
    selected: shell.selected,
    setSelected: shell.setSelected,
  });
  const countScope = materialCountScope(effective);
  // A window's cursor holds only the search words, so the quick filters'
  // counts, read without the quick filter, follow the window too.
  const counts = useQuery({
    queryKey: ["library", "counts", countScope, windowCursor],
    queryFn: ({ signal }) =>
      readLibraryCounts(api, countScope, signal, windowCursor),
    placeholderData: keepPreviousData,
    enabled: api.workspace.readiness === "ready",
  });
  // A cursor the service no longer knows (other words, an old cursor):
  // back to the newest hits, not an error page.
  const windowLost = [next.error, counts.error].some(isWindowInvalid);
  useEffect(() => {
    if (windowLost && windowCursor !== null) firstWindow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowLost, windowCursor]);
  // The page's whole scope, before any filter: the collected papers, a
  // folder, the recently read or a batch.
  const baseScope = useMemo(
    () =>
      pageQuery({
        ...scopeQuery(route.query),
        ...candidatesScope(route.query),
        ...(view === "batch"
          ? {
              intake_batch_ids: route.query.intake_batch_ids,
              discovery_run_ids: route.query.discovery_run_ids,
            }
          : {}),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryString],
  );
  // The whole library's totals, shared with the sidebar and the band.
  const libraryTotals = useQuery({
    queryKey: ["library", "counts", emptyQuery()],
    queryFn: ({ signal }) => readLibraryCounts(api, emptyQuery(), signal),
    enabled: api.workspace.readiness === "ready",
  });
  const scopeCounts = useQuery({
    queryKey: ["library", "counts", baseScope],
    queryFn: ({ signal }) => readLibraryCounts(api, baseScope, signal),
    placeholderData: keepPreviousData,
    enabled: api.workspace.readiness === "ready",
  });
  // The categories do not overlap, so their counts add up to the total
  // (page specs “界面用词”).
  const countFor = (filter: MaterialState | "") =>
    counts.data
      ? filter === ""
        ? counts.data.total
        : materialCount(counts.data, filter)
      : null;
  /** Counted from the first 10,000 matches, “1 万+”; with older hits unread, “n+”. */
  const quickCount = (filter: MaterialState | "") =>
    libraryCount(countFor(filter)!, {
      truncated:
        counts.data !== undefined &&
        (filter === ""
          ? counts.data.count_truncated === true
          : materialCountTruncated(counts.data, filter)),
      incomplete: counts.data?.scan_incomplete === true,
      lowerBound: windowNumber === 1,
    });
  const folders = useFolders();
  const folder = route.query.folder ?? null;
  const folderLabel = folder
    ? (folderPaths(folders.data?.items ?? []).find(
        (path) => path.id === folder.id,
      )?.label ?? "文件夹")
    : null;
  const [adding, setAdding] = useState<string[] | null>(null);
  /**
   * A new query keeps the chosen sort; a view's own sort follows the view,
   * and relevance goes with the search words.
   */
  const updateQuery = (query: LibraryQuery, sort?: LibrarySort) => {
    const chosen =
      sort ??
      (route.sort === viewSort(route.query) ||
      (route.sort === "relevance" && !query.text)
        ? null
        : route.sort);
    navigate({ query: JSON.stringify(query), sort: chosen }, { replace: true });
  };
  // An old address's “主 PDF” selects no quick filter, not even 全部.
  const statusFilter =
    typeof route.query.has_primary_pdf === "boolean"
      ? null
      : queryMaterialState(route.query);
  /**
   * How many of the current results are in one category: the quick filter
   * selects a single category, so the others are empty.
   */
  const resultsIn = (state: MaterialState): number | null => {
    if (!counts.data) return null;
    if (statusFilter === "") return materialCount(counts.data, state);
    if (statusFilter === null)
      return (state === "metadata" || state === "unavailable") ===
        !route.query.has_primary_pdf
        ? materialCount(counts.data, state)
        : 0;
    return statusFilter === state ? total : 0;
  };
  // One quick filter at a time; the scope's other conditions stay.
  const setStatusFilter = (value: MaterialState | "") =>
    updateQuery(
      parseLibrarySearchRequest({ query: materialQuery(route.query, value) })
        .query,
    );
  /** Drops every filter; the search stays unless `all`, the scope always. */
  const clearConditions = (all: boolean) => {
    setActiveView("");
    if (all) setText("");
    updateQuery({
      ...scopeQuery(route.query),
      ...candidatesScope(route.query),
      ...(all
        ? {}
        : {
            text: route.query.text,
            ...(route.query.collection_scope
              ? { collection_scope: route.query.collection_scope }
              : {}),
          }),
    });
  };
  useEffect(() => {
    setText(route.query.text ?? "");
  }, [route.query.text]);
  const folderName = folderLabel,
    batchName = batch.data?.label ?? null;
  useEffect(() => {
    if (view !== "search") {
      setOrigin(null);
      return;
    }
    const q = route.query;
    if (q.folder)
      setOrigin({ scope: { folder: q.folder }, name: folderName ?? "文件夹" });
    else if (q.recently_opened)
      setOrigin({ scope: { recently_opened: true }, name: "最近读过" });
    else if (q.collection_scope === "candidates")
      setOrigin({ scope: { collection_scope: "candidates" }, name: "候选" });
    else if (q.intake_batch_ids.length)
      setOrigin({
        scope: { intake_batch_ids: q.intake_batch_ids },
        name: batchName ?? "批次",
      });
  }, [view, route.query, folderName, batchName]);
  useEffect(() => {
    if (text.trim() === (route.query.text ?? "")) return;
    const timer = setTimeout(
      () => updateQuery({ ...route.query, text: text.trim() || null }),
      300,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        : await scopeIds(api, effective, route.sort);
      setOperation({ ids, kind });
    } catch (error) {
      shell.notify(errorMessage(error));
    } finally {
      setChoosing(false);
    }
  };
  /** The current results, at most 1,000, go into a folder as fixed ids. */
  const addResults = async () => {
    if (choosing) return;
    setChoosing(true);
    try {
      setAdding(await scopeIds(api, effective, route.sort));
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
      const all = await scopeItems(api, effective, route.sort);
      setWholeScope({ key: scopeKey, size: all.length });
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
  const onFile = useCallback(
    (id: string, file: File) =>
      setOperation({ ids: [id], kind: "upload", file }),
    [],
  );
  const collect = useCallback(
    async (ids: readonly string[]) => {
      const result = await collectLiteratures(api, ids);
      const done = new Set(ids);
      const update = (item: LiteratureSearchItem) => {
        if (!done.has(item.literature.literature_id) || item.collected)
          return item;
        const { discovery_origin: _origin, ...rest } = item;
        void _origin;
        return { ...rest, collected: true };
      };
      for (const id of ids) {
        const item = known.get(id);
        if (item) known.set(id, update(item));
      }
      setCollectedNow((current) => new Set([...current, ...ids]));
      // The rows and every number change where they are; the list is not
      // read again.
      queries.setQueriesData<{
        pages: { items: LiteratureSearchItem[] }[];
      }>(
        {
          queryKey: ["library"],
          predicate: (query) =>
            typeof query.queryKey[1] === "object" && query.queryKey[1] !== null,
        },
        (data) =>
          data?.pages
            ? {
                ...data,
                pages: data.pages.map((page) => ({
                  ...page,
                  items: page.items.map(update),
                })),
              }
            : data,
      );
      const n = result.newly_collected;
      queries.setQueryData<LibraryCounts>(
        ["library", "counts", emptyQuery()],
        (counts) =>
          counts?.collection_counts
            ? {
                ...counts,
                collection_counts: {
                  collected: counts.collection_counts.collected + n,
                  discovered_only: Math.max(
                    0,
                    counts.collection_counts.discovered_only - n,
                  ),
                },
              }
            : counts,
      );
      void queries.invalidateQueries({
        queryKey: ["library", "counts"],
        predicate: (query) =>
          JSON.stringify(query.queryKey[2]) !== JSON.stringify(emptyQuery()),
      });
    },
    [api, known, queries],
  );
  const { expandCitations } = shell;
  /** Seeds for citation expansion, as the library has them (page specs “入库”). */
  const seedsOf = useCallback(
    (ids: Iterable<string>) =>
      [...ids].map((id) => {
        const item = known.get(id);
        return item
          ? literatureChoice(item)
          : {
              id,
              title: metadataTitleParts(null),
              author: "作者未提供",
              year: null,
            };
      }),
    [known],
  );
  // The row's own actions reach the folder through a ref: the callback stays
  // the same between renders, so the rows are not drawn again for it.
  const removeFromFolderRef = useRef<(ids: readonly string[]) => void>(
    () => {},
  );
  /** The selection's own menu, rebuilt each render and read when it opens. */
  const selectionItemsRef = useRef<(on: string) => MenuOption[]>(() => []);
  const deletion = useDeletion();
  // “识别书目”: papers marked 书目不全 that have a PDF are read again and
  // looked up in the metadata sources, as a task (technical 03 8.4).
  const [recognizing, setRecognizing] = useState<readonly string[] | null>(
    null,
  );
  const recognize = useMutation({
    mutationFn: (ids: readonly string[]) =>
      archiveWrite(api, "literature-recognize", {
        selector: { kind: "literatures", literature_ids: ids },
      }),
    onSuccess: (_job, ids) => {
      setRecognizing(null);
      shell.setSelected(new Set());
      void queries.invalidateQueries({ queryKey: ["tasks"] });
      shell.notify(
        `已开始识别 ${ids.length.toLocaleString()} 篇的书目，进度在“任务”里`,
      );
    },
  });
  const deleteRef = useRef(deletion.request);
  deleteRef.current = deletion.request;
  const removal = useLibraryRemoval((ids) =>
    setCollectedNow(
      (current) => new Set([...current].filter((id) => !ids.includes(id))),
    ),
  );
  const uncollectRef = useRef(removal.request);
  uncollectRef.current = removal.request;
  const collectRef = useRef(collect);
  collectRef.current = collect;
  const onRowAction = useCallback(
    (id: string, title: string, kind: RowAction) => {
      if (kind === "open") shell.openPaper(id, undefined, undefined, title);
      else if (kind === "remove-folder") removeFromFolderRef.current([id]);
      else if (kind === "recognize") setRecognizing([id]);
      else if (kind === "collect")
        void collectRef
          .current([id])
          .catch((error: unknown) => shell.notify(errorMessage(error)));
      else if (kind === "uncollect")
        uncollectRef.current({ ids: [id], label: `《${title}》` });
      else if (kind === "delete" || kind === "delete-key") {
        // The Delete key on a row of the selection takes the whole selection.
        const chosen = selectedRef.current;
        if (kind === "delete-key" && chosen.has(id) && chosen.size > 1)
          deleteRef.current({
            ids: [...chosen],
            label: `已选的 ${chosen.size.toLocaleString()} 篇文献`,
          });
        else deleteRef.current({ ids: [id], label: `《${title}》` });
      } else if (kind === "cite") expandCitations(seedsOf([id]));
      else if (kind === "run")
        setRunner({
          scope: { kind: "literatures", ids: [id] },
          label: `《${title}》`,
        });
      else if (kind === "folder") setAdding([id]);
      else if (kind === "acquire")
        setAcquire({ kind: "literatures", ids: [id], label: `《${title}》` });
      else setOperation({ ids: [id], kind });
    },
    [expandCitations, seedsOf, shell],
  );
  const mutable = api.kind === "workspace";
  /** Right-click or the keyboard's menu key on a row opens its menu there. */
  const onRowMenu = useCallback(
    (id: string, x: number, y: number, keyboard: boolean) => {
      const item = known.get(id);
      if (!item) return;
      const title = paperTitle(item);
      // On one of several selected rows the menu is the selection's: every
      // action in it takes them all (page specs “连续选择与选择栏”).
      const chosen = selectedRef.current,
        several = chosen.has(id) && chosen.size > 1;
      setRowMenu({
        x,
        y,
        keyboard,
        label: several ? "已选文献操作" : "文献操作",
        items: several
          ? selectionItemsRef.current(id)
          : rowMenuItems(
              item,
              (kind) => onRowAction(id, title, kind),
              folder ? (folderLabel ?? "文件夹") : null,
            ),
      });
    },
    [known, onRowAction, folder, folderLabel],
  );
  const removeFromFolder = async (
    ids: readonly string[] = [...shell.selected],
  ) => {
    if (!folder) return;
    try {
      const result = await manageFolder(api, {
        operation: "remove",
        request: { folder_id: folder.id, literature_ids: ids },
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
  removeFromFolderRef.current = (ids) => void removeFromFolder(ids);
  // Dragging a selected row carries the whole selection to a folder.
  const selectedRef = useRef(shell.selected);
  selectedRef.current = shell.selected;
  const notifyRef = useRef(shell.notify);
  notifyRef.current = shell.notify;
  const candidateRef = useRef<(id: string) => boolean>(() => false);
  candidateRef.current = (id) =>
    known.get(id)?.collected === false && !collectedNow.has(id);
  const onDragRow = useCallback(
    (id: string, data: DataTransfer, title: string) => {
      // Only papers of the library go into a folder; candidates stay behind.
      const ids = (
        selectedRef.current.has(id) ? [...selectedRef.current] : [id]
      )
        .filter((each) => !candidateRef.current(each))
        .slice(0, 1000);
      if (!ids.length) {
        notifyRef.current("候选要先加入文献库，才能放进文件夹");
        return false;
      }
      // A press on the title or its text would otherwise drag that text.
      data.clearData();
      data.setData(LITERATURE_DRAG, JSON.stringify(ids));
      data.setData("text/plain", `${ids.length} 篇文献`);
      data.effectAllowed = "copy";
      data.setDragImage(dragGhost(ids.length, title), 14, 14);
      return true;
    },
    [],
  );
  const groups = groupSelection(shell.selected, known);
  // The selected papers that are only discovered (page specs “搜索结果”).
  const discovered = [...shell.selected].filter(
    (id) => known.get(id)?.collected === false && !collectedNow.has(id),
  );
  // The rest are of the library; these can be taken out of it (ADR 0067).
  const inLibrary = [...shell.selected].filter(
    (id) => known.get(id)?.collected !== false || collectedNow.has(id),
  );
  const uncollectItem: MenuOption[] = inLibrary.length
    ? [
        {
          id: "uncollect",
          label: `移出文献库 ${inLibrary.length.toLocaleString()}…`,
          onAction: () =>
            removal.request({
              ids: inLibrary,
              label: `已选的 ${inLibrary.length.toLocaleString()} 篇文献`,
            }),
        },
      ]
    : [];
  const collectItem: MenuOption[] = discovered.length
    ? [
        {
          id: "collect",
          label: `加入文献库 ${discovered.length.toLocaleString()}`,
          onAction: () =>
            void collect(discovered).catch((error: unknown) =>
              shell.notify(errorMessage(error)),
            ),
        },
      ]
    : [];
  /** Each batch button counts only the papers it would actually act on. */
  const batchReason = (group: SelectionGroup, none: string) =>
    groups[group].length === 0
      ? none
      : groups[group].length > 1000
        ? "最多处理 1,000 篇，请减少选择。"
        : undefined;
  const acquireReason = batchReason("no-pdf", "所选文献都已有 PDF"),
    archivingReason = batchReason(
      "unarchived",
      "所选文献没有要解析全文的；解析全文需要先有 PDF",
    ),
    runReason = batchReason("ready", "所选文献都还没有全文");
  // Candidates join the library before they go into a folder.
  const moveReason = discovered.length
    ? `所选里有 ${discovered.length.toLocaleString()} 篇候选，先加入文献库再移动。`
    : shell.selected.size > 1000
      ? "最多一次移动 1,000 篇，请减少选择。"
      : undefined;
  // With candidates chosen, adding them is the bar's one primary action.
  const primary = discovered.length
    ? null
    : selectionPrimary(acquireReason, archivingReason);
  // Of the selection, the papers marked 书目不全, and those of them with a PDF.
  const incomplete = [...shell.selected].filter(
    (id) => known.get(id)?.needs_metadata,
  );
  const recognizable = incomplete.filter(
    (id) => known.get(id)?.literature.status !== "UNREVIEWED",
  );
  const recognizeItem: MenuOption[] = incomplete.length
    ? [
        {
          id: "recognize",
          label: `识别书目 ${recognizable.length.toLocaleString()}…`,
          ...(recognizable.length === 0
            ? {
                disabled: true,
                description: "所选的书目不全的文献都还没有 PDF",
              }
            : recognizable.length > 1000
              ? {
                  disabled: true,
                  description: "最多一次识别 1,000 篇，请减少选择。",
                }
              : {}),
          onAction: () => setRecognizing(recognizable),
        },
      ]
    : [];
  const acquireSelected = () =>
    setAcquire(
      wholeScope?.key === scopeKey && wholeScope.size === shell.selected.size
        ? {
            kind: "query",
            query: effective,
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
    );
  selectionItemsRef.current = (on) => {
    const size = shell.selected.size,
      count = size.toLocaleString();
    const unless = (reason: string | undefined | false) =>
      reason ? { disabled: true, description: reason } : {};
    // In the order of the list, so the tabs read as the rows did.
    const ordered = [
      ...[...known.keys()].filter((id) => shell.selected.has(id)),
      ...[...shell.selected].filter((id) => !known.has(id)),
    ];
    return [
      {
        id: "open",
        label: `打开阅读 ${count} 篇`,
        ...unless(
          size > OPEN_TOGETHER_LIMIT &&
            `一次最多打开 ${OPEN_TOGETHER_LIMIT} 篇，请减少选择。`,
        ),
        onAction: () =>
          shell.openPapers(
            ordered.map((id) => {
              const item = known.get(id);
              return { id, title: item ? paperTitle(item) : "文献" };
            }),
            on,
          ),
      },
      ...collectItem,
      {
        id: "folder",
        label: "移动…",
        ...unless(moveReason),
        onAction: () => setAdding([...shell.selected]),
      },
      ...(folder
        ? [
            {
              id: "remove-folder",
              label: `移出「${folderLabel}」`,
              disabled: size > 1000,
              onAction: () => void removeFromFolder(),
            },
          ]
        : []),
      {
        id: "export",
        label: "导出…",
        onAction: () => void operate("export", true),
      },
      ...uncollectItem,
      {
        id: "delete",
        label: `删除 ${count} 篇…`,
        onAction: () =>
          deletion.request({
            ids: [...shell.selected],
            label: `已选的 ${count} 篇文献`,
          }),
      },
      ...recognizeItem.map((item) => ({ ...item, divider: true })),
      {
        id: "acquire",
        label: `获取 PDF ${groups["no-pdf"].length.toLocaleString()}`,
        ...(recognizeItem.length ? {} : { divider: true }),
        ...unless(acquireReason),
        onAction: acquireSelected,
      },
      {
        id: "archive",
        label: `解析全文 ${groups.unarchived.length.toLocaleString()}`,
        ...unless(archivingReason),
        onAction: () =>
          setOperation({ ids: groups.unarchived, kind: "archive" }),
      },
      {
        id: "cite",
        label: "扩展引用…",
        ...unless(
          size > CITATION_SEED_LIMIT &&
            `最多以 ${CITATION_SEED_LIMIT.toLocaleString()} 篇为种子，请减少选择。`,
        ),
        onAction: () => expandCitations(seedsOf(shell.selected)),
      },
      {
        id: "run",
        label: `运行算子 ${groups.ready.length.toLocaleString()}`,
        ...unless(runReason),
        onAction: () =>
          setRunner({
            scope: { kind: "literatures", ids: groups.ready },
            label: `已选中有全文的 ${groups.ready.length} 篇`,
          }),
      },
    ];
  };
  // The whole catalog is always over the limit, so the reason lives with the
  // disabled actions instead of occupying the toolbar.
  const overLimit = scanIncomplete
    ? { disabled: true, description: scanIncompleteReason(scanSide) }
    : total > 1000 || truncated
      ? {
          disabled: true,
          description: `当前 ${libraryCount(total, truncated, "篇")}，超过 1,000 篇上限；请先筛选或选择。`,
        }
      : {};
  // What the current results hold, for the batch menu: an action none of them
  // could ever take is left out; one they cannot take yet says why (rule 12).
  const noPdf = resultsIn("metadata"),
    exhausted = resultsIn("unavailable"),
    withPdf =
      resultsIn("ASSET_READY") === null
        ? null
        : resultsIn("ASSET_READY")! + resultsIn("ARCHIVE_FAILED")!,
    withText = resultsIn("READY");
  const withoutPdf =
    noPdf === null || exhausted === null ? null : noPdf + exhausted;
  const batchItems: MenuOption[] = [
    ...(noPdf !== 0 || exhausted
      ? [
          {
            id: "acquire",
            label: "获取 PDF…",
            ...(noPdf === 0
              ? {
                  disabled: true,
                  description: "这些文献的自动途径都已试过，没找到 PDF",
                }
              : {}),
            onAction: () => {
              setMobileTools(false);
              setAcquire({
                kind: "query",
                query: effective,
                sort: route.sort,
                label: scopeLabel(),
              });
            },
          },
        ]
      : []),
    // The current results go to archiving as a fixed scope, as the
    // selection does (page specs “文献库”).
    ...(api.workspace.capabilities.maintenance && (withPdf !== 0 || withoutPdf)
      ? [
          {
            id: "archive",
            label: "解析全文…",
            ...(withPdf === 0
              ? {
                  disabled: true,
                  description: "这些文献还没有 PDF；解析全文需要先有 PDF",
                }
              : overLimit),
            onAction: () => {
              setMobileTools(false);
              void operate("archive", false);
            },
          },
        ]
      : []),
    {
      id: "folder",
      label: "移动…",
      ...overLimit,
      onAction: () => {
        setMobileTools(false);
        void addResults();
      },
    },
    {
      id: "export",
      label: "导出…",
      ...overLimit,
      onAction: () => void operate("export", false),
    },
    // Running an operator and fixing a snapshot are processing: the
    // last group (page specs “整体信息架构”).
    processingHeading,
    {
      id: "run",
      label: "运行算子…",
      ...(withText === 0
        ? { disabled: true, description: "这些文献还没有全文" }
        : overLimit),
      onAction: () => {
        setMobileTools(false);
        setRunner({
          scope: { kind: "query" },
          label: `文献库当前筛选（${libraryCount(total, truncated, "篇")}）`,
        });
      },
    },
    {
      id: "snapshot",
      label: "生成快照",
      onAction: () => snapshot({ kind: "query", query: effective }),
    },
  ];
  const savedFilterMenu = (
    <Menu
      label="保存的筛选"
      indicator
      variant="text"
      className="library-saved-filters"
      items={[
        ...views.map((view) => ({
          id: `view:${view.filter_id}`,
          label: view.name,
          checked: view.filter_id === activeView,
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
                divider: views.length > 0,
                disabled: true,
                onAction: () => {},
              },
            ]
          : []),
        {
          id: "save",
          label: "保存当前筛选…",
          divider: views.length > 0 || !!savedFilters.error,
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
        {
          // User organization 9.5: every saved filter as one file.
          id: "export",
          label: "导出筛选",
          divider: true,
          onAction: () => {
            void exportFilters(api)
              .then((blob) => download(blob, "sciretriever-filters.json"))
              .catch((error: unknown) =>
                shell.notify(`没有导出筛选。${errorMessage(error)}`),
              );
          },
        },
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
  );
  const toolbarActions = (
    <>
      {/* One press opens or closes the conditions (page specs “文献库”). */}
      <Button
        variant="text"
        icon={<Icon name="filter" />}
        className="library-filter-toggle"
        aria-expanded={filters}
        onPress={() => {
          setFilters(!filters);
          setMobileTools(false);
        }}
      >
        {`筛选${
          activeView
            ? `：${views.find((view) => view.filter_id === activeView)?.name ?? ""}`
            : chips.length
              ? ` · ${chips.length}`
              : ""
        }`}
      </Button>
      <Select
        label="排序"
        prefix="排序"
        value={route.sort}
        onChange={(sort) =>
          updateQuery(
            route.query,
            parseLibrarySearchRequest({ query: route.query, sort }).sort,
          )
        }
        options={LIBRARY_MENU_SORTS.filter(
          (value) =>
            value === route.sort ||
            (value === "relevance"
              ? view === "search"
              : value !== "collected-desc" ||
                (view !== "search" &&
                  route.query.collection_scope !== "candidates")),
        ).map((value) => ({
          value,
          label: SORT_LABELS[value],
          // Beyond 10,000 papers only the view's own sort has an index
          // (page specs “超过一万篇”).
          // The chosen one stays as it is: the list says why it fails.
          ...(sortLimited &&
          value !== route.sort &&
          (scanIncomplete || windowNumber > 1
            ? !windowSorts.includes(value)
            : value !== allowedSort)
            ? { disabled: true, description: SORT_LIMIT_REASON }
            : {}),
        }))}
      />
      <span className="library-display">
        <span aria-hidden>显示</span>
        <SegmentedControl
          label="显示方式"
          value={display}
          onChange={(value) => chooseDisplay(value as LibraryDisplay)}
          items={[
            { id: "list", label: "列表" },
            { id: "table", label: "表格" },
          ]}
        />
      </span>
      {mutable && total > 0 ? (
        <Menu label="批量操作" indicator variant="text" items={batchItems} />
      ) : null}
      <IconButton
        className="library-pin"
        variant="text"
        aria-label={controlsPinned ? "取消固定" : "滚动时固定搜索与筛选"}
        aria-pressed={controlsPinned}
        icon={<Icon name="pin" />}
        onPress={() => setControlsPinned(!controlsPinned)}
      />
    </>
  );
  // The table's column heads stick under what stays of the top. Unpinned,
  // the block slides up until the title row reaches the top: the search box
  // goes with the page, the title and its tools stay.
  const controls = useRef<HTMLDivElement>(null);
  const stick = useRef(0);
  useLayoutEffect(() => {
    const element = controls.current,
      section = element?.parentElement;
    if (!element || !section) return;
    const measure = () => {
      const header = element.querySelector<HTMLElement>(
        ":scope > .ui-page-header",
      );
      stick.current =
        controlsPinned || !header ? 0 : Math.max(0, header.offsetTop - 12);
      section.style.setProperty(
        "--library-controls-stick",
        `${stick.current}px`,
      );
      section.style.setProperty(
        "--library-controls-height",
        `${element.offsetHeight - stick.current}px`,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [api.workspace.readiness, controlsPinned]);
  // Whether the top has slid under, and whether the way back is worth a
  // button: marked on the page itself, so scrolling draws nothing again.
  useEffect(() => {
    const section = page.current,
      container = section?.closest<HTMLElement>(".workspace-content");
    if (!section || !container) return;
    const mark = () => {
      section.toggleAttribute(
        "data-stuck",
        container.scrollTop > stick.current,
      );
      section.toggleAttribute(
        "data-scrolled",
        container.scrollTop > BACK_TO_TOP_AFTER,
      );
    };
    mark();
    container.addEventListener("scroll", mark, { passive: true });
    return () => container.removeEventListener("scroll", mark);
  }, [api.workspace.readiness, controlsPinned]);
  // The filter panel opens under the title row: unpinned and scrolled away,
  // the page returns to the top so that it is seen.
  useEffect(() => {
    const container = page.current?.closest<HTMLElement>(".workspace-content");
    if (filters && !controlsPinned && container && container.scrollTop > 0)
      container.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);
  // At once: the list corrects its own offset as rows are measured, which
  // stops a smooth scroll part of the way.
  const backToTop = () =>
    page.current
      ?.closest<HTMLElement>(".workspace-content")
      ?.scrollTo({ top: 0 });
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
  const scopeTotal = scopeCounts.data?.total;
  const pageName =
    folderLabel ??
    (view === "recent"
      ? "最近读过"
      : view === "batch"
        ? (batch.data?.label ?? "批次")
        : route.query.collection_scope === "candidates"
          ? "候选"
          : "文献库");
  const inView =
    !!route.query.folder ||
    !!route.query.recently_opened ||
    route.query.intake_batch_ids.length > 0 ||
    route.query.collection_scope === "candidates";
  const searchLabel =
    view !== "search" || inView
      ? `在「${pageName}」里搜索`
      : route.query.collection_scope === "collected"
        ? "在文献库里搜索"
        : "搜索文献";
  /** Totals at the title, once (page specs “文献库”, “超过一万篇”). */
  const headerCount = (() => {
    // Nothing in a window is said below the list, not as “0 篇”.
    if (
      view === "search" &&
      total === 0 &&
      (scanIncomplete || windowNumber > 1)
    )
      return undefined;
    if (view === "search")
      return next.data ? (
        <CountFigure
          key={`${JSON.stringify(effective)}:${windowCursor ?? ""}`}
          query={effective}
          value={total}
          truncated={truncated}
          incomplete={lowerBound}
          exact={windowNumber === 1}
          // An earlier window counts its own hits.
          prefix={windowNumber > 1 ? "这一批 " : ""}
          suffix="符合"
        />
      ) : undefined;
    if (scopeTotal === undefined || (narrowed && !next.data)) return undefined;
    const prefix = view === "recent" ? "最近 30 天 · " : "";
    const scopeText = libraryCount(
      scopeTotal,
      scopeCounts.data?.count_truncated === true,
      "篇",
    );
    return narrowed ? (
      <CountFigure
        key={JSON.stringify(effective)}
        query={effective}
        value={total}
        truncated={truncated}
        prefix={`${prefix}符合 `}
        suffix={` / 共 ${scopeText}`}
      />
    ) : (
      <CountFigure
        key={JSON.stringify(baseScope)}
        query={baseScope}
        value={scopeTotal}
        truncated={scopeCounts.data?.count_truncated === true}
        prefix={`${prefix}共 `}
      />
    );
  })();
  // The library says how many candidates stand behind it; a press lists them.
  const candidateCount =
    view === "collected"
      ? (libraryTotals.data?.collection_counts?.discovered_only ?? 0)
      : 0;
  const allLoaded =
    items.length > 0 &&
    items.every((item) => shell.selected.has(item.literature.literature_id));
  // In the table's head the box stands alone; its name stays.
  const selectAll = (visible: boolean) => (
    <Checkbox
      {...(visible ? { label: "全选已加载" } : { "aria-label": "全选已加载" })}
      isIndeterminate={
        items.some((item) =>
          shell.selected.has(item.literature.literature_id),
        ) && !allLoaded
      }
      isSelected={allLoaded}
      onChange={(checked) => {
        const selected = new Set(shell.selected);
        for (const item of items) {
          if (checked) selected.add(item.literature.literature_id);
          else selected.delete(item.literature.literature_id);
        }
        shell.setSelected(selected);
      }}
    />
  );
  const selectWhole =
    allLoaded && total > items.length ? (
      <Button
        variant="text"
        size="compact"
        isPending={choosing}
        disabledReason={
          scanIncomplete
            ? scanIncompleteReason(scanSide)
            : total > 1000 || truncated
              ? `共 ${libraryCount(total, truncated, "篇")}，超过 1,000 篇上限。获取 PDF 可用“批量操作 → 获取 PDF”整体提交。`
              : undefined
        }
        onPress={selectScope}
      >
        选择全部 {libraryCount(total, truncated, "篇")}符合条件的文献
      </Button>
    ) : null;
  // Under the title row: the search's scope, the notices, the material
  // classes, the conditions with the words of the results, and the filter
  // panel. They stay with the title only when the reader pins the top.
  const controlsRest = (
    <>
      {view === "search" ? (
        <SearchScope
          query={route.query}
          origin={
            origin ??
            (inView
              ? {
                  scope: {
                    ...(route.query.folder
                      ? { folder: route.query.folder }
                      : {}),
                    ...(route.query.recently_opened
                      ? { recently_opened: true }
                      : {}),
                    ...(route.query.intake_batch_ids.length
                      ? { intake_batch_ids: route.query.intake_batch_ids }
                      : {}),
                  },
                  name: pageName,
                }
              : null)
          }
          relevanceLimit={
            route.sort === "relevance" && !emptyWindow
              ? (firstPage?.relevanceLimit ?? null)
              : null
          }
          scoredNote={scoredNote}
          continueLabel={continueLabel}
          firstWindowLabel={firstWindowLabel}
          windowPhrase={
            (scanIncomplete || windowNumber > 1) && !emptyWindow
              ? windowPhrase
              : null
          }
          onFirstWindow={windowNumber > 1 ? firstWindow : null}
          onContinue={emptyWindow ? null : continueWindow}
          onChange={updateQuery}
        />
      ) : null}
      {(next.data?.pages[0]?.backfillPending ?? 0) > 0 ? (
        <p role="status" className="library-notice">
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
      <div className="library-quick">
        <div className="library-status-filters" aria-label="按材料状态筛选">
          {[
            { id: "" as const, label: "全部" },
            ...MAIN_MATERIAL_STATES,
            // A category from “更多状态” shows as a chip while selected.
            ...MORE_MATERIAL_STATES.filter(
              (filter) => statusFilter === filter.id,
            ),
          ]
            .filter(
              (filter) =>
                filter.id === "" ||
                statusFilter === filter.id ||
                countFor(filter.id) !== 0,
            )
            .map((filter) => (
              <FilterChip
                key={filter.id}
                isSelected={statusFilter === filter.id}
                onChange={() => setStatusFilter(filter.id)}
              >
                {filter.label}
                {countFor(filter.id) !== null && quickCount(filter.id)
                  ? " "
                  : null}
                {countFor(filter.id) !== null && quickCount(filter.id) ? (
                  <span className="filter-count">{quickCount(filter.id)}</span>
                ) : null}
              </FilterChip>
            ))}
          {MORE_MATERIAL_STATES.some(
            (filter) => statusFilter !== filter.id && countFor(filter.id) !== 0,
          ) ? (
            <Menu
              label="更多状态"
              indicator
              variant="text"
              items={MORE_MATERIAL_STATES.filter(
                (filter) =>
                  statusFilter !== filter.id && countFor(filter.id) !== 0,
              ).map((filter) => ({
                id: filter.id,
                label:
                  countFor(filter.id) === null
                    ? filter.label
                    : [filter.label, quickCount(filter.id)]
                        .filter(Boolean)
                        .join(" "),
                onAction: () => setStatusFilter(filter.id),
              }))}
            />
          ) : null}
          {/* Statuses recomputed in the background after a settings
                change (page specs “超过一万篇”). */}
          {counts.data?.status_updating || firstPage?.statusUpdating ? (
            <span className="library-status-updating" role="status">
              状态正在更新，数字可能不准
            </span>
          ) : null}
        </div>
        {/* “全选已加载” joins this line once a selection has begun, so the
              rows below never move (page specs “勾选框”). */}
        {(display === "list" && items.length > 0 && shell.selected.size > 0) ||
        selectWhole ? (
          <div className="library-select-all">
            {display === "list" && items.length > 0 && shell.selected.size > 0
              ? selectAll(true)
              : null}
            {selectWhole}
          </div>
        ) : null}
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
          {/* The one “清除” (page specs “文献库”): every condition goes, the
                search and the page's scope stay. */}
          <Button
            variant="text"
            size="compact"
            onPress={() => clearConditions(false)}
          >
            清除
          </Button>
        </div>
      )}
      {chips.length > 0 ? (
        <ScopeTerms
          query={effective}
          windowCursor={windowCursor}
          lowerBound={windowNumber === 1}
          onWindowInvalid={windowCursor === null ? undefined : firstWindow}
          onChange={(query) =>
            updateQuery(withoutScopeFlag(query, route.query))
          }
        />
      ) : null}
      <Presence>
        {filters && (
          <AnimatedPanel key="filters" preset="collapse">
            <Filters
              query={route.query}
              menu={savedFilterMenu}
              onApply={updateQuery}
            />
          </AnimatedPanel>
        )}
      </Presence>
      {next.isPending ? (
        <p role="status" className="library-loading">
          正在读取文献…
        </p>
      ) : null}
    </>
  );
  return (
    <section
      ref={page}
      className="library-page"
      data-wide={wide || undefined}
      data-preview={shownPeek !== null || undefined}
      data-preview-docked={docked || undefined}
      data-display={display}
      data-controls={controlsPinned ? "pinned" : "free"}
      {...(previewWidth === null
        ? {}
        : {
            style: {
              // Never so wide that the list is squeezed out of a small window.
              "--library-preview-width": `min(${previewWidth}px, 60vw)`,
            } as CSSProperties,
          })}
      // A click on empty space lets the selection go: not on a row, a
      // control, the selection bar, the preview, or anything laid over the
      // page, and not the click that ends a drawn selection.
      onClick={(event) => {
        if (
          !shell.selected.size ||
          event.defaultPrevented ||
          range.handledByPress() ||
          // Menus and dialogs are drawn outside the page: a click that
          // closes one is not a click on the page's empty space.
          !event.currentTarget.contains(event.target as Node) ||
          (event.target as Element).closest?.(
            'button, a, input, textarea, select, label, summary, [role="menu"], [role="dialog"], [role="listbox"], [role="tab"], .ui-popover, .ui-overlay, .ui-toast, .paper-row, .selection-wrap, .library-preview',
          )
        )
          return;
        shell.setSelected(new Set());
      }}
    >
      <div className="library-controls" ref={controls}>
        {/* The search box tops every view: from the library it covers the
            whole library, from another view that view (page specs “搜索框”). */}
        <div className="library-toolbar">
          <SearchField
            label={view === "collected" ? "搜索文献" : searchLabel}
            value={text}
            onChange={setText}
            onSubmit={(value) =>
              view === "collected"
                ? searchWholeLibrary(value)
                : updateQuery({ ...route.query, text: value.trim() || null })
            }
            placeholder={view === "collected" ? "搜索文献" : searchLabel}
          />
        </div>
        <PageHeader
          title={view === "search" ? `搜索“${route.query.text}”` : pageName}
          count={
            candidateCount > 0 ? (
              <>
                {headerCount}
                <Button
                  variant="text"
                  size="compact"
                  className="library-candidates"
                  onPress={() =>
                    navigate({
                      query: JSON.stringify({
                        ...emptyQuery(),
                        collection_scope: "candidates",
                      }),
                      sort: null,
                    })
                  }
                >
                  候选 {candidateCount.toLocaleString()} 篇
                </Button>
              </>
            ) : (
              headerCount
            )
          }
          action={
            <>
              <div className="library-toolbar-actions">{toolbarActions}</div>
              <Button
                className="library-more"
                onPress={() => setMobileTools(true)}
              >
                更多操作
              </Button>
            </>
          }
        />
        {controlsPinned ? controlsRest : null}
      </div>
      {controlsPinned ? null : (
        <div className="library-controls-rest">{controlsRest}</div>
      )}
      <LayoutGroup className="library-results-region">
        {next.isError && !sortRefused && !isWindowInvalid(next.error) && (
          <ErrorNotice
            message={errorMessage(next.error)}
            onRetry={() => void next.refetch()}
          />
        )}
        <LibraryList
          key={display}
          display={display}
          items={items}
          total={total}
          sort={route.sort}
          onSort={(sort) => updateQuery(route.query, sort)}
          sortDisabled={sortLimited ? SORT_LIMIT_REASON : undefined}
          unrankedFrom={sectioned ? null : relevanceScored}
          candidatesFrom={candidatesFrom}
          candidatesOnly={route.query.collection_scope === "candidates"}
          libraryHead={
            sectioned && libraryHits.data && libraryHits.data.items.length ? (
              <>
                <b>文献库里</b>
                <span>
                  {libraryCount(
                    libraryHits.data.total,
                    libraryHits.data.truncated,
                    "篇",
                  )}
                </span>
                {libraryHits.data.total > libraryHits.data.items.length ? (
                  <Button
                    variant="text"
                    size="compact"
                    onPress={() =>
                      updateQuery(inScope(route.query, "collected"))
                    }
                  >
                    只看文献库里的
                  </Button>
                ) : null}
              </>
            ) : null
          }
          candidatesHead={
            sectioned ? (
              <>
                <b>候选</b>
                <span>
                  {lowerBound ? "至少 " : ""}
                  {libraryCount(
                    Math.max(0, total - (libraryHits.data?.total ?? 0)),
                    truncated,
                    "篇",
                  )}
                </span>
                <span className="paper-section-note">
                  发现任务找到、还没有加入文献库的文献
                </span>
              </>
            ) : null
          }
          selectAll={selectAll(false)}
          empty={
            sortRefused ? (
              // The same words as the menu, and the one sort that works.
              <div className="library-sort-limit" role="status">
                <p>{SORT_LIMIT_REASON}</p>
                <Button onPress={() => updateQuery(route.query, allowedSort)}>
                  改按{SORT_LABELS[allowedSort]}
                </Button>
              </div>
            ) : scanIncomplete && continueWindow && windowPhrase ? (
              // Nothing in this window is not nothing in the library.
              <EmptyState
                title={`${windowPhrase}里没有，更早的还没查`}
                action={
                  <Button
                    variant="text"
                    size="compact"
                    onPress={continueWindow}
                  >
                    {continueLabel}
                  </Button>
                }
              />
            ) : view === "collected" && !narrowed ? (
              <EmptyState
                title="文献库里还没有文献"
                {...((libraryTotals.data?.collection_counts?.discovered_only ??
                  0) > 0
                  ? { description: "在上方搜索，也会列出候选" }
                  : {})}
                action={
                  mutable ? (
                    <Button
                      variant="text"
                      size="compact"
                      onPress={() =>
                        navigate(
                          { view: "disc", literature: null },
                          { clearSource: true },
                        )
                      }
                    >
                      去找文献
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <EmptyState
                title="没有符合条件的文献"
                action={
                  narrowed || view === "search" ? (
                    <Button
                      variant="text"
                      size="compact"
                      onPress={() => clearConditions(true)}
                    >
                      清除条件
                    </Button>
                  ) : undefined
                }
              />
            )
          }
          footer={
            <>
              {firstPage?.relevanceLimit &&
              route.sort === "relevance" &&
              !next.hasNextPage &&
              items.length >= firstPage.relevanceLimit ? (
                <p className="library-relevance-end" role="status">
                  相关度排序只显示前 {firstPage.relevanceLimit.toLocaleString()}{" "}
                  条；加条件或换个检索词可以看到其余的
                </p>
              ) : null}
              {/* The library has hits and this window of the index has no
                  candidate: said where the candidates would begin, above the
                  way on to the earlier hits. */}
              {candidatesFrom !== null &&
              items.length === candidatesFrom &&
              scanIncomplete &&
              windowPhrase ? (
                <p className="library-candidates-none" role="status">
                  <b>候选</b>
                  {windowPhrase}里没有，更早的还没查
                </p>
              ) : null}
              {/* At the end of a window, the way on to the earlier hits. */}
              {continueWindow ? (
                <p className="library-window-end">
                  <Button
                    variant="text"
                    size="compact"
                    onPress={continueWindow}
                  >
                    {continueLabel}
                  </Button>
                </p>
              ) : null}
            </>
          }
          collectedNow={collectedNow}
          onCollect={mutable ? collect : undefined}
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
            // Coming back, the right column shows the paper that was read.
            currents.set(scopeKey, args[0]);
            shell.openPaper(...args);
          }}
          peek={current}
          onPreview={setPeek}
          onPeek={(id) => {
            setPeek(id);
            setOverlay(true);
          }}
          onFile={onFile}
          onRowAction={onRowAction}
          rowFolder={folder ? (folderLabel ?? "文件夹") : null}
          onRowMenu={mutable ? onRowMenu : undefined}
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
                  {discovered.length ? (
                    <Button
                      variant="primary"
                      icon={<Icon name="plus" />}
                      onPress={() =>
                        void collect(discovered).catch((error: unknown) =>
                          shell.notify(errorMessage(error)),
                        )
                      }
                    >
                      加入文献库 <span>{discovered.length}</span>
                    </Button>
                  ) : null}
                  <Button
                    variant={primary === "acquire" ? "primary" : "secondary"}
                    disabledReason={acquireReason}
                    onPress={acquireSelected}
                  >
                    获取 PDF <span>{groups["no-pdf"].length}</span>
                  </Button>
                  <Button
                    variant={primary === "archive" ? "primary" : "secondary"}
                    disabledReason={archivingReason}
                    onPress={() =>
                      setOperation({ ids: groups.unarchived, kind: "archive" })
                    }
                  >
                    解析全文 <span>{groups.unarchived.length}</span>
                  </Button>
                  <Button
                    icon={<Icon name="folder" />}
                    disabledReason={moveReason}
                    onPress={() => setAdding([...shell.selected])}
                  >
                    移动…
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
                        id: "export",
                        label: "导出…",
                        onAction: () => void operate("export", true),
                      },
                      ...uncollectItem,
                      {
                        id: "delete",
                        label: `删除 ${shell.selected.size.toLocaleString()} 篇…`,
                        onAction: () =>
                          deletion.request({
                            ids: [...shell.selected],
                            label: `已选的 ${shell.selected.size.toLocaleString()} 篇文献`,
                          }),
                      },
                      ...recognizeItem.map((item) => ({
                        ...item,
                        divider: true,
                      })),
                      {
                        id: "cite",
                        label: "扩展引用…",
                        ...(recognizeItem.length ? {} : { divider: true }),
                        ...(shell.selected.size > CITATION_SEED_LIMIT
                          ? {
                              disabled: true,
                              description: `最多以 ${CITATION_SEED_LIMIT.toLocaleString()} 篇为种子，请减少选择。`,
                            }
                          : {}),
                        onAction: () =>
                          expandCitations(seedsOf(shell.selected)),
                      },
                      {
                        id: "identity",
                        label: "核验文章身份",
                        onAction: () => void operate("identity", true),
                      },
                      processingHeading,
                      {
                        id: "run",
                        label: `运行算子 ${groups.ready.length}`,
                        ...(runReason
                          ? { disabled: true, description: runReason }
                          : {}),
                        onAction: () =>
                          setRunner({
                            scope: { kind: "literatures", ids: groups.ready },
                            label: `已选中有全文的 ${groups.ready.length} 篇`,
                          }),
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
                    ]}
                  />
                </>
              ) : (
                <Button onPress={() => void operate("export", true)}>
                  导出…
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
        <MoveToFolderDialog
          ids={adding}
          from={
            folder ? { id: folder.id, label: folderLabel ?? "文件夹" } : null
          }
          onClose={() => setAdding(null)}
        />
      ) : null}
      <Drawer
        title="文献库操作"
        isOpen={mobileTools}
        onOpenChange={setMobileTools}
      >
        <div className="library-mobile-tools">{toolbarActions}</div>
      </Drawer>
      {/* One button in one place, the page's top right corner, whether the
          right column is open or not (page specs “文献库”). */}
      {wide ? (
        <IconButton
          className="library-preview-toggle"
          variant="text"
          aria-label={previewOpen ? "收起右栏" : "显示右栏"}
          aria-pressed={previewOpen}
          icon={<Icon name="panel" />}
          onPress={() => togglePreview(!previewOpen)}
        />
      ) : null}
      {docked ? (
        <PreviewResizer
          page={page}
          width={previewWidth}
          onCommit={setPreviewWidth}
        />
      ) : null}
      {shownPeek !== null ? (
        <LibraryPreview
          id={shownPeek}
          docked={docked}
          mutable={mutable}
          onClose={() => {
            // Either way the current row stays the current row.
            if (docked) return togglePreview(false);
            const id = shownPeek;
            setOverlay(false);
            // Focus goes back to the row the preview showed.
            requestAnimationFrame(() =>
              document
                .querySelector<HTMLElement>(
                  `.paper-row[data-literature-id="${CSS.escape(id)}"]`,
                )
                ?.focus(),
            );
          }}
          onOpen={(id, title) => {
            setOverlay(false);
            currents.set(scopeKey, id);
            shell.openPaper(id, undefined, undefined, title);
          }}
          onAcquire={(id, title) =>
            setAcquire({
              kind: "literatures",
              ids: [id],
              label: `《${title}》`,
            })
          }
        />
      ) : null}
      <ContextMenu
        request={rowMenu}
        onClose={() => setRowMenu(null)}
        onRetarget={(event, element) => {
          const id = element?.closest<HTMLElement>(
            ".paper-row[data-literature-id]",
          )?.dataset.literatureId;
          if (id) onRowMenu(id, event.clientX, event.clientY, false);
          else setRowMenu(null);
        }}
      />
      <div className="library-top-wrap">
        <IconButton
          className="library-top"
          aria-label="回到顶部"
          icon={<Icon name="top" />}
          onPress={backToTop}
        />
      </div>
      {deletion.dialog}
      {removal.dialog}
      <ConfirmDialog
        title="识别书目"
        isOpen={recognizing !== null}
        onOpenChange={(open) => {
          if (open) return;
          setRecognizing(null);
          // A failure shown here belongs to this attempt only.
          recognize.reset();
        }}
        confirmLabel="开始识别"
        isPending={recognize.isPending}
        {...(recognize.isError
          ? { errorMessage: errorMessage(recognize.error) }
          : {})}
        scope={`书目不全并且有 PDF 的 ${(recognizing?.length ?? 0).toLocaleString()} 篇`}
        service="已启用的元数据来源（如 Crossref、OpenAlex）"
        description={
          <>
            <p>
              重新读这些文献的 PDF，按其中的 DOI
              和标题到元数据来源查它们是哪一篇。
            </p>
            <p>
              认出的补全作者、期刊、年份等书目；没认出但 PDF
              里有标题的，把现在的文件名换成这个标题。不调用模型。
            </p>
          </>
        }
        onConfirm={() => {
          if (recognizing) recognize.mutate(recognizing);
        }}
      />
      {operation && (
        <OperationDialog {...operation} onClose={() => setOperation(null)} />
      )}
      {acquire && (
        <AcquireDialog scope={acquire} onClose={() => setAcquire(null)} />
      )}
    </section>
  );
}
/** How many papers one “打开阅读” opens as tabs at most. */
const OPEN_TOGETHER_LIMIT = 20;
/**
 * A paper's menu (page specs “文献库”), in two groups. Above the hairline,
 * what one does with any paper: 打开阅读, 移动到文件夹, 移出 the folder being
 * shown, 导出, 删除 (to 最近删除, from where it comes back). Below it, what makes or uses its material: 获取 PDF, 解析全文,
 * 扩展引用, 运行算子. What a paper never needs is left out — 获取 PDF once it
 * has one, 解析全文 once it has its full text; what it cannot do yet stays,
 * disabled, saying why (rule 12).
 */
function rowMenuItems(
  item: LiteratureSearchItem,
  act: (kind: RowAction) => void,
  folder: string | null,
): MenuOption[] {
  const status = item.literature.status;
  const unless = (reason: string | null) =>
    reason ? { disabled: true, description: reason } : {};
  const material: MenuOption[] = [
    // Only a paper marked 书目不全 needs it; it reads the paper's own PDF.
    ...(item.needs_metadata
      ? [
          {
            id: "recognize",
            label: "识别书目…",
            ...unless(status === "UNREVIEWED" ? "需要先有 PDF" : null),
            onAction: () => act("recognize"),
          },
        ]
      : []),
    ...(status === "UNREVIEWED"
      ? [
          {
            id: "acquire",
            label: "获取 PDF",
            ...unless(
              item.needs_manual_pdf
                ? "自动途径都已试过，没找到 PDF；可以把 PDF 拖到这一行上传"
                : null,
            ),
            onAction: () => act("acquire"),
          },
        ]
      : []),
    ...(status === "READY" || status === "EXCLUDED"
      ? []
      : [
          {
            id: "archive",
            label: "解析全文",
            ...unless(
              status === "UNREVIEWED"
                ? "需要先有 PDF"
                : status === "ARCHIVING"
                  ? "正在解析全文"
                  : null,
            ),
            onAction: () => act("archive"),
          },
        ]),
    {
      id: "cite",
      label: "扩展引用…",
      onAction: () => act("cite"),
    },
    {
      id: "run",
      label: "运行算子…",
      ...unless(status === "READY" ? null : "需要先有全文"),
      onAction: () => act("run"),
    },
  ];
  // A candidate is one press from the library; a paper of the library can
  // leave it again (ADR 0067 sections 4 and 5).
  const candidate = item.collected === false;
  return [
    {
      id: "open",
      label: "打开阅读",
      onAction: () => act("open"),
    },
    ...(candidate
      ? [
          {
            id: "collect",
            label: "加入文献库",
            onAction: () => act("collect"),
          },
        ]
      : [
          // Folders hold papers of the library only (ADR 0067 section 5).
          {
            id: "folder",
            label: "移动…",
            onAction: () => act("folder"),
          },
        ]),
    ...(folder
      ? [
          {
            id: "remove-folder",
            label: `移出「${folder}」`,
            onAction: () => act("remove-folder"),
          },
        ]
      : []),
    {
      id: "export",
      label: "导出…",
      onAction: () => act("export"),
    },
    ...(candidate
      ? []
      : [
          {
            id: "uncollect",
            label: "移出文献库…",
            onAction: () => act("uncollect"),
          },
        ]),
    {
      id: "delete",
      label: "删除",
      shortcut: "Del",
      onAction: () => act("delete"),
    },
    ...material.map((option, index) =>
      index === 0 ? { ...option, divider: true } : option,
    ),
  ];
}
/**
 * The preview beside the list (page specs “文献库”): no veil over the page, so
 * another row's preview is one press away; ↑ and ↓ move to the paper before
 * or after; Esc or the close button returns to the row.
 */
function LibraryPreview({
  id,
  docked,
  mutable,
  onClose,
  onOpen,
  onAcquire,
}: {
  id: string;
  /** Standing beside the list (wide) rather than opened over it. */
  docked: boolean;
  mutable: boolean;
  onClose: () => void;
  onOpen: (id: string, title: string) => void;
  onAcquire: (id: string, title: string) => void;
}) {
  const api = useApi();
  const panel = useRef<HTMLElement>(null);
  const preview = useQuery({
    queryKey: ["literature", id],
    queryFn: ({ signal }) => readLiterature(api, id, signal),
    placeholderData: keepPreviousData,
  });
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    // Beside the list it is part of the page: it takes no focus and Esc
    // leaves it where it is.
    if (docked) return;
    panel.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector('[role="dialog"], [role="menu"]')
      ) {
        // The preview closes first; the selection stays.
        event.preventDefault();
        close.current();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [docked]);
  const item = preview.data;
  const title = item ? paperTitle(item) : "";
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      className="library-preview"
      data-docked={docked || undefined}
      role="region"
      aria-label="文献预览"
      aria-busy={preview.isFetching}
    >
      {/* Docked, the page's own button closes the column from this corner;
          the header only keeps its room. */}
      <div className="library-preview-header">
        {docked ? null : (
          <>
            <span>↑ ↓ 上一篇、下一篇</span>
            <IconButton
              aria-label="关闭预览"
              variant="text"
              icon={<Icon name="close" />}
              onPress={onClose}
            />
          </>
        )}
      </div>
      {preview.isPending ? (
        <p role="status">正在读取…</p>
      ) : preview.isError ? (
        <ErrorNotice
          message={errorMessage(preview.error)}
          onRetry={() => void preview.refetch()}
        />
      ) : item ? (
        <>
          <BibliographyContent
            item={item}
            actions={
              <>
                {/* Not the page's primary: the selection bar and the
                    dialogs have theirs (design core, one primary a page). */}
                <Button onPress={() => onOpen(id, title)}>打开阅读</Button>
                {mutable && item.literature.status === "UNREVIEWED" ? (
                  <Button
                    disabledReason={
                      item.needs_manual_pdf
                        ? "自动途径都已试过，没找到 PDF"
                        : undefined
                    }
                    onPress={() => onAcquire(id, title)}
                  >
                    获取 PDF
                  </Button>
                ) : null}
              </>
            }
          />
          <TechDetails>
            <pre>{JSON.stringify(item.literature, null, 2)}</pre>
          </TechDetails>
        </>
      ) : null}
    </aside>
  );
}
/** Keys a list row or the preview leaves to the field or menu that has them. */
const KEEPS_KEYS =
  "input, textarea, select, [contenteditable], [role='menu'], [role='listbox'], [role='dialog'], [role='tablist']";
/**
 * The table's column heads (page specs “文献库”): a press on 标题 or 年份 sorts
 * by it with the service's own orders; the other columns have none.
 */
const TABLE_SORTS: Readonly<
  Record<"title" | "year", { first: LibrarySort; second: LibrarySort }>
> = {
  title: { first: "title-asc", second: "title-desc" },
  year: { first: "publication-year-desc", second: "publication-year-asc" },
};
function TableHead({
  sort,
  onSort,
  sortDisabled,
  selectAll,
}: {
  sort: LibrarySort;
  onSort: (sort: LibrarySort) => void;
  /** Why the heads do not sort, beyond 10,000 papers. */
  sortDisabled: string | undefined;
  selectAll: ReactNode;
}) {
  const head = (column: keyof typeof TABLE_SORTS, label: string) => {
    const { first, second } = TABLE_SORTS[column];
    const on = sort === first ? "first" : sort === second ? "second" : null;
    const ascending =
      (on === "first") === (first === "title-asc") && on !== null;
    return (
      <span
        role="columnheader"
        className={`library-table-cell library-table-${column}`}
        aria-sort={on ? (ascending ? "ascending" : "descending") : "none"}
      >
        <button
          type="button"
          className="library-table-sort"
          disabled={!!sortDisabled}
          {...(sortDisabled ? { title: sortDisabled } : {})}
          onClick={() => onSort(on === "first" ? second : first)}
        >
          {label}
          {on ? (
            <span className="library-table-arrow" aria-hidden>
              {ascending ? "↑" : "↓"}
            </span>
          ) : null}
        </button>
      </span>
    );
  };
  return (
    <div className="library-table-head" role="row" aria-rowindex={1}>
      <span role="columnheader" className="paper-check">
        {selectAll}
      </span>
      {head("title", "标题")}
      <span role="columnheader" className="library-table-cell paper-author">
        作者
      </span>
      <span role="columnheader" className="library-table-cell paper-venue">
        期刊
      </span>
      {head("year", "年份")}
      <span role="columnheader" className="library-table-cell">
        材料
      </span>
      <span role="columnheader" className="paper-tools" aria-label="操作" />
    </div>
  );
}
/** Scroll-range updates belong to the list, not the page's forms and motion layout. */
const LibraryList = memo(function LibraryList({
  display,
  items,
  total,
  sort,
  onSort,
  sortDisabled,
  unrankedFrom,
  candidatesFrom,
  candidatesOnly,
  libraryHead,
  candidatesHead,
  selectAll,
  empty,
  footer,
  collectedNow,
  onCollect,
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
  peek,
  onPreview,
  onPeek,
  onFile,
  onRowAction,
  rowFolder,
  onRowMenu,
  onDragRow,
}: {
  display: LibraryDisplay;
  items: readonly LiteratureSearchItem[];
  total: number;
  sort: LibrarySort;
  onSort: (sort: LibrarySort) => void;
  sortDisabled: string | undefined;
  /** The first row not ranked by relevance, in a partly ranked set. */
  unrankedFrom: number | null;
  /** In a whole-library search, the row the candidates begin at. */
  candidatesFrom: number | null;
  /** The page lists candidates only: its rows need not each say so. */
  candidatesOnly: boolean;
  libraryHead: ReactNode;
  candidatesHead: ReactNode;
  selectAll: ReactNode;
  empty: ReactNode;
  /** After the last row: the end of a relevance ranking. */
  footer: ReactNode;
  collectedNow: ReadonlySet<string>;
  onCollect: ((ids: readonly string[]) => Promise<unknown>) | undefined;
  selected: ReadonlySet<string>;
  mutable: boolean;
  scrollKey: string;
  positions: Map<string, ScrollPosition>;
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
  peek: string | null;
  /** Opens the preview on a row, where no right column shows it. */
  onPeek: (id: string) => void;
  onPreview: (id: string) => void;
  onFile: (id: string, file: File) => void;
  onRowAction: (id: string, title: string, kind: RowAction) => void;
  /** The folder being shown, when there is one: rows can leave it. */
  rowFolder: string | null;
  onRowMenu: RowMenu | undefined;
  onDragRow: (id: string, data: DataTransfer, title: string) => boolean;
}) {
  const table = display === "table";
  const list = useRef<HTMLDivElement>(null);
  const rowsBox = useRef<HTMLDivElement | null>(null);
  // The whole page scrolls; the list measures its offset inside that container.
  const scroll = useRef<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const getScrollElement = useCallback(() => scroll.current, []);
  /** The rows' offset inside the scrolling page. */
  const listOffset = useCallback(() => {
    const container = scroll.current,
      element = rowsBox.current ?? list.current;
    return container && element
      ? Math.round(
          element.getBoundingClientRect().top -
            container.getBoundingClientRect().top +
            container.scrollTop,
        )
      : 0;
  }, []);
  useLayoutEffect(() => {
    const element = list.current;
    scroll.current =
      element?.closest<HTMLElement>(".workspace-content") ?? null;
    const container = scroll.current;
    if (!element || !container) return;
    const measure = () => setScrollMargin(listOffset());
    measure();
    const observer = new ResizeObserver(measure);
    for (const sibling of element.parentElement?.parentElement?.children ?? [])
      if (!sibling.contains(element)) observer.observe(sibling);
    return () => observer.disconnect();
  }, [listOffset]);
  const getItemKey = useCallback(
    (index: number) => items[index]!.literature.literature_id,
    [items],
  );
  const initial = useMemo(
    () => ({
      offset: positions.get(scrollKey)?.top ?? 0,
      measurements: measurements.get(scrollKey) ?? [],
    }),
    [positions, measurements, scrollKey],
  );
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement,
    // Keep the scroll range and row positions in the same measured commit.
    directDomUpdates: true,
    estimateSize: table ? estimateTableRowSize : estimateRowSize,
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
      const saved = positions.get(scrollKey);
      // Within the list, the same rows; above it, the same place.
      const top = !saved
        ? 0
        : saved.top > saved.margin
          ? saved.top - saved.margin + listOffset()
          : saved.top;
      scroll.current?.scrollTo({ top });
      restored.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollKey, positions, listOffset]);
  useEffect(() => {
    const container = scroll.current;
    if (!container) return;
    const remember = () => {
      if (!restored.current) return;
      positions.set(scrollKey, {
        top: container.scrollTop,
        margin: listOffset(),
      });
      measurements.set(scrollKey, virtual.measurementsCache.slice());
    };
    container.addEventListener("scroll", remember, { passive: true });
    return () => container.removeEventListener("scroll", remember);
  }, [scrollKey, positions, measurements, virtual, listOffset]);
  // While a preview is open, moving through the rows moves the preview too.
  const previewing = useRef(peek !== null);
  previewing.current = peek !== null;
  const onMove = useCallback(
    (index: number) => {
      const target = Math.max(0, Math.min(items.length - 1, index));
      virtual.scrollToIndex(target);
      if (previewing.current)
        onPreview(items[target]!.literature.literature_id);
      requestAnimationFrame(() =>
        list.current
          ?.querySelector<HTMLElement>(`[data-index="${target}"]`)
          ?.focus(),
      );
    },
    [virtual, items, onPreview],
  );
  // ↑ and ↓ outside the rows (the preview, a row's buttons) step the preview.
  useEffect(() => {
    if (peek === null) return;
    const key = (event: KeyboardEvent) => {
      if (
        (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
        event.defaultPrevented ||
        event.altKey ||
        event.metaKey ||
        event.ctrlKey
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        target?.matches?.(".paper-row") ||
        target?.closest?.(KEEPS_KEYS) ||
        document.querySelector("[role='dialog'], [role='menu']")
      )
        return;
      const at = items.findIndex(
        (item) => item.literature.literature_id === peek,
      );
      if (at < 0) return;
      event.preventDefault();
      const to = Math.max(
        0,
        Math.min(items.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)),
      );
      if (to === at) return;
      virtual.scrollToIndex(to);
      onPreview(items[to]!.literature.literature_id);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [peek, items, virtual, onPreview]);
  const containerRef = virtual.containerRef;
  const setRowsBox = useCallback(
    (element: HTMLDivElement | null) => {
      rowsBox.current = element;
      containerRef(element);
    },
    [containerRef],
  );
  const shown = !pending && items.length > 0;
  return (
    <div
      className="library-scroll"
      ref={list}
      aria-label="文献列表"
      tabIndex={-1}
      aria-busy={fetching}
      // For tests and measurement: how many rows are loaded of how many.
      data-loaded={items.length}
      data-total={total}
      {...(table
        ? { role: "table", "aria-rowcount": total + 1, "data-display": "table" }
        : {})}
    >
      {!pending && !items.length ? (
        <div className="library-empty">{empty}</div>
      ) : null}
      {table && shown ? (
        <TableHead
          sort={sort}
          onSort={onSort}
          sortDisabled={sortDisabled}
          selectAll={selectAll}
        />
      ) : null}
      <div
        className="virtual-list"
        ref={setRowsBox}
        {...(table ? { role: "rowgroup" } : {})}
      >
        {rows.map((row) => (
          <LibraryRow
            key={row.key}
            display={display}
            row={row}
            offset={scrollMargin}
            item={items[row.index]!}
            sort={sort}
            collectedNow={collectedNow.has(
              items[row.index]!.literature.literature_id,
            )}
            // Where the ranked rows end, among the loaded ones.
            unrankedStart={
              !table &&
              unrankedFrom !== null &&
              unrankedFrom > 0 &&
              row.index === unrankedFrom
            }
            // The two sections of a whole-library search open with a line.
            head={
              candidatesFrom === null
                ? null
                : row.index === candidatesFrom
                  ? candidatesHead
                  : row.index === 0
                    ? libraryHead
                    : null
            }
            // Under “候选” the rows need not each say so again.
            underCandidates={
              candidatesOnly ||
              (candidatesFrom !== null && row.index >= candidatesFrom)
            }
            onCollect={onCollect}
            selected={selected.has(items[row.index]!.literature.literature_id)}
            previewed={peek === items[row.index]!.literature.literature_id}
            mutable={mutable}
            measure={virtual.measureElement}
            onToggle={onToggle}
            onCheckPointerDown={onCheckPointerDown}
            onRowPointerDown={onRowPointerDown}
            onCheckClickCapture={onCheckClickCapture}
            selectingRange={selectingRange}
            onOpen={onOpen}
            onPreview={onPreview}
            onPeek={onPeek}
            onFile={onFile}
            onRowAction={onRowAction}
            rowFolder={rowFolder}
            onRowMenu={onRowMenu}
            onMove={onMove}
            onDragRow={onDragRow}
          />
        ))}
      </div>
      {fetchingNextPage && <p role="status">正在读取下一批…</p>}
      {shown && !hasNextPage ? footer : null}
      {nextPageFailed && (
        <Button onPress={() => void loadNextPage()}>重试读取下一批</Button>
      )}
    </div>
  );
});
const estimateRowSize = () => 62;
/** Table rows are one line, 32 px (page specs “文献库”). */
const estimateTableRowSize = () => 32;
type CheckPointerDown = (
  index: number,
  event: ReactPointerEvent<HTMLElement>,
) => void;
type RowAction =
  | "open"
  | "collect"
  | "uncollect"
  | "folder"
  | "remove-folder"
  | "export"
  | "delete"
  | "delete-key"
  | "recognize"
  | "acquire"
  | "archive"
  | "cite"
  | "run";
type RowMenu = (id: string, x: number, y: number, keyboard: boolean) => void;
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
/** Almost the whole catalog is metadata-only; only departures get a label. */
const quietState = (item: LiteratureSearchItem) =>
  item.literature.status === "UNREVIEWED" && !item.needs_manual_pdf;

const LibraryRow = memo(function LibraryRow({
  display,
  row,
  offset,
  item,
  sort,
  collectedNow,
  unrankedStart,
  head,
  underCandidates,
  onCollect,
  selected,
  previewed,
  mutable,
  measure,
  onToggle,
  onCheckPointerDown,
  onRowPointerDown,
  onCheckClickCapture,
  selectingRange,
  onOpen,
  onPreview,
  onPeek,
  onFile,
  onRowAction,
  rowFolder,
  onRowMenu,
  onMove,
  onDragRow,
}: {
  display: LibraryDisplay;
  row: VirtualItem;
  offset: number;
  item: LiteratureSearchItem;
  sort: LibrarySort;
  /** Collected on this page: “已加入” in place of the button. */
  collectedNow: boolean;
  /** The first row the relevance ranking did not reach. */
  unrankedStart: boolean;
  /** The line that opens a section of the results, above this row. */
  head: ReactNode;
  /** Listed under the “候选” line: only where it came from is written. */
  underCandidates: boolean;
  onCollect: ((ids: readonly string[]) => Promise<unknown>) | undefined;
  selected: boolean;
  previewed: boolean;
  mutable: boolean;
  measure: (element: HTMLElement | null) => void;
  onToggle: (id: string) => void;
  onCheckPointerDown: CheckPointerDown;
  onRowPointerDown: CheckPointerDown;
  onCheckClickCapture: (event: ReactMouseEvent) => void;
  selectingRange: () => boolean;
  onOpen: ReturnType<typeof useShell>["openPaper"];
  onPreview: (id: string) => void;
  onPeek: (id: string) => void;
  onFile: (id: string, file: File) => void;
  onRowAction: (id: string, title: string, kind: RowAction) => void;
  /** The folder being shown, when there is one: rows can leave it. */
  rowFolder: string | null;
  onRowMenu: RowMenu | undefined;
  onMove: (index: number) => void;
  onDragRow: (id: string, data: DataTransfer, title: string) => boolean;
}) {
  const id = item.literature.literature_id,
    title = paperTitle(item),
    table = display === "table";
  // Only discovered: said at the end of the citation, the batch that found
  // it one press away, and “加入文献库” among the row's own actions, in the same
  // place; once pressed, “已加入” there (page specs “搜索结果”).
  const discovered = item.collected === false;
  const origin = discovered ? (item.discovery_origin ?? null) : null;
  const collectControl =
    discovered && onCollect ? (
      <Button
        variant="text"
        size="compact"
        className="paper-collect"
        icon={<Icon name="plus" />}
        onPress={async () => {
          await onCollect([id]);
        }}
      >
        加入文献库
      </Button>
    ) : collectedNow && !discovered ? (
      <small className="paper-collected">已加入</small>
    ) : null;
  const check = (
    <span
      className="paper-check"
      onPointerDownCapture={(event) => onCheckPointerDown(row.index, event)}
      onClickCapture={onCheckClickCapture}
      {...(table ? { role: "cell" } : {})}
    >
      <Checkbox
        aria-label={`选择 ${title}`}
        isSelected={selected}
        onChange={() => onToggle(id)}
      />
    </span>
  );
  const tools = (
    <span className="paper-tools" {...(table ? { role: "cell" } : {})}>
      {collectControl}
      <IconButton
        className="paper-preview"
        size="compact"
        variant="text"
        aria-label="预览"
        icon={<Icon name="eye" />}
        onPress={() => onPeek(id)}
      />
      {mutable ? (
        <Menu
          label="文献操作"
          iconOnly
          items={rowMenuItems(
            item,
            (kind) => onRowAction(id, title, kind),
            rowFolder,
          )}
        />
      ) : null}
    </span>
  );
  const open = (children: ReactNode) => (
    <button
      className="paper-open"
      // One press chooses the row, here as anywhere on it; two open the paper.
      onClick={() => onPreview(id)}
    >
      {children}
    </button>
  );
  const shared = {
    ref: measure,
    "data-literature-id": id,
    "data-index": row.index,
    "data-selected": selected || undefined,
    "data-previewed": previewed || undefined,
    "data-display": display,
    "data-section-start": head ? "" : undefined,
    className: "paper-row",
    style: { transform: `translateY(${row.start - offset}px)` },
    tabIndex: 0,
    "aria-label": title,
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === " ") {
        event.preventDefault();
        onToggle(id);
      } else if (event.key === "Enter") onOpen(id, undefined, undefined, title);
      else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        onMove(row.index + (event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Delete" && onRowMenu) {
        event.preventDefault();
        onRowAction(id, title, "delete-key");
      } else if (
        onRowMenu &&
        (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
      ) {
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        onRowMenu(id, box.left + 8, box.bottom + 4, true);
      }
    },
    // Right-click opens the row's menu; Shift keeps the browser's own.
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      if (!onRowMenu || event.shiftKey) return;
      event.preventDefault();
      onRowMenu(id, event.clientX, event.clientY, false);
    },
    // Selected rows are picked up and dragged to a folder; a press on any
    // other row that moves draws a marquee instead.
    draggable: mutable && selected,
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) =>
      onRowPointerDown(row.index, event),
    onClickCapture: onCheckClickCapture,
    // One press on the row makes it the current one; a double press opens
    // the paper. The same on every screen (page specs “当前行”).
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (
        (event.target as Element).closest?.(
          "button, a, input, label, .paper-check, .paper-tools, .paper-section-head",
        )
      )
        return;
      onPreview(id);
    },
    onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (
        (event.target as Element).closest?.(
          "button:not(.paper-open), a, input, label, .paper-check, .paper-tools, .paper-section-head",
        )
      )
        return;
      onOpen(id, undefined, undefined, title);
    },
    onDragStart: (event: ReactDragEvent<HTMLElement>) => {
      // A press on the checkbox column selects a run; it never drags the
      // row. Anywhere else, the title included, picks the row up.
      if (
        selectingRange() ||
        (event.target as Element).closest?.(".paper-check, .paper-tools")
      )
        event.preventDefault();
      else if (!onDragRow(id, event.dataTransfer, title))
        event.preventDefault();
    },
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      // Only a dropped file belongs to the row; folder drags go to the sidebar.
      if (mutable && event.dataTransfer.types.includes("Files"))
        event.preventDefault();
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      const file = event.dataTransfer.files[0];
      if (mutable && file) onFile(id, file);
    },
  };
  if (table) {
    const m = item.literature.metadata;
    return (
      <div {...shared} role="row" aria-rowindex={row.index + 2}>
        {head ? <div className="paper-section-head">{head}</div> : null}
        {check}
        <span role="cell" className="library-table-cell">
          {open(
            <span className="paper-title">
              <RichTitle parts={paperTitleParts(item)} />
            </span>,
          )}
        </span>
        <span role="cell" className="library-table-cell paper-author">
          {paperFirstAuthor(item)}
        </span>
        <span role="cell" className="library-table-cell paper-venue">
          <Venue name={m.venue} />
        </span>
        <span role="cell" className="library-table-cell library-table-year">
          {m.publication_year ?? "—"}
        </span>
        <span role="cell" className="library-table-cell">
          {quietState(item) ? null : <MaterialBadge item={item} />}
        </span>
        {tools}
      </div>
    );
  }
  const paperTitleText = (
    <span className="paper-title">
      <RichTitle parts={paperTitleParts(item)} />
    </span>
  );
  const citation = (
    <span className="paper-citation">
      {rowAuthors(item)} · <Venue name={item.literature.metadata.venue} /> ·{" "}
      {item.literature.metadata.publication_year ?? "年份未提供"}
      {/* Literature materials 8.4: its bibliography still lacks parts. */}
      {item.needs_metadata ? (
        <span className="paper-needs-metadata"> · 书目不全</span>
      ) : null}
      {origin ? (
        <span className="paper-discovered">
          {" · "}
          <button
            type="button"
            className="paper-origin"
            onClick={() => openBatch(origin.intake_batch_id)}
          >
            {underCandidates ? "" : "候选："}
            {ORIGIN_LABELS[origin.kind]}
          </button>
        </span>
      ) : discovered && !underCandidates ? (
        // Without a discovery batch the history is not guessed.
        <span className="paper-discovered"> · 候选</span>
      ) : null}
    </span>
  );
  return (
    <article {...shared} data-unranked-start={unrankedStart || undefined}>
      {head ? <div className="paper-section-head">{head}</div> : null}
      {unrankedStart ? (
        <p className="paper-unranked">以下未按相关度排序</p>
      ) : null}
      {check}
      {/* The title is the row's name and its keyboard target. */}
      <div className="paper-main">
        {open(paperTitleText)}
        {citation}
      </div>
      {/* One column on the right: the status, then the row's actions,
          side by side (page specs “搜索结果”). */}
      <span className="paper-side">
        {quietState(item) ? null : (
          <span className="paper-status-cell">
            <MaterialBadge item={item}>
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
                  onPress={() =>
                    navigate({ view: "archive", literature: null })
                  }
                >
                  查看问题
                </Button>
              ) : null}
            </MaterialBadge>
            {/* Page specs “文献库”: under the status, in small text — a long
            document, or a primary PDF whose default text is a draft. */}
            {item.literature.status === "READY" && item.long_document ? (
              <small
                className="paper-status-note"
                title="按简化流程解析全文，未逐页校对；以 PDF 为准"
              >
                长文档
              </small>
            ) : null}
            {item.text_level === "draft" ? (
              <small
                className="paper-status-note"
                title="全文未校对，文字可能含解析错误；以 PDF 为准"
              >
                {draftNote(item, sort)}
              </small>
            ) : null}
          </span>
        )}
        {tools}
      </span>
    </article>
  );
});

/**
 * The last group of every library menu (page specs “整体信息架构”): running an
 * operator and fixing a snapshot are processing, after the main-line actions.
 */
const processingHeading: MenuOption = {
  id: "processing",
  label: "加工",
  heading: true,
  onAction: () => {},
};

/** A yes/no filter that may be left open: 不限, 有, 没有. */
const FLAG_OPTIONS = [
  { value: "", label: "不限" },
  { value: "yes", label: "有" },
  { value: "no", label: "没有" },
];
const flag = (value: boolean | null | undefined) =>
  value === true ? "yes" : value === false ? "no" : "";
/**
 * The conditions panel (page specs “文献库”): author, journal, years and tag
 * on the first row, the rest under “更多条件”; saving and exporting filters in
 * the menu at its top right.
 */
function Filters({
  query,
  menu,
  onApply,
}: {
  query: LibraryQuery;
  menu: ReactNode;
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
    [needsMetadata, setNeedsMetadata] = useState(query.needs_metadata === true),
    [tagMode, setTagMode] = useState(query.tags?.mode ?? "any"),
    [error, setError] = useState("");
  // Opened already when one of its conditions is in force.
  const [more, setMore] = useState(
    () =>
      query.keywords.length > 0 ||
      query.identifiers.length > 0 ||
      query.publication_forms.length > 0 ||
      query.article_kinds.length > 0 ||
      query.tags?.mode === "primary" ||
      (query.text_levels?.length ?? 0) > 0 ||
      typeof query.has_draft_differences === "boolean" ||
      typeof query.has_image_only_pages === "boolean" ||
      query.needs_metadata === true,
  );
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
  /** What the fields say, as a query; a field passed here wins over its state. */
  type Fields = {
    form: string;
    kind: string;
    tag: string;
    tagMode: "any" | "primary";
    level: string;
    differs: string;
    scanned: string;
    needsMetadata: boolean;
  };
  const queryText = JSON.stringify(query);
  // A condition changed from outside the panel (a chip removed, a saved
  // filter opened) shows in its field; fields the change did not touch keep
  // what is being typed in them.
  const shown = useRef(query);
  useEffect(() => {
    const before = shown.current;
    shown.current = query;
    if (before === query) return;
    const sync = <T,>(
      read: (query: LibraryQuery) => T,
      write: (value: T) => void,
    ) => {
      const value = read(query);
      if (JSON.stringify(read(before)) !== JSON.stringify(value)) write(value);
    };
    sync((q) => String(q.publication_year_from ?? ""), setFrom);
    sync((q) => String(q.publication_year_to ?? ""), setTo);
    sync((q) => q.author ?? "", setAuthor);
    sync((q) => q.venue ?? "", setVenue);
    sync((q) => q.keywords[0] ?? "", setKeyword);
    sync(
      (q) => q.identifiers.find((id) => id.namespace === "doi")?.value ?? "",
      setDoi,
    );
    sync((q) => q.publication_forms[0] ?? "", setForm);
    sync((q) => q.article_kinds[0] ?? "", setKind);
    sync((q) => q.tags?.ids[0] ?? "", setTag);
    sync((q) => q.tags?.mode ?? "any", setTagMode);
    sync<TextLevel | "">(
      (q) => (q.text_levels?.length === 1 ? q.text_levels[0]! : ""),
      setLevel,
    );
    sync((q) => flag(q.has_draft_differences), setDiffers);
    sync((q) => flag(q.has_image_only_pages), setScanned);
    sync((q) => q.needs_metadata === true, setNeedsMetadata);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the query's text is the dependency
  }, [queryText]);
  /**
   * Page specs “条件”: a change takes effect at once, there is no button. A
   * choice applies when it is made; words apply on Enter or on leaving the
   * field.
   */
  const apply = (changed: Partial<Fields> = {}) => {
    const now: Fields = {
      form,
      kind,
      tag,
      tagMode,
      level,
      differs,
      scanned,
      needsMetadata,
      ...changed,
    };
    try {
      // Present only when chosen: the field is a filter, never “false”.
      const { needs_metadata: _drop, ...rest } = query;
      void _drop;
      const next = parseLibrarySearchRequest({
        query: {
          ...rest,
          ...(now.needsMetadata ? { needs_metadata: true } : {}),
          publication_year_from: from ? Number(from) : null,
          publication_year_to: to ? Number(to) : null,
          publication_forms: now.form ? [now.form] : [],
          article_kinds: now.kind ? [now.kind] : [],
          tags: { ids: now.tag ? [now.tag] : [], mode: now.tagMode },
          author: author || null,
          venue: venue || null,
          keywords: keyword ? [keyword] : [],
          identifiers: doi ? [{ namespace: "doi", value: doi }] : [],
          text_levels: now.level ? [now.level] : [],
          has_draft_differences: now.differs ? now.differs === "yes" : null,
          has_image_only_pages: now.scanned ? now.scanned === "yes" : null,
        },
      }).query;
      setError("");
      if (JSON.stringify(next) !== queryText) onApply(next);
    } catch (error) {
      setError(errorMessage(error));
    }
  };
  const words = (target: EventTarget) =>
    target instanceof HTMLInputElement && target.type !== "checkbox";
  return (
    <form
      className="library-filters"
      aria-label="筛选条件"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || !words(event.target)) return;
        event.preventDefault();
        apply();
      }}
      onBlur={(event) => {
        if (words(event.target)) apply();
      }}
    >
      <div className="library-filters-top">
        <div className="library-filter-grid">
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
          <Select
            label="标签（包含下级）"
            value={tag}
            onChange={(value) => {
              setTag(value);
              apply({ tag: value });
            }}
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
        </div>
        <div className="library-filters-menu">{menu}</div>
      </div>
      {more ? (
        <div className="library-filter-grid" aria-label="更多条件">
          <TextField
            label="关键词"
            value={keyword}
            onChange={setKeyword}
            placeholder="文献关键词"
          />
          <TextField
            label="DOI"
            value={doi}
            onChange={setDoi}
            placeholder="10.…"
          />
          <Select
            label="出版形式"
            value={form}
            onChange={(value) => {
              setForm(value);
              apply({ form: value });
            }}
            options={[
              { value: "", label: "全部" },
              ...Object.entries(PUBLICATION_FORM_LABELS).map(
                ([value, label]) => ({ value, label }),
              ),
            ]}
          />
          <Select
            label="文章性质"
            value={kind}
            onChange={(value) => {
              setKind(value);
              apply({ kind: value });
            }}
            options={[
              { value: "", label: "全部" },
              ...Object.entries(ARTICLE_KIND_LABELS).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
          />
          <Select
            label="标签范围"
            value={tagMode}
            onChange={(v) => {
              const value = v as "any" | "primary";
              setTagMode(value);
              apply({ tagMode: value });
            }}
            options={[
              { value: "any", label: "任一标签" },
              { value: "primary", label: "主标签" },
            ]}
          />
          {/* Page specs “文献库”: the primary PDF's default text. */}
          <Select
            label="文本等级"
            value={level}
            onChange={(v) => {
              const value = v as TextLevel | "";
              setLevel(value);
              apply({ level: value });
            }}
            options={[
              { value: "", label: "全部" },
              { value: "draft", label: TEXT_LEVEL_LABELS.draft },
              { value: "proofread", label: TEXT_LEVEL_LABELS.proofread },
            ]}
          />
          <Select
            label={DIFFERS_LABEL}
            value={differs}
            onChange={(value) => {
              setDiffers(value);
              apply({ differs: value });
            }}
            options={FLAG_OPTIONS}
          />
          <Select
            label="含扫描页"
            value={scanned}
            onChange={(value) => {
              setScanned(value);
              apply({ scanned: value });
            }}
            options={FLAG_OPTIONS}
          />
          <Checkbox
            label="书目不全"
            isSelected={needsMetadata}
            onChange={(value) => {
              setNeedsMetadata(value);
              apply({ needsMetadata: value });
            }}
          />
        </div>
      ) : null}
      {error && <p role="alert">{error}</p>}
      <div className="form-actions">
        <Button
          variant="text"
          size="compact"
          className="library-filters-more"
          aria-expanded={more}
          icon={<Icon name="chevron" />}
          onPress={() => setMore(!more)}
        >
          更多条件
        </Button>
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

/** The same words in the sort menu, the table heads and the list (page specs “超过一万篇”). */
const SORT_LIMIT_REASON = "超过 1 万篇时只能按这几种排序；先加条件，或缩小范围";
/** Where an only-discovered paper came from (page specs “搜索结果”). */
const ORIGIN_LABELS = {
  citation: "来自引用扩展",
  topic: "来自主题搜索",
} as const;
/** The working set a search began in. */
interface SearchOrigin {
  readonly scope: Partial<
    Pick<
      LibraryQuery,
      "folder" | "recently_opened" | "intake_batch_ids" | "collection_scope"
    >
  >;
  readonly name: string;
}
/** The candidates' page keeps its scope through every change of conditions. */
function candidatesScope(query: LibraryQuery): Partial<LibraryQuery> {
  return query.collection_scope === "candidates"
    ? { collection_scope: "candidates" }
    : {};
}
/** The page adds the collected scope itself; the address keeps without it. */
function withoutScopeFlag(
  query: LibraryQuery,
  original: LibraryQuery,
): LibraryQuery {
  if (original.collection_scope !== undefined) return query;
  const { collection_scope: _scope, ...rest } = query;
  void _scope;
  return rest;
}
/** The search's words and conditions in another scope. */
function inScope(
  query: LibraryQuery,
  scope: "all" | "collected" | SearchOrigin["scope"],
): LibraryQuery {
  const {
    collection_scope: _scope,
    folder: _folder,
    recently_opened: _recent,
    ...rest
  } = query;
  void _scope;
  void _folder;
  void _recent;
  const widened = { ...rest, intake_batch_ids: [] };
  if (scope === "all") return widened;
  if (scope === "collected")
    return { ...widened, collection_scope: "collected" };
  return { ...widened, ...scope };
}

/**
 * A count at the title (page specs “超过一万篇”): a count stopped at 10,000
 * reads “1 万篇以上” and offers “算出准确数”, worked out in the background
 * for exactly this query; another query starts over (the caller keys it).
 */
function CountFigure({
  query,
  value,
  truncated,
  incomplete = false,
  exact = true,
  prefix = "",
  suffix = "",
}: {
  query: LibraryQuery;
  value: number;
  truncated: boolean;
  /** Older raw hits are still unread: “至少 n 篇”. */
  incomplete?: boolean;
  /** Offers “算出准确数” for a count stopped at 10,000. */
  exact?: boolean;
  prefix?: string;
  suffix?: string;
}) {
  const api = useApi();
  const [state, setState] = useState<
    | { kind: "idle" | "running" }
    | { kind: "done"; total: number; at: string }
    | { kind: "failed"; reason: string }
  >({ kind: "idle" });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  if (state.kind === "done")
    return (
      <>
        {prefix}
        {libraryCount(state.total, false, "篇")}
        <span className="library-count-at">
          （截至{" "}
          {new Date(state.at).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          })}
          ）
        </span>
        {suffix}
      </>
    );
  const compute = async () => {
    const controller = new AbortController();
    abort.current = controller;
    setState({ kind: "running" });
    try {
      const exact = await exactSearchTotal(api, query, controller.signal);
      setState({ kind: "done", total: exact.total, at: exact.at });
    } catch (error) {
      if (controller.signal.aborted) return;
      setState({ kind: "failed", reason: errorMessage(error) });
    }
  };
  return (
    <>
      {prefix}
      {libraryCount(value, { truncated, incomplete }, "篇")}
      {suffix}
      {truncated && exact ? (
        state.kind === "running" ? (
          <span className="library-count-running" role="status">
            正在计算…
          </span>
        ) : (
          <>
            <Button size="compact" onPress={() => void compute()}>
              算出准确数
            </Button>
            {state.kind === "failed" ? (
              <span className="library-count-error" role="alert">
                {state.reason}
              </span>
            ) : null}
          </>
        )
      ) : null}
    </>
  );
}

/**
 * Where a search looks (page specs “搜索结果”): from the band the whole
 * library or only the collected papers; from a working set that set or the
 * whole library. Switching keeps the words and the conditions.
 */
function SearchScope({
  query,
  origin,
  relevanceLimit,
  scoredNote,
  windowPhrase,
  continueLabel,
  firstWindowLabel,
  onFirstWindow,
  onContinue,
  onChange,
}: {
  query: LibraryQuery;
  origin: SearchOrigin | null;
  relevanceLimit: number | null;
  /** Only part of a working set was ranked by relevance. */
  scoredNote: string | null;
  /** The scan window, when older hits are left or an earlier one is shown. */
  windowPhrase: string | null;
  /** “在更早的命中里继续找”, or by the set's own order for a member window. */
  continueLabel: string;
  firstWindowLabel: string;
  onFirstWindow: (() => void) | null;
  onContinue: (() => void) | null;
  onChange: (query: LibraryQuery) => void;
}) {
  const inView =
    !!query.folder ||
    !!query.recently_opened ||
    query.intake_batch_ids.length > 0 ||
    query.collection_scope === "candidates";
  const value = inView
    ? "view"
    : query.collection_scope === "collected"
      ? "collected"
      : "all";
  const note = relevanceLimit || windowPhrase || onFirstWindow || scoredNote;
  // The whole library needs no switch: its results list the library's own
  // hits and then the candidates. Nothing to say, nothing shown.
  if (!origin && value === "all" && !note) return null;
  return (
    <div className="library-search-scope">
      {origin ? (
        <RadioGroup
          label="范围"
          segmented
          value={value}
          onChange={(next) =>
            onChange(inScope(query, next === "view" ? origin.scope : "all"))
          }
        >
          <Radio value="view">「{origin.name}」里</Radio>
          <Radio value="all">全部文献</Radio>
        </RadioGroup>
      ) : value === "collected" ? (
        // Narrowed to the library from the results; taking it off lists the
        // candidates again.
        <FilterChip
          isSelected
          onChange={() => onChange(inScope(query, "all"))}
          onRemove={() => onChange(inScope(query, "all"))}
        >
          只看文献库里的
        </FilterChip>
      ) : (
        <span />
      )}
      {relevanceLimit || windowPhrase || onFirstWindow || scoredNote ? (
        <span className="library-relevance-limit">
          {windowPhrase ? `在${windowPhrase}里` : ""}
          {/* One sentence when both hold: the window, then the ranking. */}
          {scoredNote
            ? `${windowPhrase ? "，" : ""}${scoredNote}`
            : relevanceLimit
              ? `按相关度显示前 ${relevanceLimit.toLocaleString()} 条`
              : windowPhrase
                ? "查找"
                : ""}
          {onFirstWindow ? (
            <Button variant="text" size="compact" onPress={onFirstWindow}>
              {firstWindowLabel}
            </Button>
          ) : null}
          {onContinue ? (
            <Button variant="text" size="compact" onPress={onContinue}>
              {continueLabel}
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** The service no longer knows a window's cursor (technical 06 2.4). */
function isWindowInvalid(error: unknown): boolean {
  return error instanceof ApiError && error.code === "query-reference-invalid";
}
