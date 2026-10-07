import { afterEach, expect, it, vi } from "vitest";
import { parseDurableCandidate } from "@sciretriever/contracts";
import { BrowserArticleScheduler } from "../src/entry/browser-scheduler.js";
import {
  BrowserArticleClock,
  type BrowserArticleExecution,
  type BrowserArticleStepResult,
} from "../src/browser/article-session.js";
import type { BrowserDeliveryRequest } from "../src/browser/boundary.js";
import type { BrowserOwnedRequest } from "../src/browser/cdp-owner.js";

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const stopped = { kind: "terminal", result: { kind: "exhausted" } } as const;
function request(
  id: string,
  host = id,
  signal = new AbortController().signal,
): BrowserDeliveryRequest {
  return {
    literature_id: id,
    identifier: `doi:10.1/${id}`,
    version: "published",
    start_url: `https://${host}.test/article`,
    metadata_snapshot: {
      revision: 1,
      sha256: parseDurableCandidate({
        capture: null,
        source_name: "browser",
        source_record_id: null,
        transfer_id: "fixture",
        state: "durable-ready",
        reference: `.candidates/${"a".repeat(64)}.bin`,
        sha256: "a".repeat(64),
        size_bytes: 1,
      }).sha256,
    },
    signal,
    operation_id: "fixture",
    generation: 1,
  };
}
function execution(
  input: BrowserDeliveryRequest,
  step: () => Promise<BrowserArticleStepResult>,
  close: () => Promise<void> = vi.fn(async () => undefined),
): BrowserArticleExecution {
  return {
    identity: input.session_identity!,
    session_id: input.session_identity!.session_id,
    clock: new BrowserArticleClock(),
    phase: () => "ready",
    step,
    changed: async () => undefined,
    transferStarted: () => undefined,
    transferCompleted: () => undefined,
    transferFailed: () => undefined,
    candidateRejected: () => undefined,
    candidateReady: () => undefined,
    controlEpochChanged: () => undefined,
    cancel: () => undefined,
    rateLimited: () => undefined,
    setNetworkAccess: () => undefined,
    close,
  };
}
function navigation(input: BrowserDeliveryRequest): BrowserOwnedRequest {
  return {
    ...input.session_identity!,
    page_id: "page-" + input.literature_id,
    document_generation: 0,
    signal: input.signal,
    request_id: "request-" + input.literature_id,
    resource_type: "document",
    request_method: "GET",
    is_navigation: true,
    frame_id: "frame-" + input.literature_id,
    document_id: "loader-" + input.literature_id,
    parent_document_id: null,
    source_document_id: null,
    redirected_request_id: null,
  };
}

