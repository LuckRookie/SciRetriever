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
async function openType(page: Page) {
  const type = page.getByRole("button", { name: "排版", exact: true });
  // The reader's controls are in the top bar once “更多” is.
  await page.getByRole("button", { name: "更多", exact: true }).waitFor();
  if (await type.isVisible()) await type.click();
  else {
    // Below 760 px “排版” is a submenu of “更多” (spec 1.3).
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("menuitem", { name: "排版", exact: true }).click();
  }
}
/** The scale group's title in “排版”: “比例 110%”, “比例 适合宽度”. */
const scaleTitle = (page: Page) =>
  page.locator(".ui-popover .ui-menu-heading").first().innerText();
/**
 * “排版”: an item by name, or a reading scale reached the way a person does
 * (reading-experience 1.3, 1.8.1): a reading size ("24 px", 20 px is 100%)
 * or a PDF zoom ("150%") by pressing 放大 or 缩小 until the group's title
 * says it; the menu stays open meanwhile.
 */
export async function readerType(page: Page, item: string) {
  await openType(page);
  const px = /^(\d+) px$/u.exec(item),
    percent = /^(\d+)%$/u.exec(item);
  if (!px && !percent) {
    await page.getByRole("menuitem", { name: item, exact: true }).click();
    return;
  }
  const wanted = px ? Number(px[1]) * 5 : Number(percent![1]);
  // From 适合宽度 the steps start at 100%.
  if ((await scaleTitle(page)).includes("适合宽度")) {
    await page.getByRole("menuitem", { name: "实际大小" }).click();
    await openType(page);
  }
  for (let i = 0; i < 60; i++) {
    const now = Number(/(\d+)%/u.exec(await scaleTitle(page))?.[1]);
    if (now === wanted) break;
    await page
      .getByRole("menuitem", { name: now < wanted ? "放大" : "缩小" })
      .click();
  }
  await closeMenus(page);
}
/**
 * Escape closes one layer: below 760 px “排版” is a submenu of “更多”, so
 * the second Escape closes “更多” as well.
 */
async function closeMenus(page: Page) {
  for (let i = 0; i < 3 && (await page.locator(".ui-menu").count()); i++)
    await page.keyboard.press("Escape");
}
/** The scale in force, as the title of “排版”'s scale group says it. */
export async function readerTypeChoice(page: Page) {
  await openType(page);
  const value = await scaleTitle(page);
  await closeMenus(page);
  return value.trim();
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
