import { captureFeature } from "./next-feature-capture-fixture.js";
import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";

it("explains citation scope and keeps a late graph response from replacing statistics", async () => {
  const w = await nextWorkspace({
    path: `/?view=ins&query=${encodeURIComponent(JSON.stringify({ text: "Unparsed" }))}`,
    ready: ".insights-page",
  });
  let release: () => void = () => {};
  try {
    const page = w.page;
    await page.getByRole("tab", { name: "引用网络", exact: true }).click();
    await expect
      .poll(() => page.locator(".citation-network").textContent())
      .toContain("1 篇起始文献");
    expect(
      await page
        .getByRole("tab", { name: "引用网络", exact: true })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      await page
        .getByRole("tab", { name: "统计", exact: true })
        .getAttribute("aria-selected"),
    ).toBe("false");
    expect(await page.locator(".citation-network").textContent()).toContain(
      "不要求 PDF 已解析或分析",
    );
    expect(await page.locator(".citation-map").count()).toBe(0);
    expect(await page.locator(".ui-empty").textContent()).toContain(
      "不表示全库没有引用",
    );
    await page
      .getByRole("button", { name: "查看整个文献库", exact: true })
      .click();
    await expect
      .poll(() => page.locator(".citation-network").textContent())
      .toContain("2 篇起始文献");
    expect(await page.locator(".citation-network").textContent()).toContain(
      "整个文献库",
    );
    let started: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = new Promise<void>((resolve) => {
      started = resolve;
    });
    await page.route("**/api/v1/query/references?*", async (route) => {
      started();
      await gate;
      await route.continue().catch(() => {});
    });
    await page.getByRole("tab", { name: "包含一跳邻居", exact: true }).click();
    await read;
    await page.getByRole("tab", { name: "统计", exact: true }).click();
    release();
    await page.unrouteAll({ behavior: "wait" });
    expect(await page.locator(".insight-figures").count()).toBe(1);
    expect(
      await page
        .getByRole("tab", { name: "统计", exact: true })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(await page.locator(".citation-network").count()).toBe(0);
    expect(w.env.modelCalls).toBe(0);
    expect(w.env.parseCalls).toBe(w.setupCalls.parser);
    expect(w.errors).toEqual([]);
  } finally {
    release();
    await w.close();
  }
}, 60000);

it("shows one figure per available distribution, switches all figures to tables at once and applies explicit category filters", async () => {
  const w = await nextWorkspace({
    path: "/?view=ins",
    ready: ".insight-figures",
  });
  try {
    const page = w.page;
    await captureFeature(page, "react-insights");
    const figures = page.locator(".insight-figures .ui-figure");
    const titles = await figures.locator(".ui-figure-title").allTextContents();
    expect(titles.slice(0, 2)).toEqual(["年份分布", "材料状态"]);
    expect(await page.getByRole("tab", { name: "表格" }).count()).toBe(0);
    const note = (await page.locator(".ui-page-note").textContent()) ?? "";
    expect(note).toContain("不做推断");
    if (!titles.includes("元数据关键词"))
      expect(note).toContain("暂无关键词元数据");
    const years = figures.filter({ hasText: "年份分布" });
    const columns = await years.locator(".year-column").count();
    expect(columns).toBeGreaterThan(0);
    await page.getByRole("button", { name: "以表格查看", exact: true }).click();
    expect(await figures.getByRole("table").count()).toBe(titles.length);
    expect(
      await years
        .getByRole("table", { name: "年份分布", exact: true })
        .locator("tbody tr")
        .count(),
    ).toBe(columns);
    await page.getByRole("button", { name: "以图表查看", exact: true }).click();
    expect(await years.locator(".year-column").count()).toBe(columns);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Year labels are shown in full on a subset of columns and never overlap.
    const labelBoxes = await years
      .locator(".year-column-label")
      .evaluateAll((labels) =>
        labels
          .filter((label) => label.textContent)
          .map((label) => {
            const box = label.getBoundingClientRect();
            return {
              text: label.textContent!,
              left: box.left,
              right: box.right,
            };
          }),
      );
    expect(labelBoxes.length).toBeGreaterThan(0);
    for (const [index, label] of labelBoxes.entries()) {
      expect(label.text).not.toContain("…");
      if (index > 0)
        expect(label.left).toBeGreaterThan(labelBoxes[index - 1]!.right);
    }
    const year = await years
      .locator(".year-column:not([data-missing]) .year-column-label")
      .first()
      .textContent();
    await years.locator(".year-column:not([data-missing])").first().click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("view"))
      .toBe("lib");
    expect(
      JSON.parse(new URL(page.url()).searchParams.get("query")!),
    ).toMatchObject({
      publication_year_from: Number(year),
      publication_year_to: Number(year),
    });
    expect(w.env.modelCalls).toBe(0);
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("counts “材料状态” in the library's quick-filter categories, with the same numbers (page specs “界面用词”)", async () => {
  const w = await nextWorkspace({
    path: "/?view=ins&scope=all",
    ready: ".insight-figures",
  });
  try {
    const page = w.page;
    await page.getByRole("button", { name: "以表格查看", exact: true }).click();
    const table = page.getByRole("table", { name: "材料状态", exact: true });
    await table.locator("tbody tr").first().waitFor();
    const rows = Object.fromEntries(
      await table
        .locator("tbody tr")
        .evaluateAll((items) =>
          items.map((row) => [
            (row as HTMLTableRowElement).cells[0]!.textContent,
            Number(
              (row as HTMLTableRowElement).cells[1]!.textContent!.replace(
                /,/gu,
                "",
              ),
            ),
          ]),
        ),
    ) as Record<string, number>;
    const categories = [
      "有全文",
      "有 PDF",
      "只有书目",
      "正在生成全文",
      "全文生成失败",
      "没找到 PDF",
      "已排除",
    ];
    expect(Object.keys(rows).every((name) => categories.includes(name))).toBe(
      true,
    );
    // The library's quick filters show the same numbers, adding up to 全部.
    await page.goto(`${w.origin}/?view=lib`);
    const chips = page.locator(".library-status-filters .ui-filter");
    await chips.first().waitFor();
    await expect
      .poll(async () => (await chips.allTextContents()).join("|"))
      .toMatch(/全部 \d/u);
    const quick = Object.fromEntries(
      (await chips.allTextContents()).map((text) => {
        const [, name, count] = /^(.*) ([\d,]+)$/u.exec(text)!;
        return [name!, Number(count!.replace(/,/gu, ""))];
      }),
    ) as Record<string, number>;
    for (const name of ["有全文", "有 PDF", "只有书目"])
      expect(rows[name] ?? 0).toBe(quick[name] ?? 0);
    expect(Object.values(rows).reduce((a, b) => a + b, 0)).toBe(quick["全部"]);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
