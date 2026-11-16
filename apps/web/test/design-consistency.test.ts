import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { componentFixture } from "./component-fixture.js";
import { writeDesignAudit } from "./design-audit-fixture.js";
import { nextAssets } from "./next-workspace-fixture.js";
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
        metrics.every((metric) => [26, 30, 34].includes(metric.height)),
      ).toBe(true);
      expect(new Set(metrics.map((metric) => metric.radius))).toEqual(
        new Set(["6px"]),
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
it("names the style layers in order in the built main stylesheet, so page styles rank above components", async () => {
  const assets = await nextAssets();
  const html = String(assets.get("/")!.body);
  const sheets = [
    ...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/gu),
  ]
    .map((m) => m[1]!)
    .filter((href) => /^\/assets\/index-[^/]+\.css$/u.test(href));
  expect(sheets).toHaveLength(1);
  const css = String(assets.get(sheets[0]!)!.body);
  // Layers rank by first appearance. The minifier drops the order statement
  // of `tokens.css`, so the order is what the stylesheet itself first names.
  const named: string[] = [];
  for (const m of css.matchAll(/@layer\s*([^{;]+)[{;]/gu))
    for (const name of m[1]!.split(",").map((part) => part.trim()))
      if (name && !named.includes(name)) named.push(name);
  expect(named).toEqual(["tokens", "base", "components", "pages"]);
}, 120000);
