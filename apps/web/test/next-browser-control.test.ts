import {
  workbenchTestAccess,
  loginWorkbenchPage,
} from "../../server/test/workbench-auth-fixture.js";
import { nextAssets } from "./next-workspace-fixture.js";
import { chromium } from "playwright";
import { expect, it, vi } from "vitest";
import { WorkbenchSession } from "../../server/src/workbench/session.js";
import { startWorkbenchHttp } from "../../server/src/workbench/http.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";

it.each(["no-preference", "reduce"] as const)(
  "observes without taking control, binds the first click, rejects stale replay and confirms release before closing (%s)",
  async (reducedMotion) => {
    const browser = await chromium.launch({
      ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    const imagePage = await browser.newPage({
      viewport: { width: 800, height: 600 },
    });
    await imagePage.setContent(
      "<main>Synthetic browser control fixture</main>",
    );
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
    const assets = await nextAssets();
    const server = await startWorkbenchHttp({
      access: workbenchTestAccess,
      session,
      assets,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1400, height: 1000 },
        reducedMotion,
      });
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) =>
        new URL(route.request().url()).origin === server.origin
          ? route.continue()
          : route.abort(),
      );
      await loginWorkbenchPage(page, server.origin);
      await page.goto(`${server.origin}/?view=task`);
      await page
        .getByRole("complementary", { name: "主导航" })
        .getByRole("button", { name: "浏览器", exact: true })
        .click();
      await page
        .getByRole("button", { name: "观看 Agent", exact: true })
        .click();
      await expect
        .poll(() =>
          page.getByRole("img", { name: "真实 Browser 页面" }).isVisible(),
        )
        .toBe(true);
      expect(session.view().control.controller_id).toBeNull();
      await page
        .getByRole("img", { name: "真实 Browser 页面" })
        .click({ position: { x: 30, y: 30 } });
      await expect.poll(() => apply.mock.calls.length).toBe(1);
      await expect
        .poll(() => page.locator(".browser-control-note").textContent())
        .toContain("你在操作 · Agent 已暂停");
      const controller = session.view().control.controller_id;
      await page.route("**/api/control?*", async (route) => {
        if (route.request().postDataJSON().kind === "release")
          await route.fulfill({
            status: 503,
            json: { code: "synthetic-release-failure" },
          });
        else await route.continue();
      });
      await page.getByRole("button", { name: "返回会话列表" }).click();
      await expect
        .poll(() =>
          page
            .getByRole("status")
            .filter({ hasText: /交还未完成|页面发生变化/ })
            .textContent(),
        )
        .toContain("交还未完成");
      expect(session.view().control.controller_id).toBe(controller);
      expect(
        await page.getByRole("dialog", { name: "观看 Agent" }).isVisible(),
      ).toBe(true);
      // Browser back is a navigation attempt too: a failed release keeps
      // both the controlled view and its confirmed URL/history entry.
      await page.goBack();
      await expect
        .poll(() => new URL(page.url()).searchParams.get("view"))
        .toBe("web");
      expect(
        await page.getByRole("dialog", { name: "观看 Agent" }).isVisible(),
      ).toBe(true);
      expect(session.view().control.controller_id).toBe(controller);
      await page.unroute("**/api/control?*");
      await page.getByRole("button", { name: "返回会话列表" }).click();
      await expect
        .poll(() => page.getByRole("dialog", { name: "观看 Agent" }).count())
        .toBe(0);
      expect(session.view().control.controller_id).toBeNull();
      await page
        .getByRole("button", { name: "观看 Agent", exact: true })
        .click();
      await page.getByRole("img", { name: "真实 Browser 页面" }).waitFor();
      // The server applies input before its acknowledgement reaches the UI.
      // A back navigation during that window must retain the controlled dialog;
      // only a confirmed input may be followed by a release-and-leave attempt.
      let acknowledgeAction: () => void = () => undefined;
      const acknowledgement = new Promise<void>((resolve) => {
        acknowledgeAction = resolve;
      });
      const actionPath = "**/api/action?*";
      await page.route(actionPath, async (route) => {
        const response = await route.fetch();
        await acknowledgement;
        await route.fulfill({ response });
      });
      try {
        await page
          .getByRole("img", { name: "真实 Browser 页面" })
          .click({ position: { x: 30, y: 30 } });
        await expect.poll(() => apply.mock.calls.length).toBe(2);
        await page.goBack();
        await expect
          .poll(() => new URL(page.url()).searchParams.get("view"))
          .toBe("web");
        expect(session.view().control.controller_id).toBe(controller);
        expect(
          await page.getByRole("dialog", { name: "观看 Agent" }).isVisible(),
        ).toBe(true);
      } finally {
        acknowledgeAction();
      }
      await expect
        .poll(() =>
          page.getByRole("button", { name: "返回会话列表" }).isEnabled(),
        )
        .toBe(true);
      await page.unroute(actionPath);
      await page.goBack();
      await expect
        .poll(() => new URL(page.url()).searchParams.get("view"))
        .toBe("task");
      await expect.poll(() => session.view().control.controller_id).toBeNull();
      await expect
        .poll(() => page.getByRole("dialog", { name: "观看 Agent" }).count())
        .toBe(0);
      await page.goForward();
      await expect
        .poll(() => new URL(page.url()).searchParams.get("view"))
        .toBe("web");
      await page
        .getByRole("button", { name: "观看 Agent", exact: true })
        .click();
      await expect
        .poll(() =>
          page.getByRole("img", { name: "真实 Browser 页面" }).isVisible(),
        )
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
      await page
        .getByRole("img", { name: "真实 Browser 页面" })
        .click({ position: { x: 40, y: 40 } });
      await expect
        .poll(() =>
          page
            .getByRole("status")
            .filter({ hasText: /交还未完成|页面发生变化/ })
            .textContent(),
        )
        .toContain("页面发生变化");
      expect(apply).toHaveBeenCalledTimes(2);
      await page
        .getByRole("img", { name: "真实 Browser 页面" })
        .click({ position: { x: 40, y: 40 } });
      await expect.poll(() => apply.mock.calls.length).toBe(3);
      const disconnected = session.view().control.controller_id!;
      const released = vi.spyOn(session, "release");
      const detached = vi.spyOn(session, "detach");
      // Exercise the real unload handler and await its receipt before destroying
      // the renderer. Whether page.close delivers keepalive before resolving is
      // browser-specific; the contract is detach, never successful Agent release.
      await page.evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent("pagehide")),
      );
      await expect.poll(() => session.view().control.controller_id).toBeNull();
      expect(detached).toHaveBeenCalledWith(disconnected);
      await page.close();
      expect(released).not.toHaveBeenCalled();
      expect(session.view().control.controller_id).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      await server.close();
      await session.close();
      await browser.close();
    }
  },
  60000,
);
