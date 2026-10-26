import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  BrowserCdpOwner,
  type BrowserCdpOwnerOptions,
  type BrowserNativeDownload,
  type BrowserOwnedRequest,
  type BrowserPageOwnership,
} from "../src/browser/cdp-owner.js";
import {
  BrowserProtocolError,
  type BrowserProtocol,
  type BrowserProtocolEvent,
} from "../src/browser/cdp.js";
import { BrowserTransferDispatcher } from "../src/browser/transfers.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Protocol implements BrowserProtocol {
  readonly calls: {
    method: string;
    params: Readonly<Record<string, unknown>>;
    session: string | undefined;
  }[] = [];
  private readonly listeners = new Map<
    string,
    Set<(event: BrowserProtocolEvent) => void>
  >();
  result: (
    method: string,
    params: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>> = () => ({});
  async send(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    session?: string,
    _timeout?: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.calls.push({ method, params, session });
    if (signal?.aborted) throw new BrowserProtocolError("command-cancelled");
    const result = this.result(method, params);
    if (!signal) return result;
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(new BrowserProtocolError("command-cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      void Promise.resolve(result).then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }
  on(
    method: string,
    listener: (event: BrowserProtocolEvent) => void,
  ): () => void {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
    };
  }
  emit(
    method: string,
    params: Readonly<Record<string, unknown>>,
    session?: string,
  ): void {
    for (const listener of this.listeners.get(method) ?? [])
      listener({ params, session_id: session });
  }
  request(
    id: string,
    frame: string,
    resource = "Document",
    url = "http://127.0.0.1/same",
    loader = "loader-" + frame,
    method = "GET",
    networkResource = resource,
  ): void {
    this.emit(
      "Network.requestWillBeSent",
      {
        requestId: "network-" + id,
        frameId: frame,
        loaderId: loader,
        type: networkResource,
      },
      "protocol-" + (frame === "child-frame" ? "a" : frame),
    );
    this.emit("Fetch.requestPaused", {
      requestId: id,
      frameId: frame,
      resourceType: resource,
      networkId: "network-" + id,
      request: { url, method },
    });
  }
  response(
    id: string,
    status: number,
    headers: Record<string, string> = {},
  ): void {
    this.emit("Fetch.requestPaused", {
      requestId: id,
      responseStatusCode: status,
      responseHeaders: Object.entries(headers).map(([name, value]) => ({
        name,
        value,
      })),
    });
  }
  attach(target: string, opener?: string): void {
    this.emit("Target.attachedToTarget", {
      sessionId: "protocol-" + target,
      targetInfo: {
        targetId: target,
        type: "page",
        ...(opener ? { openerId: opener } : {}),
      },
    });
  }
}
function page(target: string, session: string): BrowserPageOwnership {
  return {
    page_id: target,
    session_id: session,
    operation_id: "operation-" + session,
    generation: 1,
    document_generation: 0,
    signal: new AbortController().signal,
  };
}
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture(overrides: Partial<BrowserCdpOwnerOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sciretriever-cdp-owner-"));
  directories.push(directory);
  const protocol = new Protocol();
  const pages = new Map([
    ["a", page("a", "session-a")],
    ["b", page("b", "session-b")],
  ]);
  const owner = new BrowserCdpOwner({
    protocol,
    downloads_directory: directory,
    targetCreated: (target, opener) => {
      const parent = opener ? pages.get(opener) : undefined;
      if (parent) pages.set(target, { ...parent, page_id: target });
    },
    resolvePage: (target) => pages.get(target) ?? null,
    beforeRequest: async () => {},
    admitted: () => {},
    blocked: () => {},
    failure: () => {},
    ...overrides,
  });
  await owner.start();
  protocol.attach("a");
  protocol.attach("b");
  await owner.ready("a");
  await owner.ready("b");
  return { owner, protocol, pages, directory };
}

async function oldFetchFixture(
  overrides: Partial<BrowserCdpOwnerOptions> = {},
) {
  const result = await fixture(overrides);
  const { protocol, pages } = result;
  const abort = new AbortController();
  pages.set("a", { ...pages.get("a")!, signal: abort.signal });
  protocol.emit(
    "Page.frameNavigated",
    { frame: { id: "a", loaderId: "document-a" } },
    "protocol-a",
  );
  protocol.emit(
    "Runtime.executionContextCreated",
    {
      context: {
        id: 41,
        auxData: { frameId: "a", isDefault: true },
      },
    },
    "protocol-a",
  );
  protocol.request(
    "old-fetch",
    "a",
    "XHR",
    "http://127.0.0.1/response",
    "document-a",
    "GET",
    "Fetch",
  );
  await vi.waitFor(() =>
    expect(protocol.calls).toContainEqual(
      expect.objectContaining({
        method: "Fetch.continueRequest",
        params: { requestId: "old-fetch", interceptResponse: true },
      }),
    ),
  );
  const replace = () => {
    protocol.emit("Runtime.executionContextsCleared", {}, "protocol-a");
    protocol.emit(
      "Page.frameNavigated",
      { frame: { id: "a", loaderId: "document-a2" } },
      "protocol-a",
    );
  };
  return { ...result, abort, replace };
}

it.each([
  ["eof", "text/plain"],
  ["stop-session", "text/plain"],
  ["abort", "text/plain"],
  ["eof", "application/pdf"],
  ["stop-session", "application/pdf"],
  ["abort", "application/pdf"],
] as const)(
  "drains an original late old-document response with bounded IO and confirms its %s (%s)",
  async (terminal, mime) => {
    const ended = vi.fn();
    const failure = vi.fn();
    const pdfResponse = vi.fn();
    const body = deferred<Record<string, unknown>>();
    const { owner, protocol, abort, replace } = await oldFetchFixture({
      ended,
      failure,
      pdfResponse,
    });
    let reads = 0;
    protocol.result = (method) => {
      if (method === "Fetch.takeResponseBodyAsStream")
        return { stream: "original-response" };
      if (method === "IO.read")
        return reads++ === 0 ? { data: "partial", eof: false } : body.promise;
      return {};
    };
    replace();
    expect(ended).not.toHaveBeenCalled();
    protocol.response("old-fetch", 200, { "content-type": mime });
    await vi.waitFor(() => expect(reads).toBe(2));
    let drained = false;
    const drain = owner.drainSession("session-a").then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(ended).not.toHaveBeenCalled();
    expect(protocol.calls).not.toContainEqual(
      expect.objectContaining({ method: "Fetch.continueResponse" }),
    );
    expect(protocol.calls.filter((call) => call.method === "IO.read")).toEqual([
      expect.objectContaining({
        params: { handle: "original-response", size: 65536 },
      }),
      expect.objectContaining({
        params: { handle: "original-response", size: 65536 },
      }),
    ]);
    if (terminal === "eof") body.resolve({ data: "tail", eof: true });
    else if (terminal === "stop-session") await owner.stopSession("session-a");
    else abort.abort();
    await drain;
    expect(pdfResponse).not.toHaveBeenCalled();
    expect(ended).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ request_id: "old-fetch" }),
    );
    await vi.waitFor(() =>
      expect(protocol.calls).toContainEqual(
        expect.objectContaining({
          method: "IO.close",
          params: { handle: "original-response" },
        }),
      ),
    );
    expect(
      protocol.calls.filter((call) => call.method === "Fetch.failRequest"),
    ).toEqual([
      expect.objectContaining({
        params: { requestId: "old-fetch", errorReason: "Aborted" },
      }),
    ]);
    // Explicit cancellation stops a pending ordinary read without waiting for
    // the transport's idle timeout. It does not turn a partial body into EOF.
    await vi.waitFor(() =>
      expect((Reflect.get(owner, "pending") as Set<unknown>).size).toBe(0),
    );
    expect(failure).not.toHaveBeenCalled();
    owner.dispose();
  },
);

