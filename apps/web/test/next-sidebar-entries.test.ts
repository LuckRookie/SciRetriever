import { expect, it } from "vitest";
import type { Locator, Page } from "playwright";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { missingId } from "./processor-workspace-fixture.js";

/** Plan 25 block 27: the sidebar, the task page's tabs and the menus' order. */

/** A sidebar entry's own name, without the count after it. */
const entryNames = (scope: Locator, selector: string) =>
  scope
    .locator(selector)
    .evaluateAll((items) =>
      items.map((item) =>
        (
          item.querySelector(".ui-button-label")?.firstChild?.textContent ?? ""
        ).trim(),
      ),
    );
const topLevel =
  ".navigation-library > .ui-button, .navigation-footer > .ui-button";

/** The open menu's items, with each group title in brackets. */
async function menuContent(page: Page) {
  const menu = page.getByRole("menu");
  await menu.waitFor();
  return menu
    .locator(".ui-menu-heading, .ui-menu-item")
    .evaluateAll((items) =>
      items.map((item) =>
        item.classList.contains("ui-menu-heading")
          ? `[${(item.textContent ?? "").trim()}]`
          : (item.querySelector('[slot="label"]')?.textContent ?? "").trim(),
      ),
    );
}
async function closeMenu(page: Page) {
  await page.keyboard.press("Escape");
  await page.locator(".ui-menu").waitFor({ state: "detached" });
}

