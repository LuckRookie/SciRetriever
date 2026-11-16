/**
 * Spec “reading experience” 8.2, the rows plan 25 block 01 adds: the pointer
 * anchor through Ctrl+wheel, the bounds of the zoom input, the context menus
 * and keyboard scrolling, in Chromium on the synthetic library.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { readerPanel } from "./reader-controls.js";

const TEXT = Array.from(
  { length: 300 },
  (_, i) =>
    `Paragraph ${i}: a reported measurement with conditions and evidence, long enough to wrap when the column narrows.\n\n`,
).join("");

async function openDoc(w: Awaited<ReturnType<typeof nextWorkspace>>) {
  await w.page.setViewportSize({ width: 1440, height: 900 });
  await w.page.goto(
    `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=doc`,
  );
  await w.page.locator('.react-reader[data-reading-ready="true"]').waitFor();
  await w.page
    .locator(".reader-engine-body section[data-byte-start]")
    .nth(40)
    .waitFor();
}
/**
 * Counts the window's non-passive wheel listeners (spec 1.8.1: the wheel is
 * listened to on the desk only, so scrolling never waits on the page).
 */
async function countWindowWheel(page: Page) {
  await page.addInitScript(() => {
    const live = new Set<string>();
    const key = (listener: unknown, options: unknown) =>
      `${String(listener)}|${
        typeof options === "boolean"
          ? options
          : !!(options as { capture?: boolean } | undefined)?.capture
      }`;
    const add = EventTarget.prototype.addEventListener,
      remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (
      type,
      listener,
      options,
    ) {
      if (
        this === window &&
        type === "wheel" &&
        !(typeof options === "object" && options?.passive)
      )
        live.add(key(listener, options));
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (
      type,
      listener,
      options,
    ) {
      if (this === window && type === "wheel")
        live.delete(key(listener, options));
      return remove.call(this, type, listener, options);
    };
    (window as unknown as { wheelListeners: () => number }).wheelListeners =
      () => live.size;
  });
  return () =>
    page.evaluate(() =>
      (window as unknown as { wheelListeners: () => number }).wheelListeners(),
    );
}
/** Whether the last such event reached the window's bubble phase prevented. */
async function watchPrevented(page: Page) {
  await page.evaluate(() => {
    const seen: Record<string, boolean> = {};
    (window as unknown as { seen: Record<string, boolean> }).seen = seen;
    for (const type of ["wheel", "keydown", "contextmenu"])
      addEventListener(type, (event) => (seen[type] = event.defaultPrevented), {
        passive: true,
      });
  });
  return (type: string) =>
    page.evaluate(
      (type) =>
        (window as unknown as { seen: Record<string, boolean> }).seen[type],
      type,
    );
}
const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

it("scales the full text under the pointer with Ctrl+wheel and the keys, within the reader's bounds (8.2 锚点保持、缩放的边界)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => env.setText(TEXT),
  });
  try {
    await openDoc(w);
    const prevented = await watchPrevented(w.page);
    const body = w.page.locator(".reader-engine-body");
    await body.evaluate((el) => (el.scrollTop = 1800));
    await frames(w.page);
    const box = (await body.boundingBox())!;
    const x = box.x + box.width / 2,
      y = box.y + box.height * 0.8;
    /** The block under the pointer and the screen height of one point inside it. */
    const pointAt = (key?: string) =>
      w.page.evaluate(
        ({ y, key }) => {
          const blocks = [
            ...document.querySelectorAll<HTMLElement>(
              ".reader-view:not([hidden]) article > section[data-byte-start]",
            ),
          ];
          const block = key
            ? blocks.find((b) => b.dataset.byteStart === key)!
            : blocks.find((b) => b.getBoundingClientRect().bottom > y)!;
          const r = block.getBoundingClientRect();
          return {
            key: block.dataset.byteStart!,
            top: r.top,
            height: r.height,
          };
        },
        { y, key },
      );
    const before = await pointAt();
    const ratio = (y - before.top) / before.height;
    const zoom = () =>
      w.page.evaluate(() => [visualViewport!.scale, devicePixelRatio]);
    const browserZoom = await zoom();
    const font = () =>
      body.evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--reading-font-size").trim(),
      );
    await w.page.mouse.move(x, y);
    await w.page.keyboard.down("Control");
    await w.page.mouse.wheel(0, -100);
    await frames(w.page);
    expect(await font()).toBe("21px");
    expect(await prevented("wheel")).toBe(true);
    // Z1: the page header says 105%.
    await expect
      .poll(() =>
        w.page
          .locator(".reader-view:not([hidden]) .reader-page-header-view")
          .innerText(),
      )
      .toContain("105%");
    for (let i = 0; i < 4; i++) {
      await w.page.mouse.wheel(0, -100);
      await frames(w.page);
    }
    expect(await font()).toBe("25px");
    for (let i = 0; i < 5; i++) {
      await w.page.mouse.wheel(0, 100);
      await frames(w.page);
    }
    await w.page.keyboard.up("Control");
    expect(await font()).toBe("20px");
    const after = await pointAt(before.key);
    // Z2 and 8.2: the same point of the block under the pointer, within 2 px.
    expect(Math.abs(after.top + ratio * after.height - y)).toBeLessThanOrEqual(
      2,
    );
    expect(await zoom()).toEqual(browserZoom);
    // Z16: over the top bar it is the browser's (not intercepted).
    await w.page.waitForTimeout(400);
    await w.page.mouse.move(700, 20);
    await w.page.keyboard.down("Control");
    await w.page.mouse.wheel(0, 0.01);
    await w.page.keyboard.up("Control");
    expect(await prevented("wheel")).toBe(false);
    expect(await font()).toBe("20px");
    // Z17: Ctrl+= in the page steps the scale; in the find box it is not the reader's.
    await w.page.mouse.move(x, y);
    await w.page.keyboard.press("Control+Equal");
    expect(await font()).toBe("21px");
    expect(await prevented("keydown")).toBe(true);
    await w.page.keyboard.press("Control+0");
    expect(await font()).toBe("20px");
    await w.page.keyboard.press("Control+f");
    await w.page.getByRole("searchbox", { name: "查找…" }).waitFor();
    await w.page.evaluate(() =>
      document
        .querySelector<HTMLInputElement>(".reader-find input")!
        .addEventListener("keydown", (event) => event.preventDefault()),
    );
    // A field's own handler may stop the browser; the reader must not act.
    await w.page.keyboard.press("Control+Equal");
    expect(await font()).toBe("20px");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120_000);

