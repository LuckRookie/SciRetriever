import { join } from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { readerToLibrary, reopenPaper } from "./reader-controls.js";
import { LAYERS_POINTS, LAYERS_TEXT, storedLayers } from "./stored-layers.js";

/**
 * Plan 28 block 09 (reading-experience 3, ADR 0070): the annotated copy over
 * served replies: the notes on the full text, 脉络, 概览, 导图 and going
 * between them. Screenshots go to SCIRETRIEVER_LAYERS_SHOTS when it is set.
 */
const SHOTS = process.env.SCIRETRIEVER_LAYERS_SHOTS;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};
const sheet = ".reader-view:not([hidden])[data-view='doc']";
/** A stop of the depth bar under the reading copy. */
const view = (page: Page, name: string) =>
  page
    .getByRole("tablist", { name: "读到多细" })
    .getByRole("tab", { name, exact: true });
const mapButton = (page: Page) =>
  page.getByRole("button", { name: "导图", exact: true });
const ball = (page: Page, id: "read" | "translate") =>
  page.locator(`.reader-ball-row[data-ball="${id}"] .reader-ball`);
const shows = (page: Page, layer: string) =>
  page.locator(`${sheet}[data-layer="${layer}"]`).waitFor();
const settled = (page: Page) =>
  page.waitForFunction(() => !document.querySelector(".rl-stage > *"));

it("shows the notes beside the full text and the other layers of an annotated copy (reading-experience 3)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => env.setText(LAYERS_TEXT),
  });
  try {
    const page = w.page,
      id = w.env.parseRequest.literature_id;
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.log("PAGEERROR", error.message, error.stack);
    });
    page.on("console", (m) => {
      if (m.type() === "error") console.log("CONSOLE", m.text());
    });
    await storedLayers(page, { translated: false });
    await page.goto(`${w.origin}/?literature=${id}&reader=doc`);
    await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    await shows(page, "full");
    // 全文: every note in the margin, its sentences wrapped where they lie.
    await expect
      .poll(() => page.locator(`${sheet} .rl-side .rl-pi`).count())
      .toBe(LAYERS_POINTS.length);
    const evidence = LAYERS_POINTS.reduce((n, p) => n + p.evidence.length, 0);
    expect(await page.locator(`${sheet} .rl-ev.rl-ev-end`).count()).toBe(
      evidence,
    );
    expect(await page.locator(`${sheet} .rl-stroke`).count()).toBe(evidence);
    // The author's text is unchanged.
    const first = await page
      .locator(`${sheet} article > section[data-byte-start]`)
      .nth(1)
      .evaluate((el) => el.textContent);
    expect(first).toContain(
      "Earlier reports measured only the onset temperature.",
    );
    expect(first).not.toMatch(/\d\s*$/u);
    await shot(page, "01-full");
    // 脉络: every note as a 纲 with its sentences.
    await view(page, "脉络").click();
    await shows(page, "outline");
    await settled(page);
    expect(await page.locator(`${sheet} .rl-gang`).count()).toBe(
      LAYERS_POINTS.length,
    );
    expect(await page.locator(`${sheet} .rl-mu-s`).count()).toBe(evidence);
    expect(page.url()).toContain("layer=outline");
    await shot(page, "02-outline");
    // 概览: the summary, the main notes, the data.
    await view(page, "概览").click();
    await shows(page, "overview");
    await settled(page);
    const primary = LAYERS_POINTS.filter((p) => p.primary).length;
    expect(await page.locator(`${sheet} .rl-gang`).count()).toBe(primary);
    expect(await page.locator(`${sheet} .rl-dt tbody tr`).count()).toBe(3);
    await shot(page, "03-overview");
    // A click opens more in place (reading-experience 3.2, 3.3): a main note
    // to its sentences or its paragraph, and the reader stays on 概览.
    const opened = `${sheet} :is(.rl-para, .rl-more)`;
    await page.locator(`${sheet} .rl-gang-t`).nth(1).click();
    await page.locator(opened).first().waitFor();
    expect(page.url()).toContain("layer=overview");
    await page.locator(`${sheet} .rl-gang-t`).nth(1).click();
    await expect.poll(() => page.locator(opened).count()).toBe(0);
    // 脉络: a sentence opens to its whole paragraph, marked; a click on it
    // closes it; Esc closes everything opened.
    await view(page, "脉络").click();
    await shows(page, "outline");
    await settled(page);
    const line = page.locator(`${sheet} .rl-mu-s[data-start]`).nth(3);
    const top = await line.evaluate((n) => n.getBoundingClientRect().top);
    await line.click();
    const para = page.locator(`${sheet} .rl-para`);
    await para.first().waitFor();
    expect(page.url()).toContain("layer=outline");
    expect(await para.locator(".rl-ev").count()).toBeGreaterThan(0);
    expect(
      Math.abs(
        (await para.first().evaluate((n) => n.getBoundingClientRect().top)) -
          top,
      ),
    ).toBeLessThan(2);
    await shot(page, "04-opened-in-place");
    await para.first().click();
    await expect.poll(() => para.count()).toBe(0);
    await line.click();
    await para.first().waitFor();
    await page.keyboard.press("Escape");
    await expect.poll(() => para.count()).toBe(0);
    // Opened, then 全文 by the bar: the full text at that paragraph.
    await line.click();
    await para.first().waitFor();
    await view(page, "脉络").click();
    await expect.poll(() => para.count()).toBe(0);
    await line.click();
    await para.first().waitFor();
    await view(page, "全文").click();
    await shows(page, "full");
    await settled(page);
    await shot(page, "04-back-to-full");
    // 导图
    await mapButton(page).click();
    await shows(page, "map");
    expect(await mapButton(page).getAttribute("aria-pressed")).toBe("true");
    await expect
      .poll(() => page.locator(`${sheet} .rl-mn-leaf`).count())
      .toBe(LAYERS_POINTS.length);
    await page.locator(`${sheet} .rl-mn-leaf`).nth(4).hover();
    await page.locator(`${sheet} .rl-ms-t`).waitFor();
    // One engine for the paper, whatever layer it shows.
    expect(await page.locator(".rl-map").count()).toBe(1);
    await shot(page, "05-map");
    await page.locator(`${sheet} .rl-mn-leaf`).nth(4).click();
    await shows(page, "outline");
    await view(page, "全文").click();
    await shows(page, "full");
    await settled(page);
    expect(page.url()).not.toContain("layer=");
    expect(errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 180_000);

