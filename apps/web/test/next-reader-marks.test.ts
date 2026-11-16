import { readerPanel } from "./reader-controls.js";
import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";

it(
  "highlights, notes, region captures, undo and export on a PDF, saved through the shared marks contract",
  { timeout: 0 },
  async () => {
    const w = await nextWorkspace({ ready: "body" });
    try {
      const page = w.page,
        paper = w.env.parseRequest.literature_id;
      await page.goto(`${w.origin}/?literature=${paper}&reader=pdf`);
      await page
        .locator('.reading-pdf-page[data-rendered="true"] .textLayer span')
        .first()
        .waitFor();
      // A person selects words on the text layer; the ink bar offers colours.
      const quote = await page.evaluate(() => {
        const span = [
          ...document.querySelectorAll<HTMLElement>(
            '.reading-pdf-page[data-pdf-page="1"] .textLayer span',
          ),
        ].find((s) => (s.textContent ?? "").trim().length >= 12)!;
        const text = span.firstChild as Text;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, Math.min(text.data.length, 24));
        const selection = getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        span.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        span.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        return range.toString().replace(/\s+/g, " ").trim();
      });
      const bar = page.getByRole("toolbar", { name: "选中文字" });
      await bar.waitFor();
      await page.keyboard.press("3");
      await expect
        .poll(() => page.locator(".mark-highlight").count())
        .toBeGreaterThan(0);
      await readerPanel(page, "批注");
      await page.getByRole("tab", { name: "批注 1" }).click();
      await expect
        .poll(() => page.locator(".mark-card-quote").first().textContent())
        .toBe(quote);

      // Clicking the highlight opens its bar; deleting can be undone.
      const box = (await page
        .locator(".mark-highlight")
        .first()
        .boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.up();
      await page.getByRole("toolbar", { name: "批注" }).waitFor();
      await page.keyboard.press("Backspace");
      await expect.poll(() => page.locator(".mark-highlight").count()).toBe(0);
      // The newest change replaces the earlier toast, so undo means the delete.
      await page
        .locator(".ui-toast", { hasText: "已删除批注" })
        .getByRole("button", { name: "撤销" })
        .click();
      await expect
        .poll(() => page.locator(".mark-highlight").count())
        .toBeGreaterThan(0);

      // Region capture with R, then a note with a #tag.
      await page.keyboard.press("r");
      const sheet = (await page
        .locator('.reading-pdf-page[data-pdf-page="1"]')
        .boundingBox())!;
      await page.mouse.move(
        sheet.x + sheet.width * 0.2,
        sheet.y + sheet.height * 0.55,
      );
      await page.mouse.down();
      await page.mouse.move(
        sheet.x + sheet.width * 0.6,
        sheet.y + sheet.height * 0.75,
        {
          steps: 6,
        },
      );
      await page.mouse.up();
      await page.locator(".mark-region").first().waitFor();
      await page.keyboard.press("n");
      await page
        .getByRole("textbox", { name: "笔记" })
        .fill("复现时核对坐标 #图表");
      await page.keyboard.press("Control+Enter");
      await expect.poll(() => page.locator(".mark-note").count()).toBe(1);
      await expect
        .poll(() => page.locator(".mark-tag").first().textContent())
        .toBe("#图表");
      // Spec 3.5: resting on the dot shows the note; leaving hides it.
      await page.mouse.move(5, 5);
      await page.locator(".mark-note").first().hover();
      const peek = page.locator(".mark-note-peek");
      await peek.waitFor();
      expect(await peek.innerText()).toContain("复现时核对坐标");
      await page.mouse.move(5, 5);
      await peek.waitFor({ state: "detached" });

      // The same marks are readable without the Web, and export as Markdown.
      const saved = (await w.env.app.marks.query({
        operation: "list",
        request: { literature_id: paper },
      })) as { items: { kind: string; note: string }[] };
      expect(saved.items.map((m) => m.kind).sort()).toEqual([
        "highlight",
        "region",
      ]);
      await page.getByRole("button", { name: "导出 Markdown" }).click();
      const exported = page.getByRole("dialog", { name: "导出批注" });
      await expect
        .poll(() => exported.locator("pre").textContent())
        .toContain("## 第 1 页");
      await expect
        .poll(() => exported.locator("pre").textContent())
        .toContain(`> ${quote}`);
      expect(w.errors).toEqual([]);
    } finally {
      await w.close();
    }
  },
);

