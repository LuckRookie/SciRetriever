import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { parseLiterature, parseReference } from "@sciretriever/contracts";
import { startQueryOnlyWorkbench } from "../../server/src/bootstrap/workbench.js";
import type { WorkbenchStaticAsset } from "../../server/src/workbench/http.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";
import { id, lit, proposal, setup } from "../../server/test/content-fixture.js";

async function assets(): Promise<Map<string, WorkbenchStaticAsset>> {
  const values = new Map<string, WorkbenchStaticAsset>();
  for (const [route, file, contentType] of [
    ["/", "query.html", "text/html"],
    ["/styles.css", "styles.css", "text/css"],
    ["/live.css", "live.css", "text/css"],
  ] as const)
    values.set(route, {
      contentType,
      body: await readFile(new URL(`../public/${file}`, import.meta.url)),
    });
  const bundled = await build({
    entryPoints: [new URL("../src/query.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  values.set("/query.js", {
    contentType: "text/javascript",
    body: bundled.outputFiles[0]!.contents,
  });
  return values;
}

async function launchBrowser() {
  return chromium.launch({
    executablePath:
      process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
      "/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
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
    const page = await browser.newPage();
    await page.goto(workbench.origin);
    await expect
      .poll(() => page.locator("#library-status").textContent())
      .toContain("文献库尚未初始化");
    expect(await readdir(parent)).toEqual([]);
  } finally {
    await browser.close();
    await workbench.close();
    await rm(parent, { recursive: true, force: true });
  }
});

it("reads, searches, follows references and downloads through the query-only page", async () => {
  const env = await setup(true);
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
    const source = await env.app.library.detail(lit);
    const content = await proposal(source);
    await env.app.literatureContent.accept(content.value, content.bytes);
    await env.app.database.putLiterature(related);
    await env.app.database.putLiterature(missingPdf);
    await env.app.observations.publish({
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
    const page = await browser.newPage({ acceptDownloads: true });
    const failures: string[] = [];
    const requests: URL[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("request", (request) => requests.push(new URL(request.url())));

    await page.goto(workbench.origin);
    await expect
      .poll(() => page.locator("#library-status").textContent())
      .toContain("找到");
    await page.locator("#extraction-spec").fill(
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
    await page.locator("#extraction-inputs").fill(
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
    await page.locator("#extraction-prepare-submit").click();
    await expect
      .poll(() => page.locator("#extraction-prepare-status").textContent())
      .toContain("已固定 1 项输入");
    await expect
      .poll(() => page.locator("#extraction-prepare-result").textContent())
      .toContain('"input_id": "source-1"');
    const validResult = JSON.parse(
      (await page.locator("#extraction-prepare-result").textContent())!,
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
    await page.locator("#extraction-prepare-submit").click();
    await receivedRequest;
    expect(await page.locator("#extraction-spec").isDisabled()).toBe(true);
    expect(await page.locator("#extraction-inputs").isDisabled()).toBe(true);
    await page.evaluate(() => {
      document
        .getElementById("extraction-prepare-form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(delayedRequests).toBe(1);
    release();
    await expect
      .poll(() => page.locator("#extraction-prepare-status").textContent())
      .toContain("已固定 1 项输入");
    await expect
      .poll(() => page.locator("#extraction-spec").isDisabled())
      .toBe(false);
    await page.unroute("**/api/v1/query/extraction-prepare");
    const unchangedSpec = await page.locator("#extraction-spec").inputValue();
    await page
      .locator("#extraction-spec")
      .fill(
        unchangedSpec.replace("synthetic.browser", "synthetic.browser.revised"),
      );
    await expect
      .poll(() => page.locator("#extraction-prepare-status").textContent())
      .toContain("输入已修改");
    expect(await page.locator("#extraction-prepare-result").textContent()).toBe(
      "",
    );
    await page.locator("#extraction-spec").fill(unchangedSpec);
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
      await page.locator("#extraction-prepare-submit").click();
      await expect
        .poll(() => page.locator("#extraction-prepare-status").textContent())
        .toContain("准备失败");
      expect(
        await page.locator("#extraction-prepare-result").textContent(),
      ).toBe("");
      await page.unroute("**/api/v1/query/extraction-prepare");
    }
    await page.route("**/api/v1/query/extraction-prepare", async (route) =>
      route.fulfill({
        contentType: "application/json",
        body: `{"protocol_version":1,"result":${JSON.stringify(validResult)},"result":${JSON.stringify(validResult)}}`,
      }),
    );
    await page.locator("#extraction-prepare-submit").click();
    await expect
      .poll(() => page.locator("#extraction-prepare-status").textContent())
      .toContain("准备失败");
    await page.unroute("**/api/v1/query/extraction-prepare");
    const previousPreparations = requests.filter(
      (request) => request.pathname === "/api/v1/query/extraction-prepare",
    ).length;
    const originalSpec = await page.locator("#extraction-spec").inputValue();
    await page
      .locator("#extraction-spec")
      .fill(
        originalSpec.replace(
          '"spec_id":"synthetic.browser"',
          '"spec_id":"synthetic.browser","spec_id":"forged"',
        ),
      );
    await page.locator("#extraction-prepare-submit").click();
    await expect
      .poll(() => page.locator("#extraction-prepare-status").textContent())
      .toContain("准备失败");
    expect(
      requests.filter(
        (request) => request.pathname === "/api/v1/query/extraction-prepare",
      ).length,
    ).toBe(previousPreparations);
    await page.locator("#extraction-spec").fill(originalSpec);
    const originalInputs = await page
      .locator("#extraction-inputs")
      .inputValue();
    await page
      .locator("#extraction-inputs")
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
    await page.locator("#extraction-prepare-submit").click();
    await expect
      .poll(() => page.locator("#extraction-prepare-status").textContent())
      .toContain("准备失败");
    await page.unroute("**/api/v1/query/extraction-prepare");
    await page.locator("#extraction-inputs").fill(originalInputs);
    await page.locator("#library-query").fill("Synthetic literature workbench");
    await page
      .locator("#library-form")
      .getByRole("button", { name: "搜索" })
      .click();
    const sourceResult = page
      .locator(".library-result")
      .filter({ hasText: "Synthetic literature workbench" })
      .first();
    await expect.poll(() => sourceResult.isVisible()).toBe(true);
    await sourceResult.click();
    await expect
      .poll(() => page.locator("#library-detail h2").textContent())
      .toBe("Synthetic literature workbench");
    expect(new URL(page.url()).searchParams.get("literature")).toBe(lit);
    await page.goBack();
    await expect
      .poll(() => new URL(page.url()).searchParams.has("literature"))
      .toBe(false);
    await expect
      .poll(() => page.locator("#library-detail").textContent())
      .toContain("选择一篇文献");
    await page.goForward();
    await expect
      .poll(() => page.locator("#library-detail h2").textContent())
      .toBe("Synthetic literature workbench");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page
        .locator("#library-detail")
        .getByRole("button", { name: "下载 PDF" })
        .click(),
    ]);
    expect(await readFile((await download.path())!)).toEqual(
      Buffer.from(expectedPdf),
    );

    await page
      .locator("#library-detail")
      .getByRole("button", { name: "查看参考文献", exact: true })
      .click();
    const relatedResult = page
      .locator("#library-detail")
      .getByRole("button", { name: /Query reader reference target/u });
    await expect.poll(() => relatedResult.isVisible()).toBe(true);
    await relatedResult.click();
    await expect.poll(() => page.locator(".library-evidence").count()).toBe(1);
    await expect
      .poll(() => page.locator(".library-evidence").textContent())
      .toContain("元数据参考文献文本");
    await page.locator("#library-query").fill("Query reader without a PDF");
    await page
      .locator("#library-form")
      .getByRole("button", { name: "搜索" })
      .click();
    const missingResult = page
      .locator(".library-result")
      .filter({ hasText: "Query reader without a PDF" });
    await expect.poll(() => missingResult.isVisible()).toBe(true);
    await missingResult.click();
    await expect
      .poll(() => page.locator("#library-detail h2").textContent())
      .toBe("Query reader without a PDF");
    await expect
      .poll(() => page.locator("#library-detail").textContent())
      .toContain("尚无已接纳的 PDF");
    expect(
      await page
        .locator("#library-detail")
        .getByRole("button", { name: "下载 PDF" })
        .count(),
    ).toBe(0);

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
      requests.every((request) => request.origin === workbench!.origin),
    ).toBe(true);
    expect(apiRequests.map((request) => request.pathname)).toEqual(
      expect.arrayContaining([
        "/api/v1/query/status",
        "/api/v1/query/search",
        "/api/v1/query/read",
        "/api/v1/query/references",
        "/api/v1/query/reference",
        "/api/v1/query/artifact",
      ]),
    );
    expect(failures).toEqual([]);
  } finally {
    await browser?.close();
    await workbench?.close();
    await env.close();
  }
}, 60_000);
