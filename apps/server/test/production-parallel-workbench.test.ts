import { expect, it, vi } from "vitest";
import {
  parseDurableCandidate,
  parseLiteratureCurrentFacts,
  parseWorkbenchView,
} from "@sciretriever/contracts";
import { BrowserArticleClock } from "../src/browser/article-session.js";
import { BrowserCaptureBatch } from "../src/browser/capture-batch.js";
import { createBrowserArticleFlow } from "../src/browser/article-flow.js";
import type { BrowserPageHandle } from "../src/browser/host.js";
import type { BrowserDeliveryRequest } from "../src/browser/boundary.js";
import { BrowserObservationStore } from "../src/browser/observation.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const articleA = FIXTURE_LITERATURE.literature_id;
const articleB = "00000000-0000-0000-0000-000000000003";
const metadata = parseLiteratureCurrentFacts({
  literature: FIXTURE_LITERATURE,
  metadata_snapshot: { revision: 1, sha256: "a".repeat(64) },
  primary_asset: null,
}).metadata_snapshot;
function gate<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function request(articleId: string, sessionId: string): BrowserDeliveryRequest {
  return {
    literature_id: articleId,
    identifier: "doi:10.5555/parallel",
    version: "published",
    start_url: "https://fixture.example.test/article",
    metadata_snapshot: metadata,
    signal: new AbortController().signal,
    session_identity: {
      session_id: sessionId,
      operation_id: "parallel-operation",
      generation: 1,
      literature_id: articleId,
      metadata_snapshot: metadata,
    },
    generation: 1,
  };
}
function page(articleId: string, frame: number): BrowserPageHandle {
  return {
    id: `page-${frame}`,
    url: () => "https://fixture.example.test/article",
    title: async () => articleId,
    close: vi.fn(async () => undefined),
    snapshot: async () => ({
      document_generation: 1,
      url: "https://fixture.example.test/article?credential=private",
      title: articleId,
      text: "Synthetic article",
      viewport: { width: 800, height: 600, device_scale_factor: 1 },
      screenshot: new Uint8Array([frame]),
      elements: [],
    }),
    apply: vi.fn(async () => undefined),
  };
}

