import { expect, it, vi } from "vitest";
import { sha256 } from "@sciretriever/contracts";
import { BrowserArticleScheduler } from "../src/entry/browser-scheduler.js";
import {
  BrowserArticleClock,
  type BrowserArticleExecution,
  type BrowserArticleStepResult,
} from "../src/browser/article-session.js";
import type { BrowserDeliveryRequest } from "../src/browser/boundary.js";
import type { BrowserOwnedRequest } from "../src/browser/cdp-owner.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const stopped = { kind: "terminal", result: { kind: "exhausted" } } as const;
async function fixture(
  committed = true,
  options: Partial<
    Pick<
      BrowserArticleExecution,
      "phase" | "step" | "changed" | "preparationTarget" | "navigationFailed"
    >
  > = {},
  entries?: readonly string[],
) {
  const owner = new BrowserArticleScheduler({
    sessions: 2,
    workers: 1,
    platform_cooldown_ms: 0,
  });
  const finish = deferred<BrowserArticleStepResult>();
  const opened = deferred<BrowserOwnedRequest>();
  const clock = new BrowserArticleClock();
  const input: BrowserDeliveryRequest = {
    literature_id: "article-a",
    identifier: "doi:10.1/a",
    version: "published",
    metadata_snapshot: { revision: 1, sha256: await sha256(new Uint8Array()) },
    start_url: "https://publisher-a.test/article",
    ...(entries ? { start_urls: entries } : {}),
    operation_id: "fixture",
    generation: 1,
    signal: new AbortController().signal,
  };
  const delivery = owner.deliver(input, async (bound) => {
    const identity = bound.session_identity!;
    const execution: BrowserArticleExecution = {
      identity,
      session_id: identity.session_id,
      clock,
      phase: () => "ready",
      step: () => finish.promise,
      changed: async () => {},
      transferStarted: () => {},
      transferCompleted: () => {},
      transferFailed: () => {},
      candidateRejected: () => {},
      candidateReady: () => {},
      controlEpochChanged: () => {},
      cancel: () => {},
      rateLimited: () => {},
      setNetworkAccess: () => {},
      close: async () => {},
      ...options,
    };
    owner.attach(execution);
    const request: BrowserOwnedRequest = {
      ...identity,
      page_id: "page-a",
      frame_id: "frame-a",
      document_generation: 0,
      signal: bound.signal,
      request_id: "navigation-a",
      request_method: "GET",
      resource_type: "document",
      is_navigation: true,
      document_id: "document-a",
      parent_document_id: null,
      source_document_id: null,
      redirected_request_id: null,
    };
    await owner.beforeRequest(request, bound.start_url!, async () => {});
    if (committed) commit(owner, request, 1);
    opened.resolve({ ...request, document_generation: committed ? 1 : 0 });
    return execution;
  });
  const binding = await opened.promise;
  return {
    owner,
    binding,
    clock,
    close: async () => {
      finish.resolve(stopped);
      await delivery;
      await owner.close();
    },
  };
}
function commit(
  owner: BrowserArticleScheduler,
  request: BrowserOwnedRequest,
  generation: number,
) {
  owner.documentCommitted({
    ...request,
    document_id: request.document_id!,
    document_generation: generation,
    is_main: true,
    navigation_request_id: request.request_id,
  });
}
function subrequest(
  binding: BrowserOwnedRequest,
  request = "subrequest",
): BrowserOwnedRequest {
  return {
    ...binding,
    request_id: request,
    resource_type: "fetch",
    is_navigation: false,
    source_document_id: binding.document_id,
  };
}

