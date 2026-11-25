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
      // Filter conditions open and close at one press on 筛选.
      const filter = {
        click: () => w.page.getByRole("button", { name: /^筛选/ }).click(),
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
      // The paper with its text, wherever the collected order puts it
      // (page specs “文献库”: newest collected first).
      await w.page
        .locator(
          `.paper-row[data-literature-id="${w.env.parseRequest.literature_id}"] .paper-open`,
        )
        .dblclick();
      // A paper with text opens its full text (spec 6.4); this check reads the PDF.
      await w.page.getByRole("tab", { name: "PDF", exact: true }).click();
      await w.page
        .locator('.reading-pdf-page[data-rendered="true"]')
        .first()
        .waitFor();
      // The side panel starts closed (spec 1.4): open, close, open.
      for (const name of ["显示信息", "收起信息", "显示信息"])
        await w.page.getByRole("button", { name, exact: true }).click();
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
      // “排版” sits in “更多” only below 760 px; here “更多” itself opens and closes.
      await w.page
        .getByRole("menuitem", { name: "下载 PDF", exact: true })
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

/** Every running animation per frame, as "kind:properties", while `act` runs. */
async function animationsDuring(page: Page, act: () => Promise<void>) {
  await page.evaluate(() => {
    const seen = new Set<string>();
    let on = true;
    const loop = () => {
      if (!on) return;
      for (const a of document.getAnimations()) {
        const css = a as Animation & { transitionProperty?: string };
        if (css.transitionProperty)
          seen.add(`transition:${css.transitionProperty}`);
        else if (a.effect instanceof KeyframeEffect)
          seen.add(
            `animate:${[
              ...new Set(
                a.effect
                  .getKeyframes()
                  .flatMap((k) =>
                    Object.keys(k).filter(
                      (p) =>
                        ![
                          "offset",
                          "easing",
                          "composite",
                          "computedOffset",
                        ].includes(p),
                    ),
                  ),
              ),
            ].join("+")}`,
          );
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    (window as unknown as { __seen: () => string[] }).__seen = () => {
      on = false;
      return [...seen];
    };
  });
  await act();
  await page.waitForTimeout(400);
  return page.evaluate(() =>
    (window as unknown as { __seen: () => string[] }).__seen(),
  );
}
it.each(["no-preference", "reduce"] as const)(
  "slides the side panel and crossfades the views; reduced motion keeps only colour and opacity (spec 6.1, %s)",
  async (reducedMotion) => {
    const w = await nextWorkspace({ ready: "body" });
    try {
      await w.page.emulateMedia({ reducedMotion });
      await w.page.setViewportSize({ width: 1440, height: 900 });
      const id = w.env.parseRequest.literature_id;
      await w.page.goto(`${w.origin}/?literature=${id}&reader=doc`);
      await w.page
        .locator('.react-reader[data-reading-ready="true"]')
        .waitFor();
      const seen = await animationsDuring(w.page, async () => {
        // Closed at first (spec 1.4): open, then close.
        await w.page
          .getByRole("button", { name: "显示信息", exact: true })
          .click();
        await w.page
          .getByRole("button", { name: "收起信息", exact: true })
          .click();
        await w.page.getByRole("tab", { name: "PDF", exact: true }).click();
        await w.page
          .locator(
            '.reader-view[data-view="pdf"]:not([hidden]) .reading-pdf-page[data-rendered="true"]',
          )
          .first()
          .waitFor();
        await w.page.getByRole("tab", { name: "全文", exact: true }).click();
      });
      const moving = seen.filter((a) =>
        /transform|translate|scale|rotate|clip-path|inset|left|top|width|height|margin/.test(
          a,
        ),
      );
      const colour = seen.filter((a) =>
        /opacity|color|background|filter/.test(a),
      );
      // The views crossfade either way: only opacity animates.
      expect(colour.length, seen.join(" ")).toBeGreaterThan(0);
      if (reducedMotion === "reduce")
        expect(moving, seen.join(" ")).toEqual([]);
      // The side panel slides and the sheet moves with it.
      else
        expect(
          moving.some((a) => a.includes("transform")),
          seen.join(" "),
        ).toBe(true);
      expect(w.errors).toEqual([]);
    } finally {
      await w.close();
    }
  },
  60000,
);

it("keeps the jump target's ground fading under reduced motion, as a colour transition (spec 4.4, 6.1)", async () => {
  const w = await nextWorkspace({ ready: "body" });
  try {
    await w.page.emulateMedia({ reducedMotion: "reduce" });
    await w.page.setViewportSize({ width: 1440, height: 900 });
    const id = w.env.parseRequest.literature_id;
    await w.page.goto(`${w.origin}/?literature=${id}&reader=doc`);
    await w.page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    await w.page
      .locator(".reader-engine-body")
      .click({ position: { x: 5, y: 5 } });
    await w.page.keyboard.press("o");
    // Watch the target block from the jump on: --sel at once, then a
    // background-color transition takes it back.
    await w.page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __jump: string[] }).__jump = seen;
      const loop = () => {
        const block = document.querySelector<HTMLElement>(
          ".reading-jump-flash, .reading-jump-fading",
        );
        if (block) {
          seen.push(block.className.includes("fading") ? "fading" : "flash");
          for (const a of block.getAnimations())
            seen.push(
              `${(a as Animation & { transitionProperty?: string }).transitionProperty ?? "keyframes"}`,
            );
        }
        if (seen.length < 400) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    await w.page.locator(".reader-outline button").last().click();
    await expect
      .poll(() =>
        w.page.evaluate(
          () => (window as unknown as { __jump: string[] }).__jump,
        ),
      )
      .toEqual(expect.arrayContaining(["flash", "fading", "background-color"]));
    const seen = await w.page.evaluate(
      () => (window as unknown as { __jump: string[] }).__jump,
    );
    expect(seen).not.toContain("keyframes");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
