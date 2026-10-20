import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeDesignAudit } from "./design-audit-fixture.js";
import { expect, it } from "vitest";
import { parseArtifactRef, sha256 } from "@sciretriever/contracts";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { missingId } from "./processor-workspace-fixture.js";
import { syntheticReadingPdf } from "./reading-pdf-fixture.js";

type Workspace = Awaited<ReturnType<typeof nextWorkspace>>;
const open = (
  w: Workspace,
  mode = "pdf",
  id: string = w.env.parseRequest.literature_id,
) => w.page.goto(`${w.origin}/?literature=${id}&reader=${mode}`);
const ready = (w: Workspace) =>
  w.page.locator('.reading-pdf-page[data-rendered="true"]').first().waitFor();
const longDocument = Array.from(
  { length: 140 },
  (_, i) =>
    `Paragraph ${i}: a reported measurement with conditions and evidence.\n\n`,
).join("");

it("continues fixed Unicode Markdown without rebuilding stable blocks and recovers a failed continuation", async () => {
  const w = await nextWorkspace({
    ready: "body",
    setup: async (env) => {
      env.setText(
        '# Original 文献🙂\r\n\r\nText with $E=mc^2$.\r\n\r\n| Sample | Value |\r\n|---|---|\r\n| A | 4.2 eV |\r\n\r\n$$\r\nE = mc^2\r\n$$\r\n\r\n<span onclick="window.attacked=true">unsafe HTML</span>\r\n\r\n[unsafe](javascript:alert(1)) ![image](valid.png) ![missing](missing.png)\r\n\r\n' +
          longDocument,
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
        ["valid.png", "missing.png"].map((reference) => ({
          reference,
          content: { bytes, artifact },
        })),
      );
    },
  });
  let reads = 0;
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
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/document-resource",
      async (route) => {
        const response = await route.fetch();
        const value = (await response.json()) as {
          result: { resource: { reference: string } };
        };
        if (value.result.resource.reference === "missing.png")
          await route.fulfill({
            status: 503,
            json: { code: "synthetic-resource-failure" },
          });
        else await route.fulfill({ response });
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
    await article.locator("img").waitFor();
    expect(await article.locator("img").getAttribute("src")).toMatch(/^blob:/);
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
        await w.page.getByRole("button", { name: /阅读字号/ }).click();
        await w.page
          .getByRole("option", { name: `${font} px`, exact: true })
          .click();
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
    await expect
      .poll(() => w.page.locator(".reading-status").innerText())
      .toContain("缺少续读游标");
    expect(await article.locator("[data-preserved=yes]").count()).toBe(1);
    await w.page.getByRole("button", { name: "重试", exact: true }).click();
    await expect.poll(() => reads).toBeGreaterThan(3);
    for (
      let i = 0;
      i < 20 &&
      !(await w.page.locator(".reading-status").innerText()).includes(
        "全文已加载",
      );
      i++
    ) {
      await bottom();
      await expect
        .poll(() => w.page.locator(".reading-continuation").innerText())
        .not.toContain("正在加载");
    }
    await expect.poll(() => article.innerText()).toContain("Paragraph 139:");
    expect(await article.locator("[data-preserved=yes]").count()).toBe(1);
    expect(await w.page.locator(".reading-status").innerText()).toContain(
      "全文已加载",
    );
    expect(w.env.parseCalls).toBe(w.setupCalls.parser);
    expect(w.env.modelCalls).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
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
            { length: 160 },
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
    await w.page.getByRole("button", { name: "显示目录", exact: true }).click();
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
      .getByRole("button", { name: "Section 20", exact: true })
      .click();
    await started;
    await w.page
      .locator(".reader-outline")
      .getByRole("button", { name: "Section 60", exact: true })
      .click();
    release();
    const heading = w.page
      .locator(".reading-article")
      .getByRole("heading", { name: "Section 60", exact: true });
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
        { timeout: 10000 },
      )
      .toBeLessThan(60);
    await w.page.unrouteAll({ behavior: "wait" });
    await w.page.getByRole("button", { name: /阅读字号/ }).click();
    await w.page.getByRole("option", { name: "24 px", exact: true }).click();
    await w.page.getByRole("button", { name: /阅读行宽/ }).click();
    await w.page.getByRole("option", { name: "宽", exact: true }).click();
    await w.page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const body = w.page.locator(".reader-engine-body");
    const top = await body.evaluate((element) => element.scrollTop);
    const tabs = w.page.getByRole("navigation", { name: "工作区与阅读标签" });
    await tabs.getByRole("button", { name: "文献库", exact: true }).click();
    await tabs
      .getByRole("button", {
        name: "Synthetic literature workbench",
        exact: true,
      })
      .click();
    await expect
      .poll(() => w.page.locator(".reading-article").textContent(), {
        timeout: 10000,
      })
      .toContain("Paragraph 60");
    await expect
      .poll(
        () =>
          w.page
            .getByRole("button", { name: "文档内查找", exact: true })
            .isEnabled(),
        { timeout: 10000 },
      )
      .toBe(true);
    expect(
      await w.page.getByRole("button", { name: /阅读字号/ }).textContent(),
    ).toContain("24 px");
    expect(
      await w.page.getByRole("button", { name: /阅读行宽/ }).textContent(),
    ).toContain("宽");
    expect(
      Math.abs((await body.evaluate((element) => element.scrollTop)) - top),
    ).toBeLessThan(80);
    await w.page
      .getByRole("button", { name: "文档内查找", exact: true })
      .click();
    const search = w.page.getByRole("searchbox", {
      name: "文档内查找",
      exact: true,
    });
    await search.fill("Paragraph 60");
    await search.press("Enter");
    expect(
      await w.page.locator(".reader-find [role=status]").textContent(),
    ).toContain("已加载范围");
    expect(await w.page.locator(".reading-match").textContent()).toContain(
      "Paragraph 60",
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
    await w.page
      .getByRole("button", { name: "文档内查找", exact: true })
      .click();
    await w.page
      .getByRole("searchbox", { name: "文档内查找", exact: true })
      .fill("observation");
    await w.page
      .getByRole("searchbox", { name: "文档内查找", exact: true })
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
      .poll(() => w.page.locator(".reading-status").innerText(), {
        timeout: 10000,
      })
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
      ).rejects.toThrow("pdf acceptance failed");
      expect((await env.app.library.detail(missingId)).primary_pdf).toBeNull();
    },
  });
  try {
    await open(w, "pdf", missingId);
    await expect
      .poll(() => w.page.locator(".reading-status").innerText())
      .toContain("尚无 PDF");
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
      .poll(() => w.page.locator(".reading-status").innerText(), {
        timeout: 10000,
      })
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
    await open(w, "doc");
    await w.page.locator(".reading-article").waitFor();
    await w.page.locator(".reader-engine-body").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect.poll(() => reads, { timeout: 10000 }).toBe(2);
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
    await open(w, "doc");
    await w.page.locator(".reading-article").waitFor();
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
    expect(Number(await resize.getAttribute("aria-valuenow"))).toBe(330);
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
      await pdf.press("ArrowRight");
      await w.page.keyboard.press("Enter");
      await w.page.locator(".reading-article").waitFor();
      expect(
        await w.page
          .getByRole("tab", { name: "全文", exact: true })
          .getAttribute("aria-selected"),
      ).toBe("true");
      const more = w.page.getByRole("button", { name: "更多", exact: true });
      await more.focus();
      await more.press("Enter");
      const settings = w.page.getByRole("menuitem", {
        name: "阅读设置",
        exact: true,
      });
      await settings.focus();
      await settings.press("Enter");
      await w.page
        .getByRole("dialog", { name: "阅读设置", exact: true })
        .waitFor();
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
