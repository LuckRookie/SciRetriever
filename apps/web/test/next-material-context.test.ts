import { correctedDocumentFixture } from "../../server/test/corrected-document-fixture.js";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  independentNextAssets,
  motionOptions,
} from "./next-workspace-fixture.js";
import { readingAssets } from "./reading-assets-fixture.js";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { createParserFixtureApplication as createApplication } from "../../server/test/parser-application-fixture.js";
import { startMaintenanceWorkbench } from "../../server/src/bootstrap/workbench.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";
import { workbenchPdf } from "../../server/src/workbench/synthetic-fixture.js";
import {
  parseAsset,
  parseProvenance,
  sha256,
  type ArtifactRef,
} from "@sciretriever/contracts";
import { TypeScriptParserArtifactRules } from "../../server/src/parsing/artifact-rules.js";
import type { ParserBackend } from "../../server/test/parser-fixture-types.js";
import type { WorkbenchStaticAsset } from "../../server/src/workbench/http.js";

async function assets(): Promise<Map<string, WorkbenchStaticAsset>> {
  return new Map([
    ...(await readingAssets()),
    ...(await independentNextAssets("maintenance")),
  ]);
}

it("rebuilds the v4 index explicitly and searches Context in the real browser pages", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-context-web-"));
  const app = await createApplication(home, {});
  let web: Awaited<ReturnType<typeof startMaintenanceWorkbench>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await app.database.putLiterature(FIXTURE_LITERATURE);
    await app.close();
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
      await correctedDocumentFixture(documentApp).parseDocuments({
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
      ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    const page = await browser.newPage(motionOptions());
    page.setDefaultTimeout(20_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${web.origin}/?view=set`);
    await page.getByRole("tab", { name: "索引与请求", exact: true }).click();
    let rebuilds = 0;
    page.on("request", (request) => {
      if (request.url().includes("rebuild-index")) rebuilds++;
    });
    await page
      .getByRole("button", { name: "重建全文索引", exact: true })
      .click();
    expect(rebuilds).toBe(0);
    await page
      .getByRole("dialog", { name: "重建全文索引？" })
      .getByRole("button", { name: "重建全文索引", exact: true })
      .click();
    // The rebuild runs in the background; the card polls its status.
    await expect
      .poll(() => page.getByRole("status").allTextContents(), {
        timeout: 20_000,
      })
      .toContainEqual(expect.stringContaining("全文索引已重建"));
    expect(rebuilds).toBe(1);
    await page.goto(`${web.origin}/query?view=ask`);
    await page
      .getByRole("searchbox", { name: "问题或关键词", exact: true })
      .fill("synthetic");
    // The context column appears only with the first chosen hit.
    expect(
      await page.getByRole("complementary", { name: "上下文" }).count(),
    ).toBe(0);
    await page
      .getByRole("main")
      .getByRole("button", { name: "检索", exact: true })
      .click();
    await expect
      .poll(() => page.locator('[data-testid="retrieval-result"]').count())
      .toBe(2);
    expect(
      await page.locator('[data-testid="retrieval-status"]').textContent(),
    ).toContain("2 条结果");
    expect(await page.locator(".retrieval-page").textContent()).not.toContain(
      "此版本的库尚不提供知识检索",
    );
    const document = page.locator(
      '[data-testid="retrieval-result"][data-kind="source"]',
    );
    await document
      .getByRole("button", { name: "记下出处", exact: true })
      .click();
    await expect
      .poll(() => document.locator(".fixed-source").textContent())
      .toContain("Synthetic evidence paragraph.");
    await document
      .getByRole("button", { name: "加入上下文", exact: true })
      .click();
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: web.origin,
      });
    await page
      .getByRole("button", { name: "复制为 Markdown", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain("Synthetic evidence paragraph.");
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain(FIXTURE_LITERATURE.literature_id);
    expect(clipboard).toContain("document_version_id");
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 JSON", exact: true }).click();
    const file = await downloaded,
      path = await file.path();
    expect(file.suggestedFilename()).toBe("sciretriever-context.json");
    if (!path) throw new Error("No exported context");
    const exported = JSON.parse(await readFile(path, "utf8"));
    expect(exported.items).toHaveLength(1);
    expect(exported.items[0]).toMatchObject({
      kind: "source-text",
      literature_id: FIXTURE_LITERATURE.literature_id,
      text: "Synthetic evidence paragraph.\n\n",
      reference: {
        kind: "document",
        literature_id: FIXTURE_LITERATURE.literature_id,
      },
    });
    expect(exported.query.query).toBe("synthetic");
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await web?.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 60000);