it.each([
  ["Network.loadingFinished", "network-first", "eof"],
  ["Network.loadingFailed", "network-first", "stop-session"],
  ["Network.loadingFinished", "destroy-first", "stop-session"],
  ["Network.loadingFailed", "destroy-first", "eof"],
] as const)(
  "keeps managed response IO live through %s and target destruction (%s, %s)",
  async (networkTerminal, order, completion) => {
    const ended = vi.fn();
    const failure = vi.fn();
    const body = deferred<Record<string, unknown>>();
    const closed = deferred<Record<string, unknown>>();
    const canceled = deferred<Record<string, unknown>>();
    const { owner, protocol, replace } = await oldFetchFixture({
      ended,
      failure,
    });
    let reads = 0;
    protocol.result = (method) => {
      if (method === "Fetch.takeResponseBodyAsStream")
        return { stream: "owned-original-response" };
      if (method === "IO.read")
        return reads++ === 0 ? { data: "partial", eof: false } : body.promise;
      if (method === "IO.close") return closed.promise;
      if (method === "Fetch.failRequest")
        return canceled.promise.then(() => {
          throw new BrowserProtocolError("request-inactive");
        });
      return {};
    };
    replace();
    protocol.response("old-fetch", 200, { "content-type": "text/plain" });
    await vi.waitFor(() => expect(reads).toBe(2));
    let drained = false;
    const drain = owner.drainSession("session-a").then(() => {
      drained = true;
    });
    const networkEnd = () =>
      protocol.emit(
        networkTerminal,
        { requestId: "network-old-fetch" },
        "protocol-a",
      );
    const destroyed = () =>
      protocol.emit("Target.targetDestroyed", { targetId: "a" });
    if (order === "network-first") {
      networkEnd();
      destroyed();
    } else {
      destroyed();
      networkEnd();
    }
    await Promise.resolve();
    expect(ended).not.toHaveBeenCalled();
    expect(drained).toBe(false);

    let stop: Promise<void> | undefined;
    if (completion === "eof") body.resolve({ data: "tail", eof: true });
    else stop = owner.stopSession("session-a", false);
    await vi.waitFor(() =>
      expect(protocol.calls).toContainEqual(
        expect.objectContaining({
          method: "IO.close",
          params: { handle: "owned-original-response" },
        }),
      ),
    );
    expect(ended).not.toHaveBeenCalled();
    expect(drained).toBe(false);
    closed.resolve({});
    await vi.waitFor(() =>
      expect(protocol.calls).toContainEqual(
        expect.objectContaining({
          method: "Fetch.failRequest",
          params: { requestId: "old-fetch", errorReason: "Aborted" },
        }),
      ),
    );
    expect(ended).not.toHaveBeenCalled();
    expect(drained).toBe(false);
    canceled.resolve({});
    await Promise.all([stop, drain]);
    expect(ended).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ request_id: "old-fetch" }),
    );
    await vi.waitFor(() =>
      expect((Reflect.get(owner, "pending") as Set<unknown>).size).toBe(0),
    );
    expect(failure).not.toHaveBeenCalled();
    owner.dispose();
  },
);

it.each(["live-document", "already-continued"] as const)(
  "keeps the original consumer and does not retake a %s response",
  async (state) => {
    const ended = vi.fn();
    const { owner, protocol, replace } = await oldFetchFixture({ ended });
    protocol.response("old-fetch", 200, { "content-type": "text/plain" });
    await vi.waitFor(() =>
      expect(protocol.calls).toContainEqual(
        expect.objectContaining({
          method: "Fetch.continueResponse",
          params: { requestId: "old-fetch" },
        }),
      ),
    );
    if (state === "already-continued") replace();
    expect(ended).not.toHaveBeenCalled();
    expect(
      protocol.calls.some(
        (call) => call.method === "Fetch.takeResponseBodyAsStream",
      ),
    ).toBe(false);
    protocol.emit(
      "Network.loadingFinished",
      { requestId: "network-old-fetch" },
      "protocol-a",
    );
    await owner.drainSession("session-a");
    owner.dispose();
  },
);

it.each([
  "read-failed",
  "cancel-failed",
  "cancel-inactive",
  "eof-release-failed",
  "take-failed",
  "take-and-cancel-failed",
  "close-failed",
] as const)(
  "closes a late-response IO handle while preserving a %s protocol failure",
  async (intervention) => {
    const ended = vi.fn();
    const failure = vi.fn();
    const { owner, protocol, replace } = await oldFetchFixture({
      ended,
      failure,
    });
    protocol.result = (method) => {
      if (method === "Fetch.takeResponseBodyAsStream") {
        if (intervention.startsWith("take"))
          throw new BrowserProtocolError("operation");
        return { stream: "failed-response" };
      }
      if (method === "IO.read") {
        if (
          intervention === "eof-release-failed" ||
          intervention === "close-failed"
        )
          return { data: "", eof: true };
        throw new BrowserProtocolError("operation");
      }
      if (method === "IO.close" && intervention === "close-failed")
        throw new BrowserProtocolError("operation");
      if (method === "Fetch.failRequest" && intervention === "cancel-inactive")
        throw new BrowserProtocolError("request-inactive");
      if (
        method === "Fetch.failRequest" &&
        [
          "cancel-failed",
          "eof-release-failed",
          "take-and-cancel-failed",
        ].includes(intervention)
      )
        throw new BrowserProtocolError("operation");
      return {};
    };
    replace();
    protocol.response("old-fetch", 200, { "content-type": "text/plain" });
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
    expect(
      protocol.calls.filter((call) => call.method === "IO.close"),
    ).toHaveLength(intervention.startsWith("take") ? 0 : 1);
    expect(protocol.calls).toContainEqual(
      expect.objectContaining({
        method: "Fetch.failRequest",
        params: { requestId: "old-fetch", errorReason: "Aborted" },
      }),
    );
    // A read failure is not EOF. Closing the exact acquired handle and canceling
    // its original response must both succeed before this record is released.
    expect(ended).toHaveBeenCalledTimes(
      ["read-failed", "take-failed"].includes(intervention) ? 1 : 0,
    );
    owner.dispose();
  },
);

it("hands a late old-document PDF to its original managed writer", async () => {
  const ready = deferred<void>();
  const release = deferred<void>();
  const received = vi.fn(async () => {
    ready.resolve();
    await release.promise;
  });
  const ended = vi.fn();
  const { owner, protocol, replace } = await oldFetchFixture({
    ended,
    pdfResponse: received,
  });
  replace();
  protocol.response("old-fetch", 200, {
    "content-type": "application/pdf",
    "content-disposition": "attachment; filename=selected.pdf",
  });
  await ready.promise;
  expect(ended).not.toHaveBeenCalled();
  expect(
    protocol.calls.some(
      (call) => call.method === "Fetch.takeResponseBodyAsStream",
    ),
  ).toBe(false);
  await owner.stopSession("session-a");
  expect(ended).not.toHaveBeenCalled();
  owner.dispose();
  release.resolve();
});

it.each(["context-first", "commit-first"] as const)(
  "retires only document-bound requests after their default context and loader are replaced (%s)",
  async (order) => {
    const ended = vi.fn();
    const received = deferred<void>();
    const release = deferred<void>();
    const { owner, protocol } = await fixture({
      ended,
      nativeDownload: () => {},
      pdfResponse: async () => {
        received.resolve();
        await release.promise;
      },
    });
    protocol.result = (method) =>
      method === "Fetch.takeResponseBodyAsStream"
        ? { stream: "pdf-stream" }
        : {};
    protocol.emit(
      "Page.frameNavigated",
      { frame: { id: "a", loaderId: "document-a" } },
      "protocol-a",
    );
    protocol.emit(
      "Runtime.executionContextCreated",
      {
        context: {
          id: 41,
          uniqueId: "context-a",
          auxData: { frameId: "a", isDefault: true },
        },
      },
      "protocol-a",
    );
    for (const [id, resource, networkResource] of [
      ["old-script", "Script"],
      ["old-xhr", "XHR"],
      ["old-image", "Image"],
      ["old-stylesheet", "Stylesheet"],
      ["old-font", "Font"],
      // Root Fetch reports JavaScript fetch as XHR; the exact Network event
      // distinguishes its independent, potentially keepalive-capable lifetime.
      ["keepalive-fetch", "XHR", "Fetch"],
      ["beacon", "Other"],
      ["native-pdf", "Other"],
      ["stream-pdf", "XHR"],
    ])
      protocol.request(
        id!,
        "a",
        resource!,
        "http://127.0.0.1/" + id,
        "document-a",
        "GET",
        networkResource ?? resource!,
      );
    await vi.waitFor(() =>
      expect(
        protocol.calls.filter(
          (call) => call.method === "Fetch.continueRequest",
        ),
      ).toHaveLength(9),
    );
    protocol.response("native-pdf", 200, { "content-type": "application/pdf" });
    protocol.response("stream-pdf", 200, {
      "content-type": "application/pdf",
      "content-disposition": "attachment; filename=selected.pdf",
    });
    await received.promise;
    protocol.emit("Browser.downloadWillBegin", {
      guid: "00000000-0000-0000-0000-000000000003",
      frameId: "a",
      url: "http://127.0.0.1/native-pdf",
    });
    protocol.emit("Runtime.executionContextsCleared", {}, "protocol-b");
    expect(ended).not.toHaveBeenCalled();
    const contextGone = () =>
      protocol.emit("Runtime.executionContextsCleared", {}, "protocol-a");
    const committed = () =>
      protocol.emit(
        "Page.frameNavigated",
        { frame: { id: "a", loaderId: "document-a2" } },
        "protocol-a",
      );
    if (order === "context-first") contextGone();
    else committed();
    expect(ended).not.toHaveBeenCalled();
    if (order === "context-first") committed();
    else contextGone();
    expect(
      ended.mock.calls.map(([binding]) => binding.request_id).sort(),
    ).toEqual([
      "old-font",
      "old-image",
      "old-script",
      "old-stylesheet",
      "old-xhr",
    ]);
    for (const id of ["native-pdf", "stream-pdf"])
      protocol.emit("Fetch.requestPaused", {
        requestId: id,
        networkId: "network-" + id,
        responseErrorReason: "Aborted",
      });
    await Promise.resolve();
    expect(ended).toHaveBeenCalledTimes(5);
    protocol.emit(
      "Network.loadingFailed",
      { requestId: "network-old-script" },
      "protocol-a",
    );
    expect(ended).toHaveBeenCalledTimes(5);
    let drained = false;
    const drain = owner.drainSession("session-a").then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    // Keepalive-capable Fetch, browser-owned Other and both PDF writers still
    // need their own terminal; an old document's loss cannot end any of them.
    owner.dispose();
    release.resolve();
    await drain;
  },
);

