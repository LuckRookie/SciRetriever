import { expect, it } from "vitest";
import {
  readerMore,
  readerPanel,
  readerToLibrary,
  readerType,
  readerView,
} from "./reader-controls.js";
import { nextWorkspace } from "./next-workspace-fixture.js";

const TEXT = [
  "Author One and Author Two",
  "Received 1 May 2024",
  "Department of Chemistry, Example University",
  "The cited result holds for both panels.",
  "Panel A of the figure.",
  "Panel B of the figure.",
  "Fig. 1 Two panels of one figure.",
  "A footnote that the paragraph cites.",
  "## Results",
  "Measured values follow.",
].join("\n\n");

/** UTF-8 range of a block in the published document, as the structure reports it. */
function ranger(text: string) {
  const encoder = new TextEncoder();
  return (block: string) => {
    const at = text.indexOf(block);
    if (at < 0) throw new Error(`block not in document: ${block}`);
    const start = encoder.encode(text.slice(0, at)).length;
    return {
      start_utf8: start,
      end_utf8: start + encoder.encode(block).length,
    };
  };
}

it("folds article information, lays out figure groups and footnotes, and names untitled sections by role", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => {
      env.setText(TEXT + "\n");
    },
  });
  try {
    const read = w.env.app.documentRead;
    const current = await read.default({
      literature_id: w.env.parseRequest.literature_id,
      asset_id: w.env.parseRequest.asset_id,
      asset_sha256: w.env.parseRequest.asset_sha256,
    });
    const document_version_id = current.default!.document_version_id;
    const segments = await read.segments({
      document_version_id,
      section_id: null,
      limit: 200,
      cursor: null,
    });
    const total = Math.max(...segments.segments.map((s) => s.end_utf8));
    const slice = await read.slice({
      document_version_id,
      selector: { kind: "range", start_utf8: 0, end_utf8: total },
      max_bytes: 65536,
      continuation: null,
    });
    const range = ranger(slice.text);
    // The layout shape is the server's (contract in ADR 0054's plan block); this checks the page.
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/document-describe",
      async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.result.layout = {
          schema_version: 1,
          article_info: [
            range("Received 1 May 2024"),
            range("Department of Chemistry, Example University"),
          ],
          figure_groups: [
            {
              group_id: "g1",
              kind: "figure",
              objects: [
                {
                  segment_id: "a",
                  row: 0,
                  column: 0,
                  ...range("Panel A of the figure."),
                },
                {
                  segment_id: "b",
                  row: 0,
                  column: 1,
                  ...range("Panel B of the figure."),
                },
              ],
              captions: [
                {
                  segment_id: "c",
                  ...range("Fig. 1 Two panels of one figure."),
                },
              ],
              rows: [2],
            },
          ],
          footnotes: [
            {
              segment_id: "n",
              page_index: 0,
              ...range("A footnote that the paragraph cites."),
            },
          ],
        };
        await route.fulfill({ response, json: body });
      },
    );
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/document-outline",
      async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        const [first, ...rest] = body.result.sections;
        body.result.sections = [
          {
            ...first,
            title: null,
            title_truncated: false,
            role: "introduction",
            role_source: "arrangement",
          },
          ...rest.map((section: object) =>
            "role" in section
              ? section
              : { ...section, role: null, role_source: null },
          ),
        ];
        await route.fulfill({ response, json: body });
      },
    );
    await w.page.goto(
      `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=doc`,
    );
    const article = w.page.locator(".reading-article");
    await article.getByText("Measured values follow.").waitFor();
    // Article information starts folded behind one toggle and opens on demand.
    const toggle = article.getByRole("button", {
      name: "文章信息",
      exact: true,
    });
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    expect(await article.getByText("Received 1 May 2024").isVisible()).toBe(
      false,
    );
    await toggle.click();
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await article.getByText("Received 1 May 2024").isVisible()).toBe(
      true,
    );
    // Two panels share one row; the caption and the footnote take their own styles.
    const cells = article.locator(".reading-figure-cell");
    expect(await cells.count()).toBe(2);
    const [left, right] = [
      await cells.nth(0).boundingBox(),
      await cells.nth(1).boundingBox(),
    ];
    expect(Math.abs(left!.y - right!.y)).toBeLessThan(2);
    expect(right!.x).toBeGreaterThan(left!.x + left!.width - 1);
    expect(
      await article.locator(".reading-figure-caption").innerText(),
    ).toContain("Fig. 1");
    expect(await article.locator(".reading-footnote").innerText()).toContain(
      "A footnote",
    );
    // The Markdown carries no layout markers: the body text is the paper's own.
    expect(await article.innerText()).not.toMatch(/mktero|<!--|:::/);
    // An untitled section is listed by its role, marked as such.
    await readerMore(w.page, "显示目录");
    const entry = w.page.locator(".reader-outline-entry[data-untitled]");
    await entry.waitFor();
    expect(await entry.innerText()).toBe("引言");
    expect(
      await w.page
        .locator(".reader-outline-entry", { hasText: "Results" })
        .count(),
    ).toBe(1);
    expect(w.errors).toEqual([]);
  } finally {
    await w.page.unrouteAll({ behavior: "wait" });
    await w.close();
  }
}, 90000);

