import { expect, it } from "vitest";
import type { Page } from "playwright";
import {
  nextWorkspace,
  openFilterConditions,
} from "./next-workspace-fixture.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";

/** The labels of the open menu, “[组]” for a group title. */
async function menuContent(page: Page) {
  const menu = page.getByRole("menu");
  await menu.waitFor();
  return menu
    .locator(".ui-menu-heading, .ui-menu-item")
    .evaluateAll((items) =>
      items.map((item) =>
        item.classList.contains("ui-menu-heading")
          ? `[${(item.textContent ?? "").trim()}]`
          : `${(item.querySelector('[slot="label"]')?.textContent ?? "").trim()}${
              item.getAttribute("aria-disabled") === "true" ? "（停用）" : ""
            }`,
      ),
    );
}
const ready = FIXTURE_LITERATURE.metadata.title!;
const query = (page: Page) =>
  JSON.parse(new URL(page.url()).searchParams.get("query") ?? "{}");

it("has one top bar above every page and no “活动” panel; on a narrow screen its button opens the navigation as a drawer (page specs “顶栏”“开合”)", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    await page.getByRole("heading", { level: 1, name: "文献库" }).waitFor();
    expect(await page.locator(".workspace-header.top-bar").count()).toBe(1);
    // The first tab names the page outside the reader and is the current one.
    expect(
      await page
        .locator(".workspace-tab")
        .getByRole("button", { name: "文献库", exact: true })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(await page.getByRole("button", { name: /^活动/u }).count()).toBe(0);
    // The page header is the first thing in the content area, under the bar.
    expect(
      await page.evaluate(
        () =>
          document.querySelector(".workspace-content")!.getBoundingClientRect()
            .top -
          document.querySelector(".top-bar")!.getBoundingClientRect().bottom,
      ),
    ).toBe(0);
    // Wide: the sidebar is docked, and the bar's button puts it away and back
    // without reloading the page.
    const nav = page.getByRole("complementary", { name: "主导航" });
    await nav.waitFor();
    await page.getByRole("button", { name: "收起导航", exact: true }).click();
    await nav.waitFor({ state: "detached" });
    expect(await page.locator(".paper-row").count()).toBeGreaterThan(0);
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await nav.waitFor();
    // Narrow: the same button opens the navigation as a drawer.
    await page.setViewportSize({ width: 390, height: 844 });
    await nav.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "导航" });
    await drawer.getByRole("button", { name: /^任务/u }).click();
    await page.getByRole("heading", { level: 1, name: "任务" }).waitFor();
    // The drawer closed with the move, and the first tab names the new page.
    await drawer.waitFor({ state: "detached" });
    await page
      .locator(".workspace-tab")
      .getByRole("button", { name: "任务", exact: true })
      .waitFor();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("keeps the toolbar on one line and leaves the search words out of the filter conditions (plan 25 block 29)", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    // The tools sit at the right of the title's line (page specs “工具条”).
    const toolbar = page.locator(".library-toolbar-actions");
    const filter = toolbar.getByRole("button", { name: /^筛选/u });
    expect(await filter.textContent()).toBe("筛选");
    // “排序：最近加入”, “显示：列表 / 表格”, 批量操作.
    expect(
      await toolbar
        .getByRole("button", { name: /排序/u })
        .and(page.locator('[aria-haspopup="listbox"]'))
        .textContent(),
    ).toBe("排序：最近加入");
    const display = toolbar.locator(".library-display");
    expect(await display.innerText()).toMatch(/^显示\s*列表\s*表格$/u);
    const batch = toolbar.getByRole("button", {
      name: "批量操作",
      exact: true,
    });
    await batch.waitFor();
    // A toolbar's menu trigger keeps the ink of “筛选”; only inline text
    // actions take the pen's colour (design core rule 10).
    const colour = (button: typeof batch) =>
      button.evaluate((el) => getComputedStyle(el).color);
    expect(await colour(batch)).toBe(await colour(filter));
    const tops = await toolbar
      .locator(
        ".library-filter-toggle, .ui-select, .library-display, .ui-button:last-child",
      )
      .evaluateAll((items) =>
        items.map((item) => Math.round(item.getBoundingClientRect().top)),
      );
    expect(new Set(tops).size).toBe(1);
    // Searching: the words stay in the box, no chip, no count on 筛选.
    // The library is searched from the box at its top (page specs “搜索框”).
    const count = page.locator(".ui-page-header .ui-page-count");
    await expect.poll(() => count.textContent()).toBe("共 2 篇");
    const band = page.getByRole("searchbox", { name: "搜索文献" });
    await band.fill("Unparsed");
    await band.press("Enter");
    await expect.poll(() => count.textContent()).toBe("1 篇符合");
    expect(
      await page.getByRole("searchbox", { name: "搜索文献" }).inputValue(),
    ).toBe("Unparsed");
    expect(query(page)).toMatchObject({ text: "Unparsed" });
    expect(await page.locator(".library-applied").count()).toBe(0);
    expect(await filter.textContent()).toBe("筛选");
    // A real condition is counted, and its one “清除” keeps the search.
    await openFilterConditions(page);
    await page
      .getByRole("textbox", { name: "年份起", exact: true })
      .fill("2000");
    await page.keyboard.press("Enter");
    await expect.poll(() => filter.textContent()).toBe("筛选 · 1");
    const applied = page.locator(".library-applied");
    expect(await applied.innerText()).not.toContain("搜索");
    // One “清除” in words (the search box's own ✕ clears only the words).
    expect(
      await page
        .getByRole("button", { name: /^清除/u })
        .filter({ hasText: /清除/u })
        .allTextContents(),
    ).toEqual(["清除"]);
    await applied.getByRole("button", { name: "清除", exact: true }).click();
    await expect.poll(() => filter.textContent()).toBe("筛选");
    expect(query(page)).toMatchObject({ text: "Unparsed" });
    expect(query(page).publication_year_from ?? null).toBeNull();
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("opens the conditions at one press: author, journal, years and tag first, the rest in “更多条件”, saving in the panel's menu (plan 25 block 29)", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    const filter = page
      .locator(".library-toolbar-actions")
      .getByRole("button", {
        name: /^筛选/u,
      });
    expect(await filter.getAttribute("aria-expanded")).toBe("false");
    await filter.click();
    // No menu in between: the panel itself.
    expect(await page.getByRole("menu").count()).toBe(0);
    const panel = page.getByRole("form", { name: "筛选条件" });
    await panel.waitFor();
    expect(await filter.getAttribute("aria-expanded")).toBe("true");
    const labels = () =>
      panel
        .locator(
          ".library-filter-grid .ui-label, .library-filter-grid .ui-choice",
        )
        .allInnerTexts();
    expect(await labels()).toEqual([
      "作者",
      "期刊",
      "年份起",
      "年份止",
      "标签（包含下级）",
    ]);
    // “更多条件”: the rest, and the list still in the window under them.
    await panel.getByRole("button", { name: "更多条件", exact: true }).click();
    expect(await labels()).toEqual(
      expect.arrayContaining([
        "关键词",
        "DOI",
        "出版形式",
        "文章性质",
        "标签范围",
        "文本等级",
        "全文和 PDF 自带的文字不一样",
        "含扫描页",
        "书目不全",
      ]),
    );
    const first = page.locator(".paper-row").first();
    const box = (await first.boundingBox())!;
    expect(box.y).toBeLessThan(page.viewportSize()!.height - 40);
    // Saving and exporting are in the menu at the panel's top right.
    await panel
      .getByRole("button", { name: "保存的筛选", exact: true })
      .click();
    expect(await menuContent(page)).toEqual(
      expect.arrayContaining(["保存当前筛选…", "导出筛选"]),
    );
    await page.keyboard.press("Escape");
    // A second press closes it.
    await filter.click();
    await panel.waitFor({ state: "detached" });
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("lists only what a paper can use in its menu, by what it has, and the same on right-click (plan 25 block 29)", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    const row = (title: string) =>
      page.getByRole("article", { name: title, exact: true });
    // A paper with its full text: nothing to fetch or to generate.
    await row(ready).hover();
    await row(ready)
      .getByRole("button", { name: "文献操作", exact: true })
      .click();
    expect(await menuContent(page)).toEqual([
      "加入文件夹…",
      "导出书目",
      "扩展引用…",
      "[加工]",
      "运行算子…",
    ]);
    await page.keyboard.press("Escape");
    // Only a bibliography: 获取 PDF first; what needs a PDF or a full text
    // stays, disabled, and says why.
    await row("Unparsed source").hover();
    await row("Unparsed source")
      .getByRole("button", { name: "文献操作", exact: true })
      .click();
    expect(await menuContent(page)).toEqual([
      "获取 PDF",
      "生成全文（停用）",
      "加入文件夹…",
      "导出书目",
      "扩展引用…",
      "[加工]",
      "运行算子…（停用）",
    ]);
    const menu = page.getByRole("menu");
    expect(await menu.innerText()).toContain("需要先有 PDF");
    expect(await menu.innerText()).toContain("需要先有全文");
    await page.keyboard.press("Escape");
    // Right-click opens the same menu at the pointer; “导出书目” acts on the row.
    await row("Unparsed source")
      .locator(".paper-citation")
      .click({ button: "right" });
    expect(await menuContent(page)).toEqual([
      "获取 PDF",
      "生成全文（停用）",
      "加入文件夹…",
      "导出书目",
      "扩展引用…",
      "[加工]",
      "运行算子…（停用）",
    ]);
    await page.getByRole("menuitem", { name: "导出书目", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    expect(await dialog.innerText()).toContain("范围已固定：1 篇文献。");
    await page.keyboard.press("Escape");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("shows a table display that selects, sorts by its heads and is remembered in this browser (plan 25 block 29)", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    await page.getByRole("tab", { name: "表格", exact: true }).click();
    const table = page.getByRole("table", { name: "文献列表" });
    await table.waitFor();
    const heads = await table
      .getByRole("columnheader")
      .evaluateAll((items) =>
        items.map((item) => (item.textContent ?? "").replace(/[↑↓]/gu, "")),
      );
    expect(heads.filter(Boolean)).toEqual([
      "标题",
      "作者",
      "期刊",
      "年份",
      "材料",
    ]);
    const rows = table.locator('.paper-row[data-display="table"]');
    await expect.poll(() => rows.count()).toBe(2);
    for (const height of await rows.evaluateAll((items) =>
      items.map((item) => item.getBoundingClientRect().height),
    ))
      expect(height).toBe(32);
    // Only title and year sort: the service has those orders.
    const sortable = await table
      .getByRole("columnheader")
      .evaluateAll((items) =>
        items
          .filter((item) => item.querySelector("button"))
          .map((item) => (item.textContent ?? "").replace(/[↑↓]/gu, "")),
      );
    expect(sortable).toEqual(["标题", "年份"]);
    const head = (name: string) =>
      table.getByRole("columnheader", { name: new RegExp(`^${name}`) });
    await head("标题").getByRole("button").click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("sort"))
      .toBe("title-asc");
    expect(await head("标题").getAttribute("aria-sort")).toBe("ascending");
    await head("标题").getByRole("button").click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("sort"))
      .toBe("title-desc");
    expect(await head("标题").getAttribute("aria-sort")).toBe("descending");
    await head("年份").getByRole("button").click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("sort"))
      .toBe("publication-year-desc");
    expect(await head("年份").getAttribute("aria-sort")).toBe("descending");
    expect(await head("标题").getAttribute("aria-sort")).toBe("none");
    // The materials column: a status only where it departs from 只有书目.
    const material = (title: string) =>
      table
        .getByRole("row", { name: title, exact: true })
        .getByRole("cell")
        .nth(5);
    expect(await material(ready).innerText()).toBe("有全文");
    expect(await material("Unparsed source").innerText()).toBe("");
    // The selection is the list's: keyboard, Shift+click, the bar.
    const box = (title: string) =>
      table.getByRole("checkbox", { name: `选择 ${title}`, exact: true });
    await box(ready).focus();
    await page.keyboard.press("Space");
    await page.keyboard.down("Shift");
    await box("Unparsed source").click({ force: true });
    await page.keyboard.up("Shift");
    const bar = page.getByRole("region", { name: "文献选择" });
    await expect.poll(() => bar.locator("b").textContent()).toBe("已选 2 篇");
    expect(
      await table
        .getByRole("checkbox", { name: "全选已加载", exact: true })
        .isChecked(),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await bar.waitFor({ state: "detached" });
    // Remembered here: the table again after a reload, the list once chosen.
    await page.reload();
    await table.waitFor();
    expect(
      await page.evaluate(() =>
        localStorage.getItem(
          "sciretriever:react:sciretriever:library:display:v1",
        ),
      ),
    ).toBe("table");
    // Opening reads the paper, as from the list.
    await table
      .getByRole("row", { name: ready, exact: true })
      .locator(".paper-open")
      .dblclick();
    await page.locator(".reader-workspace").waitFor();
    await page.goBack();
    await table.waitFor();
    await page.getByRole("tab", { name: "列表", exact: true }).click();
    await page.getByRole("article", { name: ready, exact: true }).waitFor();
    expect(await page.getByRole("table", { name: "文献列表" }).count()).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("shows the current row in the right column without a veil, steps with ↑ ↓, shows its bibliography and folds away (page specs “右栏”)", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    // Wide, the column is there from the start, on the first row.
    const preview = page.getByRole("region", { name: "文献预览", exact: true });
    await preview.waitFor();
    expect(
      await page.getByRole("button", { name: "预览", exact: true }).count(),
    ).toBe(0);
    // No veil, no modal: the rows stay pressable.
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(await page.locator(".ui-overlay, .ui-drawer").count()).toBe(0);
    const first = await page
      .locator(".paper-row")
      .first()
      .getAttribute("aria-label");
    await preview.getByRole("heading", { name: first!, exact: true }).waitFor();
    // Nothing of the list lies under it on a wide screen.
    const panel = (await preview.boundingBox())!;
    const list = (await page.locator(".library-scroll").boundingBox())!;
    expect(list.x + list.width).toBeLessThanOrEqual(panel.x);
    // ↓ moves to the next paper, ↑ back.
    await page.keyboard.press("ArrowDown");
    const second = await page
      .locator(".paper-row")
      .nth(1)
      .getAttribute("aria-label");
    await preview
      .getByRole("heading", { name: second!, exact: true })
      .waitFor();
    expect(
      await page
        .locator(".paper-row[data-previewed]")
        .getAttribute("aria-label"),
    ).toBe(second);
    await page.keyboard.press("ArrowUp");
    await preview.getByRole("heading", { name: first!, exact: true }).waitFor();
    // One press on a row makes it the current one, on its title too; it
    // does not open the paper (page specs “当前行”).
    const other = page.getByRole("article", { name: second!, exact: true });
    await other.locator(".paper-open").click();
    await preview
      .getByRole("heading", { name: second!, exact: true })
      .waitFor();
    expect(new URL(page.url()).searchParams.has("literature")).toBe(false);
    await page
      .getByRole("article", { name: first!, exact: true })
      .locator(".paper-citation")
      .click();
    await preview.getByRole("heading", { name: first!, exact: true }).waitFor();
    await other.locator(".paper-citation").click();
    expect(new URL(page.url()).searchParams.has("literature")).toBe(false);
    await preview
      .getByRole("heading", { name: second!, exact: true })
      .waitFor();
    // The bibliography: kind and year, authors, source, abstract, material,
    // 打开阅读; 获取 PDF only for a paper without one.
    const unparsed = second === "Unparsed source";
    const text = await preview.innerText();
    expect(text).toContain("期刊论文 · 2026");
    expect(text).toContain("摘要");
    expect(text).toContain("材料");
    await preview
      .getByRole("button", { name: "打开阅读", exact: true })
      .waitFor();
    expect(
      await preview
        .getByRole("button", { name: "获取 PDF", exact: true })
        .count(),
    ).toBe(unparsed ? 1 : 0);
    expect(text).toContain(unparsed ? "只有书目" : "有全文");
    // Esc leaves it; its own button folds it away, the list takes the width,
    // and the toolbar's last button brings it back on the same row.
    await page.keyboard.press("Escape");
    expect(await preview.count()).toBe(1);
    const before = (await page.locator(".library-scroll").boundingBox())!.width;
    await preview
      .getByRole("button", { name: "收起右栏", exact: true })
      .click();
    await preview.waitFor({ state: "detached" });
    expect(
      (await page.locator(".library-scroll").boundingBox())!.width,
    ).toBeGreaterThan(before);
    await page.reload();
    await page.locator(".paper-row").first().waitFor();
    expect(await preview.count()).toBe(0);
    await page.getByRole("button", { name: "显示右栏", exact: true }).click();
    await preview.waitFor();
    // Two presses open the paper; back from it, the column shows that paper.
    await other.locator(".paper-open").dblclick();
    await expect
      .poll(() => new URL(page.url()).searchParams.has("literature"))
      .toBe(true);
    await page.locator(".workspace-tab").getByRole("button").click();
    await preview
      .getByRole("heading", { name: second!, exact: true })
      .waitFor();
    expect(
      await page
        .locator(".paper-row[data-previewed]")
        .getAttribute("aria-label"),
    ).toBe(second);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
