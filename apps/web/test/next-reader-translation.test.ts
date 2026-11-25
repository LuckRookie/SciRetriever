import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { fullTextStrings } from "../src/app/strings.js";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { readerPanel } from "./reader-controls.js";
import { storedTranslation } from "./stored-translation.js";

/**
 * Plan 28 block 08 (reading-experience 9, ADR 0068): the full text's three
 * readings over the library's stored translation, as served replies give it.
 * Screenshots go to SCIRETRIEVER_TRANSLATION_SHOTS when it is set.
 */
const SHOTS = process.env.SCIRETRIEVER_TRANSLATION_SHOTS;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};
const TEXT = [
  "# Measurements",
  "The measured energy was 4.2 eV.",
  ...Array.from(
    { length: 22 },
    (_, i) =>
      `Paragraph ${i}: the values were measured under the stated conditions, each with its uncertainty and the method that gave it.`,
  ),
  "$$E = h \\nu$$",
  "## Context",
  "A separate discussion.",
  ...Array.from(
    { length: 8 },
    (_, i) => `Closing ${i}: what the measurements mean for the comparison.`,
  ),
].join("\n\n");
const KEY = "sciretriever:react:sciretriever:reader:text-mode:v1";
const sheet = ".reader-view:not([hidden])[data-view='doc']";
const readings = (page: Page) =>
  page.getByRole("tablist", { name: fullTextStrings.readings });
const reading = (page: Page, name: string) =>
  readings(page).getByRole("tab", { name, exact: true });
const section = (page: Page, text: string) =>
  page
    .locator(`${sheet} article > section[data-byte-start]`)
    .filter({ hasText: text })
    .first();
const headerView = (page: Page) =>
  page.locator(`${sheet} .reader-page-header-view`);
/** Waits for the full text to show the reading `mode`. */
const shows = (page: Page, mode: string) =>
  page.locator(`${sheet} article[data-text-mode="${mode}"]`).waitFor();