it("reads an annotated copy in translation (reading-experience 3.3.2, 9)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => env.setText(LAYERS_TEXT),
  });
  try {
    const page = w.page,
      id = w.env.parseRequest.literature_id;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() =>
      localStorage.setItem(
        "sciretriever:react:sciretriever:reader:text-mode:v1",
        "translation",
      ),
    );
    const fake = await storedLayers(page, { translated: true });
    await page.goto(`${w.origin}/?literature=${id}&reader=doc&layer=outline`);
    await shows(page, "outline");
    expect(fake.asked).toContain("bilingual");
    await expect
      .poll(() => page.locator(`${sheet} .rl-gang-t`).first().textContent())
      .toContain("六种三唑盐");
    await shot(page, "06-outline-translation");
    await view(page, "概览").click();
    await shows(page, "overview");
    await settled(page);
    await shot(page, "07-overview-translation");
    await view(page, "全文").click();
    await shows(page, "full");
    await settled(page);
    await expect
      .poll(() =>
        page.locator(`${sheet} .rl-side .rl-pi-t`).first().textContent(),
      )
      .toContain("六种三唑盐");
    await shot(page, "08-full-translation");
  } finally {
    await w.close();
  }
}, 180_000);

it("moves between layers by hand with Alt and the wheel, and puts notes under their paragraphs on a narrow sheet (reading-experience 3.3.1, 3.4)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => env.setText(LAYERS_TEXT),
  });
  try {
    const page = w.page,
      id = w.env.parseRequest.literature_id;
    await page.setViewportSize({ width: 1440, height: 900 });
    await storedLayers(page, { translated: false });
    await page.goto(`${w.origin}/?literature=${id}&reader=doc`);
    await shows(page, "full");
    await expect
      .poll(() => page.locator(`${sheet} .rl-side .rl-pi`).count())
      .toBe(LAYERS_POINTS.length);
    // Down with Alt held is farther: toward 脉络; it can stop half way.
    await page.mouse.move(600, 500);
    await page.keyboard.down("Alt");
    for (const part of [1, 2, 3]) {
      await page.mouse.wheel(0, 90);
      await page.waitForTimeout(60);
      await shot(page, `09-by-hand-${part}`);
    }
    expect(await page.locator(".rl-stage > *").count()).toBeGreaterThan(0);
    await page.mouse.wheel(0, 120);
    await page.keyboard.up("Alt");
    await settled(page);
    await shows(page, "outline");
    expect(page.url()).toContain("layer=outline");
    // Up again, a little: back where it was.
    await page.keyboard.down("Alt");
    await page.mouse.wheel(0, -60);
    await page.keyboard.up("Alt");
    await settled(page);
    await shows(page, "outline");
    // A narrow sheet has no margin for notes: each stands under its paragraph.
    await page.goto(`${w.origin}/?literature=${id}&reader=doc`);
    await page.setViewportSize({ width: 900, height: 900 });
    await shows(page, "full");
    await expect
      .poll(() => page.locator(`${sheet} article .rl-pi.rl-below`).count())
      .toBe(LAYERS_POINTS.length);
    await shot(page, "10-narrow-full");
    await view(page, "脉络").click();
    await shows(page, "outline");
    await settled(page);
    await shot(page, "11-narrow-outline");
  } finally {
    await w.close();
  }
}, 180_000);

