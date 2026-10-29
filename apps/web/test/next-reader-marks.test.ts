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
