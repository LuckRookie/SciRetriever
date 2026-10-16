import { afterEach, expect, it, vi } from "vitest";
import type {
  BrowserNativeDownload,
  BrowserOwnedRequest,
} from "../src/browser/cdp-owner.js";
import { BrowserDownloadResources } from "../src/browser/resources.js";
import { BrowserTransferDispatcher } from "../src/browser/transfers.js";
import type { CandidateCapture } from "@sciretriever/contracts";
import { createLogger } from "../src/logging/index.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function capture(
  page: string,
  generation: number,
  source: string,
  session?: string,
): CandidateCapture {
  return {
    session_id: session ?? "session-a",
    article_id: "article-a",
    page_id: page,
    document_generation: generation,
    source_url: source,
    captured_at: "2026-10-05T00:00:00Z",
  };
}
function native() {
  const completed = deferred();
  const retired = deferred();
  void completed.promise.catch(() => undefined);
  const cancel = vi.fn(async () => {
    completed.reject(new Error("native writer cancelled"));
  });
  const download: BrowserNativeDownload = {
    guid: "00000000-0000-0000-0000-000000000001",
    url: "http://127.0.0.1/pdf",
    page: {
      page_id: "page-a",
      session_id: "session-a",
      operation_id: "operation-a",
      generation: 1,
      document_generation: 0,
      signal: new AbortController().signal,
    },
    completed: completed.promise,
    retired: retired.promise,
    cancel,
    chunks: async function* () {
      yield new Uint8Array([1]);
    },
  };
  return { completed, retired, cancel, download };
}
afterEach(() => vi.useRealTimers());

it.each(["native-download", "response-stream"] as const)(
  "separates observed network and Intake time without logging locators (%s)",
  async (mode) => {
    const lines: string[] = [];
    let clock = 0;
    const time = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const reading = deferred(),
      checked = deferred();
    const n = native();
    const failed = vi.fn();
    const dispatcher = new BrowserTransferDispatcher(
      {
        captureContext: capture,
        failed,
        receive: async (input) => {
          for await (const chunk of input.chunks)
            expect(chunk.length).toBeGreaterThan(0);
          reading.resolve();
          await checked.promise;
        },
      },
      {},
      createLogger("browser-transfer", (line) => lines.push(line)),
    );
    let response: Promise<void> | undefined;
    try {
      if (mode === "native-download") {
        dispatcher.nativeDownload(
          n.download,
          async () => n.retired.resolve(),
          "/tmp/sciretriever-timing",
        );
        clock = 100;
        dispatcher.nativeProgress({
          guid: n.download.guid,
          received_bytes: 1,
          total_bytes: 3,
          state: "inProgress",
        });
        clock = 200;
        dispatcher.nativeProgress({
          guid: n.download.guid,
          received_bytes: 1,
          total_bytes: 3,
          state: "inProgress",
        });
        clock = 11000;
        dispatcher.nativeProgress({
          guid: n.download.guid,
          received_bytes: 3,
          total_bytes: 3,
          state: "completed",
        });
        n.completed.resolve();
      } else {
        const identity: BrowserOwnedRequest = {
          ...n.download.page,
          request_id: "timing",
          resource_type: "fetch",
          request_method: "GET",
          is_navigation: false,
          frame_id: "page-a",
          document_id: "loader-a",
          parent_document_id: null,
          source_document_id: "loader-a",
          redirected_request_id: null,
        };
        const url = "http://127.0.0.1/pdf?signature=private-fixture-value";
        dispatcher.admitted(identity, url);
        response = dispatcher.pdfResponse(identity, url, {
          status: 200,
          content_length: 3,
          cancel: async () => {},
          chunks: async function* () {
            clock = 100;
            yield new Uint8Array([1]);
            clock = 200;
            yield new Uint8Array([2]);
            clock = 11000;
            yield new Uint8Array([3]);
          },
        });
      }
      await reading.promise;
      expect(lines.filter((x) => x.includes("phase=first-byte"))).toHaveLength(
        1,
      );
      expect(lines.find((x) => x.includes("phase=first-byte"))).toContain(
        "elapsed_ms=100",
      );
      expect(lines.filter((x) => x.includes("phase=progress"))).toHaveLength(1);
      expect(
        lines.find((x) => x.includes("phase=network-completed")),
      ).toContain("elapsed_ms=11000");
      expect(lines.some((x) => x.includes("phase=completed"))).toBe(false);
      clock = 13000;
      checked.resolve();
      await response;
      await dispatcher.settle();
      expect(lines.find((x) => x.includes("phase=completed"))).toContain(
        "elapsed_ms=13000",
      );
      expect(
        lines.every(
          (x) =>
            x.includes(`transfer_mode=${mode}`) &&
            x.includes("article_id=article-a"),
        ),
      ).toBe(true);
      expect(lines.join("\n")).not.toMatch(
        /https?:|private-fixture-value|source_url/,
      );
      expect(failed).not.toHaveBeenCalled();
    } finally {
      checked.resolve();
      n.completed.resolve();
      await response;
      await dispatcher.settle();
      time.mockRestore();
    }
  },
);