it("opens on the PDF and swaps or pairs with the two balls (reading-experience 1.9, ADR 0071)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => env.setText(LAYERS_TEXT),
  });
  try {
    const page = w.page,
      id = w.env.parseRequest.literature_id;
    await page.setViewportSize({ width: 1440, height: 900 });
    await storedLayers(page, { translated: true });
    // No view in the address: a paper with a PDF opens on its PDF.
    await page.goto(`${w.origin}/?literature=${id}`);
    await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    await expect.poll(() => page.url()).toContain("reader=pdf");
    await expect.poll(() => ball(page, "read").textContent()).toBe("读");
    expect(await page.getByRole("tablist", { name: "读到多细" }).count()).toBe(
      0,
    );
    await shot(page, "12-pdf-first");
    // 读: the reading copy at the full text, the depth bar under it; the ball says 看.
    await ball(page, "read").click();
    await shows(page, "full");
    await expect.poll(() => ball(page, "read").textContent()).toBe("看");
    await view(page, "全文").waitFor();
    // 译: one click swaps to the translation, a double click pairs the two.
    const mode = () =>
      page
        .locator(`${sheet} article.reading-article`)
        .getAttribute("data-text-mode");
    expect(await ball(page, "translate").textContent()).toBe("译");
    await ball(page, "translate").click();
    await expect.poll(mode).toBe("translation");
    expect(await ball(page, "translate").textContent()).toBe("原");
    await page.waitForTimeout(500);
    await ball(page, "translate").dblclick();
    await expect.poll(mode).toBe("bilingual");
    expect(await ball(page, "translate").textContent()).toBe("原/译");
    await shot(page, "13-balls-bilingual");
    // One more click takes the pair back to what showed before it.
    await page.waitForTimeout(500);
    await ball(page, "translate").click();
    await expect.poll(mode).toBe("translation");
    // The depth is kept for the paper: 看, then 读 again, comes back to it.
    await view(page, "脉络").click();
    await shows(page, "outline");
    await settled(page);
    await ball(page, "read").click();
    await expect.poll(() => page.url()).toContain("reader=pdf");
    await ball(page, "read").click();
    await shows(page, "outline");
  } finally {
    await w.close();
  }
}, 180_000);