it("routes HTTP selection, takeover, guidance, frames and cancellation to one article while another delivers", async () => {
  const enteredA = gate<void>();
  const enteredB = gate<void>();
  const answerA = gate<unknown>();
  const answerB = gate<unknown>();
  const pages = new Map([
    [articleA, page(articleA, 1)],
    [articleB, page(articleB, 2)],
  ]);
  const sources = new Map<string, BrowserCaptureBatch>();
  const workbench = new ProductionWorkbenchSession(articleA, async () => {
    throw new Error("A second Workbench model loop must not run");
  });
  const flow = createBrowserArticleFlow({
    session_id: "parallel",
    observations: new BrowserObservationStore(),
    collaboration: workbench,
    pages: {
      openPage: async (incoming) => {
        const owned = pages.get(incoming.literature_id)!;
        return {
          page: owned,
          session_id: incoming.session_identity!.session_id,
          stopNetwork: async () => undefined,
          close: () => owned.close(),
        };
      },
    },
    onSession: (execution) => {
      sources.set(execution.session_id, new BrowserCaptureBatch(1));
    },
    candidateSource: (identity) => ({
      hasCandidate: () => sources.get(identity.session_id)!.hasCandidate(),
      next: (signal) => sources.get(identity.session_id)!.next(signal),
    }),
    decide: async (
      observation,
      _frame,
      _signal,
      _guidance,
      _target,
      _history,
      _feedback,
      lifecycle,
    ) => {
      lifecycle!.onDispatched();
      if (observation.article_id === articleA) {
        enteredA.resolve();
        return answerA.promise;
      }
      enteredB.resolve();
      return answerB.promise;
    },
  });
  const a = await flow.open!(request(articleA, "article-session-a"));
  const b = await flow.open!(request(articleB, "article-session-b"));
  const http = await startWorkbenchHttp({
    session: workbench,
    assets: new Map([["/", { contentType: "text/html", body: "offline" }]]),
  });
  try {
    const landing = await fetch(http.origin);
    const cookie = landing.headers.get("set-cookie")!.split(";")[0]!;
    const create = await fetch(`${http.origin}/api/clients`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: http.origin,
        "Content-Type": "application/json",
        "X-Workbench-Init": "1",
      },
      body: "{}",
    });
    const client = (await create.json()) as {
      client_id: string;
      csrf: string;
      view: unknown;
    };
    const initial = parseWorkbenchView(client.view);
    expect(initial.sessions).toHaveLength(2);
    expect(initial.observation).toBeNull();
    const post = async (path: string, body: unknown) => {
      const response = await fetch(
        `${http.origin}${path}?client_id=${client.client_id}`,
        {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: http.origin,
            "Content-Type": "application/json",
            "X-Workbench-Csrf": client.csrf,
          },
          body: JSON.stringify(body),
        },
      );
      return {
        status: response.status,
        value: (await response.json()) as { view?: unknown; code?: string },
      };
    };
    const selectedA = await post("/api/sessions/select", {
      session_id: a.session_id,
    });
    expect(selectedA.status).toBe(200);
    let viewA = parseWorkbenchView(selectedA.value.view);
    const oldEpoch = viewA.control.epoch;
    expect(viewA.observation!.remaining).toMatchObject(a.clock.remaining());
    const firstA = a.step();
    const firstB = b.step();
    await Promise.all([enteredA.promise, enteredB.promise]);
    b.transferStarted("background-transfer-b");
    expect(await firstB).toEqual({
      kind: "suspended",
      transfer_id: "background-transfer-b",
    });
    expect(
      (
        await post("/api/control", {
          kind: "takeover",
          session_id: a.session_id,
          article_id: articleA,
          control_epoch: oldEpoch,
        })
      ).status,
    ).toBe(200);
    expect(await firstA).toMatchObject({ kind: "waiting" });
    answerA.resolve({ kind: "go-back", revision: 1 });
    answerB.resolve({ kind: "go-back", revision: 1 });
    viewA = parseWorkbenchView(workbench.view(client.client_id));
    expect(viewA.control.controller_id).toBe(client.client_id);
    expect(viewA.observation!.remaining).toMatchObject(a.clock.remaining());
    expect(pages.get(articleA)!.apply).not.toHaveBeenCalled();
    expect(pages.get(articleB)!.apply).not.toHaveBeenCalled();
    const epochAfterTakeover = viewA.control.epoch;
    const selectedB = await post("/api/sessions/select", {
      session_id: b.session_id,
    });
    expect(selectedB.status).toBe(200);
    expect(
      parseWorkbenchView(selectedB.value.view).control.controller_id,
    ).toBeNull();
    expect(workbench.view().control.epoch).toBe(epochAfterTakeover);
    const oldFrame = await fetch(
      `${http.origin}/api/frame?client_id=${client.client_id}&session_id=${a.session_id}&frame_seq=1`,
      { headers: { Cookie: cookie } },
    );
    expect(oldFrame.status).toBe(409);
    const missingBinding = await fetch(
      `${http.origin}/api/frame?client_id=${client.client_id}&frame_seq=1`,
      { headers: { Cookie: cookie } },
    );
    expect(missingBinding.status).toBe(400);
    const frameB = await fetch(
      `${http.origin}/api/frame?client_id=${client.client_id}&session_id=${b.session_id}&frame_seq=${parseWorkbenchView(selectedB.value.view).observation!.frame_seq}`,
      { headers: { Cookie: cookie } },
    );
    expect(new Uint8Array(await frameB.arrayBuffer())).toEqual(
      new Uint8Array([2]),
    );
    expect(
      (
        await post("/api/control", {
          kind: "pause",
          session_id: a.session_id,
          article_id: articleA,
          control_epoch: oldEpoch,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post("/api/guidance", {
          guidance_id: "b-guidance",
          session_id: b.session_id,
          article_id: articleB,
          control_epoch: 0,
          text: "Use the visible PDF button",
        })
      ).status,
    ).toBe(200);
    expect(workbench.view(client.client_id).guidance).toHaveLength(1);
    await post("/api/sessions/select", { session_id: a.session_id });
    expect(workbench.view(client.client_id).guidance).toEqual([]);
    const candidate = parseDurableCandidate({
      transfer_id: "background-transfer-b",
      source_name: "browser",
      source_record_id: null,
      state: "durable-ready",
      reference: `.candidates/${"b".repeat(64)}.bin`,
      sha256: "b".repeat(64),
      size_bytes: 32,
      capture: null,
    });
    b.transferCompleted(candidate.transfer_id);
    sources
      .get(b.session_id)!
      .add({ transfer_id: candidate.transfer_id, candidate, accepted: true });
    workbench.captured(
      articleB,
      {
        transfer_id: candidate.transfer_id,
        sha256: candidate.sha256,
        size_bytes: candidate.size_bytes,
        page_count: 1,
        disposition: "accepted",
        publication: null,
      },
      b.session_id,
    );
    b.candidateReady();
    const delivered = await b.step();
    expect(delivered).toMatchObject({ kind: "candidate", candidate });
    expect(workbench.view(client.client_id).candidates).toEqual([]);
    expect(
      (
        await post("/api/control", {
          kind: "cancel",
          session_id: a.session_id,
          article_id: articleA,
          control_epoch: epochAfterTakeover,
        })
      ).status,
    ).toBe(200);
    expect(await a.step()).toMatchObject({
      kind: "terminal",
      result: { kind: "refused", code: "browser-flow-cancelled" },
    });
    await b.close({ kind: "published", receipt_id: "publication-b" });
    workbench.removed(b.session_id, {
      kind: "retained",
      code: "browser-network-drain-timeout",
    });
    await post("/api/sessions/select", { session_id: b.session_id });
    const completedB = parseWorkbenchView(workbench.view(client.client_id));
    expect(completedB.session_outcome).toEqual({
      kind: "published",
      receipt_id: "publication-b",
    });
    expect(completedB).toMatchObject({
      state: "finished",
      session_cleanup_failure: "browser-network-drain-timeout",
    });
    expect(completedB.candidates[0]?.sha256).toBe(candidate.sha256);
    expect(a.clock.snapshot()).toMatchObject({ model_calls: 1, actions: 0 });
    expect(b.clock.snapshot()).toMatchObject({ model_calls: 1, actions: 0 });
    expect(pages.get(articleB)!.close).toHaveBeenCalledTimes(1);
    await a.close({ kind: "cancelled" });
  } finally {
    await http.close();
    await workbench.close();
    await Promise.all([
      a.close({ kind: "cancelled" }),
      b.close({ kind: "cancelled" }),
    ]);
  }
});

