import { WorkbenchApi } from "./api.js";
import {
  node,
  escape as e,
  icon,
  click,
  toast,
  message,
  failure,
  overlayBusy,
  dismissOverlay,
} from "./dom.js";
import {
  emptyQuery,
  loadViews,
  renderLibrary,
  renderReader,
  search,
} from "./library.js";
import { operate, uploadPdf } from "./actions.js";
import { renderTasks, taskList, openActivity } from "./tasks.js";
import { renderBrowser, closeWatch } from "./browser.js";
import { renderIntake } from "./intake.js";
import { renderRetrieval } from "./retrieval.js";
import { renderSyntheses } from "./synthesis.js";
import { renderInsights } from "./insights.js";
import { renderSettings, renderAdvanced } from "./settings.js";
import type { AppContext, Section, ReaderMode, LibraryState } from "./types.js";
import {
  parseLibrarySearchRequest,
  parseLiteratureId,
  type LiteratureDetail,
} from "@sciretriever/contracts";

const sections: readonly (readonly [Section, string])[] = [
  ["lib", "文献库"],
  ["disc", "发现"],
  ["ins", "洞察"],
  ["ask", "检索"],
  ["syn", "综合"],
  ["ext", "提取"],
  ["task", "任务"],
  ["web", "浏览器"],
  ["set", "设置"],
];
const legacy: Readonly<Record<string, Section>> = {
  overview: "lib",
  library: "lib",
  jobs: "task",
  browser: "web",
  configuration: "set",
};
export async function mountLibraryWorkspace(): Promise<void> {
  const api = new WorkbenchApi(),
    main = node("#main"),
    details = new Map<string, LiteratureDetail>();
  const library: LibraryState = {
    query: emptyQuery(),
    sort: "publication-year-desc",
    items: [],
    total: 0,
    cursor: null,
    selected: new Set(),
    peek: null,
    views: [],
    viewId: "",
  };
  const tabs = new Map<
    string,
    { mode: ReaderMode; title: string; source: Record<string, string> }
  >();
  const roots = new Map<string, HTMLElement>();
  const persistentContexts = new Map<string, AppContext>();
  let currentSection: Section = "lib",
    currentPaper: string | null = null,
    controller = new AbortController(),
    current: AppContext | null = null,
    renderRevision = 0;
  try {
    const theme = localStorage.getItem("sciretriever:theme:v1");
    if (theme && ["light", "dark", "green", "warm"].includes(theme))
      document.documentElement.dataset.theme = theme;
  } catch {
    /* Storage is optional for displaying the current page. */
  }
  const navigation = () => {
    const link = (id: Section, label: string) =>
      `<button class="si ${!currentPaper && currentSection === id ? "on" : ""}" data-go="${id}" id="${id === "lib" ? "library-tab" : id === "task" ? "jobs-tab" : id === "set" ? "config-tab" : `nav-${id}`}" ${!currentPaper && currentSection === id ? 'aria-current="page"' : ""}>${icon(id)}<span class="lb">${label}</span>${id === "lib" ? `<span class="ct">${library.total}</span>` : ""}</button>`;
    node("#side").innerHTML =
      `<div class="ws"><span class="logo">S</span>SciRetriever</div><div class="sscroll"><button class="si" id="gsearch">${icon("srch")}<span class="lb">搜索</span><span class="ct mono">⌘K</span></button><div class="kh" style="padding-top:14px">资料</div>${link("lib", "文献库")}${link("disc", "发现")}<div class="kh" style="padding-top:14px">使用</div>${link("ins", "洞察")}${link("ask", "检索")}${link("syn", "综合")}${link("ext", "提取")}<div class="kh" style="padding-top:14px">运行</div>${link("task", "任务")}${link("web", "浏览器")}</div><div class="sfoot">${link("set", "设置")}</div>`;
    click(
      "[data-go]",
      (el) => navigate(el.dataset.go as Section),
      node("#side"),
    );
    click("#gsearch", () => openSearch(), node("#side"));
    node("#tabs").innerHTML =
      `<button class="tab ${currentPaper ? "" : "on"}" data-module>${icon(currentSection, true)}<span>${sections.find((s) => s[0] === currentSection)![1]}</span></button>${[...tabs].map(([id, t]) => `<button class="tab ${id === currentPaper ? "on" : ""}" data-paper="${e(id)}" title="${e(t.title)}">${icon("file", true)}<span>${e(t.title)}</span><span class="x" data-close-tab="${e(id)}" role="button" aria-label="关闭文献">✕</span></button>`).join("")}`;
    click("[data-module]", () => navigate(currentSection), node("#tabs"));
    click(
      "[data-paper]",
      (el) => {
        if (el.dataset.paper) {
          const saved = tabs.get(el.dataset.paper);
          void openPaper(el.dataset.paper, saved?.mode, saved?.source);
        }
      },
      node("#tabs"),
    );
    click(
      "[data-close-tab]",
      (el) => {
        const id = el.dataset.closeTab!;
        tabs.delete(id);
        roots.get(`paper:${id}`)?.remove();
        roots.delete(`paper:${id}`);
        if (currentPaper === id) navigate(currentSection);
        else navigation();
      },
      node("#tabs"),
    );
  };
  const changed = () => {
    void refreshActivity();
  };
  const context = (root: HTMLElement): AppContext => ({
    api,
    root,
    signal: controller.signal,
    library,
    details,
    navigate: (section, parameters) => {
      void navigate(section, parameters);
    },
    openPaper: (id, mode, source) => {
      void openPaper(id, mode, source);
    },
    refresh: () => {
      void render();
    },
    updateNavigation: navigation,
    onTasksChanged: changed,
    scopeIds: async () => {
      const source = current ?? context(root);
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await search(source, cursor);
        if (page.total > 1000)
          throw new Error("当前范围超过 1000 篇，请缩小筛选范围后操作");
        ids.push(...page.items.map((p) => String(p.literature.literature_id)));
        cursor = page.cursor;
      } while (cursor);
      return [...new Set(ids)];
    },
    upload: async (id, file) => {
      await uploadPdf(current ?? context(root), id, file);
    },
    operate: async (op, ids) => {
      await operate(current ?? context(root), op, ids);
    },
  });
  const render = async () => {
    const revision = ++renderRevision;
    controller.abort();
    controller = new AbortController();
    const key = currentPaper ? `paper:${currentPaper}` : currentSection;
    for (const root of roots.values()) root.hidden = true;
    let root = roots.get(key);
    if (!root) {
      root = document.createElement("div");
      root.className = "workspace-page";
      root.dataset.page = key;
      main.append(root);
      roots.set(key, root);
    }
    root.hidden = false;
    if (!currentPaper && ["set", "ext"].includes(currentSection)) {
      const previous = persistentContexts.get(key);
      current = previous
        ? Object.assign(previous, context(root))
        : context(root);
      persistentContexts.set(key, current);
    } else current = context(root);
    navigation();
    try {
      if (currentPaper) {
        const id = currentPaper;
        await renderReader(current, id, tabs.get(id)?.mode ?? "pdf");
        if (revision !== renderRevision) return;
        const entry = tabs.get(id);
        if (entry)
          entry.title = details.get(id)?.literature.metadata.title ?? id;
        navigation();
      } else {
        if (
          new URL(location.href).searchParams.get("scope") === "selection" &&
          !library.selected.size
        )
          throw new Error("所选范围未恢复，请回到文献库重新选择。");
        const handlers = {
          lib: renderLibrary,
          disc: renderIntake,
          ins: renderInsights,
          ask: renderRetrieval,
          syn: renderSyntheses,
          ext: renderAdvanced,
          task: renderTasks,
          web: renderBrowser,
          set: renderSettings,
        };
        await handlers[currentSection](current);
      }
    } catch (error) {
      if (revision === renderRevision && !controller.signal.aborted)
        failure(root, error, render);
    }
  };
  const navigate = async (
    section: Section,
    parameters: Record<string, string> = {},
    push = true,
  ) => {
    if (overlayBusy()) {
      toast("正在等待操作回执，请稍候。");
      return;
    }
    try {
      await closeWatch();
    } catch (error) {
      toast(message(error));
      return;
    }
    currentSection = section;
    currentPaper = null;
    dismissOverlay();
    node("#side").classList.remove("open");
    if (push) {
      const url = new URL(location.href);
      url.search = "";
      url.searchParams.set("view", section);
      url.searchParams.set("query", JSON.stringify(library.query));
      url.searchParams.set("sort", library.sort);
      for (const [k, v] of Object.entries(parameters))
        url.searchParams.set(k, v);
      history.pushState({ selected: [...library.selected] }, "", url);
    }
    await render();
  };
  const openPaper = async (
    id: string,
    mode: ReaderMode = "pdf",
    source: Record<string, string> = {},
  ) => {
    if (overlayBusy()) {
      toast("正在等待操作回执，请稍候。");
      return;
    }
    try {
      await closeWatch();
    } catch (error) {
      toast(message(error));
      return;
    }
    currentPaper = id;
    const previous = tabs.get(id);
    tabs.set(id, {
      mode,
      source,
      title:
        previous?.title ??
        details.get(id)?.literature.metadata.title ??
        "正在读取…",
    });
    const url = new URL(location.href);
    url.search = "";
    url.searchParams.set("view", currentSection);
    url.searchParams.set("query", JSON.stringify(library.query));
    url.searchParams.set("sort", library.sort);
    url.searchParams.set("literature", id);
    url.searchParams.set("reader", mode);
    for (const [key, value] of Object.entries(source))
      url.searchParams.set(key, value);
    history.pushState({ selected: [...library.selected] }, "", url);
    dismissOverlay();
    await render();
  };
  let activityBusy = false;
  const refreshActivity = async () => {
    if (activityBusy || !current || !api.workspace.capabilities.tasks) return;
    activityBusy = true;
    try {
      const list = await taskList(current, "active");
      node("#actTxt").textContent = list.items.length
        ? `${list.items.length}${list.cursor ? "+" : ""} 个任务进行中`
        : "没有进行中的任务";
      node("#actBtn .d").hidden = !list.items.length;
    } catch {
      node("#actTxt").textContent = "任务状态暂不可用";
    } finally {
      activityBusy = false;
    }
  };
  const openSearch = async () => {
    if (overlayBusy()) return;
    await closeWatch();
    const overlay = node("#overlay");
    overlay.innerHTML =
      '<div class="scrim" data-close></div><section class="modal" role="dialog" aria-label="搜索"><div class="dh"><h3>搜索文献</h3><button class="btn q sm" data-close>✕</button></div><form class="db" id="global-search"><input aria-label="搜索文献" placeholder="标题、作者或关键词" required autofocus><button class="btn blue">搜索</button></form></section>';
    click("[data-close]", () => overlay.replaceChildren(), overlay);
    node<HTMLFormElement>("#global-search", overlay).onsubmit = (event) => {
      event.preventDefault();
      library.query = {
        ...emptyQuery(),
        text: node<HTMLInputElement>("input", overlay).value,
      };
      void navigate("lib");
    };
    node<HTMLInputElement>("input", overlay).focus();
  };
  node("#menuBtn").onclick = () => node("#side").classList.toggle("open");
  node("#actBtn").onclick = () => {
    if (overlayBusy()) return;
    if (current)
      void closeWatch()
        .then(() => openActivity(current!))
        .catch((error) => toast(message(error)));
  };
  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      void openSearch().catch((error) => toast(message(error)));
    }
    if (event.key === "Escape") node("#side").classList.remove("open");
    if (event.key === "Escape")
      void closeWatch()
        .then(() => {
          dismissOverlay();
        })
        .catch((error) => toast(message(error)));
  });
  window.addEventListener("sciretriever:tasks-changed", changed);
  window.addEventListener("sciretriever:navigate", (event) => {
    const detail = (
      event as CustomEvent<{
        workspace: string;
        parameters: Record<string, string>;
      }>
    ).detail;
    if (detail.workspace === "library" && detail.parameters.synthesis) {
      void navigate("syn", { artifact: detail.parameters.synthesis });
      return;
    }
    if (detail.workspace === "library" && detail.parameters.literature) {
      void openPaper(
        detail.parameters.literature,
        detail.parameters.document
          ? "doc"
          : detail.parameters.knowledge
            ? "know"
            : "pdf",
        detail.parameters,
      );
      return;
    }
    void navigate(legacy[detail.workspace] ?? "lib", {
      ...detail.parameters,
      ...(detail.parameters.job ? { task: detail.parameters.job } : {}),
    });
  });
  const readLocation = () => {
    const address = new URL(location.href);
    const p = address.searchParams;
    if (history.state && Array.isArray(history.state.selected)) {
      library.selected = new Set(
        (history.state.selected as unknown[]).map((value) =>
          parseLiteratureId(value),
        ),
      );
    }
    currentSection = sections.some((s) => s[0] === p.get("view"))
      ? (p.get("view") as Section)
      : (legacy[p.get("workspace") ?? ""] ?? "lib");
    if (p.has("workspace") && !legacy[p.get("workspace")!]) {
      p.delete("workspace");
      p.set("view", currentSection);
      history.replaceState(null, "", address);
    }
    const parsed = parseLibrarySearchRequest({
      query: p.has("query") ? JSON.parse(p.get("query")!) : library.query,
      sort: p.get("sort") ?? library.sort,
      limit: 50,
      cursor: null,
    });
    library.query = parsed.query;
    library.sort = parsed.sort;
    currentPaper =
      p.has("reader") || p.get("workspace") === "library"
        ? p.get("literature")
        : null;
    if (currentPaper)
      tabs.set(currentPaper, {
        mode: (["pdf", "doc", "know"].includes(p.get("reader") ?? "")
          ? p.get("reader")
          : "pdf") as ReaderMode,
        title: currentPaper,
        source: Object.fromEntries(
          ["document", "knowledge", "task"].flatMap((key) =>
            p.has(key) ? [[key, p.get(key)!]] : [],
          ),
        ),
      });
  };
  window.addEventListener("popstate", () => {
    void closeWatch()
      .then(() => {
        readLocation();
        return render();
      })
      .catch((error) => toast(message(error)));
  });
  navigation();
  main.innerHTML =
    '<div class="empty" id="workspace-connecting" role="status">正在连接文献库…</div>';
  try {
    await api.connect();
    main.replaceChildren();
    readLocation();
    current = context(main);
    library.views = loadViews(current);
    await render();
    await refreshActivity();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshActivity();
    }, 5000);
    window.addEventListener(
      "pagehide",
      () => {
        clearInterval(timer);
        controller.abort();
      },
      { once: true },
    );
  } catch (error) {
    failure(main, error, () => {
      location.reload();
    });
    node("#actTxt").textContent = "连接未完成";
  }
}
