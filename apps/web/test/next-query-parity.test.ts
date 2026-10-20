import { showAllLibraryStatuses } from "./next-workspace-fixture.js";
import { processorFixture } from "../../server/test/processor-fixture.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  independentNextAssets,
  motionOptions,
} from "./next-workspace-fixture.js";
import { readingAssets } from "./reading-assets-fixture.js";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { parseLiterature, parseReference } from "@sciretriever/contracts";
import { startQueryOnlyWorkbench } from "../../server/src/bootstrap/workbench.js";
import type { WorkbenchStaticAsset } from "../../server/src/workbench/http.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";
import { id, lit } from "../../server/test/content-fixture.js";

async function assets(): Promise<Map<string, WorkbenchStaticAsset>> {
  return new Map([
    ...(await readingAssets()),
    ...(await independentNextAssets("query")),
  ]);
}

async function launchBrowser() {
  return chromium.launch({
    ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
      ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
      : {}),
    headless: true,
  });
}

it("shows an uninitialized state without creating a home or catalog", async () => {
  const parent = await mkdtemp(join(tmpdir(), "sciretriever-query-web-empty-"));
  const home = join(parent, "not-created");
  const workbench = await startQueryOnlyWorkbench({
    home,
    assets: await assets(),
  });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage(motionOptions());
    page.setDefaultTimeout(5000);
    await page.goto(`${workbench.origin}/`);
    await expect
      .poll(() => page.locator(".library-page").textContent())
      .toContain("文献库尚未初始化");
    expect(await readdir(parent)).toEqual([]);
  } finally {
    await browser.close();
    await workbench.close();
    await rm(parent, { recursive: true, force: true });
  }
}, 60000);

