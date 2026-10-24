import { expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  libraryStatus,
  nextWorkspace,
  openFilterConditions,
} from "./next-workspace-fixture.js";

it("serves the React library under the production CSP with persisted preferences and independent selection", async () => {
  const w = await nextWorkspace({ ready: "body" });
  try {
    const page = w.page;
    await page
      .getByRole("heading", { name: "文献库", exact: true })
      .waitFor()
      .catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}\n${await page.locator("body").textContent()}\n${w.errors.join("\n")}`,
        );
      });
    const row = page.locator(".paper-row").first();
    await row.getByRole("checkbox").focus();
    await row.getByRole("checkbox").press("Space");
    expect(new URL(page.url()).searchParams.get("literature")).toBeNull();
    expect(
      await page.getByRole("region", { name: "文献选择" }).textContent(),
    ).toContain("已选 1 篇");
    const separator = page.getByRole("separator", { name: "导航栏宽度" });
    await separator.focus();
    await separator.press("ArrowRight");
    expect(await separator.getAttribute("aria-valuenow")).toBe("260");
    expect(
      await page.evaluate(() =>
        localStorage.getItem("sciretriever:panel:navigation:v1"),
      ),
    ).toBeNull();
    expect(
      await page.evaluate(() =>
        localStorage.getItem(
          "sciretriever:react:sciretriever:panel:navigation:v1",
        ),
      ),
    ).toBe("260px");
    await openFilterConditions(page);
    await page
      .getByRole("textbox", { name: "年份起", exact: true })
      .fill("2020");
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("query"))
      .toContain('"publication_year_from":2020');
    await libraryStatus(page, "全部");
    await page.getByRole("button", { name: "浏览器", exact: true }).click();
    await page.getByRole("heading", { name: "浏览器", exact: true }).waitFor();
    await page
      .getByRole("button", { name: /^文献库/ })
      .first()
      .click();
    await row.waitFor();
    expect(await page.locator("style").count()).toBe(0);
    expect(w.errors).toEqual([]);
    const output = process.env.SCIRETRIEVER_WEB_REVIEW_OUTPUT;
    if (output) {
      await mkdir(output, { recursive: true });
      for (const width of [1440, 1280, 1024, 390])
        for (const theme of ["light", "dark", "green", "warm"]) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          await page.screenshot({
            path: join(output, `library-${width}-${theme}.png`),
            animations: "disabled",
          });
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
        }
    }
  } finally {
    await w.close();
  }
}, 60000);
