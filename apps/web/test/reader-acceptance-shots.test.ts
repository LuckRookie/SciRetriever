/**
 * Plan 25 block 05 (5.2): the reader's screenshots for review — spec 8.2
 * “截图” for the views that exist (full text, PDF, loading) at 1440×900,
 * 1024×768 and 390 wide, light and dark; and the side panel's tabs, the
 * spine's hint, the context menus, the shortcut list, the scale in the page
 * header and the 390 px view menu. Runs only with SCIRETRIEVER_READER_SHOTS.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { readerPanel } from "./reader-controls.js";

const TEXT =
  [
    "# 1 Introduction",
    "Energetic salts were measured at 1.86 g cm and R1 = 0.036 for NX-7.",
    "含能盐的密度为 1.86 g cm，晶体结构 R1 = 0.036，样品记为 NX-7。热分解温度高于 250 °C。",
    "# 2 Methods",
    ...Array.from(
      { length: 20 },
      (_, i) =>
        `Paragraph ${i}: a reported measurement with conditions and evidence, long enough to wrap.`,
    ),
    "# 3 Results",
    ...Array.from(
      { length: 20 },
      (_, i) => `Result ${i}: values with their conditions and uncertainty.`,
    ),
  ].join("\n\n") + "\n";

/** The theme as a person chose it, kept across loads; checked dark when dark. */
async function theme(page: Page, origin: string, value: "light" | "dark") {
  await page.goto(origin);
  await page.evaluate((value) => {
    localStorage.setItem("sciretriever:react:sciretriever:theme:v1", value);
  }, value);
}
async function checkTheme(page: Page, value: "light" | "dark") {
  const dark = await page.evaluate(() => {
    const [r, g, b] = getComputedStyle(document.body)
      .backgroundColor.match(/\d+/gu)!
      .map(Number);
    return (
      document.documentElement.dataset.theme === "dark" &&
      0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 80
    );
  });
  expect(dark).toBe(value === "dark");
}

it("takes the reader's review screenshots once (plan 25 block 05)", async (context) => {
  const output = process.env.SCIRETRIEVER_READER_SHOTS;
  if (!output) return context.skip();
  await mkdir(output, { recursive: true });
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => env.setText(TEXT),
  });
  const id = w.env.parseRequest.literature_id;
  const page = w.page;
  const shot = async (name: string, value: "light" | "dark") => {
    await checkTheme(page, value);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(output, `${name}-${value}.png`) });
  };
  const open = async (view: "doc" | "pdf") => {
    await page.goto(`${w.origin}/?literature=${id}&reader=${view}`);
    await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    if (view === "pdf")
      await page.locator('[data-pdf-page="1"][data-rendered="true"]').waitFor();
  };
  try {
    for (const value of ["light", "dark"] as const) {
      await theme(page, w.origin, value);
      // SCIRETRIEVER_READER_SHOTS_NARROW=1: only the 390 px shots, retaken.
      const narrow = process.env.SCIRETRIEVER_READER_SHOTS_NARROW === "1";
      for (const [width, height] of (narrow
        ? [[390, 844]]
        : [
            [1440, 900],
            [1024, 768],
            [390, 844],
          ]) as [number, number][]) {
        await page.setViewportSize({ width, height });
        await open("doc");
        await shot(`doc-${width}`, value);
        await open("pdf");
        await shot(`pdf-${width}`, value);
        // Loading: the text held back, the skeleton shows (spec 6.3).
        let release = () => {};
        const held = new Promise<void>((resolve) => (release = resolve));
        await page.route("**/api/v1/query/document-slice?*", async (route) => {
          await held;
          await route.continue().catch(() => {});
        });
        await page.goto(`${w.origin}/?literature=${id}&reader=doc`);
        await page.locator(".reader-preparing").waitFor();
        await page.waitForTimeout(400);
        await shot(`loading-${width}`, value);
        release();
        await page.unrouteAll({ behavior: "wait" });
      }
      // The states at 1440.
      if (!narrow) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await open("doc");
        for (const [tab, name] of [
          ["信息", "info"],
          ["批注", "marks"],
          ["关联", "relations"],
          ["翻译", "translation"],
        ] as const) {
          await readerPanel(page, tab);
          await shot(`panel-${name}-1440`, value);
        }
        await page
          .getByRole("button", { name: "收起信息", exact: true })
          .click();
        await page.locator(".reader-spine-part").nth(1).hover();
        await page.locator(".reader-spine-tip").waitFor();
        await shot("spine-hover-1440", value);
        await page.mouse.move(10, 500);
        const paragraph = page
          .locator(".reader-engine-body section[data-byte-start]")
          .nth(6);
        await paragraph.click({ button: "right", position: { x: 60, y: 8 } });
        await page.locator(".ui-context-menu").waitFor();
        await shot("menu-paragraph-1440", value);
        await page.keyboard.press("Escape");
        await paragraph.evaluate((el) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let text = walker.nextNode() as Text | null;
          while (text && !text.data.includes("Paragraph"))
            text = walker.nextNode() as Text | null;
          const range = document.createRange();
          range.setStart(text!, 0);
          range.setEnd(text!, 20);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
        });
        const rect = await paragraph.evaluate(() => {
          const r = getSelection()!.getRangeAt(0).getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.mouse.click(rect.x, rect.y, { button: "right" });
        await page.locator(".ui-context-menu").waitFor();
        await shot("menu-selection-1440", value);
        await page.keyboard.press("Escape");
        await page.evaluate(() => getSelection()!.removeAllRanges());
        await page
          .locator("[data-paper-tab]")
          .first()
          .click({ button: "right" });
        await page.locator(".ui-context-menu").waitFor();
        await shot("menu-tab-1440", value);
        await page.keyboard.press("Escape");
        await page.mouse.move(700, 500);
        await page.keyboard.press("Control+Equal");
        await page.keyboard.press("Control+Equal");
        await shot("header-scale-1440", value);
        await page.keyboard.press("Control+0");
        await page.keyboard.press("Shift+Slash");
        await page.getByRole("dialog", { name: "键盘快捷键" }).waitFor();
        await shot("shortcuts-1440", value);
        await page.keyboard.press("Escape");
        await open("pdf");
        await page
          .locator('[data-pdf-page="1"][data-rendered="true"]')
          .click({ button: "right", position: { x: 80, y: 120 } });
        await page.locator(".ui-context-menu").waitFor();
        await shot("menu-pdf-page-1440", value);
        await page.keyboard.press("Escape");
      }
      // 390: the views as one button, its menu open.
      await page.setViewportSize({ width: 390, height: 844 });
      await open("doc");
      await page.getByRole("button", { name: /^视图：/u }).click();
      await page.getByRole("menu").waitFor();
      await shot("view-menu-390", value);
      await page.keyboard.press("Escape");
    }
  } finally {
    await w.close();
  }
}, 600_000);
