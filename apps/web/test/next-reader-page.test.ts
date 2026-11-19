import { parseLiterature } from "@sciretriever/contracts";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";
import { openType, readerPanel, readerToLibrary } from "./reader-controls.js";
import { missingId } from "./processor-workspace-fixture.js";
import { nextWorkspace, libraryStatus } from "./next-workspace-fixture.js";
import { syntheticReadingPdf } from "./reading-pdf-fixture.js";

/**
 * Plan 25 block 30 (reading-experience 9.0): the bibliography page, the PDF
 * of a paper without full text, the top bar and “更多”, the “排版” panel, the
 * selection bar and translation, the spine, the draft's marks, the title
 * printed once, the narrow page header, the empty relations; and the
 * sidebar's “正在读”.
 */
const BIBLIOGRAPHY = "00000000-0000-0000-0000-000000005201";
const DOI = "10.5555/block30.bibliography";
async function putBibliography(env: {
  app: { database: { putLiterature(value: unknown): Promise<unknown> } };
}) {
  await env.app.database.putLiterature(
    parseLiterature({
      ...FIXTURE_LITERATURE,
      literature_id: BIBLIOGRAPHY,
      meta_literature_id: "00000000-0000-0000-0000-000000005202",
      metadata: {
        ...FIXTURE_LITERATURE.metadata,
        title: "Catholyte interfaces for lithium metal: a synthetic example",
        authors: ["Reyes", "Imai"].map((family) => ({
          kind: "person",
          display_name: `${family} A.`,
          given_name: "A.",
          family_name: family,
          orcid: null,
          affiliations: [],
        })),
        abstract: "A synthetic abstract on interfaces that evolve in cycling.",
        publication_year: 2024,
        venue: "Advanced Materials",
        volume: "36",
        issue: "12",
        keywords: ["interface", "sulfide electrolyte"],
        identifiers: [{ namespace: "doi", value: DOI }],
      },
    }),
  );
}
/** Selects words of the shown full text as a person does, and lets the reader hear it. */
async function selectWords(page: Page) {
  await page.evaluate(() => {
    const block = [
      ...document.querySelectorAll<HTMLElement>(
        ".reader-view:not([hidden]) article > section[data-byte-start]",
      ),
    ].find((b) => /measured energy/u.test(b.textContent ?? ""))!;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode() as Text | null;
    while (text && !text.data.includes("measured"))
      text = walker.nextNode() as Text | null;
    const at = text!.data.indexOf("measured");
    const range = document.createRange();
    range.setStart(text!, at);
    range.setEnd(text!, at + 15);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    block.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    block.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  const bar = page.getByRole("toolbar", { name: "选中文字" });
  await bar.waitFor();
  return bar;
}

it("sets a paper without a PDF as its bibliography page with the ways to its full text (block 30.1, 30.7)", async () => {
  const w = await nextWorkspace({ ready: "body", setup: putBibliography });
  try {
    const page = w.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${w.origin}/?literature=${BIBLIOGRAPHY}`);
    const sheet = page.locator(".reader-bibliography-sheet");
    await sheet.waitFor();
    // The page header: kind and year on the left, what this is on the right.
    expect(await sheet.locator(".reader-page-header-source").innerText()).toBe(
      "期刊论文 · 2024",
    );
    expect(await sheet.locator(".reader-page-header-view").innerText()).toBe(
      "书目",
    );
    // Title, authors, journal with volume and issue and the DOI, the abstract
    // between two rules, the keywords.
    expect(await sheet.getByRole("heading", { level: 1 }).innerText()).toBe(
      "Catholyte interfaces for lithium metal: a synthetic example",
    );
    expect(await sheet.locator(".bibliography-authors").innerText()).toContain(
      "Reyes",
    );
    const source = sheet.locator(".bibliography-source");
    expect(await source.innerText()).toContain("Advanced Materials");
    expect(await source.innerText()).toContain("36 卷 12 期");
    expect(
      await source
        .getByRole("link", { name: `doi:${DOI}` })
        .getAttribute("href"),
    ).toBe(`https://doi.org/${DOI}`);
    const abstract = sheet.getByRole("region", { name: "摘要" });
    expect(await abstract.innerText()).toContain("interfaces that evolve");
    expect(
      await abstract.evaluate((el) => {
        const style = getComputedStyle(el);
        return [style.borderTopWidth, style.borderBottomWidth];
      }),
    ).toEqual(["1px", "1px"]);
    expect(await sheet.locator(".bibliography-terms").innerText()).toContain(
      "interface · sulfide electrolyte",
    );
    // The line under it: no full text yet; 获取 PDF the primary, 上传 PDF, the publisher.
    const line = sheet.getByRole("group", { name: "全文" });
    expect(await line.locator("p").innerText()).toBe("这篇还没有全文。");
    expect(
      await line.locator('.ui-button[data-variant="primary"]').allInnerTexts(),
    ).toEqual(["获取 PDF"]);
    await line.getByRole("button", { name: "上传 PDF", exact: true }).waitFor();
    expect(
      await line
        .getByRole("link", { name: "去出版社页面" })
        .getAttribute("href"),
    ).toBe(`https://doi.org/${DOI}`);
    // No views to switch and no spine; the side panel stays closed.
    expect(await page.getByRole("tablist", { name: "阅读视图" }).count()).toBe(
      0,
    );
    expect(await page.locator(".reader-spine").count()).toBe(0);
    expect(await page.locator(".reader-information").isVisible()).toBe(false);
    // “获取 PDF” opens its dialog; “更多” offers it too while there is no PDF.
    await line.getByRole("button", { name: "获取 PDF", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "获取 PDF", exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    // 关联 without any citation data says so in one sentence (30.7).
    const panel = await readerPanel(page, "关联");
    await expect
      .poll(() => panel.locator(".reader-relations-empty").innerText())
      .toBe("还没有这篇的引用数据。");
    expect(await panel.locator("table").count()).toBe(0);
    // “没找到 PDF”: the automatic routes were tried; uploading is what is left.
    await page.route(
      (url) => url.pathname === "/api/v1/query/read",
      async (route) => {
        const response = await route.fetch();
        const value = await response.json();
        if (value.detail?.literature?.literature_id === BIBLIOGRAPHY)
          value.detail.needs_manual_pdf = true;
        await route.fulfill({ response, json: value });
      },
    );
    await page.reload();
    await expect
      .poll(() => page.locator(".reader-bibliography-fulltext p").innerText())
      .toBe("自动找过，没找到 PDF。可以自己上传。");
    const exhausted = page.locator(".reader-bibliography-fulltext");
    expect(
      await exhausted
        .locator('.ui-button[data-variant="primary"]')
        .allInnerTexts(),
    ).toEqual(["上传 PDF"]);
    expect(
      await exhausted.getByRole("button", { name: "获取 PDF" }).count(),
    ).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("opens the PDF of a paper without full text, saying so under the page header (block 30.2)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => {
      await env.app.maintenance!.ingestPdf({
        literature_id: missingId,
        bytes: syntheticReadingPdf(3),
      });
    },
  });
  try {
    await w.page.goto(`${w.origin}/?literature=${missingId}`);
    await expect
      .poll(() => new URL(w.page.url()).searchParams.get("reader"))
      .toBe("pdf");
    const line = w.page.locator(
      ".reader-view:not([hidden]) .reader-page-header-line",
    );
    await expect
      .poll(() => line.locator(".reader-page-header-line-text").innerText())
      .toBe("还没有全文");
    expect(await line.evaluate((el) => getComputedStyle(el).color)).toBe(
      await w.page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--fg2)";
        document.body.append(probe);
        const colour = getComputedStyle(probe).color;
        probe.remove();
        return colour;
      }),
    );
    await line.getByRole("button", { name: "生成全文", exact: true }).click();
    await w.page.getByRole("dialog").waitFor();
    await w.page.keyboard.press("Escape");
    // Even where the full text was last left, the PDF opens.
    await w.page.getByRole("tab", { name: "原文", exact: true }).click();
    await w.page.locator(".reader-surface .ui-empty").waitFor();
    await w.page.goto(`${w.origin}/?literature=${missingId}`);
    await expect
      .poll(() => new URL(w.page.url()).searchParams.get("reader"))
      .toBe("pdf");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("puts the summary and the results in the views as a cell, on the sheet, with 原文 a press away (block 30.3)", async () => {
  const w = await nextWorkspace({ ready: "body" });
  try {
    const page = w.page,
      id = w.env.parseRequest.literature_id;
    const views = page.getByRole("tablist", { name: "阅读视图" });
    for (const [mode, label] of [
      ["know", "总结"],
      ["results", "结果"],
    ] as const) {
      await page.goto(`${w.origin}/?literature=${id}&reader=${mode}`);
      await views.waitFor();
      await expect
        .poll(() => views.getByRole("tab").allInnerTexts())
        .toEqual(["原文", "PDF", label]);
      expect(
        await views
          .getByRole("tab", { name: label, exact: true })
          .getAttribute("aria-selected"),
      ).toBe("true");
      // On the desk's sheet, as the full text is.
      const sheet = page.locator(".reader-plain-sheet");
      await sheet.waitFor();
      expect(
        await sheet.evaluate((el) => getComputedStyle(el).boxShadow),
      ).not.toBe("none");
      await views.getByRole("tab", { name: "原文", exact: true }).click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get("reader"))
        .toBe("doc");
      await expect
        .poll(() => views.getByRole("tab").allInnerTexts())
        .toEqual(["原文", "PDF"]);
    }
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("sets the size, line length and spacing in “排版”, keeps them in this browser and shares the theme with the settings (block 30.4)", async () => {
  const w = await nextWorkspace({ ready: "body" });
  try {
    const page = w.page,
      id = w.env.parseRequest.literature_id;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${w.origin}/?literature=${id}&reader=doc`);
    await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    const article = page.locator(".reader-view:not([hidden]) .reading-article");
    const measure = () =>
      article.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          width: Math.round(el.getBoundingClientRect().width),
          font: parseFloat(style.fontSize),
          line: Math.round(parseFloat(style.lineHeight) * 10) / 10,
        };
      });
    const set = {
      width: 40 * 21,
      font: 21,
      line: Math.round(21 * 1.85 * 1.12 * 10) / 10,
    };
    expect(await measure()).toEqual({ width: 680, font: 20, line: 37 });
    let panel = await openType(page);
    await panel.getByRole("button", { name: "放大", exact: true }).click();
    await expect
      .poll(() => panel.locator(".reader-type-scale-value").innerText())
      .toBe("105%");
    await panel.getByRole("tab", { name: "宽", exact: true }).click();
    await panel.getByRole("tab", { name: "松", exact: true }).click();
    await expect.poll(measure).toEqual(set);
    // A theme swatch puts it on at once; it is the settings' own choice.
    await panel.locator('[title="宣纸"]').click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("xuan");
    await page.keyboard.press("Escape");
    // Kept in this browser: a reload opens with them.
    await page.reload();
    await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    await expect.poll(measure).toEqual(set);
    panel = await openType(page);
    for (const name of ["宽", "松"])
      expect(
        await panel
          .getByRole("tab", { name, exact: true })
          .getAttribute("aria-selected"),
      ).toBe("true");
    expect(await panel.getByRole("radio", { name: "宣纸" }).isChecked()).toBe(
      true,
    );
    await page.keyboard.press("Escape");
    await page.goto(`${w.origin}/?view=set&setting=appearance`);
    await expect
      .poll(() =>
        page
          .getByRole("radiogroup", { name: "主题" })
          .getByRole("radio", { name: "宣纸" })
          .isChecked(),
      )
      .toBe(true);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("keeps the page live while “排版” is open: it scrolls, and a press outside, Esc or its button closes it, doing nothing else, the focus back on its button", async () => {
  const w = await nextWorkspace({ ready: "body" });
  try {
    const page = w.page,
      id = w.env.parseRequest.literature_id;
    await page.setViewportSize({ width: 1440, height: 600 });
    const typeButton = page
      .locator(".reader-topbar-tools")
      .getByRole("button", { name: "排版", exact: true });
    const focusedOnButton = () =>
      typeButton.evaluate((button) => document.activeElement === button);
    const panel = page.getByRole("dialog", { name: "排版", exact: true });
    // Non-modal: the PDF scrolls under the open panel, which stays open.
    await page.goto(`${w.origin}/?literature=${id}&reader=pdf`);
    await page
      .locator(
        '.reader-view:not([hidden]) .reading-pdf-page[data-rendered="true"]',
      )
      .first()
      .waitFor();
    const body = page.locator(".reader-engine-body:not([hidden])");
    await openType(page);
    const box = (await body.boundingBox())!;
    await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
    await page.mouse.wheel(0, 400);
    await expect
      .poll(() => body.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    expect(await panel.isVisible()).toBe(true);
    // A press on the paper closes it and does nothing else.
    await page.mouse.click(box.x + box.width / 3, box.y + box.height / 2);
    await panel.waitFor({ state: "detached" });
    await expect.poll(focusedOnButton).toBe(true);
    // In the full text, a drag across the words that closes it selects nothing.
    await page.goto(`${w.origin}/?literature=${id}&reader=doc`);
    await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    const paragraph = page
      .locator(
        ".reader-view:not([hidden]) .reading-article section[data-byte-start] p",
      )
      .first();
    await openType(page);
    const words = (await paragraph.boundingBox())!;
    await page.mouse.move(words.x + 2, words.y + words.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      words.x + words.width - 2,
      words.y + words.height / 2,
      {
        steps: 5,
      },
    );
    await page.mouse.up();
    await panel.waitFor({ state: "detached" });
    expect(await page.evaluate(() => String(getSelection()))).toBe("");
    await expect.poll(focusedOnButton).toBe(true);
    // The next press reaches the page as usual: the same drag selects.
    await page.mouse.move(words.x + 2, words.y + words.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      words.x + words.width - 2,
      words.y + words.height / 2,
      {
        steps: 5,
      },
    );
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => String(getSelection()).length))
      .toBeGreaterThan(0);
    await page.evaluate(() => getSelection()?.removeAllRanges());
    // Esc closes this layer; its button, pressed again, closes it too.
    await openType(page);
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    await expect.poll(focusedOnButton).toBe(true);
    await typeButton.click();
    await panel.waitFor();
    // Tab moves within the panel, from one control to the next.
    await page.keyboard.press("Tab");
    expect(
      await panel.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
    await typeButton.click();
    await panel.waitFor({ state: "detached" });
    expect(await focusedOnButton()).toBe(true);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("shows translation only when asked, and not at all where it is not set up (block 30.5)", async () => {
  for (const translation of [true, false]) {
    const w = await nextWorkspace({ ready: "body", translation });
    try {
      const page = w.page,
        id = w.env.parseRequest.literature_id;
      const translated: string[] = [];
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname === "/api/translation"
        )
          translated.push(request.url());
      });
      // Whether translation is set up is read once, from its model list.
      const catalog = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/translation" &&
          response.request().method() === "GET",
      );
      await page.goto(`${w.origin}/?literature=${id}&reader=doc`);
      await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
      expect((await catalog).status()).toBe(translation ? 200 : 503);
      const bar = await selectWords(page);
      // A floating layer on the paper's ground, not a dark strip; five pens.
      expect(
        await bar.evaluate((el) => getComputedStyle(el).backgroundColor),
      ).toBe(
        await page.evaluate(() => {
          const probe = document.createElement("span");
          probe.style.backgroundColor = "var(--surface-raised)";
          document.body.append(probe);
          const colour = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return colour;
        }),
      );
      expect(await bar.locator(".mark-swatch").count()).toBe(5);
      // Selecting translates nothing and opens no card.
      await page.waitForTimeout(600);
      expect(await page.getByLabel("划词翻译").count()).toBe(0);
      expect(await page.getByText("当前服务没有开启翻译").count()).toBe(0);
      expect(translated).toEqual([]);
      const button = bar.getByRole("button", { name: "翻译选中文字" });
      if (translation) {
        await button.click();
        await page.getByLabel("划词翻译").waitFor();
        await expect.poll(() => translated.length).toBe(1);
      } else {
        expect(await button.count()).toBe(0);
        // Nor in the context menu or the side panel.
        await page.keyboard.press("Escape");
        const paragraph = page
          .locator(".reader-view:not([hidden]) section[data-byte-start]:has(p)")
          .first();
        await paragraph.click({ button: "right", position: { x: 40, y: 8 } });
        const menu = page.locator(".ui-context-menu");
        await menu.waitFor();
        await menu.getByRole("menuitem").first().waitFor();
        expect(await menu.getByText("翻译本段").count()).toBe(0);
        await page.keyboard.press("Escape");
        const panel = await readerPanel(page);
        expect(await panel.getByRole("tab").allInnerTexts()).not.toContain(
          "翻译",
        );
      }
      expect(w.errors).toEqual([]);
    } finally {
      await w.close();
    }
  }
}, 150000);

it("draws a 4 px spine without a frame, prints a repeated title once and keeps a narrow sheet's header to its right side (block 30.6)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) =>
      env.setText(
        [
          "# Synthetic literature workbench",
          "Opening words of the paper.",
          "# Methods",
          ...Array.from(
            { length: 160 },
            (_, i) => `Paragraph ${i}: measured values with their conditions.`,
          ),
        ].join("\n\n"),
      ),
  });
  try {
    const page = w.page,
      id = w.env.parseRequest.literature_id;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${w.origin}/?literature=${id}&reader=doc`);
    await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    const spine = page.locator(".reader-spine");
    await spine.waitFor();
    const look = await page.evaluate(() => {
      const strip = document.querySelector<HTMLElement>(".reader-spine")!;
      const sheet = document
        .querySelector(".reader-view:not([hidden])[data-view='doc']")!
        .getBoundingClientRect();
      const window_ = document.querySelector<HTMLElement>(
        ".reader-spine-window",
      )!;
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--fg)";
      document.body.append(probe);
      const ink = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        width: strip.getBoundingClientRect().width,
        gap: strip.getBoundingClientRect().left - sheet.right,
        shadow: getComputedStyle(strip).boxShadow,
        frame: getComputedStyle(window_).borderTopWidth,
        ink: getComputedStyle(window_).backgroundColor === ink,
      };
    });
    expect(look).toEqual({
      width: 4,
      gap: 8,
      shadow: "none",
      frame: "0px",
      ink: true,
    });
    // Hovering a part names its section.
    await page.locator(".reader-spine-part").first().hover();
    await expect
      .poll(() => page.locator(".reader-spine-tip").innerText())
      .toBe("Synthetic literature workbench");
    // The text's first heading is the paper's title: printed once.
    const titles = await page
      .locator(".reader-view:not([hidden]) .reading-article")
      .evaluate((article) =>
        [...article.querySelectorAll<HTMLElement>("h1, h2, h3")]
          .filter((h) => h.offsetHeight > 0)
          .map((h) => h.textContent?.trim()),
      );
    expect(
      titles.filter((t) => t === "Synthetic literature workbench"),
    ).toHaveLength(1);
    expect(
      await page
        .locator(".reader-view:not([hidden]) .reading-document-title:visible")
        .count(),
    ).toBe(1);
    // A sheet narrower than 420 px keeps only the view on its page header.
    await page.setViewportSize({ width: 400, height: 800 });
    await expect
      .poll(() =>
        page
          .locator(".reader-view:not([hidden]) .reader-page-header-source")
          .isVisible(),
      )
      .toBe(false);
    expect(
      await page
        .locator(".reader-view:not([hidden]) .reader-page-header-view")
        .isVisible(),
    ).toBe(true);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("lists the open papers under 文献库 as “正在读”, five at most, and goes back to one (block 30 · 2a)", async () => {
  const w = await nextWorkspace({ ready: "body" });
  try {
    const page = w.page,
      id = w.env.parseRequest.literature_id;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${w.origin}/?view=lib`);
    const reading = page.getByRole("group", { name: "正在读" });
    await page.getByRole("group", { name: "文献文件夹" }).waitFor();
    // Nothing open: no group.
    expect(await reading.count()).toBe(0);
    await page.goto(`${w.origin}/?literature=${id}&reader=doc`);
    await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    await readerToLibrary(page);
    await reading.waitFor();
    const paper = reading.getByRole("button", {
      name: "Synthetic literature workbench",
    });
    await paper.click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("literature"))
      .toBe(id);
    // Past five, “另外 n 篇”.
    await page.evaluate((current) => {
      const tabs = [
        { id: current, title: "Synthetic literature workbench", source: {} },
        ...Array.from({ length: 6 }, (_, n) => ({
          id: `00000000-0000-0000-0000-00000000600${n}`,
          title: `Open paper ${n} with a title long enough to be cut on one line`,
          source: {},
        })),
      ];
      sessionStorage.setItem(
        "sciretriever:reader:tabs:v1",
        JSON.stringify(tabs),
      );
    }, id);
    await page.goto(`${w.origin}/?view=lib`);
    await reading.waitFor();
    expect(await reading.locator(".reading-now-paper").count()).toBe(5);
    const more = reading.getByRole("button", {
      name: "另外 2 篇",
      exact: true,
    });
    await more.waitFor();
    expect(
      await reading
        .locator(".reading-now-paper .folder-name")
        .first()
        .evaluate((el) => getComputedStyle(el).whiteSpace),
    ).toBe("nowrap");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("shows a selected quick filter once: no condition chip and not counted in 筛选 (block 30 · 2b)", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    await page
      .locator(".library-status-filters")
      .getByRole("button")
      .first()
      .waitFor();
    const names = await page
      .locator(".library-status-filters")
      .getByRole("button")
      .allInnerTexts();
    const quick = names
      .map((name) => name.replace(/\s*[\d,]+$/u, ""))
      .find((name) => name !== "全部" && name !== "更多状态")!;
    await libraryStatus(page, quick);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("query") ?? "")
      .not.toBe("");
    expect(await page.locator(".library-applied").count()).toBe(0);
    expect(await page.locator(".library-filter-toggle").textContent()).toBe(
      "筛选",
    );
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