it("requires a known default context and a different committed loader for document retirement", async () => {
  const ended = vi.fn();
  const { owner, protocol } = await fixture({ ended });
  protocol.emit(
    "Page.frameNavigated",
    { frame: { id: "a", loaderId: "document-a" } },
    "protocol-a",
  );
  protocol.request(
    "script-a",
    "a",
    "Script",
    "http://127.0.0.1/script",
    "document-a",
  );
  await vi.waitFor(() =>
    expect(protocol.calls).toContainEqual(
      expect.objectContaining({
        method: "Fetch.continueRequest",
        params: { requestId: "script-a", interceptResponse: true },
      }),
    ),
  );
  protocol.emit(
    "Runtime.executionContextCreated",
    {
      context: {
        id: 41,
        uniqueId: "isolated-context",
        auxData: { frameId: "a", isDefault: false },
      },
    },
    "protocol-a",
  );
  protocol.emit("Runtime.executionContextsCleared", {}, "protocol-b");
  protocol.emit("Runtime.executionContextsCleared", {}, "protocol-a");
  protocol.emit(
    "Page.frameNavigated",
    { frame: { id: "a", loaderId: "document-a2" } },
    "protocol-a",
  );
  expect(ended).not.toHaveBeenCalled();
  owner.dispose();
});

it.each([
  "continued-failure",
  "interception-retired",
  "protocol-operation",
  "unmatched-network",
] as const)(
  "settles only an exact explicit failed response while retaining protocol failures (%s)",
  async (intervention) => {
    const ended = vi.fn();
    const failure = vi.fn();
    const { owner, protocol } = await fixture({ ended, failure });
    protocol.request("failed-fetch", "a", "Fetch");
    await vi.waitFor(() =>
      expect(protocol.calls).toContainEqual(
        expect.objectContaining({
          method: "Fetch.continueRequest",
          params: { requestId: "failed-fetch", interceptResponse: true },
        }),
      ),
    );
    protocol.result = (method) => {
      if (method === "Fetch.continueResponse") {
        if (intervention === "interception-retired")
          throw new BrowserProtocolError("request-inactive");
        if (intervention === "protocol-operation")
          throw new BrowserProtocolError("operation");
      }
      return {};
    };
    protocol.emit("Fetch.requestPaused", {
      requestId: "failed-fetch",
      networkId:
        intervention === "unmatched-network"
          ? "network-unrelated"
          : "network-failed-fetch",
      responseErrorReason: "Failed",
    });
    await vi.waitFor(() =>
      expect(failure).toHaveBeenCalledTimes(
        ["protocol-operation", "unmatched-network"].includes(intervention)
          ? 1
          : 0,
      ),
    );
    if (intervention === "unmatched-network") {
      expect(ended).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
      await owner.drainSession("session-a");
      protocol.emit(
        "Network.loadingFailed",
        { requestId: "network-failed-fetch" },
        "protocol-a",
      );
      expect(ended).toHaveBeenCalledTimes(1);
    }
    owner.dispose();
  },
);

it("gates same-URL popups by opener identity while another session admission waits", async () => {
  const waiting = deferred<void>();
  const admissions: { session: string; page: string }[] = [];
  const { owner, protocol } = await fixture({
    beforeRequest: async (identity) => {
      admissions.push({ session: identity.session_id, page: identity.page_id });
      if (identity.session_id === "session-a") await waiting.promise;
    },
  });
  protocol.attach("popup-a", "a");
  protocol.attach("popup-b", "b");
  protocol.request("first-a", "popup-a");
  protocol.request("first-b", "popup-b");
  await vi.waitFor(() =>
    expect(
      protocol.calls.filter((call) => call.method === "Fetch.continueRequest"),
    ).toEqual([
      expect.objectContaining({
        params: { requestId: "first-b", interceptResponse: true },
      }),
    ]),
  );
  expect(admissions).toEqual([
    { session: "session-a", page: "popup-a" },
    { session: "session-b", page: "popup-b" },
  ]);
  waiting.resolve();
  await vi.waitFor(() =>
    expect(
      protocol.calls.filter((call) => call.method === "Fetch.continueRequest"),
    ).toHaveLength(2),
  );
  protocol.request("unowned", "unowned");
  await vi.waitFor(() =>
    expect(protocol.calls).toContainEqual(
      expect.objectContaining({
        method: "Fetch.failRequest",
        params: { requestId: "unowned", errorReason: "BlockedByClient" },
      }),
    ),
  );
  owner.dispose();
});

it("joins an OOPIF document terminal by frame and network identity after renderer transfer", async () => {
  const ended = vi.fn();
  const { owner, protocol } = await fixture({ ended });
  protocol.emit(
    "Page.frameAttached",
    { frameId: "child-frame", parentFrameId: "a" },
    "protocol-a",
  );
  protocol.request("iframe-document", "child-frame");
  await vi.waitFor(() =>
    expect(protocol.calls).toContainEqual(
      expect.objectContaining({
        method: "Fetch.continueRequest",
        params: { requestId: "iframe-document", interceptResponse: true },
      }),
    ),
  );
  protocol.emit("Target.attachedToTarget", {
    sessionId: "protocol-child-frame",
    targetInfo: { targetId: "child-frame", type: "iframe" },
  });
  await owner.ready("child-frame");
  expect(protocol.calls).toContainEqual(
    expect.objectContaining({
      method: "Target.setAutoAttach",
      session: "protocol-child-frame",
    }),
  );
  protocol.emit(
    "Network.loadingFinished",
    { requestId: "network-iframe-document" },
    "protocol-child-frame",
  );
  await owner.drainSession("session-a");
  expect(ended).toHaveBeenCalledTimes(1);
  expect(ended).toHaveBeenCalledWith(
    expect.objectContaining({
      request_id: "iframe-document",
      session_id: "session-a",
    }),
  );
  owner.dispose();
});

it.each([true, false])(
  "binds OOPIF commits and requests when the parent relation arrives first: %s",
  async (parentFirst) => {
    const documentCommitted = vi.fn();
    const beforeRequest = vi.fn(async () => {});
    const { owner, protocol } = await fixture({
      documentCommitted,
      beforeRequest,
    });
    protocol.emit(
      "Page.frameNavigated",
      { frame: { id: "a", loaderId: "loader-a" } },
      "protocol-a",
    );
    const parent = () =>
      protocol.emit(
        "Page.frameAttached",
        { frameId: "child-frame", parentFrameId: "a" },
        "protocol-a",
      );
    if (parentFirst) parent();
    protocol.emit("Target.attachedToTarget", {
      sessionId: "protocol-child",
      targetInfo: { targetId: "child-frame", type: "iframe" },
    });
    await owner.ready("child-frame");
    if (!parentFirst) parent();
    protocol.emit(
      "Page.frameNavigated",
      { frame: { id: "child-frame", parentId: "a", loaderId: "loader-child" } },
      "protocol-child",
    );
    expect(documentCommitted).toHaveBeenLastCalledWith(
      expect.objectContaining({
        page_id: "a",
        is_main: false,
        document_id: "loader-child",
        parent_document_id: "loader-a",
      }),
    );
    protocol.emit(
      "Network.requestWillBeSent",
      {
        requestId: "child-asset",
        frameId: "child-frame",
        loaderId: "loader-child",
      },
      "protocol-child",
    );
    protocol.emit("Fetch.requestPaused", {
      requestId: "fetch-child",
      frameId: "child-frame",
      networkId: "child-asset",
      resourceType: "Fetch",
      request: { url: "http://127.0.0.1/same" },
    });
    await vi.waitFor(() =>
      expect(beforeRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          page_id: "a",
          is_navigation: false,
          parent_document_id: "loader-a",
        }),
        expect.any(String),
        expect.any(Function),
      ),
    );
    protocol.emit(
      "Network.loadingFinished",
      { requestId: "child-asset" },
      "protocol-child",
    );
    await owner.drainSession("session-a");
    owner.dispose();
  },
);

