import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { expect } from "vitest";
import { writeDesignAudit } from "./design-audit-fixture.js";
/** Optional synthetic review artifacts; never creates tracked screenshots or reads user materials. */
export async function captureFeature(page: Page, name: string) {
  const output = process.env.SCIRETRIEVER_WEB_REVIEW_OUTPUT;
  if (!output) return;
  await mkdir(output, { recursive: true });
  const previous = page.viewportSize()!;
  const theme = await page.locator("html").getAttribute("data-theme");
  for (const width of [1440, 1024, 390])
    for (const choice of ["light", "dark", "green", "warm"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((choice) => {
        document.documentElement.dataset.theme = choice;
        document.querySelectorAll("main, .ui-tab-panel").forEach((element) => {
          element.scrollTop = 0;
        });
      }, choice);
      const id = `${name}-${width}-${choice}`;
      await page.screenshot({
        path: join(output, `${id}.png`),
        animations: "disabled",
      });
      await writeDesignAudit(page, output, id);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  await page.setViewportSize(previous);
  await page.evaluate((theme) => {
    document.documentElement.dataset.theme = theme ?? "light";
  }, theme);
}
