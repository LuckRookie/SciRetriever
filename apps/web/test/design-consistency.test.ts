import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { componentFixture } from "./component-fixture.js";
import { writeDesignAudit } from "./design-audit-fixture.js";
it("uses bounded control metrics and four themes without inline style sheets or narrow-screen overflow", async () => {
  const env = await componentFixture();
  try {
    const page = env.page;
    await page
      .getByRole("heading", { name: "组件画廊", exact: true })
      .waitFor();
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const theme of ["light", "dark", "green", "warm"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const metrics = await page.locator(".ui-button").evaluateAll((elements) =>
        elements
          .filter((element) => element.getBoundingClientRect().height > 0)
          .map((element) => ({
            height: Math.round(element.getBoundingClientRect().height),
            radius: getComputedStyle(element).borderRadius,
          })),
      );
      expect(
        metrics.every((metric) => [28, 36, 40].includes(metric.height)),
      ).toBe(true);
      expect(new Set(metrics.map((metric) => metric.radius))).toEqual(
        new Set(["8px"]),
      );
      if (process.env.SCIRETRIEVER_WEB_REVIEW_OUTPUT)
        await writeDesignAudit(
          page,
          process.env.SCIRETRIEVER_WEB_REVIEW_OUTPUT,
          `controls-${theme}`,
        );
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(env.errors).toEqual([]);
  } finally {
    await env.close();
  }
}, 30000);
it("keeps design variables in CSS and avoids geometry transitions", async () => {
  for (const file of ["components.css", "tokens.css", "base.css"]) {
    const text = await readFile(
      new URL(`../src/app/styles/${file}`, import.meta.url),
      "utf8",
    );
    if (file !== "base.css") expect(text).not.toContain("!important");
    expect(text).not.toMatch(/(?:^|[}\n])\s*#[A-Za-z]/u);
    for (const match of text.matchAll(/border-radius:\s*([^;}]+)/gu))
      expect(match[1]).toMatch(/var\(--radius-/u);
    for (const match of text.matchAll(/transition:\s*([^;}]+)/gu))
      expect(match[1]).not.toMatch(/\b(?:all|width|height|left|top)\b/u);
  }
});