it("freezes dedicated and nested worker requests to their creator document and joins script terminals", async () => {
  const admitted: BrowserOwnedRequest[] = [];
  const ended = vi.fn();
  let forbidPrevious = false;
  const { owner, protocol } = await fixture({
    beforeRequest: async (identity) => {
      admitted.push(identity);
      if (forbidPrevious && identity.document_id === "loader-a")
        throw new Error("previous document has no network grant");
    },
    ended,
  });
  protocol.emit(
    "Page.frameNavigated",
    { frame: { id: "a", loaderId: "loader-a" } },
    "protocol-a",
  );
  protocol.request("worker-script", "a", "Script");
  await vi.waitFor(() => expect(admitted).toHaveLength(1));
  protocol.emit(
    "Target.attachedToTarget",
    {
      sessionId: "protocol-worker",
      targetInfo: { targetId: "worker", type: "worker" },
    },
    "protocol-a",
  );
  await owner.ready("worker");
  protocol.emit(
    "Network.loadingFinished",
    { requestId: "network-worker-script" },
    "protocol-worker",
  );
  expect(ended).toHaveBeenCalledWith(
    expect.objectContaining({ request_id: "worker-script" }),
  );
  const request = (id: string, target: string) => {
    protocol.emit(
      "Network.requestWillBeSent",
      { requestId: "network-" + id },
      "protocol-" + target,
    );
    protocol.emit("Fetch.requestPaused", {
      requestId: id,
      networkId: "network-" + id,
      resourceType: "Fetch",
      request: { url: "http://127.0.0.1/same" },
    });
  };
  request("worker-fetch", "worker");
  protocol.emit(
    "Network.requestWillBeSent",
    { requestId: "nested", frameId: "a", loaderId: "loader-a" },
    "protocol-a",
  );
  protocol.emit("Fetch.requestPaused", {
    requestId: "nested-script",
    frameId: "a",
    networkId: "nested",
    resourceType: "Other",
    request: { url: "http://127.0.0.1/same" },
  });
  await vi.waitFor(() => expect(admitted).toHaveLength(3));
  protocol.emit(
    "Target.attachedToTarget",
    {
      sessionId: "protocol-nested",
      targetInfo: { targetId: "nested", type: "worker" },
    },
    "protocol-worker",
  );
  await owner.ready("nested");
  protocol.emit(
    "Network.loadingFinished",
    { requestId: "nested" },
    "protocol-nested",
  );
  expect(ended).toHaveBeenCalledWith(
    expect.objectContaining({ request_id: "nested-script" }),
  );
  request("nested-fetch", "nested");
  await vi.waitFor(() => expect(admitted).toHaveLength(4));
  for (const identity of admitted)
    expect(identity).toEqual(
      expect.objectContaining({
        page_id: "a",
        session_id: "session-a",
        frame_id: "a",
        document_id: "loader-a",
        source_document_id: "loader-a",
        is_navigation: false,
      }),
    );
  expect(
    protocol.calls.some(
      (call) =>
        call.method === "Page.enable" &&
        ["protocol-worker", "protocol-nested"].includes(call.session ?? ""),
    ),
  ).toBe(false);
  protocol.emit(
    "Network.loadingFinished",
    { requestId: "network-worker-fetch" },
    "protocol-worker",
  );
  protocol.emit(
    "Network.loadingFinished",
    { requestId: "network-nested-fetch" },
    "protocol-nested",
  );
  await owner.drainSession("session-a");
  protocol.emit(
    "Page.frameNavigated",
    { frame: { id: "a", loaderId: "loader-new" } },
    "protocol-a",
  );
  forbidPrevious = true;
  request("old-worker-fetch", "worker");
  await vi.waitFor(() =>
    expect(protocol.calls).toContainEqual(
      expect.objectContaining({
        method: "Fetch.failRequest",
        params: {
          requestId: "old-worker-fetch",
          errorReason: "BlockedByClient",
        },
      }),
    ),
  );
  expect(admitted.at(-1)).toEqual(
    expect.objectContaining({
      document_id: "loader-a",
      source_document_id: "loader-a",
    }),
  );
  protocol.emit("Fetch.requestPaused", {
    requestId: "unowned-worker",
    resourceType: "Fetch",
    request: { url: "http://127.0.0.1/same" },
  });
  await vi.waitFor(() =>
    expect(protocol.calls).toContainEqual(
      expect.objectContaining({
        method: "Fetch.failRequest",
        params: { requestId: "unowned-worker", errorReason: "BlockedByClient" },
      }),
    ),
  );
  owner.dispose();
});

it("stops a worker through its own runtime and waits for destruction across protocol detach", async () => {
  const ended = vi.fn();
  const { owner, protocol } = await fixture({ ended });
  protocol.emit(
    "Page.frameNavigated",
    { frame: { id: "a", loaderId: "loader-a" } },
    "protocol-a",
  );
  protocol.emit(
    "Page.frameAttached",
    { frameId: "child-frame", parentFrameId: "a" },
    "protocol-a",
  );
  protocol.emit(
    "Page.frameNavigated",
    { frame: { id: "child-frame", parentId: "a", loaderId: "loader-child" } },
    "protocol-a",
  );
  protocol.emit("Target.attachedToTarget", {
    sessionId: "protocol-child",
    targetInfo: { targetId: "child-frame", type: "iframe" },
  });
  await owner.ready("child-frame");
  protocol.emit(
    "Target.attachedToTarget",
    {
      sessionId: "protocol-worker",
      targetInfo: { targetId: "worker", type: "worker" },
    },
    "protocol-child",
  );
  await owner.ready("worker");
  protocol.emit(
    "Network.requestWillBeSent",
    { requestId: "worker-network" },
    "protocol-worker",
  );
  protocol.emit("Fetch.requestPaused", {
    requestId: "worker-fetch",
    networkId: "worker-network",
    resourceType: "Fetch",
    request: { url: "http://127.0.0.1/same" },
  });
  await vi.waitFor(() =>
    expect(protocol.calls).toContainEqual(
      expect.objectContaining({
        method: "Fetch.continueRequest",
        params: { requestId: "worker-fetch", interceptResponse: true },
      }),
    ),
  );
  let stopped = false;
  let drained = false;
  const stop = owner.stopSession("session-a").then(() => {
    stopped = true;
  });
  const drain = owner.drainSession("session-a").then(() => {
    drained = true;
  });
  await vi.waitFor(() =>
    expect(protocol.calls).toContainEqual({
      method: "Runtime.evaluate",
      params: { expression: "self.close()", returnByValue: true },
      session: "protocol-worker",
    }),
  );
  expect(protocol.calls).toContainEqual({
    method: "Page.stopLoading",
    params: {},
    session: "protocol-a",
  });
  expect(
    protocol.calls.some(
      (call) =>
        call.method === "Page.stopLoading" && call.session === "protocol-child",
    ),
  ).toBe(false);
  protocol.emit("Target.detachedFromTarget", { sessionId: "protocol-worker" });
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(drained).toBe(false);
  expect(ended).not.toHaveBeenCalled();
  protocol.emit("Target.targetDestroyed", { targetId: "worker" });
  await stop;
  await drain;
  expect(ended).toHaveBeenCalledWith(
    expect.objectContaining({
      request_id: "worker-fetch",
      document_id: "loader-child",
      parent_document_id: "loader-a",
      source_document_id: "loader-a",
    }),
  );
  owner.dispose();
});

it("associates a committed main loader only with its exact admitted navigation", async () => {
  const documentCommitted = vi.fn();
  const { owner, protocol } = await fixture({ documentCommitted });
  protocol.request("navigation", "a");
  await vi.waitFor(() =>
    expect(protocol.calls).toContainEqual(
      expect.objectContaining({ method: "Fetch.continueRequest" }),
    ),
  );
  protocol.emit(
    "Page.frameNavigated",
    { frame: { id: "a", loaderId: "unrelated-loader" } },
    "protocol-a",
  );
  expect(documentCommitted).toHaveBeenLastCalledWith(
    expect.objectContaining({
      document_id: "unrelated-loader",
      navigation_request_id: null,
    }),
  );
  protocol.emit(
    "Page.frameNavigated",
    { frame: { id: "a", loaderId: "loader-a" } },
    "protocol-a",
  );
  expect(documentCommitted).toHaveBeenLastCalledWith(
    expect.objectContaining({
      document_id: "loader-a",
      navigation_request_id: "navigation",
      document_generation: 2,
    }),
  );
  protocol.emit(
    "Page.frameNavigated",
    { frame: { id: "a", loaderId: "loader-a" } },
    "protocol-a",
  );
  expect(owner.documentGeneration("a")).toBe(2);
  owner.dispose();
});