it("puts the PDF beside the reading copy with a double click on 读, each page following the other (reading-experience 1.9)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => env.setText(LAYERS_TEXT),
  });
  try {
    const page = w.page,
      id = w.env.parseRequest.literature_id;
    await page.setViewportSize({ width: 1600, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await storedLayers(page, { translated: true });
    await page.goto(`${w.origin}/?literature=${id}&reader=pdf`);
    await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    await expect.poll(() => ball(page, "read").textContent()).toBe("读");
    // A double click: the PDF on the left, the reading copy on the right.
    await ball(page, "read").dblclick();
    const left = page.locator(".reader-surface[data-paired] > .reader-beside");
    await left.waitFor();
    await left
      .locator('.reading-pdf-page[data-rendered="true"]')
      .first()
      .waitFor();
    await shows(page, "full");
    expect(await ball(page, "read").textContent()).toBe("看/读");
    const leftBox = await left.boundingBox();
    const rightBox = await page
      .locator(
        ".reader-surface[data-paired] > .reader-engine-body:not(.reader-beside)",
      )
      .boundingBox();
    expect(leftBox!.width).toBeGreaterThan(500);
    expect(rightBox!.x).toBeGreaterThan(leftBox!.x + leftBox!.width - 1);
    // The depth bar stands under the reading copy.
    await view(page, "脉络").click();
    await shows(page, "outline");
    await settled(page);
    await shot(page, "14-pair-outline");
    // Pressing a sentence shows its place on the PDF; the reading copy stays.
    await page.locator(`${sheet} .rl-mu-s`).first().click();
    await page.locator(".reader-beside .reading-pdf-locator").waitFor();
    await shows(page, "outline");
    // 译 beside the PDF (ADR 0072): both pages in translation; 原/译 keeps
    // the original on the left and the translation on the right.
    const text = () =>
      page
        .locator(`${sheet} article.reading-article`)
        .getAttribute("data-text-mode");
    const twin = left.locator(".ft-twin[data-state='ready']");
    await page.waitForTimeout(500);
    await ball(page, "translate").click();
    await expect.poll(text).toBe("translation");
    await twin.first().waitFor();
    await shot(page, "15-pair-translation");
    await page.waitForTimeout(500);
    const row = page.locator('.reader-ball-row[data-ball="translate"]');
    await row.hover();
    await row.locator(".reader-ball-pair").click();
    await expect
      .poll(() => ball(page, "translate").textContent())
      .toBe("原/译");
    await expect.poll(() => twin.count()).toBe(0);
    expect(await text()).toBe("translation");
    await shot(page, "16-pair-original-left-translation-right");
    await row.locator(".reader-ball-pair").click();
    await expect
      .poll(() => ball(page, "translate").textContent())
      .not.toBe("原/译");
    if ((await ball(page, "translate").textContent()) === "原") {
      await page.waitForTimeout(500);
      await ball(page, "translate").click();
    }
    await expect.poll(text).toBe("original");
    // The handle moves the edge, within 30 % to 70 %.
    const handle = page.locator(".reader-pair-handle");
    await handle.focus();
    for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowRight");
    expect(await handle.getAttribute("aria-valuenow")).toBe("70");
    await handle.dblclick();
    expect(await handle.getAttribute("aria-valuenow")).toBe("50");
    // The pair is kept for the paper.
    await page.reload();
    await left.waitFor();
    // One more click takes the pair back to what showed before it: the PDF.
    await page.waitForTimeout(500);
    await ball(page, "read").click();
    await expect.poll(() => page.url()).toContain("reader=pdf");
    await expect.poll(() => left.count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 180_000);

it("reads layers published after the paper was first opened in the session (reading-experience 3.9)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => env.setText(LAYERS_TEXT),
  });
  try {
    const page = w.page,
      id = w.env.parseRequest.literature_id;
    await page.setViewportSize({ width: 1440, height: 900 });
    // Opened while the paper is being parsed: the text is there, its layers
    // come a step later on the same version (technical 04 §9.3).
    const fake = await storedLayers(page, { state: "none", translated: false });
    await page.goto(`${w.origin}/?literature=${id}&reader=doc`);
    await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    await page.locator(`${sheet} article`).waitFor();
    expect(await page.getByRole("tablist", { name: "读到多细" }).count()).toBe(
      0,
    );
    fake.state = "complete";
    // Back to the paper in the same session: the notes are there and the
    // depth bar and 导图 work, not only shown.
    await readerToLibrary(page);
    await reopenPaper(page, "Synthetic literature workbench");
    await expect
      .poll(() => page.locator(`${sheet} .rl-side .rl-pi`).count(), {
        timeout: 20_000,
      })
      .toBe(LAYERS_POINTS.length);
    await view(page, "概览").click();
    await shows(page, "overview");
    await settled(page);
    await mapButton(page).click();
    await shows(page, "map");
  } finally {
    await w.close();
  }
}, 180_000);
