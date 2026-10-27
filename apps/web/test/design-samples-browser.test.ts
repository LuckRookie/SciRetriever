import { expect, it } from "vitest";
import { build } from "esbuild";
import { chromium } from "playwright";
import { startWorkbenchHttp } from "../../server/src/workbench/http.js";
import { ProductionWorkbenchSession } from "../../server/src/workbench/production-session.js";
import {
  loginWorkbenchPage,
  workbenchTestAccess,
} from "../../server/test/workbench-auth-fixture.js";
import { designSamplePageCleanup } from "./design-samples-browser.js";

it("awaits real ApiClient detach before destroying twenty renderers and rejects a failed receipt", async () => {
  const assets = await build({
    stdin: {
      contents: `import { ApiClient } from "./apps/web/src/app/data/api.ts";
      const api = new ApiClient();
      await api.connect(new AbortController().signal);
      document.documentElement.dataset.connected = "true";`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  const session = new ProductionWorkbenchSession(null, async () => {
    throw new Error("Acquisition must remain offline");
  });
  const server = await startWorkbenchHttp({
    session,
    access: workbenchTestAccess,
    assets: new Map([
      [
        "/",
        {
          contentType: "text/html",
          body: '<!doctype html><script type="module" src="/fixture.js"></script>',
        },
      ],
      [
        "/fixture.js",
        { contentType: "text/javascript", body: assets.outputFiles[0]!.text },
      ],
    ]),
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await loginWorkbenchPage({ request: context.request }, server.origin);
    for (let n = 0; n < 20; n++) {
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const close = designSamplePageCleanup(page);
      await page.goto(server.origin);
      await page.locator('[data-connected="true"]').waitFor();
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const received = new Promise<void>((resolve) => {
        entered = resolve;
      });
      await page.route(
        (url) => url.pathname === "/api/clients/disconnect",
        async (route) => {
          entered();
          await gate;
          await route.continue();
        },
      );
      let settled = false;
      const closing = close().then(() => {
        settled = true;
      });
      try {
        await received;
        expect(page.isClosed()).toBe(false);
        expect(settled).toBe(false);
        expect(session.view().control.viewers).toBe(1);
      } finally {
        release();
        await closing;
      }
      expect(page.isClosed()).toBe(true);
      expect(session.view().control.viewers).toBe(0);
    }
    const rejected = await context.newPage();
    const closeRejected = designSamplePageCleanup(rejected);
    await rejected.goto(server.origin);
    await rejected.locator('[data-connected="true"]').waitFor();
    await rejected.route(
      (url) => url.pathname === "/api/clients/disconnect",
      (route) =>
        route.fulfill({ status: 403, json: { code: "csrf-required" } }),
    );
    await expect(closeRejected()).rejects.toThrow(
      "disconnect was not acknowledged",
    );
    expect(rejected.isClosed()).toBe(true);
    expect(session.view().control.viewers).toBe(1);
    const anonymous = await context.newPage();
    await designSamplePageCleanup(anonymous)();
    expect(anonymous.isClosed()).toBe(true);
  } finally {
    await browser.close();
    await server.close();
    await session.close();
  }
}, 30000);
