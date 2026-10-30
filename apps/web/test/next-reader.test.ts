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
import { missingId } from "./processor-workspace-fixture.js";
import { expect, it } from "vitest";

import {
  nextWorkspace,
  readerOperation,
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
      expect(
        await w.page
          .getByRole("textbox", { name: "PDF 页码", exact: true })
          .inputValue(),
      ).toBe("1");
      await w.page
        .getByRole("button", { name: "收起信息", exact: true })
        .click();
      await w.page.getByRole("tab", { name: "全文", exact: true }).click();
      await w.page.locator(".reader-engine-body .reading-article").waitFor();
      await expect
        .poll(() =>
          w.page.locator(".reader-engine-body .reading-article").textContent(),
        )
        .toContain("4.2 eV");
      expect(
        await w.page.locator(".reading-status:visible").textContent(),
      ).not.toContain("字节");
      expect(
        await w.page
          .locator(".reader-engine-body .reading-article")
          .evaluate((el) => getComputedStyle(el).fontSize),
      ).toBe("20px");
      await w.page
        .getByRole("button", { name: "显示信息", exact: true })
        .click();
      await readerOperation(w.page, "解析 PDF");
      await w.page
        .getByRole("dialog", { name: "解析 PDF", exact: true })
        .waitFor();
      await w.page.getByRole("button", { name: "取消", exact: true }).click();
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
      const tabs = w.page.getByRole("navigation", { name: "工作区与阅读标签" });
      const tab = tabs.getByRole("button", { name: title, exact: true });
      if (await tab.count()) await tab.click();
      else {
        await tabs.getByRole("button", { name: "文献库", exact: true }).click();
        await w.page
          .getByRole("article", { name: title, exact: true })
          .locator(".paper-open")
          .click()
          .catch(async (cause: unknown) => {
            throw new Error(
              `${String(cause)}\n${w.page.url()}\n${await w.page.locator("body").innerText()}\n${JSON.stringify(await w.page.locator(".library-list,.paper-row").evaluateAll((elements) => elements.map((el) => ({ tag: el.tagName, class: el.className, height: el.clientHeight, scroll: el.scrollTop, rect: el.getBoundingClientRect().toJSON() }))))}`,
            );
          });
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
    let start = Date.now();
    await open(missingId);
    timings.cold = Date.now() - start;
    const page = w.page.getByRole("textbox", { name: "PDF 页码", exact: true });
    await page.fill("50");
    start = Date.now();
    await page.press("Enter");
    await w.page
      .locator('[data-pdf-page="50"][data-rendered="true"]')
      .waitFor();
    timings.page = Date.now() - start;
    await w.page.getByRole("button", { name: "PDF 缩放" }).click();
    start = Date.now();
    await w.page.getByRole("option", { name: "125%", exact: true }).click();
    await expect
      .poll(() => w.page.locator(".textLayer").allTextContents())
      .toContainEqual(expect.stringContaining("page 50"));
    timings.zoom = Date.now() - start;
    await w.page
      .getByRole("button", { name: "文档内查找", exact: true })
      .click();
    await w.page
      .getByRole("searchbox", { name: "文档内查找", exact: true })
      .fill("page 89");
    start = Date.now();
    await w.page
      .getByRole("searchbox", { name: "文档内查找", exact: true })
      .press("Enter");
    await expect.poll(() => page.inputValue()).toBe("89");
    timings.find = Date.now() - start;
    await page.fill("50");
    await page.press("Enter");
    await w.page
      .locator('[data-pdf-page="50"][data-rendered="true"]')
      .waitFor();
    for (let index = 0; index < 10; index++) {
      await open(w.env.parseRequest.literature_id);
      expect(await page.inputValue()).toBe("1");
      expect(
        await w.page.getByRole("button", { name: "PDF 缩放" }).textContent(),
      ).toContain("适宽");
      start = Date.now();
      await open(missingId);
      await expect.poll(() => page.inputValue()).toBe("50");
      expect(
        await w.page.getByRole("button", { name: "PDF 缩放" }).textContent(),
      ).toContain("125%");
      timings.warm.push(Date.now() - start);
      const counts = await readingResourceCounts(w.page);
      expect(counts.workers).toBe(1);
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
      (url) => url.pathname === "/api/v1/query/material-bytes",
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
    await w.page.getByRole("tab", { name: "全文", exact: true }).click();
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
