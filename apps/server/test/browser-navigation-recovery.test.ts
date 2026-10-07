import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { expect, it, vi } from "vitest";
import {
  BrowserHost,
  BrowserHostNavigationError,
  BrowserHostRuntimeError,
  type BrowserPageHandle,
} from "../src/browser/host.js";
import type { BrowserPageSnapshot } from "../src/browser/observation.js";
import {
  BrowserPageClosedError,
  BrowserPageCrashedError,
  BrowserPageTransitionError,
} from "../src/browser/page-runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function hostFixture(
  page: Page,
  protocol: {
    documentGeneration(): number;
    navigationRecovery(): Promise<void> | undefined;
  },
) {
  const host = new BrowserHost({
    profile: join(tmpdir(), "sciretriever-navigation-recovery-fixture"),
  });
  (Reflect.get(host, "pages") as Map<string, Page>).set("page-a", page);
  (Reflect.get(host, "pageIds") as Map<Page, string>).set(page, "page-a");
  (Reflect.get(host, "pageTargets") as Map<string, string>).set(
    "page-a",
    "target-a",
  );
  Reflect.set(host, "cdp", protocol);
  if (!Reflect.has(protocol, "navigationRecoveryRequest"))
    Reflect.set(protocol, "navigationRecoveryRequest", () => undefined);
  return host;
}

it.each(["new-abort", "unrelated-error", "historical-abort"] as const)(
  "awaits only a new recovery for its original aborted goto (%s)",
  async (failure) => {
    const completed = Promise.resolve();
    let recovery: Promise<void> | undefined =
      failure === "historical-abort" ? completed : undefined;
    const cause = new Error(
      failure === "unrelated-error" ? "net::ERR_FAILED" : "net::ERR_ABORTED",
    );
    const goto = vi.fn(async () => {
      recovery = completed;
      throw cause;
    });
    const page = { goto } as unknown as Page;
    const host = hostFixture(page, {
      documentGeneration: () => 1,
      navigationRecovery: () => recovery,
    });
    const navigate = Reflect.get(host, "navigatePage") as (
      page: Page,
      url: string,
    ) => Promise<void>;
    const result = navigate.call(host, page, "http://127.0.0.1/article");
    if (failure === "new-abort") await expect(result).resolves.toBeUndefined();
    else
      await expect(result).rejects.toMatchObject({
        name: BrowserHostNavigationError.name,
        cause,
      });
    expect(goto).toHaveBeenCalledTimes(1);
  },
);

it("refuses to replay the start URL after its admitted redirect connection fails", async () => {
  const cause = new Error("net::ERR_CONNECTION_CLOSED");
  const goto = vi.fn(async () => {
    throw cause;
  });
  const page = { goto } as unknown as Page;
  const host = hostFixture(page, {
    documentGeneration: () => 0,
    navigationRecovery: () => undefined,
  });
  const canRetryNavigation = vi.fn(() => false);
  const waitForDocumentChange = vi.fn(async () => undefined);
  Reflect.set(
    Reflect.get(host, "cdp") as object,
    "canRetryNavigation",
    canRetryNavigation,
  );
  Reflect.set(
    Reflect.get(host, "cdp") as object,
    "waitForDocumentChange",
    waitForDocumentChange,
  );
  (Reflect.get(host, "pageSessions") as Map<string, unknown>).set("page-a", {
    networkAllowed: true,
    closing: false,
    controller: new AbortController(),
  });
  const navigate = Reflect.get(host, "navigatePage") as (
    page: Page,
    url: string,
  ) => Promise<void>;
  await expect(
    navigate.call(host, page, "http://127.0.0.1/doi"),
  ).rejects.toMatchObject({ code: "browser-navigation-failed", cause });
  expect(goto).toHaveBeenCalledOnce();
  expect(canRetryNavigation).toHaveBeenCalledWith(
    "target-a",
    0,
    "http://127.0.0.1/doi",
  );
  expect(waitForDocumentChange).toHaveBeenCalledWith("target-a", 0);
});

