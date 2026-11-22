import { designSamplePageCleanup } from "./design-samples-browser.js";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { startDesignSamples } from "./design-samples-fixture.js";
import {
  designSamplePages,
  reachDesignSample,
} from "./design-samples-pages.js";
import { designSamplesAssets } from "./design-samples-assets.js";
import { loginWorkbenchPage } from "../../server/test/workbench-auth-fixture.js";

let samples: Awaited<ReturnType<typeof startDesignSamples>>;
let browser: Browser;
const contexts = new Map<string, BrowserContext>();
const loggedIn = new Set<BrowserContext>();
const password = randomBytes(32).toString("base64url");
beforeAll(async () => {
  const assets = await designSamplesAssets();
  samples = await startDesignSamples({ assets, password });
  browser = await chromium.launch({
    ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
      ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
      : {}),
    headless: true,
  });
}, 0);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await samples?.close();
  }
}, 0);
it("seeds sixty synthetic papers and four real operator flows", async () => {
  const runs = await samples.env.app.database.review<{
    items: {
      outcomes: {
        with_result: number;
        empty: number;
        incomplete: number;
      } | null;
    }[];
  }>("processor-runs", {});
  for (const key of ["with_result", "empty", "incomplete"] as const)
    expect(
      runs.items.some((r) => (r.outcomes?.[key] ?? 0) > 0),
      key,
    ).toBe(true);
  expect(samples.inventory.count).toBe(60);
  expect(samples.inventory.counts.total).toBe(60);
  expect(samples.inventory.counts.statuses.READY).toBeGreaterThan(0);
  expect(samples.inventory.counts.statuses.ARCHIVING).toBe(2);
  expect(samples.inventory.counts.statuses.ARCHIVE_FAILED).toBeGreaterThan(0);
  expect(samples.inventory.counts.statuses.EXCLUDED).toBe(3);
  expect(samples.inventory.counts.unavailable_pdf).toBe(3);
  expect(samples.inventory.snapshots).toHaveLength(3);
  expect(new Set(samples.inventory.results.map((r) => r.processor))).toEqual(
    new Set(["summary", "labels", "records", "knowledge-synthesis"]),
  );
});
it.each(designSamplePages)(
  "reaches $id on desktop and narrow screens without console errors",
  { timeout: 0 },
  async (entry) => {
    for (const width of [1440, 390]) {
      const key = `${width}-${!!entry.anonymous}`;
      const context =
        contexts.get(key) ??
        (await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 900 },
          reducedMotion: "reduce",
          serviceWorkers: "block",
        }));
      contexts.set(key, context);
      const page = await context.newPage();
      const closePage = designSamplePageCleanup(page);
      await page.addInitScript(() => localStorage.clear());
      const errors: string[] = [],
        blocked: string[] = [];
      try {
        await page.route("**/*", async (route) => {
          const origin = new URL(route.request().url()).origin;
          if (origin === samples.origin) return route.continue();
          blocked.push(origin);
          await route.abort("blockedbyclient");
        });
        page.setDefaultTimeout(20_000);
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        if (!entry.anonymous && !loggedIn.has(context)) {
          await loginWorkbenchPage(page, samples.origin, password);
          loggedIn.add(context);
        }
        await reachDesignSample(
          page,
          samples.origin,
          samples.ids,
          entry,
          process.env.SCIRETRIEVER_DESIGN_GALLERY !== "lab",
        );
        expect(errors, `${entry.id}/${width}`).toEqual([]);
        expect(blocked, `${entry.id}/${width}`).toEqual([]);
      } finally {
        await closePage();
      }
    }
  },
);
it("renders publisher inline markup in titles, raw or entity-escaped, as real tags", async () => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    await loginWorkbenchPage(page, samples.origin, password);
    // By title, so the two samples are among the first rows.
    await page.goto(`${samples.origin}/?view=lib&sort=title-asc`);
    const raw = page.locator(".paper-title", { hasText: "[Sample 01]" });
    await raw.waitFor();
    expect(await raw.locator("sub").allTextContents()).toEqual(["6", "5"]);
    expect(await raw.textContent()).toContain("Li6 PS5 Cl");
    const escaped = page.locator(".paper-title", { hasText: "[Sample 02]" });
    expect(await escaped.locator("sup").allTextContents()).toEqual(["3"]);
    expect(await escaped.locator("i").allTextContents()).toEqual(["via"]);
    expect(await escaped.textContent()).not.toMatch(/&lt;|<sup>/);
  } finally {
    await context.close();
  }
});
it("renders the same title markup in a snapshot's member list", async () => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    await loginWorkbenchPage(page, samples.origin, password);
    await page.goto(
      `${samples.origin}/?view=snapshots&snapshot=${samples.ids.snapshot}`,
    );
    const members = page.locator(".snapshot-detail li");
    const raw = members.filter({ hasText: "[Sample 01]" });
    await raw.waitFor();
    expect(await raw.locator("sub").allTextContents()).toEqual(["6", "5"]);
    expect(await raw.textContent()).not.toMatch(/<sub>/);
    const escaped = members.filter({ hasText: "[Sample 02]" });
    expect(await escaped.locator("sup").allTextContents()).toEqual(["3"]);
    expect(await escaped.locator("i").allTextContents()).toEqual(["via"]);
    expect(await escaped.textContent()).not.toMatch(/&lt;|<sup>/);
  } finally {
    await context.close();
  }
});
it(
  "selects runs of papers by dragging the checkbox column and Shift+click, and Esc clears",
  { timeout: 60000 },
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    try {
      await loginWorkbenchPage(page, samples.origin, password);
      await page.goto(`${samples.origin}/?view=lib`);
      const check = async (index: number) => {
        const box = (await page
          .locator(`.paper-row[data-index="${index}"] .paper-check`)
          .boundingBox())!;
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      };
      await page.locator('.paper-row[data-index="4"]').waitFor();
      const bar = page.getByRole("region", { name: "文献选择" });
      const from = await check(0),
        to = await check(3);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 6 });
      await page.mouse.up();
      expect(await bar.locator("b").textContent()).toBe("已选 4 篇");
      // Shift extends from the row where the last press began.
      const end = await check(4);
      await page.keyboard.down("Shift");
      await page.mouse.click(end.x, end.y);
      await page.keyboard.up("Shift");
      expect(await bar.locator("b").textContent()).toBe("已选 5 篇");
      // Starting on a selected row clears the run instead.
      const a = await check(1),
        b = await check(2);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 4 });
      await page.mouse.up();
      expect(await bar.locator("b").textContent()).toBe("已选 3 篇");
      expect(
        await page
          .locator(".paper-row[data-selected]")
          .evaluateAll((rows) =>
            rows.map((row) => Number((row as HTMLElement).dataset.index)),
          ),
      ).toEqual([0, 3, 4]);
      // The bar splits the selection by what each action can act on.
      const counts = await bar.locator(".selection-group").allTextContents();
      expect(counts.length).toBeGreaterThan(0);
      const total = counts
        .map((text) => Number(text.match(/(\d+)$/)?.[1] ?? 0))
        .reduce((sum, n) => sum + n, 0);
      expect(total).toBe(3);
      // Esc right after clicking checkboxes clears the selection.
      await page.keyboard.press("Escape");
      await expect.poll(() => bar.count(), { timeout: 3000 }).toBe(0);
    } finally {
      await context.close();
    }
  },
);
/** A logged-in page on one design sample, at one width. */
async function onSample(id: string, width: number) {
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 900 },
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await loginWorkbenchPage(page, samples.origin, password);
  await reachDesignSample(
    page,
    samples.origin,
    samples.ids,
    designSamplePages.find((entry) => entry.id === id)!,
  );
  return { page, close: () => context.close() };
}
it("keeps each library row's status on a phone screen, under the citation and aligned with the title", async () => {
  for (const id of ["library", "library-selection-mixed"]) {
    const { page, close } = await onSample(id, 390);
    try {
      const rows = await page
        .locator(".paper-row:has(.paper-status)")
        .evaluateAll((rows) =>
          rows.map((row) => {
            const box = (selector: string) =>
              row.querySelector(selector)!.getBoundingClientRect();
            return {
              status: box(".paper-status"),
              title: box(".paper-title").left,
              citation: box(".paper-open").bottom,
            };
          }),
        );
      expect(rows.length, id).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.status.left, id).toBeGreaterThanOrEqual(0);
        expect(row.status.right, id).toBeLessThanOrEqual(390);
        expect(Math.abs(row.status.left - row.title), id).toBeLessThan(1);
        expect(row.status.top, id).toBeGreaterThanOrEqual(row.citation);
      }
    } finally {
      await close();
    }
  }
});
it("sets a draft's doubt word in the left margin below the paragraph number, not over it", async () => {
  const { page, close } = await onSample("reader-draft", 1440);
  try {
    const marks = await page
      .locator(".reading-show-sources section[data-paragraph] > .reading-doubt")
      .evaluateAll((marks) =>
        marks.map((mark) => {
          const section = mark.parentElement!;
          const number = getComputedStyle(section, "::before");
          const top =
            section.getBoundingClientRect().top + parseFloat(number.top);
          const range = document.createRange();
          range.selectNodeContents(mark);
          const word = range.getBoundingClientRect();
          return {
            word: mark.textContent,
            numberBottom: top + parseFloat(number.lineHeight),
            wordTop: word.top,
          };
        }),
      );
    expect(marks.map((m) => m.word)).toEqual(
      expect.arrayContaining(["疑点", "无自带文字"]),
    );
    for (const mark of marks)
      expect(mark.wordTop, mark.word ?? "").toBeGreaterThanOrEqual(
        mark.numberBottom,
      );
  } finally {
    await close();
  }
});
it("keeps an operator result's values flush with their column headers and 字段详情 on one line", async () => {
  const { page, close } = await onSample("result-detail", 1440);
  try {
    const table = page.locator('[aria-label="提取结果"]');
    const geometry = await table.evaluate((table) => {
      const textLeft = (el: Element) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getClientRects()[0]?.left ?? NaN;
      };
      const headers = [...table.querySelectorAll("thead th")].map(textLeft);
      const cells = [...table.querySelectorAll("tbody tr:first-child > td")];
      const coverage = cells.at(-1)!;
      const left = (selector: string) =>
        coverage.querySelector(selector)!.getBoundingClientRect().left;
      // One rect per line of the trigger's words, its chevron left out.
      const words = document.createRange();
      const trigger = coverage.querySelector(".ui-disclosure-trigger")!;
      const text = [...trigger.querySelectorAll("*")]
        .concat(trigger)
        .flatMap((el) => [...el.childNodes])
        .find((node) => node.nodeType === 3 && node.textContent?.trim())!;
      words.selectNodeContents(text);
      return {
        values: cells.flatMap((td, i) =>
          [...td.querySelectorAll(".result-value .ui-button-label")].map(
            (value) => ({ header: headers[i]!, value: textLeft(value) }),
          ),
        ),
        coverage: {
          header: headers[cells.length - 1]!,
          badge: left(".ui-badge"),
          trigger: left(".ui-disclosure-trigger"),
        },
        word: text.textContent,
        lines: new Set(
          [...words.getClientRects()].map((r) => Math.round(r.top)),
        ).size,
      };
    });
    expect(geometry.values.length).toBeGreaterThan(0);
    for (const cell of geometry.values)
      expect(Math.abs(cell.value - cell.header)).toBeLessThan(1);
    expect(
      Math.abs(geometry.coverage.badge - geometry.coverage.header),
    ).toBeLessThan(1);
    expect(
      Math.abs(geometry.coverage.trigger - geometry.coverage.header),
    ).toBeLessThan(1);
    expect(geometry.word).toBe("字段详情");
    expect(geometry.lines).toBe(1);
  } finally {
    await close();
  }
});
