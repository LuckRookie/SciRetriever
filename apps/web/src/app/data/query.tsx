import { createContext, useContext } from "react";
import { QueryClient } from "@tanstack/react-query";
import { ApiClient, ApiError } from "./api.js";
import type { WorkbenchView } from "@sciretriever/contracts";

export const queryKeys = {
  workspace: ["workspace"],
  library: ["library"],
  literature: ["literature"],
  document: ["document"],
  knowledge: ["knowledge"],
  processors: ["processors"],
  archive: ["archive"],
  tags: ["tags"],
  snapshots: ["snapshots"],
  metadata: ["metadata"],
  tasks: ["tasks"],
  browser: ["browser"],
  configuration: ["configuration"],
} as const;
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (count, error) =>
          count < 1 &&
          (!(error instanceof ApiError) || error.kind === "retryable"),
      },
      mutations: { retry: false },
    },
  });
}
export const ApiContext = createContext<ApiClient | null>(null);
export function useApi() {
  const api = useContext(ApiContext);
  if (!api) throw new Error("ApiContext is missing");
  return api;
}
export function invalidateMaterials(queries: QueryClient) {
  for (const queryKey of [
    queryKeys.archive,
    queryKeys.tags,
    queryKeys.snapshots,
    ["folders"],
    queryKeys.metadata,
    queryKeys.document,
    queryKeys.library,
    queryKeys.literature,
    queryKeys.knowledge,
    queryKeys.processors,
  ])
    void queries.invalidateQueries({ queryKey });
}
function publicationKey(view: WorkbenchView | null): string {
  // Observations, screenshots, controller epochs and heartbeat timestamps are
  // not publications. Refresh the library only when a durable outcome changes.
  return JSON.stringify({
    publications:
      view?.candidates
        .filter((candidate) => candidate.publication)
        .map((candidate) => candidate.publication) ?? [],
    outcome: view?.session_outcome
      ? [view.session_id, view.session_outcome]
      : null,
    report: view?.operation_feedback?.report ?? null,
    // The PDF read back through Library once the operation ends: its
    // arrival is a publication of the paper's materials too.
    primary_pdf: view?.operation_feedback
      ? [
          view.operation_feedback.primary_pdf_status,
          view.operation_feedback.primary_pdf?.sha256 ?? null,
        ]
      : null,
  });
}
/** The server publishes a complete Browser view, never an untyped cache patch. */
export function subscribeInvalidation(
  api: ApiClient,
  queries: QueryClient,
): () => void {
  let previous = publicationKey(api.view);
  let disconnected = false;
  const onView = () => {
    queries.setQueryData(["browser", "view"], api.view);
    const current = publicationKey(api.view);
    if (current !== previous) {
      previous = current;
      invalidateMaterials(queries);
      void queries.invalidateQueries({ queryKey: queryKeys.tasks });
    }
  };
  const reconnect = (connected: boolean) => {
    queries.setQueryData(["workspace", "connected"], connected);
    if (connected && disconnected) {
      invalidateMaterials(queries);
      void queries.invalidateQueries({ queryKey: ["agent-sessions"] });
      void queries.invalidateQueries({ queryKey: queryKeys.tasks });
    }
    disconnected = !connected;
    if (connected) onView();
  };
  const onMaterials = () => {
    invalidateMaterials(queries);
    void queries.invalidateQueries({ queryKey: queryKeys.tasks });
  };
  const onAgents = () => {
    void queries.invalidateQueries({ queryKey: ["agent-sessions"] });
    void queries.invalidateQueries({ queryKey: queryKeys.tasks });
  };
  api.agentListeners.add(onAgents);
  api.materialListeners.add(onMaterials);
  api.listeners.add(onView);
  api.connectionListeners.add(reconnect);
  return () => {
    api.agentListeners.delete(onAgents);
    api.materialListeners.delete(onMaterials);
    api.listeners.delete(onView);
    api.connectionListeners.delete(reconnect);
  };
}
