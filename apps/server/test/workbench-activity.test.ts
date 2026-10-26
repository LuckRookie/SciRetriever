import { expect, it, vi } from "vitest";
import {
  parseWorkbenchView,
  sha256,
  type OperatorInput,
} from "@sciretriever/contracts";
import { WorkbenchSession } from "../src/workbench/session.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import type { BrowserPageHandle } from "../src/browser/host.js";
import { BrowserActivityLog } from "../src/browser/activity.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

it("projects bounded synthetic actions, actual points, private input omission and terminal rows", async () => {
  const page: BrowserPageHandle = {
    id: "page",
    close: async () => {},
    title: async () => "Fixture",
    url: () => "https://fixture.test/",
    snapshot: async () => ({
      document_generation: 1,
      url: "https://fixture.test/?credential=private",
      title: "Fixture",
      viewport: { width: 800, height: 600, device_scale_factor: 1 },
      screenshot: new Uint8Array([1]),
      elements: [
        {
          element_id: "button",
          role: "button",
          name: "View PDF",
          editable: false,
        },
        { element_id: "input", role: "textbox", name: "Notes", editable: true },
      ],
    }),
    apply: vi.fn(async (input: OperatorInput) =>
      input.kind === "click-element"
        ? { point: { x: 41, y: 27 }, label: "View PDF" }
        : undefined,
    ),
  };
  const session = new WorkbenchSession(
    "article",
    page,
    {
      max_actions: 200,
      max_model_calls: 10,
      max_retries: 200,
      max_bytes: 10000,
      deadline_ms: 60000,
    },
    undefined,
    "session",
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    { title: "Frozen metadata title", operation_id: "synthetic-operation" },
  );
  const client = session.attach();
  try {
    await session.refresh();
    expect(session.view().actions?.[0]).toMatchObject({
      kind: "navigation",
      actor: "platform",
      url: "https://fixture.test/",
    });
    await session.activatePage({ ...page, id: "page-2" });
    expect(session.view().actions?.at(-1)).toMatchObject({
      kind: "tab-switch",
      actor: "human",
      page_id: "page-2",
    });
    session.takeover(client, 0);
    const obs = session.view().observation!;
    const command = async (input: OperatorInput, id: string) =>
      session.command(client, {
        session_id: "session",
        page_id: obs.page_id,
        document_generation: obs.document_generation,
        observation_revision: obs.observation_revision,
        viewport_revision: obs.viewport_revision,
        control_epoch: session.view().control.epoch,
        request_id: id,
        input,
      });
    await command(
      {
        kind: "click-element",
        element_id: "button",
        revision: obs.observation_revision,
      },
      "click",
    );
    expect(session.view().actions?.at(-1)).toMatchObject({
      actor: "human",
      kind: "click-element",
      point: { x: 41, y: 27 },
      frame_seq: obs.frame_seq,
      observation_revision: obs.observation_revision,
    });
    await command(
      {
        kind: "type-text",
        element_id: "input",
        text: "PRIVATE_INPUT_9271",
        revision: obs.observation_revision,
      },
      "type",
    );
    expect(JSON.stringify(session.view().actions)).not.toContain(
      "PRIVATE_INPUT_9271",
    );
    expect(session.view().actions?.at(-1)).toMatchObject({
      kind: "type-text",
      actor: "human",
    });
    const unlocated = {
      kind: "click-point",
      x: 10,
      y: 20,
      revision: obs.observation_revision,
      viewport_version: obs.viewport_revision,
    } as const;
    await command(unlocated, "no-runtime-point");
    expect(session.view().actions?.at(-1)?.point).toBeUndefined();
    const length = session.view().actions!.length;
    expect(await command(unlocated, "no-runtime-point")).toBe("duplicate");
    expect(session.view().actions).toHaveLength(length);
    vi.mocked(page.apply).mockRejectedValueOnce(
      new Error("Synthetic dispatch rejected"),
    );
    await expect(command(unlocated, "failed-dispatch")).rejects.toThrow(
      "Synthetic dispatch rejected",
    );
    expect(session.view().actions).toHaveLength(length);
    for (let i = 0; i < 105; i++)
      await command(
        { kind: "press-key", key: "Tab", revision: obs.observation_revision },
        `key-${i}`,
      );
    session.transferStarted();
    session.transferFailed();
    session.candidateReady({
      transfer_id: "transfer",
      sha256: await sha256(new Uint8Array([1])),
      size_bytes: 1,
      page_count: 1,
      disposition: "accepted",
      publication: null,
    });
    await command({ kind: "stop", reason: "user" }, "stop");
    const view = parseWorkbenchView(session.view());
    expect(view.sessions?.[0]).toMatchObject({
      operation_id: "synthetic-operation",
      title: "Frozen metadata title",
      phase: "closed",
      queued_at: expect.any(String),
      closed_at: expect.any(String),
      outcome: { kind: "retained", code: "exhausted" },
      stop: { reason: "user" },
    });
    expect(view.actions).toHaveLength(100);
    expect(
      view.actions!.every(
        (item, i, all) => i === 0 || item.seq > all[i - 1]!.seq,
      ),
    ).toBe(true);
    expect(view.actions!.slice(-4).map((a) => a.kind)).toEqual([
      "download-started",
      "download-failed",
      "validation-passed",
      "flow-stopped",
    ]);
  } finally {
    await session.close();
  }
});

