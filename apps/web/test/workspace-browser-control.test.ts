import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it, vi } from "vitest";
import { WorkbenchSession } from "../../server/src/workbench/session.js";
import {
  startWorkbenchHttp,
  type WorkbenchStaticAsset,
} from "../../server/src/workbench/http.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";

it("observes without taking control, binds the first click, rejects stale replay and confirms release before closing", async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
      "/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
    headless: true,
  });
  const imagePage = await browser.newPage({
    viewport: { width: 800, height: 600 },
  });
  await imagePage.setContent("<main>Synthetic browser control fixture</main>");
  const screenshot = await imagePage.screenshot({ type: "jpeg" });
  await imagePage.close();
  let generation = 1;
  const apply = vi.fn(async () => undefined);
  const session = new WorkbenchSession(
    FIXTURE_LITERATURE.literature_id,
    {
      id: "direct-click-page",
      title: async () => "Direct click fixture",
      url: () => "http://127.0.0.1/fixture",
      close: async () => undefined,
      apply,
      snapshot: async () => ({
        document_generation: generation,
        title: "Direct click fixture",
        url: "http://127.0.0.1/fixture",
        text: "Synthetic",
        viewport: { width: 800, height: 600, device_scale_factor: 1 },
        screenshot,
      }),
    },
    {
      max_actions: 10,
      max_model_calls: 1,
      max_retries: 1,
      max_bytes: 1024,
      deadline_ms: 60000,
    },
  );
  await session.refresh();
  const assets = new Map<string, WorkbenchStaticAsset>();
  for (const [route, file, contentType] of [
    ["/", "live.html", "text/html"],
    ["/workspace.css", "workspace.css", "text/css"],
  ])
    assets.set(route!, {
      contentType: contentType!,
      body: await readFile(new URL(`../public/${file}`, import.meta.url)),
    });
  const script = await build({
    entryPoints: [new URL("../src/live.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  assets.set("/live.js", {
    contentType: "text/javascript",
    body: script.outputFiles[0]!.contents,
  });
  const server = await startWorkbenchHttp({ session, assets });
  try {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 1000 },
    });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === server.origin
        ? route.continue()
        : route.abort(),
    );
    await page.goto(`${server.origin}/?view=web`);
    await page.locator("[data-session]").click();
    await expect
      .poll(() => page.locator("#browser-frame").isVisible())
      .toBe(true);
    expect(session.view().control.controller_id).toBeNull();
    await page.locator("#browser-frame").click({ position: { x: 30, y: 30 } });
    await expect.poll(() => apply.mock.calls.length).toBe(1);
    await expect
      .poll(() => page.locator("#watch-control").textContent())
      .toContain("你正在操作");
    const controller = session.view().control.controller_id;
    await page.route("**/api/control?*", async (route) => {
      if (route.request().postDataJSON().kind === "release")
        await route.fulfill({
          status: 503,
          json: { code: "synthetic-release-failure" },
        });
      else await route.continue();
    });
    await page.locator("#watch-close").click();
    await expect
      .poll(() => page.locator("#watch-feedback").textContent())
      .toContain("交还未完成");
    expect(session.view().control.controller_id).toBe(controller);
    expect(await page.locator(".watch").isVisible()).toBe(true);
    await page.unroute("**/api/control?*");
    await page.locator("#watch-close").click();
    await expect.poll(() => page.locator(".watch").count()).toBe(0);
    expect(session.view().control.controller_id).toBeNull();
    await page.locator("[data-session]").click();
    await expect
      .poll(() => page.locator("#browser-frame").isVisible())
      .toBe(true);
    await page.route(
      "**/api/control?*",
      async (route) => {
        if (route.request().postDataJSON().kind === "takeover") {
          generation += 1;
          await session.refresh();
        }
        await route.continue();
      },
      { times: 1 },
    );
    await page.locator("#browser-frame").click({ position: { x: 40, y: 40 } });
    await expect
      .poll(() => page.locator("#watch-feedback").textContent())
      .toContain("页面发生变化");
    expect(apply).toHaveBeenCalledTimes(1);
    await page.locator("#browser-frame").click({ position: { x: 40, y: 40 } });
    await expect.poll(() => apply.mock.calls.length).toBe(2);
    const disconnected = session.view().control.controller_id!;
    await page.close();
    // Closing the tab must not issue a successful-release command. Grant expiry
    // and the production detach/pause policy remain owned by the server.
    expect(session.view().control.controller_id).toBe(disconnected);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
    await session.close();
    await browser.close();
  }
}, 20000);
