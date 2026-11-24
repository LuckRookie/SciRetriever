import { parseLiterature } from "@sciretriever/contracts";
import { expect, it } from "vitest";
import type { Page } from "playwright";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";
import { nextWorkspace, selectAllLoaded } from "./next-workspace-fixture.js";
import { missingId } from "./processor-workspace-fixture.js";

const salt = "00000000-0000-0000-0000-000000005201";
const cyclic = (n: number) =>
  `00000000-0000-0000-0000-0000000052${String(10 + n).padStart(2, "0")}`;
const person = (given: string, family: string) => ({
  kind: "person" as const,
  display_name: `${given} ${family}`,
  given_name: given,
  family_name: family,
  orcid: null,
  affiliations: [],
});
/** Two papers beside the fixture's two: one with authors, six to fill a list. */
const setup: NonNullable<Parameters<typeof nextWorkspace>[0]>["setup"] = async (
  env,
) => {
  const paper = (id: string, meta: string, title: string, more = {}) =>
    env.app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: id,
        meta_literature_id: meta,
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title,
          identifiers: [],
          ...more,
        },
      }),
    );
  await paper(
    salt,
    "00000000-0000-0000-0000-000000005202",
    "Nitrogen-rich salt survey",
    {
      publication_year: 2024,
      authors: [person("Ada", "Quill"), person("Ben", "Rook")],
    },
  );
  for (let n = 1; n <= 6; n += 1)
    await paper(
      cyclic(n),
      `00000000-0000-0000-0000-0000000053${String(10 + n).padStart(2, "0")}`,
      `Cyclic seed paper ${n}`,
    );
  // All of them are in hand: the library lists the collected papers
  // (ADR 0065 §2, page specs “文献库”).
  await env.app.database.collectLiteratures([
    salt,
    ...Array.from({ length: 6 }, (_, n) => cyclic(n + 1)),
  ]);
};
/** The listed seeds' titles, in order. */
const listed = (page: Page) =>
  page
    .getByRole("group", { name: "已选的种子文献" })
    .locator("li .literature-picker-title")
    .allTextContents();
const focused = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement?.getAttribute("aria-label") ??
      document.activeElement?.getAttribute("role") ??
      document.activeElement?.tagName,
  );

