import { expect, it, vi } from "vitest";
import { WorkbenchSession } from "../src/workbench/session.js";
import type { BrowserPageHandle } from "../src/browser/host.js";
import { BrowserPageRuntimeError } from "../src/browser/page-runtime.js";
import { createBrowserArticleFlow } from "../src/browser/article-flow.js";
import type { WorkbenchObservation } from "@sciretriever/contracts";

function fixture(
  decide: ConstructorParameters<typeof WorkbenchSession>[3],
  deadlineMs = 60_000,
) {
  let generation = 1;
  const committed = vi.fn();
  const apply = vi.fn<BrowserPageHandle["apply"]>(
    async (_input, expectedGeneration, current) => {
      if (generation !== expectedGeneration || !current())
        throw new BrowserPageRuntimeError();
      committed();
    },
  );
  const page: BrowserPageHandle = {
    id: "production-page",
    close: async () => {},
    title: async () => "Article",
    url: () => "http://127.0.0.1/article",
    snapshot: async () => ({
      document_generation: generation,
      url: "http://127.0.0.1/article",
      title: "Article",
      viewport: { width: 800, height: 600, device_scale_factor: 1 },
      screenshot: new Uint8Array([1]),
      elements: [],
    }),
    apply,
  };
  const session = new WorkbenchSession(
    "article-1",
    page,
    {
      max_actions: 10,
      max_model_calls: 5,
      max_retries: 10,
      max_bytes: 10000,
      deadline_ms: deadlineMs,
    },
    decide,
    "production-session",
    async () => {},
    undefined,
    undefined,
    undefined,
    true,
  );
  return {
    session,
    page,
    apply,
    committed,
    navigate: () => {
      generation += 1;
    },
  };
}

function guidance(session: WorkbenchSession, text: string) {
  return {
    guidance_id: "guidance-1",
    session_id: session.id,
    article_id: session.articleId,
    control_epoch: session.view().control.epoch,
    text,
  };
}

it("consumes bounded guidance at the next model observation and drops a late model result after takeover", async () => {
  let resolve!: (action: unknown) => void;
  const seen: Array<{
    observation: WorkbenchObservation;
    guidance: readonly string[] | undefined;
  }> = [];
  const { session, apply } = fixture(
    async (observation, _frame, _signal, hints) => {
      seen.push({ observation, guidance: hints });
      return new Promise((done) => {
        resolve = done;
      });
    },
  );
  const a = session.attach(),
    b = session.attach();
  await session.refresh();
  const first = session.submitGuidance(
    a,
    guidance(session, "Try the visible download button"),
  );
  expect(first.state).toBe("accepted");
  expect(Object.keys(first).sort()).toEqual(
    ["guidance_id", "article_id", "text", "state"].sort(),
  );
  expect(session.submitGuidance(a, guidance(session, first.text)).state).toBe(
    "accepted",
  );
  expect(() =>
    session.submitGuidance(a, guidance(session, "Different text")),
  ).toThrow();
  const pending = session.runAutomaticStep(new AbortController().signal);
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  expect(seen[0]!.guidance).toEqual([first.text]);
  expect(session.view().guidance?.[0]?.state).toBe("consumed");
  const epoch = session.view().control.epoch;
  session.takeover(a, epoch);
  expect(() => session.takeover(b, epoch)).toThrow();
  resolve({
    kind: "go-back",
    revision: seen[0]!.observation.observation_revision,
  });
  expect(await pending).toBe("retry");
  expect(apply).not.toHaveBeenCalled();
  const current = session.view().observation!;
  await session.command(a, {
    session_id: session.id,
    page_id: current.page_id,
    document_generation: current.document_generation,
    observation_revision: current.observation_revision,
    viewport_revision: current.viewport_revision,
    control_epoch: session.view().control.epoch,
    request_id: "human-1",
    input: { kind: "go-back", revision: current.observation_revision },
  });
  expect(apply).toHaveBeenCalledTimes(1);
  session.release(a, session.view().control.epoch);
  await session.close();
});

it("does not reacquire AI control after a gated refresh crosses human takeover", async () => {
  let resumeSnapshot!: () => void;
  let snapshotStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    resumeSnapshot = resolve;
  });
  const started = new Promise<void>((resolve) => {
    snapshotStarted = resolve;
  });
  const decide = vi.fn(async (observation: WorkbenchObservation) => ({
    kind: "go-back",
    revision: observation.observation_revision,
  }));
  const { session, page, committed } = fixture(decide);
  const controller = session.attach();
  await session.refresh();
  const original = page.snapshot.bind(page);
  vi.spyOn(page, "snapshot").mockImplementationOnce(async () => {
    snapshotStarted();
    await gate;
    return original();
  });
  const pending = session.runAutomaticStep(new AbortController().signal);
  await started;
  session.takeover(controller, session.view().control.epoch);
  resumeSnapshot();
  expect(await pending).toBe("retry");
  expect(decide).not.toHaveBeenCalled();
  expect(committed).not.toHaveBeenCalled();
  const waiting = session.runAutomaticStep(new AbortController().signal);
  session.release(controller, session.view().control.epoch);
  expect(await waiting).toBe("retry");
  expect(await session.runAutomaticStep(new AbortController().signal)).toBe(
    "applied",
  );
  expect(decide).toHaveBeenCalledTimes(1);
  expect(committed).toHaveBeenCalledTimes(1);
  await session.close();
});