it("marks a long document above the text, in the information panel and in the library row", async () => {
  const w = await nextWorkspace({ ready: "body" });
  const long = {
    pages: 294,
    arrange_input_bytes: 796130,
    reasons: ["pages", "arrange-input"],
  };
  // The flag is the server's (ADR 0055 contract); this checks the page.
  const withLong = async (
    route: import("playwright").Route,
    // Response bodies are untyped JSON; each route edits its own known path.
    mutate: (body: ReturnType<typeof JSON.parse>) => void,
  ) => {
    const response = await route.fetch();
    const body = await response.json();
    mutate(body);
    await route.fulfill({ response, json: body });
  };
  try {
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/document-describe",
      (route) =>
        withLong(route, (body) => {
          body.result.long_document = long;
        }),
    );
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/read",
      (route) =>
        withLong(route, (body) => {
          const r = body.result ?? body;
          (r.detail ?? r).long_document = long;
        }),
    );
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/search",
      (route) =>
        withLong(route, (body) => {
          const r = body.result ?? body;
          for (const item of (r.page ?? r).items ?? [])
            item.long_document = long;
        }),
    );
    await w.page.goto(
      `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=doc`,
    );
    const note = w.page.locator(".reading-long-document");
    await note.waitFor();
    expect(await note.innerText()).toBe(
      "长文档：按简化流程建档，未逐页校订，文字可能含解析错误；以 PDF 为准（294 页）",
    );
    expect(await w.page.getByText("长文档（294 页）· 未逐页校订").count()).toBe(
      1,
    );
    await w.page.goto(`${w.origin}/?view=lib`);
    await w.page
      .locator(".paper-status-note", { hasText: "长文档" })
      .first()
      .waitFor();
    expect(w.errors).toEqual([]);
  } finally {
    await w.page.unrouteAll({ behavior: "wait" });
    await w.close();
  }
}, 90000);

