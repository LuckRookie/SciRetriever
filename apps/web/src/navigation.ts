export type Workspace = "browser" | "jobs" | "library" | "configuration";

const WORKSPACES = new Set<Workspace>([
  "browser",
  "jobs",
  "library",
  "configuration",
]);

export function currentWorkspace(): Workspace {
  const value = new URL(window.location.href).searchParams.get("workspace");
  return WORKSPACES.has(value as Workspace) ? (value as Workspace) : "browser";
}

export function navigateWorkspace(workspace: Workspace): void {
  const url = new URL(window.location.href);
  if (currentWorkspace() === workspace) return;
  if (workspace === "browser") url.searchParams.delete("workspace");
  else url.searchParams.set("workspace", workspace);
  window.history.pushState({ workspace }, "", url);
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
  if (raw !== null && !WORKSPACES.has(raw as Workspace)) {
    url.searchParams.delete("workspace");
    window.history.replaceState({ workspace }, "", url);
  }
  window.dispatchEvent(
    new CustomEvent<Workspace>("sciretriever:workspace", {
      detail: workspace,
    }),
  );
}

export function mountWorkspaceHistory(): void {
  window.addEventListener("popstate", dispatchWorkspace);
  dispatchWorkspace();
}
