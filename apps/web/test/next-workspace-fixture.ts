import type { Locator, Page } from "playwright";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, expect } from "vitest";
import {
  loadReactAssets,
  loadIndependentReactAssets,
} from "../../server/src/workbench/assets.js";
import { workspace } from "./processor-workspace-fixture.js";

let assets: ReturnType<typeof loadReactAssets> | undefined;
let directory: string | undefined;
/** Lets the same browser journeys verify the system reduced-motion preference. */
export function motionOptions(): { reducedMotion?: "reduce" } {
  return process.env.SCIRETRIEVER_REDUCED_MOTION === "reduce"
    ? { reducedMotion: "reduce" }
    : {};
}
/** Production Vite resources, served with the existing authentication and CSP. */
export function nextAssets() {
  assets ??= (async () => {
    directory = await mkdtemp(join(tmpdir(), "sciretriever-next-web-"));
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { buildReactAssets } from './scripts/build-react-assets.mjs'; await buildReactAssets(process.argv[1]);",
        directory,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    return loadReactAssets(pathToFileURL(`${directory}/`));
  })();
  return assets;
}
let probeAssets: ReturnType<typeof loadReactAssets> | undefined;
/** The test build whose reader carries measurement counters (`src/reading/probe.ts`). */
export function readerProbeAssets() {
  probeAssets ??= (async () => {
    const output = await mkdtemp(join(tmpdir(), "sciretriever-reader-probe-"));
    try {
      await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import { buildReactAssets } from './scripts/build-react-assets.mjs'; await buildReactAssets(process.argv[1], { readerProbe: true });",
          output,
        ],
        { maxBuffer: 4 * 1024 * 1024 },
      );
      // Loaded into memory, so the build directory can go at once.
      return await loadReactAssets(pathToFileURL(`${output}/`));
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  })();
  return probeAssets;
}
export async function nextWorkspace(
  options: {
    analysisModel?: boolean;
    /** Serve the reader's test build with its counters. */
    readerProbe?: boolean;
    setup?: Parameters<typeof workspace>[1];
    path?: string;
    ready?: string;
    configuration?: NonNullable<
      Parameters<typeof workspace>[2]
    >["configuration"];
    /** Serve reader translation; false for a deployment without it. */
    translation?: boolean;
  } = {},
) {
  return workspace(options.analysisModel ?? true, options.setup, {
    assets: await (options.readerProbe ? readerProbeAssets() : nextAssets()),
    path: options.path ?? "/",
    ready: options.ready ?? '[aria-label="文献列表"] .paper-row:first-child',
    ...(options.configuration ? { configuration: options.configuration } : {}),
    ...(options.translation === false ? { translation: false } : {}),
  });
}
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

export async function independentNextAssets(kind: "query" | "maintenance") {
  await nextAssets();
  if (!directory) throw new Error("React fixture directory is unavailable");
  return loadIndependentReactAssets(kind, pathToFileURL(`${directory}/`));
}

/**
 * Opens a page of the sidebar's folding “加工” group (算子, 快照, 词表, 洞察),
 * unfolding the group first when it is closed (plan 25 block 27).
 */
export async function openProcessingEntry(scope: Locator, name: string) {
  await scope.getByRole("button", { name: "加工", exact: true }).click();
  // The four pages are tabs of the one page “加工”.
  const tab = scope
    .page()
    .getByRole("tablist", { name: "加工视图" })
    .getByRole("tab", { name, exact: true });
  await tab.click();
  await expect.poll(() => tab.getAttribute("aria-selected")).toBe("true");
}
/** Explicitly reset any active status filter to include raw and imported papers. */
export async function showAllLibraryStatuses(page: Page) {
  await libraryStatus(page, "全部");
}
/** Quick status filters are toggle buttons in the library's sticky toolbar. */
export async function libraryStatus(page: Page, name: string) {
  // Quick filters carry their count after the label, e.g. "有 PDF 3".
  await page
    .locator(".library-status-filters")
    .getByRole("button", { name: statusFilterName(name) })
    .click();
}
export function statusFilterName(name: string) {
  return new RegExp(
    `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: [\\d,]+)?$`,
  );
}
/** Material operations of the reader live in its "更多" menu. */
export async function readerOperation(page: Page, name: string) {
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
/** Run the full-text summary on the open paper through the four-step dialog. */
export async function runSummaryFromReader(page: Page) {
  // The reader's top bar keeps it in “更多” (reading-experience 1.3).
  await readerOperation(page, "运行算子…");
  const dialog = page.getByRole("dialog", { name: "运行算子", exact: true });
  const next = dialog.getByRole("button", { name: "下一步", exact: true });
  await expect.poll(() => next.isEnabled()).toBe(true);
  await next.click();
  await next.click();
  await dialog.getByRole("button", { name: /^运行 [\d,]+ 篇$/u }).click();
}
/** Run an operator on the open snapshot through the four-step dialog. */
export async function runFromSnapshot(
  page: Page,
  operator: string,
  spec?: (dialog: Locator) => Promise<void>,
) {
  await page.getByRole("button", { name: "运行算子…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "运行算子", exact: true });
  await dialog.getByText(operator, { exact: true }).click();
  const next = dialog.getByRole("button", { name: "下一步", exact: true });
  await expect.poll(() => next.isEnabled()).toBe(true);
  await next.click();
  await spec?.(dialog);
  await next.click();
  await dialog.getByRole("button", { name: /^运行 [\d,]+ 篇$/u }).click();
  return dialog;
}
/**
 * “筛选” opens and closes the conditions panel at one press (page specs
 * “文献库”); opens it when it is closed.
 */
export async function openFilterConditions(page: Page) {
  const toggle = page
    .getByRole("button", { name: /^筛选/ })
    .filter({ visible: true })
    .first();
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await page.getByRole("form", { name: "筛选条件" }).waitFor();
}
/** Saved filters are in the menu at the panel's top right; returns the open menu. */
export async function openSavedViews(page: Page) {
  await openFilterConditions(page);
  await page
    .getByRole("form", { name: "筛选条件" })
    .getByRole("button", { name: "保存的筛选", exact: true })
    .click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  return menu;
}
/** Opens “更多条件” in the conditions panel when it is closed. */
export async function openMoreConditions(page: Page) {
  await openFilterConditions(page);
  const more = page.getByRole("button", { name: "更多条件", exact: true });
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
}
/**
 * Selects every loaded row (page specs “勾选框”): in the list “全选已加载” joins
 * once a selection has begun, so the first row is ticked first.
 */
export async function selectAllLoaded(page: Page) {
  const all = page.getByRole("checkbox", { name: "全选已加载", exact: true });
  if (!(await all.count())) {
    const first = page.locator(".paper-row").first().getByRole("checkbox");
    await first.focus();
    await first.press("Space");
    await all.waitFor();
  }
  if (!(await all.isChecked())) {
    await all.focus();
    await all.press("Space");
  }
}
/**
 * Searches as a person does (page specs “搜索框”): from the box that tops the
 * library, or the search page's own; Enter opens the results.
 */
export async function searchLibrary(
  page: Pick<Page, "getByRole">,
  words: string,
) {
  const box = page
    .getByRole("searchbox", { name: "搜索文献", exact: true })
    .first();
  await box.fill(words);
  await box.press("Enter");
}