it("retains only the proven source for fresh admission after a superseding PDF candidate is rejected", async () => {
  const changed = deferred<void>();
  const terminal = deferred<BrowserArticleStepResult>();
  const entered = deferred<void>();
  const drain = deferred<{ readonly kind: "retry-navigation" }>();
  let phase: "ready" | "candidate-ready" = "ready";
  let steps = 0;
  const f = await fixture(true, {
    phase: () => phase,
    step: async () =>
      ++steps === 1 ? { kind: "waiting", reason: "page" } : terminal.promise,
    changed: () => changed.promise,
  });
  const b = {
    ...f.binding,
    request_id: "canceled-b",
    document_id: "document-b",
    source_document_id: "document-a",
  };
  try {
    await vi.waitFor(() => expect(steps).toBe(1));
    f.clock.recordModelDispatch();
    f.clock.recordAgentAction();
    const counters = f.clock.snapshot();
    const transition = f.owner.beforeRequest(
      b,
      "https://publisher-b.test/article",
      async () => {
        entered.resolve();
        return drain.promise;
      },
    );
    const superseded = expect(transition).rejects.toThrow(
      "browser-navigation-superseded-by-transfer",
    );
    await entered.promise;
    phase = "candidate-ready";
    f.owner.networkEnded(f.binding.session_id);
    drain.resolve({ kind: "retry-navigation" });
    await superseded;
    f.owner.navigationRetryFailed(b);
    expect(f.owner.snapshot().sessions).toBe(1);
    expect(f.owner.snapshot().platform_active).toBe(0);
    await expect(
      f.owner.beforeRequest(
        subrequest(f.binding),
        "https://publisher-a.test/background",
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
    // Candidate rejection wakes the retained execution; the broker restores its
    // original platform before the same source may start another GET.
    phase = "ready";
    changed.resolve();
    await vi.waitFor(() => expect(f.owner.snapshot().platform_active).toBe(1));
    await vi.waitFor(() => expect(steps).toBe(2));
    const restored = {
      ...f.binding,
      request_id: "retry-source-a",
      document_id: "document-a-2",
      source_document_id: "document-a",
    };
    await f.owner.beforeRequest(
      restored,
      "https://publisher-a.test/next",
      async () => {},
    );
    expect(f.clock.snapshot()).toMatchObject({
      model_calls: counters.model_calls,
      actions: counters.actions,
    });
    commit(f.owner, restored, 2);
    await expect(
      f.owner.beforeRequest(
        subrequest(f.binding, "stale-background"),
        "https://publisher-a.test/background",
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
  } finally {
    terminal.resolve(stopped);
    await f.close();
  }
});

it("refuses old queued and newly created document requests between B admission and B commit", async () => {
  const f = await fixture();
  const drain = deferred<void>();
  const b: BrowserOwnedRequest = {
    ...f.binding,
    request_id: "navigation-b",
    document_id: "document-b",
    source_document_id: "document-a",
  };
  const allowed: string[] = [];
  try {
    const transition = f.owner.beforeRequest(
      b,
      "https://publisher-b.test/article",
      () => drain.promise,
    );
    const queued = f.owner
      .beforeRequest(
        subrequest(f.binding, "old-queued"),
        "https://cdn.test/a",
        async () => {},
      )
      .then(() => allowed.push("old-queued"));
    const rejectedQueued = expect(queued).rejects.toThrow(
      "browser-session-network-inactive",
    );
    drain.resolve();
    await transition;
    await rejectedQueued;
    await expect(
      f.owner.beforeRequest(
        subrequest(f.binding, "old-after-admission"),
        "https://cdn.test/a",
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
    await expect(
      f.owner.beforeRequest(
        f.binding,
        "https://publisher-a.test/background",
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
    f.owner.documentCommitted({
      ...b,
      document_id: "document-b",
      document_generation: 2,
      is_main: true,
      navigation_request_id: "unrelated-navigation",
    });
    await expect(
      f.owner.beforeRequest(
        subrequest({ ...b, document_generation: 2 }),
        "https://cdn.test/b",
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
    commit(f.owner, b, 2);
    await f.owner.beforeRequest(
      subrequest({ ...b, document_generation: 2 }, "new-b"),
      "https://cdn.test/b",
      async () => {},
    );
    allowed.push("new-b");
    const iframe = {
      ...subrequest(b, "new-frame"),
      resource_type: "document",
      frame_id: "frame-child",
      document_id: "document-child",
      parent_document_id: "document-b",
    };
    await f.owner.beforeRequest(
      iframe,
      "https://embed.test/frame",
      async () => {},
    );
    allowed.push("new-frame");
    await f.owner.beforeRequest(
      { ...iframe, request_id: "frame-fetch", resource_type: "fetch" },
      "https://cdn.test/frame-data",
      async () => {},
    );
    allowed.push("frame-fetch");
    expect(allowed).toEqual(["new-b", "new-frame", "frame-fetch"]);
  } finally {
    await f.close();
  }
});

it("does not revive an old B document while a later navigation reacquires B", async () => {
  const f = await fixture();
  try {
    const popup = {
      ...f.binding,
      page_id: "popup-b",
      frame_id: "popup-b",
      request_id: "popup-b-navigation",
      document_id: "popup-b-document",
      source_document_id: "document-a",
    };
    await f.owner.beforeRequest(
      popup,
      "https://publisher-b.test/article",
      async () => {},
    );
    commit(f.owner, popup, 1);
    const a = {
      ...popup,
      request_id: "popup-a-navigation",
      document_id: "popup-a-document",
      source_document_id: "popup-b-document",
      document_generation: 1,
    };
    await f.owner.beforeRequest(
      a,
      "https://publisher-a.test/article",
      async () => {},
    );
    commit(f.owner, a, 2);
    const b = {
      ...a,
      request_id: "new-b-navigation",
      document_id: "new-b-document",
      source_document_id: "popup-a-document",
      document_generation: 2,
    };
    await f.owner.beforeRequest(
      b,
      "https://publisher-b.test/article",
      async () => {},
    );
    await expect(
      f.owner.beforeRequest(
        subrequest(popup),
        "https://cdn.test/old-b",
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
    commit(f.owner, b, 3);
    await f.owner.beforeRequest(
      subrequest({ ...b, document_generation: 3 }),
      "https://cdn.test/new-b",
      async () => {},
    );
  } finally {
    await f.close();
  }
});

it("allows only the exact redirect chain and ignores a superseded commit", async () => {
  const f = await fixture();
  try {
    const b = {
      ...f.binding,
      request_id: "navigation-b",
      document_id: "document-b",
      source_document_id: "document-a",
    };
    await f.owner.beforeRequest(
      b,
      "https://publisher-b.test/redirect",
      async () => {},
    );
    const c = {
      ...b,
      request_id: "navigation-c",
      document_id: "document-c",
      redirected_request_id: "navigation-b",
    };
    await f.owner.beforeRequest(
      c,
      "https://publisher-c.test/article",
      async () => {},
    );
    commit(f.owner, b, 2);
    await expect(
      f.owner.beforeRequest(
        subrequest(b),
        "https://cdn.test/obsolete-b",
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
    commit(f.owner, c, 2);
    await f.owner.beforeRequest(
      subrequest({ ...c, document_generation: 2 }),
      "https://cdn.test/c",
      async () => {},
    );
  } finally {
    await f.close();
  }
});

it("admits a first-response native PDF without requiring commit and revokes its old background document", async () => {
  const f = await fixture();
  try {
    const pdf = {
      ...f.binding,
      page_id: "pdf-popup",
      frame_id: "pdf-popup",
      request_id: "native-pdf",
      document_id: null,
      source_document_id: "document-a",
    };
    await f.owner.beforeRequest(
      pdf,
      "https://publisher-b.test/paper.pdf",
      async () => {},
    );
    expect(f.owner.snapshot().platform_active).toBe(1);
    await expect(
      f.owner.beforeRequest(
        subrequest(f.binding),
        "https://publisher-a.test/background",
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
    f.owner.networkEnded(f.binding.session_id);
    commit(f.owner, { ...pdf, document_id: "late-document" }, 1);
    await expect(
      f.owner.beforeRequest(
        subrequest({ ...pdf, document_id: "late-document" }),
        "https://cdn.test/late",
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
    expect(f.owner.snapshot().platform_active).toBe(0);
  } finally {
    await f.close();
  }
});

it("reacquires the original platform only after an explicit parent or history document action", async () => {
  const f = await fixture();
  try {
    const b = {
      ...f.binding,
      request_id: "navigation-b",
      document_id: "document-b",
      source_document_id: "document-a",
    };
    await f.owner.beforeRequest(
      b,
      "https://publisher-b.test/article",
      async () => {},
    );
    commit(f.owner, b, 2);
    await expect(
      f.owner.beforeRequest(
        subrequest(f.binding),
        "https://publisher-a.test/background",
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
    await expect(
      f.owner.resumeDocument(
        {
          ...f.binding,
          document_id: "unknown-document",
          is_main: true,
          navigation_request_id: null,
        },
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
    await f.owner.resumeDocument(
      {
        ...f.binding,
        document_id: "document-a",
        document_generation: 3,
        is_main: true,
        navigation_request_id: null,
        is_history_navigation: true,
      },
      async () => {},
    );
    await f.owner.beforeRequest(
      subrequest({ ...f.binding, document_generation: 3 }),
      "https://cdn.test/resumed-a",
      async () => {},
    );
    await expect(
      f.owner.beforeRequest(
        subrequest({ ...b, document_generation: 2 }),
        "https://publisher-b.test/background",
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
  } finally {
    await f.close();
  }
});

it("allows a controlled retry only after the exact failed navigation ends and only for its admitted URL", async () => {
  const f = await fixture();
  try {
    const b = {
      ...f.binding,
      request_id: "navigation-b",
      document_id: "document-b",
      source_document_id: "document-a",
    };
    await f.owner.beforeRequest(
      b,
      "https://publisher-b.test/article",
      async () => {},
    );
    const retry = {
      ...b,
      request_id: "retry-b",
      document_id: "retry-document-b",
    };
    await expect(
      f.owner.beforeRequest(
        retry,
        "https://publisher-b.test/article",
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
    f.owner.requestEnded(b);
    await expect(
      f.owner.beforeRequest(
        retry,
        "https://publisher-b.test/other",
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
    await f.owner.beforeRequest(
      retry,
      "https://publisher-b.test/article",
      async () => {},
    );
    await expect(
      f.owner.beforeRequest(
        subrequest(f.binding),
        "https://publisher-a.test/background",
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
    commit(f.owner, retry, 2);
    await f.owner.beforeRequest(
      subrequest({ ...retry, document_generation: 2 }),
      "https://cdn.test/new-b",
      async () => {},
    );
  } finally {
    await f.close();
  }
});

it("recognizes an initial browser redirect or HSTS hop by the same exact navigation loader", async () => {
  const f = await fixture(false);
  try {
    const hop = {
      ...f.binding,
      request_id: "initial-redirect",
      source_document_id: null,
      redirected_request_id: null,
    };
    await expect(
      f.owner.beforeRequest(
        { ...hop, document_id: "unrelated-loader" },
        "https://publisher-b.test/article",
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
    await f.owner.beforeRequest(
      hop,
      "https://publisher-b.test/article",
      async () => {},
    );
    commit(f.owner, hop, 1);
    await f.owner.beforeRequest(
      subrequest({ ...hop, document_generation: 1 }),
      "https://cdn.test/data",
      async () => {},
    );
  } finally {
    await f.close();
  }
});

it("hands an explicit pre-model alternate to the existing platform lease owner after an uncommitted failure", async () => {
  const initial = "https://publisher-a.test/article";
  const alternate = "https://publisher-b.test/article?version=2";
  let target: string | null = alternate;
  const f = await fixture(false, { preparationTarget: () => target }, [
    initial,
    alternate,
  ]);
  const drain = deferred<void>();
  const entered = deferred<void>();
  const exclude = vi.spyOn(f.clock, "exclude");
  const b: BrowserOwnedRequest = {
    ...f.binding,
    request_id: "prepared-b",
    document_id: "document-b",
    source_document_id: null,
  };
  try {
    f.owner.requestEnded(f.binding);
    const admitted = f.owner.beforeRequest(b, alternate, async () => {
      entered.resolve();
      await drain.promise;
    });
    await entered.promise;
    expect(exclude).toHaveBeenCalledOnce();
    expect(f.owner.snapshot().platform_active).toBe(1);
    drain.resolve();
    await admitted;
    target = null;
    expect(f.owner.snapshot().platform_active).toBe(1);
    commit(f.owner, b, 1);
    await f.owner.beforeRequest(
      subrequest({ ...b, document_generation: 1 }),
      "https://publisher-b.test/document-resource",
      async () => {},
    );
    await expect(
      f.owner.beforeRequest(
        subrequest(f.binding),
        "https://publisher-a.test/obsolete-resource",
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
    expect(f.clock.snapshot()).toMatchObject({ model_calls: 0, actions: 0 });
  } finally {
    drain.resolve();
    exclude.mockRestore();
    await f.close();
  }
});

it.each([
  "unlisted-target",
  "different-target",
  "no-target",
  "after-model",
  "post",
  "iframe",
  "subresource",
  "legacy-request",
] as const)(
  "refuses preparation authority for %s without a committed source",
  async (scenario) => {
    const initial = "https://publisher-a.test/article";
    const alternate = "https://publisher-b.test/article?version=2";
    const target =
      scenario === "different-target"
        ? initial
        : scenario === "no-target"
          ? null
          : alternate;
    const f = await fixture(
      false,
      { preparationTarget: () => target },
      scenario === "legacy-request"
        ? undefined
        : scenario === "unlisted-target"
          ? [initial]
          : [initial, alternate],
    );
    const drain = vi.fn(async () => {});
    const b: BrowserOwnedRequest = {
      ...f.binding,
      request_id: "unproven-b",
      document_id: "document-b",
      source_document_id: null,
      request_method: scenario === "post" ? "POST" : "GET",
      parent_document_id: scenario === "iframe" ? "uncommitted-parent" : null,
      is_navigation: scenario !== "subresource",
      resource_type: scenario === "subresource" ? "fetch" : "document",
    };
    try {
      f.owner.requestEnded(f.binding);
      if (scenario === "after-model") f.clock.recordModelDispatch();
      await expect(f.owner.beforeRequest(b, alternate, drain)).rejects.toThrow(
        "browser-document-network-inactive",
      );
      expect(drain).not.toHaveBeenCalled();
      expect(f.owner.snapshot().platform_active).toBe(1);
    } finally {
      await f.close();
    }
  },
);

it("retains failed navigation for feedback without inventing old-document network grants", async () => {
  const navigationFailed = vi.fn();
  const f = await fixture(true, { navigationFailed });
  const next = {
    ...f.binding,
    request_id: "failed-navigation",
    source_document_id: "document-a",
    document_id: "document-b",
  };
  try {
    await expect(
      f.owner.beforeRequest(
        next,
        "https://publisher-b.test/reader",
        async () => {
          throw new Error("synthetic-drain-failure");
        },
      ),
    ).rejects.toThrow("synthetic-drain-failure");
    f.owner.navigationRetryFailed({ ...next, operation_id: "other-operation" });
    expect(navigationFailed).not.toHaveBeenCalled();
    f.owner.navigationRetryFailed(next);
    expect(navigationFailed).toHaveBeenCalledOnce();
    expect(f.owner.snapshot().sessions).toBe(1);
    await expect(
      f.owner.beforeRequest(
        subrequest(f.binding),
        "https://publisher-a.test/background",
        async () => {},
      ),
    ).rejects.toThrow("browser-document-network-inactive");
    await f.owner.resumeDocument(
      {
        ...f.binding,
        document_id: "document-a",
        document_generation: 1,
        is_main: true,
        navigation_request_id: null,
      },
      async () => {},
    );
    await expect(
      f.owner.beforeRequest(
        subrequest(f.binding),
        "https://publisher-a.test/background",
        async () => {},
      ),
    ).resolves.toBeUndefined();
  } finally {
    await f.close();
  }
});