// Spec 4.2 and 8.2: the block at the reading line keeps its place on screen
// (within 2 px) when the font size, the information panel or the window width
// changes; the reading line is 28% down the scroll area (spec 10).
it("keeps the block at the reading line in place across font size, information panel and window width", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) =>
      env.setText(
        Array.from(
          { length: 300 },
          (_, i) =>
            `Paragraph ${i}: a reported measurement with conditions and evidence, long enough to wrap when the column narrows.\n\n`,
        ).join(""),
      ),
  });
  try {
    await w.page.setViewportSize({ width: 1440, height: 900 });
    await w.page.goto(
      `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=doc`,
    );
    const body = w.page.locator(".reader-engine-body");
    await body.locator("section[data-byte-start]").nth(40).waitFor();
    await body.evaluate((el) => {
      el.scrollTop = 1800;
    });
    /** The block at the reading line and its top, or that block's top now. */
    const anchor = (key?: string) =>
      body.evaluate((el, wanted) => {
        // Spec 4.1: 28% down the visible desk, below the page header.
        const header = el.querySelector<HTMLElement>(
            ".reader-view:not([hidden]) .reader-page-header",
          ),
          below = header?.getClientRects().length ? header.offsetHeight : 0;
        const line =
          el.getBoundingClientRect().top +
          below +
          (el.clientHeight - below) * 0.28;
        const blocks = [
          ...el.querySelectorAll<HTMLElement>(
            ".reader-view:not([hidden]) article > section[data-byte-start]",
          ),
        ];
        const block = wanted
          ? blocks.find((b) => b.dataset.byteStart === wanted)
          : blocks.find((b) => b.getBoundingClientRect().bottom > line);
        return {
          key: block?.dataset.byteStart ?? "",
          top: block?.getBoundingClientRect().top ?? Number.NaN,
        };
      }, key);
    /** Layout unchanged for 200 ms (spec 8.2 "still"), at most 2 s. */
    const still = () =>
      body.evaluate(
        (el) =>
          new Promise<void>((resolve) => {
            const start = performance.now();
            let last = "",
              changed = start;
            const tick = (t: number) => {
              const now = `${el.scrollTop}:${el.scrollHeight}:${el.clientWidth}:${el.clientHeight}`;
              if (now !== last) changed = t;
              last = now;
              if (t - changed >= 200 || t - start > 2000) resolve();
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
      );
    await still();
    const moves: Record<string, number> = {};
    const measure = async (name: string, change: () => Promise<unknown>) => {
      const before = await anchor();
      await change();
      await still();
      const after = await anchor(before.key);
      moves[name] = Math.abs(after.top - before.top);
    };
    const font = (size: number) => readerType(w.page, `${size} px`);
    const first = await anchor();
    await measure("font 20 → 24", () => font(24));
    await measure("font 24 → 20", () => font(20));
    moves["font round trip"] = Math.abs(
      (await anchor(first.key)).top - first.top,
    );
    // The side panel starts closed (spec 1.4): open, then close.
    await measure("panel open", () =>
      w.page.getByRole("button", { name: "显示信息", exact: true }).click(),
    );
    await measure("panel closed", () =>
      w.page.getByRole("button", { name: "收起信息", exact: true }).click(),
    );
    await measure("window 1440 → 1200", () =>
      w.page.setViewportSize({ width: 1200, height: 900 }),
    );
    await measure("window 1200 → 1440", () =>
      w.page.setViewportSize({ width: 1440, height: 900 }),
    );
    for (const [name, move] of Object.entries(moves))
      expect(move, name).toBeLessThanOrEqual(2);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

// Spec 4.4 and 4.5: a far jump can be undone (the floating way back, Alt+←
// and Alt+→), and a paper opened again returns to where it was read.
it("returns from an outline jump with Alt+← and reopens a paper where it was left", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) =>
      env.setText(
        Array.from(
          { length: 300 },
          (_, i) =>
            `Paragraph ${i}: a reported measurement with conditions and evidence.\n\n`,
        ).join(""),
      ),
  });
  try {
    await w.page.setViewportSize({ width: 1440, height: 900 });
    const url = `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=doc`;
    await w.page.goto(url);
    const body = w.page.locator(".reader-engine-body");
    await body.locator("section[data-byte-start]").nth(40).waitFor();
    await body.evaluate((el) => {
      el.scrollTop = 1200;
    });
    const atLine = () =>
      body.evaluate((el) => {
        // Spec 4.1: 28% down the visible desk, below the page header.
        const header = el.querySelector<HTMLElement>(
            ".reader-view:not([hidden]) .reader-page-header",
          ),
          below = header?.getClientRects().length ? header.offsetHeight : 0;
        const line =
          el.getBoundingClientRect().top +
          below +
          (el.clientHeight - below) * 0.28;
        const block = [
          ...el.querySelectorAll<HTMLElement>(
            ".reader-view:not([hidden]) article > section[data-byte-start]",
          ),
        ].find((b) => b.getBoundingClientRect().bottom > line)!;
        return {
          key: block.dataset.byteStart!,
          top: block.getBoundingClientRect().top,
        };
      });
    const topOf = (key: string) =>
      body.evaluate(
        (el, wanted) =>
          el
            .querySelector<HTMLElement>(
              `.reader-view:not([hidden]) section[data-byte-start="${wanted}"]`,
            )!
            .getBoundingClientRect().top,
        key,
      );
    await w.page.waitForTimeout(400);
    const before = await atLine();
    // Jump far away through the outline.
    await readerMore(w.page, "显示目录");
    await w.page
      .locator(".reader-outline-entry", { hasText: "Conclusion" })
      .click();
    // Spec 1.2: the way back sits in the page header, before what shows.
    const back = w.page.locator(
      ".reader-view:not([hidden]) .reader-page-header-back",
    );
    await expect.poll(() => back.textContent()).toMatch(/^↩ 回到 ¶\d+$/u);
    // Back: the block that was at the reading line is there again (the outline
    // panel opened meanwhile, so lines wrap differently; the block is the place).
    await w.page.keyboard.press("Alt+ArrowLeft");
    await expect.poll(async () => (await atLine()).key).toBe(before.key);
    await expect.poll(() => back.count()).toBe(0);
    // Forward again, then back by the button.
    await w.page.keyboard.press("Alt+ArrowRight");
    await back.waitFor();
    await back.click();
    await expect.poll(async () => (await atLine()).key).toBe(before.key);
    // Read on a little, then open the paper again: the same block at the same
    // place. Choosing an entry already closed the outline (spec 1.6).
    expect(await w.page.locator(".reader-outline").count()).toBe(0);
    await body.evaluate((el) => {
      el.scrollTop += 640;
    });
    await w.page.waitForTimeout(400);
    // The record is the block and where the line falls in it (spec 4.1); a line
    // in the space between two blocks is recorded as the lower block's top.
    // Put the line inside a block, so the remembered place is exact.
    const gap = await atLine();
    const line = await body.evaluate((el) => {
      const header = el.querySelector<HTMLElement>(
          ".reader-view:not([hidden]) .reader-page-header",
        ),
        below = header?.getClientRects().length ? header.offsetHeight : 0;
      return (
        el.getBoundingClientRect().top +
        below +
        (el.clientHeight - below) * 0.28
      );
    });
    if (gap.top > line)
      await body.evaluate(
        (el, by) => {
          el.scrollTop += by;
        },
        gap.top - line + 6,
      );
    await w.page.waitForTimeout(800);
    const left = await atLine();
    await w.page.goto(url);
    await body.locator("section[data-byte-start]").first().waitFor();
    await expect
      .poll(async () => {
        const top = await topOf(left.key).catch(() => Number.NaN);
        return Math.abs(top - left.top);
      })
      .toBeLessThanOrEqual(2);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

// Spec 4.4 lists the marks list among jumps: opening a mark from it records the place first.
it("records the place before the marks list moves the reader", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) =>
      env.setText(
        Array.from(
          { length: 300 },
          (_, i) =>
            `Paragraph ${i}: a reported measurement with conditions and evidence.\n\n`,
        ).join(""),
      ),
  });
  try {
    await w.page.setViewportSize({ width: 1440, height: 900 });
    await w.page.goto(
      `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=doc`,
    );
    const body = w.page.locator(".reader-engine-body");
    await body.locator("section[data-byte-start]").nth(40).waitFor();
    // Mark words of an early paragraph, as a person selecting them would.
    await w.page.evaluate(() => {
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
      range.setEnd(text!, at + 30);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      block.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      block.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    await w.page.getByRole("toolbar", { name: "选中文字" }).waitFor();
    await w.page.keyboard.press("3");
    await readerPanel(w.page, "批注");
    await w.page.getByRole("tab", { name: "批注 1" }).waitFor();
    // Read far on, then go to the mark from the list. The place is the block
    // at the reading line and where the line falls in it (spec 4.1): put the
    // line inside a block, not in the space between two.
    const left = await body.evaluate((el) => {
      el.scrollTop = 6000;
      const header = el.querySelector<HTMLElement>(
          ".reader-view:not([hidden]) .reader-page-header",
        ),
        below = header?.getClientRects().length ? header.offsetHeight : 0;
      const line =
        el.getBoundingClientRect().top +
        below +
        (el.clientHeight - below) * 0.28;
      const block = [
        ...el.querySelectorAll<HTMLElement>(
          ".reader-view:not([hidden]) article > section[data-byte-start]",
        ),
      ].find((b) => b.getBoundingClientRect().bottom > line);
      const top = block?.getBoundingClientRect().top ?? line;
      if (top > line) el.scrollTop += top - line + 6;
      return el.scrollTop;
    });
    await w.page.waitForTimeout(400);
    await w.page.getByRole("tab", { name: "批注 1" }).click();
    await w.page
      .getByRole("button", { name: /^转到批注：Paragraph 3/u })
      .click();
    // Spec 1.2: the way back sits in the page header, before what shows.
    const back = w.page.locator(
      ".reader-view:not([hidden]) .reader-page-header-back",
    );
    await expect.poll(() => back.textContent()).toMatch(/^↩ 回到 ¶\d+$/u);
    await back.click();
    await expect
      .poll(() => body.evaluate((el, at) => Math.abs(el.scrollTop - at), left))
      .toBeLessThanOrEqual(2);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("puts the reader under one top bar: navigation in a drawer, the views, find, type, side panel and “更多” with every operation (spec 1.3)", async () => {
  const w = await nextWorkspace({ ready: "body" });
  const menuItems = async (button: string) => {
    await w.page.getByRole("button", { name: button, exact: true }).click();
    const names = await w.page
      .getByRole("menuitem")
      .evaluateAll((items) =>
        items.map((item) =>
          (item.querySelector('[slot="label"]')?.textContent ?? "").trim(),
        ),
      );
    await w.page.keyboard.press("Escape");
    await w.page.locator(".ui-menu").waitFor({ state: "detached" });
    return names;
  };
  try {
    await w.page.setViewportSize({ width: 1440, height: 900 });
    const id = w.env.parseRequest.literature_id;
    await w.page.goto(`${w.origin}/?literature=${id}&reader=doc`);
    await w.page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    // No site sidebar; the navigation button and the paper's tab instead.
    expect(await w.page.locator("aside.navigation").count()).toBe(0);
    await w.page
      .getByRole("navigation", { name: "阅读标签", exact: true })
      .getByRole("button", {
        name: "Synthetic literature workbench",
        exact: true,
      })
      .waitFor();
    // Only what can be used: 原文 and PDF, no overview, flow or question box,
    // not even disabled (no reading-layer or question capability here).
    expect(
      await w.page
        .getByRole("tablist", { name: "阅读视图" })
        .getByRole("tab")
        .allInnerTexts(),
    ).toEqual(["原文", "PDF"]);
    expect(await w.page.getByPlaceholder("向这份资料提问").count()).toBe(0);
    expect(await w.page.getByRole("tab", { name: /概览|脉络/ }).count()).toBe(
      0,
    );
    // The navigation drawer opens from the start edge; Esc or outside closes it.
    const open = w.page.getByRole("button", { name: "打开导航", exact: true });
    const drawer = w.page.getByRole("dialog", { name: "导航" });
    await open.click();
    await drawer.getByRole("button", { name: /^文献库/ }).waitFor();
    const box = (await drawer.boundingBox())!;
    expect(box.x).toBeLessThan(2);
    await w.page.keyboard.press("Escape");
    await drawer.waitFor({ state: "detached" });
    await open.click();
    await drawer.waitFor();
    await w.page.mouse.click(1400, 450);
    await drawer.waitFor({ state: "detached" });
    // Every operation of the old toolbar has a place (spec 1.3).
    const more = await menuItems("更多");
    for (const item of [
      "运行算子…",
      "编辑校订稿",
      "显示目录",
      "进入专注模式",
      "高亮笔",
      "笔颜色",
      "获取 PDF",
      "上传 PDF",
      "核验文章身份",
      "导出书目",
      "下载已核验的原始 PDF",
      "下载全文 Markdown",
      "加工结果",
    ])
      expect(more, item).toContain(item);
    expect(more).not.toContain("复制引用");
    expect(more.some((item) => item.includes("解析"))).toBe(false);
    expect(more).not.toContain("框选区域");
    // Spec 1.3: the scale group (放大, 缩小, 恢复默认), then the two switches.
    expect(await menuItems("排版")).toEqual([
      "放大",
      "缩小",
      "恢复默认",
      "标出关键句",
      "显示核对依据",
    ]);
    // Shortcuts outside text fields: Alt+4 the PDF, Alt+3 back, O the outline, ⌘/Ctrl+F find.
    await w.page
      .locator(".reader-engine-body")
      .click({ position: { x: 5, y: 5 } });
    await w.page.keyboard.press("Alt+4");
    await expect
      .poll(() => new URL(w.page.url()).searchParams.get("reader"))
      .toBe("pdf");
    await w.page
      .locator(
        '.reader-view[data-view="pdf"]:not([hidden]) .reading-pdf-page[data-rendered="true"]',
      )
      .first()
      .waitFor();
    expect(await menuItems("更多")).toContain("框选区域");
    // Spec 1.3: the PDF's scale group, with “实际大小”.
    expect((await menuItems("排版")).slice(0, 4)).toEqual([
      "放大",
      "缩小",
      "适合宽度",
      "实际大小",
    ]);
    await w.page.keyboard.press("Alt+3");
    await expect
      .poll(() => new URL(w.page.url()).searchParams.get("reader"))
      .toBe("doc");
    await w.page.keyboard.press("o");
    await w.page.locator(".reader-outline").waitFor();
    await w.page.keyboard.press("o");
    await w.page.locator(".reader-outline").waitFor({ state: "detached" });
    await w.page.keyboard.press("Control+f");
    await expect
      .poll(() =>
        w.page
          .getByRole("searchbox", { name: "查找…", exact: true })
          .evaluate((el) => el === document.activeElement),
      )
      .toBe(true);
    await w.page
      .locator(".reader-engine-body")
      .click({ position: { x: 5, y: 5 } });
    // Below 760 px find, type and the side panel are in “更多”.
    await w.page.setViewportSize({ width: 700, height: 900 });
    await expect
      .poll(() =>
        w.page.getByRole("button", { name: "查找…", exact: true }).count(),
      )
      .toBe(0);
    const compact = await menuItems("更多");
    // The same name as everywhere else (spec 1.8): “查找…”.
    for (const item of ["查找…", "排版", "收起信息"])
      expect(compact.some((name) => name === item || name === "显示信息")).toBe(
        true,
      );
    // Below 640 px: no tabs, the views as one button, the title in the page header.
    await w.page.setViewportSize({ width: 600, height: 900 });
    await expect
      .poll(() =>
        w.page
          .getByRole("navigation", { name: "阅读标签", exact: true })
          .count(),
      )
      .toBe(0);
    await w.page.getByRole("button", { name: "视图：原文" }).click();
    expect(await w.page.getByRole("menuitem").allInnerTexts()).toEqual(["PDF"]);
    await w.page.keyboard.press("Escape");
    await expect
      .poll(() =>
        w.page
          .locator(".reader-view:not([hidden]) .reader-page-header-source")
          .innerText(),
      )
      .toBe("Synthetic literature workbench");
    // Leaving the reader brings the site sidebar back.
    await w.page.setViewportSize({ width: 1440, height: 900 });
    await readerToLibrary(w.page);
    await w.page.locator("aside.navigation").waitFor();
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("lays the PDF on the sheet's desk, one sheet per page, and folds the top bar in focus mode (spec 3.5, 1.7)", async () => {
  const w = await nextWorkspace({ ready: "body" });
  const box = async (selector: string) =>
    (await w.page.locator(selector).first().boundingBox())!;
  const shown = ".reader-engine:not([hidden]) .reader-view:not([hidden])";
  try {
    await w.page.setViewportSize({ width: 1440, height: 900 });
    const id = w.env.parseRequest.literature_id;
    await w.page.goto(`${w.origin}/?literature=${id}&reader=doc`);
    await w.page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    const sheet = await box(`${shown}[data-view="doc"]`);
    await readerView(w.page, "PDF");
    await w.page
      .locator(
        `${shown}[data-view="pdf"] .reading-pdf-page[data-rendered="true"]`,
      )
      .first()
      .waitFor();
    // At 适宽 a page is the sheet: as wide, at the same place.
    const page = await box(`${shown} .reading-pdf-page`);
    expect(Math.abs(page.x - sheet.x)).toBeLessThan(1);
    expect(Math.abs(page.width - sheet.width)).toBeLessThan(1);
    // The page header sits on the column's top, over the first page.
    const header = await box(`${shown} .reader-page-header`);
    expect(Math.abs(header.x - page.x)).toBeLessThan(1);
    expect(Math.abs(header.width - page.width)).toBeLessThan(1);
    expect(Math.abs(header.y + header.height - page.y)).toBeLessThan(1);
    // Pages are separate sheets with 16 px of desk between them.
    expect(
      await w.page
        .locator(`${shown} .reading-pdf-pages`)
        .evaluate((el) => getComputedStyle(el).rowGap),
    ).toBe("16px");
    // Zoomed, the column and the spine (8 + 16 px) are centred on the desk.
    await readerType(w.page, "50%");
    await expect
      .poll(async () =>
        Math.round((await box(`${shown} .reading-pdf-page`)).width),
      )
      .toBe(306);
    const desk = await w.page.locator(".reader-engine-body").evaluate((el) => ({
      left: el.getBoundingClientRect().left,
      width: el.clientWidth,
    }));
    const zoomed = await box(`${shown} .reading-pdf-page`);
    expect(
      Math.abs(
        zoomed.x -
          desk.left -
          Math.max(16, (desk.width - zoomed.width - 24) / 2),
      ),
    ).toBeLessThan(1.5);
    await readerType(w.page, "适合宽度");
    // Focus mode: F folds the top bar up and closes the side panel; the
    // sheet's header stays where it was, and nothing else moves the text.
    await readerView(w.page, "原文");
    await w.page
      .locator(`${shown}[data-view="doc"] .reading-article`)
      .waitFor();
    // The side panel open first, so focus mode has one to close.
    await readerPanel(w.page);
    await w.page.waitForTimeout(400);
    const before = await box(`${shown} .reader-page-header`);
    await w.page
      .locator(".reader-engine-body")
      .click({ position: { x: 5, y: 5 } });
    await w.page.keyboard.press("f");
    const bar = w.page.locator(".reader-topbar");
    await expect
      .poll(() => bar.evaluate((el) => getComputedStyle(el).visibility))
      .toBe("hidden");
    await expect
      .poll(() => w.page.locator(".reader-information").isVisible())
      .toBe(false);
    expect(
      Math.abs((await box(`${shown} .reader-page-header`)).y - before.y),
    ).toBeLessThan(1);
    // The pointer resting at the window's top brings the bar back over the desk.
    await w.page.mouse.move(700, 4);
    await expect
      .poll(() => bar.evaluate((el) => getComputedStyle(el).visibility))
      .toBe("visible");
    await w.page.mouse.move(700, 500);
    await expect
      .poll(() => bar.evaluate((el) => getComputedStyle(el).visibility), {
        timeout: 3000,
      })
      .toBe("hidden");
    // Esc leaves it: the top bar and the side panel as they were.
    await w.page.keyboard.press("Escape");
    await expect
      .poll(() => bar.evaluate((el) => getComputedStyle(el).visibility))
      .toBe("visible");
    await w.page.locator(".reader-information").waitFor();
    // “更多 → 专注模式” enters it too; F leaves it.
    await readerMore(w.page, "进入专注模式");
    await expect
      .poll(() => bar.evaluate((el) => getComputedStyle(el).visibility))
      .toBe("hidden");
    await w.page.keyboard.press("f");
    await expect
      .poll(() => bar.evaluate((el) => getComputedStyle(el).visibility))
      .toBe("visible");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("opens the side panel closed by default, docked from a 1440 px window and floating below it, with its four tabs (spec 1.4)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) =>
      env.setText(
        Array.from(
          { length: 120 },
          (_, i) =>
            `Paragraph ${i}: measured values with their conditions.\n\n`,
        ).join(""),
      ),
  });
  try {
    const id = w.env.parseRequest.literature_id;
    const sheet = () =>
      w.page.evaluate(() => {
        // The page header spans the sheet (spec 1.2).
        const el = document.querySelector<HTMLElement>(
          ".reader-view:not([hidden]) .reader-page-header",
        )!;
        const r = el.getBoundingClientRect();
        return { left: r.left, width: r.width };
      });
    const panel = w.page.getByRole("complementary", { name: "右侧面板" });
    // At a 1440 px window the desk is 1088 px, where the column is already
    // a little narrower (spec 1.1): the sheet's width is compared at 1600.
    for (const [width, docked] of [
      [1600, true],
      [1439, false],
    ] as const) {
      await w.page.setViewportSize({ width, height: 900 });
      await w.page.goto(`${w.origin}/?literature=${id}&reader=doc`);
      await w.page
        .locator('.react-reader[data-reading-ready="true"]')
        .waitFor();
      // Closed until asked for.
      expect(await panel.isVisible()).toBe(false);
      const before = await sheet();
      await readerPanel(w.page);
      // The slide in (spec 6.1) done.
      await panel.evaluate((el) =>
        Promise.all(
          el
            .closest(".react-reader")!
            .getAnimations({ subtree: true })
            .map((a) => a.finished),
        ),
      );
      const box = (await panel.boundingBox())!;
      expect(Math.round(box.width)).toBe(352);
      expect(Math.round(box.x + box.width)).toBe(width);
      expect(await w.page.evaluate(() => scrollX)).toBe(0);
      const after = await sheet();
      // Docked: the desk narrows, the sheet keeps its width and moves left
      // to stay centred; floating: nothing moves.
      expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
      if (docked) expect(after.left).toBeLessThan(before.left - 100);
      else expect(Math.abs(after.left - before.left)).toBeLessThanOrEqual(1);
      expect(
        await panel.evaluate((el) =>
          el.classList.contains("reader-information-floating"),
        ),
      ).toBe(!docked);
      // Four tabs: 信息, 批注, 关联, 翻译; the choice is kept for the paper.
      expect(
        await panel
          .getByRole("tab")
          .evaluateAll((tabs) => tabs.map((tab) => tab.textContent?.trim())),
      ).toEqual(["信息", "批注", "关联", "翻译"]);
      await panel.getByRole("tab", { name: "关联", exact: true }).click();
      const overview = panel.getByRole("region", { name: "库内概况" });
      await overview.waitFor();
      expect(await overview.getByRole("rowheader").allInnerTexts()).toEqual([
        "被引用",
        "引用",
      ]);
      await w.page
        .getByRole("button", { name: "收起信息", exact: true })
        .click();
      await w.page.reload();
      await w.page
        .locator('.react-reader[data-reading-ready="true"]')
        .waitFor();
      expect(await panel.isVisible()).toBe(false);
      await w.page
        .getByRole("button", { name: "显示信息", exact: true })
        .click();
      expect(
        await panel
          .getByRole("tab", { name: "关联", exact: true })
          .getAttribute("aria-selected"),
      ).toBe("true");
      await panel.getByRole("tab", { name: "信息", exact: true }).click();
      await w.page
        .getByRole("button", { name: "收起信息", exact: true })
        .click();
    }
    // Docked from exactly 1440 px.
    await w.page.setViewportSize({ width: 1440, height: 900 });
    await readerPanel(w.page);
    await expect
      .poll(() =>
        panel.evaluate((el) =>
          el.classList.contains("reader-information-floating"),
        ),
      )
      .toBe(false);
    // 信息: every item of the old information panel is still there (block 02).
    const info = await readerPanel(w.page, "信息");
    for (const heading of ["摘要", "标签", "材料"])
      await info.getByRole("heading", { name: heading, exact: true }).waitFor();
    // Citations are in “关联” only; other versions are part of 材料 (spec 1.4).
    expect(
      await info.getByRole("heading", { name: "关联", exact: true }).count(),
    ).toBe(0);
    expect(await info.innerText()).not.toContain("库内被引");
    expect(await info.locator(".reader-info-archive").innerText()).toContain(
      "其他版本",
    );
    for (const button of [
      "复制引用",
      "导出书目",
      "编辑元数据",
      "编辑标签",
      "技术详情",
    ])
      await info.getByRole("button", { name: button, exact: true }).waitFor();
    expect(await info.innerText()).toContain("原始 PDF 已保存");
    // 翻译: the section at the reading line can be translated.
    await readerPanel(w.page, "翻译");
    await panel
      .getByRole("button", { name: "翻译当前所在的节", exact: true })
      .waitFor();
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("draws the spine 8 px beside the sheet, keeps it there with the panel docked, opens its hint inside the window, and the outline beside it (spec 1.5, 1.6)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) =>
      env.setText(
        ["# Introduction", "# Methods", "# Results", "# Discussion"]
          .map(
            (heading, h) =>
              `${heading}\n\n` +
              Array.from(
                { length: 30 },
                (_, i) =>
                  `Paragraph ${h}.${i}: measured values with their conditions.\n\n`,
              ).join(""),
          )
          .join(""),
      ),
  });
  try {
    const id = w.env.parseRequest.literature_id;
    const spine = w.page.locator(".reader-spine");
    const gap = () =>
      w.page.evaluate(() => {
        const sheet = document
          .querySelector(".reader-view:not([hidden])[data-view='doc']")!
          .getBoundingClientRect();
        const s = document
          .querySelector(".reader-spine")!
          .getBoundingClientRect();
        return { gap: s.left - sheet.right, width: s.width };
      });
    await w.page.setViewportSize({ width: 1600, height: 900 });
    await w.page.goto(`${w.origin}/?literature=${id}&reader=doc`);
    await w.page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    await spine.waitFor();
    expect(await gap()).toEqual({ gap: 8, width: 16 });
    // One part per top-level heading of the outline; the window frames what shows.
    await w.page.keyboard.press("o");
    const tops = await w.page
      .locator('.reader-outline-row[data-depth="0"]')
      .count();
    await w.page.keyboard.press("o");
    expect(tops).toBeGreaterThanOrEqual(4);
    await expect
      .poll(() => w.page.locator(".reader-spine-part").count())
      .toBe(tops);
    await w.page.locator(".reader-spine-window").waitFor();
    // Docked side panel: the spine stays beside the sheet.
    await readerPanel(w.page);
    await w.page.waitForTimeout(400);
    expect((await gap()).gap).toBe(8);
    await w.page.getByRole("button", { name: "收起信息", exact: true }).click();
    // A part pressed goes to its section, and the way back appears.
    await w.page.locator(".reader-spine-part").nth(2).click();
    await w.page
      .locator(".reader-view:not([hidden]) .reader-page-header-back")
      .waitFor();
    // Narrow window: the hint opens to the left of the spine, fully visible.
    await w.page.setViewportSize({ width: 700, height: 900 });
    await w.page.waitForTimeout(300);
    await w.page.locator(".reader-spine-part").nth(1).hover();
    const tip = w.page.locator(".reader-spine-tip");
    await tip.waitFor();
    expect(await tip.getAttribute("data-side")).toBe("left");
    const box = (await tip.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(700);
    expect(await tip.innerText()).toBe("Methods");
    // The outline opens beside the spine; choosing an entry closes it; Esc too.
    await w.page.setViewportSize({ width: 1600, height: 900 });
    await w.page.mouse.move(10, 400);
    await w.page.keyboard.press("o");
    const outline = w.page.locator(".reader-outline");
    await outline.waitFor();
    const place = (await outline.boundingBox())!,
      spineBox = (await spine.boundingBox())!;
    expect(Math.round(place.width)).toBe(300);
    // Beside it, 8 px away, on whichever side has the room (as the hint).
    expect([
      Math.round(place.x - (spineBox.x + spineBox.width)),
      Math.round(spineBox.x - (place.x + place.width)),
    ]).toContain(8);
    await outline
      .locator(".reader-outline-entry", { hasText: "Results" })
      .click();
    await outline.waitFor({ state: "detached" });
    await w.page.keyboard.press("o");
    await outline.waitFor();
    await w.page.keyboard.press("Escape");
    await outline.waitFor({ state: "detached" });
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);