it("marks a known cached loader only after an explicit history action", async () => {
  const documentCommitted = vi.fn();
  const { owner, protocol } = await fixture({ documentCommitted });
  protocol.request("first", "a");
  await vi.waitFor(() =>
    expect(protocol.calls).toContainEqual(
      expect.objectContaining({ method: "Fetch.continueRequest" }),
    ),
  );
  protocol.emit(
    "Page.frameNavigated",
    { frame: { id: "a", loaderId: "loader-a" } },
    "protocol-a",
  );
  protocol.request(
    "second",
    "a",
    "Document",
    "http://127.0.0.1/second",
    "loader-b",
  );
  await vi.waitFor(() =>
    expect(
      protocol.calls.filter((call) => call.method === "Fetch.continueRequest"),
    ).toHaveLength(2),
  );
  protocol.emit(
    "Page.frameNavigated",
    { frame: { id: "a", loaderId: "loader-b" } },
    "protocol-a",
  );
  owner.expectHistoryNavigation("a");
  protocol.emit(
    "Page.frameNavigated",
    { frame: { id: "a", loaderId: "loader-a" } },
    "protocol-a",
  );
  expect(documentCommitted).toHaveBeenLastCalledWith(
    expect.objectContaining({
      document_id: "loader-a",
      navigation_request_id: null,
      is_history_navigation: true,
      document_generation: 3,
    }),
  );
  expect(owner.currentDocument("a")).toMatchObject({
    document_id: "loader-a",
    document_generation: 3,
  });
  owner.dispose();
});

it("retains iframe ownership without treating its Document as a publisher navigation", async () => {
  const admitted = vi.fn();
  const { owner, protocol } = await fixture({ admitted });
  protocol.emit(
    "Page.frameAttached",
    { frameId: "child-frame", parentFrameId: "a" },
    "protocol-a",
  );
  protocol.request("iframe", "child-frame");
  await vi.waitFor(() =>
    expect(admitted).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "session-a",
        page_id: "a",
        is_navigation: false,
      }),
      "http://127.0.0.1/same",
    ),
  );
  owner.dispose();
});

it("refuses a request whose document changes while admission is awaiting", async () => {
  const release = deferred<void>();
  const { owner, protocol, pages } = await fixture({
    beforeRequest: async () => {
      await release.promise;
    },
  });
  protocol.request("late-document", "a", "Fetch");
  await Promise.resolve();
  const previous = pages.get("a")!;
  pages.set("a", {
    ...previous,
    document_generation: previous.document_generation + 1,
  });
  release.resolve();
  await vi.waitFor(() =>
    expect(protocol.calls).toContainEqual(
      expect.objectContaining({
        method: "Fetch.failRequest",
        params: { requestId: "late-document", errorReason: "BlockedByClient" },
      }),
    ),
  );
  expect(
    protocol.calls.some((call) => call.method === "Fetch.continueRequest"),
  ).toBe(false);
  owner.dispose();
});

it("ends a redirect hop before asking the next platform admission to drain", async () => {
  let drainNext = false;
  const { owner, protocol } = await fixture({
    beforeRequest: async (_identity, _url, drain) => {
      if (drainNext) await drain();
    },
  });
  protocol.request("redirect", "a");
  await vi.waitFor(() =>
    expect(
      protocol.calls.some((call) => call.method === "Fetch.continueRequest"),
    ).toBe(true),
  );
  protocol.response("redirect", 302, { location: "http://127.0.0.1/final" });
  await vi.waitFor(() =>
    expect(
      protocol.calls.some((call) => call.method === "Fetch.continueResponse"),
    ).toBe(true),
  );
  drainNext = true;
  protocol.request("final", "a", "Document", "http://127.0.0.1/final");
  await vi.waitFor(() =>
    expect(protocol.calls).toContainEqual(
      expect.objectContaining({
        method: "Fetch.continueRequest",
        params: { requestId: "final", interceptResponse: true },
      }),
    ),
  );
  owner.dispose();
});

it("settles an exact terminal arriving during admission without continuing the canceled request", async () => {
  const waiting = deferred<void>();
  const entered = deferred<void>();
  const ended = vi.fn();
  const blocked = vi.fn();
  const { owner, protocol } = await fixture({
    ended,
    blocked,
    beforeRequest: async () => {
      entered.resolve();
      await waiting.promise;
    },
  });
  try {
    protocol.request("canceled-before-admission", "a");
    await entered.promise;
    protocol.emit(
      "Network.loadingFailed",
      { requestId: "network-canceled-before-admission" },
      "protocol-a",
    );
    expect(ended).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        session_id: "session-a",
        request_id: "canceled-before-admission",
      }),
    );
    waiting.resolve();
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledTimes(1));
    expect(protocol.calls).not.toContainEqual(
      expect.objectContaining({
        method: "Fetch.continueRequest",
        params: {
          requestId: "canceled-before-admission",
          interceptResponse: true,
        },
      }),
    );
    expect(ended).toHaveBeenCalledTimes(1);
    await owner.drainSession("session-a");
  } finally {
    waiting.resolve();
    owner.dispose();
  }
});

it.each(["GET", "POST"])(
  "cancels and restarts only an original main GET after real terminals (%s)",
  async (method) => {
    const entered = deferred<void>();
    const retryNavigation = vi.fn(async () => {});
    const ended = vi.fn();
    const { owner, protocol } = await fixture({
      retryNavigation,
      ended,
      beforeRequest: async (identity, _url, drain) => {
        if (identity.request_id === "next") {
          entered.resolve();
          return drain();
        }
      },
    });
    try {
      protocol.request("old-script", "a", "Script");
      await vi.waitFor(() =>
        expect(protocol.calls).toContainEqual(
          expect.objectContaining({
            method: "Fetch.continueRequest",
            params: { requestId: "old-script", interceptResponse: true },
          }),
        ),
      );
      protocol.result = (command) => {
        if (command === "Fetch.failRequest")
          protocol.emit(
            "Network.loadingFailed",
            { requestId: "network-next" },
            "protocol-a",
          );
        if (command === "Page.stopLoading")
          protocol.emit(
            "Network.loadingFailed",
            { requestId: "network-old-script" },
            "protocol-a",
          );
        return {};
      };
      protocol.request(
        "next",
        "a",
        "Document",
        "http://127.0.0.1/next",
        "loader-next",
        method,
      );
      await entered.promise;
      if (method === "POST") {
        expect(retryNavigation).not.toHaveBeenCalled();
        expect(
          protocol.calls.some((call) => call.method === "Page.stopLoading"),
        ).toBe(false);
        protocol.emit(
          "Network.loadingFinished",
          { requestId: "network-old-script" },
          "protocol-a",
        );
        await vi.waitFor(() =>
          expect(protocol.calls).toContainEqual(
            expect.objectContaining({
              method: "Fetch.continueRequest",
              params: { requestId: "next", interceptResponse: true },
            }),
          ),
        );
        protocol.emit(
          "Network.loadingFinished",
          { requestId: "network-next" },
          "protocol-a",
        );
        expect(retryNavigation).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() =>
          expect(retryNavigation).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              request_method: "GET",
              session_id: "session-a",
              request_id: "next",
            }),
            "http://127.0.0.1/next",
          ),
        );
        await owner.navigationRecovery("a", 0, "http://127.0.0.1/next");
        expect(
          owner.navigationRecovery("a", 1, "http://127.0.0.1/next"),
        ).toBeUndefined();
        expect(
          owner.navigationRecovery("b", 0, "http://127.0.0.1/next"),
        ).toBeUndefined();
        expect(
          owner.navigationRecovery("a", 0, "http://127.0.0.1/another"),
        ).toBeUndefined();
        expect(
          protocol.calls.filter(
            (call) =>
              call.method === "Fetch.failRequest" &&
              call.params.requestId === "next",
          ),
        ).toEqual([
          expect.objectContaining({
            params: { requestId: "next", errorReason: "Aborted" },
          }),
        ]);
        expect(
          protocol.calls.some(
            (call) =>
              call.method === "Fetch.continueRequest" &&
              call.params.requestId === "next",
          ),
        ).toBe(false);
      }
      expect(ended.mock.calls.map(([identity]) => identity.request_id)).toEqual(
        method === "GET" ? ["next", "old-script"] : ["old-script", "next"],
      );
      await owner.drainSession("session-a");
    } finally {
      owner.dispose();
    }
  },
);