it("projects the same active clock across manual control and does not charge human commands", async () => {
  let at = 0;
  const clock = new BrowserArticleClock({ now: () => at });
  const active = clock.beginActive("inference");
  at += 2_000;
  active();
  expect(clock.remaining().deadline_ms).toBe(298_000);
  const workbench = new ProductionWorkbenchSession(articleA, async () => ({
    kind: "stop",
    reason: "user",
  }));
  const incoming = request(articleA, "shared-clock-session");
  const { BrowserArticleFlowDriver } = await import(
    "../src/browser/article-flow.js"
  );
  const execution = new BrowserArticleFlowDriver({
    identity: incoming.session_identity!,
    clock,
    page: pagesForClock(),
    decide: undefined,
    max_actions: 100,
    max_model_calls: 50,
    deadline_ms: 300_000,
    started_at: 0,
    signal: incoming.signal,
    article_id: articleA,
    session_id: incoming.session_identity!.session_id,
    awaitCandidate: async () => null,
  });
  const opened = await workbench.open(
    incoming,
    pagesForClock(),
    Date.now() + 1,
    execution,
  );
  const client = workbench.attach();
  workbench.takeover(client, 0);
  at += 600_000;
  const view = workbench.view(client);
  expect(view.observation!.remaining.deadline_ms).toBe(298_000);
  const observation = view.observation!;
  const command = {
    session_id: execution.session_id,
    page_id: observation.page_id,
    document_generation: observation.document_generation,
    observation_revision: observation.observation_revision,
    viewport_revision: observation.viewport_revision,
    control_epoch: view.control.epoch,
    request_id: "human-command",
    input: { kind: "go-back", revision: observation.observation_revision },
  };
  expect(await workbench.command(client, command)).toBe("applied");
  expect(await workbench.command(client, command)).toBe("duplicate");
  expect(clock.snapshot()).toMatchObject({
    active_elapsed_ms: 2_000,
    actions: 0,
    model_calls: 0,
  });
  workbench.release(client, workbench.view(client).control.epoch);
  expect(opened.automatic!.canDecide()).toBe(true);
  await execution.close({ kind: "retained", code: "synthetic" });
  opened.close(false);
  await workbench.close();
});
function pagesForClock() {
  return page(articleA, 1);
}