it("retires an active old generation before its late candidate and keeps the same platform's cooldown for the replacement", async () => {
  vi.useFakeTimers();
  const owner = new BrowserArticleScheduler({ sessions: 2, workers: 2 });
  const late = deferred<BrowserArticleStepResult>();
  const opened: { generation: number; signal: AbortSignal }[] = [];
  const oldClose = vi.fn(async () => undefined);
  const candidate = parseDurableCandidate({
    capture: null,
    source_name: "browser",
    source_record_id: null,
    transfer_id: "old-generation-candidate",
    state: "durable-ready",
    reference: `.candidates/${"a".repeat(64)}.bin`,
    sha256: "a".repeat(64),
    size_bytes: 1,
  });
  let oldExecution!: BrowserArticleExecution;
  const open = async (input: BrowserDeliveryRequest) => {
    opened.push({ generation: input.generation!, signal: input.signal });
    const value = execution(
      input,
      () => (input.generation === 1 ? late.promise : Promise.resolve(stopped)),
      input.generation === 1 ? oldClose : undefined,
    );
    if (input.generation === 1) oldExecution = value;
    owner.attach(value);
    await owner.beforeRequest(
      navigation(input),
      input.start_url!,
      async () => {},
    );
    return value;
  };
  const first = owner.deliver(request("a", "same"), open);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(opened.map((row) => row.generation)).toEqual([1]);
    const replacement = owner.deliver(
      { ...request("a", "same"), generation: 2 },
      open,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toMatchObject({
      kind: "refused",
      code: "browser-flow-cancelled",
    });
    expect(opened[0]!.signal.aborted).toBe(true);
    expect(oldClose).toHaveBeenCalledOnce();
    late.resolve({
      kind: "candidate",
      candidate,
      accepted: true,
      lease: oldExecution,
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(opened.map((row) => row.generation)).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await replacement).toMatchObject({ kind: "exhausted" });
    expect(opened.map((row) => row.generation)).toEqual([1, 2]);
    const staleOpen = vi.fn(open);
    expect(await owner.deliver(request("a", "same"), staleOpen)).toMatchObject({
      kind: "refused",
      code: "browser-stale-generation",
    });
    expect(staleOpen).not.toHaveBeenCalled();
    expect(oldClose).toHaveBeenCalledOnce();
  } finally {
    late.resolve(stopped);
    await owner.close();
  }
});

it("overlaps two decision workers while a third article downloads, retaining its session until publication", async () => {
  const owner = new BrowserArticleScheduler({
    sessions: 5,
    workers: 2,
    platform_cooldown_ms: 0,
  });
  const first = deferred<BrowserArticleStepResult>();
  const second = deferred<BrowserArticleStepResult>();
  const downloaded = deferred<void>();
  let deciding = 0;
  let peak = 0;
  let thirdSession = "";
  let downloadDone = false;
  const closed = vi.fn(async () => undefined);
  const model =
    (gate: ReturnType<typeof deferred<BrowserArticleStepResult>>) =>
    async (input: BrowserDeliveryRequest) => {
      const value = execution(input, async () => {
        peak = Math.max(peak, ++deciding);
        try {
          return await gate.promise;
        } finally {
          deciding--;
        }
      });
      owner.attach(value);
      await owner.beforeRequest(
        navigation(input),
        input.start_url!,
        async () => undefined,
      );
      return value;
    };
  const a = owner.deliver(request("a"), model(first));
  const b = owner.deliver(request("b"), model(second));
  const c = owner.deliver(request("c"), async (input) => {
    thirdSession = input.session_identity!.session_id;
    const candidate = parseDurableCandidate({
      capture: null,
      source_name: "browser",
      source_record_id: null,
      transfer_id: "candidate-c",
      state: "durable-ready",
      reference: `.candidates/${"a".repeat(64)}.bin`,
      sha256: "a".repeat(64),
      size_bytes: 128,
    });
    const value = execution(
      input,
      async () =>
        downloadDone
          ? {
              kind: "candidate",
              accepted: true,
              candidate,
              lease: { session_id: thirdSession, close: closed },
            }
          : { kind: "suspended", transfer_id: "download-c" },
      closed,
    );
    Object.assign(value, {
      phase: () => (downloadDone ? "candidate-ready" : "downloading"),
      changed: () => downloaded.promise,
    });
    owner.attach(value);
    await owner.beforeRequest(
      navigation(input),
      input.start_url!,
      async () => undefined,
    );
    return value;
  });
  try {
    await vi.waitFor(() =>
      expect(owner.snapshot()).toMatchObject({
        sessions: 3,
        workers: 2,
        platform_active: 3,
      }),
    );
    expect(peak).toBe(2);
    expect(thirdSession).not.toBe("");
    first.resolve(stopped);
    second.resolve(stopped);
    expect((await a).kind).toBe("exhausted");
    expect((await b).kind).toBe("exhausted");
    await vi.waitFor(() => expect(owner.snapshot().workers).toBe(0));
    downloadDone = true;
    owner.networkEnded(thirdSession);
    downloaded.resolve();
    const result = await c;
    expect(result.kind).toBe("delivered");
    await vi.waitFor(() =>
      expect(owner.snapshot()).toMatchObject({
        sessions: 1,
        workers: 0,
        platform_active: 0,
      }),
    );
    expect(closed).not.toHaveBeenCalled();
    if (result.kind !== "delivered")
      throw new Error("fixture candidate missing");
    await result.lease!.close({ kind: "published", receipt_id: "receipt-c" });
    expect(closed).toHaveBeenCalledWith({
      kind: "published",
      receipt_id: "receipt-c",
    });
    expect(owner.snapshot()).toEqual({
      sessions: 0,
      queued: 0,
      workers: 0,
      platform_active: 0,
    });
  } finally {
    first.resolve(stopped);
    second.resolve(stopped);
    downloaded.resolve();
    await owner.close();
  }
});

it("does not retain a backlog from one platform or bypass its completion cooldown", async () => {
  vi.useFakeTimers();
  const owner = new BrowserArticleScheduler({ sessions: 2, workers: 2 });
  const gate = deferred<BrowserArticleStepResult>();
  const opened: string[] = [];
  const open = async (input: BrowserDeliveryRequest) => {
    opened.push(input.literature_id);
    const value = execution(input, () =>
      input.literature_id === "a" ? gate.promise : Promise.resolve(stopped),
    );
    owner.attach(value);
    await owner.beforeRequest(
      navigation(input),
      input.start_url!,
      async () => undefined,
    );
    return value;
  };
  const a = owner.deliver(request("a", "same"), open);
  const b = owner.deliver(request("b", "same"), open);
  const c = owner.deliver(request("c", "other"), open);
  await vi.advanceTimersByTimeAsync(0);
  expect(opened).toEqual(["a", "c"]);
  await c;
  gate.resolve(stopped);
  await a;
  await vi.advanceTimersByTimeAsync(29_999);
  expect(opened).toEqual(["a", "c"]);
  await vi.advanceTimersByTimeAsync(1);
  await b;
  expect(opened).toEqual(["a", "c", "b"]);
  await owner.close();
});

it("places recovery behind an older queued article instead of giving retries permanent priority", async () => {
  vi.useFakeTimers();
  const owner = new BrowserArticleScheduler({ sessions: 2, workers: 2 });
  const failedDownload = deferred<void>();
  const events: string[] = [];
  let recovery = false;
  let aId = "";
  const a = owner.deliver(request("a", "same"), async (input) => {
    aId = input.session_identity!.session_id;
    const value = execution(input, async () =>
      recovery ? stopped : { kind: "suspended", transfer_id: "a-download" },
    );
    Object.assign(value, {
      phase: () => (recovery ? "ready" : "downloading"),
      changed: () => failedDownload.promise,
      setNetworkAccess: () => {
        events.push("a-recovered");
      },
    });
    owner.attach(value);
    await owner.beforeRequest(
      navigation(input),
      input.start_url!,
      async () => undefined,
    );
    events.push("a-opened");
    return value;
  });
  const b = owner.deliver(request("b", "same"), async (input) => {
    const value = execution(input, async () => stopped);
    owner.attach(value);
    await owner.beforeRequest(
      navigation(input),
      input.start_url!,
      async () => undefined,
    );
    events.push("b-opened");
    return value;
  });
  await vi.advanceTimersByTimeAsync(0);
  owner.networkEnded(aId, { kind: "failure" });
  recovery = true;
  failedDownload.resolve();
  await vi.advanceTimersByTimeAsync(30_000);
  await b;
  expect(events).toEqual(["a-opened", "b-opened"]);
  await vi.advanceTimersByTimeAsync(30_000);
  await a;
  expect(events).toEqual(["a-opened", "b-opened", "a-recovered"]);
  await owner.close();
});

it("quarantines unproven cleanup instead of silently reusing its session capacity", async () => {
  const owner = new BrowserArticleScheduler({
    sessions: 2,
    workers: 2,
    platform_cooldown_ms: 0,
  });
  const failed = await owner.deliver(request("a", "same"), async (input) => {
    const value = execution(
      input,
      async () => stopped,
      vi.fn(async () => {
        throw new Error("synthetic cleanup failure");
      }),
    );
    owner.attach(value);
    await owner.beforeRequest(
      navigation(input),
      input.start_url!,
      async () => undefined,
    );
    return value;
  });
  expect(failed).toMatchObject({
    kind: "refused",
    code: "browser-session-cleanup-failed",
  });
  const forbidden = vi.fn(async (input: BrowserDeliveryRequest) =>
    execution(input, async () => stopped),
  );
  const blocked = await owner.deliver(request("b", "same"), forbidden);
  expect(blocked).toMatchObject({
    kind: "refused",
    code: "browser-session-cleanup-failed",
  });
  expect(forbidden).not.toHaveBeenCalled();
  expect(owner.snapshot().sessions).toBe(1);
  const unrelated = await owner.deliver(
    request("c", "other"),
    async (input) => {
      const value = execution(input, async () => stopped);
      owner.attach(value);
      return value;
    },
  );
  expect(unrelated.kind).toBe("exhausted");
  await owner.close();
});

it("projects and cancels a queued article without opening a page or cancelling its sibling", async () => {
  const queued = new Map<string, () => void>();
  const removed = vi.fn();
  const owner = new BrowserArticleScheduler({
    sessions: 1,
    workers: 1,
    onQueued: (identity, cancel) => queued.set(identity.literature_id, cancel),
    onRemoved: removed,
  });
  const hold = deferred<BrowserArticleStepResult>();
  const firstClose = vi.fn(async () => undefined);
  const first = owner.deliver(request("a"), async (input) => {
    const value = execution(input, () => hold.promise, firstClose);
    owner.attach(value);
    return value;
  });
  const secondOpen = vi.fn(async (input: BrowserDeliveryRequest) =>
    execution(input, async () => stopped),
  );
  const second = owner.deliver(request("b"), secondOpen);
  try {
    await vi.waitFor(() => expect(owner.snapshot().workers).toBe(1));
    queued.get("b")!();
    expect(await second).toMatchObject({
      kind: "refused",
      code: "browser-flow-cancelled",
    });
    expect(secondOpen).not.toHaveBeenCalled();
    expect(firstClose).not.toHaveBeenCalled();
    expect(removed).toHaveBeenCalledTimes(1);
    hold.resolve(stopped);
    expect(await first).toEqual({ kind: "exhausted" });
    expect(removed).toHaveBeenCalledTimes(2);
  } finally {
    hold.resolve(stopped);
    await owner.close();
  }
});

it("propagates article cancellation to an opening page's scheduler signal", async () => {
  const owner = new BrowserArticleScheduler({ sessions: 1, workers: 1 });
  const cancel = new AbortController();
  let admittedSignal: AbortSignal | undefined;
  const pending = owner.deliver(request("a"), async (input) => {
    admittedSignal = input.signal;
    const value = execution(input, async () => stopped);
    owner.attach(value, cancel.signal);
    await new Promise<void>((resolve) =>
      input.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return value;
  });
  try {
    await vi.waitFor(() => expect(admittedSignal).toBeDefined());
    cancel.abort();
    expect(await pending).toMatchObject({
      kind: "refused",
      code: "browser-flow-cancelled",
    });
    expect(admittedSignal?.aborted).toBe(true);
  } finally {
    cancel.abort();
    await owner.close();
  }
});

it("defers a platform retry longer than the retained lifetime without clearing its cooldown", async () => {
  vi.useFakeTimers();
  const owner = new BrowserArticleScheduler({
    sessions: 2,
    workers: 2,
    lifetime_ms: 10_000,
  });
  let session = "";
  const hold = deferred<BrowserArticleStepResult>();
  const first = owner.deliver(request("a", "publisher"), async (input) => {
    session = input.session_identity!.session_id;
    const value = execution(input, () => hold.promise);
    owner.attach(value);
    await owner.beforeRequest(
      navigation(input),
      input.start_url!,
      async () => undefined,
    );
    return value;
  });
  await vi.advanceTimersByTimeAsync(0);
  owner.rateLimited(session, 120_000);
  expect(await first).toMatchObject({
    kind: "refused",
    code: "browser-rate-limited",
  });
  const open = vi.fn(async (input: BrowserDeliveryRequest) =>
    execution(input, async () => stopped),
  );
  const second = owner.deliver(request("b", "publisher"), open);
  try {
    await vi.advanceTimersByTimeAsync(119_999);
    expect(open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toEqual({ kind: "exhausted" });
  } finally {
    hold.resolve(stopped);
    await owner.close();
  }
});

it("keeps one platform's retained files from consuming all session capacity", async () => {
  vi.useFakeTimers();
  const owner = new BrowserArticleScheduler({
    sessions: 3,
    workers: 2,
    platform_cooldown_ms: 0,
  });
  const opened: string[] = [];
  const open = async (input: BrowserDeliveryRequest) => {
    opened.push(input.literature_id);
    const value = execution(input, async () => {
      owner.networkEnded(value.session_id);
      return {
        kind: "candidate",
        accepted: true,
        candidate: parseDurableCandidate({
          capture: null,
          source_name: "browser",
          source_record_id: null,
          transfer_id: input.literature_id,
          state: "durable-ready",
          reference: `.candidates/${"a".repeat(64)}.bin`,
          sha256: "a".repeat(64),
          size_bytes: 1,
        }),
        lease: { session_id: value.session_id, close: async () => undefined },
      };
    });
    owner.attach(value);
    return value;
  };
  const first = await owner.deliver(request("a", "same"), open);
  const second = await owner.deliver(request("b", "same"), open);
  const third = owner.deliver(request("c", "same"), open);
  const other = await owner.deliver(request("d", "different"), open);
  try {
    expect(opened).toEqual(["a", "b", "d"]);
    if (
      first.kind !== "delivered" ||
      second.kind !== "delivered" ||
      other.kind !== "delivered"
    )
      throw new Error("fixture did not deliver");
    await first.lease!.close({ kind: "published", receipt_id: "a" });
    const last = await third;
    expect(last.kind).toBe("delivered");
    expect(opened).toEqual(["a", "b", "d", "c"]);
  } finally {
    await owner.close();
  }
});

it("reports a stable cleanup cause through the delivered lease while quarantining its resources", async () => {
  const removed = vi.fn();
  const owner = new BrowserArticleScheduler({
    sessions: 1,
    workers: 1,
    onRemoved: removed,
  });
  const cause = Object.assign(
    new Error("untrusted URL/details must not escape"),
    { code: "browser-platform-handoff-stalled" },
  );
  try {
    const result = await owner.deliver(request("a"), async (input) => {
      const value = execution(
        input,
        async () => ({
          kind: "candidate",
          accepted: true,
          candidate: parseDurableCandidate({
            capture: null,
            source_name: "browser",
            source_record_id: null,
            transfer_id: "a",
            state: "durable-ready",
            reference: `.candidates/${"a".repeat(64)}.bin`,
            sha256: "a".repeat(64),
            size_bytes: 1,
          }),
          lease: {
            session_id: input.session_identity!.session_id,
            close: async () => undefined,
          },
        }),
        async () => {
          throw new Error("wrapped", { cause });
        },
      );
      owner.attach(value);
      return value;
    });
    if (result.kind !== "delivered") throw new Error("fixture did not deliver");
    await expect(
      result.lease!.close({ kind: "published", receipt_id: "published-a" }),
    ).rejects.toMatchObject({
      code: "browser-platform-handoff-stalled",
      message: "Browser session cleanup failed",
    });
    expect(owner.snapshot().sessions).toBe(1);
    expect(removed).toHaveBeenCalledWith(result.lease!.session_id, {
      kind: "retained",
      code: "browser-platform-handoff-stalled",
    });
  } finally {
    await owner.close();
  }
});

it("does not open an article whose collaboration registration failed, even if close feedback also fails", async () => {
  const owner = new BrowserArticleScheduler({
    sessions: 1,
    workers: 1,
    onQueued: () => {
      throw new Error("fixture registration failure");
    },
    onRemoved: () => {
      throw new Error("fixture feedback failure");
    },
  });
  const open = vi.fn(async (input: BrowserDeliveryRequest) =>
    execution(input, async () => stopped),
  );
  try {
    expect(await owner.deliver(request("a"), open)).toMatchObject({
      kind: "refused",
      code: "browser-projection-failed",
    });
    expect(open).not.toHaveBeenCalled();
    expect(owner.snapshot()).toEqual({
      sessions: 0,
      queued: 0,
      workers: 0,
      platform_active: 0,
    });
  } finally {
    await owner.close();
  }
});

it("resumes a queued decision when its in-flight navigation acquires the platform first", async () => {
  const owner = new BrowserArticleScheduler({
    sessions: 2,
    workers: 2,
    platform_cooldown_ms: 0,
  });
  const releaseB = deferred<BrowserArticleStepResult>();
  const changedA = deferred<void>();
  const enteredA = deferred<BrowserDeliveryRequest>();
  const enteredB = deferred<void>();
  let stepsA = 0;
  let settledA = false;
  const b = owner.deliver(request("b", "destination"), async (input) => {
    const value = execution(input, () => releaseB.promise);
    owner.attach(value);
    await owner.beforeRequest(
      navigation(input),
      input.start_url!,
      async () => {},
    );
    enteredB.resolve();
    return value;
  });
  await enteredB.promise;
  const a = owner
    .deliver(request("a", "source"), async (input) => {
      const value = execution(input, async () => {
        if (++stepsA === 1) return { kind: "waiting", reason: "page" };
        return stopped;
      });
      Object.assign(value, { changed: () => changedA.promise });
      owner.attach(value);
      await owner.beforeRequest(
        navigation(input),
        input.start_url!,
        async () => {},
      );
      enteredA.resolve(input);
      return value;
    })
    .then((result) => {
      settledA = true;
      return result;
    });
  const input = await enteredA.promise;
  let transition:
    | ReturnType<BrowserArticleScheduler["beforeRequest"]>
    | undefined;
  try {
    await vi.waitFor(() => expect(stepsA).toBe(1));
    transition = owner.beforeRequest(
      {
        ...navigation(input),
        request_id: "redirect-a",
        redirected_request_id: navigation(input).request_id,
      },
      "https://destination.test/article",
      async () => {},
    );
    void transition.catch(() => undefined);
    // The network handoff is waiting for B; A becomes ready during that wait.
    await vi.waitFor(() => expect(owner.snapshot().platform_active).toBe(1));
    changedA.resolve();
    await vi.waitFor(() => expect(owner.snapshot().queued).toBe(1));
    releaseB.resolve(stopped);
    await b;
    await transition;
    await vi.waitFor(() => expect(settledA).toBe(true));
    expect(await a).toEqual({ kind: "exhausted" });
    expect(stepsA).toBe(2);
    expect(owner.snapshot()).toEqual({
      sessions: 0,
      queued: 0,
      workers: 0,
      platform_active: 0,
    });
  } finally {
    releaseB.resolve(stopped);
    changedA.resolve();
    await owner.close();
    await Promise.allSettled([a, b, ...(transition ? [transition] : [])]);
  }
});

it("settles an opening redirect waiter when its destination is quarantined without releasing the failed owner", async () => {
  const owner = new BrowserArticleScheduler({
    sessions: 2,
    workers: 2,
    platform_cooldown_ms: 0,
  });
  const fail = deferred<BrowserArticleStepResult>();
  const aOpened = deferred<void>();
  const bWaiting = deferred<void>();
  let bSettled = false;
  const a = owner.deliver(request("a", "same"), async (input) => {
    const value = execution(
      input,
      () => fail.promise,
      async () => {
        throw new Error("Unconfirmed cleanup");
      },
    );
    owner.attach(value);
    await owner.beforeRequest(
      navigation(input),
      input.start_url!,
      async () => {},
    );
    aOpened.resolve();
    return value;
  });
  await aOpened.promise;
  const b = owner
    .deliver(request("b", "transit"), async (input) => {
      const value = execution(input, async () => stopped);
      owner.attach(value);
      await owner.beforeRequest(
        navigation(input),
        input.start_url!,
        async () => {},
      );
      bWaiting.resolve();
      await owner.beforeRequest(
        {
          ...navigation(input),
          request_id: "b-redirect",
          redirected_request_id: navigation(input).request_id,
        },
        "https://same.test/article",
        async () => {},
      );
      return value;
    })
    .then((result) => {
      bSettled = true;
      return result;
    });
  try {
    await bWaiting.promise;
    await vi.waitFor(() => expect(owner.snapshot().platform_active).toBe(1));
    fail.resolve(stopped);
    expect(await a).toMatchObject({
      kind: "refused",
      code: "browser-session-cleanup-failed",
    });
    await vi.waitFor(() => expect(bSettled).toBe(true));
    expect(await b).toMatchObject({
      kind: "refused",
      code: "browser-session-cleanup-failed",
    });
    expect(owner.snapshot()).toMatchObject({
      sessions: 1,
      platform_active: 1,
      queued: 0,
    });
    expect(
      await owner.deliver(request("c", "other"), async (input) =>
        execution(input, async () => stopped),
      ),
    ).toEqual({ kind: "exhausted" });
  } finally {
    fail.resolve(stopped);
    await owner.close();
    await Promise.all([a, b]);
  }
});