it("reads, searches, follows references and downloads through the query-only page", async () => {
  const env = await processorFixture();
  await env.build(env.parseRequest);
  const source = await env.app.library.detail(lit);
  const related = parseLiterature({
    ...FIXTURE_LITERATURE,
    literature_id: id(80),
    meta_literature_id: id(81),
    metadata: {
      ...FIXTURE_LITERATURE.metadata,
      title: "Query reader reference target",
      identifiers: [],
    },
  });
  const missingPdf = parseLiterature({
    ...FIXTURE_LITERATURE,
    literature_id: id(82),
    meta_literature_id: id(83),
    metadata: {
      ...FIXTURE_LITERATURE.metadata,
      title: "Query reader without a PDF",
      identifiers: [],
    },
  });
  let workbench:
    | Awaited<ReturnType<typeof startQueryOnlyWorkbench>>
    | undefined;
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    await env.app.database.putLiterature(related);
    await env.app.database.putLiterature(missingPdf);
    await env.app.observations.publish({
      source_type: null,
      source_type_mapping_version: null,
      observation_id: id(85),
      literature_id: lit,
      provenance: {
        provenance_id: id(86),
        source_kind: "user",
        source_name: "bibliographic-import",
        source_record_id: null,
        observed_at: "2026-09-28T00:00:00Z",
        input_sha256: null,
        parameters_sha256: null,
      },
      version_role: "published",
      reference_count: 1,
      cited_by_count: null,
      metadata: FIXTURE_LITERATURE.metadata,
      declared_keywords: [],
      reference_texts: ["Query reader reference target"],
    });
    await env.app.references.publish(
      parseReference({
        reference_id: id(84),
        source_literature_id: lit,
        target_literature_id: related.literature_id,
      }),
    );
    await env.app.references.supportWithMetadataReferenceText(
      id(84),
      id(85),
      0,
    );
    const expectedPdf = await env.app.files.read(
      source.primary_pdf!.asset.path,
      source.primary_pdf!.asset.size_bytes,
    );
    workbench = await startQueryOnlyWorkbench({
      home: env.home,
      assets: await assets(),
    });
    const directDetail = await workbench.application.query!.detail(lit);
    expect(directDetail.literature.literature_id).toBe(lit);
    browser = await launchBrowser();
    const page = await browser.newPage({
      ...motionOptions(),
      acceptDownloads: true,
    });
    page.setDefaultTimeout(5000);
    const failures: string[] = [];
    const requests: URL[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("request", (request) => requests.push(new URL(request.url())));

    await page.goto(`${workbench.origin}/`);
    await expect
      .poll(() => page.locator(".library-page").textContent())
      .toContain("篇");
    await page.goto(`${workbench.origin}/?view=ext&tools=delivery`);
    await page.getByLabel("规范 JSON", { exact: true }).fill(
      JSON.stringify({
        schema_version: 1,
        spec_id: "synthetic.browser",
        spec_version: "1",
        record_meaning: "一条记录代表一项合成观察。",
        output_schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
        },
        field_instructions: [],
        inclusion_rules: [],
        missing_value_rules: [],
        evidence_policy: {
          field_granularity: "file",
          required_pointers: "record-root",
          cross_input_relation: "optional",
        },
        required_capabilities: ["material-file-v1"],
      }),
    );
    await page.getByLabel("显式输入 JSON 数组", { exact: true }).fill(
      JSON.stringify([
        {
          input_id: "source-1",
          literature_id: lit,
          asset_id: source.primary_pdf!.asset.asset_id,
          asset_sha256: source.primary_pdf!.asset.sha256,
          document_version_id: null,
        },
      ]),
    );
    await page
      .getByRole("button", { name: "检查规范并固定输入", exact: true })
      .click();
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("请求已完成");
    await page
      .getByRole("button", { name: "回执与固定输入", exact: true })
      .click();
    await expect
      .poll(() => page.getByTestId("delivery-result").textContent())
      .toContain('"input_id": "source-1"');
    const validResult = JSON.parse(
      (await page.getByTestId("delivery-result").textContent())!,
    );
    let received!: () => void;
    let release!: () => void;
    const receivedRequest = new Promise<void>((resolve) => {
      received = resolve;
    });
    const holdResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delayedRequests = 0;
    await page.route("**/api/v1/query/extraction-prepare", async (route) => {
      delayedRequests++;
      received();
      await holdResponse;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          protocol_version: 1,
          result: validResult,
        }),
      });
    });
    await page
      .getByRole("button", { name: "检查规范并固定输入", exact: true })
      .click();
    await receivedRequest;
    expect(
      await page.getByLabel("规范 JSON", { exact: true }).isDisabled(),
    ).toBe(true);
    expect(
      await page.getByLabel("显式输入 JSON 数组", { exact: true }).isDisabled(),
    ).toBe(true);
    await page
      .getByRole("button", { name: "检查规范并固定输入", exact: true })
      .evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
    expect(delayedRequests).toBe(1);
    release();
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("请求已完成");
    await expect
      .poll(() => page.getByLabel("规范 JSON", { exact: true }).isDisabled())
      .toBe(false);
    await page.unroute("**/api/v1/query/extraction-prepare");
    const unchangedSpec = await page
      .getByLabel("规范 JSON", { exact: true })
      .inputValue();
    await page
      .getByLabel("规范 JSON", { exact: true })
      .fill(
        unchangedSpec.replace("synthetic.browser", "synthetic.browser.revised"),
      );
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("输入已修改");
    expect(await page.getByTestId("delivery-result").count()).toBe(0);
    await page.getByLabel("规范 JSON", { exact: true }).fill(unchangedSpec);
    for (const envelope of [
      { protocol_version: 2, result: validResult },
      {
        protocol_version: 1,
        result: {
          ...validResult,
          spec: { ...validResult.spec, spec_sha256: "f".repeat(64) },
        },
      },
      {
        protocol_version: 1,
        result: {
          ...validResult,
          manifest: {
            ...validResult.manifest,
            manifest_sha256: "f".repeat(64),
          },
        },
      },
      {
        protocol_version: 1,
        result: {
          ...validResult,
          missing_required_capabilities: [
            { input_id: "source-1", capabilities: ["document-segment-v1"] },
          ],
        },
      },
    ]) {
      await page.route("**/api/v1/query/extraction-prepare", async (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(envelope),
        }),
      );
      await page
        .getByRole("button", { name: "检查规范并固定输入", exact: true })
        .click();
      await expect
        .poll(() => page.getByTestId("delivery-feedback").textContent())
        .toContain("请求失败");
      expect(await page.getByTestId("delivery-result").count()).toBe(0);
      await page.unroute("**/api/v1/query/extraction-prepare");
    }
    await page.route("**/api/v1/query/extraction-prepare", async (route) =>
      route.fulfill({
        contentType: "application/json",
        body: `{"protocol_version":1,"result":${JSON.stringify(validResult)},"result":${JSON.stringify(validResult)}}`,
      }),
    );
    await page
      .getByRole("button", { name: "检查规范并固定输入", exact: true })
      .click();
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("请求失败");
    await page.unroute("**/api/v1/query/extraction-prepare");
    const previousPreparations = requests.filter(
      (request) => request.pathname === "/api/v1/query/extraction-prepare",
    ).length;
    const originalSpec = await page
      .getByLabel("规范 JSON", { exact: true })
      .inputValue();
    await page
      .getByLabel("规范 JSON", { exact: true })
      .fill(
        originalSpec.replace(
          '"spec_id":"synthetic.browser"',
          '"spec_id":"synthetic.browser","spec_id":"forged"',
        ),
      );
    await page
      .getByRole("button", { name: "检查规范并固定输入", exact: true })
      .click();
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("请求失败");
    expect(
      requests.filter(
        (request) => request.pathname === "/api/v1/query/extraction-prepare",
      ).length,
    ).toBe(previousPreparations);
    await page.getByLabel("规范 JSON", { exact: true }).fill(originalSpec);
    const originalInputs = await page
      .getByLabel("显式输入 JSON 数组", { exact: true })
      .inputValue();
    await page
      .getByLabel("显式输入 JSON 数组", { exact: true })
      .fill(
        originalInputs.replace(
          '"document_version_id":null',
          `"document_version_id":"${id(999)}"`,
        ),
      );
    await page.route("**/api/v1/query/extraction-prepare", async (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          protocol_version: 1,
          result: validResult,
        }),
      }),
    );
    await page
      .getByRole("button", { name: "检查规范并固定输入", exact: true })
      .click();
    await expect
      .poll(() => page.getByTestId("delivery-feedback").textContent())
      .toContain("请求失败");
    await page.unroute("**/api/v1/query/extraction-prepare");
    await page
      .getByLabel("显式输入 JSON 数组", { exact: true })
      .fill(originalInputs);
    await page.goto(`${workbench.origin}/`);
    await showAllLibraryStatuses(page);
    await page
      .getByRole("searchbox", { name: "搜索文献", exact: true })
      .fill("Synthetic literature workbench");
    const sourceResult = page.getByRole("article", {
      name: "Synthetic literature workbench",
      exact: true,
    });
    await sourceResult.locator(".paper-open").click();
    await page
      .locator('.reading-pdf-page[data-rendered="true"]')
      .first()
      .waitFor();
    expect(new URL(page.url()).searchParams.get("literature")).toBe(lit);
    await page.goBack();
    await expect
      .poll(() => new URL(page.url()).searchParams.has("literature"))
      .toBe(false);
    await sourceResult.waitFor();
    await page.goForward();
    await page
      .locator('.reading-pdf-page[data-rendered="true"]')
      .first()
      .waitFor();
    const pdfDownload = async () => {
      await page.getByRole("button", { name: "更多", exact: true }).click();
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page
          .getByRole("menuitem", { name: "下载已核验的原始 PDF", exact: true })
          .click(),
      ]);
      expect(await readFile((await download.path())!)).toEqual(
        Buffer.from(expectedPdf),
      );
    };
    await pdfDownload();
    await pdfDownload();
    await page.getByRole("button", { name: "更多", exact: true }).click();
    expect(
      await page
        .getByRole("menuitem", { name: "导出书目", exact: true })
        .count(),
    ).toBe(0);
    await page.keyboard.press("Escape");
    await page.route("**/api/v1/query/material-bytes", async (route) => {
      const corrupted = Buffer.from(expectedPdf);
      corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        headers: {
          "x-sciretriever-asset-id": source.primary_pdf!.asset.asset_id,
          "x-sciretriever-asset-sha256": source.primary_pdf!.asset.sha256,
          "x-sciretriever-byte-size": String(expectedPdf.length),
        },
        body: corrupted,
      });
    });
    await page.reload();
    await expect
      .poll(() => page.getByRole("alert").allTextContents(), { timeout: 10000 })
      .toContainEqual(expect.stringContaining("完整性校验失败"));
    expect(await page.locator(".reading-pdf-page").count()).toBe(0);
    await page.getByRole("button", { name: "更多", exact: true }).click();
    expect(
      await page
        .getByRole("menuitem", { name: "下载已核验的原始 PDF", exact: true })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await page.keyboard.press("Escape");
    await page.unroute("**/api/v1/query/material-bytes");
    await page
      .getByRole("button", { name: "查看参考文献", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Query reader reference target",
        exact: true,
      })
      .waitFor();
    await page
      .getByRole("button", { name: "来源证据（1）", exact: true })
      .click();
    await page.getByText("元数据参考文献第 1 项", { exact: true }).waitFor();
    await page
      .getByRole("button", {
        name: "Query reader reference target",
        exact: true,
      })
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("literature"))
      .toBe(related.literature_id);
    await page.goto(`${workbench.origin}/`);
    await showAllLibraryStatuses(page);
    await page
      .getByRole("searchbox", { name: "搜索文献", exact: true })
      .fill("Query reader without a PDF");
    await page
      .getByRole("article", { name: "Query reader without a PDF", exact: true })
      .locator(".paper-open")
      .click();
    await page
      .getByText("尚无 PDF。可从信息栏上传或显式获取。", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "更多", exact: true }).click();
    expect(
      await page
        .getByRole("menuitem", { name: "下载已核验的原始 PDF", exact: true })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await page.keyboard.press("Escape");
    for (const section of ["disc", "task", "web", "set"]) {
      await page.goto(`${workbench.origin}/?view=${section}`);
      await page.getByText("当前入口不提供这项操作", { exact: true }).waitFor();
    }
    const apiRequests = requests.filter((request) =>
      request.pathname.startsWith("/api/"),
    );
    expect(apiRequests.length).toBeGreaterThan(0);
    expect(
      apiRequests.every((request) =>
        request.pathname.startsWith("/api/v1/query/"),
      ),
    ).toBe(true);
    expect(
      requests
        .filter(
          (request) =>
            !(
              request.origin === workbench!.origin ||
              // Chromium's built-in PDF viewer loads bundled extension resources, not remote services.
              (request.protocol === "chrome-extension:" &&
                request.hostname === "mhjfbmdgcfjbbpaeojofohoefgiehjai") ||
              (request.protocol === "chrome:" &&
                request.hostname === "resources") ||
              (request.protocol === "chrome-untrusted:" &&
                request.hostname === "pdf")
            ),
        )
        .map((request) => request.href),
    ).toEqual([]);
    expect(apiRequests.map((request) => request.pathname)).toEqual(
      expect.arrayContaining([
        "/api/v1/query/status",
        "/api/v1/query/search",
        "/api/v1/query/read",
        "/api/v1/query/references",
        "/api/v1/query/reference",
        "/api/v1/query/material-bytes",
      ]),
    );
    expect(failures).toEqual([]);
  } finally {
    await browser?.close();
    await workbench?.close();
    await env.close();
  }
}, 120_000);