it("keeps an owned PDF response running while a later GET waits for its real terminal", async () => {
  const release = deferred<void>();
  const consuming = deferred<void>();
  const next = deferred<void>();
  const retryNavigation = vi.fn(async () => {});
  const { owner, protocol } = await fixture({
    retryNavigation,
    pdfResponse: async () => {
      consuming.resolve();
      await release.promise;
    },
    beforeRequest: async (identity, _url, drain) => {
      if (identity.request_id === "next") {
        next.resolve();
        return drain();
      }
    },
  });
  try {
    protocol.request("pdf-fetch", "a", "Fetch");
    await vi.waitFor(() =>
      expect(protocol.calls).toContainEqual(
        expect.objectContaining({
          method: "Fetch.continueRequest",
          params: { requestId: "pdf-fetch", interceptResponse: true },
        }),
      ),
    );
    protocol.response("pdf-fetch", 200, {
      "content-type": "application/pdf",
      "content-disposition": "attachment; filename=selected.pdf",
    });
    await consuming.promise;
    protocol.request("next", "a", "Document", "http://127.0.0.1/next");
    await next.promise;
    expect(
      protocol.calls.some(
        (call) =>
          call.method === "Page.stopLoading" ||
          call.method === "Browser.cancelDownload",
      ),
    ).toBe(false);
    expect(retryNavigation).not.toHaveBeenCalled();
    release.resolve();
    await vi.waitFor(() =>
      expect(protocol.calls).toContainEqual(
        expect.objectContaining({
          method: "Fetch.continueRequest",
          params: { requestId: "next", interceptResponse: true },
        }),
      ),
    );
    expect(retryNavigation).not.toHaveBeenCalled();
    protocol.emit(
      "Network.loadingFinished",
      { requestId: "network-next" },
      "protocol-a",
    );
    await owner.drainSession("session-a");
  } finally {
    release.resolve();
    owner.dispose();
  }
});

it("preserves a PDF writer admitted while the provisional GET cancellation awaits its terminal", async () => {
  const release = deferred<void>();
  const consuming = deferred<void>();
  const retryNavigation = vi.fn(async () => {});
  const { owner, protocol } = await fixture({
    retryNavigation,
    pdfResponse: async () => {
      consuming.resolve();
      await release.promise;
    },
    beforeRequest: async (identity, _url, drain) =>
      identity.request_id === "next" ? drain() : undefined,
  });
  try {
    protocol.request("old-fetch", "a", "Fetch");
    await vi.waitFor(() =>
      expect(protocol.calls).toContainEqual(
        expect.objectContaining({
          method: "Fetch.continueRequest",
          params: { requestId: "old-fetch", interceptResponse: true },
        }),
      ),
    );
    protocol.request("next", "a", "Document", "http://127.0.0.1/next");
    await vi.waitFor(() =>
      expect(protocol.calls).toContainEqual(
        expect.objectContaining({
          method: "Fetch.failRequest",
          params: { requestId: "next", errorReason: "Aborted" },
        }),
      ),
    );
    protocol.response("old-fetch", 200, {
      "content-type": "application/pdf",
      "content-disposition": "attachment; filename=selected.pdf",
    });
    await consuming.promise;
    protocol.emit(
      "Network.loadingFailed",
      { requestId: "network-next" },
      "protocol-a",
    );
    await owner.ready("a");
    expect(
      protocol.calls.some(
        (call) =>
          call.method === "Page.stopLoading" ||
          call.method === "Browser.cancelDownload",
      ),
    ).toBe(false);
    expect(retryNavigation).not.toHaveBeenCalled();
    release.resolve();
    await vi.waitFor(() => expect(retryNavigation).toHaveBeenCalledTimes(1));
    await owner.navigationRecovery("a", 0, "http://127.0.0.1/next");
    expect(
      protocol.calls.some(
        (call) =>
          call.method === "Page.stopLoading" ||
          call.method === "Browser.cancelDownload",
      ),
    ).toBe(false);
    expect(
      protocol.calls.filter(
        (call) =>
          call.method === "Fetch.failRequest" &&
          call.params.requestId === "next",
      ),
    ).toHaveLength(1);
    expect(
      protocol.calls.some(
        (call) =>
          call.method === "Fetch.continueRequest" &&
          call.params.requestId === "next",
      ),
    ).toBe(false);
  } finally {
    release.resolve();
    owner.dispose();
  }
});

it.each(["Document", "Fetch", "XHR"])(
  "refuses partial PDF downloads before %s transfer can consume them",
  async (resource) => {
    const rejectedResponse = vi.fn();
    const pdfResponse = vi.fn();
    const nativeDownload = vi.fn();
    const { owner, protocol } = await fixture({
      rejectedResponse,
      pdfResponse,
      nativeDownload,
    });
    protocol.request("partial", "a", resource);
    await vi.waitFor(() =>
      expect(
        protocol.calls.some((call) => call.method === "Fetch.continueRequest"),
      ).toBe(true),
    );
    protocol.response("partial", 206, {
      "content-type": "application/pdf",
      ...(resource === "Document"
        ? {}
        : { "content-disposition": "attachment; filename=selected.pdf" }),
    });
    await vi.waitFor(() =>
      expect(rejectedResponse).toHaveBeenCalledWith(
        expect.objectContaining({ session_id: "session-a" }),
        "browser-partial-pdf",
      ),
    );
    expect(pdfResponse).not.toHaveBeenCalled();
    expect(nativeDownload).not.toHaveBeenCalled();
    await owner.drainSession("session-a");
    owner.dispose();
  },
);

