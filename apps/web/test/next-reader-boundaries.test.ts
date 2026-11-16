import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeDesignAudit } from "./design-audit-fixture.js";
import { expect, it } from "vitest";
import {
  parseArtifactRef,
  parseLiterature,
  sha256,
} from "@sciretriever/contracts";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { missingId } from "./processor-workspace-fixture.js";
import { syntheticReadingPdf } from "./reading-pdf-fixture.js";
import {
  readerMore,
  readerPageNumber,
  readerTextComplete,
  readerToLibrary,
  readerType,
  readerTypeChoice,
  readerPanel,
} from "./reader-controls.js";

type Workspace = Awaited<ReturnType<typeof nextWorkspace>>;
const open = (
  w: Workspace,
  mode = "pdf",
  id: string = w.env.parseRequest.literature_id,
) => w.page.goto(`${w.origin}/?literature=${id}&reader=${mode}`);
const ready = (w: Workspace) =>
  w.page.locator('.reading-pdf-page[data-rendered="true"]').first().waitFor();
const paragraphs = (length: number) =>
  Array.from(
    { length },
    (_, i) =>
      `Paragraph ${i}: a reported measurement with conditions and evidence.\n\n`,
  ).join("");
// A slice carries up to 200 segments: these span two segment pages, and
// several slices when continuation is held back.
const mediumDocument = paragraphs(300);
const longDocument = paragraphs(1400);