it("opens the reader's context menus, leaves the browser's where it belongs, and scrolls by keys without a click (8.2 右键菜单、键盘滚动)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => env.setText(TEXT),
  });
  try {
    const wheelListeners = await countWindowWheel(w.page);
    await openDoc(w);
    // No menu open: no non-passive wheel listener on the window (spec 1.8.1).
    expect(await wheelListeners()).toBe(0);
    const prevented = await watchPrevented(w.page);
    const body = w.page.locator(".reader-engine-body");
    // K1: no click anywhere; space turns 90% of the visible height below the rule.
    const visible = await body.evaluate((el) => {
      const header = el.querySelector<HTMLElement>(
        ".reader-view:not([hidden]) .reader-page-header",
      );
      return el.clientHeight - (header?.offsetHeight ?? 0);
    });
    const top0 = await body.evaluate((el) => el.scrollTop);
    await w.page.evaluate(() =>
      document.documentElement.setAttribute("data-reduced-motion", "true"),
    );
    await w.page.keyboard.press("Space");
    await expect
      .poll(() => body.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(top0);
    await w.page.waitForTimeout(400);
    const top1 = await body.evaluate((el) => el.scrollTop);
    expect(Math.abs(top1 - top0 - visible * 0.9)).toBeLessThanOrEqual(2);
    await w.page.keyboard.press("Shift+Space");
    await w.page.waitForTimeout(400);
    expect(
      Math.abs((await body.evaluate((el) => el.scrollTop)) - top0),
    ).toBeLessThanOrEqual(2);
    // Focus on the views' segmented control: space is the control's.
    await w.page.getByRole("tab", { name: "原文", exact: true }).focus();
    const still = await body.evaluate((el) => el.scrollTop);
    await w.page.keyboard.press("Space");
    await w.page.waitForTimeout(300);
    expect(await body.evaluate((el) => el.scrollTop)).toBe(still);
    await w.page.evaluate(() => (document.activeElement as HTMLElement).blur());

    // M1: a paragraph's menu: its own part, the reading part, the paper part.
    const paragraph = body.locator("section[data-byte-start]").nth(45);
    await paragraph.scrollIntoViewIfNeeded();
    await paragraph.click({ button: "right", position: { x: 40, y: 8 } });
    const menu = w.page.locator(".ui-context-menu");
    await menu.waitFor();
    expect(await prevented("contextmenu")).toBe(true);
    const items = await menu
      .getByRole("menuitem")
      .evaluateAll((list) =>
        list.map((item) =>
          (item.querySelector('[slot="label"]')?.textContent ?? "").trim(),
        ),
      );
    expect(items.slice(0, 3)).toEqual([
      "复制本段",
      "复制本段为引用",
      "翻译本段",
    ]);
    expect(items).toContain("在 PDF 中查看此处");
    expect(items.slice(-3)).toEqual([
      "关闭本文献",
      "关闭其他文献",
      "关闭所有文献",
    ]);
    // M20: no jumps yet, no “返回上一位置”.
    expect(items).not.toContain("返回上一位置");
    // Open, Ctrl+wheel over the desk closes it; only now is one listening.
    expect(await wheelListeners()).toBe(1);
    await w.page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    await expect.poll(wheelListeners).toBe(0);
    // M2: Shift+right-click is the browser's.
    await paragraph.click({
      button: "right",
      modifiers: ["Shift"],
      position: { x: 40, y: 8 },
    });
    expect(await prevented("contextmenu")).toBe(false);
    expect(await menu.count()).toBe(0);
    // M5: within a selection, the selected text's menu, and the selection stays.
    await paragraph.evaluate((el) => {
      const range = document.createRange();
      const text = el.querySelector("p")!.firstChild!;
      range.setStart(text, 0);
      range.setEnd(text, 9);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    const rect = await paragraph.evaluate(() => {
      const r = getSelection()!.getRangeAt(0).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await w.page.mouse.click(rect.x, rect.y, { button: "right" });
    await menu.waitFor();
    const selected = await menu
      .getByRole("menuitem")
      .evaluateAll((list) =>
        list.map((item) =>
          (item.querySelector('[slot="label"]')?.textContent ?? "").trim(),
        ),
      );
    expect(selected.slice(0, 2)).toEqual(["复制", "复制为引用"]);
    expect(selected).not.toContain("关闭本文献");
    await w.page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    expect(await w.page.evaluate(() => getSelection()!.toString())).toBe(
      "Paragraph",
    );
    await w.page.evaluate(() => getSelection()!.removeAllRanges());
    // M24: Shift+F10 from the page: at the reading line, the first item focused;
    // Esc closes it and the focus goes back.
    await w.page.keyboard.press("Shift+F10");
    await menu.waitFor();
    expect(
      await w.page.evaluate(
        () =>
          document.activeElement?.closest(".ui-context-menu") !== null &&
          document.activeElement?.getAttribute("role") === "menuitem",
      ),
    ).toBe(true);
    await w.page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    expect(
      await w.page.evaluate(() => document.activeElement === document.body),
    ).toBe(true);
    // M3: inside the find box the browser's menu.
    await w.page.keyboard.press("Control+f");
    const search = w.page.getByRole("searchbox", { name: "查找…" });
    await search.click({ button: "right" });
    expect(await prevented("contextmenu")).toBe(false);
    expect(await menu.count()).toBe(0);
    await search.press("Escape");
    // The paper's tab: its own menu (T2), “重新打开刚关闭的文献” disabled (T8).
    await w.page
      .getByRole("navigation", { name: "阅读标签", exact: true })
      .locator("[data-paper-tab]")
      .first()
      .click({ button: "right" });
    await menu.waitFor();
    expect(
      await menu
        .getByRole("menuitem", { name: /重新打开刚关闭的文献/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await w.page.keyboard.press("Escape");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120_000);

it("shows the context menus, the shortcut list and the scale in the page header (screenshots, 1440 and 1024, both themes)", async (context) => {
  const output = process.env.SCIRETRIEVER_WEB_REVIEW_OUTPUT;
  if (!output) return context.skip();
  await mkdir(output, { recursive: true });
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => env.setText(TEXT),
  });
  try {
    for (const width of [1440, 1024]) {
      await w.page.setViewportSize({ width, height: 900 });
      for (const theme of ["light", "dark"]) {
        const shot = async (name: string) => {
          await w.page.waitForTimeout(250);
          await w.page.screenshot({
            path: join(output, `${name}-${width}-${theme}.png`),
          });
        };
        await w.page.goto(
          `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=doc`,
        );
        await w.page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await w.page
          .locator('.react-reader[data-reading-ready="true"]')
          .waitFor();
        const body = w.page.locator(".reader-engine-body");
        const paragraph = body.locator("section[data-byte-start]").nth(3);
        await paragraph.waitFor();
        await paragraph.click({ button: "right", position: { x: 60, y: 8 } });
        await shot("menu-paragraph");
        await w.page.keyboard.press("Escape");
        await paragraph.evaluate((el) => {
          const range = document.createRange();
          const text = el.querySelector("p")!.firstChild!;
          range.setStart(text, 0);
          range.setEnd(text, 20);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
        });
        const rect = await paragraph.evaluate(() => {
          const r = getSelection()!.getRangeAt(0).getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await w.page.mouse.click(rect.x, rect.y, { button: "right" });
        await shot("menu-selection");
        await w.page.keyboard.press("Escape");
        await w.page.evaluate(() => getSelection()!.removeAllRanges());
        await w.page
          .locator("[data-paper-tab]")
          .first()
          .click({ button: "right" });
        await shot("menu-tab");
        await w.page.keyboard.press("Escape");
        await w.page.mouse.move(700, 500);
        await w.page.keyboard.press("Control+Equal");
        await w.page.keyboard.press("Control+Equal");
        await shot("header-scale");
        await w.page.keyboard.press("Control+0");
        await w.page.keyboard.press("Shift+Slash");
        await w.page.getByRole("dialog", { name: "键盘快捷键" }).waitFor();
        await shot("shortcuts");
        await w.page.keyboard.press("Escape");
        await w.page.goto(
          `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=pdf`,
        );
        await w.page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        const page1 = w.page.locator(
          '[data-pdf-page="1"][data-rendered="true"]',
        );
        await page1.waitFor();
        await page1.click({ button: "right", position: { x: 80, y: 120 } });
        await shot("menu-pdf-page");
        await w.page.keyboard.press("Escape");
      }
    }
  } finally {
    await w.close();
  }
}, 300_000);

it("shows the side panel's four tabs, docked at 1440 and floating at 1024 (plan 25 block 02 screenshots)", async (context) => {
  const output = process.env.SCIRETRIEVER_WEB_PANEL_OUTPUT;
  if (!output) return context.skip();
  await mkdir(output, { recursive: true });
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => env.setText(TEXT),
  });
  try {
    for (const width of [1440, 1024]) {
      await w.page.setViewportSize({ width, height: 900 });
      await w.page.goto(
        `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=doc`,
      );
      await w.page
        .locator('.react-reader[data-reading-ready="true"]')
        .waitFor();
      for (const [tab, name] of [
        ["信息", "info"],
        ["批注", "marks"],
        ["关联", "relations"],
        ["翻译", "translation"],
      ] as const) {
        await readerPanel(w.page, tab);
        await w.page.waitForTimeout(400);
        await w.page.screenshot({
          path: join(output, `panel-${name}-${width}.png`),
        });
      }
    }
  } finally {
    await w.close();
  }
}, 180_000);
