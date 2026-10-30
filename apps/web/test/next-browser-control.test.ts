import {
  workbenchTestAccess,
  loginWorkbenchPage,
} from "../../server/test/workbench-auth-fixture.js";
import { nextAssets } from "./next-workspace-fixture.js";
import { chromium, type Page, type WebSocketRoute } from "playwright";
import { expect, it, vi } from "vitest";
import { startWorkbenchHttp } from "../../server/src/workbench/http.js";
import { createSyntheticScreencastSession } from "../../server/src/workbench/synthetic-screencast.js";

/** Pixels actually drawn on the live canvas (0 before the first frame). */
const painted = (page: Page) =>
  page.locator("canvas.browser-frame").evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    if (canvas.width < 2) return 0;
    const data = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4 * 97) if (data[i]) n++;
    return n;
  });

it.each(["no-preference", "reduce"] as const)(
  "observes without taking control, binds the first press, rejects a replaced document and confirms release before closing (%s)",
  async (reducedMotion) => {
    const browser = await chromium.launch({
      ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    const { session, source } = createSyntheticScreencastSession();
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
      page.setDefaultTimeout(20_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // A seam over the real socket: frames can be held back and a release refused,
      // while every other message reaches the production relay unchanged.
      let failRelease = false,
        holdFrames = false;
      await page.routeWebSocket(/\/api\/screencast$/u, (ws: WebSocketRoute) => {
        const relay = ws.connectToServer();
        ws.onMessage((message) => {
          const value =
            typeof message === "string" ? JSON.parse(message) : null;
          if (failRelease && value?.type === "release") {
            ws.send(
              JSON.stringify({
                type: "input-result",
                seq: value.seq,
                status: "rejected",
                control_epoch: value.control_epoch,
                problem: {
                  display: "error",
                  technical_details: {
                    diagnostics: [
                      { code: "synthetic-release-failure", scope: "runtime" },
                    ],
                  },
                },
              }),
            );
            return;
          }
          relay.send(message);
        });
        relay.onMessage((message) => {
          if (holdFrames && typeof message !== "string") return;
          ws.send(message);
        });
      });
      await loginWorkbenchPage(page, server.origin);
      await page.goto(`${server.origin}/?view=task`);
      await page
        .getByRole("complementary", { name: "主导航" })
        .getByRole("button", { name: "浏览器", exact: true })
        .click();
      await page
        .getByRole("button", { name: "观看 Agent", exact: true })
        .click();
      const picture = page.getByRole("img", { name: "Browser 页面实时画面" });
      await expect.poll(() => painted(page)).toBeGreaterThan(0);
      // Watching, even with the pointer over the picture, never takes control.
      await picture.hover({ position: { x: 60, y: 60 } });
      expect(session.view().control.controller_id).toBeNull();
      expect(source.inputs).toBe(0);

      await picture.click({ position: { x: 30, y: 30 } });
      await expect.poll(() => source.inputs).toBeGreaterThanOrEqual(2);
      await expect
        .poll(() => page.locator(".browser-control-note").textContent())
        .toContain("你在操作 · Agent 已暂停");
      const controller = session.view().control.controller_id;
      expect(controller).not.toBeNull();

      // A refused hand-back keeps the dialog, the control and the URL.
      failRelease = true;
      await page.getByRole("button", { name: "返回会话列表" }).click();
      await expect
        .poll(() => page.locator(".browser-feedback").textContent())
        .toContain("交还未完成");
      expect(session.view().control.controller_id).toBe(controller);
      await page.goBack();
      await expect
        .poll(() => new URL(page.url()).searchParams.get("view"))
        .toBe("web");
      expect(
        await page.getByRole("dialog", { name: "观看 Agent" }).isVisible(),
      ).toBe(true);
      expect(session.view().control.controller_id).toBe(controller);

      failRelease = false;
      await page.getByRole("button", { name: "返回会话列表" }).click();
      await expect
        .poll(() => page.getByRole("dialog", { name: "观看 Agent" }).count())
        .toBe(0);
      expect(session.view().control.controller_id).toBeNull();

      // The first press is checked against the document it was aimed at.
      await page
        .getByRole("button", { name: "观看 Agent", exact: true })
        .click();
      await expect.poll(() => painted(page)).toBeGreaterThan(0);
      holdFrames = true;
      source.navigate();
      const before = source.inputs;
      await picture.click({ position: { x: 40, y: 40 } });
      await expect
        .poll(() => page.locator(".browser-feedback").textContent())
        .toContain("页面没有接受这次操作");
      // The Agent is paused by the attempt, but the press never reached the new page.
      expect(source.inputs).toBe(before);
      holdFrames = false;
      source.emit();
      await picture.click({ position: { x: 40, y: 40 } });
      await expect.poll(() => source.inputs).toBeGreaterThan(before);

      // Leaving the page detaches this window; it is never a successful release.
      const disconnected = session.view().control.controller_id!;
      const released = vi.spyOn(session, "release");
      const detached = vi.spyOn(session, "detach");
      await page.evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent("pagehide")),
      );
      await expect.poll(() => session.view().control.controller_id).toBeNull();
      expect(detached).toHaveBeenCalledWith(disconnected);
      await page.close();
      expect(released).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    } finally {
      await server.close();
      await session.close();
      await browser.close();
    }
  },
  60000,
);
