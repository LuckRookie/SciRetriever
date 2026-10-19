import {
  workbenchTestAccess,
  loginWorkbenchPage,
} from "../../server/test/workbench-auth-fixture.js";
import { readingAssets } from "./reading-assets-fixture.js";
import {
  motionOptions,
  nextAssets,
  nextWorkspace,
} from "./next-workspace-fixture.js";
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
  const assets = new Map<string, WorkbenchStaticAsset>(await readingAssets());
  for (const [path, value] of await nextAssets()) assets.set(path, value);
  const server = await startWorkbenchHttp({
    access: workbenchTestAccess,
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
    ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
      ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
      : {}),
    headless: true,
  });
  try {
    const page = await browser.newPage({
      ...motionOptions(),
      viewport: { width: 1440, height: 1000 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(5000);
    await loginWorkbenchPage(page, server.origin);
    await page.goto(server.origin + "/");
    await page.locator(".paper-row .paper-open").click();
    await page
      .locator('.reading-pdf-page[data-rendered="true"]')
      .first()
      .waitFor();
    expect(await page.locator(".textLayer").first().textContent()).toContain(
      "Synthetic",
    );
    expect(env.parseCalls).toBe(0);
    expect(env.modelCalls).toBe(0);
    expect(await env.app.jobs!.listJobs(10)).toHaveLength(0);
    await page.getByRole("button", { name: "更多", exact: true }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "下载已核验的原始 PDF" }).click();
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/u);
    await page.getByRole("button", { name: "加入提取", exact: true }).click();
    await page.getByRole("tab", { name: "外部交付" }).click();
    await page
      .getByRole("button", { name: "使用库中选定范围", exact: true })
      .click();
    await expect
      .poll(async () =>
        JSON.parse(
          await page
            .getByRole("textbox", { name: "显式输入 JSON 数组" })
            .inputValue(),
        ),
      )
      .toMatchObject([
        {
          literature_id: env.parseRequest.literature_id,
          asset_sha256: env.asset.sha256,
        },
      ]);
    await page
      .locator(".paper-tab")
      .getByRole("button", {
        name: "Synthetic literature workbench",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "解析", exact: true }).click();
    expect(env.parseCalls).toBe(0);
    await page.getByRole("button", { name: "确认启动", exact: true }).click();
    await expect
      .poll(() => page.getByRole("dialog").textContent())
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
    await page.getByRole("button", { name: "查看任务", exact: true }).click();
    await page
      .getByRole("button", { name: "打开解析 PDF结果", exact: true })
      .click();
    await expect
      .poll(() => page.locator(".reading-status:visible").textContent())
      .toContain("全文已加载");
    expect(new URL(page.url()).searchParams.get("document")).toBeTruthy();
    await page.getByRole("button", { name: "显示目录", exact: true }).click();
    await page.locator(".reader-outline button").first().click();
    expect(await page.locator(".reader-engine-body").textContent()).toContain(
      "A synthetic finding.",
    );
    expect(env.parseCalls).toBe(1);
    await page.getByRole("button", { name: "加入综合", exact: true }).click();
    await page.getByRole("button", { name: "新建综合", exact: true }).click();
    await page
      .getByRole("textbox", { name: "研究问题" })
      .fill("Compare the synthetic finding");
    await page.getByRole("button", { name: "固定输入", exact: true }).click();
    await expect
      .poll(() => page.getByRole("dialog").textContent())
      .toContain("已固定 1 项");
    expect(env.modelCalls).toBe(0);
    await page.keyboard.press("Escape");
    expect(
      await page.locator(".workspace-tabs").textContent(),
      page.url(),
    ).toContain("Synthetic literature workbench");
    await page
      .locator(".paper-tab")
      .getByRole("button", {
        name: "Synthetic literature workbench",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "分析", exact: true }).click();
    await page.getByRole("button", { name: "确认启动", exact: true }).click();
    await expect
      .poll(() => page.getByRole("dialog").textContent())
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
    await page.getByRole("button", { name: "查看任务", exact: true }).click();
    await page
      .getByRole("button", { name: "打开单篇知识分析结果", exact: true })
      .click();
    expect(new URL(page.url()).searchParams.get("knowledge")).toBeTruthy();
    await expect
      .poll(() => page.locator(".reader-summary-scroll").textContent())
      .toContain("A synthetic finding.");
    await page
      .locator(".reader-summary-scroll")
      .getByRole("button", { name: "[1]", exact: true })
      .first()
      .click();
    await expect
      .poll(() => page.locator(".reader-evidence-preview").textContent())
      .toContain("# Synthetic literature workbench");
    expect(env.modelCalls).toBe(callsAfterAnalysis);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "核验身份", exact: true }).click();
    await page.getByRole("button", { name: "确认启动", exact: true }).click();
    await expect
      .poll(() => page.getByRole("dialog").textContent())
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
      .poll(() => page.locator(".reader-information").textContent())
      .toContain("文章身份有证据支持");
    await page.getByRole("tab", { name: "总结", exact: true }).click();
    await expect
      .poll(() => page.locator(".reader-summary-scroll").textContent())
      .toContain("A synthetic finding.");
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

it.each([true, false])(
  "preserves explicit reparse publication and missing-model recovery (%s)",
  async (analysisModel) => {
    const w = await nextWorkspace({ analysisModel });
    try {
      const id = w.env.parseRequest.literature_id;
      w.env.setText("# Revised fixture\nThe NEWLY PARSED text is different.\n");
      await w.page.goto(`${w.origin}/?literature=${id}&reader=doc`);
      await w.page
        .getByRole("button", {
          name: analysisModel ? "解析" : "分析",
          exact: true,
        })
        .click();
      await w.page
        .getByRole("button", { name: "确认启动", exact: true })
        .click();
      await expect
        .poll(() => w.page.getByRole("dialog").textContent())
        .toContain("已提交 1 项");
      const job = (await w.env.app.jobs!.listJobs(10))[0]!;
      await expect
        .poll(
          async () =>
            (await w.env.app.processingTasks!.read(job.job_id)).job.status,
        )
        .toBe(analysisModel ? "completed" : "failed");
      await w.page
        .getByRole("button", { name: "查看任务", exact: true })
        .click();
      if (analysisModel) {
        const current = await w.env.app.documentRead.default({
          literature_id: id,
          asset_id: w.env.asset.asset_id,
          asset_sha256: w.env.asset.sha256,
        });
        expect(current.default!.document_version_id).not.toBe(
          w.parsed.document.document_version_id,
        );
        await expect
          .poll(() => w.page.getByRole("dialog").textContent())
          .toContain("已设为默认全文");
        await w.page
          .getByRole("button", { name: "打开解析 PDF结果", exact: true })
          .click();
        await expect
          .poll(() => w.page.locator(".reading-article").textContent())
          .toContain("NEWLY PARSED");
      } else {
        await expect
          .poll(() => w.page.getByRole("dialog").textContent())
          .toContain("保存并重启");
        await w.page
          .getByRole("button", { name: "技术详情", exact: true })
          .first()
          .click();
        expect(await w.page.getByRole("dialog").textContent()).toContain(
          "knowledge-unconfigured",
        );
        await w.page
          .getByRole("button", { name: "前往模型设置", exact: true })
          .click();
        expect(new URL(w.page.url()).searchParams.get("setting")).toBe(
          "models",
        );
        expect(w.env.modelCalls).toBe(0);
      }
      expect(w.errors).toEqual([]);
    } finally {
      await w.close();
    }
  },
  60000,
);
