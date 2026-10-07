import { describe, expect, it } from "vitest";
import { BrowserPageRuntime } from "../src/browser/page-runtime.js";
import type { Page } from "playwright";

function fixture() {
  const frame = {};
  const listeners = new Map<string, (value: never) => void>();
  let feedback = "unchanged";
  let tick = () => {};
  let ticks = 0;
  let reloads = 0;
  let closed = false;
  const page = {
    on(event: string, listener: (value: never) => void) {
      listeners.set(event, listener);
      return page;
    },
    mainFrame: () => frame,
    isClosed: () => closed,
    evaluate: async () => feedback,
    waitForTimeout: async () => {
      ticks++;
      tick();
    },
    reload: async () => {
      reloads++;
    },
  } as unknown as Page;
  return {
    runtime: new BrowserPageRuntime(page),
    crash: () => listeners.get("crash")?.(undefined as never),
    close: () => {
      closed = true;
    },
    change: () => {
      feedback = "article";
    },
    navigate: () => listeners.get("framenavigated")?.(frame as never),
    onTick: (value: () => void) => {
      tick = value;
    },
    ticks: () => ticks,
    reloads: () => reloads,
    throttle: (header?: string, method = "GET") =>
      listeners.get("response")?.({
        status: () => 429,
        headers: () => (header ? { "retry-after": header } : {}),
        request: () => ({
          isNavigationRequest: () => true,
          frame: () => frame,
          method: () => method,
        }),
      } as never),
  };
}
const wait = {
  kind: "wait-for-change",
  revision: 1,
  timeout_ms: 1000,
} as const;
describe("BrowserPageRuntime feedback and server throttling", () => {
  it("hands off a committed document without waiting for blocked subresources", async () => {
    const f = fixture();
    f.onTick(f.navigate);
    await f.runtime.apply(wait, 0, () => true);
    expect(f.ticks()).toBe(1);
    await f.runtime.apply(wait, 0, () => true);
    expect(f.ticks()).toBe(1);
  });
  it("ends a wait when visible DOM changes without navigation", async () => {
    const f = fixture();
    f.onTick(f.change);
    await f.runtime.apply(wait, 0, () => true);
    expect(f.ticks()).toBe(1);
  });
  it("preserves a stable page-closed cause when its wait RPC rejects before shared runtime loss", async () => {
    const f = fixture();
    f.onTick(() => {
      f.close();
      throw new Error("synthetic closed page RPC");
    });
    await expect(f.runtime.apply(wait, 0, () => true)).rejects.toMatchObject({
      name: "BrowserPageClosedError",
      code: "browser-page-closed",
    });
  });
  it("lets the Host guard preserve confirmed shared runtime loss during a wait", async () => {
    const f = fixture();
    let lost = false;
    f.onTick(() => {
      lost = true;
    });
    const failure = Object.assign(new Error("synthetic shared runtime loss"), {
      code: "browser-runtime-lost",
    });
    await expect(
      f.runtime.apply(wait, 0, () => {
        if (lost) throw failure;
        return true;
      }),
    ).rejects.toBe(failure);
  });
  it("reports a renderer crash as a local failure while its Page remains open", async () => {
    const f = fixture();
    f.onTick(f.crash);
    await expect(f.runtime.apply(wait, 0, () => true)).rejects.toMatchObject({
      code: "browser-page-crashed",
    });
    await expect(f.runtime.snapshot()).rejects.toMatchObject({
      code: "browser-page-crashed",
    });
  });
  it("reports real throttling separately and retries an idempotent request only once", async () => {
    const f = fixture();
    f.throttle("0");
    await expect(f.runtime.apply(wait, 0, () => true)).rejects.toMatchObject({
      code: "browser-rate-limited",
    });
    expect(
      await f.runtime.retryRateLimit(
        new AbortController().signal,
        Date.now() + 5000,
      ),
    ).toBe(true);
    expect(
      await f.runtime.retryRateLimit(
        new AbortController().signal,
        Date.now() + 5000,
      ),
    ).toBe(false);
    expect(f.reloads()).toBe(1);
  });
  it.each([
    [undefined, "GET"],
    ["3600", "GET"],
    ["0", "POST"],
    ["invalid", "GET"],
  ])(
    "defers an unsafe or out-of-budget retry (%s, %s)",
    async (header, method) => {
      const f = fixture();
      f.throttle(header, method);
      expect(
        await f.runtime.retryRateLimit(
          new AbortController().signal,
          Date.now() + 5000,
        ),
      ).toBe(false);
      expect(f.reloads()).toBe(0);
    },
  );
});
