import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { componentFixture } from "./component-fixture.js";
import { writeDesignAudit } from "./design-audit-fixture.js";
import { nextAssets } from "./next-workspace-fixture.js";
// Design core “主题”: the seven themes' root names.
const themes = [
  "light",
  "oldbook",
  "xuan",
  "bean",
  "eink",
  "dark",
  "candle",
] as const;
it("uses bounded control metrics and seven themes without inline style sheets or narrow-screen overflow", async () => {
  const env = await componentFixture();
  try {
    const page = env.page;
    await page
      .getByRole("heading", { name: "组件画廊", exact: true })
      .waitFor();
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const theme of themes) {
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
/** Runs in the page: a token's computed colour, through a probe element. */
function tokenColour(name: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}
it("draws the primary button in ink (paper on ink at night), a disabled one grey on grey at full opacity, and one colour per status in all seven themes", async () => {
  const env = await componentFixture();
  try {
    const page = env.page;
    await page
      .getByRole("heading", { name: "组件画廊", exact: true })
      .waitFor();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const primary = page.getByRole("button", { name: "主要操作", exact: true });
    await primary.evaluate((el) => {
      el.style.transitionDuration = "0s";
    });
    const seen = new Map<string, string>();
    for (const theme of themes) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const colour = (name: string) => page.evaluate(tokenColour, name);
      const [fg, bg, ink, paper, grey, pale] = await Promise.all([
        colour("--fg"),
        colour("--bg"),
        colour("--primary"),
        colour("--primary-fg"),
        colour("--disabled-bg"),
        colour("--disabled-fg"),
      ]);
      // The primary is the theme's ink; its label is paper (white on 纸墨).
      expect(ink).toBe(fg);
      expect([bg, "rgb(255, 255, 255)"]).toContain(paper);
      const style = () =>
        primary.evaluate((el) => {
          const s = getComputedStyle(el);
          return {
            background: s.backgroundColor,
            color: s.color,
            opacity: s.opacity,
          };
        });
      expect(await style()).toEqual({
        background: ink,
        color: paper,
        opacity: "1",
      });
      await primary.evaluate((el) => el.setAttribute("data-disabled", "true"));
      expect(await style()).toEqual({
        background: grey,
        color: pale,
        opacity: "1",
      });
      await primary.evaluate((el) => el.removeAttribute("data-disabled"));
      // Rule 5: each status tone is one colour pair on every label, the
      // four tones differ, and work in progress turns a ring.
      const badges = await page
        .locator(".ui-badge[data-tone], .paper-status[data-tone]")
        .evaluateAll((elements) =>
          elements.map((el) => {
            const s = getComputedStyle(el);
            return {
              tone: el.getAttribute("data-tone")!,
              pair: `${s.color} on ${s.backgroundColor}`,
            };
          }),
        );
      const pairs = new Map<string, Set<string>>();
      for (const { tone, pair } of badges)
        pairs.set(tone, (pairs.get(tone) ?? new Set()).add(pair));
      // A paper's material keeps the colours set on 2026-10-23 (ADR 0070,
      // section 5): being archived is yellow, "no PDF found" is purple.
      expect([...pairs.keys()].sort()).toEqual(
        [
          "archiving",
          "done",
          "other",
          "pdf",
          "problem",
          "running",
          "unavailable",
        ].sort(),
      );
      for (const set of pairs.values()) expect(set.size).toBe(1);
      const one = (tone: string) => [...pairs.get(tone)!][0]!;
      expect(one("running")).toBe(one("other"));
      expect(
        new Set(
          ["done", "pdf", "problem", "other", "archiving", "unavailable"].map(
            one,
          ),
        ).size,
      ).toBe(6);
      const ring = await page
        .locator('.ui-badge[data-tone="running"] > span[aria-hidden="true"]')
        .first()
        .evaluate((el) => {
          const s = getComputedStyle(el);
          return {
            background: s.backgroundColor,
            ring:
              s.borderTopStyle === "solid" && parseFloat(s.borderTopWidth) >= 1,
            open: s.borderRightColor === "rgba(0, 0, 0, 0)",
          };
        });
      expect(ring).toEqual({
        background: "rgba(0, 0, 0, 0)",
        ring: true,
        open: true,
      });
      seen.set(theme, `${ink} ${one("done")}`);
    }
    expect(new Set(seen.values()).size).toBe(themes.length);
    expect(env.errors).toEqual([]);
  } finally {
    await env.close();
  }
}, 60000);
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
