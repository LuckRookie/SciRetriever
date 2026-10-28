import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  workbenchTestAccess,
  loginWorkbenchPage,
} from "../../server/test/workbench-auth-fixture.js";
import { nextAssets } from "./next-workspace-fixture.js";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { startWorkbenchHttp } from "../../server/src/workbench/http.js";
import { createSyntheticScreencastSession } from "../../server/src/workbench/synthetic-screencast.js";

/**
 * Design samples of the live viewer (plan 17 · 4.7, R-04) from the synthetic screencast:
 * no Browser, model or network. Runs only when SCREENCAST_SAMPLE_OUTPUT names a
 * directory for the screenshots.
 */
const output = process.env.SCREENCAST_SAMPLE_OUTPUT;
const scenarios = [
  "running",
  "controlling",
  "taken-over",
  "reconnecting",
  "no-frame",
] as const;

it.skipIf(!output)(
  "captures every viewer state at desktop and phone widths",
  async () => {
    await mkdir(output!, { recursive: true });
    const assets = await nextAssets();
    const browser = await chromium.launch({ headless: true });
    try {
      for (const [n, scenario] of scenarios.entries())
        for (const width of [1440, 390]) {
          const { session, source, applyScenario } =
            createSyntheticScreencastSession({
              scenario:
                scenario === "reconnecting" || scenario === "no-frame"
                  ? scenario
                  : "running",
            });
          await session.refresh();
          const server = await startWorkbenchHttp({
            access: workbenchTestAccess,
            session,
            assets,
          });
          try {
            const page = await browser.newPage({
              viewport: { width, height: width === 390 ? 844 : 960 },
              reducedMotion: "reduce",
            });
            await loginWorkbenchPage(page, server.origin);
            await page.goto(`${server.origin}/?view=web`);
            await page
              .getByRole("button", { name: "观看 Agent", exact: true })
              .click();
            const stage = page.locator(".browser-frame-wrap");
            if (scenario === "reconnecting" || scenario === "no-frame")
              await expect
                .poll(() => stage.getAttribute("data-status"))
                .toBe(scenario);
            else
              await expect
                .poll(() => stage.getAttribute("data-painted"))
                .toBe("true");
            if (scenario === "controlling") {
              await page
                .locator("canvas.browser-frame")
                .click({ position: { x: 40, y: 40 } });
              await expect
                .poll(() => stage.getAttribute("data-control"))
                .toBe("controlling");
            }
            if (scenario === "taken-over") {
              applyScenario("taken-over", "");
              source.emit();
              await expect
                .poll(() => stage.getAttribute("data-control"))
                .toBe("taken-over");
            }
            await page.screenshot({
              path: join(
                output!,
                `${String(n + 1).padStart(2, "0")}-${scenario}-${width}.png`,
              ),
            });
            await page.close();
          } finally {
            await server.close();
            await session.close();
          }
        }
    } finally {
      await browser.close();
    }
  },
  180000,
);