it("keeps queued/closed production metadata and existing outcomes without a page or database", async () => {
  const workbench = new ProductionWorkbenchSession(null, undefined);
  const identity = {
    session_id: "queued",
    operation_id: "job-1",
    generation: 2,
    literature_id: FIXTURE_LITERATURE.literature_id,
    metadata_snapshot: {
      revision: 1,
      sha256: await sha256(new Uint8Array([1])),
    },
    title: "Frozen title",
  };
  workbench.queued(identity, () => {});
  const queued = parseWorkbenchView(workbench.view()).sessions![0]!;
  expect(queued).toMatchObject({
    operation_id: "job-1",
    title: "Frozen title",
    phase: "queued",
    queued_at: expect.any(String),
  });
  expect(queued.closed_at).toBeUndefined();
  workbench.removed("queued", { kind: "published", receipt_id: "receipt-1" });
  expect(parseWorkbenchView(workbench.view()).sessions?.[0]).toMatchObject({
    phase: "closed",
    outcome: { kind: "published", code: "published" },
    closed_at: expect.any(String),
  });
  workbench.queued({ ...identity, session_id: "cancelled" }, () => {});
  workbench.removed("cancelled", { kind: "cancelled" });
  expect(parseWorkbenchView(workbench.view()).sessions?.[1]).toMatchObject({
    outcome: { kind: "retained", code: "browser-flow-cancelled" },
    stop: { reason: "browser-flow-cancelled" },
  });
});

it("retains the original bounded stop text, distinct from the platform close outcome", () => {
  const log = new BrowserActivityLog();
  const explanation = "No link.\n" + "x".repeat(2500);
  log.stopped({ reason: "no-viable-path", explanation }, "agent");
  log.close({ kind: "retained", code: "browser-agent-stopped" });
  expect(log.stop).toEqual({
    reason: "no-viable-path",
    explanation: explanation.slice(0, 2048),
  });
  expect(log.snapshot()).toHaveLength(1);
  expect(log.snapshot()[0]).toMatchObject({
    actor: "agent",
    kind: "flow-stopped",
  });
});

it("replaces only the pending navigation input with a bounded failed platform record", () => {
  const log = new BrowserActivityLog();
  const older = log.record({
    actor: "agent",
    kind: "click-element",
    label: "Earlier action",
  });
  const pending = log.record({
    actor: "agent",
    kind: "click-element",
    page_id: "page-a",
    label: "ePDF",
  });
  log.navigationFailed("browser-navigation-failed", pending);
  expect(log.snapshot().map((action) => action.seq)).toEqual([
    older,
    pending + 1,
  ]);
  expect(log.snapshot().at(-1)).toMatchObject({
    actor: "platform",
    kind: "navigation-failed",
    page_id: "page-a",
  });
  // A later observation ended the association. The earlier successful action stays.
  log.navigationFailed("browser-navigation-failed");
  expect(log.snapshot()[0]?.seq).toBe(older);
  for (let index = 0; index < 110; index++)
    log.navigationFailed("browser-navigation-failed");
  expect(log.snapshot()).toHaveLength(100);
  expect(new Set(log.snapshot().map((action) => action.seq)).size).toBe(100);
  expect(
    log
      .snapshot()
      .every(
        (action) => action.url === undefined && action.point === undefined,
      ),
  ).toBe(true);
});