it("continues fixed Unicode Markdown without rebuilding stable blocks and recovers a failed continuation", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => {
      env.setText(
        '# Original 文献🙂\r\n\r\nText with $E=mc^2$.\r\n\r\n| Sample | Value |\r\n|---|---|\r\n| A | 4.2 eV |\r\n\r\n$$\r\nE = mc^2\r\n$$\r\n\r\n<span onclick="window.attacked=true">unsafe HTML</span>\r\n\r\n[unsafe](javascript:alert(1)) ![image](valid.png) ![missing](missing.png)\r\n\r\n' +
          mediumDocument +
          '\n\n<table><tr><td><img src="tail.png" alt="Final figure"></td></tr></table>\n',
      );
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=",
        "base64",
      );
      const artifact = parseArtifactRef({
        sha256: await sha256(bytes),
        byte_size: bytes.length,
        media_type: "image/png",
      });
      env.setResources(
        ["valid.png", "missing.png", "tail.png"].map((reference) => ({
          reference,
          content: { bytes, artifact },
        })),
      );
    },
  });
  let reads = 0;
  let releaseImage!: () => void;
  const imageBarrier = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  try {
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/document-slice",
      async (route) => {
        reads++;
        if (reads === 2)
          await route.fulfill({
            status: 503,
            json: { code: "synthetic-read-failure" },
          });
        else if (reads === 3) {
          const response = await route.fetch();
          const envelope = await response.json();
          const result = envelope.result;
          const bytes = Buffer.from(result.text);
          result.text = bytes.subarray(0, 20).toString();
          result.actual_range.end_utf8 =
            result.actual_range.start_utf8 + Buffer.byteLength(result.text);
          result.truncated = false;
          result.continuation = null;
          await route.fulfill({ response, json: envelope });
        } else await route.continue();
      },
    );
    // Pictures arrive whole by resource ID; the listing maps IDs to references.
    const references = new Map<string, string>();
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/document-resources",
      async (route) => {
        const response = await route.fetch();
        const value = (await response.json()) as {
          result: { resources: { resource_id: string; reference: string }[] };
        };
        for (const r of value.result.resources)
          references.set(r.resource_id, r.reference);
        await route.fulfill({ response });
      },
    );
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/document-resource-bytes",
      async (route) => {
        const request = route.request().postDataJSON() as {
          request: { resource_id: string };
        };
        const reference = references.get(request.request.resource_id);
        const response = await route.fetch();
        if (reference === "missing.png")
          await route.fulfill({
            status: 503,
            json: { code: "synthetic-resource-failure" },
          });
        else {
          if (reference === "valid.png") await imageBarrier;
          await route.fulfill({ response });
        }
      },
    );
    await open(w, "doc");
    const article = w.page.locator(".reading-article");
    await article.locator("table").waitFor();
    expect(await article.locator(".katex").count()).toBe(2);
    expect(await article.locator("table").innerText()).toContain("4.2 eV");
    expect(await article.locator("h1").count()).toBe(1);
    expect(await article.locator("a[href^='javascript:']").count()).toBe(0);
    await w.page.locator(".reading-resource").first().scrollIntoViewIfNeeded();
    const firstImage = article.locator('[data-resource="valid.png"]');
    await expect.poll(() => firstImage.innerText()).toBe("正在加载图片…");
    expect(await firstImage.getAttribute("aria-busy")).toBe("true");
    expect(await article.innerText()).not.toContain("valid.png");
    releaseImage();
    await article.locator("img").waitFor();
    expect(await article.locator("img").getAttribute("src")).toMatch(/^blob:/);
    expect(
      await article
        .locator("img")
        .evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0),
    ).toBe(true);
    expect(await firstImage.getAttribute("aria-busy")).toBeNull();
    await expect
      .poll(() => article.locator('[data-resource="missing.png"]').innerText())
      .toContain("暂不可读");
    await article.locator("img").click();
    await w.page.getByRole("dialog", { name: "查看原图" }).waitFor();
    await w.page.keyboard.press("Escape");
    if (process.env.SCIRETRIEVER_WEB_REVIEW_OUTPUT) {
      const output = process.env.SCIRETRIEVER_WEB_REVIEW_OUTPUT;
      await mkdir(output, { recursive: true });
      for (const font of [18, 24]) {
        await readerType(w.page, `${font} px`);
        for (const theme of ["light", "dark", "green", "warm"]) {
          await w.page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
            document.querySelector(".reader-engine-body")!.scrollTop = 0;
          }, theme);
          const name = `reader-scientific-${font}-${theme}`;
          await w.page.screenshot({
            path: join(output, `${name}.png`),
            animations: "disabled",
          });
          await writeDesignAudit(w.page, output, name);
        }
      }
      await w.page.evaluate(() => {
        document.documentElement.dataset.theme = "light";
      });
    }
    await article
      .locator("section")
      .first()
      .evaluate((el) => el.setAttribute("data-preserved", "yes"));
    const body = w.page.locator(".reader-engine-body");
    const bottom = () =>
      body.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
    await bottom();
    await w.page
      .getByText("加载暂停，已读正文保留。", { exact: true })
      .first()
      .waitFor();
    expect(reads).toBe(2);
    await bottom();
    expect(reads).toBe(2);
    await w.page.getByRole("button", { name: "重试", exact: true }).click();
    await expect.poll(() => reads).toBe(3);
    // The notice gives the reason in words; the internal cause is in its technical details.
    await expect
      .poll(() =>
        w.page.locator(".reader-surface .ui-error-notice").innerText(),
      )
      .toContain("正文续读位置失效，请重新打开。");
    expect(
      await w.page.locator(".reader-surface .ui-tech-details").textContent(),
    ).toContain("缺少续读游标");
    expect(await article.locator("[data-preserved=yes]").count()).toBe(1);
    await w.page.getByRole("button", { name: "重试", exact: true }).click();
    await expect.poll(() => reads).toBeGreaterThan(3);
    for (let i = 0; i < 20 && !(await readerTextComplete(w.page)); i++) {
      await bottom();
      await expect
        .poll(() => w.page.locator(".reading-continuation").innerText())
        .not.toContain("正在加载");
    }
    await expect.poll(() => article.innerText()).toContain("Paragraph 299:");
    expect(await article.locator("[data-preserved=yes]").count()).toBe(1);
    expect(await readerTextComplete(w.page)).toBe(true);
    const tailImage = article.locator('[data-resource="tail.png"] img');
    await article
      .locator('[data-resource="tail.png"]')
      .scrollIntoViewIfNeeded();
    await tailImage.waitFor();
    expect(
      await tailImage.evaluate((el: HTMLImageElement) => el.naturalWidth),
    ).toBeGreaterThan(0);
    await w.page.setViewportSize({ width: 390, height: 844 });
    await tailImage.scrollIntoViewIfNeeded();
    expect(
      await w.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await tailImage.focus();
    await tailImage.press("Enter");
    const zoom = w.page.getByRole("dialog", { name: "查看原图" });
    await zoom.waitFor();
    expect(await zoom.locator("img").getAttribute("alt")).toBe("Final figure");
    await w.page.keyboard.press("Escape");
    expect(w.env.parseCalls).toBe(w.setupCalls.parser);
    expect(w.env.modelCalls).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    releaseImage();
    await w.page.unrouteAll({ behavior: "wait" });
    await w.close();
  }
}, 90000);

