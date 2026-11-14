import { expect, it } from "vitest";
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
    await w.page.getByRole("button", { name: "显示目录", exact: true }).click();
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
      "长文档（294 页）：按简化流程建档，未逐页校订，文字可能含解析错误；以 PDF 为准。",
    );
    expect(await w.page.getByText("长文档（294 页）· 未逐页校订").count()).toBe(
      1,
    );
    await w.page.goto(`${w.origin}/?view=lib`);
    await w.page
      .locator(".paper-status small", { hasText: "长文档" })
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
        const line = el.getBoundingClientRect().top + el.clientHeight * 0.28;
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
    const font = async (size: number) => {
      await w.page.getByRole("button", { name: /阅读字号/ }).click();
      await w.page
        .getByRole("option", { name: `${size} px`, exact: true })
        .click();
    };
    const first = await anchor();
    await measure("font 20 → 24", () => font(24));
    await measure("font 24 → 20", () => font(20));
    moves["font round trip"] = Math.abs(
      (await anchor(first.key)).top - first.top,
    );
    await measure("panel closed", () =>
      w.page.getByRole("button", { name: "收起信息", exact: true }).click(),
    );
    await measure("panel open", () =>
      w.page.getByRole("button", { name: "显示信息", exact: true }).click(),
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
        const line = el.getBoundingClientRect().top + el.clientHeight * 0.28;
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
    await w.page.getByRole("button", { name: "显示目录", exact: true }).click();
    await w.page
      .locator(".reader-outline-entry", { hasText: "Conclusion" })
      .click();
    const back = w.page.locator(".reader-return-jump");
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
    // place (the outline is not remembered, so it is closed first).
    await w.page.getByRole("button", { name: "收起目录", exact: true }).click();
    await body.evaluate((el) => {
      el.scrollTop += 640;
    });
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
    await w.page.getByRole("tab", { name: "批注 1" }).waitFor();
    // Read far on, then go to the mark from the list.
    await body.evaluate((el) => {
      el.scrollTop = 6000;
    });
    await w.page.waitForTimeout(400);
    await w.page.getByRole("tab", { name: "批注 1" }).click();
    await w.page
      .getByRole("button", { name: /^转到批注：Paragraph 3/u })
      .click();
    const back = w.page.locator(".reader-return-jump");
    await expect.poll(() => back.textContent()).toMatch(/^↩ 回到 ¶\d+$/u);
    await back.click();
    await expect
      .poll(() => body.evaluate((el) => Math.abs(el.scrollTop - 6000)))
      .toBeLessThanOrEqual(2);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);
