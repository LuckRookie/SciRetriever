import { expect, it, vi } from "vitest";
import {
  parseArtifactRef,
  parseDurableCandidate,
} from "@sciretriever/contracts";
import { BrowserArticleScheduler } from "../src/entry/browser-scheduler.js";
import {
  BrowserArticleClock,
  type BrowserArticleExecution,
  type BrowserArticleStepResult,
} from "../src/browser/article-session.js";
import type { BrowserDeliveryRequest } from "../src/browser/boundary.js";

function request(id: string): BrowserDeliveryRequest {
  return {
    literature_id: id,
    identifier: `doi:10.1000/runtime-${id}`,
    version: "published",
    start_url: `https://${id}.test/article`,
    metadata_snapshot: {
      revision: 1,
      sha256: parseArtifactRef({
        sha256: "a".repeat(64),
        byte_size: 1,
        media_type: "application/pdf",
      }).sha256,
    },
    signal: new AbortController().signal,
    operation_id: "runtime-loss-fixture",
    generation: 1,
  };
}

function execution(
  input: BrowserDeliveryRequest,
  step: () => Promise<BrowserArticleStepResult>,
  close: BrowserArticleExecution["close"],
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

it("wakes model, changed and queued work with a stable runtime loss while preserving the delivered publication lease", async () => {
  const removed = vi.fn();
  const owner = new BrowserArticleScheduler({
    sessions: 3,
    workers: 2,
    onRemoved: removed,
  });
  const candidate = parseDurableCandidate({
    capture: null,
    source_name: "browser",
    source_record_id: null,
    transfer_id: "delivered-before-runtime-loss",
    state: "durable-ready",
    reference: `.candidates/${"a".repeat(64)}.bin`,
    sha256: "a".repeat(64),
    size_bytes: 128,
  });
  const publishedClose = vi.fn(async () => undefined);
  let deliveredSignal: AbortSignal | undefined;
  const delivered = await owner.deliver(request("delivered"), async (input) => {
    deliveredSignal = input.signal;
    const value = execution(
      input,
      async () => ({
        kind: "candidate",
        candidate,
        accepted: true,
        lease: {
          session_id: input.session_identity!.session_id,
          close: publishedClose,
        },
      }),
      publishedClose,
    );
    owner.attach(value);
    return value;
  });
  const signals: AbortSignal[] = [];
  const closes = vi.fn(async () => undefined);
  let stepAborted = false;
  let changedWaiting = false;
  let changedAborted = false;
  const model = owner.deliver(request("model"), async (input) => {
    signals.push(input.signal);
    const value = execution(
      input,
      () =>
        new Promise<BrowserArticleStepResult>((_resolve, reject) => {
          input.signal.addEventListener(
            "abort",
            () => {
              stepAborted = true;
              reject(new Error("model aborted"));
            },
            { once: true },
          );
        }),
      closes,
    );
    owner.attach(value);
    return value;
  });
  const waiting = owner.deliver(request("waiting"), async (input) => {
    signals.push(input.signal);
    const value = execution(
      input,
      async () => ({ kind: "suspended", transfer_id: "background-transfer" }),
      closes,
    );
    Object.assign(value, {
      phase: () => "downloading",
      changed: (signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          changedWaiting = true;
          signal.addEventListener(
            "abort",
            () => {
              changedAborted = true;
              reject(new Error("changed aborted"));
            },
            { once: true },
          );
        }),
    });
    owner.attach(value);
    return value;
  });
  const queuedOpen = vi.fn(async (input: BrowserDeliveryRequest) =>
    execution(
      input,
      async () => ({ kind: "terminal", result: { kind: "exhausted" } }),
      closes,
    ),
  );
  const queued = owner.deliver(request("queued"), queuedOpen);
  try {
    await vi.waitFor(() => {
      expect(changedWaiting).toBe(true);
      expect(owner.snapshot()).toMatchObject({
        sessions: 3,
        queued: 1,
        workers: 1,
      });
    });
    owner.runtimeLost();
    owner.runtimeLost();
    const results = await Promise.all([model, waiting, queued]);
    for (const result of results)
      expect(result).toMatchObject({
        kind: "refused",
        code: "browser-runtime-lost",
      });
    expect(stepAborted).toBe(true);
    expect(changedAborted).toBe(true);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(queuedOpen).not.toHaveBeenCalled();
    expect(closes).toHaveBeenCalledTimes(2);
    expect(publishedClose).not.toHaveBeenCalled();
    expect(deliveredSignal?.aborted).toBe(false);
    expect(delivered).toMatchObject({ kind: "delivered", candidate });
    const laterOpen = vi.fn(queuedOpen);
    expect(await owner.deliver(request("later"), laterOpen)).toMatchObject({
      kind: "refused",
      code: "browser-runtime-lost",
    });
    expect(laterOpen).not.toHaveBeenCalled();
    if (delivered.kind !== "delivered")
      throw new Error("fixture did not deliver");
    await delivered.lease!.close({
      kind: "published",
      receipt_id: "published-after-runtime-loss",
    });
    expect(publishedClose).toHaveBeenCalledOnce();
    expect(publishedClose).toHaveBeenCalledWith({
      kind: "published",
      receipt_id: "published-after-runtime-loss",
    });
    await vi.waitFor(() =>
      expect(owner.snapshot()).toEqual({
        sessions: 0,
        queued: 0,
        workers: 0,
        platform_active: 0,
      }),
    );
    expect(removed).toHaveBeenCalledTimes(4);
  } finally {
    await owner.close();
  }
});