it("keeps the latest outline target, text settings and reading position across a tab switch and searches the loaded range", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) =>
      env.setText(
        "# Original document\n\n" +
          Array.from(
            { length: 400 },
            (_, index) =>
              `## Section ${index}\n\nParagraph ${index} 中文 α🙂. ${"A reported observation with conditions. ".repeat(3)}\n\n`,
          ).join(""),
      ),
  });
  const requests: string[] = [];
  let release: () => void = () => {};
  try {
    w.page.on("request", (request) => requests.push(request.url()));
    await open(w, "doc");
    await w.page.locator(".reading-article").waitFor();
    await readerMore(w.page, "显示目录");
    let arrived: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    await w.page.route("**/api/v1/query/document-slice?*", async (route) => {
      arrived();
      await held;
      await route.continue().catch(() => {});
    });
    await w.page
      .locator(".reader-outline")
      .getByRole("button", { name: "Section 150", exact: true })
      .click();
    await started;
    // Choosing an entry closed the outline (spec 1.6): open it again.
    await readerMore(w.page, "显示目录");
    await w.page
      .locator(".reader-outline")
      .getByRole("button", { name: "Section 300", exact: true })
      .click();
    release();
    const heading = w.page
      .locator(".reading-article")
      .getByRole("heading", { name: "Section 300", exact: true });
    await expect
      .poll(
        () =>
          heading.evaluate((element) =>
            Math.abs(
              element.getBoundingClientRect().top -
                document
                  .querySelector(".reader-engine-body")!
                  .getBoundingClientRect().top,
            ),
          ),
        { timeout: 20_000 },
      )
      .toBeLessThan(60);
    await w.page.unrouteAll({ behavior: "wait" });
    await readerType(w.page, "24 px");
    await w.page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const body = w.page.locator(".reader-engine-body");
    const top = await body.evaluate((element) => element.scrollTop);
    await readerToLibrary(w.page);
    // Back through its tab: the shell's tabs show beside the library's section button.
    const tabs = w.page.getByRole("navigation", { name: "工作区与阅读标签" });
    await tabs
      .getByRole("button", {
        name: "Synthetic literature workbench",
        exact: true,
      })
      .click();
    await expect
      .poll(() => w.page.locator(".reading-article").textContent(), {
        timeout: 20_000,
      })
      .toContain("Paragraph 300");
    await expect
      .poll(
        () =>
          w.page
            .getByRole("button", { name: "查找…", exact: true })
            .isEnabled(),
        { timeout: 20_000 },
      )
      .toBe(true);
    expect(await readerTypeChoice(w.page)).toBe("比例 120%");
    expect(
      Math.abs((await body.evaluate((element) => element.scrollTop)) - top),
    ).toBeLessThan(80);
    await w.page.getByRole("button", { name: "查找…", exact: true }).click();
    const search = w.page.getByRole("searchbox", {
      name: "查找…",
      exact: true,
    });
    await search.fill("Paragraph 300");
    await search.press("Enter");
    expect(
      await w.page.locator(".reader-find [role=status]").textContent(),
    ).toContain("已加载范围");
    expect(await w.page.locator(".reading-match").textContent()).toContain(
      "Paragraph 300",
    );
    expect(requests.every((url) => new URL(url).origin === w.origin)).toBe(
      true,
    );
    expect(w.env.parseCalls).toBe(w.setupCalls.parser);
    expect(w.env.modelCalls).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    release();
    await w.page.unrouteAll({ behavior: "wait" });
    await w.close();
  }
}, 60000);