it.each(["generation", "recovery", "settled-recovery"] as const)(
  "refuses an in-flight old snapshot after its navigation begins (%s)",
  async (change) => {
    let generation = 1;
    let recovery: Promise<void> | undefined;
    let marker: object | undefined;
    const entered = deferred<void>();
    const release = deferred<BrowserPageSnapshot>();
    const navigating = deferred<void>();
    const page = { isClosed: () => false } as unknown as Page;
    const host = hostFixture(page, {
      documentGeneration: () => generation,
      navigationRecovery: () => recovery,
    });
    Reflect.set(
      Reflect.get(host, "cdp") as object,
      "navigationRecoveryRequest",
      () => marker,
    );
    (Reflect.get(host, "runtimes") as Map<string, unknown>).set("page-a", {
      snapshot: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const handle = Reflect.get(host, "handle") as (
      id: string,
      page: Page,
    ) => BrowserPageHandle;
    const snapshot = handle.call(host, "page-a", page).snapshot();
    await entered.promise;
    if (change === "generation") generation = 2;
    else {
      marker = {};
      if (change === "recovery") recovery = navigating.promise;
    }
    release.resolve({
      url: "http://127.0.0.1/article",
      title: "A",
      text: "A document",
      screenshot: null,
      elements: [],
      document_generation: 1,
      loading: false,
      viewport: { width: 1024, height: 768, device_scale_factor: 1 },
    });
    await expect(snapshot).rejects.toBeInstanceOf(BrowserPageTransitionError);
    navigating.resolve();
  },
);

it.each(["stable", "generation", "target", "recovery"] as const)(
  "classifies a rejected snapshot using only confirmed document changes (%s)",
  async (change) => {
    let generation = 1;
    let marker: object | undefined;
    const entered = deferred<void>();
    const release = deferred<BrowserPageSnapshot>();
    const cause = new Error("Synthetic uncategorized snapshot RPC failure");
    const page = { isClosed: () => false } as unknown as Page;
    const host = hostFixture(page, {
      documentGeneration: () => generation,
      navigationRecovery: () => undefined,
    });
    Reflect.set(
      Reflect.get(host, "cdp") as object,
      "navigationRecoveryRequest",
      () => marker,
    );
    (Reflect.get(host, "runtimes") as Map<string, unknown>).set("page-a", {
      snapshot: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const handle = Reflect.get(host, "handle") as (
      id: string,
      page: Page,
    ) => BrowserPageHandle;
    const snapshot = handle.call(host, "page-a", page).snapshot();
    await entered.promise;
    if (change === "generation") generation = 2;
    else if (change === "target")
      (Reflect.get(host, "pageTargets") as Map<string, string>).set(
        "page-a",
        "target-b",
      );
    else if (change === "recovery") marker = {};
    release.reject(cause);
    if (change === "stable") await expect(snapshot).rejects.toBe(cause);
    else
      await expect(snapshot).rejects.toBeInstanceOf(BrowserPageTransitionError);
  },
);

it.each([
  "runtime-lost",
  "page-closed",
  "page-crashed",
  "closed-page",
] as const)(
  "preserves a terminal snapshot failure over a changed document (%s)",
  async (terminal) => {
    let generation = 1;
    let closed = false;
    const entered = deferred<void>();
    const release = deferred<BrowserPageSnapshot>();
    const cause =
      terminal === "page-closed"
        ? new BrowserPageClosedError()
        : terminal === "page-crashed"
          ? new BrowserPageCrashedError()
          : new Error("Synthetic uncategorized snapshot RPC failure");
    const page = { isClosed: () => closed } as unknown as Page;
    const host = hostFixture(page, {
      documentGeneration: () => generation,
      navigationRecovery: () => undefined,
    });
    (Reflect.get(host, "runtimes") as Map<string, unknown>).set("page-a", {
      snapshot: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const handle = Reflect.get(host, "handle") as (
      id: string,
      page: Page,
    ) => BrowserPageHandle;
    const snapshot = handle.call(host, "page-a", page).snapshot();
    await entered.promise;
    generation = 2;
    if (terminal === "runtime-lost") {
      Reflect.set(host, "runtimeLost", true);
      closed = true;
    } else if (terminal === "closed-page") closed = true;
    release.reject(cause);
    if (terminal === "runtime-lost")
      await expect(snapshot).rejects.toMatchObject({
        name: BrowserHostRuntimeError.name,
        cause,
      });
    else if (terminal === "closed-page")
      await expect(snapshot).rejects.toBeInstanceOf(BrowserPageClosedError);
    else await expect(snapshot).rejects.toBe(cause);
  },
);
