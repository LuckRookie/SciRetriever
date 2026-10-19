import { cpus, totalmem } from "node:os";
import { captureReading, recordReading } from "./reading-capture-fixture.js";
import { parseArtifactRef, sha256 } from "@sciretriever/contracts";
import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { workspace, missingId } from "./processor-workspace-fixture.js";
import { markdownBlocks, markdown } from "../src/reading/markdown.js";
import type { Page } from "playwright";

function pdf(pages = 100, text = true, password = false) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /Outlines " + (pages * 2 + 4) + " 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const kids: number[] = [];
  for (let n = 1; n <= pages; n++) {
    const p = objects.length + 1,
      c = p + 1;
    kids.push(p);
    const content = text
      ? `BT /F1 20 Tf 60 740 Td (Synthetic research paper - page ${n}) Tj 0 -40 Td /F1 12 Tf (Page ${n}: reported findings and evidence.) Tj ET`
      : "";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${c} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${pages} >>`;
  const outline = objects.length + 1;
  objects.push(
    `<< /Type /Outlines /First ${outline + 1} 0 R /Last ${outline + 1} 0 R /Count 1 >>`,
    `<< /Title (Results) /Parent ${outline} 0 R /Dest [4 0 R /Fit] >>`,
  );
  let encryption = "";
  if (password) {
    const padding = Buffer.from(
      "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
      "hex",
    );
    const pad = (text: string) =>
      Buffer.concat([Buffer.from(text), padding]).subarray(0, 32);
    const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest();
    const rc4 = (key: Uint8Array, bytes: Uint8Array) => {
      const state = Array.from({ length: 256 }, (_, i) => i);
      let j = 0;
      for (let i = 0; i < 256; i++) {
        j = (j + state[i]! + key[i % key.length]!) % 256;
        [state[i], state[j]] = [state[j]!, state[i]!];
      }
      let i = 0;
      j = 0;
      return Buffer.from(
        bytes.map((value) => {
          i = (i + 1) % 256;
          j = (j + state[i]!) % 256;
          [state[i], state[j]] = [state[j]!, state[i]!];
          return value ^ state[(state[i]! + state[j]!) % 256]!;
        }),
      );
    };
    const owner = rc4(md5(pad("owner")).subarray(0, 5), pad("reader")),
      file = md5(Buffer.from("synthetic-locked-pdf")),
      permissions = Buffer.alloc(4);
    permissions.writeInt32LE(-4);
    const key = md5(
        Buffer.concat([pad("reader"), owner, permissions, file]),
      ).subarray(0, 5),
      user = rc4(key, padding);
    objects.push(
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString("hex")}> /U <${user.toString("hex")}> /P -4 >>`,
    );
    encryption = ` /Encrypt ${objects.length} 0 R /ID [<${file.toString("hex")}> <${file.toString("hex")}>]`;
  }
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryption} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}
async function ready(page: Page) {
  try {
    await page.waitForFunction(() => {
      const root = document.querySelector(".workspace-page:not([hidden])");
      const page = root?.querySelector<HTMLInputElement>("#reader-page")?.value;
      return (
        !!page &&
        !!root?.querySelector(`[data-pdf-page="${page}"][data-rendered="true"]`)
      );
    });
  } catch (cause) {
    throw new Error(
      `PDF did not render: ${await page.locator("#reader-status").textContent()}`,
      { cause },
    );
  }
}
async function resourceCounts(page: Page) {
  return page.evaluate(() => {
    const counts = (
      window as unknown as { readingCounts: { workers: number; urls: number } }
    ).readingCounts;
    return {
      ...counts,
      canvases: document.querySelectorAll(".reading-pdf-page canvas").length,
    };
  });
}
async function trackResources(page: Page) {
  await page.addInitScript(() => {
    const counts = { workers: 0, urls: 0 };
    Object.assign(window, { readingCounts: counts });
    const Native = window.Worker;
    window.Worker = class extends Native {
      closed = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        counts.workers++;
      }
      override terminate() {
        if (!this.closed) counts.workers--;
        this.closed = true;
        super.terminate();
      }
    };
    const create = URL.createObjectURL,
      revoke = URL.revokeObjectURL,
      urls = new Set<string>();
    URL.createObjectURL = (data) => {
      const url = create(data);
      urls.add(url);
      counts.urls = urls.size;
      return url;
    };
    URL.revokeObjectURL = (url) => {
      urls.delete(url);
      counts.urls = urls.size;
      revoke(url);
    };
  });
}
it("reads a 100 page PDF with bounded rendering, restores per-paper page/zoom over ten switches and releases workers and URLs", async () => {
  const w = await workspace(true, async (env) => {
    await env.app.maintenance!.ingestPdf({
      literature_id: missingId,
      bytes: pdf(),
    });
  });
  try {
    await trackResources(w.page);
    await w.page.reload();
    const counts = {
      parser: w.env.parseCalls,
      model: w.env.modelCalls,
      jobs: (await w.env.app.jobs!.listJobs(20)).length,
    };
    const requests: string[] = [];
    w.page.on("request", (r) => requests.push(r.url()));
    const timing = {
      cold: Date.now(),
      warm: [] as number[],
      page: 0,
      zoom: 0,
      find: 0,
    };
    await w.page.locator(`.prow[data-id="${missingId}"]`).click();
    await ready(w.page);
    timing.cold = Date.now() - timing.cold;
    const phases = await w.page.evaluate(() =>
      Object.fromEntries(
        ["read-verify", "parse", "first-paint"].map((phase) => [
          phase,
          performance.getEntriesByName(`sciretriever-pdf-${phase}`).at(-1)
            ?.duration ?? null,
        ]),
      ),
    );

    expect(await w.page.locator("#reader-page-count").textContent()).toBe(
      "/ 100",
    );
    await captureReading(w.page, "pdf");
    expect((await resourceCounts(w.page)).workers).toBe(1);
    expect((await resourceCounts(w.page)).canvases).toBeLessThanOrEqual(4);
    timing.page = Date.now();
    await w.page.locator("#reader-page:visible").fill("50");
    await w.page.locator("#reader-page:visible").press("Enter");
    await w.page
      .locator('[data-pdf-page="50"][data-rendered="true"]')
      .waitFor();
    timing.page = Date.now() - timing.page;
    timing.zoom = Date.now();
    await w.page.locator("#reader-zoom:visible").selectOption("1.25");
    await expect
      .poll(() =>
        w.page
          .locator('.reading-pdf-page[data-rendered="true"] .textLayer')
          .allTextContents(),
      )
      .toContainEqual(expect.stringContaining("page 50"));
    await w.page
      .locator('[data-pdf-page="50"][data-rendered="true"]')
      .waitFor();
    timing.zoom = Date.now() - timing.zoom;
    await w.page.locator("#reader-find-toggle").click();
    await w.page.locator("#reader-find-query").fill("page 89");
    timing.find = Date.now();
    await w.page.locator("#reader-find-query").press("Enter");
    await expect
      .poll(() => w.page.locator("#reader-page:visible").inputValue())
      .toBe("89");
    await w.page
      .locator('[data-pdf-page="89"][data-rendered="true"]')
      .waitFor();
    timing.find = Date.now() - timing.find;
    await w.page.locator("#reader-outline-toggle").click();
    await w.page
      .locator("#reader-outline")
      .getByRole("button", { name: "Results" })
      .click();
    await expect
      .poll(() => w.page.locator("#reader-page:visible").inputValue())
      .toBe("1");
    await w.page.locator("#reader-page:visible").fill("50");
    // The scroll notification from a preceding navigation can arrive while
    // the user edits the page number, before blur commits their new target.
    await w.page.evaluate(async () => {
      document
        .querySelector(".workspace-page:not([hidden]) .reading-scroll")!
        .dispatchEvent(new Event("scroll"));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    expect(await w.page.locator("#reader-page:visible").inputValue()).toBe(
      "50",
    );
    await w.page.locator("#reader-page:visible").press("Tab");
    await w.page.locator("[data-module]").first().click();
    await w.page
      .locator(`.prow[data-id="${w.env.parseRequest.literature_id}"]`)
      .click();
    await ready(w.page);
    for (let i = 0; i < 10; i++) {
      const begin = Date.now();
      await w.page.locator(`[data-paper="${missingId}"]`).click();
      await ready(w.page);
      timing.warm.push(Date.now() - begin);
      expect(await w.page.locator("#reader-page:visible").inputValue()).toBe(
        "50",
      );
      expect(await w.page.locator("#reader-zoom:visible").inputValue()).toBe(
        "1.25",
      );
      expect((await resourceCounts(w.page)).workers).toBe(1);
      expect((await resourceCounts(w.page)).canvases).toBeLessThanOrEqual(4);
      await w.page
        .locator(`[data-paper="${w.env.parseRequest.literature_id}"]`)
        .click();
      await ready(w.page);
      expect(await w.page.locator("#reader-page:visible").inputValue()).toBe(
        "1",
      );
    }
    await w.page.locator("[data-close-tab]").first().click();
    await w.page.locator("[data-close-tab]").first().click();
    await expect
      .poll(() => resourceCounts(w.page))
      .toEqual({ workers: 0, urls: 0, canvases: 0 });
    await recordReading("pdf-performance", {
      timing,
      phases,
      bytes: pdf().length,
      sha256: await sha256(pdf()),
      cpu: cpus()[0]?.model,
      memory: totalmem(),
      chromium: w.page.context().browser()?.version(),
      viewport: w.page.viewportSize(),
      resources: await resourceCounts(w.page),
    });
    expect(w.env.parseCalls).toBe(counts.parser);
    expect(w.env.modelCalls).toBe(counts.model);
    expect((await w.env.app.jobs!.listJobs(20)).length).toBe(counts.jobs);
    expect(
      requests.every(
        (url) => new URL(url).origin === new URL(w.page.url()).origin,
      ),
    ).toBe(true);
    expect(w.errors).toEqual([]);
  } finally {
    await w.page.unrouteAll({ behavior: "wait" });
    await w.close();
  }
}, 120000);

it("progressively typesets fixed Markdown with Unicode, tables and safe math, restores position and isolates malicious/missing resources", async () => {
  const source =
    '# Original 文献🙂\r\n\r\nText with $E=mc^2$.\r\n\r\n| Sample | Value |\r\n|---|---|\r\n| A | 4.2 eV |\r\n\r\n$$\r\nE = mc^2\r\n$$\r\n\r\n<span onclick="window.attacked=true">unsafe HTML</span>\r\n\r\n[unsafe](javascript:alert(1)) ![image](valid.png) ![missing](missing.png)\r\n\r\n' +
    Array.from(
      { length: 160 },
      (_, i) =>
        `## Section ${i}\r\n\r\nParagraph ${i} 中文 α🙂 and a reported observation.\r\n\r\n`,
    ).join("");
  const w = await workspace(true, async (env) => {
    env.setText(source);
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=",
      "base64",
    );
    const hash = await sha256(bytes);
    env.setResources(
      ["valid.png", "missing.png"].map((reference) => ({
        reference,
        content: {
          bytes,
          artifact: parseArtifactRef({
            sha256: hash,
            byte_size: bytes.length,
            media_type: "image/png",
          }),
        },
      })),
    );
  });
  try {
    const requests: string[] = [];
    w.page.on("request", (r) => requests.push(r.url()));
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
            contentType: "application/json",
            body: JSON.stringify({ reason: "synthetic-resource-unavailable" }),
          });
        else await route.fulfill({ response });
      },
    );
    await w.page
      .locator(`.prow[data-id="${w.env.parseRequest.literature_id}"]`)
      .click();
    await w.page.locator('[data-rm="doc"]').click();
    await w.page.locator(".reading-article table").waitFor();
    expect(await w.page.locator(".reading-article .katex").count()).toBe(2);
    expect(
      await w.page.locator(".reading-article table").textContent(),
    ).toContain("4.2 eV");
    await w.page.locator(".reading-article img").waitFor();
    expect(
      await w.page.locator(".reading-article img").getAttribute("src"),
    ).toMatch(/^blob:/);
    expect(
      await w.page.locator('.reading-article a[href^="javascript:"]').count(),
    ).toBe(0);
    await expect
      .poll(() =>
        w.page
          .locator('.reading-resource[data-resource="missing.png"]')
          .textContent(),
      )
      .toContain("暂不可读");
    expect(await w.page.locator("#reader-status").textContent()).toContain(
      "已加载部分正文",
    );
    await captureReading(w.page, "document");
    await w.page.locator("#reader-outline-toggle").click();
    let releaseSlice!: () => void, startedSlice!: () => void;
    const sliceGate = new Promise<void>((resolve) => {
      releaseSlice = resolve;
    });
    const sliceStarted = new Promise<void>((resolve) => {
      startedSlice = resolve;
    });
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/document-slice",
      async (route) => {
        startedSlice();
        await sliceGate;
        await route.continue();
      },
    );
    await w.page
      .locator("#reader-outline")
      .getByRole("button", { name: "Section 20", exact: true })
      .click();
    await sliceStarted;
    try {
      await w.page
        .locator("#reader-outline")
        .getByRole("button", { name: "Section 60", exact: true })
        .click();
    } finally {
      releaseSlice();
    }

    await expect
      .poll(() => w.page.locator(".reading-article").textContent(), {
        timeout: 10000,
      })
      .toContain("Paragraph 60");
    await expect
      .poll(
        () =>
          w.page
            .locator(".reading-article h2")
            .filter({ hasText: /^Section 60$/ })
            .evaluate((el) =>
              Math.abs(
                el.getBoundingClientRect().top -
                  document
                    .querySelector("#reader-body")!
                    .getBoundingClientRect().top,
              ),
            ),
        { timeout: 10000 },
      )
      .toBeLessThan(60);
    await w.page.locator("#reader-font-size").selectOption("24");
    await w.page.locator("#reader-measure").selectOption("wide");
    const top = await w.page
      .locator("#reader-body")
      .evaluate((el) => el.scrollTop);
    await w.page.locator("[data-module]").first().click();
    await w.page
      .locator(`[data-paper="${w.env.parseRequest.literature_id}"]`)
      .click();
    await w.page.locator(".reading-article").waitFor();
    await expect
      .poll(() => w.page.locator(".reading-article").textContent(), {
        timeout: 10000,
      })
      .toContain("Paragraph 60");
    await expect
      .poll(() => w.page.locator("#reader-find-toggle").isEnabled(), {
        timeout: 10000,
      })
      .toBe(true);
    expect(await w.page.locator("#reader-font-size").inputValue()).toBe("24");
    expect(
      Math.abs(
        (await w.page.locator("#reader-body").evaluate((el) => el.scrollTop)) -
          top,
      ),
    ).toBeLessThan(80);
    await w.page.locator("#reader-find-toggle").click();
    await w.page.locator("#reader-find-query").fill("Paragraph 60");
    await w.page.locator("#reader-find-query").press("Enter");
    expect(await w.page.locator("#reader-find-status").textContent()).toContain(
      "已加载范围",
    );
    expect(
      requests.every(
        (url) => new URL(url).origin === new URL(w.page.url()).origin,
      ),
    ).toBe(true);
    expect(w.env.parseCalls).toBe(1);
    expect(w.env.modelCalls).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.page.unrouteAll({ behavior: "wait" });
    await w.close();
  }
}, 90000);
it("maps normalized Markdown blocks back to original UTF-8 boundaries including CRLF and non-BMP text", () => {
  const text = "# 标题🙂\r\n\r\nαβ content.\r\n";
  const blocks = markdownBlocks(text),
    bytes = Buffer.from(text);
  expect(bytes.subarray(blocks[0]!.start, blocks[0]!.end).toString()).toBe(
    "# 标题🙂",
  );
  const paragraph = blocks.find((b) => b.token.type === "paragraph")!;
  expect(paragraph.start).toBe(bytes.indexOf(Buffer.from("αβ")));
  expect(
    bytes.subarray(paragraph.start, paragraph.end).toString().trimEnd(),
  ).toBe("αβ content.");
  const unsafe = markdown.parse(
    '<img src="https://example.invalid/tracker" onerror="alert(1)"> [x](javascript:alert(1)) ![x](https://example.invalid/image)',
    { async: false },
  );
  expect(unsafe).not.toMatch(/<img|href="javascript:/);
  expect(unsafe).toContain("&lt;img");
});

it("explains scan-only and invalid PDFs and cancels a late original-byte read without replacing the active document", async () => {
  const w = await workspace(true, async (env) => {
    await env.app.maintenance!.ingestPdf({
      literature_id: missingId,
      bytes: pdf(1, false),
    });
  });
  try {
    await w.page.locator(`.prow[data-id="${missingId}"]`).click();
    await ready(w.page);
    await w.page.locator("#reader-find-toggle").click();
    await w.page.locator("#reader-find-query").fill("observation");
    await w.page.locator("#reader-find-query").press("Enter");
    await expect
      .poll(() => w.page.locator("#reader-find-status").textContent())
      .toContain("没有可检索文字层");
    await w.page.locator("[data-module]").click();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedRead = new Promise<void>((resolve) => {
      started = resolve;
    });
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/material-bytes",
      async (route) => {
        const response = await route.fetch();
        started();
        await gate;
        await route.fulfill({ response });
      },
    );
    await w.page.locator(`[data-paper="${missingId}"]`).click();
    await startedRead;
    await w.page.locator("[data-module]").click();
    release();
    await w.page.unrouteAll({ behavior: "wait" });
    expect(await w.page.locator(".reading-pdf-page canvas").count()).toBe(0);
    await expect.poll(() => w.page.locator(".prow").count()).toBeGreaterThan(0);
    await w.page.route(
      (url) => url.pathname === "/api/v1/query/material-bytes",
      async (route) => {
        const response = await route.fetch();
        const body = await response.body();
        body[body.length - 1] = body[body.length - 1]! ^ 1;
        await route.fulfill({ response, body });
      },
    );
    await w.page.locator(`[data-paper="${missingId}"]`).click();
    await expect
      .poll(() => w.page.locator("#reader-status:visible").textContent())
      .toContain("PDF 完整性校验失败");
    expect(await w.page.locator(".reading-pdf-page canvas").count()).toBe(0);
    expect(w.errors).toEqual([]);
    expect(w.env.modelCalls).toBe(0);
    expect(w.env.parseCalls).toBe(1);
  } finally {
    await w.page.unrouteAll({ behavior: "wait" });
    await w.close();
  }
}, 60000);

