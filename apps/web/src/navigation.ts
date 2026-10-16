export type Workspace =
  | "overview"
  | "browser"
  | "jobs"
  | "library"
  | "configuration";

const WORKSPACES: Readonly<
  Record<Workspace, { id: string; title: string; tab: string }>
> = {
  overview: { id: "overview-workspace", title: "工作台", tab: "overview-tab" },
  browser: { id: "live-workspace", title: "Browser 协助", tab: "browser-tab" },
  jobs: { id: "jobs-workspace", title: "任务", tab: "jobs-tab" },
  library: { id: "library-workspace", title: "文献库", tab: "library-tab" },
  configuration: { id: "config-workspace", title: "设置", tab: "config-tab" },
};

function isWorkspace(value: string | null): value is Workspace {
  return value !== null && Object.hasOwn(WORKSPACES, value);
}

export function currentWorkspace(): Workspace {
  const value = new URL(window.location.href).searchParams.get("workspace");
  return isWorkspace(value) ? value : "overview";
}

export function navigateWorkspace(
  workspace: Workspace,
  parameters: Readonly<Record<string, string | null>> = {},
): void {
  if (document.documentElement.dataset.ui === "library") {
    window.dispatchEvent(
      new CustomEvent("sciretriever:navigate", {
        detail: {
          workspace,
          parameters: Object.fromEntries(
            Object.entries(parameters).filter(([, value]) => value !== null),
          ),
        },
      }),
    );
    return;
  }
  const url = new URL(window.location.href);
  if (workspace === "overview") url.searchParams.delete("workspace");
  else url.searchParams.set("workspace", workspace);
  for (const [name, value] of Object.entries(parameters)) {
    if (value === null) url.searchParams.delete(name);
    else url.searchParams.set(name, value);
  }
  if (url.href !== window.location.href)
    window.history.pushState({ workspace }, "", url);
  dispatchWorkspace();
}

export function onWorkspace(
  listener: (workspace: Workspace) => void,
): () => void {
  const handle = (event: Event) =>
    listener((event as CustomEvent<Workspace>).detail);
  window.addEventListener("sciretriever:workspace", handle);
  return () => window.removeEventListener("sciretriever:workspace", handle);
}

function dispatchWorkspace(): void {
  const workspace = currentWorkspace();
  const url = new URL(window.location.href);
  const raw = url.searchParams.get("workspace");
  if (raw !== null && !isWorkspace(raw)) {
    url.searchParams.delete("workspace");
    window.history.replaceState({ workspace }, "", url);
  }
  const selected = WORKSPACES[workspace];
  for (const [name, descriptor] of Object.entries(WORKSPACES)) {
    const panel = document.getElementById(descriptor.id);
    if (panel) panel.hidden = name !== workspace;
    const tab = document.getElementById(descriptor.tab);
    if (name === workspace) tab?.setAttribute("aria-current", "page");
    else tab?.removeAttribute("aria-current");
  }
  const title = document.getElementById("workspace-name");
  if (title) title.textContent = selected.title;
  const details = document.getElementById("open-details");
  if (details) details.hidden = workspace !== "browser";
  const browserDetails = document.getElementById("live-details");
  if (browserDetails) browserDetails.dataset.open = "false";
  const backdrop = document.getElementById("details-backdrop");
  if (backdrop) backdrop.hidden = true;
  const skip = document.querySelector<HTMLAnchorElement>(".skip-link");
  if (skip) {
    skip.href = `#${selected.id}`;
    skip.textContent = `跳到${selected.title}`;
  }
  document.getElementById(selected.id)?.focus({ preventScroll: true });
  closeMobileNavigation();
  window.dispatchEvent(
    new CustomEvent<Workspace>("sciretriever:workspace", { detail: workspace }),
  );
}

function closeMobileNavigation(): void {
  const rail = document.getElementById("workspace-navigation");
  if (rail) {
    rail.dataset.open = "false";
    rail.inert = window.matchMedia("(max-width: 850px)").matches;
  }
  document
    .getElementById("mobile-navigation")
    ?.setAttribute("aria-expanded", "false");
}

export function mountWorkspaceHistory(): void {
  const mobile = window.matchMedia("(max-width: 850px)");
  mobile.addEventListener("change", closeMobileNavigation);
  closeMobileNavigation();
  const menu = document.getElementById("mobile-navigation");
  menu?.addEventListener("click", () => {
    const rail = document.getElementById("workspace-navigation");
    if (!rail) return;
    const open = rail.dataset.open !== "true";
    rail.dataset.open = String(open);
    rail.inert = mobile.matches && !open;
    menu.setAttribute("aria-expanded", String(open));
    if (open) rail.querySelector<HTMLElement>("button, a")?.focus();
  });
  window.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      document.getElementById("workspace-navigation")?.dataset.open === "true"
    ) {
      closeMobileNavigation();
      menu?.focus();
    }
  });
  document.getElementById("browser-back")?.addEventListener("click", () => {
    navigateWorkspace("jobs", {
      job: new URL(window.location.href).searchParams.get("job"),
    });
  });
  document.addEventListener("click", (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-workspace]")
        : null;
    if (target && isWorkspace(target.dataset.workspace ?? null)) {
      event.preventDefault();
      navigateWorkspace(target.dataset.workspace as Workspace);
    }
  });
  for (const [workspace, descriptor] of Object.entries(WORKSPACES)) {
    document
      .getElementById(descriptor.tab)
      ?.addEventListener("click", (event) => {
        event.preventDefault();
        navigateWorkspace(workspace as Workspace);
      });
  }
  for (const [id, workspace] of [
    ["jobs-toggle", "jobs"],
    ["library-toggle", "library"],
  ] as const)
    document
      .getElementById(id)
      ?.addEventListener("click", () => navigateWorkspace(workspace));
  const newTask = () => {
    navigateWorkspace("jobs", { job: null });
    const form = document.getElementById("job-form");
    const containingDetails = form?.closest("details");
    if (containingDetails) containingDetails.open = true;
    form?.scrollIntoView({ block: "nearest" });
    document.getElementById("job-query")?.focus();
  };
  document
    .getElementById("new-task-button")
    ?.addEventListener("click", newTask);
  window.addEventListener("popstate", dispatchWorkspace);
  dispatchWorkspace();
}
