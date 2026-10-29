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
  ErrorNotice,
  EmptyState,
  IconButton,
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
  sourceParameterKeys,
  type ReaderMode,
  type Section,
} from "../data/url.js";
import {
  preferences,
  readTheme,
  bindTheme,
  type Theme,
} from "../data/preferences.js";
import {
  emptyQuery,
  readLibraryCounts,
  readLiterature,
  paperTitle,
} from "../data/library.js";
import { recordReadingOpen } from "../data/folders.js";
import { LibraryFolders, withoutScope } from "../features/library/Folders.js";
import { createReadingState, closeReadingState } from "../../reading/state.js";
import { ShellContext } from "./context.js";
import { Icon } from "./icon.js";
import { CommandPalette } from "./CommandPalette.js";
import { sectionLabels, errorMessage } from "../strings.js";
import { warmInterfaceFonts } from "../styles/warm-fonts.js";

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
  let stopped = false;
  const run = async () => {
    warmInterfaceFonts();
    for (const load of warm) {
      if (stopped) return;
      await load().catch(() => undefined);
    }
  };
  const handle =
    typeof requestIdleCallback === "function"
      ? requestIdleCallback(() => void run(), { timeout: 4000 })
      : window.setTimeout(() => void run(), 1500);
  return () => {
    stopped = true;
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
interface PaperTab {
  id: string;
  title: string;
  mode: ReaderMode;
  source: Record<string, string>;
}
function Workspace({ api }: { api: ApiClient }) {
  const notify = useToast();
  const route = useUrlState(),
    [theme, setTheme] = useState<Theme>(readTheme),
    [selected, setSelected] = useState<ReadonlySet<string>>(new Set()),
    [reading] = useState(createReadingState),
    [tabs, setTabs] = useState<PaperTab[]>([]),
    [mobileNav, setMobileNav] = useState(false),
    [activity, setActivity] = useState(false),
    [search, setSearch] = useState(false);
  const [width, setWidth] = useState(() => {
    const value = preferences.read("sciretriever:panel:navigation:v1");
    return value && /^\d+px$/.test(value)
      ? Math.max(200, Math.min(420, Number.parseInt(value)))
      : 244;
  });
  useEffect(() => bindTheme(theme), [theme]);
  // Pages share one scroll container; each route starts at the top and the
  // library restores its own remembered position afterwards.
  const content = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    content.current?.scrollTo({ top: 0 });
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
        mode: route.reader,
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
  const running = Array.isArray(tasks.data?.tasks)
    ? tasks.data.tasks.length
    : 0;
  const lastTasks = useRef<string | null>(null);
  const taskQueries = useQueryClient();
  useEffect(() => {
    if (!tasks.data) return;
    const current = JSON.stringify(tasks.data.tasks);
    if (lastTasks.current !== null && lastTasks.current !== current)
      invalidateMaterials(taskQueries);
    lastTasks.current = current;
  }, [tasks.data, taskQueries]);
  const showPaper = (
    id: string,
    mode: ReaderMode = "pdf",
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
      { literature: id, reader: mode, ...source },
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
        {(
          [
            { name: "资料", sections: ["lib", "snapshots", "tags"] },
            { name: "加工", sections: ["ext", "ask", "ins"] },
            { name: "运行", sections: ["task", "web"] },
          ] as const
        ).map((group) => (
          <div className="navigation-group" key={group.name}>
            <span className="navigation-group-name">{group.name}</span>
            {group.sections
              .filter(
                (section) =>
                  api.kind === "workspace" ||
                  ["lib", "ins", "ask", "syn", "ext"].includes(section),
              )
              .map((section) => (
                <Fragment key={section}>
                  <Button
                    variant="text"
                    aria-current={
                      (route.section === section ||
                        (section === "task" &&
                          ["agent", "stats"].includes(route.section))) &&
                      !route.literature &&
                      !(
                        section === "lib" &&
                        (route.query.folder || route.query.recently_opened)
                      )
                        ? "page"
                        : false
                    }
                    icon={<Icon name={section} />}
                    onPress={() =>
                      section === "lib" ? openLibrary() : go(section)
                    }
                  >
                    {sectionLabels[section]}
                    {section === "lib" && (
                      <span className="navigation-count">
                        {count.isPending
                          ? "…"
                          : (count.data?.total.toLocaleString() ?? "")}
                      </span>
                    )}
                    {section === "task" && running > 0 && (
                      <span className="navigation-count">{running} 进行中</span>
                    )}
                  </Button>
                  {section === "lib" && api.kind === "workspace" ? (
                    <LibraryFolders onNavigate={() => setMobileNav(false)} />
                  ) : null}
                </Fragment>
              ))}
          </div>
        ))}
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
  return (
    <ShellContext.Provider
      value={{
        selected,
        setSelected,
        openPaper,
        notify,
        reading,
        theme,
        setTheme: (value) => {
          setTheme(value);
          preferences.write("sciretriever:theme:v1", value);
        },
      }}
    >
      <div className="application-shell">
        <SplitPane
          label="导航栏宽度"
          width={width}
          onWidthChange={(value) => {
            setWidth(value);
            preferences.write("sciretriever:panel:navigation:v1", `${value}px`);
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
            <main className="workspace-content" ref={content}>
              <PageBoundary
                resetKey={`${route.section}:${route.literature ?? ""}`}
              >
                <Suspense
                  key={`${route.section}:${route.literature ?? ""}`}
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
          </div>
        </SplitPane>
      </div>
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
            value={theme}
            onChange={(value) => {
              setTheme(value as Theme);
              preferences.write("sciretriever:theme:v1", value);
            }}
            options={[
              { value: "light", label: "蓝白" },
              { value: "dark", label: "深色" },
              { value: "green", label: "墨绿" },
              { value: "warm", label: "暖白" },
              { value: "system", label: "跟随系统" },
            ]}
          />
        </div>
      )}
    </ShellContext.Provider>
  );
}