it("cancels a native quota violation and retains its ledger until real retirement", async () => {
  const resources = new BrowserDownloadResources({
    temporary_bytes: 100,
    disk_reserve_bytes: 0,
    available_bytes: async () => 100000,
  });
  const retireAllowed = deferred();
  const n = native();
  const failure = vi.fn();
  const receive = vi.fn();
  const dispatcher = new BrowserTransferDispatcher({
    resources: () => resources,
    captureContext: capture,
    receive,
    failed: failure,
  });
  dispatcher.nativeDownload(
    n.download,
    async () => {
      await retireAllowed.promise;
      n.retired.resolve();
    },
    "/tmp/sciretriever-dispatcher-owned",
  );
  dispatcher.nativeProgress({
    guid: n.download.guid,
    received_bytes: 150,
    total_bytes: null,
    state: "inProgress",
  });
  await vi.waitFor(() => expect(n.cancel).toHaveBeenCalled());
  expect(resources.snapshot().native_bytes).toBe(150);
  dispatcher.nativeProgress({
    guid: n.download.guid,
    received_bytes: 210,
    total_bytes: null,
    state: "canceled",
  });
  await vi.waitFor(() => expect(resources.snapshot().native_bytes).toBe(210));
  expect(resources.snapshot().peak_written_bytes).toBe(210);
  expect(receive).not.toHaveBeenCalled();
  expect(failure).not.toHaveBeenCalled();
  retireAllowed.resolve();
  await dispatcher.settle("session-a");
  expect(failure).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ session_id: "session-a" }),
    "browser-download-temporary-quota",
  );
  expect(resources.snapshot().native_bytes).toBe(0);
});

it("finishes terminal-byte accounting before releasing retirement and retains the first disk refusal", async () => {
  const accounting = deferred();
  const entered = deferred();
  const retireAllowed = deferred();
  let checks = 0;
  const resources = new BrowserDownloadResources({
    temporary_bytes: 1000,
    disk_reserve_bytes: 0,
    available_bytes: async () => {
      checks++;
      if (checks === 2) throw new Error("synthetic unavailable disk");
      if (checks === 3) {
        entered.resolve();
        await accounting.promise;
      }
      return 100000;
    },
  });
  const n = native();
  const failure = vi.fn();
  const receive = vi.fn();
  const dispatcher = new BrowserTransferDispatcher({
    resources: () => resources,
    captureContext: capture,
    receive,
    failed: failure,
  });
  dispatcher.nativeDownload(
    n.download,
    async () => {
      await retireAllowed.promise;
      n.retired.resolve();
    },
    "/tmp/sciretriever-dispatcher-owned",
  );
  try {
    dispatcher.nativeProgress({
      guid: n.download.guid,
      received_bytes: 150,
      total_bytes: null,
      state: "inProgress",
    });
    await vi.waitFor(() => expect(n.cancel).toHaveBeenCalled());
    dispatcher.nativeProgress({
      guid: n.download.guid,
      received_bytes: 210,
      total_bytes: null,
      state: "canceled",
    });
    await entered.promise;
    let settled = false;
    const settlement = dispatcher.settle("session-a").then(() => {
      settled = true;
    });
    retireAllowed.resolve();
    await n.retired.promise;
    expect(resources.snapshot().native_bytes).toBe(210);
    expect(settled).toBe(false);
    accounting.resolve();
    await settlement;
    expect(resources.snapshot().native_bytes).toBe(0);
    expect(resources.snapshot().peak_written_bytes).toBe(210);
    expect(receive).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ session_id: "session-a" }),
      "browser-download-disk-unavailable",
    );
  } finally {
    accounting.resolve();
    retireAllowed.resolve();
    await dispatcher.settle("session-a");
  }
});