it("explains scan-only PDFs and refuses bytes whose immutable hash changed", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => {
      await env.app.maintenance!.ingestPdf({
        literature_id: missingId,
        bytes: syntheticReadingPdf(1, false),
      });
    },
  });
  try {
    await open(w, "pdf", missingId);
    await ready(w);
    await w.page.getByRole("button", { name: "查找…", exact: true }).click();
    await w.page
      .getByRole("searchbox", { name: "查找…", exact: true })
      .fill("observation");
    await w.page
      .getByRole("searchbox", { name: "查找…", exact: true })
      .press("Enter");
    await expect
      .poll(() => w.page.locator(".reader-find").innerText())
      .toContain("没有可检索文字层");
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/material-bytes",
      async (route) => {
        const response = await route.fetch();
        const bytes = await response.body();
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        await route.fulfill({ response, body: bytes });
      },
    );
    await w.page.reload();
    await expect
      .poll(
        () => w.page.locator(".reader-surface .ui-error-notice").innerText(),
        { timeout: 20_000 },
      )
      .toContain("PDF 完整性校验失败");
    expect(await w.page.locator("canvas").count()).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.page.unrouteAll({ behavior: "wait" });
    await w.close();
  }
}, 60000);

it("keeps encrypted PDF rejection at ingestion and reports no accepted PDF", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => {
      await expect(
        env.app.maintenance!.ingestPdf({
          literature_id: missingId,
          bytes: syntheticReadingPdf(1, false, true),
        }),
      ).rejects.toMatchObject({ code: "manual-pdf-invalid" });
      expect((await env.app.library.detail(missingId)).primary_pdf).toBeNull();
    },
  });
  try {
    const detailRead = w.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/v1/query/read",
    );
    await open(w, "pdf", missingId);
    // Navigation only loads the shell. Source resolution starts after the
    // literature receipt; do not spend the assertion window on application startup.
    await (await detailRead).finished();
    // Without a PDF the paper does not open in the PDF view (spec 6.4, 3.9).
    await w.page
      .locator(".reader-surface .ui-empty")
      .getByText("这份资料只有书目信息。", { exact: true })
      .waitFor();
    expect(new URL(w.page.url()).searchParams.get("reader")).toBe("doc");
    expect(await w.page.locator("canvas").count()).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 45000);

it("keeps a verified PDF download available when its worker fails and supports retry", async () => {
  const w = await nextWorkspace({ ready: "body" });
  try {
    await w.page.route("**/reader/pdf.worker.mjs", (route) => route.abort());
    await open(w);
    await expect
      .poll(
        () => w.page.locator(".reader-surface .ui-error-notice").innerText(),
        { timeout: 20_000 },
      )
      .toContain("阅读组件未能加载");
    await w.page.getByRole("button", { name: "更多", exact: true }).click();
    expect(
      await w.page
        .getByRole("menuitem", { name: "下载已核验的原始 PDF", exact: true })
        .getAttribute("aria-disabled"),
    ).not.toBe("true");
    await w.page.keyboard.press("Escape");
    await w.page.unrouteAll({ behavior: "wait" });
    await w.page.getByRole("button", { name: "重试", exact: true }).click();
    await ready(w);
    expect(w.env.parseCalls).toBe(w.setupCalls.parser);
    expect(w.env.modelCalls).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.page.unrouteAll({ behavior: "wait" });
    await w.close();
  }
}, 60000);