it("projects a supported 64-target cohort and evicts only a closed row before accepting a new queued identity", async () => {
  const workbench = new ProductionWorkbenchSession(articleA, async () => ({
    kind: "stop",
    reason: "user",
  }));
  const cancelled: string[] = [];
  for (let index = 0; index < 64; index++) {
    const identity = request(
      articleA,
      `cohort-article-${index}`,
    ).session_identity!;
    workbench.queued(identity, () => {
      cancelled.push(identity.session_id);
      workbench.removed(identity.session_id, { kind: "cancelled" });
    });
  }
  const client = workbench.attach();
  expect(parseWorkbenchView(workbench.view(client)).sessions).toHaveLength(64);
  expect(() =>
    workbench.queued(
      request(articleB, "cohort-overflow").session_identity!,
      () => {},
    ),
  ).toThrow(expect.objectContaining({ code: "session-busy" }));
  workbench.selectSession(client, "cohort-article-40");
  expect(workbench.view(client)).toMatchObject({
    session_id: "cohort-article-40",
    session_phase: "queued",
    observation: null,
  });
  workbench.cancel(client, 0, "cohort-article-40");
  expect(cancelled).toEqual(["cohort-article-40"]);
  workbench.queued(
    request(articleB, "cohort-replacement").session_identity!,
    () => {},
  );
  const replacement = parseWorkbenchView(workbench.view(client));
  expect(replacement.sessions).toHaveLength(64);
  expect(
    replacement.sessions!.some((row) => row.session_id === "cohort-article-40"),
  ).toBe(false);
  expect(
    replacement.sessions!.some(
      (row) => row.session_id === "cohort-replacement",
    ),
  ).toBe(true);
  expect(() =>
    workbench.assertBinding(client, "cohort-article-40", articleA),
  ).toThrow(expect.objectContaining({ code: "stale-command" }));
  await workbench.close();
});

it("keeps another opening article's candidate when a Workbench operation starts", async () => {
  const workbench = new ProductionWorkbenchSession(articleA, async () => ({
    kind: "stop",
  }));
  const incoming = request(articleB, "opening-candidate-b");
  workbench.queued(incoming.session_identity!, () => {});
  const candidate = {
    transfer_id: "candidate-before-admission",
    sha256: "c".repeat(64),
    size_bytes: 32,
    page_count: 1,
    disposition: "accepted" as const,
    publication: null,
  };
  workbench.captured(
    articleB,
    candidate,
    incoming.session_identity!.session_id,
  );
  const client = workbench.attach();
  workbench.selectSession(client, incoming.session_identity!.session_id);
  workbench.bindOperation(async () => {
    throw new Error("Synthetic operation finished");
  });
  const owned = page(articleB, 2);
  const flow = createBrowserArticleFlow({
    session_id: "operation-candidate-cache",
    collaboration: workbench,
    observations: new BrowserObservationStore(),
    decide: async () => ({ kind: "stop" }),
    candidateSource: () => ({
      hasCandidate: () => false,
      next: async () => null,
    }),
    pages: {
      openPage: async () => ({
        page: owned,
        session_id: incoming.session_identity!.session_id,
        stopNetwork: async () => undefined,
        close: () => owned.close(),
      }),
    },
  });
  try {
    workbench.start(articleA);
    expect(workbench.view(client).candidates).toEqual([candidate]);
    const execution = await flow.open!(incoming);
    expect(parseWorkbenchView(workbench.view(client)).candidates).toEqual([
      candidate,
    ]);
    await execution.close({ kind: "cancelled" });
  } finally {
    await workbench.close();
  }
});

