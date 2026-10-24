import { expect, it } from "vitest";
import type { Page } from "playwright";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { recordReading } from "./reading-capture-fixture.js";

declare global {
  interface Window {
    __motionAudit?: {
      longTasks: number[];
      feedback: number[];
      canvasInsertions: number;
      stop(): void;
    };
  }
}
async function begin(page: Page) {
  await page.evaluate(() => {
    window.__motionAudit?.stop();
    const longTasks: number[] = [],
      feedback: number[] = [];
    let canvasInsertions = 0;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    observer.observe({ type: "longtask" });
    const mutations = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof Element)
            canvasInsertions +=
              (node.matches("canvas") ? 1 : 0) +
              node.querySelectorAll("canvas").length;
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    const press = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("button"))
        return;
      const started = performance.now();
      requestAnimationFrame(() => feedback.push(performance.now() - started));
    };
    document.addEventListener("pointerdown", press, true);
    window.__motionAudit = {
      longTasks,
      feedback,
      get canvasInsertions() {
        return canvasInsertions;
      },
      stop: () => {
        observer.disconnect();
        mutations.disconnect();
        document.removeEventListener("pointerdown", press, true);
      },
    };
  });
}
async function end(page: Page) {
  return page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    const audit = window.__motionAudit!;
    audit.stop();
    return {
      longTasks: audit.longTasks,
      feedback: audit.feedback,
      canvasInsertions: audit.canvasInsertions,
    };
  });
}
it.each(["no-preference", "reduce"] as const)(
  "keeps repeated real workspace transitions responsive without frame-by-frame PDF painting (%s)",
  async (reducedMotion) => {
    const w = await nextWorkspace();
    try {
      await w.page.emulateMedia({ reducedMotion });
      // Filter conditions open and close from the 筛选 menu.
      const filter = {
        click: async () => {
          await w.page.getByRole("button", { name: /^筛选/ }).click();
          await w.page
            .getByRole("menuitem", { name: /^(?:筛选条件…|收起筛选条件)$/ })
            .click();
        },
      };
      await filter.click();
      await w.page
        .getByRole("textbox", { name: "年份起", exact: true })
        .waitFor();
      await filter.click();
      await begin(w.page);
      for (let index = 0; index < 10; index++) {
        await filter.click();
        await w.page
          .getByRole("textbox", { name: "年份起", exact: true })
          .waitFor();
        await filter.click();
        await w.page
          .getByRole("textbox", { name: "年份起", exact: true })
          .waitFor({ state: "hidden" });
      }
      const filters = await end(w.page);
      await w.page.locator(".paper-open").first().click();
      await w.page
        .locator('.reading-pdf-page[data-rendered="true"]')
        .first()
        .waitFor();
      await w.page
        .getByRole("button", { name: "收起信息", exact: true })
        .click();
      await w.page
        .getByRole("button", { name: "显示信息", exact: true })
        .click();
      await begin(w.page);
      for (let index = 0; index < 10; index++) {
        await w.page
          .getByRole("button", { name: "收起信息", exact: true })
          .click();
        await w.page
          .getByRole("button", { name: "显示信息", exact: true })
          .click();
      }
      const panels = await end(w.page);
      expect(await w.page.locator(".reader-information").isVisible()).toBe(
        true,
      );
      expect(panels.canvasInsertions).toBeLessThanOrEqual(40);
      const more = w.page.getByRole("button", { name: "更多", exact: true });
      await more.click();
      await w.page
        .getByRole("menuitem", { name: "阅读设置", exact: true })
        .click();
      await w.page
        .getByRole("dialog", { name: "阅读设置", exact: true })
        .waitFor();
      await w.page.keyboard.press("Escape");
      await expect
        .poll(() => more.evaluate((el) => document.activeElement === el))
        .toBe(true);
      await recordReading(`react-motion-${reducedMotion}`, {
        filters,
        panels,
        chromium: w.browser.version(),
        viewport: w.page.viewportSize(),
        scope:
          "warm synthetic 2-row library, 1-page PDF, 10 filter and 20 information-panel transitions; rAF scheduling latency is recorded, not a network completion time",
      });
      // Wall-clock targets are reviewed from the report. The shared CI host
      // is not a calibrated benchmark; HARNESS does not add a timing gate here.
      expect(filters.feedback.length).toBe(20);
      expect(panels.feedback.length).toBe(20);
      expect(w.env.parseCalls).toBe(w.setupCalls.parser);
      expect(w.env.modelCalls).toBe(0);
      expect(w.errors).toEqual([]);
    } finally {
      await w.close();
    }
  },
  90000,
);
