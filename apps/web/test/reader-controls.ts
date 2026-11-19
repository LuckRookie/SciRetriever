import type { Page } from "playwright";

/**
 * The reader page's top bar (reading-experience 1.3): its menus and the PDF
 * page jump in the page header (1.2), as tests reach them.
 */
export async function readerMore(page: Page, item: string | RegExp) {
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page
    .getByRole(
      "menuitem",
      typeof item === "string" ? { name: item, exact: true } : { name: item },
    )
    .click();
}
/** The “排版” panel (plan 25 block 30), opened from its button or, below 760 px, from “更多”. */
export async function openType(page: Page) {
  const panel = page.getByRole("dialog", { name: "排版", exact: true });
  if (await panel.isVisible()) return panel;
  const type = page.getByRole("button", { name: "排版", exact: true });
  // The reader's controls are in the top bar once “更多” is.
  await page.getByRole("button", { name: "更多", exact: true }).waitFor();
  if (await type.isVisible()) await type.click();
  else {
    // Below 760 px “排版” is in “更多” (spec 1.3).
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("menuitem", { name: "排版", exact: true }).click();
  }
  await panel.waitFor();
  return panel;
}
/** The scale the panel shows: “110%”, “适合宽度”. */
const scaleValue = async (page: Page) =>
  (
    await page
      .getByRole("dialog", { name: "排版", exact: true })
      .locator(".reader-type-scale-value")
      .innerText()
  ).trim();
/** Waits for a condition the page reaches (no test runner needed: the sample scripts use this too). */
async function until(condition: () => Promise<boolean>, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("排版 did not settle");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
/** Closes the panel when it is open. */
async function closeType(page: Page) {
  const panel = page.getByRole("dialog", { name: "排版", exact: true });
  for (let i = 0; i < 3 && (await panel.isVisible()); i++)
    await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
}
/**
 * “排版”: a switch or a button by name, or a reading scale reached the way
 * a person does (reading-experience 1.3, 1.8.1): a reading size ("24 px",
 * 20 px is 100%) or a PDF zoom ("150%") by pressing 放大 or 缩小 until the
 * panel says it; the panel stays open meanwhile and closes after.
 */
export async function readerType(page: Page, item: string) {
  const panel = await openType(page);
  const px = /^(\d+) px$/u.exec(item),
    percent = /^(\d+)%$/u.exec(item);
  if (!px && !percent) {
    // A switch is pressed on its label, as a person does.
    const control = panel
      .locator(".ui-choice", { hasText: item })
      .or(panel.getByRole("button", { name: item, exact: true }))
      .or(panel.getByRole("tab", { name: item, exact: true }))
      .or(panel.getByRole("radio", { name: item, exact: true }));
    await control.first().click();
    await closeType(page);
    return;
  }
  const wanted = px ? Number(px[1]) * 5 : Number(percent![1]);
  // From 适合宽度 the steps start at 100%.
  if ((await scaleValue(page)).includes("适合宽度")) {
    await panel.getByRole("button", { name: "实际大小", exact: true }).click();
    await until(async () => (await scaleValue(page)) === "100%");
  }
  for (let i = 0; i < 60; i++) {
    const now = Number(/(\d+)%/u.exec(await scaleValue(page))?.[1]);
    if (now === wanted) break;
    await panel
      .getByRole("button", {
        name: now < wanted ? "放大" : "缩小",
        exact: true,
      })
      .click();
    await until(
      async () => Number(/(\d+)%/u.exec(await scaleValue(page))?.[1]) !== now,
    );
  }
  await closeType(page);
}
/** The scale in force, as “排版” writes it: “比例 110%”, “比例 适合宽度”. */
export async function readerTypeChoice(page: Page) {
  await openType(page);
  const value = await scaleValue(page);
  await closeType(page);
  return `比例 ${value}`;
}
/**
 * A tool of the top bar by its name (“显示目录”, “进入专注模式”); below 760 px
 * it is in “更多” (plan 25 block 30).
 */
export async function readerTool(page: Page, name: string) {
  await page.getByRole("button", { name: "更多", exact: true }).waitFor();
  const button = page
    .locator(".reader-topbar-tools")
    .getByRole("button", { name, exact: true });
  if (await button.isVisible()) await button.click();
  else await readerMore(page, name);
}
/** Opens a PDF page through the page number in the page header. */
export async function readerGoToPage(page: Page, n: number) {
  await page
    .locator(
      ".reader-engine:not([hidden]) .reader-view:not([hidden]) .reader-page-header-page",
    )
    .click();
  const field = page.getByRole("spinbutton", { name: "PDF 页码", exact: true });
  await field.fill(String(n));
  await field.press("Enter");
}
/** The PDF page the page header shows. */
export async function readerPageNumber(page: Page) {
  const text = await page
    .locator(
      ".reader-engine:not([hidden]) .reader-view:not([hidden]) .reader-page-header-page",
    )
    .innerText();
  return Number(/第\s*(\d+)/u.exec(text)?.[1] ?? Number.NaN);
}
/** Chooses a view: its tab, or below 640 px the views button's menu (spec 1.3). */
export async function readerView(page: Page, name: "原文" | "PDF") {
  const tab = page.getByRole("tab", { name, exact: true });
  await page.getByRole("button", { name: "更多", exact: true }).waitFor();
  if (await tab.isVisible()) return tab.click();
  await page.getByRole("button", { name: /^视图：/ }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
/**
 * The shown full text is loaded to its end: the row that loads more under the
 * text is gone (the reader page has no status bar, spec 1).
 */
export async function readerTextComplete(page: Page) {
  const tail = page.locator(
    ".reader-engine:not([hidden]) .reader-view:not([hidden]) .reading-continuation",
  );
  return (
    (await tail.count()) === 1 &&
    (await tail.evaluate((el) => (el as HTMLElement).hidden))
  );
}
/** Opens the reader page's navigation drawer (spec 1.3). */
export async function readerNavigation(page: Page) {
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  return page.getByRole("dialog", { name: "导航" });
}
/** Leaves the reader for the library through the navigation drawer. */
export async function readerToLibrary(page: Page) {
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page
    .getByRole("dialog", { name: "导航" })
    .getByRole("button", { name: /^文献库/ })
    .first()
    .click();
}
/**
 * Opens the side panel (reading-experience 1.4: closed by default) unless
 * it is open, and shows one of its tabs.
 */
export async function readerPanel(
  page: Page,
  tab: "信息" | "批注" | "关联" | "翻译" = "信息",
) {
  const open = page.getByRole("button", { name: "显示信息", exact: true });
  await page.getByRole("button", { name: "更多", exact: true }).waitFor();
  if (await open.isVisible()) await open.click();
  else if (
    !(await page
      .getByRole("button", { name: "收起信息", exact: true })
      .isVisible())
  ) {
    // Below 760 px it is in “更多” (spec 1.3).
    await page.getByRole("button", { name: "更多", exact: true }).click();
    const item = page.getByRole("menuitem", { name: "显示信息", exact: true });
    if (await item.count()) await item.click();
    else await page.keyboard.press("Escape");
  }
  const panel = page.getByRole("complementary", { name: "右侧面板" });
  await panel.waitFor();
  const tabs = panel.getByRole("tab", { name: new RegExp(`^${tab}`) });
  if (await tabs.count()) await tabs.first().click();
  return panel;
}
