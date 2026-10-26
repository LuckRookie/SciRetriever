import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import { BrowserPageRuntime } from "../src/browser/page-runtime.js";
import type { Page } from "playwright";

function fixture() {
  const frame = {
    evaluate: async () => feedback,
    childFrames: () => [],
  };
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
    expect(await f.runtime.apply(wait, 0, () => true)).toMatchObject({
      wait_outcome: "changed",
    });
    expect(f.ticks()).toBe(1);
    expect(await f.runtime.apply(wait, 0, () => true)).toMatchObject({
      wait_outcome: "changed",
    });
    expect(f.ticks()).toBe(1);
  });
  it("ends a wait when visible DOM changes without navigation", async () => {
    const f = fixture();
    f.onTick(f.change);
    expect(await f.runtime.apply(wait, 0, () => true)).toMatchObject({
      wait_outcome: "changed",
    });
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

describe("visible frame feedback on real loopback Chromium", () => {
  let browser: import("playwright").Browser;
  let server: import("node:http").Server;
  let origin: string;
  let frameOrigin: string;
  let page: Page;
  let runtime: BrowserPageRuntime;
  let generation: number;

  // Launching Chromium can exceed the 10 s hook default under Full load.
  beforeAll(async () => {
    server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html");
      if (request.url === "/frame") {
        response.end(
          `<title>Frame</title><p>Waiting</p><input id="control" type="checkbox" style="display:none"><button id="enable" disabled>Continue</button>`,
        );
      } else if (request.url === "/nested") {
        response.end(
          `<title>Outer frame</title><iframe src="/frame" style="width:350px;height:200px"></iframe>`,
        );
      } else {
        response.end(
          `<title>Article</title><style>@keyframes spin{to{transform:rotate(360deg)}}#spinner{width:30px;height:30px;border:3px solid;animation:spin .2s linear infinite}iframe{width:450px;height:300px}</style><p>Stable article</p><div id="spinner"></div><button id="top" style="display:none">New route</button><iframe src="${frameOrigin}${request.url === "/deep" ? "/nested" : "/frame"}"></iframe><iframe id="hidden" style="display:none" src="/frame"></iframe>`,
        );
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture address missing");
    origin = `http://127.0.0.1:${address.port}`;
    frameOrigin = `http://localhost:${address.port}`;
    browser = await chromium.launch({
      headless: true,
      args: ["--no-proxy-server", "--disable-background-networking"],
    });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  });
  beforeEach(async () => {
    page = await browser.newPage({
      viewport: { width: 800, height: 600 },
      serviceWorkers: "block",
    });
    await page.route("**/*", (route) =>
      [origin, frameOrigin].includes(new URL(route.request().url()).origin)
        ? route.continue()
        : route.abort(),
    );
    runtime = new BrowserPageRuntime(page);
    await page.goto(origin, { waitUntil: "load" });
    generation = (await runtime.snapshot()).document_generation!;
  });
  afterEach(async () => {
    await page?.context().close();
  });

  // Real Chromium work reached 2.2 s under Full (36/12) load, too close to the 5 s default.
  it.each(["main", "cross-origin", "nested"])(
    "wakes for a newly visible control in %s without waiting for timeout",
    async (surface) => {
      if (surface === "nested") {
        await page.goto(`${origin}/deep`, { waitUntil: "load" });
        generation = (await runtime.snapshot()).document_generation!;
      }
      const target =
        surface === "main"
          ? page.mainFrame()
          : page
              .frames()
              .find((frame) => frame.url() === `${frameOrigin}/frame`)!;
      await target.evaluate(
        (selector) => {
          setTimeout(() => {
            (document.querySelector(selector) as HTMLElement).style.display =
              "inline-block";
          }, 200);
        },
        surface === "main" ? "#top" : "#control",
      );
      const result = await runtime.apply(
        { ...wait, timeout_ms: 2000 },
        generation,
        () => true,
      );
      expect(result).toMatchObject({ wait_outcome: "changed" });
      expect(result?.wait_elapsed_ms).toBeLessThan(1700);
      expect(
        await target
          .locator(surface === "main" ? "#top" : "#control")
          .isVisible(),
      ).toBe(true);
    },
    30_000,
  );

  it("returns execution-time element centers and point labels without typed values", async () => {
    await page.setContent(
      '<title>Fixture</title><button style="position:absolute;left:25px;top:35px;width:100px;height:40px">View PDF<span hidden>Hidden copy</span></button><input aria-label="Notes" style="position:absolute;left:25px;top:100px;width:150px;height:30px">',
    );
    const snapshot = await runtime.snapshot();
    const button = snapshot.elements!.find((e) => e.name === "View PDF")!;
    const input = snapshot.elements!.find((e) => e.editable)!;
    const click = await runtime.apply(
      { kind: "click-element", element_id: button.element_id, revision: 1 },
      snapshot.document_generation!,
      () => true,
    );
    expect(click).toMatchObject({ point: { x: 75, y: 55 }, label: "View PDF" });
    const point = await runtime.apply(
      { kind: "click-point", x: 75, y: 55, revision: 1, viewport_version: 1 },
      snapshot.document_generation!,
      () => true,
    );
    expect(point).toMatchObject({ point: { x: 75, y: 55 }, label: "View PDF" });
    const typed = await runtime.apply(
      {
        kind: "type-text",
        element_id: input.element_id,
        text: "PRIVATE_INPUT_4821",
        revision: 1,
      },
      snapshot.document_generation!,
      () => true,
    );
    expect(await page.locator("input").inputValue()).toBe("PRIVATE_INPUT_4821");
    expect(JSON.stringify(typed)).not.toContain("PRIVATE_INPUT_4821");
    expect(typed?.point).toBeUndefined();
  }, 30_000);

  it("detects an iframe control becoming enabled without text or frame navigation", async () => {
    const frame = page
      .frames()
      .find((value) => value.url() === `${frameOrigin}/frame`)!;
    await frame.evaluate(() => {
      setTimeout(() => {
        (document.querySelector("#enable") as HTMLButtonElement).disabled =
          false;
      }, 200);
    });
    expect(
      await runtime.apply(
        { ...wait, timeout_ms: 2000 },
        generation,
        () => true,
      ),
    ).toMatchObject({ wait_outcome: "changed" });
    expect(await frame.locator("#enable").isEnabled()).toBe(true);
  });

  it("does not wake on spinner animation or changes inside a hidden frame", async () => {
    const hidden = page
      .frames()
      .find((frame) => frame.url() === `${origin}/frame`)!;
    await hidden.evaluate(() => {
      setTimeout(() => {
        document.body.textContent = "Hidden new controls";
      }, 100);
    });
    const result = await runtime.apply(
      { ...wait, timeout_ms: 650 },
      generation,
      () => true,
    );
    expect(result).toMatchObject({ wait_outcome: "timeout" });
    expect(result?.wait_elapsed_ms).toBeGreaterThanOrEqual(650);
  });

  it("detects visible frame removal", async () => {
    await page.evaluate(() => {
      setTimeout(() => {
        document.querySelector("iframe")!.remove();
      }, 200);
    });
    expect(
      await runtime.apply(
        { ...wait, timeout_ms: 2000 },
        generation,
        () => true,
      ),
    ).toMatchObject({ wait_outcome: "changed" });
  });
});