it("discards a late automatic text continuation after the reader closes", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => env.setText(longDocument),
  });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  try {
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/document-slice",
      async (route) => {
        reads++;
        const response = await route.fetch();
        if (reads === 2) await barrier;
        await route.fulfill({ response });
      },
    );
    const initialOutline = w.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/query/document-outline",
    );
    await open(w, "doc");
    await w.page.locator(".reading-article").waitFor();
    // The article container precedes the first body chunk. Initial restoration
    // follows its outline receipt. Wait for the existing ready control as well,
    // so a programmatic scroll cannot race that initial restoration.
    await (await initialOutline).finished();
    await expect
      .poll(() =>
        w.page.getByRole("button", { name: "查找…", exact: true }).isEnabled(),
      )
      .toBe(true);
    await w.page.locator(".reader-engine-body").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect.poll(() => reads, { timeout: 20_000 }).toBe(2);
    await w.page.getByRole("button", { name: /^关闭文献 / }).click();
    release();
    await w.page.unrouteAll({ behavior: "wait" });
    expect(await w.page.locator(".reading-article").count()).toBe(0);
    await w.page.locator(".paper-row").first().waitFor();
    expect(reads).toBe(2);
    expect(w.errors).toEqual([]);
  } finally {
    release();
    await w.page.unrouteAll({ behavior: "wait" });
    await w.close();
  }
}, 60000);

it("renders metadata provenance as human fields and preserves a keyboard- and pointer-resized information panel", async () => {
  const w = await nextWorkspace({ ready: "body" });
  try {
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/read",
      async (route) => {
        const response = await route.fetch();
        const value = await response.json();
        value.detail.metadata_observations = [
          {
            observation_id: "00000000-0000-0000-0000-000000009901",
            source_type: null,
            source_type_mapping_version: null,
            provenance: {
              provenance_id: "00000000-0000-0000-0000-000000009902",
              source_kind: "metadata-provider",
              source_name: "Synthetic Crossref",
              source_record_id: "10.0000/example",
              observed_at: "2026-10-19T00:00:00Z",
              input_sha256: "a".repeat(64),
              parameters_sha256: null,
            },
            metadata: {
              ...value.detail.literature.metadata,
              abstract: "An original metadata abstract.",
            },
            version_role: null,
            version_links: [],
            declared_keywords: [],
            reference_texts: [],
            reference_count: null,
            cited_by_count: null,
            asset_hints: [],
          },
        ];
        await route.fulfill({ response, json: value });
      },
    );
    // Docked from a 1440 px window, where its handle is (spec 1.4).
    await w.page.setViewportSize({ width: 1440, height: 900 });
    await open(w, "doc");
    await w.page.locator(".reading-article").waitFor();
    await readerPanel(w.page);
    const resize = w.page.getByRole("separator", { name: "文献信息栏宽度" });
    await resize.focus();
    const before = Number(await resize.getAttribute("aria-valuenow"));
    await resize.press("ArrowLeft");
    expect(Number(await resize.getAttribute("aria-valuenow"))).toBe(
      before + 16,
    );
    const grip = await resize.boundingBox();
    if (!grip) throw new Error("Information resize grip is unavailable");
    const pointerX = grip.x + grip.width / 2,
      pointerY = grip.y + Math.min(80, grip.height / 2);
    await w.page.mouse.move(pointerX, pointerY);
    await w.page.mouse.down();
    await w.page.mouse.move(pointerX - 80, pointerY, { steps: 4 });
    await w.page.mouse.up();
    expect(Number(await resize.getAttribute("aria-valuenow"))).toBe(
      before + 96,
    );
    const side = w.page.locator(
      ".react-reader > .ui-split-pane > .ui-split-side",
    );
    expect(await side.evaluate((element) => element.clientWidth)).toBe(
      before + 96,
    );
    await w.page
      .locator(".reader-information")
      .getByRole("button", { name: "技术详情", exact: true })
      .click();
    await w.page
      .getByRole("heading", { name: "Synthetic Crossref", exact: true })
      .waitFor();
    expect(await w.page.locator(".reader-source pre").count()).toBe(0);
    await w.page
      .getByRole("button", { name: "此来源的摘要", exact: true })
      .click();
    expect(await w.page.locator(".reader-source").innerText()).toContain(
      "An original metadata abstract.",
    );
    await w.page.setViewportSize({ width: 390, height: 844 });
    await w.page.locator(".reader-source").scrollIntoViewIfNeeded();
    expect(
      await w.page
        .getByRole("heading", { name: "Synthetic Crossref", exact: true })
        .isVisible(),
    ).toBe(true);
    expect(await resize.isVisible()).toBe(false);
    await w.page.setViewportSize({ width: 1440, height: 1000 });
    await w.page.reload();
    await w.page.locator(".reading-article").waitFor();
    expect(Number(await resize.getAttribute("aria-valuenow"))).toBe(
      before + 96,
    );
    expect(await side.evaluate((element) => element.clientWidth)).toBe(
      before + 96,
    );
    await resize.dblclick();
    // Back to the default width, 352 px (spec 1.4).
    expect(Number(await resize.getAttribute("aria-valuenow"))).toBe(352);
    expect(w.errors).toEqual([]);
  } finally {
    await w.page.unrouteAll({ behavior: "wait" });
    await w.close();
  }
}, 60000);

