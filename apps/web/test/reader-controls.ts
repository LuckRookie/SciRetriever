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
/** “排版”: a reading size ("24 px") or a PDF zoom ("150%", "适合宽度"). */
export async function readerType(page: Page, item: string) {
  const type = page.getByRole("button", { name: "排版", exact: true });
  // The reader's controls are in the top bar once “更多” is.
  await page.getByRole("button", { name: "更多", exact: true }).waitFor();
  if (await type.isVisible()) await type.click();
  else {
    // Below 760 px “排版” is a submenu of “更多” (spec 1.3).
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("menuitem", { name: "排版", exact: true }).click();
  }
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}
/** The checked “排版” item: the reading size or the PDF zoom in force. */
export async function readerTypeChoice(page: Page) {
  await page.getByRole("button", { name: "排版", exact: true }).click();
  const value = await page
    .locator(".ui-menu-item[data-checked]")
    .first()
    .innerText();
  await page.keyboard.press("Escape");
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
