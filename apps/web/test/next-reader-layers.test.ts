import { join } from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";
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
const view = (page: Page, name: string) =>
  page
    .getByRole("tablist", { name: "阅读视图" })
    .getByRole("tab", { name, exact: true });
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
    // A main note goes to 脉络, a sentence there to 全文.
    await page.locator(`${sheet} .rl-gang-t`).nth(1).click();
    await shows(page, "outline");
    await settled(page);
    await page.locator(`${sheet} .rl-mu-s`).nth(3).click();
    await shows(page, "full");
    await settled(page);
    await shot(page, "04-back-to-full");
    // 导图
    await view(page, "导图").click();
    await shows(page, "map");
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
