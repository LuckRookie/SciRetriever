import {
  Component,
  Fragment,
  Suspense,
  createElement,
  lazy,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LibraryCounts } from "@sciretriever/contracts";
import {
  Button,
  Drawer,
  Icon as ComponentIcon,
  ErrorNotice,
  EmptyState,
  IconButton,
  Menu,
  Select,
  SplitPane,
  ToastProvider,
  useToast,
} from "../components/index.js";
import { MotionProvider } from "../motion/index.js";
import { ApiClient, type EntryKind } from "../data/api.js";
import {
  ApiContext,
  subscribeInvalidation,
  invalidateMaterials,
} from "../data/query.js";
import {
  useUrlState,
  navigate,
  navigationAllowed,
  sourceParameterKeys,
  type ReaderMode,
  type Section,
} from "../data/url.js";
import {
  preferences,
  readThemeChoice,
  bindTheme,
  themeOptions,
  THEME_KEY,
  THEME_TIME_KEYS,
  type Theme,
  type ThemeChoice,
} from "../data/preferences.js";
import {
  emptyQuery,
  readLibraryCounts,
  readLiterature,
  paperTitle,
} from "../data/library.js";
import { recordReadingOpen } from "../data/folders.js";
import { runningTaskCount, taskCountText } from "../data/tasks.js";
import {
  IntakeBatches,
  LibraryFolders,
  withoutScope,
} from "../features/library/Folders.js";
import { taskTabs } from "../features/tasks/TaskPage.js";
import { archiveQuery } from "../data/archive.js";
import { record } from "../data/wire.js";
import { createReadingState, closeReadingState } from "../../reading/state.js";
import { READER_PAINTED, ShellContext } from "./context.js";
import { topBarLayout } from "../features/reader/geometry.js";
import { Icon } from "./icon.js";
import { CommandPalette } from "./CommandPalette.js";
import {
  currentAfterClose,
  cycleTab,
  keepUnsaved,
  loadTabs,
  recordClose,
  reopenTabs,
  saveTabs,
  tabsToClose,
  unsavedPapers,
  usedOrder,
  type CloseKind,
  type ClosedTabs,
  type PaperTab,
} from "./paper-tabs.js";
import {
  ContextMenu,
  type ContextMenuRequest,
} from "../features/reader/input/ContextMenu.js";
import {
  commandItem,
  type ReaderCommand,
} from "../features/reader/input/commands.js";
import { sectionLabels, errorMessage } from "../strings.js";
import { warmInterfaceFonts } from "../styles/warm-fonts.js";

const PROCESSING_KEY = "sciretriever:navigation:processing:v1";
const processingLabel = "加工";

/**
 * Route chunks load on first visit; once the shell is idle the rest are fetched
 * too. A page whose code is already here renders directly: going through
 * `lazy` would still suspend once, and React holds a revealed boundary back for
 * about 300 ms, which was most of a first section switch.
 */
const warm: (() => Promise<unknown>)[] = [];
function page<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
) {
  let loaded: ComponentType<P> | undefined;
  const fetch = () =>
    load().then((module) => {
      loaded = module.default;
      return module;
    });
  warm.push(fetch);
  const Lazy = lazy(fetch);
  return function Page(props: P) {
    // One instance keeps the component it mounted with, so warming never remounts it.
    const [View] = useState<ComponentType<P>>(() => loaded ?? Lazy);
    return createElement(View, props);
  };
}
function warmPages(): () => void {
  let stopped = false,
    handle = 0;
  const run = async () => {
    warmInterfaceFonts();
    for (const load of warm) {
      if (stopped) return;
      await load().catch(() => undefined);
    }
  };
  const schedule = () => {
    if (stopped) return;
    handle =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback(() => void run(), { timeout: 4000 })
        : window.setTimeout(() => void run(), 1500);
  };
  // Opened on a paper: compiling other pages in the reader's network gaps
  // delayed its first screen; warm them once it is drawn, or after 6 s.
  const reading = new URLSearchParams(location.search).has("literature");
  let wait = 0;
  if (reading) {
    const go = () => {
      window.clearTimeout(wait);
      window.removeEventListener(READER_PAINTED, go);
      schedule();
    };
    window.addEventListener(READER_PAINTED, go);
    wait = window.setTimeout(go, 6000);
  } else schedule();
  return () => {
    stopped = true;
    window.clearTimeout(wait);
    if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle);
    else window.clearTimeout(handle);
  };
}