it("selects and cancels an initial queued article through HTTP without opening its page or cancelling another article", async () => {
  const workbench = new ProductionWorkbenchSession(articleA, async () => ({
    kind: "stop",
  }));
  const incoming = request(articleA, "queued-session-a");
  const cancelQueued = vi.fn(() =>
    workbench.removed(incoming.session_identity!.session_id, {
      kind: "cancelled",
    }),
  );
  workbench.queued(incoming.session_identity!, cancelQueued);
  const flow = createBrowserArticleFlow({
    session_id: "queued-http",
    collaboration: workbench,
    observations: new BrowserObservationStore(),
    candidateSource: () => ({
      hasCandidate: () => false,
      next: async () => null,
    }),
    decide: async () => ({ kind: "stop" }),
    pages: {
      openPage: vi.fn(async (delivery) => {
        expect(delivery.literature_id).toBe(articleB);
        const owned = page(articleB, 2);
        return {
          page: owned,
          session_id: delivery.session_identity!.session_id,
          stopNetwork: async () => undefined,
          close: () => owned.close(),
        };
      }),
    },
  });
  const b = await flow.open!(request(articleB, "queued-session-b"));
  b.transferStarted("queued-http-transfer-b");
  const http = await startWorkbenchHttp({
    session: workbench,
    assets: new Map([["/", { contentType: "text/html", body: "offline" }]]),
  });
  try {
    const landing = await fetch(http.origin);
    const cookie = landing.headers.get("set-cookie")!.split(";")[0]!;
    const create = await fetch(`${http.origin}/api/clients`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: http.origin,
        "Content-Type": "application/json",
        "X-Workbench-Init": "1",
      },
      body: "{}",
    });
    const client = (await create.json()) as {
      client_id: string;
      csrf: string;
      view: unknown;
    };
    const post = async (path: string, body: unknown) => {
      const response = await fetch(
        `${http.origin}${path}?client_id=${client.client_id}`,
        {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: http.origin,
            "Content-Type": "application/json",
            "X-Workbench-Csrf": client.csrf,
          },
          body: JSON.stringify(body),
        },
      );
      return { response, body: (await response.json()) as { view?: unknown } };
    };
    const selected = await post("/api/sessions/select", {
      session_id: incoming.session_identity!.session_id,
    });
    const queued = parseWorkbenchView(selected.body.view);
    expect(queued).toMatchObject({
      session_id: incoming.session_identity!.session_id,
      article_id: articleA,
      session_phase: "queued",
      observation: null,
      control: { epoch: 0, controller_id: null },
    });
    expect(queued.sessions).toContainEqual({
      session_id: b.session_id,
      article_id: articleB,
      generation: 1,
      phase: "downloading",
    });
    const binding = {
      session_id: incoming.session_identity!.session_id,
      article_id: articleA,
      control_epoch: 0,
    };
    expect(
      (await post("/api/control", { ...binding, kind: "takeover" })).response
        .status,
    ).toBe(409);
    const cancelled = await post("/api/control", {
      ...binding,
      kind: "cancel",
    });
    expect(cancelled.response.status).toBe(200);
    expect(parseWorkbenchView(cancelled.body.view)).toMatchObject({
      state: "cancelled",
      session_phase: "closed",
      session_outcome: { kind: "cancelled" },
    });
    expect(cancelQueued).toHaveBeenCalledOnce();
    expect(b.phase()).toBe("downloading");
    expect(b.clock.snapshot()).toMatchObject({ model_calls: 0, actions: 0 });
  } finally {
    await http.close();
    await b.close({ kind: "cancelled" });
    await workbench.close();
  }
});

it("cancels navigation admission with the owning article signal while preserving its cohort", async () => {
  const incoming = request(articleA, "opening-session-a");
  const entered = gate<void>();
  const workbench = new ProductionWorkbenchSession(articleA, async () => ({
    kind: "stop",
  }));
  let openingSignal: AbortSignal | undefined;
  const flow = createBrowserArticleFlow({
    session_id: "opening-cancellation",
    collaboration: workbench,
    candidateSource: () => ({
      hasCandidate: () => false,
      next: async () => null,
    }),
    decide: async () => ({ kind: "stop" }),
    pages: {
      openPage: async (delivery) => {
        openingSignal = delivery.signal;
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          delivery.signal.addEventListener(
            "abort",
            () => reject(new Error("Synthetic admission cancelled")),
            { once: true },
          );
        });
        throw new Error("An aborted queued article cannot create a page");
      },
    },
  });
  const opening = flow.open!(incoming);
  const rejected = expect(opening).rejects.toMatchObject({
    code: "browser-flow-cancelled",
  });
  await entered.promise;
  const client = workbench.attach();
  expect(workbench.view(client).session_phase).toBe("queued");
  workbench.cancel(client, 0, incoming.session_identity!.session_id);
  await rejected;
  expect(openingSignal!.aborted).toBe(true);
  expect(incoming.signal.aborted).toBe(false);
  expect(workbench.view(client)).toMatchObject({
    state: "cancelled",
    session_phase: "closed",
    session_outcome: { kind: "cancelled" },
    observation: null,
  });
  await workbench.close();
});

