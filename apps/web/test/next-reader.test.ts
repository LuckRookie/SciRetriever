import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { writeDesignAudit } from "./design-audit-fixture.js";
import {
  syntheticReadingPdf,
  readingResourceCounts,
  trackReadingResources,
} from "./reading-pdf-fixture.js";
import { recordReading } from "./reading-capture-fixture.js";
import {
  readerGoToPage,
  readerPageNumber,
  readerToLibrary,
  readerType,
  readerPanel,
} from "./reader-controls.js";
import { missingId } from "./processor-workspace-fixture.js";
import { doubtfulDraft, draftPdf, formDraft } from "./draft-fixture.js";
import { expect, it } from "vitest";

import {
  nextWorkspace,
  showAllLibraryStatuses,
} from "./next-workspace-fixture.js";

async function captureReader(page: Page, name: string) {
  const output = process.env.SCIRETRIEVER_WEB_REVIEW_OUTPUT;
  if (!output) return;
  await mkdir(output, { recursive: true });
  await page.locator(".reader-information").evaluateAll((elements) =>
    elements.forEach((el) => {
      el.scrollTop = 0;
    }),
  );
  const original = page.viewportSize()!;
  for (const width of [1440, 1280, 1024, 390])
    for (const theme of ["light", "dark", "green", "warm"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await page.screenshot({
        path: join(output, `${name}-${width}-${theme}.png`),
        animations: "disabled",
      });
      await writeDesignAudit(page, output, `${name}-${width}-${theme}`);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  await page.setViewportSize(original);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
}

it.each(["no-preference", "reduce"] as const)(
  "reads PDF and full text with a visible mode switch and preserves the processing confirmation (%s)",
  async (reducedMotion) => {
    const w = await nextWorkspace({ ready: "body" });
    try {
      await w.page.emulateMedia({ reducedMotion });
      const counts = {
        parser: w.env.parseCalls,
        model: w.env.modelCalls,
        jobs: (await w.env.app.jobs!.listJobs(20)).length,
      };
      await w.page.goto(
        `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=pdf`,
      );
      await w.page
        .locator('.reading-pdf-page[data-rendered="true"]')
        .first()
        .waitFor()
        .catch(async (error: unknown) => {
          throw new Error(
            `${String(error)}\n${await w.page.locator("body").innerText()}\n${w.errors.join("\n")}`,
          );
        });
      expect(await readerPageNumber(w.page)).toBe(1);
      // The side panel starts closed (spec 1.4).
      expect(
        await w.page
          .getByRole("button", { name: "显示信息", exact: true })
          .isVisible(),
      ).toBe(true);
      await w.page.getByRole("tab", { name: "原文", exact: true }).click();
      await w.page.locator(".reader-engine-body .reading-article").waitFor();
      await expect
        .poll(() =>
          w.page.locator(".reader-engine-body .reading-article").textContent(),
        )
        .toContain("4.2 eV");
      expect(
        await w.page
          .locator(
            ".reader-engine:not([hidden]) .reader-view:not([hidden]) .reader-page-header",
          )
          .textContent(),
      ).not.toContain("字节");
      expect(
        await w.page
          .locator(".reader-engine-body .reading-article")
          .evaluate((el) => getComputedStyle(el).fontSize),
      ).toBe("20px");
      await w.page
        .getByRole("button", { name: "显示信息", exact: true })
        .click();
      // Parsing is the first archive step; the reader offers no separate action.
      await w.page.getByRole("button", { name: "更多", exact: true }).click();
      await w.page.getByRole("menu").waitFor();
      expect(
        await w.page
          .getByRole("menuitem", { name: "解析 PDF", exact: true })
          .count(),
      ).toBe(0);
      await w.page.keyboard.press("Escape");
      expect(w.env.parseCalls).toBe(counts.parser);
      expect(w.env.modelCalls).toBe(counts.model);
      expect((await w.env.app.jobs!.listJobs(20)).length).toBe(counts.jobs);
      if (reducedMotion === "no-preference")
        await captureReader(w.page, "react-document");
      expect(await w.page.locator("style").count()).toBe(0);
      expect(w.errors).toEqual([]);
    } finally {
      await w.close();
    }
  },
  90000,
);

it("switches between PDF and full text on one engine: one build, one PDF read and one check", async () => {
  const w = await nextWorkspace({ ready: "body", readerProbe: true });
  try {
    const id = w.env.parseRequest.literature_id;
    const pdf = w.page.locator(
      '.reader-view[data-view="pdf"]:not([hidden]) .reading-pdf-page[data-rendered="true"]',
    );
    const text = w.page.locator(
      '.reader-view[data-view="doc"]:not([hidden]) .reading-article section[data-byte-start]',
    );
    await w.page.goto(`${w.origin}/?literature=${id}&reader=pdf`);
    await pdf.first().waitFor();
    for (let n = 0; n < 3; n++) {
      await w.page.getByRole("tab", { name: "原文", exact: true }).click();
      await text.first().waitFor();
      await w.page.getByRole("tab", { name: "PDF", exact: true }).click();
      await pdf.first().waitFor();
    }
    const counts = await w.page.evaluate(
      () =>
        (
          window as unknown as {
            __sciretrieverReaderProbe?: {
              engines: Record<string, number>;
              pdfRequests: Record<string, number>;
              pdfHashes: Record<string, number>;
              workersStarted: number;
              workersTerminated: number;
            };
          }
        ).__sciretrieverReaderProbe,
    );
    expect(counts, "the reader test build exposes its counters").toBeTruthy();
    expect(Object.values(counts!.engines)).toEqual([1]);
    expect(Object.values(counts!.pdfRequests)).toEqual([1]);
    expect(Object.values(counts!.pdfHashes)).toEqual([1]);
    expect(counts!.workersStarted - counts!.workersTerminated).toBe(1);
    expect(counts!.workersStarted).toBe(1);
    // The hidden PDF view keeps at most the three canvases it showed (spec 5.3),
    // so coming back draws at once.
    await w.page.getByRole("tab", { name: "原文", exact: true }).click();
    await text.first().waitFor();
    const kept = await w.page.locator(".reading-pdf-page canvas").count();
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThanOrEqual(3);
    await w.page.getByRole("tab", { name: "PDF", exact: true }).click();
    expect(
      await w.page
        .locator('.reader-view[data-view="pdf"]:not([hidden]) canvas')
        .count(),
    ).toBeGreaterThan(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("groups existing statements, hides technical IDs, verifies nearby evidence and returns to the saved summary", async () => {
  const w = await nextWorkspace({ ready: "body" });
  try {
    const env = w.env,
      id = env.parseRequest.literature_id;
    const material = await env.app.documentRead.materialEvidence({
      literature_id: id,
      asset_id: env.asset.asset_id,
    });
    if (material.evidence.target_kind !== "material")
      throw new Error("invalid fixture");
    const document = (
      await env.app.documentRead.describe({
        document_version_id: w.parsed.document.document_version_id,
      })
    ).document;
    env.setModel((input) => ({
      outcome: "completed",
      title: "Synthetic evidence summary",
      statements: [
        {
          statement_id: "finding-1",
          category: "finding",
          epistemic: "reported",
          text: "The measured energy was 4.2 eV.",
          conditions: ["Ambient conditions"],
          quantity: { value: "4.2", unit: "eV", comparison_basis: null },
          evidence_segment_ids: [
            input.segments!.find((s) => s.text.includes("4.2"))!.segment_id,
          ],
        },
        {
          statement_id: "limitation-1",
          category: "limitation",
          epistemic: "inference",
          text: "The supplied material does not establish wider applicability.",
          conditions: [],
          quantity: null,
          evidence_segment_ids: [
            input.segments!.find((s) => s.text.includes("discussion"))!
              .segment_id,
          ],
        },
      ],
    }));
    const job = await env.app.processors!.submit({
      schema_version: 1,
      idempotency_key: "reader-summary",
      name: "Reader summary",
      processor: { id: "summary", version: "2" },
      spec: { purpose: "overview", question: null },
      inputs: [{ kind: "literature", literature_id: id }],
    });
    await env.app.processingTasks!.run(job.job_id);
    const state = await env.app.processingTasks!.read(job.job_id);
    expect(state.failures).toEqual([]);
    const result = (await env.app.processorRead!.byId(
      (state.results[0] as { result: { result_id: string } }).result.result_id,
    ))!;
    const counts = { parser: env.parseCalls, model: env.modelCalls };
    await w.page.goto(
      `${w.origin}/?literature=${id}&reader=know&result=${result.ref.result_id}&resultHash=${result.ref.content_sha256}`,
    );
    await expect
      .poll(() => w.page.locator(".reader-summary").textContent())
      .toContain("4.2 eV");
    expect(await w.page.locator(".reader-statement").count()).toBe(2);
    expect(
      await w.page.locator(".reader-statement").last().textContent(),
    ).toContain("wider applicability");
    const summary = w.page.locator(".reader-summary");
    expect(await summary.innerText()).not.toContain(result.ref.result_id);
    expect(await summary.innerText()).not.toContain(result.ref.content_sha256);
    await w.page.getByRole("button", { name: "[1.1]", exact: true }).click();
    await w.page
      .getByRole("dialog", { name: "证据 1.1", exact: true })
      .waitFor();
    await expect
      .poll(() =>
        w.page.locator(".reader-evidence-preview blockquote").textContent(),
      )
      .toContain("4.2 eV");
    await w.page
      .getByRole("button", { name: "在原文中核对", exact: true })
      .click();
    await w.page.locator(".reading-evidence").first().waitFor();
    expect(new URL(w.page.url()).searchParams.get("document")).toBe(
      document.document_version_id,
    );
    await w.page.getByRole("button", { name: "返回总结", exact: true }).click();
    await expect
      .poll(() => w.page.locator(".reader-summary").textContent())
      .toContain("4.2 eV");
    await captureReader(w.page, "react-summary");
    await summary
      .getByRole("button", { name: "技术详情", exact: true })
      .click();
    expect(await summary.innerText()).toContain(result.ref.result_id);
    expect(env.parseCalls).toBe(counts.parser);
    expect(env.modelCalls).toBe(counts.model);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("opens a paper in the view this browser remembers before the view its material suggests (spec 6.4)", async () => {
  const w = await nextWorkspace({ ready: "body" });
  try {
    const id = w.env.parseRequest.literature_id;
    const view = () => new URL(w.page.url()).searchParams.get("reader");
    // Nothing remembered: the paper has text, so its full text.
    await w.page.goto(`${w.origin}/?literature=${id}`);
    await w.page
      .locator(
        '.reader-view[data-view="doc"]:not([hidden]) section[data-byte-start]',
      )
      .first()
      .waitFor();
    expect(view()).toBe("doc");
    await w.page.getByRole("tab", { name: "PDF", exact: true }).click();
    await w.page
      .locator(
        '.reader-view[data-view="pdf"]:not([hidden]) .reading-pdf-page[data-rendered="true"]',
      )
      .first()
      .waitFor();
    // Opened again without a view: the remembered PDF view.
    await w.page.goto(`${w.origin}/?literature=${id}`);
    await w.page
      .locator(
        '.reader-view[data-view="pdf"]:not([hidden]) .reading-pdf-page[data-rendered="true"]',
      )
      .first()
      .waitFor();
    expect(view()).toBe("pdf");
    expect(
      await w.page.locator('.reader-view[data-view="doc"]').count(),
      "the full text was not built on the way",
    ).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("shows the loading skeleton with its steps in order past 300 ms, and none when the view is ready sooner (spec 6.3)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => {
      await env.app.maintenance!.ingestPdf({
        literature_id: missingId,
        bytes: syntheticReadingPdf(20),
      });
    },
  });
  try {
    // Every state the skeleton shows, in order, and when it first appeared.
    await w.page.addInitScript(() => {
      const seen: string[] = [];
      const record = { seen, first: null as number | null };
      new MutationObserver(() => {
        const root = document.querySelector(".reader-preparing");
        if (!root) return;
        record.first ??= performance.now();
        const current = root.querySelector(
          '.reader-preparing-step[data-state="current"]',
        );
        const text = current?.textContent?.replace(/[\d.]+ MB.*$/u, "").trim();
        if (text && seen.at(-1) !== text) seen.push(text);
      }).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      Object.assign(window, { preparing: record });
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await w.page.route(
      (url) => url.pathname.startsWith("/api/v1/query/material-bytes/"),
      async (route) => {
        await held;
        await route.continue().catch(() => undefined);
      },
    );
    await w.page.goto(`${w.origin}/?literature=${missingId}&reader=pdf`);
    const skeleton = w.page.locator(".reader-preparing");
    await skeleton
      .locator('.reader-preparing-step[data-state="current"]')
      .getByText("下载 PDF")
      .waitFor();
    // In the content area, with the title from the bibliography, the steps and the bar.
    expect(await skeleton.locator(".reader-preparing-title").innerText()).toBe(
      "Unparsed source",
    );
    expect(
      await skeleton.locator(".reader-preparing-step").allInnerTexts(),
    ).toEqual(["下载 PDF", "解析", "排版"]);
    // The page header on the skeleton's sheet says what is being prepared (spec 6.3).
    expect(await skeleton.locator(".reader-page-header-view").innerText()).toBe(
      "PDF · 正在准备",
    );
    // Released slowly enough for each step to show.
    await w.page.unroute((url) =>
      url.pathname.startsWith("/api/v1/query/material-bytes/"),
    );
    release();
    await w.page
      .locator('.reading-pdf-page[data-rendered="true"]')
      .first()
      .waitFor();
    await skeleton.waitFor({ state: "detached" });
    const record = await w.page.evaluate(
      () => (window as unknown as { preparing: { seen: string[] } }).preparing,
    );
    // Each step shown in the order the loading went; at least the first and last.
    const order = ["下载 PDF", "解析", "排版"];
    const seen = record.seen.map((s) =>
      order.findIndex((o) => s.startsWith(o)),
    );
    expect(seen[0]).toBe(0);
    expect(seen.every((n, i) => n >= 0 && (i === 0 || n > seen[i - 1]!))).toBe(
      true,
    );
    // Switching between views that are both ready shows no skeleton at all.
    await w.page.getByRole("tab", { name: "原文", exact: true }).click();
    await w.page
      .locator(".reader-surface .ui-empty")
      .getByText("这份资料还没有可读的文本。", { exact: true })
      .waitFor();
    await w.page.evaluate(() => {
      (
        window as unknown as { preparing: { first: number | null } }
      ).preparing.first = null;
    });
    for (const name of ["PDF", "原文", "PDF"] as const) {
      await w.page.getByRole("tab", { name, exact: true }).click();
      await w.page.waitForTimeout(400);
    }
    expect(
      await w.page.evaluate(
        () =>
          (window as unknown as { preparing: { first: number | null } })
            .preparing.first,
      ),
    ).toBeNull();
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("stretches the drawn PDF pages in the first frame of a zoom, then replaces them sharp at the new scale", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => {
      await env.app.maintenance!.ingestPdf({
        literature_id: missingId,
        bytes: syntheticReadingPdf(20),
      });
    },
  });
  try {
    await w.page.goto(`${w.origin}/?literature=${missingId}&reader=pdf`);
    await w.page
      .locator('.reading-pdf-page[data-rendered="true"]')
      .first()
      .waitFor();
    // Every frame from the click on: does each visible page show a picture?
    await w.page.evaluate(() => {
      const frames: { t: number; pictured: boolean; pages: number }[] = [];
      const loop = (t: number) => {
        const body = document.querySelector<HTMLElement>(
          ".reader-engine-body:not([hidden])",
        )!;
        const box = body.getBoundingClientRect();
        const visible = [
          ...body.querySelectorAll<HTMLElement>(".reading-pdf-page"),
        ].filter((p) => {
          const r = p.getBoundingClientRect();
          return r.bottom > box.top && r.top < box.bottom;
        });
        frames.push({
          t,
          pages: visible.length,
          pictured: visible.every((p) => {
            const canvas = p.querySelector("canvas");
            return !!canvas && canvas.width > 0;
          }),
        });
        if (frames.length < 600) requestAnimationFrame(loop);
      };
      addEventListener("pointerdown", () => requestAnimationFrame(loop), {
        capture: true,
        once: true,
      });
      Object.assign(window, { zoomFrames: frames });
    });
    await readerType(w.page, "150%");
    const ratio = await w.page.evaluate(() =>
      Math.min(devicePixelRatio || 1, 2),
    );
    // Sharp: every visible page drawn at 150% (612 pt → 918 CSS px), pixels to match.
    await w.page.waitForFunction((ratio) => {
      const body = document.querySelector<HTMLElement>(
        ".reader-engine-body:not([hidden])",
      )!;
      const box = body.getBoundingClientRect();
      const visible = [
        ...body.querySelectorAll<HTMLElement>(".reading-pdf-page"),
      ].filter((p) => {
        const r = p.getBoundingClientRect();
        return r.bottom > box.top && r.top < box.bottom;
      });
      return (
        visible.length > 0 &&
        visible.every((p) => {
          const canvas = p.querySelector("canvas");
          return (
            !!canvas &&
            Math.abs(p.getBoundingClientRect().width - 918) < 1 &&
            Math.abs(canvas.getBoundingClientRect().width - 918) < 1 &&
            canvas.width === Math.ceil(918 * ratio) &&
            canvas.height === Math.ceil(792 * 1.5 * ratio)
          );
        })
      );
    }, ratio);
    const frames = await w.page.evaluate(
      () =>
        (
          window as unknown as {
            zoomFrames: { pictured: boolean; pages: number }[];
          }
        ).zoomFrames,
    );
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.pages > 0 && f.pictured)).toBe(true);
    // One canvas per page once replaced; only visible pages and one either side.
    const drawn = await w.page.locator(".reading-pdf-page canvas").count();
    expect(drawn).toBeGreaterThan(0);
    expect(
      await w.page
        .locator(".reading-pdf-page")
        .evaluateAll((pages) =>
          Math.max(...pages.map((p) => p.querySelectorAll("canvas").length)),
        ),
    ).toBe(1);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("keeps a 100-page PDF bounded over ten React reader switches and releases its resources", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => {
      await env.app.maintenance!.ingestPdf({
        literature_id: missingId,
        bytes: syntheticReadingPdf(),
      });
    },
  });
  const timings = { cold: 0, warm: [] as number[], page: 0, zoom: 0, find: 0 };
  try {
    await trackReadingResources(w.page);
    await w.page.reload();
    await showAllLibraryStatuses(w.page);
    const open = async (id: string) => {
      const title =
        id === missingId ? "Unparsed source" : "Synthetic literature workbench";
      const tabs = w.page.getByRole("navigation", {
        name: "阅读标签",
        exact: true,
      });
      const tab = tabs.getByRole("button", { name: title, exact: true });
      if (await tab.count()) await tab.click();
      else {
        if (await tabs.count()) await readerToLibrary(w.page);
        await w.page
          .getByRole("article", { name: title, exact: true })
          .locator(".paper-open")
          .click()
          .catch(async (cause: unknown) => {
            throw new Error(
              `${String(cause)}\n${w.page.url()}\n${await w.page.locator("body").innerText()}\n${JSON.stringify(await w.page.locator(".library-list,.paper-row").evaluateAll((elements) => elements.map((el) => ({ tag: el.tagName, class: el.className, height: el.clientHeight, scroll: el.scrollTop, rect: el.getBoundingClientRect().toJSON() }))))}`,
            );
          });
        // A paper with text opens its full text (spec 6.4); this check reads the PDF.
        await w.page.getByRole("tab", { name: "PDF", exact: true }).click();
      }
      await w.page
        .locator(
          `.reader-engine-body[data-literature-id="${id}"] .reading-pdf-page[data-rendered="true"]`,
        )
        .first()
        .waitFor()
        .catch(async (error: unknown) => {
          throw new Error(
            `${String(error)}\n${await w.page.locator("body").innerText()}\n${await w.page
              .locator(".reader-engine-body")
              .evaluate((el) => ({
                identity: el.dataset.literatureId,
                children: el.childElementCount,
              }))
              .catch(() => "no body")}\n${w.errors.join("\n")}`,
          );
        });
    };
    // The zoom in force, as the page header writes it (spec 1.2).
    const zoomShown = () =>
      w.page
        .locator(
          ".reader-engine:not([hidden]) .reader-view:not([hidden]) .reader-page-header-view",
        )
        .innerText();
    let start = Date.now();
    await open(missingId);
    timings.cold = Date.now() - start;
    const pageIs = async () => String(await readerPageNumber(w.page));
    start = Date.now();
    await readerGoToPage(w.page, 50);
    await w.page
      .locator('[data-pdf-page="50"][data-rendered="true"]')
      .waitFor();
    timings.page = Date.now() - start;
    start = Date.now();
    // Spec 1.8.1: 实际大小, then 放大 by tens to 130%.
    await readerType(w.page, "130%");
    await expect
      .poll(() => w.page.locator(".textLayer").allTextContents())
      .toContainEqual(expect.stringContaining("page 50"));
    timings.zoom = Date.now() - start;
    await w.page.getByRole("button", { name: "查找…", exact: true }).click();
    await w.page
      .getByRole("searchbox", { name: "查找…", exact: true })
      .fill("page 89");
    start = Date.now();
    await w.page
      .getByRole("searchbox", { name: "查找…", exact: true })
      .press("Enter");
    await expect.poll(pageIs).toBe("89");
    timings.find = Date.now() - start;
    await readerGoToPage(w.page, 50);
    await w.page
      .locator('[data-pdf-page="50"][data-rendered="true"]')
      .waitFor();
    for (let index = 0; index < 10; index++) {
      await open(w.env.parseRequest.literature_id);
      expect(await pageIs()).toBe("1");
      expect(await zoomShown()).toContain("适合宽度");
      start = Date.now();
      await open(missingId);
      await expect.poll(pageIs).toBe("50");
      expect(await zoomShown()).toContain("130%");
      timings.warm.push(Date.now() - start);
      const counts = await readingResourceCounts(w.page);
      // The current and the previous tab keep their engines (spec 5.1, 5.3).
      expect(counts.workers).toBeLessThanOrEqual(2);
      expect(counts.canvases).toBeLessThanOrEqual(4);
    }
    while (await w.page.getByRole("button", { name: /^关闭文献 / }).count())
      await w.page
        .getByRole("button", { name: /^关闭文献 / })
        .first()
        .click();
    await expect
      .poll(() => readingResourceCounts(w.page))
      .toEqual({ workers: 0, urls: 0, canvases: 0 });
    await recordReading("react-pdf-performance", {
      timings,
      chromium: w.browser.version(),
      bytes: syntheticReadingPdf().length,
    });
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("previews only explicit document links and never guesses bare citation numbers", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => {
      env.setText(
        "# Results\nThe measured energy was 4.2 eV.\nSee [reference](#reference-one), [missing](#unresolved), and bare [1].\n\n## Reference One\nSmith et al. Explicit source citation.\n",
      );
    },
  });
  let releaseOutline!: () => void;
  const outlineGate = new Promise<void>((resolve) => {
    releaseOutline = resolve;
  });
  try {
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/document-outline",
      async (route) => {
        const response = await route.fetch();
        await outlineGate;
        await route.fulfill({ response });
      },
    );
    await w.page.goto(
      `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=doc`,
    );
    const reference = w.page.getByRole("link", {
      name: "reference",
      exact: true,
    });
    await reference.hover();
    const preview = w.page.getByRole("dialog", {
      name: "文内引用预览",
      exact: true,
    });
    await preview.waitFor();
    expect(await preview.innerText()).toContain("Smith et al.");
    // Auxiliary navigation can arrive after the user has already opened a preview.
    const outlineResponse = w.page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/document-outline"),
    );
    releaseOutline();
    await (await outlineResponse).finished();
    // Remain usable after the former Dialog autofocus/refocus interval.
    await w.page.waitForTimeout(650);
    expect(await preview.count()).toBe(1);
    await preview
      .getByRole("button", { name: "前往文内位置", exact: true })
      .click();
    await preview.waitFor({ state: "hidden" });
    const missing = w.page.getByRole("link", { name: "missing", exact: true });
    expect(await missing.getAttribute("aria-disabled")).toBe("true");
    await missing.hover();
    expect(await preview.count()).toBe(0);
    expect(
      await w.page.getByRole("link", { name: "1", exact: true }).count(),
    ).toBe(0);
    expect(await w.page.locator(".reading-article").innerText()).toContain(
      "bare [1]",
    );
    expect(w.errors).toEqual([]);
  } finally {
    releaseOutline();
    await w.page.unrouteAll({ behavior: "wait" });
    await w.close();
  }
}, 90000);

it("does not let a late PDF response overwrite a newer full-text view", async () => {
  const w = await nextWorkspace({ ready: "body" });
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  try {
    await w.page.route(
      (url) => url.pathname.startsWith("/api/v1/query/material-bytes/"),
      async (route) => {
        intercepted = true;
        await barrier;
        await route.continue();
      },
    );
    await w.page.goto(
      `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=pdf`,
    );
    await expect.poll(() => intercepted, { timeout: 20_000 }).toBe(true);
    await w.page.getByRole("tab", { name: "原文", exact: true }).click();
    await w.page.locator(".reading-article").waitFor();
    release!();
    await expect
      .poll(() => w.page.locator(".reading-article").innerText())
      .toContain("4.2 eV");
    expect(await w.page.locator(".reading-pdf-page").count()).toBe(0);
    expect(new URL(w.page.url()).searchParams.get("reader")).toBe("doc");
    expect(w.errors).toEqual([]);
  } finally {
    release?.();
    await w.close();
  }
}, 90000);

it("reads a draft as the default text: its level, its note, no editing, its doubts and their differences, and starts no processing (plan 21 block 10)", async () => {
  const w = await nextWorkspace({ ready: "body", setup: draftPdf });
  try {
    await w.page.setViewportSize({ width: 1440, height: 900 });
    const draft = await formDraft(w);
    const doubtful = await doubtfulDraft(w.page);
    const before = {
      parses: w.env.parseCalls,
      models: w.env.modelCalls,
      jobs: (await w.env.app.jobs!.listJobs(50)).length,
    };
    // A mark made on the draft says so in the marks list (technical 09 §9.2).
    const segments = await w.env.app.documentRead.segments({
      document_version_id: draft,
      section_id: null,
      limit: 100,
      cursor: null,
    });
    const first = segments.segments.find((s) => s.kind === "text")!;
    await w.env.app.marks.manage({
      operation: "create",
      request: {
        literature_id: missingId,
        kind: "highlight",
        color: "blue",
        quote: "Page 1: reported results and evidence.",
        document: {
          document_version_id: draft,
          start_utf8: first.start_utf8,
          end_utf8: first.end_utf8,
        },
      },
    });
    await w.page.goto(`${w.origin}/?literature=${missingId}&reader=doc`);
    await w.page.locator('.react-reader[data-reading-ready="true"]').waitFor();
    const shown = ".reader-engine:not([hidden]) .reader-view:not([hidden])";
    // The page header names the level; the note above the text is the spec's sentence.
    await expect
      .poll(() =>
        w.page.locator(`${shown} .reader-page-header-view`).innerText(),
      )
      .toBe("原文 · 未校对");
    expect(
      await w.page.locator(`${shown} .reading-long-document`).innerText(),
    ).toBe("全文 · 未校对：文字可能含解析错误；以 PDF 为准");
    // The information panel: each part's level, and why there is no editing.
    const information = w.page.locator(".reader-information");
    await expect.poll(() => information.innerText()).toContain("全文：未校对");
    expect(await information.innerText()).toContain(
      "未校对的全文不接受改字，生成全文并校对后再修改",
    );
    await w.page.getByRole("button", { name: "更多", exact: true }).click();
    expect(
      await w.page
        .getByRole("menuitem", { name: "修改全文", exact: true })
        .count(),
    ).toBe(0);
    await w.page.keyboard.press("Escape");
    // The marks list says on which level each mark was made.
    await readerPanel(w.page, "批注");
    await expect
      .poll(() => w.page.locator(".mark-card-level").allInnerTexts())
      .toEqual(["未校对的全文上"]);
    await w.page.getByRole("tab", { name: "信息", exact: true }).click();
    // “显示核对依据”: only the segments that differ from the PDF's own text
    // or have none to check carry a mark; agreeing ones carry nothing (plan
    // 25 block 30). The doubts stand in the left margin.
    await readerType(w.page, "显示核对依据");
    expect(doubtful.size).toBe(2);
    const sources = await w.page
      .locator(`${shown} .reading-block-source`)
      .allInnerTexts();
    expect(sources).toEqual(
      expect.arrayContaining([
        "和 PDF 自带的文字不一样",
        "没有 PDF 自带的文字可以对照",
      ]),
    );
    expect(sources).not.toContain("和 PDF 自带的文字一致");
    expect(
      await w.page.locator(`${shown} section[data-byte-start]:has(p)`).count(),
    ).toBeGreaterThan(sources.length);
    expect(
      await w.page.locator(`${shown} .reading-doubt`).allInnerTexts(),
    ).toEqual(["疑点", "无自带文字"]);
    // “疑点” opens the saved differences: text layer over draft, or another page.
    await w.page
      .locator(`${shown} .reading-doubt`)
      .getByText("疑点", { exact: true })
      .click();
    const popover = w.page.locator(".reader-doubt");
    await expect.poll(() => popover.innerText()).toContain("疑点 · 2 处差异");
    const text = await popover.innerText();
    expect(text).toContain("PDF 自带的文字：findings");
    expect(text).toContain("未校对的全文：results");
    expect(text).toContain(
      "这段文字在本页 PDF 自带的文字里找不到，出现在第 3 页。",
    );
    await w.page.keyboard.press("Escape");
    // Reading forms, parses and runs nothing.
    expect(w.env.parseCalls).toBe(before.parses);
    expect(w.env.modelCalls).toBe(before.models);
    expect((await w.env.app.jobs!.listJobs(50)).length).toBe(before.jobs);
    // An archived paper reads its proofread text: no note, and it can be edited.
    await w.page.unrouteAll({ behavior: "wait" });
    await w.page.goto(
      `${w.origin}/?literature=${w.env.parseRequest.literature_id}&reader=doc`,
    );
    await expect
      .poll(
        () => w.page.locator(`${shown} .reader-page-header-view`).innerText(),
        { timeout: 20_000 },
      )
      .toBe("原文 · 已校对");
    expect(
      await w.page.locator(`${shown} .reading-long-document`).count(),
    ).toBe(0);
    await w.page.getByRole("button", { name: "更多", exact: true }).click();
    await w.page
      .getByRole("menuitem", { name: "修改全文", exact: true })
      .waitFor();
    await w.page.keyboard.press("Escape");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);
