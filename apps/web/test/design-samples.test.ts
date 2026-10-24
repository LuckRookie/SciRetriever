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
        page.setDefaultTimeout(10000);
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
        await page.close();
      }
    }
  },
);