it("reads the full text in 原文, 译文 and 对照, keeps the place and the choice, finds what shows and downloads all three (reading-experience 9)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => env.setText(TEXT),
  });
  try {
    const page = w.page,
      id = w.env.parseRequest.literature_id;
    await page.setViewportSize({ width: 1440, height: 900 });
    const fake = await storedTranslation(page);
    const asked: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/translation"
      )
        asked.push(request.url());
    });
    await page.goto(`${w.origin}/?literature=${id}&reader=doc`);
    await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    // The view is “全文”; its readings sit right of the views.
    expect(
      await page
        .getByRole("tablist", { name: "阅读视图" })
        .getByRole("tab")
        .allInnerTexts(),
    ).toEqual(["全文", "PDF"]);
    expect(await readings(page).getByRole("tab").allInnerTexts()).toEqual([
      "原文",
      "译文",
      "对照",
    ]);
    expect(await reading(page, "原文").getAttribute("aria-selected")).toBe(
      "true",
    );
    await expect
      .poll(() => reading(page, "译文").getAttribute("aria-disabled"))
      .not.toBe("true");
    await shows(page, "original");
    expect(await page.locator(`${sheet} .reading-translation`).count()).toBe(0);
    await expect.poll(() => headerView(page).innerText()).toBe("全文 · 已校对");

    // 译文: translated paragraphs show their translation, the one left
    // untranslated its original with “未译”, the formula stays once.
    await reading(page, "译文").click();
    await shows(page, "translation");
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe(
      "translation",
    );
    await expect
      .poll(() => headerView(page).innerText())
      .toBe("全文 · 已校对 · 译文（机器翻译）");
    const first = section(page, "Paragraph 3:");
    await first.locator(".reading-translation").waitFor();
    expect(await first.locator(":scope > p").isVisible()).toBe(false);
    const translated = first.locator(".reading-translation");
    expect(
      await translated.evaluate((el) => {
        const style = getComputedStyle(el),
          probe = document.createElement("span");
        probe.style.color = "var(--fg2)";
        probe.style.fontFamily = "var(--sans)";
        el.append(probe);
        const want = getComputedStyle(probe);
        const same =
          style.color === want.color && style.fontFamily === want.fontFamily;
        probe.remove();
        return same && el.getAttribute("data-origin") === "machine";
      }),
    ).toBe(true);
    const untranslated = page
      .locator(`${sheet} section[data-translation="missing"]`)
      .first();
    await untranslated.waitFor();
    expect(
      await untranslated.locator(".reading-untranslated").innerText(),
    ).toBe("未译");
    expect(await untranslated.locator(":scope > p").isVisible()).toBe(true);
    const formula = page.locator(`${sheet} section:has(.katex-display)`);
    expect(await formula.count()).toBe(1);
    expect(await formula.locator(".reading-translation").count()).toBe(0);
    expect(await formula.isVisible()).toBe(true);
    await shot(page, "translation-light");

    // The choice is this browser's: it holds after a reload.
    await page.reload();
    await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    await shows(page, "translation");
    expect(await reading(page, "译文").getAttribute("aria-selected")).toBe(
      "true",
    );

    // 对照 keeps the paragraph at the reading line where it was (spec 4.2).
    await reading(page, "原文").click();
    await shows(page, "original");
    const target = section(page, "Paragraph 14:");
    const placeAtLine = () =>
      target.evaluate((el) => {
        const body = el.closest<HTMLElement>(".reading-scroll")!,
          header = el
            .closest(".reader-view")!
            .querySelector<HTMLElement>(".reader-page-header")!;
        const top = body.getBoundingClientRect().top + header.offsetHeight,
          line = top + 0.28 * (body.clientHeight - header.offsetHeight),
          box = el.getBoundingClientRect();
        body.scrollTop += box.top + box.height / 2 - line;
      });
    await placeAtLine();
    await page.waitForTimeout(200);
    const before = await target.evaluate(
      (el) => el.getBoundingClientRect().top,
    );
    await reading(page, "对照").click();
    await shows(page, "bilingual");
    await page.waitForTimeout(200);
    const after = await target.evaluate((el) => el.getBoundingClientRect().top);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
    await expect
      .poll(() => headerView(page).innerText())
      .toBe("全文 · 已校对 · 对照");
    // Above the original, below its translation; a heading's translation one size smaller.
    const pair = await section(page, "Paragraph 14:").evaluate((el) => {
      const original = el.querySelector(":scope > p")!.getBoundingClientRect(),
        translation = el
          .querySelector(".reading-translation")!
          .getBoundingClientRect();
      return { original: original.bottom, translation: translation.top };
    });
    expect(pair.translation).toBeGreaterThanOrEqual(pair.original);
    const heading = section(page, "Context");
    const sizes = await heading.evaluate((el) => ({
      original: parseFloat(
        getComputedStyle(el.querySelector(":is(h1,h2,h3,h4,h5,h6)")!).fontSize,
      ),
      translation: parseFloat(
        getComputedStyle(el.querySelector(".reading-translation-heading")!)
          .fontSize,
      ),
    }));
    expect(sizes.translation).toBeLessThan(sizes.original);
    await shot(page, "bilingual-light");
    // The old-paper theme, the same 对照.
    await page.evaluate(() =>
      localStorage.setItem(
        "sciretriever:react:sciretriever:theme:v1",
        "oldbook",
      ),
    );
    await page.reload();
    await shows(page, "bilingual");
    await section(page, "Paragraph 3:").scrollIntoViewIfNeeded();
    await shot(page, "bilingual-oldbook");
    await page.evaluate(() =>
      localStorage.setItem("sciretriever:react:sciretriever:theme:v1", "light"),
    );
    await page.reload();
    await shows(page, "bilingual");

    // Find looks in what shows: the translation in 对照, not in 原文.
    await page.getByRole("button", { name: "查找…", exact: true }).click();
    const field = page.locator(".reader-find input");
    await field.fill("段落译文");
    await field.press("Enter");
    const status = page.locator(".reader-find [role='status']").first();
    await expect.poll(() => status.innerText()).toMatch(/第 1 \/ \d+ 处/u);
    await reading(page, "原文").click();
    await shows(page, "original");
    await expect.poll(() => status.innerText()).toContain("没有匹配");
    await page.getByRole("button", { name: "查找…", exact: true }).click();

    // A marked paragraph read in translation: “批注 1” in its margin, and
    // pressed, 对照 at that paragraph. The translation reading takes no marks.
    await page.evaluate(() => {
      const block = [
        ...document.querySelectorAll<HTMLElement>(
          ".reader-view:not([hidden]) article > section[data-byte-start]",
        ),
      ].find((b) => /Paragraph 5:/u.test(b.textContent ?? ""))!;
      block.scrollIntoView({ block: "center" });
      const text = block.querySelector("p")!.firstChild as Text;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 11);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      block.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      block.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    const bar = page.getByRole("toolbar", { name: "选中文字" });
    await bar.locator(".mark-swatch").first().click();
    await expect
      .poll(() => page.evaluate(() => CSS.highlights.size))
      .toBeGreaterThan(0);
    await reading(page, "译文").click();
    await shows(page, "translation");
    const sign = section(page, "Paragraph 5:").locator(
      ".reading-translation-marks",
    );
    await expect.poll(() => sign.innerText()).toBe("批注 1");
    await shot(page, "translation-marks");
    await sign.click();
    await shows(page, "bilingual");
    expect(await reading(page, "对照").getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe(
      "bilingual",
    );

    // 下载全文: 原文, 译文 and 对照, read from the stored translation.
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page
      .getByRole("menuitem", { name: fullTextStrings.download, exact: true })
      .click();
    const submenu = page.getByRole("menu").last();
    expect(await submenu.getByRole("menuitem").allInnerTexts()).toEqual([
      "原文",
      "译文",
      "对照",
    ]);
    const download = page.waitForEvent("download");
    await submenu.getByRole("menuitem", { name: "译文", exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`${id}.zh-Hans.md`);
    expect(await readFile((await file.path())!, "utf8")).toContain("机器译文");
    expect(fake.slices).toContain("translation");
    // No model was asked for any of it.
    expect(asked).toEqual([]);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 180000);

it("says why there is no translation, reads the original meanwhile without forgetting the choice, and turns the PDF's 对照翻译 off or reads the stored pages (reading-experience 9)", async () => {
  const w = await nextWorkspace({ ready: "body" });
  try {
    const page = w.page,
      id = w.env.parseRequest.literature_id;
    await page.setViewportSize({ width: 1440, height: 900 });
    const fake = await storedTranslation(page, { state: "none" });
    await page.goto(`${w.origin}/?literature=${id}&reader=doc`);
    await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    await page.evaluate((key) => localStorage.setItem(key, "translation"), KEY);
    // The fixture's text is proofread: parsed before translating was a step.
    const parsedBefore = "这篇解析全文时还没有翻译；再解析一次全文即可补上译文";
    for (const [state, reason] of [
      ["none", parsedBefore],
      ["same-language", "这篇已经是简体中文"],
      ["stale", "全文改过，译文还没有更新；再解析一次全文即可补上"],
    ] as const) {
      fake.state = state;
      await page.reload();
      await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
      await shows(page, "original");
      await expect
        .poll(() => reading(page, "译文").getAttribute("aria-disabled"))
        .toBe("true");
      expect(await reading(page, "对照").getAttribute("aria-disabled")).toBe(
        "true",
      );
      expect(await reading(page, "原文").getAttribute("aria-selected")).toBe(
        "true",
      );
      await reading(page, "对照").hover();
      const tip = page.locator(".reader-text-mode-tip");
      await expect.poll(() => tip.isVisible()).toBe(true);
      expect(await tip.innerText()).toBe(reason);
      if (state === "none") await shot(page, "no-translation");
      // The choice stays: a paper with a translation opens in it.
      expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe(
        "translation",
      );
      // Only the original to download.
      await page.getByRole("button", { name: "更多", exact: true }).click();
      const item = page.getByRole("menuitem", {
        name: fullTextStrings.download,
        exact: true,
      });
      await item.waitFor();
      expect(await item.getAttribute("aria-haspopup")).toBeNull();
      await page.keyboard.press("Escape");
    }

    // The PDF: 对照翻译 off with the same reason, no readings in the bar.
    fake.state = "none";
    await page.goto(`${w.origin}/?literature=${id}&reader=pdf`);
    await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    expect(await readings(page).count()).toBe(0);
    const panel = await readerPanel(page, "翻译");
    const open = panel.getByRole("button", { name: "对照翻译", exact: true });
    await expect.poll(() => open.isDisabled()).toBe(true);
    await panel.getByText(parsedBefore).waitFor();
    expect(
      await panel
        .getByRole("button", { name: "翻译当前所在的节", exact: true })
        .count(),
    ).toBe(0);
    await shot(page, "pdf-no-translation");

    // With a stored translation it reads the pages: no confirmation, no model.
    const asked: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path === "/api/translation")
        asked.push(path);
    });
    fake.state = "complete";
    await page.reload();
    await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    const again = await readerPanel(page, "翻译");
    const enabled = again.getByRole("button", {
      name: "对照翻译",
      exact: true,
    });
    await expect.poll(() => enabled.isDisabled()).toBe(false);
    const pageRead = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/translation/fulltext/page",
    );
    await enabled.click();
    const body = (await pageRead).postDataJSON() as {
      target_language: string;
      force: boolean;
    };
    expect(body.target_language).toBe("zh-Hans");
    expect(body.force).toBe(false);
    expect(await page.getByRole("dialog", { name: "翻译全文" }).count()).toBe(
      0,
    );
    await page.locator(".ft-twin[data-state='ready']").first().waitFor();
    await shot(page, "pdf-bilingual");
    expect(asked).toEqual([]);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 180000);

