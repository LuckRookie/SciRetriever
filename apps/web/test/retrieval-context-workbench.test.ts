import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { createApplication } from "../../server/src/bootstrap/application.js";
import { startMaintenanceWorkbench } from "../../server/src/bootstrap/workbench.js";
import { migrateDocumentCatalog } from "../../server/src/storage/sqlite/document-migration.js";
import { migrateRetrievalCatalog } from "../../server/src/storage/sqlite/retrieval-migration.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";
import { workbenchPdf } from "../../server/src/workbench/synthetic-fixture.js";
import {
  parseAsset,
  parseProvenance,
  sha256,
  type ArtifactRef,
} from "@sciretriever/contracts";
import { TypeScriptParserArtifactRules } from "../../server/src/parsing/artifact-rules.js";
import type { ParserBackend } from "../../server/src/parsing/ports.js";
import type { WorkbenchStaticAsset } from "../../server/src/workbench/http.js";

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

it("rebuilds the v4 index explicitly and searches Context in the real browser pages", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-context-web-"));
  const catalog = join(home, "catalog.sqlite");
  const app = await createApplication(home, {
    executionSchema: "upgrade-synthetic",
  });
  let web: Awaited<ReturnType<typeof startMaintenanceWorkbench>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await app.database.putLiterature(FIXTURE_LITERATURE);
    await app.close();
    await migrateDocumentCatalog({
      catalog_path: catalog,
      backup_path: join(home, "before-v3.sqlite"),
    });
    await migrateRetrievalCatalog({
      catalog_path: catalog,
      backup_path: join(home, "before-v4.sqlite"),
    });
    const markdown = Buffer.from("# Results\nSynthetic evidence paragraph.\n");
    const parser: ParserBackend = {
      parse: async (input) => ({
        source_asset_id: input.source_asset_id,
        source_sha256: input.source_sha256,
        page_count: 1,
        markdown: {
          artifact: {
            sha256: createHash("sha256")
              .update(markdown)
              .digest("hex") as ArtifactRef["sha256"],
            byte_size: markdown.length,
            media_type: "text/markdown",
          },
          bytes: markdown,
        },
        resources: [],
        provenance: {
          provenance: parseProvenance({
            provenance_id: "00000000-0000-0000-0000-000000000921",
            source_kind: "parser",
            source_name: "fixture",
            source_record_id: null,
            observed_at: "2026-09-29T00:00:00Z",
            input_sha256: input.source_sha256,
            parameters_sha256: "a".repeat(64),
          }),
          parser_version: "fixture",
          mode: null,
          model_identity: null,
        },
      }),
    };
    const documentApp = await createApplication(home, {
      executionSchema: "require-v2",
      parsing: { parser, rules: new TypeScriptParserArtifactRules() },
    });
    try {
      const pdf = workbenchPdf();
      const stage = await documentApp.files.stage();
      await stage.write(pdf);
      await documentApp.files.publish(stage, "objects/source.pdf");
      const asset = parseAsset({
        asset_id: "00000000-0000-0000-0000-000000000922",
        sha256: await sha256(pdf),
        size_bytes: pdf.length,
        media_type: "application/pdf",
        path: "objects/source.pdf",
      });
      await documentApp.database.putLiteratureAsset({
        literature_asset_id: "00000000-0000-0000-0000-000000000923",
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset,
        role: "primary-pdf",
        source_url: null,
        provenance: {
          provenance_id: "00000000-0000-0000-0000-000000000924",
          source_kind: "asset-provider",
          source_name: "fixture",
          source_record_id: null,
          observed_at: "2026-09-29T00:00:00Z",
          input_sha256: asset.sha256,
          parameters_sha256: null,
        },
      });
      await documentApp.documentProcessing.parseDocuments({
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset_id: asset.asset_id,
        asset_sha256: asset.sha256,
        mode: "reparse",
        expected_default_revision: null,
      });
    } finally {
      await documentApp.close();
    }
    web = await startMaintenanceWorkbench({ home, assets: await assets() });
    browser = await chromium.launch({
      executablePath:
        process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
        "/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
      headless: true,
    });
    const page = await browser.newPage();
    await page.goto(web.origin);
    await page.locator("#retrieval-rebuild").click();
    await expect
      .poll(() => page.locator("#retrieval-rebuild-status").textContent())
      .toContain("索引已发布");
    await page.goto(`${web.origin}/query`);
    await page.locator("#context-query").fill("synthetic");
    await page.locator("#context-submit").click();
    await expect
      .poll(() => page.locator("#context-status").textContent())
      .toContain("complete");
    await expect
      .poll(() => page.locator("#context-results article").count())
      .toBe(2);
    expect(
      await page.locator("#context-results article").first().textContent(),
    ).toContain(FIXTURE_LITERATURE.literature_id);
    await page.getByRole("button", { name: "解析证据 1" }).click();
    await expect
      .poll(() =>
        page.locator("#context-results article pre").allTextContents(),
      )
      .toContain("Synthetic evidence paragraph.\n");
  } finally {
    await browser?.close();
    await web?.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
