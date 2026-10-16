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

it("uses the authenticated library workspace to read original bytes, run durable parsing and analysis, and reopen verified knowledge", async () => {
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
    ["/workspace.css", "workspace.css", "text/css"],
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
    page.setDefaultTimeout(5000);
    await page.goto(server.origin);
    await expect.poll(() => page.locator(".prow").count()).toBe(1);
    await page.locator(".prow").click();
    await expect
      .poll(() => page.locator("#reader-info h2").textContent())
      .toContain("Synthetic literature workbench");
    expect(env.parseCalls).toBe(0);
    expect(env.modelCalls).toBe(0);
    expect(await env.app.jobs!.listJobs(10)).toHaveLength(0);
    await expect
      .poll(() => page.locator(".library-pdf-reading").textContent())
      .toContain(env.asset.sha256);
    expect(
      await page.locator('iframe[title="原始 PDF 预览"]').getAttribute("src"),
    ).toMatch(/^blob:/u);
    await page
      .getByRole("button", { name: "加入提取输入", exact: true })
      .click();
    await page
      .getByRole("button", { name: "使用库中选定范围", exact: true })
      .click();
    await expect
      .poll(async () => {
        const value = await page.locator("#extraction-inputs").inputValue();
        return value ? JSON.parse(value) : null;
      })
      .toMatchObject([
        {
          literature_id: env.parseRequest.literature_id,
          asset_sha256: env.asset.sha256,
        },
      ]);
    await page.locator("[data-paper]").click();
    await page.getByRole("button", { name: "解析", exact: true }).click();
    expect(env.parseCalls).toBe(0);
    await page.locator("#op-confirm").click();
    await expect
      .poll(() => page.locator("#op-status").textContent())
      .toContain("已提交 1 项");
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
    await page.locator("#op-results [data-task]").click();
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
      .getByRole("button", { name: "加入集合综合", exact: true })
      .click();
    await page.locator("#new-synthesis").click();
    await page
      .locator("#workspace-synthesis-question")
      .fill("Compare the synthetic finding");
    await page.locator("#workspace-synthesis-prepare").click();
    await expect
      .poll(() => page.locator("#workspace-synthesis-status").textContent())
      .toContain("已固定 1 项");
    expect(env.modelCalls).toBe(0);
    await page.locator("[data-paper]").click();
    await page.getByRole("button", { name: "分析", exact: true }).click();
    await page.locator("#op-confirm").click();
    await expect
      .poll(() => page.locator("#op-status").textContent())
      .toContain("已提交 1 项");
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
    await page.locator("#op-results [data-task]").click();
    await page
      .getByRole("button", { name: "打开单篇知识分析结果", exact: true })
      .click();
    expect(new URL(page.url()).searchParams.get("knowledge")).toBeTruthy();
    await expect
      .poll(() => page.locator("#reader-body").textContent())
      .toContain("A synthetic finding.");
    await page
      .locator("#reader-body")
      .getByRole("button", { name: "展开证据" })
      .first()
      .click();
    await expect
      .poll(() => page.locator("#reader-body").textContent())
      .toContain("已读取完整证据");
    expect(env.modelCalls).toBe(callsAfterAnalysis);
    await page.getByRole("button", { name: "核验身份", exact: true }).click();
    await page.locator("#op-confirm").click();
    await expect
      .poll(() => page.locator("#op-status").textContent())
      .toContain("已提交 1 项");
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
    await expect
      .poll(() => page.locator("#reader-info").textContent())
      .toContain("文章身份有证据支持");
    await page.locator('[data-rm="know"]').click();
    await expect
      .poll(() =>
        page
          .locator("#reader-body .vbar button")
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