it("does not refresh native stall protection when progress repeats the same bytes", async () => {
  vi.useFakeTimers();
  const n = native();
  const failure = vi.fn();
  const dispatcher = new BrowserTransferDispatcher(
    { captureContext: capture, receive: async () => {}, failed: failure },
    { stall_ms: 1200, lifetime_ms: 20000 },
  );
  dispatcher.nativeDownload(
    n.download,
    async () => {
      n.retired.resolve();
    },
    "/tmp/sciretriever-dispatcher-owned",
  );
  await vi.advanceTimersByTimeAsync(1000);
  dispatcher.nativeProgress({
    guid: n.download.guid,
    received_bytes: 10,
    total_bytes: null,
    state: "inProgress",
  });
  await vi.advanceTimersByTimeAsync(1000);
  dispatcher.nativeProgress({
    guid: n.download.guid,
    received_bytes: 10,
    total_bytes: null,
    state: "inProgress",
  });
  await vi.advanceTimersByTimeAsync(200);
  await dispatcher.settle();
  expect(n.cancel).toHaveBeenCalled();
  expect(failure).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(Object),
    "browser-transfer-stalled",
  );
});

it("enforces the default twenty-minute lifetime despite continuously increasing native bytes", async () => {
  vi.useFakeTimers();
  const n = native();
  const failure = vi.fn();
  const dispatcher = new BrowserTransferDispatcher({
    captureContext: capture,
    receive: async () => {},
    failed: failure,
  });
  dispatcher.nativeDownload(
    n.download,
    async () => n.retired.resolve(),
    "/tmp/sciretriever-dispatcher-owned",
  );
  for (let minute = 1; minute < 20; minute++) {
    await vi.advanceTimersByTimeAsync(60_000);
    dispatcher.nativeProgress({
      guid: n.download.guid,
      received_bytes: minute * 10,
      total_bytes: null,
      state: "inProgress",
    });
  }
  await vi.advanceTimersByTimeAsync(59_999);
  expect(n.cancel).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await dispatcher.settle("session-a");
  expect(n.cancel).toHaveBeenCalled();
  expect(failure).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ session_id: "session-a" }),
    "browser-transfer-deadline",
  );
});

it("preserves the PDF reader cause after IO bytes finish", async () => {
  const identity: BrowserOwnedRequest = {
    ...native().download.page,
    request_id: "io",
    resource_type: "fetch",
    request_method: "GET",
    is_navigation: false,
    frame_id: "page-a",
    document_id: "loader-a",
    parent_document_id: null,
    source_document_id: "loader-a",
    redirected_request_id: null,
  };
  const failed = vi.fn();
  const dispatcher = new BrowserTransferDispatcher({
    captureContext: capture,
    receive: async (input) => {
      for await (const chunk of input.chunks) expect(chunk.byteLength).toBe(1);
      const reader = Object.assign(new Error("reader deadline"), {
        code: "pdf-reader-timeout",
      });
      throw Object.assign(new Error("acceptance failed", { cause: reader }), {
        code: "pdf-acceptance",
      });
    },
    failed,
  });
  dispatcher.admitted(identity, "http://127.0.0.1/pdf");
  await dispatcher.pdfResponse(identity, "http://127.0.0.1/pdf", {
    status: 200,
    content_length: null,
    chunks: async function* () {
      yield new Uint8Array([1]);
    },
    cancel: async () => {},
  });
  expect(failed).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ session_id: "session-a" }),
    "pdf-reader-timeout",
  );
});

it("refuses A's excess bindings without evicting B's admitted response", async () => {
  const received: string[] = [];
  const dispatcher = new BrowserTransferDispatcher({
    captureContext: capture,
    receive: async (input) => {
      for await (const chunk of input.chunks) expect(chunk.byteLength).toBe(1);
      received.push(input.capture.session_id);
    },
    failed: () => {
      throw new Error("unexpected transfer failure");
    },
  });
  const base: BrowserOwnedRequest = {
    ...native().download.page,
    request_id: "a",
    resource_type: "fetch",
    request_method: "GET",
    is_navigation: false,
    frame_id: "page-a",
    document_id: "loader-a",
    parent_document_id: null,
    source_document_id: "loader-a",
    redirected_request_id: null,
  };
  const b: BrowserOwnedRequest = {
    ...base,
    session_id: "session-b",
    page_id: "page-b",
    request_id: "b",
  };
  dispatcher.admitted(b, "http://127.0.0.1/pdf");
  for (let index = 0; index < 256; index++)
    dispatcher.admitted(
      { ...base, request_id: "a-" + index },
      "http://127.0.0.1/pdf",
    );
  expect(() =>
    dispatcher.admitted(
      { ...base, request_id: "a-overflow" },
      "http://127.0.0.1/pdf",
    ),
  ).toThrow("browser transfer admission limit");
  await dispatcher.pdfResponse(b, "http://127.0.0.1/pdf", {
    status: 200,
    content_length: null,
    chunks: async function* () {
      yield new Uint8Array([1]);
    },
    cancel: async () => {},
  });
  expect(received).toEqual(["session-b"]);
});
