import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import {
  parseAsset,
  parseLiterature,
  parseProvenance,
  sha256,
} from "@sciretriever/contracts";
import { createApplication } from "../../server/src/bootstrap/application.js";
import { migrateDocumentCatalog } from "../../server/src/storage/sqlite/document-migration.js";
import { TypeScriptParserArtifactRules } from "../../server/src/parsing/artifact-rules.js";
import type { ParserBackend } from "../../server/src/parsing/ports.js";
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
  const result = new Map<string, WorkbenchStaticAsset>();
  for (const [route, file, contentType] of [
    ["/", "maintenance.html", "text/html"],
    ["/query", "query.html", "text/html"],
    ["/styles.css", "styles.css", "text/css"],
    ["/live.css", "live.css", "text/css"],
  ] as const)
    result.set(route, {
      contentType,
      body: await readFile(new URL(`../public/${file}`, import.meta.url)),
    });
  for (const [route, file] of [
    ["/maintenance.js", "maintenance.ts"],
    ["/query.js", "query.ts"],
  ] as const) {
    const bundle = await build({
      entryPoints: [new URL(`../src/${file}`, import.meta.url).pathname],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
    });
    result.set(route, {
      contentType: "text/javascript",
      body: bundle.outputFiles[0]!.contents,
    });
  }
  return result;
}

it("selects the current Library PDF and validates a published Document receipt in Chromium", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-document-web-"));
  const id = (n: number) =>
    `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  let app = await createApplication(home, {
    executionSchema: "upgrade-synthetic",
  });
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
    await migrateDocumentCatalog({
      catalog_path: join(home, "catalog.sqlite"),
      backup_path: join(home, "before.sqlite"),
    });
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
    const seeded = await app.documentProcessing.parseDocuments({
      literature_id: FIXTURE_LITERATURE.literature_id,
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
      mode: "reparse",
      expected_default_revision: null,
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
    const page = await browser.newPage();
    await page.goto(workbench.origin);
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
    await page.locator("#extraction-caller").fill("local.browser");
    await page.locator("#extraction-prepared").fill(
      JSON.stringify({
        spec: { spec_id: "synthetic" },
        manifest: { items: [] },
      }),
    );
    await page.locator("#extraction-create").click();
    await expect
      .poll(() => page.locator("#extraction-status").textContent())
      .toContain("请求失败");
    expect(await page.locator("#extraction-operation-id").inputValue()).toBe(
      "",
    );
    await page.locator("#extraction-receipt-id").fill("synthetic-receipt");
    await page.locator("#extraction-receipt").click();
    await expect
      .poll(() => page.locator("#extraction-status").textContent())
      .toContain("请求失败");
    expect(await page.locator("#extraction-result").textContent()).toBe("");
    await page
      .locator("#document-literature-id")
      .fill(FIXTURE_LITERATURE.literature_id);
    await page.locator("#document-load-material").click();
    await expect
      .poll(() => page.locator("#document-material-status").textContent())
      .toContain("已选择当前 PDF");
    await expect
      .poll(() => page.locator("#document-asset-id").inputValue())
      .toBe(asset.asset_id);
    await expect
      .poll(() => page.locator("#document-asset-sha256").inputValue())
      .toBe(asset.sha256);
    await expect
      .poll(() => page.locator("#document-default-revision").inputValue())
      .toBe("1");
    await page.locator("#document-parse-submit").click();
    await expect
      .poll(() => page.locator("#document-parse-status").textContent())
      .toContain(seeded.document.document_version_id);
    await expect
      .poll(() => page.locator("#document-parse-status").textContent())
      .toContain("已存在");
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
    await page.locator("#document-parse-submit").click();
    await expect
      .poll(() => page.locator("#document-parse-status").textContent())
      .toContain("发布回执无效");
  } finally {
    await browser?.close();
    await workbench?.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

it("accepts a selected PDF in Chromium, reads the same fact, and reports rejection and conflict", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-maintenance-web-"));
  const application = await createApplication(home, {
    executionSchema: "upgrade-synthetic",
  });
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
    const page = await browser.newPage();
    await page.goto(workbench.origin);
    await page
      .locator("#manual-pdf-literature-id")
      .fill(FIXTURE_LITERATURE.literature_id);
    await page.locator("#manual-pdf-file").setInputFiles({
      name: "wrong.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("<html>Not a PDF</html>"),
    });
    await page.locator("#manual-pdf-submit").click();
    await expect
      .poll(() => page.locator("#manual-pdf-status").textContent())
      .toContain("manual-pdf-invalid");
    expect(
      (
        await workbench.application.library.detail(
          FIXTURE_LITERATURE.literature_id,
        )
      ).primary_pdf,
    ).toBeNull();

    await page.locator("#manual-pdf-file").setInputFiles({
      name: "paper.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(workbenchPdf("", "", false)),
    });
    await page.locator("#manual-pdf-submit").click();
    await expect
      .poll(() => page.locator("#manual-pdf-status").textContent())
      .toContain("PDF 已接纳");
    await page.locator('a[href="/query"]').first().click();
    expect(new URL(page.url()).pathname).toBe("/query");
    await expect
      .poll(() => page.locator("#library-status").textContent())
      .toContain("找到 1 篇文献");
    await page.locator("#library-query").fill("Synthetic literature workbench");
    await page.locator("#library-form button[type=submit]").click();
    await page.locator(".library-result").first().click();
    await expect
      .poll(() => page.locator("#library-detail").textContent())
      .toContain("下载 PDF");
    await expect
      .poll(() => page.locator("#library-detail").textContent())
      .toContain("文章身份未验证");
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

    await page.goto(workbench.origin);
    await page
      .locator("#manual-pdf-literature-id")
      .fill(FIXTURE_LITERATURE.literature_id);
    await page.locator("#manual-pdf-file").setInputFiles({
      name: "paper.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(workbenchPdf("", "", false)),
    });
    await page.locator("#manual-pdf-submit").click();
    await expect
      .poll(() => page.locator("#manual-pdf-status").textContent())
      .toContain("primary-asset-conflict");

    const queryAssets = await assets();
    queryAssets.set("/", queryAssets.get("/query")!);
    queryAssets.delete("/query");
    queryAssets.delete("/maintenance.js");
    const queryOnly = await startQueryOnlyWorkbench({
      home,
      assets: queryAssets,
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
});
