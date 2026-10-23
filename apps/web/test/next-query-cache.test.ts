import { expect, it, vi } from "vitest";
import { ApiClient } from "../src/app/data/api.js";
import {
  createQueryClient,
  subscribeInvalidation,
} from "../src/app/data/query.js";
import { parseUrl } from "../src/app/data/url.js";
import type { WorkbenchView } from "@sciretriever/contracts";

it("does not refetch material queries on Browser heartbeats or control changes, but invalidates publications and reconnects", () => {
  const api = new ApiClient();
  const view: WorkbenchView = {
    session_id: "synthetic-session",
    article_id: null,
    state: "watching",
    control: {
      workspace_id: "synthetic-workspace",
      viewers: 1,
      controller_id: null,
      epoch: 0,
    },
    observation: null,
    model_ready: false,
    error: null,
    candidates: [],
  };
  api.view = view;
  const client = createQueryClient();
  const invalidations = vi.spyOn(client, "invalidateQueries");
  const dispose = subscribeInvalidation(api, client);
  const emit = (next: WorkbenchView) => {
    api.view = next;
    for (const listener of api.listeners) listener(next);
  };
  for (let i = 0; i < 20; i++)
    emit({ ...view, control: { ...view.control, epoch: i } });
  expect(invalidations).not.toHaveBeenCalled();
  emit({
    ...view,
    session_outcome: { kind: "published", receipt_id: "receipt-1" },
  });
  expect(invalidations).toHaveBeenCalledTimes(11);
  expect(
    invalidations.mock.calls.map(([request]) => request?.queryKey?.[0]).sort(),
  ).toEqual(
    [
      "archive",
      "tags",
      "snapshots",
      "folders",
      "metadata",
      "document",
      "library",
      "literature",
      "knowledge",
      "processors",
      "tasks",
    ].sort(),
  );
  for (let i = 0; i < 20; i++) emit(api.view!);
  expect(invalidations).toHaveBeenCalledTimes(11);
  for (const listener of api.connectionListeners) {
    listener(false);
    listener(true);
    listener(true);
  }
  expect(invalidations).toHaveBeenCalledTimes(23);
  expect(
    invalidations.mock.calls
      .slice(11)
      .map(([request]) => request?.queryKey?.[0]),
  ).toContain("agent-sessions");
  invalidations.mockClear();
  for (const listener of api.agentListeners) listener();
  expect(
    invalidations.mock.calls.map(([request]) => request?.queryKey),
  ).toEqual([["agent-sessions"], ["tasks"]]);
  dispose();
  expect(api.agentListeners.size).toBe(0);
  expect(api.listeners.size).toBe(0);
  expect(api.connectionListeners.size).toBe(0);
  client.clear();
});

it("parses current view links and fixed sources without mapping retired workspace aliases", () => {
  for (const section of ["lib", "task", "web", "set"])
    expect(parseUrl(`?view=${section}`).section).toBe(section);
  expect(parseUrl("?workspace=browser").section).toBe("lib");
  const route = parseUrl(
    "?view=lib&literature=00000000-0000-0000-0000-000000000001&reader=doc&document=fixed-version",
  );
  expect(route.literature).toBe("00000000-0000-0000-0000-000000000001");
  expect(route.reader).toBe("doc");
  expect(route.parameters.get("document")).toBe("fixed-version");
  expect(parseUrl('?query={"statuses":["invented"]}').error).not.toBeNull();
});

it("keeps a newer pushed Browser session when an older view read finishes late", async () => {
  const api = new ApiClient();
  const view: WorkbenchView = {
    session_id: "session-old",
    article_id: "article-old",
    state: "watching",
    control: {
      workspace_id: "session-old",
      viewers: 1,
      controller_id: null,
      epoch: 0,
    },
    observation: null,
    model_ready: false,
    error: null,
    candidates: [],
  };
  api.accept(view);
  let finish!: (value: Record<string, unknown>) => void;
  vi.spyOn(api, "read").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = api.refreshView();
  const pushed = {
    ...view,
    session_id: "session-new",
    control: {
      ...view.control,
      workspace_id: "session-new",
      epoch: 2,
      controller_id: "new-controller",
    },
  };
  api.accept(pushed);
  finish({ ...view });
  expect(await pending).toEqual(pushed);
  expect(api.view).toEqual(pushed);

  const next = api.refreshView();
  const latest = { ...pushed, state: "paused" as const };
  finish(latest);
  expect(await next).toEqual(latest);
  expect(api.view).toEqual(latest);
});