it("draws a full-text mark as its colour's pen line, its note in the right margin with a leader, below the paragraph when narrow (spec 2.5)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) =>
      env.setText(
        Array.from(
          { length: 60 },
          (_, i) =>
            `Paragraph ${i}: a reported measurement with conditions and evidence.\n\n`,
        ).join(""),
      ),
  });
  try {
    const page = w.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=doc`,
    );
    await page
      .locator(".reader-engine-body section[data-byte-start]")
      .nth(10)
      .waitFor();
    await page.evaluate(() => {
      const block = [
        ...document.querySelectorAll<HTMLElement>(
          ".reader-view:not([hidden]) article > section[data-byte-start]",
        ),
      ].find((b) => (b.textContent ?? "").includes("Paragraph 3:"))!;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let text = walker.nextNode() as Text | null;
      while (text && !text.data.includes("Paragraph 3:"))
        text = walker.nextNode() as Text | null;
      const range = document.createRange();
      const at = text!.data.indexOf("Paragraph 3:");
      range.setStart(text!, at);
      range.setEnd(text!, at + 20);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      block.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      block.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    await page.getByRole("toolbar", { name: "选中文字" }).waitFor();
    // N: a mark in the pen's colour (blue by default) and its note.
    await page.keyboard.press("n");
    const field = page.getByRole("textbox", { name: "笔记" });
    await field.fill("Check the conditions.");
    await field.press("Control+Enter");
    // The pen line: an underline in --t-blue, never a fill.
    const rule = await page.evaluate(() => {
      for (const sheet of document.styleSheets)
        for (const r of sheet.cssRules) {
          const inner = r instanceof CSSLayerBlockRule ? [...r.cssRules] : [r];
          for (const x of inner)
            if (
              x instanceof CSSStyleRule &&
              x.selectorText.includes("::highlight(mark-blue)") &&
              x.style.textDecorationColor.startsWith("var(")
            )
              return {
                color: x.style.textDecorationColor,
                fill: x.style.backgroundColor,
              };
        }
      return null;
    });
    expect(rule).toEqual({ color: "var(--t-blue)", fill: "" });
    expect(await page.evaluate(() => CSS.highlights.has("mark-blue"))).toBe(
      true,
    );
    // The note in the right margin, its leader from the marked line.
    const note = page.locator(".reading-margin-notes .reading-margin-note");
    await note.waitFor();
    expect(await note.innerText()).toContain("Check the conditions.");
    const geometry = await page.evaluate(() => {
      const sheet = document.querySelector<HTMLElement>(
        ".reader-view:not([hidden])[data-view='doc']",
      )!;
      const article = sheet
        .querySelector(".reading-article")!
        .getBoundingClientRect();
      const n = sheet
        .querySelector(".reading-margin-note-place")!
        .getBoundingClientRect();
      const path = sheet
        .querySelector(".reading-margin-leaders path")!
        .getAttribute("d")!;
      return {
        column: article.right,
        note: n.left,
        path,
        top: sheet.getBoundingClientRect().top,
      };
    });
    expect(geometry.note).toBeGreaterThan(geometry.column);
    expect(geometry.path).toMatch(/^M [\d.]+ [\d.]+ H/u);
    // Narrow: below its paragraph, in the column.
    await page.setViewportSize({ width: 760, height: 900 });
    await page
      .locator("section[data-byte-start] .reading-margin-note-below")
      .waitFor();
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);