const Tags = page(() => import("../features/tags/Tags.js"));
const Snapshots = page(() => import("../features/archive/Snapshots.js"));
const Archive = page(() => import("../features/archive/Archive.js"));
const Library = page(() => import("../features/library/Library.js"));
const Reader = page(() => import("../features/reader/Reader.js"));
const Lab = lazy(() => import("../features/lab/Lab.js"));
const Gallery = lazy(() => import("../features/lab/Gallery.js"));
const Tasks = page(() => import("../features/tasks/Tasks.js"));
const ActivityList = lazy(() =>
  import("../features/tasks/Tasks.js").then((module) => ({
    default: module.ActivityList,
  })),
);
const Agents = page(() => import("../features/agents/Agents.js"));
const SourceStatistics = page(
  () => import("../features/tasks/SourceStatistics.js"),
);
const Browser = page(() => import("../features/browser/Browser.js"));
const Retrieval = page(() => import("../features/retrieval/Retrieval.js"));
const Insights = page(() => import("../features/insights/Insights.js"));
const Settings = page(() => import("../features/settings/Settings.js"));
const Processing = page(() => import("../features/processing/Processing.js"));
const Synthesis = page(() => import("../features/synthesis/Synthesis.js"));
const Intake = page(() => import("../features/intake/Intake.js"));
const Maintenance = page(
  () => import("../features/maintenance/Maintenance.js"),
);

class PageBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { error: string | null }
> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: errorMessage(error) };
  }
  override componentDidCatch() {
    console.warn("The active workspace view failed to render.");
  }
  override componentDidUpdate(
    previous: Readonly<{ children: ReactNode; resetKey: string }>,
  ) {
    if (previous.resetKey !== this.props.resetKey && this.state.error)
      this.setState({ error: null });
  }
  override render() {
    return this.state.error ? (
      <div className="page-recovery">
        <ErrorNotice
          message={`当前页面未能显示。已保存的材料不受影响。${this.state.error}`}
          onRetry={() => this.setState({ error: null })}
        />
        <Button
          onPress={() =>
            navigate({ view: "lib", literature: null }, { clearSource: true })
          }
        >
          返回文献库
        </Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
export function Application() {
  const [api] = useState(
    () =>
      new ApiClient(
        (document.documentElement.dataset.entry ?? "workspace") as EntryKind,
      ),
  );
  const queries = useQueryClient();
  const connection = useQuery({
    queryKey: ["workspace", "connection", api.kind],
    queryFn: ({ signal }) => api.connect(signal),
    staleTime: Infinity,
    retry: false,
  });
  useEffect(() => {
    const unsubscribe = subscribeInvalidation(api, queries);
    return () => {
      unsubscribe();
      api.close();
    };
  }, [api, queries]);
  useEffect(
    () => (connection.isSuccess ? warmPages() : undefined),
    [connection.isSuccess],
  );
  return (
    <PageBoundary resetKey="application">
      <ApiContext.Provider value={api}>
        <MotionProvider
          preference={
            preferences.read("sciretriever:motion:v1") === "reduced"
              ? "reduced"
              : preferences.read("sciretriever:motion:v1") === "full"
                ? "full"
                : "system"
          }
        >
          <ToastProvider>
            {connection.isPending ? (
              <div className="application-loading" role="status">
                正在连接文献库…
              </div>
            ) : connection.isError ? (
              <div className="page-recovery">
                <ErrorNotice
                  message={errorMessage(connection.error)}
                  onRetry={() => void connection.refetch()}
                />
              </div>
            ) : (
              <Workspace api={api} />
            )}
          </ToastProvider>
        </MotionProvider>
      </ApiContext.Provider>
    </PageBoundary>
  );
}
function Workspace({ api }: { api: ApiClient }) {
  const notify = useToast();
  const route = useUrlState(),
    [themes, setThemes] = useState<ThemeChoice>(readThemeChoice),
    [selected, setSelected] = useState<ReadonlySet<string>>(new Set()),
    [reading] = useState(createReadingState),
    // Spec 1.8.3: after a reload the open tabs come back from session storage.
    [tabs, setTabs] = useState<PaperTab[]>(loadTabs),
    [closed, setClosed] = useState<ClosedTabs[]>([]),
    [tabMenu, setTabMenu] = useState<ContextMenuRequest | null>(null),
    [mobileNav, setMobileNav] = useState(false),
    [activity, setActivity] = useState(false),
    // The folding “加工” group, closed unless the person opened it.
    [processingOpen, setProcessingOpen] = useState(
      () => preferences.read(PROCESSING_KEY) === "open",
    ),
    [search, setSearch] = useState(false),
    // Spec 1.3: the reader page's top bar, its slot for the reader's controls and its width.
    [readerNav, setReaderNav] = useState(false),
    [readerBar, setReaderBar] = useState<HTMLElement | null>(null),
    [readerBarWidth, setReaderBarWidth] = useState(0),
    [readerFocus, setReaderFocus] = useState(false),
    // In focus mode, the top bar shown over the desk for a while (spec 1.7).
    [peek, setPeek] = useState(false),
    topBar = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(() => {
    const value = preferences.read("sciretriever:panel:navigation:v1");
    return value && /^\d+px$/.test(value)
      ? Math.max(200, Math.min(420, Number.parseInt(value)))
      : 244;
  });
  useEffect(() => bindTheme(themes), [themes]);
  const setTheme = (theme: Theme) => {
    setThemes((current) => ({ ...current, theme }));
    preferences.write(THEME_KEY, theme);
  };
  // Pages share one scroll container; each route starts at the top and the
  // library restores its own remembered position afterwards.
  const content = useRef<HTMLElement>(null),
    mounted = useRef(false);
  useLayoutEffect(() => {
    // A new page starts at its top; the first one already does, and scrolling
    // it would force a layout before the first paint.
    if (mounted.current) content.current?.scrollTo({ top: 0 });
    mounted.current = true;
  }, [route.section, route.literature]);
  const activePaper = useQuery({
    queryKey: ["literature", route.literature],
    queryFn: ({ signal }) => readLiterature(api, route.literature!, signal),
    enabled: !!route.literature && route.section !== "web",
  });
  useEffect(() => {
    if (!route.literature || route.section === "web") return;
    setTabs((current) => {
      const old = current.find((tab) => tab.id === route.literature);
      const tab = {
        id: route.literature!,
        title: activePaper.data
          ? paperTitle(activePaper.data)
          : (old?.title ?? "文献"),
        mode: route.readerChosen ? route.reader : old?.mode,
        source: Object.fromEntries(
          sourceParameterKeys.flatMap((key) =>
            route.parameters.has(key)
              ? [[key, route.parameters.get(key)!]]
              : [],
          ),
        ),
      };
      return old
        ? current.map((item) => (item.id === tab.id ? tab : item))
        : [...current, tab];
    });
  }, [route, activePaper.data]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearch(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  // Shares the folder tree's counts query instead of running a library search.
  const count = useQuery({
    queryKey: ["library", "counts", emptyQuery()],
    queryFn: ({ signal }) => readLibraryCounts(api, emptyQuery(), signal),
    enabled: api.workspace.readiness === "ready",
  });
  const tasks = useQuery({
    queryKey: ["tasks", "activity"],
    queryFn: ({ signal }) =>
      api.read("/api/tasks?limit=100&status_group=active", signal),
    enabled: api.kind === "workspace",
    refetchInterval: 5000,
  });
  // “n 进行中” and “活动 · n”; the activity list still shows queued tasks.
  const running = runningTaskCount(tasks.data);
  // “m 需处理” beside 任务: the archive issues' total, under the archive query
  // prefix so resolving an issue refreshes it.
  const issues = useQuery({
    queryKey: ["archive", "issues", "count"],
    queryFn: async ({ signal }) =>
      Number(
        record(
          await archiveQuery(
            api,
            "archive",
            { operation: "issues", request: { offset: 0, limit: 1 } },
            signal,
          ),
          "archive issues",
        ).total_count ?? 0,
      ),
    enabled: api.kind === "workspace" && api.workspace.readiness === "ready",
    staleTime: 30000,
  });
  const lastTasks = useRef<string | null>(null);
  const taskQueries = useQueryClient();
  useEffect(() => {
    if (!tasks.data) return;
    const current = JSON.stringify(tasks.data.tasks);
    if (lastTasks.current !== null && lastTasks.current !== current)
      invalidateMaterials(taskQueries);
    lastTasks.current = current;
  }, [tasks.data, taskQueries]);
  /** Without a view the reader picks one: the remembered view, else what the paper has (spec 6.4). */
  const showPaper = (
    id: string,
    mode?: ReaderMode,
    source: Record<string, string> = {},
    title?: string,
  ) => {
    setTabs((current) => {
      const old = current.find((tab) => tab.id === id);
      const tab = { id, mode, source, title: title ?? old?.title ?? "文献" };
      return old
        ? current.map((item) => (item.id === id ? tab : item))
        : [...current, tab];
    });
    navigate(
      { literature: id, reader: mode ?? null, ...source },
      { clearSource: true },
    );
  };
  /** Intentional opens are recorded for "recently read"; tab switches are not. */
  const openPaper: typeof showPaper = (...args) => {
    showPaper(...args);
    if (api.kind !== "workspace") return;
    recordReadingOpen(api, args[0])
      .then((opened) => {
        // Counting the whole library is expensive and shares the reader's
        // database worker, so a first open only bumps the sidebar count and
        // every library query refreshes at its next natural read.
        if (opened.open_count === 1)
          taskQueries.setQueryData<LibraryCounts>(
            ["library", "counts", emptyQuery()],
            (counts) =>
              counts && {
                ...counts,
                recently_opened: Math.min(100, counts.recently_opened + 1),
              },
          );
        void taskQueries.invalidateQueries({
          queryKey: ["library"],
          refetchType: "none",
        });
      })
      .catch(() => undefined);
  };
  const go = (section: Section) => {
    navigate(
      { view: section, literature: null, results: null },
      { clearSource: true },
    );
    setMobileNav(false);
  };
  // The library entry leaves a folder or "recently read" scope, keeping filters.
  const openLibrary = () => {
    navigate(
      {
        view: "lib",
        literature: null,
        query: JSON.stringify(withoutScope(route.query)),
        ...(route.query.recently_opened && route.sort === "opened-desc"
          ? { sort: "intake-desc" }
          : {}),
      },
      { clearSource: true },
    );
    setMobileNav(false);
  };
  const available = (section: Section) =>
    api.kind === "workspace" ||
    ["lib", "ins", "ask", "syn", "ext"].includes(section);
  const mainSections = (["lib", "disc", "ask", "task"] as const).filter(
      available,
    ),
    processingSections = (["ext", "snapshots", "tags", "ins"] as const).filter(
      available,
    );
  const inProcessing =
    !route.literature &&
    (processingSections as readonly Section[]).includes(route.section);
  // “加工” stays as the person left it; a page inside it opens it.
  useEffect(() => {
    if (inProcessing) setProcessingOpen(true);
  }, [inProcessing]);
  const toggleProcessing = (open: boolean) => {
    setProcessingOpen(open);
    preferences.write(PROCESSING_KEY, open ? "open" : "closed");
  };
  /** “n 进行中 · m 需处理”, leaving out a zero; nothing when both are. */
  const taskCount = taskCountText(running, issues.data ?? 0);
  const isCurrent = (section: Section) =>
    section === "task"
      ? // Its five tabs; the browser tab names the paper it watches.
        taskTabs.includes(route.section) &&
        (!route.literature || route.section === "web")
      : route.section === section &&
        !route.literature &&
        // A folder, “recently read” or a batch is marked in its own entry.
        !(
          section === "lib" &&
          (route.query.folder ||
            route.query.recently_opened ||
            route.query.intake_batch_ids.length)
        );
  const sectionButton = (section: Section) => (
    <Button
      variant="text"
      aria-current={isCurrent(section) ? "page" : false}
      icon={<Icon name={section} />}
      onPress={() => (section === "lib" ? openLibrary() : go(section))}
    >
      {sectionLabels[section]}
      {section === "lib" && (
        <span className="navigation-count">
          {count.isPending ? "…" : (count.data?.total.toLocaleString() ?? "")}
        </span>
      )}
      {section === "task" && taskCount ? (
        <span className="navigation-count">{taskCount}</span>
      ) : null}
    </Button>
  );
  const navigation = (
    <>
      <div className="brand">
        <span className="brand-mark">S</span>
        <span>SciRetriever</span>
      </div>
      <div className="navigation-content">
        <Button
          variant="text"
          icon={<Icon name="search" />}
          onPress={() => setSearch(true)}
        >
          搜索 <kbd>⌘K</kbd>
        </Button>
        {/* One column on the main line, with “加工” as the one folding
            group (page specs “整体信息架构”). */}
        <div className="navigation-group">
          {mainSections.map((section) => (
            <Fragment key={section}>
              {sectionButton(section)}
              {section === "lib" && api.kind === "workspace" ? (
                <LibraryFolders onNavigate={() => setMobileNav(false)} />
              ) : null}
              {section === "disc" ? (
                <IntakeBatches onNavigate={() => setMobileNav(false)} />
              ) : null}
            </Fragment>
          ))}
          {processingSections.length ? (
            <div
              className="navigation-fold"
              role="group"
              aria-label={processingLabel}
            >
              <Button
                variant="text"
                className="navigation-fold-toggle"
                aria-expanded={processingOpen}
                data-open={processingOpen || undefined}
                icon={<ComponentIcon name="chevron" />}
                onPress={() => toggleProcessing(!processingOpen)}
              >
                {processingLabel}
              </Button>
              {processingOpen ? (
                <div className="navigation-fold-items">
                  {processingSections.map((section) => (
                    <Fragment key={section}>{sectionButton(section)}</Fragment>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {api.kind !== "query" ? (
        <div className="navigation-footer">
          <Button
            variant="text"
            icon={<Icon name="set" />}
            onPress={() => go("set")}
          >
            {api.kind === "maintenance" ? "高级维护" : "设置"}
          </Button>
        </div>
      ) : null}
    </>
  );
  const page =
    (api.kind !== "workspace" &&
      ["disc", "task", "web", "stats"].includes(route.section)) ||
    (api.kind === "query" && route.section === "set") ? (
      <EmptyState
        title="当前入口不提供这项操作"
        description="此入口用于查询已保存材料。发现、持久任务、浏览器操作和配置由完整工作台提供。"
        action={<Button onPress={() => go("lib")}>返回文献库</Button>}
      />
    ) : route.section === "agent" ? (
      <Agents />
    ) : route.section === "stats" ? (
      <SourceStatistics />
    ) : route.section === "web" ? (
      <Browser />
    ) : route.literature ? (
      <Reader />
    ) : route.section === "tags" ? (
      <Tags />
    ) : route.section === "snapshots" ? (
      <Snapshots />
    ) : route.section === "archive" ? (
      <Archive />
    ) : route.section === "lib" ? (
      <Library />
    ) : route.section === "lab" ? (
      <Lab />
    ) : route.section === "gallery" ? (
      <Gallery />
    ) : route.section === "task" ? (
      <Tasks />
    ) : route.section === "ask" ? (
      <Retrieval />
    ) : route.section === "set" ? (
      api.kind === "maintenance" ? (
        <Maintenance />
      ) : (
        <Settings />
      )
    ) : route.section === "ext" ? (
      <Processing />
    ) : route.section === "syn" ? (
      <Synthesis />
    ) : route.section === "disc" ? (
      <Intake />
    ) : (
      <Insights />
    );
  // Navigating closes the reader's navigation drawer.
  useEffect(() => {
    setReaderNav(false);
  }, [route.section, route.literature]);
  // The reader page shows no site sidebar: one top bar, and navigation in a drawer.
  const readerPage =
    !route.error &&
    !!route.literature &&
    !["agent", "stats", "web"].includes(route.section) &&
    !(
      (api.kind !== "workspace" &&
        ["disc", "task", "web", "stats"].includes(route.section)) ||
      (api.kind === "query" && route.section === "set")
    );
  // Leaving the reader page leaves focus mode.
  useEffect(() => {
    if (!readerPage) setReaderFocus(false);
  }, [readerPage]);
  /**
   * Spec 1.7: in focus mode the pointer resting within 8 px of the window's
   * top for 150 ms brings the top bar back over the desk; 400 ms after the
   * pointer leaves it, it folds up again.
   */
  useEffect(() => {
    if (!readerPage || !readerFocus) {
      setPeek(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined,
      shown = false;
    const set = (value: boolean, after: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        shown = value;
        setPeek(value);
      }, after);
    };
    const move = (event: PointerEvent) => {
      const bar = topBar.current?.getBoundingClientRect();
      const over = !!bar && shown && event.clientY <= bar.bottom;
      if (over) return clearTimeout(timer);
      if (event.clientY <= 8) {
        if (!shown) set(true, 150);
      } else if (shown) set(false, 400);
      else clearTimeout(timer);
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", move);
    };
  }, [readerPage, readerFocus]);
  useEffect(() => saveTabs(tabs), [tabs]);
  // The order tabs were used in, for the one that follows a close (spec 1.8.3).
  const used = useRef<string[]>([]);
  useEffect(() => {
    if (route.literature)
      used.current = usedOrder(used.current, route.literature);
  }, [route.literature]);
  const tabsNow = useRef(tabs);
  tabsNow.current = tabs;
  /** Shows `next`, or the page the reader was entered from when none is left. */
  const showAfterClose = (next: string | null, force = false) => {
    const tab = tabsNow.current.find((item) => item.id === next);
    if (tab) {
      navigate(
        { literature: tab.id, reader: tab.mode ?? null, ...tab.source },
        { clearSource: true, force },
      );
    } else
      navigate(
        { view: route.section, literature: null, results: null },
        { clearSource: true, force },
      );
  };
  /**
   * Spec 1.8.3: closing never asks; a batch leaves tabs with unsaved
   * proofread edits open and says so, and offers to undo; closing the
   * current tab shows the one last used. Every close is recorded.
   */
  const closeTabs = async (kind: CloseKind, on: string) => {
    const all = tabsNow.current;
    const { closing: ids, kept } = keepUnsaved(
      kind,
      tabsToClose(all, kind, on),
      unsavedPapers,
    );
    if (!ids.length) return;
    const closing = new Set(ids),
      current = route.literature ?? null;
    // A single unsaved tab asks the editor's own question first.
    let force = false;
    if (current && closing.has(current) && kind === "one") {
      if (!(await navigationAllowed())) return;
      force = true;
    }
    const next =
      kind === "others"
        ? on
        : currentAfterClose(all, used.current, closing, current);
    const record: ClosedTabs = {
      tabs: all.flatMap((tab, index) =>
        closing.has(tab.id) ? [{ tab, index }] : [],
      ),
      current,
    };
    setClosed((records) => recordClose(records, record));
    setTabs((items) => items.filter((item) => !closing.has(item.id)));
    used.current = used.current.filter((id) => !closing.has(id));
    for (const id of ids) closeReadingState(reading, id);
    if (current !== next || (current && closing.has(current)))
      showAfterClose(next, force);
    if (ids.length > 1 || kept.length)
      notify({
        message:
          `已关闭 ${ids.length} 篇文献` +
          (kept.length ? `；${kept.length} 篇有未保存的修改，未关闭` : ""),
        action: { label: "撤销", onPress: () => reopen(record) },
        replace: "reader-tabs-closed",
      });
  };
  /** Opens the tabs of the last close again, in their places (spec 1.8.3). */
  const reopen = (which?: ClosedTabs) => {
    const record = which ?? closed.at(-1);
    if (!record) return;
    setClosed((records) => records.filter((item) => item !== record));
    setTabs((items) => reopenTabs(items, record));
    const back =
      record.current && record.tabs.some(({ tab }) => tab.id === record.current)
        ? record.current
        : (record.tabs.at(-1)?.tab.id ?? null);
    const tab = record.tabs.find((item) => item.tab.id === back)?.tab;
    if (tab)
      navigate(
        { literature: tab.id, reader: tab.mode ?? null, ...tab.source },
        { clearSource: true },
      );
  };
  const cycle = (step: 1 | -1) => {
    const next = cycleTab(tabsNow.current, route.literature ?? null, step);
    const tab = tabs.find((item) => item.id === next);
    if (tab && tab.id !== route.literature)
      showPaper(tab.id, tab.mode, tab.source, tab.title);
  };
  /** The tab's own menu (spec 1.8.3), for the tab right-clicked. */
  const tabCommands = (on: string): ReaderCommand[] => {
    const at = tabs.findIndex((tab) => tab.id === on);
    return [
      { id: "tab-close", label: "关闭", run: () => void closeTabs("one", on) },
      {
        id: "tab-close-others",
        enabled: tabs.length > 1,
        run: () => void closeTabs("others", on),
      },
      {
        id: "tab-close-right",
        enabled: at >= 0 && at < tabs.length - 1,
        run: () => void closeTabs("right", on),
      },
      { id: "tab-close-all", run: () => void closeTabs("all", on) },
      { id: "tab-reopen", enabled: closed.length > 0, run: () => reopen() },
    ];
  };
  const openTabMenu = (on: string, x: number, y: number, keyboard: boolean) =>
    setTabMenu({
      x,
      y,
      keyboard,
      label: "标签页",
      items: tabCommands(on).map((command, index) =>
        commandItem(command, index === 4 ? { divider: true } : {}),
      ),
    });
  const paperTab = (tab: PaperTab) => (
    <div
      className="paper-tab"
      key={tab.id}
      title={tab.title}
      data-selected={route.literature === tab.id || undefined}
      data-paper-tab={tab.id}
      // Spec 1.8.3: the middle button closes a tab, with no autoscroll.
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        void closeTabs("one", tab.id);
      }}
      onContextMenu={(event) => {
        if (event.shiftKey) return;
        event.preventDefault();
        openTabMenu(tab.id, event.clientX, event.clientY, false);
      }}
    >
      <Button
        variant="text"
        aria-current={route.literature === tab.id ? "page" : false}
        icon={<Icon name="file" />}
        onPress={() => showPaper(tab.id, tab.mode, tab.source, tab.title)}
      >
        {tab.title}
      </Button>
      <IconButton
        size="inline"
        variant="text"
        aria-label={`关闭文献 ${tab.title}`}
        icon={<Icon name="close" />}
        onPress={() => void closeTabs("one", tab.id)}
      />
    </div>
  );
  const content_ = (
    <main className="workspace-content" ref={content}>
      <PageBoundary resetKey={`${route.section}:${route.literature ?? ""}`}>
        {/* The reader stays mounted across papers: it keeps the old
            picture until the new paper can show (spec 5.1). */}
        <Suspense
          key={route.literature ? "reader" : route.section}
          fallback={
            <div className="page-recovery" role="status">
              正在打开…
            </div>
          }
        >
          {route.error ? <ErrorNotice message={route.error} /> : page}
        </Suspense>
      </PageBoundary>
    </main>
  );
  // Below 1180 px only the current paper's tab shows, the others in a menu;
  // below 640 px no tab shows (spec 1.3).
  const current = tabs.find((tab) => tab.id === route.literature),
    others = tabs.filter((tab) => tab.id !== route.literature),
    barLayout = topBarLayout(readerBarWidth),
    allTabs = barLayout.tabs === "all",
    noTabs = barLayout.tabs === "none";
  useLayoutEffect(() => {
    const bar = topBar.current;
    if (!readerPage || !bar) return;
    const measure = () => setReaderBarWidth(bar.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [readerPage]);
  const readerTopBar = (
    <header
      className="workspace-header reader-topbar"
      ref={topBar}
      data-tabs={allTabs ? "all" : noTabs ? "none" : "current"}
    >
      <IconButton
        aria-label="打开导航"
        icon={<Icon name="menu" />}
        onPress={() => setReaderNav(true)}
      />
      {noTabs ? null : (
        <div
          className="workspace-tabs reader-topbar-tabs"
          role="navigation"
          aria-label="阅读标签"
        >
          {allTabs ? tabs.map(paperTab) : current ? paperTab(current) : null}
          {!allTabs && others.length ? (
            <Menu
              label={`另 ${others.length} 篇`}
              variant="text"
              className="reader-topbar-others"
              items={[
                ...others.map((tab) => ({
                  id: tab.id,
                  label: tab.title,
                  onAction: () =>
                    showPaper(tab.id, tab.mode, tab.source, tab.title),
                })),
                // Spec 1.3: the batch closes end the menu.
                ...(current
                  ? tabCommands(current.id)
                      .filter(
                        (command) =>
                          command.id === "tab-close-others" ||
                          command.id === "tab-close-all",
                      )
                      .map((command, index) =>
                        commandItem(command, {
                          id: `${command.id}-menu`,
                          divider: index === 0,
                        }),
                      )
                  : []),
              ]}
            />
          ) : null}
        </div>
      )}
      <div className="reader-topbar-tools" ref={setReaderBar} />
      <ContextMenu
        request={tabMenu}
        onClose={() => setTabMenu(null)}
        onRetarget={(event, element) => {
          const on =
            element?.closest<HTMLElement>("[data-paper-tab]")?.dataset.paperTab;
          if (on) openTabMenu(on, event.clientX, event.clientY, false);
          else setTabMenu(null);
        }}
      />
    </header>
  );
  return (
    <ShellContext.Provider
      value={{
        selected,
        setSelected,
        openPaper,
        notify,
        readerBar: readerPage ? readerBar : null,
        readerBarWidth: readerPage ? readerBarWidth : 0,
        readerFocus: readerPage && readerFocus,
        setReaderFocus,
        reading,
        tabs: {
          list: tabs,
          current: route.literature ?? null,
          close: (kind, on) =>
            void closeTabs(kind, on ?? route.literature ?? ""),
          reopen: () => reopen(),
          canReopen: closed.length > 0,
          cycle,
          openMenu: openTabMenu,
        },
        theme: themes.theme,
        setTheme,
        themes,
        setThemeTime: (time, value) => {
          setThemes((current) => ({ ...current, [time]: value }));
          preferences.write(THEME_TIME_KEYS[time], value);
        },
      }}
    >
      {readerPage ? (
        <div
          className="application-shell"
          data-reader-page=""
          data-focus={readerFocus || undefined}
          data-peek={(readerFocus && peek) || undefined}
        >
          <div className="workspace-main">
            {readerTopBar}
            {content_}
          </div>
        </div>
      ) : (
        <div className="application-shell">
          <SplitPane
            label="导航栏宽度"
            width={width}
            onWidthChange={(value) => {
              setWidth(value);
              preferences.write(
                "sciretriever:panel:navigation:v1",
                `${value}px`,
              );
            }}
            min={200}
            max={420}
            defaultWidth={244}
            side={
              <aside className="navigation" aria-label="主导航">
                {navigation}
              </aside>
            }
          >
            <div className="workspace-main">
              <header className="workspace-header">
                <span className="mobile-navigation-toggle">
                  <IconButton
                    aria-label="打开导航"
                    icon={<Icon name="menu" />}
                    onPress={() => setMobileNav(true)}
                  />
                </span>
                <div
                  className="workspace-tabs"
                  role="navigation"
                  aria-label="工作区与阅读标签"
                >
                  <Button
                    variant="text"
                    aria-current={!route.literature ? "page" : false}
                    icon={<Icon name={route.section} />}
                    onPress={() => go(route.section)}
                  >
                    {sectionLabels[route.section]}
                  </Button>
                  {tabs.map((tab) => (
                    <div
                      className="paper-tab"
                      key={tab.id}
                      title={tab.title}
                      data-selected={route.literature === tab.id || undefined}
                    >
                      <Button
                        variant="text"
                        aria-current={
                          route.literature === tab.id ? "page" : false
                        }
                        icon={<Icon name="file" />}
                        onPress={() =>
                          showPaper(tab.id, tab.mode, tab.source, tab.title)
                        }
                      >
                        {tab.title}
                      </Button>
                      <IconButton
                        size="inline"
                        variant="text"
                        aria-label={`关闭文献 ${tab.title}`}
                        icon={<Icon name="close" />}
                        onPress={() => {
                          setTabs((items) =>
                            items.filter((item) => item.id !== tab.id),
                          );
                          closeReadingState(reading, tab.id);
                          if (route.literature === tab.id) go(route.section);
                        }}
                      />
                    </div>
                  ))}
                </div>
                {api.kind === "workspace" && (
                  <Button
                    variant="text"
                    icon={<Icon name="activity" />}
                    onPress={() => setActivity(true)}
                  >
                    {running > 0 ? `活动 · ${running}` : "活动"}
                  </Button>
                )}
              </header>
              {content_}
            </div>
          </SplitPane>
        </div>
      )}
      <Drawer
        title="导航"
        side="start"
        className="reader-navigation"
        isOpen={readerPage && readerNav}
        onOpenChange={setReaderNav}
      >
        {navigation}
      </Drawer>
      <Drawer title="导航" isOpen={mobileNav} onOpenChange={setMobileNav}>
        {navigation}
      </Drawer>
      <Drawer title="活动" isOpen={activity} onOpenChange={setActivity}>
        <Suspense fallback={<p role="status">正在读取活动…</p>}>
          <ActivityList
            onSelect={(id) => {
              setActivity(false);
              navigate(
                { view: "task", literature: null, task: id },
                { clearSource: true },
              );
            }}
          />
        </Suspense>
        <Button
          onPress={() => {
            go("task");
            setActivity(false);
          }}
        >
          查看全部任务
        </Button>
      </Drawer>
      <CommandPalette isOpen={search} onOpenChange={setSearch} />
      {(route.section === "lab" || route.section === "gallery") && (
        <div className="review-theme">
          <Select
            label="主题"
            value={themes.theme}
            onChange={(value) => setTheme(value as Theme)}
            options={themeOptions}
          />
        </div>
      )}
    </ShellContext.Provider>
  );
}
