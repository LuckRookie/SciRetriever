import { expect, it } from "vitest";
import type { Locator, Page } from "playwright";
import { parseFolderNode } from "@sciretriever/contracts";
import { nextWorkspace } from "./next-workspace-fixture.js";

/** Whether `target` lies wholly inside the window. */
const inWindow = async (page: Page, target: Locator) => {
  const box = (await target.boundingBox())!;
  const { height, width } = page.viewportSize()!;
  return (
    box.y >= 0 && box.y + box.height <= height && box.x >= 0 && box.x <= width
  );
};
/** Scrolls an element to its end and says whether there was anything to scroll. */
const scrollToEnd = (target: Locator) =>
  target.evaluate((el) => {
    const scrolls = el.scrollHeight > el.clientHeight;
    el.scrollTop = el.scrollHeight;
    return scrolls;
  });

it("keeps the navigation scrollable in a short window, with “设置” in view and usable: sidebar, narrow drawer and reader drawer", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    const app = w.env.app;
    // More folders than a short window holds.
    for (let n = 1; n <= 24; n++)
      parseFolderNode(
        await app.folders.manage({
          operation: "create",
          request: { name: `文件夹 ${String(n).padStart(2, "0")}` },
        }),
      );
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.reload();
    const aside = page.getByRole("complementary", { name: "主导航" });
    await aside.getByRole("button", { name: /^文件夹 24/u }).waitFor();
    // The sidebar: the library and its folders scroll inside the window; the
    // pages below them, “设置” last, stay in view and can be pressed.
    const content = aside.locator(".navigation-content");
    expect(await scrollToEnd(content)).toBe(true);
    const settings = aside.getByRole("button", { name: "设置", exact: true });
    expect(await inWindow(page, settings)).toBe(true);
    expect(
      await inWindow(page, aside.getByRole("button", { name: /^任务/u })),
    ).toBe(true);
    expect(
      await inWindow(page, aside.getByRole("button", { name: /^文件夹 24/u })),
    ).toBe(true);
    await settings.click({ trial: true });
    await settings.click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("view"))
      .toBe("set");

    // The narrow drawer: scrolled to its end, “设置” is in view and works.
    await page.goto(`${w.origin}/`);
    await page.setViewportSize({ width: 390, height: 600 });
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "导航" });
    await drawer.getByRole("button", { name: /^文件夹 24/u }).waitFor();
    await scrollToEnd(page.locator(".ui-drawer"));
    const drawerSettings = drawer.getByRole("button", {
      name: "设置",
      exact: true,
    });
    expect(await inWindow(page, drawerSettings)).toBe(true);
    await drawerSettings.click({ trial: true });

    // The reader's drawer in a short window: the same.
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto(
      `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=pdf`,
    );
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    const readerDrawer = page.getByRole("dialog", { name: "导航" });
    await readerDrawer.getByRole("button", { name: /^文件夹 24/u }).waitFor();
    await scrollToEnd(page.locator(".ui-drawer"));
    const readerSettings = readerDrawer.getByRole("button", {
      name: "设置",
      exact: true,
    });
    expect(await inWindow(page, readerSettings)).toBe(true);
    await readerSettings.click({ trial: true });
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);