it("keeps the library and its folders above and the other pages fixed below, with “加工” one entrance whose pages are its tabs, the same in the drawer (page specs “整体信息架构”)", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    const nav = page.getByRole("complementary", { name: "主导航" });
    expect(await entryNames(nav, topLevel)).toEqual([
      "文献库",
      "找文献",
      "全文检索",
      "任务",
      "加工",
      "设置",
    ]);
    // No group titles, and the three entries that moved are gone.
    expect(
      await nav.locator(".navigation-group-name").allTextContents(),
    ).toEqual(["文件夹"]);
    // Neither the open papers nor the intake batches hang in the sidebar.
    expect(await nav.getByRole("group", { name: "正在读" }).count()).toBe(0);
    expect(await nav.getByRole("group", { name: "最近入库" }).count()).toBe(0);
    // The library scrolls; the other pages are outside the scrolling part.
    expect(
      await nav.locator(".navigation-content .navigation-footer").count(),
    ).toBe(0);
    for (const name of ["最近入库", "需处理", "浏览器", "资料", "运行"])
      expect(
        await nav.getByRole("button", { name, exact: true }).count(),
        name,
      ).toBe(0);
    // 找文献 is in the sidebar, not in the library's header.
    expect(
      await page
        .locator(".ui-page-header")
        .getByRole("button", { name: "找文献" })
        .count(),
    ).toBe(0);
    // “加工” is one entrance: 算子 opens, and the four pages are its tabs.
    const entrance = nav.getByRole("button", { name: "加工", exact: true });
    expect(await nav.getByRole("button", { name: "算子" }).count()).toBe(0);
    await entrance.click();
    await page.getByRole("heading", { level: 1, name: "加工" }).waitFor();
    const tabs = page.getByRole("tablist", { name: "加工视图" });
    expect(await tabs.getByRole("tab").allTextContents()).toEqual([
      "算子",
      "快照",
      "标签词表",
      "洞察",
    ]);
    expect(new URL(page.url()).searchParams.get("view")).toBe("ext");
    expect(await entrance.getAttribute("aria-current")).toBe("page");
    // Each tab is its own address; the entrance stays current on all four.
    for (const [name, view] of [
      ["快照", "snapshots"],
      ["标签词表", "tags"],
      ["洞察", "ins"],
    ] as const) {
      await tabs.getByRole("tab", { name, exact: true }).click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get("view"))
        .toBe(view);
      expect(
        await tabs
          .getByRole("tab", { name, exact: true })
          .getAttribute("aria-selected"),
      ).toBe("true");
      expect(await entrance.getAttribute("aria-current")).toBe("page");
    }
    await page.goBack();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("view"))
      .toBe("tags");
    // The reader's drawer and the narrow drawer hold the same sidebar.
    await page.goto(`${w.origin}/?literature=${missingId}&reader=pdf`);
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    const readerDrawer = page.getByRole("dialog", { name: "导航" });
    await readerDrawer.waitFor();
    expect(await entryNames(readerDrawer, topLevel)).toEqual([
      "文献库",
      "找文献",
      "全文检索",
      "任务",
      "加工",
      "设置",
    ]);
    await page.keyboard.press("Escape");
    await readerDrawer.waitFor({ state: "detached" });
    await page.goto(`${w.origin}/?view=task`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "导航" });
    await drawer.waitFor();
    expect(await entryNames(drawer, topLevel)).toEqual([
      "文献库",
      "找文献",
      "全文检索",
      "任务",
      "加工",
      "设置",
    ]);
    expect(
      await drawer
        .getByRole("button", { name: /^任务/u })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("puts 需处理, 浏览器 and Agent 会话 in the task page's tabs; old addresses open them and Back returns through them", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    const nav = page.getByRole("complementary", { name: "主导航" });
    const tasks = nav.getByRole("button", { name: /^任务/u });
    await tasks.click();
    const tablist = page.getByRole("tablist", { name: "任务视图" });
    // The task page loads on first visit.
    await tablist.waitFor();
    expect(await tablist.getByRole("tab").allTextContents()).toEqual([
      "任务",
      "需处理",
      "浏览器",
      "Agent 会话",
      "来源统计",
    ]);
    // Underlined tabs, not a segmented control (design core “组件外观”).
    expect(
      await page.locator(".ui-tabs").filter({ has: tablist }).count(),
    ).toBe(1);
    expect(
      await page
        .getByRole("group", { name: "任务状态" })
        .getByRole("button")
        .allTextContents(),
    ).toEqual(["全部", "进行中", "有问题", "已结束"]);
    const selected = () =>
      tablist.getByRole("tab", { selected: true }).textContent();
    const view = () => new URL(page.url()).searchParams.get("view");
    for (const [old, tab] of [
      ["archive", "需处理"],
      ["web", "浏览器"],
      ["agent", "Agent 会话"],
    ] as const) {
      await page.goto(`${w.origin}/?view=${old}`);
      await expect.poll(selected).toBe(tab);
      expect(
        await page.getByRole("heading", { level: 1 }).allTextContents(),
      ).toEqual(["任务"]);
      expect(await tasks.getAttribute("aria-current")).toBe("page");
    }
    await page.goto(`${w.origin}/?view=task`);
    await expect.poll(selected).toBe("任务");
    await tablist.getByRole("tab", { name: "需处理" }).click();
    await expect.poll(view).toBe("archive");
    await page
      .getByLabel("需处理的问题列表")
      .or(page.locator(".archive-empty"))
      .waitFor();
    await tablist.getByRole("tab", { name: "浏览器" }).click();
    await expect.poll(view).toBe("web");
    await page.getByRole("button", { name: "刷新会话", exact: true }).waitFor();
    await page.goBack();
    await expect.poll(view).toBe("archive");
    await expect.poll(selected).toBe("需处理");
    await page.goBack();
    await expect.poll(view).toBe("task");
    await expect.poll(selected).toBe("任务");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("writes “n 进行中 · m 需处理” beside 任务, leaving out a zero", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    let running = 1,
      issues = 12;
    await page.route("**/api/tasks?*", (route) =>
      new URL(route.request().url()).searchParams.get("status_group") ===
      "active"
        ? route.fulfill({
            json: {
              tasks: Array.from({ length: running }, (_, n) => ({
                job_id: `00000000-0000-4000-8000-00000000001${n}`,
                status: "running",
                selector: {
                  goal: "pdf",
                  selector: {
                    kind: "literatures",
                    literature_ids: [missingId],
                  },
                },
                created_at: "2026-11-19T00:00:00.000Z",
              })),
              next_cursor: null,
            },
          })
        : route.continue(),
    );
    // Only the sidebar's count is answered here; the tab's list is left alone.
    await page.route("**/api/v1/query/archive*", async (route) => {
      const body = route.request().postDataJSON() as {
        request?: { operation?: string };
      };
      if (body.request?.operation !== "issue-count") return route.continue();
      await route.fulfill({
        json: { protocol_version: 1, result: { total_count: issues } },
      });
    });
    await page.reload();
    const tasks = page
      .getByRole("complementary", { name: "主导航" })
      .getByRole("button", { name: /^任务/u });
    await expect
      .poll(() => tasks.textContent(), { timeout: 15_000 })
      .toBe("任务1 进行中 · 12 需处理");
    running = 0;
    await expect
      .poll(() => tasks.textContent(), { timeout: 15_000 })
      .toBe("任务12 需处理");
    issues = 0;
    await page.reload();
    await page
      .waitForResponse((r) => r.url().includes("/api/v1/query/archive"))
      .catch(() => undefined);
    await expect
      .poll(() => tasks.textContent(), { timeout: 15_000 })
      .toBe("任务");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("makes the first usable of 获取 PDF and 生成全文 the selection bar's primary, none when both are 0, and ends every menu with “加工”", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    const bar = page.getByRole("region", { name: "文献选择" });
    const rows = page.locator(".paper-row");
    await expect.poll(() => rows.count()).toBe(2);
    const missing = page.locator(".paper-row", { hasText: "Unparsed source" });
    const parsed = page
      .locator(".paper-row")
      .filter({ hasNotText: "Unparsed source" });
    // A paper without a PDF: 获取 PDF acts on it and leads.
    await missing.getByRole("checkbox").focus();
    await page.keyboard.press("Space");
    const actions = () =>
      bar
        .locator(".ui-button:not(.selection-group)")
        .evaluateAll((items) =>
          items.map((item) => (item.textContent ?? "").trim()),
        );
    const primary = () =>
      bar
        .locator('.ui-button[data-variant="primary"]')
        .evaluateAll((items) =>
          items.map((item) => (item.textContent ?? "").trim()),
        );
    await bar.waitFor();
    expect((await actions()).filter((text) => text !== "取消选择")).toEqual([
      "获取 PDF 1",
      "生成全文 0",
      "移动…",
      "更多",
    ]);
    expect(await primary()).toEqual(["获取 PDF 1"]);
    // “更多”: 导出…, 删除, then 扩展引用…, 核验文章身份 and the “加工” group.
    await bar.getByRole("button", { name: "更多", exact: true }).click();
    expect(await menuContent(page)).toEqual([
      "导出…",
      "删除 1 篇…",
      "扩展引用…",
      "核验文章身份",
      "[加工]",
      "运行算子 0",
      "生成快照",
    ]);
    await closeMenu(page);
    // A paper with its full text: nothing to fetch or archive, so no primary.
    await page.getByRole("button", { name: "取消选择", exact: true }).click();
    await bar.waitFor({ state: "detached" });
    await parsed.getByRole("checkbox").focus();
    await page.keyboard.press("Space");
    await bar.waitFor();
    expect(await bar.textContent()).toContain("获取 PDF 0");
    expect(await bar.textContent()).toContain("生成全文 0");
    expect(await primary()).toEqual([]);
    await page.getByRole("button", { name: "取消选择", exact: true }).click();
    await bar.waitFor({ state: "detached" });
    // The row's menu: what one does with any paper, then what makes or
    // uses its material.
    await missing.hover();
    await missing
      .getByRole("button", { name: "文献操作", exact: true })
      .click();
    expect(await menuContent(page)).toEqual([
      "打开阅读",
      "移动…",
      "导出…",
      "删除",
      "获取 PDF",
      "生成全文",
      "扩展引用…",
      "运行算子…",
    ]);
    await closeMenu(page);
    // “批量操作” ends the same way.
    await page.getByRole("button", { name: "批量操作", exact: true }).click();
    expect((await menuContent(page)).slice(-3)).toEqual([
      "[加工]",
      "运行算子…",
      "生成快照",
    ]);
    await closeMenu(page);
    // The reader's “⋯”: “加工” is the last group, before the shortcuts.
    await page.goto(`${w.origin}/?literature=${missingId}&reader=pdf`);
    await page.getByRole("button", { name: "更多", exact: true }).click();
    expect((await menuContent(page)).slice(-4)).toEqual([
      "[加工]",
      "运行算子…",
      "加工结果",
      "键盘快捷键",
    ]);
    await closeMenu(page);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