it("keeps a native writer and its bytes live when cancellation has no terminal event", async () => {
  let download!: BrowserNativeDownload;
  const { owner, protocol, directory } = await fixture({
    nativeDownload: (value) => {
      download = value;
    },
  });
  const guid = "00000000-0000-0000-0000-000000000001";
  await writeFile(join(directory, guid + ".crdownload"), "pending");
  protocol.request("download-link", "a", "Other", "http://127.0.0.1/pdf");
  await vi.waitFor(() =>
    expect(
      protocol.calls.some((call) => call.method === "Fetch.continueRequest"),
    ).toBe(true),
  );
  protocol.response("download-link", 200, {
    "content-type": "application/pdf",
    "content-disposition": "attachment",
  });
  await vi.waitFor(() =>
    expect(
      protocol.calls.some((call) => call.method === "Fetch.continueResponse"),
    ).toBe(true),
  );
  protocol.emit(
    "Network.loadingFailed",
    { requestId: "network-download-link" },
    "protocol-a",
  );
  protocol.emit("Browser.downloadWillBegin", {
    guid,
    frameId: "a",
    url: "http://127.0.0.1/pdf",
  });
  vi.useFakeTimers();
  const cancellation = expect(download.cancel()).rejects.toBeInstanceOf(
    BrowserProtocolError,
  );
  await vi.advanceTimersByTimeAsync(5000);
  await cancellation;
  expect(await readFile(join(directory, guid + ".crdownload"), "utf8")).toBe(
    "pending",
  );
  let drained = false;
  const drain = owner.drainSession("session-a").then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  protocol.emit("Browser.downloadProgress", {
    guid,
    state: "canceled",
    receivedBytes: 7,
    totalBytes: 0,
  });
  await download.retired;
  await drain;
  await expect(
    readFile(join(directory, guid + ".crdownload")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  owner.dispose();
});

it.each(["guid-first", "failed-response-first"] as const)(
  "keeps real native writers and exact same-URL attribution after a renderer failure (%s)",
  async (order) => {
    const ended = vi.fn();
    const downloads: BrowserNativeDownload[] = [];
    const { owner, protocol } = await fixture({
      ended,
      nativeDownload: (download) => downloads.push(download),
    });
    const url = "http://127.0.0.1/same-pdf";
    const guidA = "00000000-0000-0000-0000-000000000004";
    const guidB = "00000000-0000-0000-0000-000000000005";
    try {
      protocol.request("native-a", "a", "Other", url);
      protocol.request("native-b", "b", "Other", url);
      await vi.waitFor(() =>
        expect(
          protocol.calls.filter(
            (call) => call.method === "Fetch.continueRequest",
          ),
        ).toHaveLength(2),
      );
      for (const id of ["native-a", "native-b"])
        protocol.response(id, 200, { "content-type": "application/pdf" });
      await vi.waitFor(() =>
        expect(
          protocol.calls.filter(
            (call) => call.method === "Fetch.continueResponse",
          ),
        ).toHaveLength(2),
      );
      // A native conversion can report its renderer terminal before its GUID.
      protocol.emit(
        "Network.loadingFailed",
        {
          requestId: "network-native-a",
          errorText: "net::ERR_ABORTED",
          canceled: true,
        },
        "protocol-a",
      );
      expect(ended).not.toHaveBeenCalled();
      const beginA = () =>
        protocol.emit("Browser.downloadWillBegin", {
          guid: guidA,
          frameId: "a",
          url,
        });
      if (order === "guid-first") beginA();
      protocol.result = (method, params) => {
        if (
          method === "Fetch.continueResponse" &&
          params.requestId === "native-a"
        )
          throw new BrowserProtocolError("request-inactive");
        return {};
      };
      protocol.emit("Fetch.requestPaused", {
        requestId: "native-a",
        networkId: "network-native-a",
        responseErrorReason: "Failed",
      });
      if (order === "failed-response-first") {
        await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
        await owner.drainSession("session-a");
        beginA();
      } else {
        await Promise.resolve();
        await Promise.resolve();
        expect(ended).not.toHaveBeenCalled();
      }
      protocol.emit("Browser.downloadWillBegin", {
        guid: guidB,
        frameId: "b",
        url,
      });
      expect(
        downloads.map((download) => [download.guid, download.page.session_id]),
      ).toEqual([
        [guidA, "session-a"],
        [guidB, "session-b"],
      ]);
      let drainedA = false;
      let drainedB = false;
      const drainA = owner.drainSession("session-a").then(() => {
        drainedA = true;
      });
      const drainB = owner.drainSession("session-b").then(() => {
        drainedB = true;
      });
      protocol.emit("Target.targetDestroyed", { targetId: "a" });
      await Promise.resolve();
      expect(drainedA).toBe(false);
      expect(drainedB).toBe(false);
      protocol.emit("Browser.downloadProgress", {
        guid: guidA,
        state: "completed",
        receivedBytes: 0,
        totalBytes: 0,
      });
      await drainA;
      expect(drainedB).toBe(false);
      protocol.emit("Browser.downloadProgress", {
        guid: guidB,
        state: "completed",
        receivedBytes: 0,
        totalBytes: 0,
      });
      await drainB;
      expect(
        ended.mock.calls.map(([identity]) => identity.request_id).sort(),
      ).toEqual(["native-a", "native-b"]);
    } finally {
      owner.dispose();
    }
  },
);

it("cancels and retires a late native GUID owned by a closed article", async () => {
  const nativeDownload = vi.fn();
  const { owner, protocol, pages, directory } = await fixture({
    nativeDownload,
  });
  const controller = new AbortController();
  pages.set("a", { ...pages.get("a")!, signal: controller.signal });
  const guid = "00000000-0000-0000-0000-000000000006";
  const url = "http://127.0.0.1/late-pdf";
  try {
    protocol.request("late-pdf", "a", "Other", url);
    await vi.waitFor(() =>
      expect(
        protocol.calls.some((call) => call.method === "Fetch.continueRequest"),
      ).toBe(true),
    );
    protocol.response("late-pdf", 200, { "content-type": "application/pdf" });
    await vi.waitFor(() =>
      expect(
        protocol.calls.some((call) => call.method === "Fetch.continueResponse"),
      ).toBe(true),
    );
    protocol.emit("Fetch.requestPaused", {
      requestId: "late-pdf",
      networkId: "network-late-pdf",
      responseErrorReason: "Failed",
    });
    await owner.drainSession("session-a");
    controller.abort();
    pages.delete("a");
    protocol.emit("Target.targetDestroyed", { targetId: "a" });
    owner.sessionClosed("session-a");
    expect(
      (Reflect.get(owner, "nativeResponses") as Map<string, unknown>).size,
    ).toBe(0);
    await writeFile(
      join(directory, guid + ".crdownload"),
      "synthetic pending bytes",
    );
    protocol.result = (method, params) => {
      if (method === "Browser.cancelDownload")
        protocol.emit("Browser.downloadProgress", {
          guid: params.guid,
          state: "canceled",
          receivedBytes: 0,
          totalBytes: 0,
        });
      return {};
    };
    protocol.emit("Browser.downloadWillBegin", { guid, frameId: "a", url });
    await vi.waitFor(() =>
      expect(protocol.calls).toContainEqual({
        method: "Browser.cancelDownload",
        params: { guid },
        session: undefined,
      }),
    );
    await vi.waitFor(async () => {
      await expect(
        readFile(join(directory, guid + ".crdownload")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
    expect(nativeDownload).not.toHaveBeenCalled();
    expect(pages.get("b")!.signal.aborted).toBe(false);
    await owner.drainSession("session-a");
  } finally {
    owner.dispose();
  }
});

it("keeps late native attribution after a download popup destroys itself in a live article", async () => {
  const downloads: BrowserNativeDownload[] = [];
  const { owner, protocol, pages } = await fixture({
    nativeDownload: (download) => downloads.push(download),
  });
  const guid = "00000000-0000-0000-0000-000000000007";
  const url = "http://127.0.0.1/popup-pdf";
  try {
    protocol.attach("popup-a", "a");
    await owner.ready("popup-a");
    protocol.request("popup-pdf", "popup-a", "Document", url);
    await vi.waitFor(() =>
      expect(
        protocol.calls.some((call) => call.method === "Fetch.continueRequest"),
      ).toBe(true),
    );
    protocol.response("popup-pdf", 200, { "content-type": "application/pdf" });
    await vi.waitFor(() =>
      expect(
        protocol.calls.some((call) => call.method === "Fetch.continueResponse"),
      ).toBe(true),
    );
    protocol.emit("Fetch.requestPaused", {
      requestId: "popup-pdf",
      networkId: "network-popup-pdf",
      responseErrorReason: "Failed",
    });
    await owner.drainSession("session-a");
    pages.delete("popup-a");
    protocol.emit("Target.targetDestroyed", { targetId: "popup-a" });
    expect(pages.get("a")!.signal.aborted).toBe(false);
    protocol.emit("Browser.downloadWillBegin", {
      guid,
      frameId: "popup-a",
      url,
    });
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.page).toMatchObject({
      session_id: "session-a",
      page_id: "popup-a",
    });
    let drained = false;
    const drain = owner.drainSession("session-a").then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    protocol.emit("Browser.downloadProgress", {
      guid,
      state: "completed",
      receivedBytes: 0,
      totalBytes: 0,
    });
    await drain;
  } finally {
    owner.dispose();
  }
});

it("releases native response intents after each confirmed article close in a shared context", async () => {
  const { owner, protocol, pages } = await fixture();
  try {
    for (let index = 0; index < 12; index++) {
      const target = "article-" + index;
      const session = "session-" + index;
      const requestId = "unconverted-" + index;
      const controller = new AbortController();
      pages.set(target, {
        ...page(target, session),
        signal: controller.signal,
      });
      protocol.attach(target);
      await owner.ready(target);
      protocol.request(requestId, target, "Other", "http://127.0.0.1/same-pdf");
      await vi.waitFor(() =>
        expect(
          protocol.calls.some(
            (call) =>
              call.method === "Fetch.continueRequest" &&
              call.params.requestId === requestId,
          ),
        ).toBe(true),
      );
      protocol.response(requestId, 200, { "content-type": "application/pdf" });
      await vi.waitFor(() =>
        expect(
          protocol.calls.some(
            (call) =>
              call.method === "Fetch.continueResponse" &&
              call.params.requestId === requestId,
          ),
        ).toBe(true),
      );
      expect(() => owner.sessionClosed(session)).toThrow(BrowserProtocolError);
      protocol.emit("Fetch.requestPaused", {
        requestId,
        networkId: "network-" + requestId,
        responseErrorReason: "Failed",
      });
      await owner.drainSession(session);
      controller.abort();
      pages.delete(target);
      protocol.emit("Target.targetDestroyed", { targetId: target });
      owner.sessionClosed(session);
      expect(
        (Reflect.get(owner, "nativeResponses") as Map<string, unknown>).size,
      ).toBe(0);
    }
    expect((Reflect.get(owner, "natives") as Map<string, unknown>).size).toBe(
      0,
    );
  } finally {
    owner.dispose();
  }
});

it.each(["GET", "POST"] as const)(
  "authorizes a connection retry only for the exact ended main GET (%s)",
  async (method) => {
    const { owner, protocol } = await fixture();
    const finalUrl = "http://127.0.0.1/publisher";
    try {
      protocol.request(
        "redirect-final",
        "a",
        "Document",
        finalUrl,
        "final-loader",
        method,
      );
      await vi.waitFor(() =>
        expect(
          protocol.calls.some(
            (call) => call.method === "Fetch.continueRequest",
          ),
        ).toBe(true),
      );
      expect(owner.canRetryNavigation("a", 0, finalUrl)).toBe(false);
      protocol.emit(
        "Network.loadingFailed",
        {
          requestId: "network-redirect-final",
          errorText: "net::ERR_CONNECTION_CLOSED",
        },
        "protocol-a",
      );
      expect(owner.canRetryNavigation("a", 0, "http://127.0.0.1/doi")).toBe(
        false,
      );
      expect(owner.canRetryNavigation("a", 1, finalUrl)).toBe(false);
      expect(owner.canRetryNavigation("b", 0, finalUrl)).toBe(false);
      expect(owner.canRetryNavigation("a", 0, finalUrl)).toBe(method === "GET");
    } finally {
      owner.dispose();
    }
  },
);

it("does not retry an ended redirect hop while its next hop admission is pending", async () => {
  const gate = deferred<void>();
  const entered = deferred<void>();
  const { owner, protocol } = await fixture({
    beforeRequest: async (identity) => {
      if (identity.request_id === "pending-redirect") {
        entered.resolve();
        await gate.promise;
      }
    },
  });
  const startUrl = "http://127.0.0.1/doi";
  try {
    protocol.request("start-hop", "a", "Document", startUrl);
    await vi.waitFor(() =>
      expect(
        protocol.calls.some((call) => call.method === "Fetch.continueRequest"),
      ).toBe(true),
    );
    protocol.response("start-hop", 302);
    await vi.waitFor(() =>
      expect(
        protocol.calls.some((call) => call.method === "Fetch.continueResponse"),
      ).toBe(true),
    );
    protocol.emit(
      "Network.requestWillBeSent",
      {
        requestId: "network-start-hop",
        frameId: "a",
        loaderId: "loader-a",
        type: "Document",
        redirectResponse: { status: 302 },
      },
      "protocol-a",
    );
    protocol.emit("Fetch.requestPaused", {
      requestId: "pending-redirect",
      networkId: "network-start-hop",
      frameId: "a",
      resourceType: "Document",
      redirectedRequestId: "start-hop",
      request: { url: "http://127.0.0.1/publisher", method: "GET" },
    });
    await entered.promise;
    protocol.emit(
      "Network.loadingFailed",
      {
        requestId: "network-start-hop",
        errorText: "net::ERR_CONNECTION_CLOSED",
      },
      "protocol-a",
    );
    expect(owner.canRetryNavigation("a", 0, startUrl)).toBe(false);
    expect(owner.canRetryNavigation("a", 0, "http://127.0.0.1/publisher")).toBe(
      false,
    );
  } finally {
    gate.resolve();
    owner.dispose();
  }
});

it.each([
  [200, undefined],
  [200, 'inline; filename="attachment.pdf"'],
  [206, "inline"],
  [429, "inline"],
] as const)(
  "leaves a programmatic PDF preview to its renderer (%s, %s)",
  async (status, disposition) => {
    const pdfResponse = vi.fn();
    const rejectedResponse = vi.fn();
    const rateLimited = vi.fn();
    const { owner, protocol } = await fixture({
      pdfResponse,
      rejectedResponse,
      rateLimited,
    });
    try {
      protocol.request("preview", "a", "Fetch");
      await vi.waitFor(() =>
        expect(protocol.calls).toContainEqual(
          expect.objectContaining({
            method: "Fetch.continueRequest",
            params: { requestId: "preview", interceptResponse: true },
          }),
        ),
      );
      protocol.response("preview", status, {
        "content-type": "application/pdf",
        ...(disposition ? { "content-disposition": disposition } : {}),
      });
      await vi.waitFor(() =>
        expect(protocol.calls).toContainEqual(
          expect.objectContaining({
            method: "Fetch.continueResponse",
            params: { requestId: "preview" },
          }),
        ),
      );
      expect(pdfResponse).not.toHaveBeenCalled();
      expect(rejectedResponse).not.toHaveBeenCalled();
      expect(rateLimited).not.toHaveBeenCalled();
      expect(
        protocol.calls.some((call) => call.method === "Fetch.failRequest"),
      ).toBe(false);
      protocol.emit(
        "Network.loadingFinished",
        { requestId: "network-preview" },
        "protocol-a",
      );
      await owner.drainSession("session-a");
    } finally {
      owner.dispose();
    }
  },
);

it("streams an attachment PDF fetch through its original IO response", async () => {
  const pdfResponse = vi.fn(async () => {});
  const nativeDownload = vi.fn();
  const { owner, protocol } = await fixture({ pdfResponse, nativeDownload });
  protocol.request("attachment-fetch", "a", "Fetch");
  await vi.waitFor(() =>
    expect(
      protocol.calls.some((call) => call.method === "Fetch.continueRequest"),
    ).toBe(true),
  );
  protocol.response("attachment-fetch", 200, {
    "content-type": "application/pdf",
    "content-disposition": "attachment; filename=original.pdf",
  });
  await vi.waitFor(() =>
    expect(pdfResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: "attachment-fetch",
        session_id: "session-a",
      }),
      "http://127.0.0.1/same",
      expect.objectContaining({ status: 200 }),
    ),
  );
  expect(nativeDownload).not.toHaveBeenCalled();
  await owner.drainSession("session-a");
  owner.dispose();
});

it("ends IO activity before completed calls stopNetwork while local validation continues", async () => {
  const validation = deferred<void>();
  const rawComplete = deferred<void>();
  let receiveSignal: AbortSignal | undefined;
  const { owner, protocol } = await fixture({
    admitted: (identity, url) => dispatcher.admitted(identity, url),
    ended: (identity) => dispatcher.ended(identity),
    pdfResponse: (identity, url, response) =>
      dispatcher.pdfResponse(identity, url, response),
  });
  protocol.result = (method) =>
    method === "Fetch.takeResponseBodyAsStream"
      ? { stream: "owned-stream" }
      : method === "IO.read"
        ? { data: "JVBERi1maXh0dXJl", base64Encoded: true, eof: true }
        : {};
  const dispatcher = new BrowserTransferDispatcher(
    {
      captureContext: (id, generation, url, session) => ({
        session_id: session!,
        article_id: "article-a",
        page_id: id,
        document_generation: generation,
        source_url: url,
        captured_at: "2026-10-05T00:00:00Z",
      }),
      receive: async (input) => {
        receiveSignal = input.signal;
        for await (const chunk of input.chunks)
          expect(chunk.byteLength).toBeGreaterThan(0);
        await validation.promise;
      },
      completed: () => {
        void owner
          .stopSession("session-a")
          .then(() => owner.drainSession("session-a"))
          .then(() => rawComplete.resolve());
      },
      failed: () => {
        throw new Error("unexpected IO failure");
      },
    },
    { stall_ms: 1000, lifetime_ms: 2000 },
  );
  protocol.request("io", "a", "Fetch");
  await vi.waitFor(() =>
    expect(
      protocol.calls.some((call) => call.method === "Fetch.continueRequest"),
    ).toBe(true),
  );
  vi.useFakeTimers();
  protocol.response("io", 200, {
    "content-type": "application/pdf",
    "content-disposition": "attachment; filename=selected.pdf",
  });
  await rawComplete.promise;
  await vi.advanceTimersByTimeAsync(3000);
  expect(receiveSignal?.aborted).toBe(false);
  validation.resolve();
  await dispatcher.settle("session-a");
  owner.dispose();
});

it.each(["current", "cancelled", "replaced", "different-url"] as const)(
  "replays only the bound popup recovery through its CDP session (%s)",
  async (change) => {
    const abort = new AbortController();
    const replayed = deferred<void>();
    let recovered: BrowserOwnedRequest | undefined;
    const failed = vi.fn();
    const { owner, protocol, pages } = await fixture({
      beforeRequest: async (binding, _url, drain) =>
        binding.request_id === "popup-first" ? drain() : undefined,
      retryNavigation: async (binding, url) => {
        recovered = binding;
        if (change === "cancelled") abort.abort();
        if (change === "replaced")
          pages.set("popup", { ...pages.get("popup")!, generation: 2 });
        try {
          await owner.replayNavigation(
            binding,
            change === "different-url" ? url + "/other" : url,
          );
        } finally {
          replayed.resolve();
        }
      },
      navigationRetryFailed: failed,
    });
    pages.set("a", { ...pages.get("a")!, signal: abort.signal });
    try {
      protocol.attach("popup", "a");
      await owner.ready("popup");
      protocol.request("old", "a", "Image");
      await vi.waitFor(() =>
        expect(
          protocol.calls.some(
            (c) =>
              c.method === "Fetch.continueRequest" &&
              c.params.requestId === "old",
          ),
        ).toBe(true),
      );
      protocol.result = (command, params) => {
        if (
          command === "Fetch.failRequest" &&
          params.requestId === "popup-first"
        )
          protocol.emit(
            "Network.loadingFailed",
            { requestId: "network-popup-first" },
            "protocol-popup",
          );
        if (command === "Page.stopLoading")
          protocol.emit(
            "Network.loadingFailed",
            { requestId: "network-old" },
            "protocol-a",
          );
        return {};
      };
      protocol.request(
        "popup-first",
        "popup",
        "Document",
        "http://127.0.0.1/viewer",
      );
      await replayed.promise;
      if (change === "current") {
        expect(
          protocol.calls.filter((c) => c.method === "Page.navigate"),
        ).toEqual([
          {
            method: "Page.navigate",
            params: { url: "http://127.0.0.1/viewer", frameId: "popup" },
            session: "protocol-popup",
          },
        ]);
        expect(failed).not.toHaveBeenCalled();
        await expect(
          owner.replayNavigation(recovered!, "http://127.0.0.1/viewer"),
        ).rejects.toBeInstanceOf(BrowserProtocolError);
      } else {
        await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
        expect(
          protocol.calls.filter((c) => c.method === "Page.navigate"),
        ).toEqual([]);
      }
    } finally {
      owner.dispose();
    }
  },
);
