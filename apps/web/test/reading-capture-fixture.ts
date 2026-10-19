import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
/** Optional local review evidence; ordinary regression runs do not write screenshots. */
export async function captureReading(page: Page, name: string) {
  const directory = process.env.SCIRETRIEVER_WEB_REVIEW_OUTPUT;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const original = page.viewportSize()!,
    layouts: unknown[] = [];
  for (const [width, height, theme] of [
    [1440, 900, "light"],
    [1280, 800, "dark"],
    [390, 844, "light"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.evaluate(() => document.fonts.ready);
    if (name === "pdf")
      await page.waitForFunction(() => {
        const root = document.querySelector<HTMLElement>(
            ".workspace-page:not([hidden])",
          ),
          body = root?.querySelector<HTMLElement>("#reader-body");
        const page = root?.querySelector<HTMLElement>(
          '.reading-pdf-page[data-rendered="true"]',
        );
        const canvas = page?.querySelector("canvas");
        return (
          !!body &&
          !!page &&
          !!canvas &&
          page.clientWidth <= body.clientWidth &&
          Math.abs(canvas.clientWidth - page.clientWidth) < 2
        );
      });
    await page.screenshot({
      path: join(directory, `${name}-${width}-${theme}.png`),
      animations: "disabled",
    });
    layouts.push(
      await page.evaluate(() => ({
        viewport: innerWidth,
        page: document.documentElement.scrollWidth,
        bodyFont: getComputedStyle(document.body).fontSize,
        article: getComputedStyle(
          document.querySelector(".reading-article") ?? document.body,
        ).fontSize,
      })),
    );
  }
  await writeFile(
    join(directory, `${name}-layout.json`),
    JSON.stringify(layouts, null, 2),
  );
  await page.setViewportSize(original);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
}

export async function recordReading(name: string, value: unknown) {
  const directory =
    process.env.SCIRETRIEVER_READING_METRICS_OUTPUT ??
    process.env.SCIRETRIEVER_WEB_REVIEW_OUTPUT;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${name}.json`),
    JSON.stringify(value, null, 2),
  );
}
