import { showAllLibraryStatuses } from "./next-workspace-fixture.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  independentNextAssets,
  motionOptions,
} from "./next-workspace-fixture.js";
import { readingAssets } from "./reading-assets-fixture.js";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import {
  parseAsset,
  parseLiterature,
  parseProvenance,
  sha256,
} from "@sciretriever/contracts";
import { createParserFixtureApplication as createApplication } from "../../server/test/parser-application-fixture.js";
import { TypeScriptParserArtifactRules } from "../../server/src/parsing/artifact-rules.js";
import type { ParserBackend } from "../../server/test/parser-fixture-types.js";
import {
  startMaintenanceWorkbench,
  startQueryOnlyWorkbench,
} from "../../server/src/bootstrap/workbench.js";
import type { WorkbenchStaticAsset } from "../../server/src/workbench/http.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../../server/src/workbench/synthetic-fixture.js";

async function assets(): Promise<Map<string, WorkbenchStaticAsset>> {
  return new Map([
    ...(await readingAssets()),
    ...(await independentNextAssets("maintenance")),
  ]);
}
async function confirm(page: import("playwright").Page, label: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: label, exact: true })
    .click();
}

it("selects the current Library PDF and validates the raw parsing receipt in Chromium", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-document-web-"));
  const id = (n: number) =>
    `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  let app = await createApplication(home, {});
  let workbench:
    | Awaited<ReturnType<typeof startMaintenanceWorkbench>>
    | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await app.database.putLiterature(parseLiterature(FIXTURE_LITERATURE));
    const pdf = workbenchPdf();
    const stage = await app.files.stage();
    await stage.write(pdf);
    await app.files.publish(stage, "objects/document-web.pdf");
    const asset = parseAsset({
      asset_id: id(801),
      sha256: await sha256(pdf),
      size_bytes: pdf.length,
      media_type: "application/pdf",
      path: "objects/document-web.pdf",
    });
    await app.database.putLiteratureAsset({
      literature_asset_id: id(802),
      literature_id: FIXTURE_LITERATURE.literature_id,
      asset,
      role: "primary-pdf",
      source_url: null,
      provenance: parseProvenance({
        provenance_id: id(803),
        source_kind: "asset-provider",
        source_name: "fixture",
        source_record_id: null,
        observed_at: "2026-09-29T00:00:00Z",
        input_sha256: asset.sha256,
        parameters_sha256: null,
      }),
    });
    await app.close();
    const backend: ParserBackend = {
      parse: async (request) => {
        const markdown = Buffer.from("# Title\nEvidence text\n");
        return {
          source_asset_id: request.source_asset_id,
          source_sha256: request.source_sha256,
          page_count: 1,
          markdown: {
            artifact: {
              sha256: await sha256(markdown),
              byte_size: markdown.length,
              media_type: "text/markdown",
            },
            bytes: markdown,
          },
          resources: [],
          provenance: {
            provenance: parseProvenance({
              provenance_id: id(804),
              source_kind: "parser",
              source_name: "fixture",
              source_record_id: null,
              observed_at: "2026-09-29T00:00:00Z",
              input_sha256: request.source_sha256,
              parameters_sha256: "a".repeat(64),
            }),
            parser_version: "fixture-1",
            mode: null,
            model_identity: null,
          },
        };
      },
    };
    app = await createApplication(home, {
      parsing: { parser: backend, rules: new TypeScriptParserArtifactRules() },
    });
    await app.documentProcessing.parseDocuments({
      literature_id: FIXTURE_LITERATURE.literature_id,
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
      force: true,
    });
    await app.close();
    workbench = await startMaintenanceWorkbench({
      home,
      assets: await assets(),
    });
    browser = await chromium.launch({
      executablePath:
        process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
        chromium.executablePath(),
      headless: true,
    });
    const page = await browser.newPage(motionOptions());
    await page.goto(`${workbench.origin}/?view=set`);
    await page.route(
      "**/api/v1/maintenance/extraction-operation",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            protocol_version: 1,
            result: {
              operation_id: "synthetic-operation",
              status: "open",
            },
          }),
        });
      },
    );
    await page.route(
      "**/api/v1/maintenance/extraction-receipt",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            protocol_version: 1,
            result: {
              receipt_id: "synthetic-receipt",
              protected_materials: [],
            },
          }),
        });
      },
    );
    await page.getByRole("tab", { name: "规范与交付", exact: true }).click();
    await page
      .getByLabel("调用方 namespace", { exact: true })
      .fill("local.browser");
    await page.getByLabel("输入准备结果 JSON", { exact: true }).fill(
      JSON.stringify({
        spec: { spec_id: "synthetic" },
        manifest: { items: [] },
      }),
    );
    await confirm(page, "创建 operation");
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("请求失败");
    expect(
      await page.getByLabel("Operation ID", { exact: true }).inputValue(),
    ).toBe("");
    await page
      .getByLabel("Receipt ID", { exact: true })
      .fill("synthetic-receipt");
    await page
      .getByRole("button", { name: "读取回执与保护", exact: true })
      .click();
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("请求失败");
    expect(await page.getByTestId("delivery-result").count()).toBe(0);
    await page.getByRole("tab", { name: "材料与分析", exact: true }).click();
    await page
      .getByLabel("文献编号", { exact: true })
      .fill(FIXTURE_LITERATURE.literature_id);
    await page
      .getByRole("button", { name: "从文献库读取当前 PDF", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .getByRole("status")
          .filter({ hasText: "已选择当前 PDF" })
          .textContent(),
      )
      .toContain("已选择当前 PDF");
    await page.getByRole("button", { name: "技术详情", exact: true }).click();
    expect(await page.locator(".maintenance-grid").innerText()).toContain(
      asset.asset_id,
    );
    expect(await page.locator(".maintenance-grid").innerText()).toContain(
      asset.sha256,
    );
    expect(await page.locator(".maintenance-grid").innerText()).not.toContain(
      "默认版本：",
    );
    await page.route("**/api/v1/maintenance/parse-document", async (route) => {
      const request = route.request().postDataJSON();
      expect(request).toMatchObject({
        force: false,
      });
      expect(request).not.toHaveProperty("profiles");
      expect(request).not.toHaveProperty("expected_default_revision");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          protocol_version: 1,
          receipt: {
            literature_id: FIXTURE_LITERATURE.literature_id,
            asset_id: asset.asset_id,
            asset_sha256: asset.sha256,
            profiles: [
              {
                profile: "vlm-engine",
                status: "published",
                raw_parse_id: id(805),
                result_sha256: "a".repeat(64),
                failure_code: null,
                failure_source_type: null,
              },
            ],
            draft: {
              status: "failed",
              raw_parse_id: id(805),
              failure_code: "page-tools-unavailable",
            },
          },
        }),
      });
    });
    await confirm(page, "解析 PDF");
    await expect
      .poll(() => page.getByRole("status").allTextContents())
      .toContainEqual(expect.stringContaining("vlm-engine"));
    await page
      .locator(".maintenance-output")
      .getByRole("button", { name: "技术详情", exact: true })
      .click();
    expect(await page.locator(".maintenance-output").innerText()).toContain(
      "raw_parse_id",
    );
    expect(await page.locator(".maintenance-output").innerText()).toContain(
      '"status": "published"',
    );
    await page.route("**/api/v1/maintenance/parse-document", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          protocol_version: 1,
          receipt: {
            document: { document_version_id: "invalid" },
            default_updated: true,
          },
        }),
      });
    });
    await confirm(page, "解析 PDF");
    await expect.poll(() => page.getByRole("alert").textContent()).toBeTruthy();
  } finally {
    await browser?.close();
    await workbench?.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 90000);

it("accepts a selected PDF in Chromium, reads the same fact, and reports rejection and conflict", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-maintenance-web-"));
  const application = await createApplication(home, {});
  await application.database.putLiterature(parseLiterature(FIXTURE_LITERATURE));
  await application.close();
  const workbench = await startMaintenanceWorkbench({
    home,
    assets: await assets(),
  });
  const browser = await chromium.launch({
    executablePath:
      process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ?? chromium.executablePath(),
    headless: true,
  });
  try {
    const page = await browser.newPage(motionOptions());
    // The independent maintenance entry has no intake routes: it keeps its own.
    const routes: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/ingest-pdf") || path.includes("/intake/"))
        routes.push(path);
    });
    await page.goto(`${workbench.origin}/?view=set`);
    await page
      .getByLabel("文献编号", { exact: true })
      .fill(FIXTURE_LITERATURE.literature_id);
    await page.locator("#maintenance-pdf").setInputFiles({
      name: "wrong.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("<html>Not a PDF</html>"),
    });
    await confirm(page, "接纳 PDF");
    await expect
      .poll(() => page.getByRole("alert").textContent())
      .toContain("有效的 PDF");
    expect(
      (
        await workbench.application.library.detail(
          FIXTURE_LITERATURE.literature_id,
        )
      ).primary_pdf,
    ).toBeNull();

    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await page.locator("#maintenance-pdf").setInputFiles({
      name: "paper.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(workbenchPdf("", "", false)),
    });
    await confirm(page, "接纳 PDF");
    await expect
      .poll(() => page.locator(".maintenance-grid").textContent())
      .toContain("PDF 已接纳");
    expect(new Set(routes)).toEqual(
      new Set(["/api/v1/maintenance/ingest-pdf"]),
    );
    await page.goto(`${workbench.origin}/query`);
    await showAllLibraryStatuses(page);
    expect(new URL(page.url()).pathname).toBe("/query");
    await page
      .getByRole("article", {
        name: "Synthetic literature workbench",
        exact: true,
      })
      .waitFor();
    await page
      .getByRole("article", {
        name: "Synthetic literature workbench",
        exact: true,
      })
      .locator(".paper-open")
      .click();
    // A paper with text opens its full text (spec 6.4); this check reads the PDF.
    await page.getByRole("tab", { name: "PDF", exact: true }).click();
    await page
      .locator('.reading-pdf-page[data-rendered="true"]')
      .first()
      .waitFor();
    expect(await page.locator(".reader-steps").innerText()).toMatch(
      /尚未核对这份 PDF 是否就是这篇文章/u,
    );
    const read = await page.evaluate(async (literatureId) => {
      const response = await fetch("/api/v1/query/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: 1,
          request: { literature_id: literatureId },
        }),
      });
      return response.json() as Promise<{
        detail: { primary_pdf: { asset: { sha256: string } } };
      }>;
    }, FIXTURE_LITERATURE.literature_id);
    expect(read.detail.primary_pdf.asset.sha256).toBe(
      await sha256(workbenchPdf("", "", false)),
    );

    await page.goto(`${workbench.origin}/?view=set`);
    await page
      .getByLabel("文献编号", { exact: true })
      .fill(FIXTURE_LITERATURE.literature_id);
    await page.locator("#maintenance-pdf").setInputFiles({
      name: "paper.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(workbenchPdf("", "", false)),
    });
    await confirm(page, "接纳 PDF");
    await expect
      .poll(() => page.getByRole("alert").textContent())
      .toContain("已有主 PDF");

    const queryOnly = await startQueryOnlyWorkbench({
      home,
      assets: await independentNextAssets("query"),
    });
    try {
      expect(
        (
          await fetch(`${queryOnly.origin}/api/v1/maintenance/ingest-pdf`, {
            method: "POST",
          })
        ).status,
      ).toBe(404);
    } finally {
      await queryOnly.close();
    }
  } finally {
    await browser.close();
    await workbench.close();
    await rm(home, { recursive: true, force: true });
  }
}, 90000);