it("shows the 翻译 tab for the library's translation where no translation service is set up: no model and no selection, “翻译本段” and the PDF's 对照翻译 from the library (plan 28 block 08)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    translation: false,
    setup: async (env) => env.setText(TEXT),
  });
  try {
    const page = w.page,
      id = w.env.parseRequest.literature_id;
    await page.setViewportSize({ width: 1440, height: 900 });
    await storedTranslation(page, { state: "complete" });
    await page.goto(`${w.origin}/?literature=${id}&reader=doc`);
    await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    await expect
      .poll(() => reading(page, "译文").getAttribute("aria-disabled"))
      .not.toBe("true");
    const panel = await readerPanel(page, "翻译");
    await panel.getByText(fullTextStrings.storedOnly).waitFor();
    expect(await panel.getByLabel("模型").count()).toBe(0);
    expect(await panel.getByText("在选区旁显示划词翻译").count()).toBe(0);
    // “翻译本段” shows the library's translation of the paragraph.
    const paragraph = section(page, "Paragraph 3:");
    await paragraph.click({ button: "right", position: { x: 40, y: 8 } });
    const menu = page.locator(".ui-context-menu");
    await menu.getByRole("menuitem", { name: "翻译本段" }).click();
    await panel.getByText(/段落译文 \d+：/u).waitFor();
    await panel.getByText(fullTextStrings.stored, { exact: true }).waitFor();
    // The menu closes once it has acted.
    await menu.waitFor({ state: "detached" });
    // The PDF reads the same translation beside its pages.
    await page.goto(`${w.origin}/?literature=${id}&reader=pdf`);
    await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    const pdfPanel = await readerPanel(page, "翻译");
    const open = pdfPanel.getByRole("button", {
      name: "对照翻译",
      exact: true,
    });
    await expect.poll(() => open.isDisabled()).toBe(false);
    await open.click();
    await page.locator(".ft-twin[data-state='ready']").first().waitFor();
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 180000);
