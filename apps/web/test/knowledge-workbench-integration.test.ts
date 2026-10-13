import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { coreProcessingFixture } from "../../server/test/core-processing-fixture.js";
import { createQueryApplication } from "../../server/src/bootstrap/application.js";
import { taskHttpAdapters } from "../../server/src/bootstrap/workbench.js";
import {
  startWorkbenchHttp,
  type WorkbenchStaticAsset,
} from "../../server/src/workbench/http.js";
import { ProductionWorkbenchSession } from "../../server/src/workbench/production-session.js";

it("uses the authenticated blue workbench to read original bytes, run durable parsing and analysis, and reopen verified knowledge", async () => {
  const env = await coreProcessingFixture();
  const query = await createQueryApplication(env.home);
  const session = new ProductionWorkbenchSession(null, async () => {
    throw new Error("unexpected browser action");
  });
  const assets = new Map<string, WorkbenchStaticAsset>();
  for (const [route, file, contentType] of [
    ["/", "live.html", "text/html"],
    ["/styles.css", "styles.css", "text/css"],
    ["/live.css", "live.css", "text/css"],
  ] as const)
    assets.set(route, {
      contentType,
      body: await readFile(new URL(`../public/${file}`, import.meta.url)),
    });
  const bundle = await build({
    entryPoints: [new URL("../src/live.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  assets.set("/live.js", {
    contentType: "text/javascript",
    body: bundle.outputFiles[0]!.contents,
  });
  const server = await startWorkbenchHttp({
    ...taskHttpAdapters(env.app),
    session,
    query: { application: query, maintenance: env.app.maintenance! },
    maintenance: env.app.maintenance!,
    library: {
      queries: env.app.library,
      artifacts: env.app.literatureArtifacts,
    },
    assets,
  });
  const browser = await chromium.launch({
    executablePath:
      process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
      "/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
    headless: true,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.origin);
    await page.locator("#library-tab").click();
    await expect.poll(() => page.locator(".library-result").count()).toBe(1);
    await page.locator(".library-result").click();
    await expect
      .poll(() => page.locator("#library-detail h2").textContent())
      .toContain("Synthetic literature workbench");
    expect(env.parseCalls).toBe(0);
    expect(env.modelCalls).toBe(0);
    expect(await env.app.jobs!.listJobs(10)).toHaveLength(0);
    await page
      .getByRole("button", { name: "阅读原始 PDF", exact: true })
      .click();
    await expect
      .poll(() => page.locator(".library-pdf-reading").textContent())
      .toContain(env.asset.sha256);
    expect(
      await page.locator('iframe[title="原始 PDF 预览"]').getAttribute("src"),
    ).toMatch(/^blob:/u);
    await page
      .getByRole("button", { name: "加入集合综合", exact: true })
      .click();
    expect(
      JSON.parse(await page.locator("#synthesis-inputs").inputValue()),
    ).toMatchObject([
      {
        literature_id: env.parseRequest.literature_id,
        asset_sha256: env.asset.sha256,
      },
    ]);
    await page
      .getByRole("button", { name: "加入提取输入", exact: true })
      .click();
    expect(
      JSON.parse(await page.locator("#extraction-inputs").inputValue()),
    ).toMatchObject([
      {
        literature_id: env.parseRequest.literature_id,
        asset_sha256: env.asset.sha256,
      },
    ]);
    await page
      .getByRole("button", { name: "加工这篇文献", exact: true })
      .click();
    await expect
      .poll(() => page.locator("#document-material-status").textContent())
      .toContain("尚无默认版本");
    expect(await page.locator("#document-literature-id").inputValue()).toBe(
      env.parseRequest.literature_id,
    );
    await page.locator("#document-parse-submit").click();
    await expect
      .poll(() => page.locator("#document-parse-status").textContent())
      .toContain("任务已持久保存");
    await expect
      .poll(
        async () => {
          const jobs = await env.app.jobs!.listJobs(10);
          return {
            status: jobs[0]?.status,
            failures: jobs[0]
              ? (await env.app.processingTasks!.read(jobs[0].job_id)).failures
              : [],
          };
        },
        { timeout: 10000 },
      )
      .toEqual({ status: "completed", failures: [] });
    expect(env.parseCalls).toBe(1);
    expect(env.modelCalls).toBe(0);
    await page.locator("#document-parse-status a").click();
    await page.getByRole("tab", { name: "结果与材料" }).click();
    await page
      .getByRole("button", { name: "打开解析 PDF结果", exact: true })
      .click();
    await expect
      .poll(() => page.locator(".library-reading").textContent())
      .toContain("固定表示");
    expect(new URL(page.url()).searchParams.get("document")).toBeTruthy();
    await page.locator(".library-reading-sections button").first().click();
    await expect
      .poll(() => page.locator(".library-reading-text").textContent())
      .toContain("A synthetic finding.");
    expect(env.parseCalls).toBe(1);
    await page
      .getByRole("button", { name: "加工这篇文献", exact: true })
      .click();
    await page.locator("#knowledge-start").click();
    await expect
      .poll(() => page.locator("#knowledge-status").textContent())
      .toContain("任务已持久保存");
    await expect
      .poll(
        async () =>
          (await env.app.jobs!.listJobs(10)).filter(
            (job) => job.status === "completed",
          ).length,
        { timeout: 10000 },
      )
      .toBe(2);
    expect(env.modelCalls).toBeGreaterThan(0);
    const callsAfterAnalysis = env.modelCalls;
    await page.locator("#knowledge-status a").click();
    await page.getByRole("tab", { name: "结果与材料" }).click();
    await page
      .getByRole("button", { name: "打开单篇知识分析结果", exact: true })
      .click();
    expect(new URL(page.url()).searchParams.get("knowledge")).toBeTruthy();
    await expect
      .poll(() => page.locator("#knowledge-read-result").textContent())
      .toContain("A synthetic finding.");
    await page
      .locator("#knowledge-read-result")
      .getByRole("button", { name: "展开证据" })
      .first()
      .click();
    await expect
      .poll(() => page.locator("#knowledge-read-result").textContent())
      .toContain("已读取完整证据");
    expect(env.modelCalls).toBe(callsAfterAnalysis);
    await page.locator(".library-identity summary").click();
    await page
      .getByRole("button", { name: "提交身份核验任务", exact: true })
      .click();
    await expect
      .poll(() => page.locator(".library-identity").textContent())
      .toContain("任务已持久保存");
    await expect
      .poll(
        async () =>
          (await env.app.jobs!.listJobs(10)).filter(
            (job) => job.status === "completed",
          ).length,
        { timeout: 10000 },
      )
      .toBe(3);
    await page.reload();
    await page.locator("#library-tab").click();
    await expect.poll(() => page.locator(".library-result").count()).toBe(1);
    await page.locator(".library-result").click();
    await expect
      .poll(() => page.locator("#library-detail").textContent())
      .toContain("文章身份有证据支持");
    await expect
      .poll(() =>
        page
          .locator("#knowledge-list-results button")
          .filter({ hasText: "overview ·" })
          .count(),
      )
      .toBe(1);
    expect(await env.app.jobs!.listJobs(10)).toHaveLength(3);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.close();
    await session.close();
    await query.close();
    await env.close();
  }
}, 60000);