it("projects the same hard active deadline used by the production decision loop", async () => {
  vi.useFakeTimers();
  const workbench = new ProductionWorkbenchSession(articleA, async () => {
    throw new Error("A second model loop must not run");
  });
  const dispatched = gate<void>();
  const flow = createBrowserArticleFlow({
    session_id: "hard-budget",
    deadline_ms: 200,
    now: () => Date.now(),
    collaboration: workbench,
    observations: new BrowserObservationStore(),
    candidateSource: () => ({
      hasCandidate: () => false,
      next: async () => null,
    }),
    decide: async (_o, _f, _s, _g, _t, _h, _feedback, lifecycle) => {
      lifecycle!.onDispatched();
      dispatched.resolve();
      return new Promise<never>(() => {});
    },
    pages: {
      openPage: async (delivery) => ({
        page: page(articleA, 1),
        session_id: delivery.session_identity!.session_id,
        stopNetwork: async () => undefined,
        close: async () => undefined,
      }),
    },
  });
  const execution = await flow.open!(request(articleA, "budget-session-a"));
  try {
    const client = workbench.attach();
    const step = execution.step();
    await dispatched.promise;
    await vi.advanceTimersByTimeAsync(199);
    expect(workbench.view(client).observation!.remaining).toMatchObject({
      deadline_ms: 1,
      model_calls: 49,
      actions: 100,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(await step).toMatchObject({
      kind: "terminal",
      result: { kind: "refused", code: "browser-flow-budget-exhausted" },
    });
    expect(workbench.view(client).observation!.remaining.deadline_ms).toBe(0);
    expect(execution.clock.snapshot()).toMatchObject({
      active_elapsed_ms: 200,
      model_calls: 1,
      actions: 0,
    });
  } finally {
    await execution.close({
      kind: "retained",
      code: "browser-flow-budget-exhausted",
    });
    await workbench.close();
    vi.useRealTimers();
  }
});

it("consumes only guidance included in the dispatched request when new guidance arrives during a model permit queue", async () => {
  const constructed = gate<void>();
  const permit = gate<void>();
  const workbench = new ProductionWorkbenchSession(articleA, async () => {
    throw new Error("A second model loop must not run");
  });
  const flow = createBrowserArticleFlow({
    session_id: "queued-guidance",
    collaboration: workbench,
    observations: new BrowserObservationStore(),
    candidateSource: () => ({
      hasCandidate: () => false,
      next: async () => null,
    }),
    decide: async (_o, _f, _s, guidance, _t, _h, _feedback, lifecycle) => {
      expect(guidance).toEqual(["First request guidance"]);
      constructed.resolve();
      await permit.promise;
      lifecycle!.onDispatched();
      return { kind: "stop", reason: "user" };
    },
    pages: {
      openPage: async (delivery) => ({
        page: page(articleA, 1),
        session_id: delivery.session_identity!.session_id,
        stopNetwork: async () => undefined,
        close: async () => undefined,
      }),
    },
  });
  const execution = await flow.open!(request(articleA, "guidance-session-a"));
  const client = workbench.attach();
  const submit = (id: string, text: string) =>
    workbench.submitGuidance(client, {
      guidance_id: id,
      session_id: execution.session_id,
      article_id: articleA,
      control_epoch: 0,
      text,
    });
  try {
    submit("included-guidance", "First request guidance");
    const step = execution.step();
    await constructed.promise;
    submit("next-request-guidance", "New guidance during the queue");
    permit.resolve();
    expect(await step).toMatchObject({ kind: "terminal" });
    expect(workbench.view(client).guidance).toMatchObject([
      { guidance_id: "included-guidance", state: "consumed" },
      { guidance_id: "next-request-guidance", state: "accepted" },
    ]);
  } finally {
    permit.resolve();
    await execution.close({ kind: "retained", code: "exhausted" });
    await workbench.close();
  }
});
