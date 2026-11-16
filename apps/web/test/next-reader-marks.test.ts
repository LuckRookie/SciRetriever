import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
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
    // A view that fails to render is caught and reported, not thrown.
    const broken: string[] = [];
    page.on("console", (m) => {
      if (/TypeError|failed to render/u.test(m.text())) broken.push(m.text());
    });
    // The mark's save answers only once its note shows in the margin: that
    // reply (no note yet) must not take the note back.
    let noted!: () => void;
    const given = new Promise<void>((resolve) => (noted = resolve));
    await page.route("**/api/v1/maintenance/marks**", async (route) => {
      const body = route.request().postDataJSON() as { operation?: string };
      if (body?.operation !== "create") return route.continue();
      const response = await route.fetch();
      await given;
      await route.fulfill({ response });
    });
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
    // Placed in the text (its note shows beside it), then painted as a blue
    // pen line; the failure message lists what is painted.
    await page.locator(".reading-margin-notes .reading-margin-note").waitFor();
    // Now the save answers, without the note.
    noted();
    await expect
      .poll(() => page.evaluate(() => [...CSS.highlights.keys()]))
      .toContain("mark-blue");
    // The note in the right margin, its leader from the marked line.
    const note = page.locator(".reading-margin-notes .reading-margin-note");
    await note.waitFor();
    expect(await note.innerText()).toContain("Check the conditions.");
    // Measured once the note is laid out beside its line (its leader drawn).
    const geometry = () =>
      page.evaluate(() => {
        const sheet = document.querySelector<HTMLElement>(
          ".reader-view:not([hidden])[data-view='doc']",
        )!;
        const article = sheet
          .querySelector(".reading-article")!
          .getBoundingClientRect();
        const n = sheet
          .querySelector(".reading-margin-note-place")
          ?.getBoundingClientRect();
        const path = sheet
          .querySelector(".reading-margin-leaders path")
          ?.getAttribute("d");
        return { column: article.right, note: n?.left ?? 0, path: path ?? "" };
      });
    await expect
      .poll(async () => {
        const g = await geometry();
        return g.note > g.column && /^M [\d.]+ [\d.]+ H/u.test(g.path);
      })
      .toBe(true);
    // Narrow: below its paragraph, in the column.
    await page.setViewportSize({ width: 760, height: 900 });
    await page
      .locator("section[data-byte-start] .reading-margin-note-below")
      .waitFor();
    expect(
      await page
        .locator(".reading-margin-note-below .reading-margin-note-text")
        .innerText(),
    ).toBe("Check the conditions.");
    expect(broken).toEqual([]);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("finds marks of another PDF again, records the place once, and never looks for a region (user organization 9.4)", async () => {
  const other = "e".repeat(64);
  const highlightId = "00000000-0000-4000-8000-0000000000a1",
    regionId = "00000000-0000-4000-8000-0000000000a2";
  // Marks made on another PDF of the main part, written as the catalog
  // keeps them (that file is not in this fixture): a highlight whose words
  // are on this PDF, a region, and a place recorded under an older method.
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => {
      const db = new DatabaseSync(join(env.home, "catalog.sqlite"));
      try {
        const now = new Date().toISOString(),
          paper = env.parseRequest.literature_id;
        const insert = db.prepare(
          "INSERT INTO reading_marks VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,NULL,?)",
        );
        insert.run(
          highlightId,
          paper,
          "highlight",
          "blue",
          "",
          "Synthetic literature workbench",
          "",
          "",
          other,
          4,
          "[[10,20,200,12]]",
          now,
          now,
          "test",
        );
        insert.run(
          regionId,
          paper,
          "region",
          "blue",
          "",
          "",
          "",
          "",
          other,
          1,
          "[[10,20,100,100]]",
          now,
          now,
          "test",
        );
        // The older method's place is on this very PDF: it is not used,
        // the mark is looked for again and the new place replaces it.
        const current = db
          .prepare(
            "SELECT a.sha256 FROM literature_assets la JOIN assets a USING(asset_id) WHERE la.literature_id=? AND la.role='primary-pdf'",
          )
          .get(paper) as { sha256: string };
        db.prepare(
          "INSERT INTO reading_mark_places VALUES(?,?,?,?,?,NULL,NULL,?,?,?)",
        ).run(
          highlightId,
          "pdf",
          current.sha256,
          3,
          "[[1,1,1,1]]",
          1,
          "mark-locate-v0",
          now,
        );
      } finally {
        db.close();
      }
    },
  });
  try {
    const page = w.page;
    const paper = w.env.parseRequest.literature_id;
    const app = w.env.app as unknown as {
      marks: { query(op: unknown): Promise<unknown> };
    };
    const highlight = { mark_id: highlightId };
    const places: string[] = [];
    // A place counts once the service has written it (its reply arrived),
    // not when the request leaves: the list is read right after.
    page.on("response", (response) => {
      const request = response.request();
      if (
        request.url().includes("/api/v1/maintenance/marks") &&
        (request.postData() ?? "").includes('"place"') &&
        response.ok()
      )
        places.push(request.postData()!);
    });
    const open = async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${w.origin}/?literature=${paper}&reader=pdf`);
      await page.locator('[data-pdf-page="1"][data-rendered="true"]').waitFor();
    };
    await open();
    const body = page.locator(".reader-engine-body");
    const top = await body.evaluate((el) => el.scrollTop);
    // Found on this PDF and drawn; recorded once.
    await page.locator('[data-pdf-page="1"] .mark-highlight').first().waitFor();
    await expect.poll(() => places.length).toBe(1);
    // The reading position stays as it was.
    expect(await body.evaluate((el) => el.scrollTop)).toBe(top);
    const saved = (
      (await app.marks.query({
        operation: "list",
        request: { literature_id: paper },
      })) as {
        items: {
          mark_id: string;
          kind: string;
          pdf: { sha256: string; page: number } | null;
          places: { method: string; target: { pdf?: { page: number } } }[];
        }[];
      }
    ).items;
    const mark = saved.find((m) => m.mark_id === highlight.mark_id)!;
    // Its own anchor is untouched; the place is recorded under the current method.
    expect(mark.pdf).toMatchObject({ sha256: other, page: 4 });
    // Recorded under the current method, replacing the older one for this file.
    expect(mark.places.map((p) => p.method)).toEqual(["mark-locate-v1"]);
    expect(
      mark.places.find((p) => p.method === "mark-locate-v1")?.target.pdf?.page,
    ).toBe(1);
    // The region is not drawn here, and the list says whose it is.
    expect(await page.locator(".mark-region").count()).toBe(0);
    await readerPanel(page, "批注");
    await expect
      .poll(() => page.locator(".reader-information").innerText())
      .toContain("属于原来那份文件");
    // A second opening reads the record: drawn, and nothing more recorded.
    await open();
    await page.locator('[data-pdf-page="1"] .mark-highlight').first().waitFor();
    await page.waitForTimeout(500);
    expect(places.length).toBe(1);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);