it("rejects encrypted PDFs at the existing ingestion boundary and does not present an unaccepted asset", async () => {
  const w = await workspace(true, async (env) => {
    await expect(
      env.app.maintenance!.ingestPdf({
        literature_id: missingId,
        bytes: pdf(1, false, true),
      }),
    ).rejects.toThrow("pdf acceptance failed");
    expect((await env.app.library.detail(missingId)).primary_pdf).toBeNull();
  });
  try {
    await w.page.locator(`.prow[data-id="${missingId}"]`).click();
    await expect
      .poll(() => w.page.locator("#reader-status").textContent())
      .toContain("尚无 PDF");
    expect(await w.page.locator("canvas").count()).toBe(0);
    expect(w.errors).toEqual([]);
    expect(w.env.modelCalls).toBe(0);
  } finally {
    await w.close();
  }
}, 45000);
it("reports a failed PDF worker and keeps the verified original download available", async () => {
  const w = await workspace();
  try {
    await w.page.route("**/reader/pdf.worker.mjs", (route) => route.abort());
    await w.page
      .locator(`.prow[data-id="${w.env.parseRequest.literature_id}"]`)
      .click();
    await expect
      .poll(() => w.page.locator("#reader-status").textContent())
      .toContain("阅读组件未能加载");
    expect(
      await w.page
        .getByRole("link", { name: "下载已核验的原始 PDF" })
        .getAttribute("href"),
    ).toMatch(/^blob:/);
    await w.page.unrouteAll({ behavior: "wait" });
    await w.page
      .locator("#reader-body")
      .getByRole("button", { name: "重试", exact: true })
      .click();
    await ready(w.page);
    expect(w.errors).toEqual([]);
    expect(w.env.parseCalls).toBe(1);
    expect(w.env.modelCalls).toBe(0);
  } finally {
    await w.page.unrouteAll({ behavior: "wait" });
    await w.close();
  }
}, 45000);