it.each(["no-preference", "reduce"] as const)(
  "keeps reading actions keyboard-accessible at a 200 percent equivalent viewport (%s)",
  async (reducedMotion) => {
    const w = await nextWorkspace({ ready: "body" });
    try {
      await w.page.emulateMedia({ reducedMotion });
      // A 1440 × 900 display at 200% exposes a 720 × 450 CSS viewport.
      // This checks reflow and keyboard access; it is not an OS font-rendering claim.
      await w.page.setViewportSize({ width: 720, height: 450 });
      await open(w);
      await ready(w);
      const pdf = w.page.getByRole("tab", { name: "PDF", exact: true });
      await pdf.focus();
      await pdf.press("ArrowLeft");
      await w.page.keyboard.press("Enter");
      await w.page.locator(".reading-article").waitFor();
      expect(
        await w.page
          .getByRole("tab", { name: "原文", exact: true })
          .getAttribute("aria-selected"),
      ).toBe("true");
      // Below 760 px “排版” is folded into “更多” (spec 1.3), reached by keys.
      const more = w.page.getByRole("button", { name: "更多", exact: true });
      await more.focus();
      await more.press("Enter");
      const type = w.page.getByRole("menuitem", { name: "排版", exact: true });
      await type.focus();
      await type.press("ArrowRight");
      await w.page
        .getByRole("menuitem", { name: "放大", exact: true })
        .waitFor();
      await w.page.keyboard.press("Escape");
      await w.page.keyboard.press("Escape");
      await expect
        .poll(() => more.evaluate((el) => el === document.activeElement))
        .toBe(true);
      expect(
        await w.page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(w.env.parseCalls).toBe(w.setupCalls.parser);
      expect(w.env.modelCalls).toBe(0);
      expect(w.errors).toEqual([]);
    } finally {
      await w.close();
    }
  },
  60000,
);

it("keeps two reader engines over ten paper switches, releases the oldest for a third and all with their tabs", async () => {
  const third = "00000000-0000-0000-0000-000000005103";
  const w = await nextWorkspace({
    ready: "body",
    readerProbe: true,
    setup: async (env) => {
      await env.app.maintenance!.ingestPdf({
        literature_id: missingId,
        bytes: syntheticReadingPdf(3),
      });
      await env.app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: third,
          meta_literature_id: "00000000-0000-0000-0000-000000005104",
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: "Third source",
            identifiers: [],
          },
        }),
      );
      await env.app.maintenance!.ingestPdf({
        literature_id: third,
        bytes: Buffer.concat([
          syntheticReadingPdf(3),
          Buffer.from("\n% third\n"),
        ]),
      });
    },
  });
  type Counts = {
    engines: Record<string, number>;
    pdfRequests: Record<string, number>;
    pdfHashes: Record<string, number>;
    workersStarted: number;
    workersTerminated: number;
    workersPeak: number;
    objectUrlsCreated: number;
    objectUrlsRevoked: number;
  };
  const counts = () =>
    w.page.evaluate(
      () =>
        (window as unknown as { __sciretrieverReaderProbe: Counts })
          .__sciretrieverReaderProbe,
    );
  const shown = (id: string) =>
    w.page
      .locator(
        `.reader-engine-body[data-literature-id="${id}"] .reader-engine[data-literature-id="${id}"]:not([hidden]) .reading-pdf-page[data-rendered="true"]`,
      )
      .first()
      .waitFor();
  const visit = (id: string) =>
    w.page.evaluate((url) => {
      history.pushState(null, "", url);
      dispatchEvent(new PopStateEvent("popstate"));
    }, `/?literature=${id}&reader=pdf`);
  const hiddenCanvases = () =>
    w.page.locator(".reader-engine[hidden] canvas").count();
  try {
    const papers = [w.env.parseRequest.literature_id, missingId];
    await open(w, "pdf", papers[0]);
    await shown(papers[0]!);
    await visit(papers[1]!);
    await shown(papers[1]!);
    for (let n = 0; n < 10; n++) {
      await w.page
        .locator(".paper-tab")
        .nth(n % 2)
        .click();
      await shown(papers[n % 2]!);
      expect(await hiddenCanvases()).toBe(0);
      expect(await w.page.locator(".reader-engine").count()).toBe(2);
    }
    const two = await counts();
    expect(Object.values(two.engines)).toEqual([2]);
    expect(Object.values(two.pdfRequests)).toEqual([1, 1]);
    expect(Object.values(two.pdfHashes)).toEqual([1, 1]);
    expect(two.workersPeak).toBeLessThanOrEqual(2);
    // A third paper releases the least recently used engine first.
    await visit(third);
    await shown(third);
    const three = await counts();
    expect(three.workersPeak).toBeLessThanOrEqual(2);
    expect(three.workersStarted - three.workersTerminated).toBe(2);
    expect(await w.page.locator(".reader-engine").count()).toBe(2);
    expect(await hiddenCanvases()).toBe(0);
    while (await w.page.getByRole("button", { name: /^关闭文献 / }).count())
      await w.page
        .getByRole("button", { name: /^关闭文献 / })
        .first()
        .click();
    await expect
      .poll(async () => {
        const c = await counts();
        return {
          workers: c.workersStarted - c.workersTerminated,
          urls: c.objectUrlsCreated - c.objectUrlsRevoked,
        };
      })
      .toEqual({ workers: 0, urls: 0 });
    expect(await w.page.locator(".reading-pdf-page canvas").count()).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("bounds PDF canvases while zooming and bitmaps while scrolling, and releases both with the tab", async () => {
  const w = await nextWorkspace({
    ready: "body",
    readerProbe: true,
    setup: async (env) => {
      await env.app.maintenance!.ingestPdf({
        literature_id: missingId,
        bytes: syntheticReadingPdf(100),
      });
    },
  });
  type Counts = {
    canvasesCreated: number;
    canvasesReleased: number;
    objectUrlsCreated: number;
    objectUrlsRevoked: number;
    workersStarted: number;
    workersTerminated: number;
    bitmapsCreated: number;
    bitmapsReleased: number;
    bitmapsPerPaperPeak: number;
    bitmapBytesPerPaperPeak: number;
  };
  const counts = () =>
    w.page.evaluate(
      () =>
        (window as unknown as { __sciretrieverReaderProbe: Counts })
          .__sciretrieverReaderProbe,
    );
  const zoomTo = (option: string) => readerType(w.page, option);
  try {
    await open(w, "pdf", missingId);
    await ready(w);
    // Every frame: live canvases against the cap, two per page in the drawn range.
    await w.page.evaluate(() => {
      const probe = () =>
        (
          window as unknown as {
            __sciretrieverReaderProbe: {
              canvasesCreated: number;
              canvasesReleased: number;
            };
          }
        ).__sciretrieverReaderProbe;
      const state = { over: [] as string[], frames: 0, peak: 0, run: true };
      const loop = () => {
        if (!state.run) return;
        const body = document.querySelector<HTMLElement>(
          ".reader-engine-body:not([hidden])",
        );
        if (body) {
          const box = body.getBoundingClientRect();
          const visible = [
            ...body.querySelectorAll<HTMLElement>(".reading-pdf-page"),
          ].filter((p) => {
            const r = p.getBoundingClientRect();
            return r.bottom > box.top && r.top < box.bottom;
          }).length;
          const live = probe().canvasesCreated - probe().canvasesReleased;
          state.frames++;
          state.peak = Math.max(state.peak, live);
          if (live > 2 * (visible + 2)) state.over.push(`${live}/${visible}`);
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      Object.assign(window, { canvasCap: state });
    });
    await w.page.evaluate(() => {
      document.querySelector<HTMLElement>(
        ".reader-engine-body:not([hidden])",
      )!.scrollTop = 6000;
    });
    await ready(w);
    for (const option of ["150%", "75%", "200%", "适合宽度"])
      await zoomTo(option);
    // A window drag: many widths in a row, each stretched at once.
    for (const width of [1400, 1320, 1240, 1180, 1260, 1440])
      await w.page.setViewportSize({ width, height: 900 });
    await w.page
      .locator('.reading-pdf-page[data-picture="canvas"]')
      .first()
      .waitFor();
    const cap = await w.page.evaluate(() => {
      const state = (
        window as unknown as {
          canvasCap: {
            over: string[];
            frames: number;
            peak: number;
            run: boolean;
          };
        }
      ).canvasCap;
      state.run = false;
      return state;
    });
    expect(cap.frames).toBeGreaterThan(10);
    expect(cap.over).toEqual([]);
    // Scroll through the whole paper: pages that leave the drawn range keep bitmaps.
    for (let n = 0; n < 200; n++) {
      const end = await w.page.evaluate(() => {
        const body = document.querySelector<HTMLElement>(
          ".reader-engine-body:not([hidden])",
        )!;
        body.scrollTop += body.clientHeight;
        return body.scrollTop >= body.scrollHeight - body.clientHeight - 1;
      });
      // Each screen is drawn before the next, so every page leaves a bitmap.
      await w.page.waitForFunction(() => {
        const body = document.querySelector<HTMLElement>(
          ".reader-engine-body:not([hidden])",
        )!;
        const box = body.getBoundingClientRect();
        return [...body.querySelectorAll<HTMLElement>(".reading-pdf-page")]
          .filter((p) => {
            const r = p.getBoundingClientRect();
            return r.bottom > box.top && r.top < box.bottom;
          })
          .every((p) => p.dataset.picture === "canvas");
      });
      if (end) break;
    }
    await expect
      .poll(async () => (await counts()).bitmapsCreated, { timeout: 15000 })
      .toBeGreaterThan(40);
    const scrolled = await counts();
    // Spec 5.3: at most 40 pages and 48 MB per paper, the farthest evicted.
    expect(scrolled.bitmapsPerPaperPeak).toBeLessThanOrEqual(40);
    expect(scrolled.bitmapBytesPerPaperPeak).toBeLessThanOrEqual(
      48 * 1024 * 1024,
    );
    expect(
      scrolled.bitmapsCreated - scrolled.bitmapsReleased,
    ).toBeLessThanOrEqual(40);
    const kept = await w.page
      .locator(".reading-pdf-page > img.reading-pdf-bitmap")
      .evaluateAll((images) =>
        images.map((img) =>
          Number(
            img.closest<HTMLElement>(".reading-pdf-page")!.dataset.pdfPage,
          ),
        ),
      );
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThanOrEqual(40);
    // At the end of the paper the nearest pages are kept: the first ones were evicted.
    expect(await readerPageNumber(w.page)).toBe(100);
    expect(Math.min(...kept)).toBeGreaterThan(55);
    // No page shows a placeholder where it holds a picture, nor the reverse.
    expect(
      await w.page
        .locator(".reading-pdf-page:not([data-picture]):has(canvas, img)")
        .count(),
    ).toBe(0);
    await w.page
      .getByRole("button", { name: /^关闭文献 / })
      .first()
      .click();
    await expect
      .poll(async () => {
        const c = await counts();
        return {
          workers: c.workersStarted - c.workersTerminated,
          canvases: c.canvasesCreated - c.canvasesReleased,
          bitmaps: c.bitmapsCreated - c.bitmapsReleased,
          urls: c.objectUrlsCreated - c.objectUrlsRevoked,
        };
      })
      .toEqual({ workers: 0, canvases: 0, bitmaps: 0, urls: 0 });
    expect(await w.page.locator(".reading-pdf-page").count()).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);