it("rejects a pending model action after the Browser document generation changes", async () => {
  let finishModel!: (action: unknown) => void;
  const { session, navigate, apply, committed } = fixture(
    () =>
      new Promise((resolve) => {
        finishModel = resolve;
      }),
  );
  await session.refresh();
  const pending = session.runAutomaticStep(new AbortController().signal);
  await vi.waitFor(() => expect(finishModel).toBeDefined());
  const revision = session.view().observation!.observation_revision;
  navigate();
  finishModel({ kind: "go-back", revision });
  await expect(pending).rejects.toBeInstanceOf(BrowserPageRuntimeError);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(committed).not.toHaveBeenCalled();
  await session.close();
});

it("pauses on controller disconnect until an explicit takeover and release, while observers can disconnect", async () => {
  const { session, apply } = fixture(async (observation) => ({
    kind: "go-back",
    revision: observation.observation_revision,
  }));
  const controller = session.attach();
  const observer = session.attach();
  await session.refresh();
  session.takeover(controller, session.view().control.epoch);
  session.detach(observer);
  expect(session.view().state).toBe("watching");
  session.detach(controller);
  expect(session.view().state).toBe("paused");
  const signal = new AbortController();
  const waiting = session.runAutomaticStep(signal.signal);
  const next = session.attach();
  session.takeover(next, session.view().control.epoch);
  expect(await waiting).toBe("retry");
  expect(apply).not.toHaveBeenCalled();
  session.release(next, session.view().control.epoch);
  expect(await session.runAutomaticStep(signal.signal)).toBe("applied");
  expect(apply).toHaveBeenCalledTimes(1);
  await session.close();
});

it("keeps the model's observation binding stable while viewers poll frames", async () => {
  let decide!: (action: unknown) => void;
  const { session, apply } = fixture(
    () =>
      new Promise((resolve) => {
        decide = resolve;
      }),
  );
  session.attach();
  await session.refresh();
  const pending = session.runAutomaticStep(new AbortController().signal);
  await vi.waitFor(() => expect(session.view().state).toBe("agent-running"));
  const revision = session.view().observation!.observation_revision;
  await session.refresh();
  await session.refresh();
  expect(session.view().observation!.observation_revision).toBe(revision);
  decide({ kind: "go-back", revision });
  expect(await pending).toBe("applied");
  expect(apply).toHaveBeenCalledTimes(1);
  await session.close();
});

it("expires unconsumed guidance on control takeover", async () => {
  const { session } = fixture(undefined);
  const a = session.attach();
  await session.refresh();
  session.submitGuidance(a, guidance(session, "Old article"));
  session.takeover(a, session.view().control.epoch);
  expect(session.view().guidance?.[0]?.state).toBe("expired");
  await session.close();
});

it.each([
  ["user", "stopped"],
  ["budget", "budget"],
  ["cancel", "cancelled"],
] as const)(
  "preserves model stop reason %s as %s in the production article flow",
  async (reason, expected) => {
    const { session, apply } = fixture(async () => ({
      kind: "stop",
      reason,
    }));
    await session.refresh();
    expect(await session.runAutomaticStep(new AbortController().signal)).toBe(
      expected,
    );
    expect(apply).toHaveBeenCalledTimes(1);
    await session.close();
  },
);

it("wakes a human-controlled article flow when the human stops it", async () => {
  const { session } = fixture(undefined);
  const controller = session.attach();
  await session.refresh();
  session.takeover(controller, session.view().control.epoch);
  const waiting = session.runAutomaticStep(new AbortController().signal);
  const observation = session.view().observation!;
  await session.command(controller, {
    session_id: session.id,
    page_id: observation.page_id,
    document_generation: observation.document_generation,
    observation_revision: observation.observation_revision,
    viewport_revision: observation.viewport_revision,
    control_epoch: session.view().control.epoch,
    request_id: "human-stop",
    input: { kind: "stop", reason: "user" },
  });
  expect(await waiting).toBe("stopped");
  await session.close();
});

it("ends the article on the shared page deadline when a model ignores AbortSignal", async () => {
  let modelCalled = false;
  const { session, page } = fixture(async () => {
    modelCalled = true;
    return new Promise<never>(() => {});
  }, 500);
  const flow = createBrowserArticleFlow({
    pages: { openPage: async () => ({ page, close: async () => {} }) },
    decide: async () => ({ kind: "stop", reason: "user" }),
    collaboration: {
      open: async () => ({
        step: (signal) => session.runAutomaticStep(signal),
        close: (failed) =>
          session.finishProduction(failed ? "failed" : "finished"),
      }),
    },
    session_id: session.id,
    max_actions: 10,
    max_model_calls: 5,
    deadline_ms: 500,
    candidate_timeout_ms: 1,
    awaitCandidate: async () => null,
  });
  const result = await flow.deliver({
    literature_id: session.articleId,
    start_url: "http://127.0.0.1/article",
    signal: new AbortController().signal,
  } as Parameters<typeof flow.deliver>[0]);
  expect(modelCalled).toBe(true);
  expect(result).toMatchObject({
    kind: "refused",
    code: "browser-flow-budget-exhausted",
  });
  expect(session.view().state).toBe("failed");
  await session.close();
});
