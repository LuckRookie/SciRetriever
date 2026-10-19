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
      .getByRole("button", { name: "查看全部文献库", exact: true })
      .click();
    await expect
      .poll(() => page.locator(".citation-network").textContent())
      .toContain("2 篇起始文献");
    expect(await page.locator(".citation-network").textContent()).toContain(
      "全部文献库",
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
    expect(await page.locator(".insight-charts").count()).toBe(1);
    expect(
      await page
        .getByRole("tab", { name: "统计", exact: true })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(await page.locator(".citation-network").count()).toBe(0);
    expect(w.env.modelCalls).toBe(0);
    expect(w.env.parseCalls).toBe(1);
    expect(w.errors).toEqual([]);
  } finally {
    release();
    await w.close();
  }
}, 60000);

it("offers chart and table views of all four metadata distributions and applies explicit category filters", async () => {
  const w = await nextWorkspace({
    path: "/?view=ins",
    ready: ".insight-charts",
  });
  try {
    const page = w.page;
    await captureFeature(page, "react-insights");
    for (const title of ["年份分布", "元数据关键词", "期刊", "材料状态"]) {
      const area = page.locator(".distribution").filter({
        has: page.getByRole("heading", { name: title, exact: true }),
      });
      const bars = await area.locator(".distribution-bar").count();
      await area.getByRole("tab", { name: "表格", exact: true }).click();
      const table = area.getByRole("table", { name: title, exact: true });
      await table.waitFor();
      expect(await table.locator("tbody tr").count()).toBe(Math.max(1, bars));
      await area.getByRole("tab", { name: "图表", exact: true }).click();
      expect(await area.locator(".distribution-bar").count()).toBe(bars);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    const years = page.locator(".distribution").filter({
      has: page.getByRole("heading", { name: "年份分布", exact: true }),
    });
    const year = await years
      .locator(".distribution-bar")
      .first()
      .locator("span")
      .first()
      .textContent();
    await years.locator(".distribution-bar").first().click();
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