it("picks citation seeds from the library by search or pasted number, each once and in order, and sends them as seed_literature_ids", async () => {
  const w = await nextWorkspace({
    path: "/?view=disc",
    ready: ".intake-form",
    setup,
  });
  try {
    const page = w.page;
    // The synthetic server is intercepted: this test checks the request the
    // form sends, not the server's acceptance of it.
    const bodies: Record<string, unknown>[] = [];
    await page.route("**/api/discovery?*", async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        json: {
          report: {
            discovery_run_id: "00000000-0000-0000-0000-000000000991",
            status: "COMPLETED",
            accepted_count: 0,
            matched_count: 0,
            source_results: [],
            fixture: true,
          },
        },
      });
    });
    await page.getByRole("tab", { name: "引用扩展", exact: true }).click();
    // No number field: seeds are papers picked from the library (rule 8).
    expect(
      await page.getByRole("textbox", { name: "种子文献 ID" }).count(),
    ).toBe(0);
    const start = page.getByRole("button", { name: "开始扩展", exact: true });
    expect(await start.isDisabled()).toBe(true);
    await page.getByText("先选种子文献", { exact: true }).waitFor();
    const search = page.getByRole("searchbox", {
      name: "种子文献",
      exact: true,
    });
    const options = page
      .getByRole("listbox", { name: "文献候选" })
      .getByRole("option");
    // By title: 标题 · 第一作者 · 年份.
    await search.fill("Nitrogen-rich");
    await expect.poll(() => options.count()).toBe(1);
    expect(await options.first().textContent()).toContain(
      "Ada Quill 等 · 2024",
    );
    await options.first().click();
    const seeds = page.getByRole("group", { name: "已选的种子文献" });
    await seeds.getByText("已选 1 篇", { exact: true }).waitFor();
    expect(await seeds.getByRole("button", { name: "全部移除" }).count()).toBe(
      0,
    );
    expect(await start.isDisabled()).toBe(false);
    expect(await page.getByText("先选种子文献", { exact: true }).count()).toBe(
      0,
    );
    // By keyboard: ↓ from the search goes into the results, Enter picks.
    await search.fill("Unparsed");
    await expect
      .poll(() => options.first().textContent())
      .toContain("Unparsed source");
    await search.focus();
    await page.keyboard.press("ArrowDown");
    expect(await focused(page)).toBe("option");
    await page.keyboard.press("Enter");
    await seeds.getByText("已选 2 篇", { exact: true }).waitFor();
    await seeds.getByRole("button", { name: "全部移除" }).waitFor();
    // A pasted number finds its paper; one already chosen is marked and kept once.
    await search.fill(missingId);
    await expect
      .poll(() => options.first().getAttribute("aria-selected"))
      .toBe("true");
    expect(await options.first().textContent()).toContain("已选");
    await options.first().click();
    await seeds.getByText("已选 2 篇", { exact: true }).waitFor();
    await search.fill(FIXTURE_LITERATURE.literature_id);
    await expect
      .poll(() => options.first().textContent())
      .toContain("Synthetic literature workbench");
    await options.first().click();
    await seeds.getByText("已选 3 篇", { exact: true }).waitFor();
    expect(await listed(page)).toEqual([
      "Nitrogen-rich salt survey",
      "Unparsed source",
      "Synthetic literature workbench",
    ]);
    // Removing one moves focus to the next seed's 移除.
    await seeds
      .getByRole("button", { name: "移除《Unparsed source》" })
      .click();
    await seeds.getByText("已选 2 篇", { exact: true }).waitFor();
    await expect
      .poll(() => focused(page))
      .toBe("移除《Synthetic literature workbench》");
    await start.click();
    const dialog = page.getByRole("dialog", { name: "确认发现文献" });
    await dialog.getByText("处理范围：2 篇种子 · 1 层 · 不限条数").waitFor();
    await dialog.getByRole("button", { name: "开始扩展", exact: true }).click();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]).toEqual({
      kind: "citation",
      seed_literature_ids: [salt, FIXTURE_LITERATURE.literature_id],
      direction: "references",
      max_depth: 1,
    });
    await start.waitFor();
    // 全部移除 empties the list and returns to the search.
    await seeds.getByRole("button", { name: "全部移除" }).click();
    await page.getByText("先选种子文献", { exact: true }).waitFor();
    expect(await start.isDisabled()).toBe(true);
    await expect.poll(() => focused(page)).toBe("INPUT");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("hands the library's selection or one paper to citation expansion as seeds, kept in the page and not the address", async () => {
  const w = await nextWorkspace({ setup });
  try {
    const page = w.page;
    await expect.poll(() => page.locator(".paper-row").count()).toBe(9);
    for (const title of ["Nitrogen-rich salt survey", "Unparsed source"]) {
      await page.getByRole("checkbox", { name: `选择 ${title}` }).focus();
      await page.keyboard.press("Space");
    }
    const bar = page.getByRole("region", { name: "文献选择" });
    await bar.getByText("已选 2 篇").waitFor();
    await bar.getByRole("button", { name: "更多", exact: true }).click();
    // After 导出书目 (page specs “连续选择与选择栏”).
    const labels = await page.getByRole("menuitem").allTextContents();
    expect(labels.indexOf("扩展引用…")).toBe(labels.indexOf("导出书目") + 1);
    await page
      .getByRole("menuitem", { name: "扩展引用…", exact: true })
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("view"))
      .toBe("disc");
    expect(page.url()).not.toContain(salt);
    expect(page.url()).not.toContain(missingId);
    expect(
      await page
        .getByRole("tab", { name: "引用扩展", exact: true })
        .getAttribute("aria-selected"),
    ).toBe("true");
    await expect
      .poll(() => listed(page))
      .toEqual(["Nitrogen-rich salt survey", "Unparsed source"]);
    await page.goBack();
    await expect.poll(() => page.locator(".paper-row").count()).toBe(9);
    // The whole loaded list: five shown, the rest behind “另外 n 篇”.
    await selectAllLoaded(page);
    await bar.getByText("已选 9 篇").waitFor();
    await bar.getByRole("button", { name: "更多", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "扩展引用…", exact: true })
      .click();
    const seeds = page.getByRole("group", { name: "已选的种子文献" });
    await seeds.getByText("已选 9 篇", { exact: true }).waitFor();
    expect(await seeds.locator("li").count()).toBe(5);
    await seeds.getByRole("button", { name: "另外 4 篇", exact: true }).click();
    expect(await seeds.locator("li").count()).toBe(9);
    await expect.poll(() => focused(page)).toMatch(/^移除《/u);
    expect(
      await page
        .locator(".seed-list li .ui-button")
        .nth(5)
        .getAttribute("aria-label"),
    ).toBe(await focused(page));
    // One paper from its row menu, after 导出书目.
    await page.goBack();
    await expect.poll(() => page.locator(".paper-row").count()).toBe(9);
    await bar.getByRole("button", { name: "取消选择", exact: true }).click();
    const row = page.locator(".paper-row", { hasText: "Unparsed source" });
    await row.hover();
    await row.getByRole("button", { name: "文献操作" }).click();
    const rowLabels = await page.getByRole("menuitem").allTextContents();
    expect(rowLabels.indexOf("扩展引用…")).toBe(
      rowLabels.indexOf("导出书目") + 1,
    );
    await page
      .getByRole("menuitem", { name: "扩展引用…", exact: true })
      .click();
    await expect.poll(() => listed(page)).toEqual(["Unparsed source"]);
    await page
      .getByRole("searchbox", { name: "种子文献", exact: true })
      .waitFor();
    expect(
      await page
        .getByRole("button", { name: "开始扩展", exact: true })
        .isDisabled(),
    ).toBe(false);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);
