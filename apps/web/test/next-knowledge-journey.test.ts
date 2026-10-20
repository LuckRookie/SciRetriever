import { showAllLibraryStatuses } from "./next-workspace-fixture.js";
import { FIXTURE_DOI } from "../../server/src/workbench/synthetic-fixture.js";
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
import { processorFixture as coreProcessingFixture } from "../../server/test/processor-fixture.js";
import { createQueryApplication } from "../../server/src/bootstrap/application.js";
import {
  taskHttpAdapters,
  processorHttpAdapters,
} from "../../server/src/bootstrap/workbench.js";
import {
  startWorkbenchHttp,
  type WorkbenchStaticAsset,
} from "../../server/src/workbench/http.js";
import { ProductionWorkbenchSession } from "../../server/src/workbench/production-session.js";

it("keeps parsing separate from document publication and reads existing verified knowledge in the authenticated workspace", async () => {
  const env = await coreProcessingFixture();
  env.setText(
    `# Synthetic literature workbench\nDOI: ${FIXTURE_DOI}\nA synthetic finding.`,
  );
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
    query: {
      application: query,
      maintenance: env.app.maintenance!,
      ...processorHttpAdapters(env.app),
    },
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
    await showAllLibraryStatuses(page);
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
    await page.getByRole("tab", { name: "规范与外部交付" }).click();
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
    expect(env.parseCalls).toBe(2);
    expect(env.modelCalls).toBe(0);
    expect(
      (
        await env.app.documentRead.default({
          literature_id: env.parseRequest.literature_id,
          asset_id: env.asset.asset_id,
          asset_sha256: env.asset.sha256,
        })
      ).default,
    ).toBeNull();
    expect(
      (await env.app.rawParseStorage!.current(env.asset.asset_id)).filter(
        (s) => s.result,
      ),
    ).toHaveLength(2);
    await page.getByRole("button", { name: "查看任务", exact: true }).click();
    await expect
      .poll(() => page.getByRole("dialog").textContent())
      .toContain("各模式的解析结果");
    expect(
      await page
        .getByRole("button", { name: "打开解析 PDF结果", exact: true })
        .count(),
    ).toBe(0);
    // Existing-version reading is independent of the now raw-only parsing boundary.
    const seeded = await env.build(env.parseRequest);
    await page.goto(
      `${server.origin}/?literature=${env.parseRequest.literature_id}&reader=doc&document=${seeded.document.document_version_id}`,
    );
    await expect
      .poll(() => page.locator(".reading-status:visible").textContent())
      .toContain("全文已加载");
    await page.getByRole("button", { name: "显示目录", exact: true }).click();
    await page.locator(".reader-outline button").first().click();
    expect(await page.locator(".reader-engine-body").textContent()).toContain(
      "A synthetic finding.",
    );
    expect(env.parseCalls).toBe(4);
    await page.getByRole("button", { name: "加入综合", exact: true }).click();
    await page
      .getByRole("button", { name: "从当前筛选生成快照", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "综合问题" })
      .fill("Compare the synthetic finding");
    await expect
      .poll(
        async () =>
          (await env.app.snapshots.list({ after: null, limit: 10 })).items
            .length,
      )
      .toBe(1);
    expect(env.modelCalls).toBe(0);
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
      .toContain("总结任务已提交");
    await page.getByRole("button", { name: "查看任务", exact: true }).click();
    await page
      .getByRole("button", { name: "查看本次结果", exact: true })
      .waitFor();
    const summaries = (await env.app.processorRead!.list()).items.filter(
      (result) => result.processor_id === "summary",
    );
    expect(summaries).toHaveLength(1);
    const callsAfterAnalysis = env.modelCalls;
    await page.goto(
      `${server.origin}/?literature=${env.parseRequest.literature_id}&reader=know&result=${summaries[0]!.result_id}&resultHash=${summaries[0]!.content_sha256}`,
    );
    await expect
      .poll(() => page.locator(".reader-summary-scroll").textContent())
      .toContain("A synthetic finding.");
    await page
      .locator(".reader-summary-scroll")
      .getByRole("button", { name: "[1.1]", exact: true })
      .first()
      .click();
    await expect
      .poll(() => page.locator(".reader-evidence-preview").textContent())
      .toContain("Synthetic literature workbench");
    expect(env.modelCalls).toBe(callsAfterAnalysis);
    await page.keyboard.press("Escape");
    env.setModel((input) => {
      const segment = input.segments!.find((s) => s.text.includes("DOI:"))!;
      return {
        document_kind: "article",
        fields: [
          {
            field: "doi",
            value: FIXTURE_DOI,
            quote: `DOI: ${FIXTURE_DOI}`,
            segment_id: segment.segment_id,
          },
        ],
      };
    });
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
  "preserves the default document during raw parsing and supports missing-model recovery (%s)",
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
        .toContain(analysisModel ? "已提交 1 项" : "总结任务已提交");
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
        expect(current.default!.document_version_id).toBe(
          w.parsed.document.document_version_id,
        );
        await expect
          .poll(() => w.page.getByRole("dialog").textContent())
          .toContain("各模式的解析结果");
        expect(
          await w.page
            .getByRole("button", { name: "打开解析 PDF结果", exact: true })
            .count(),
        ).toBe(0);
        const raw = (
          await w.env.app.rawParseStorage!.current(w.env.asset.asset_id)
        ).find((s) => s.profile === "vlm-engine")!.result!;
        expect(
          Buffer.from(
            await w.env.app.rawParseStorage!.readArtifact(
              raw.raw_parse_id,
              "markdown",
            ),
          ).toString(),
        ).toContain("The measured energy was 4.2 eV.");
        expect(w.env.parseCalls).toBe(w.setupCalls.parser);
      } else {
        await expect
          .poll(() => w.page.getByRole("dialog").textContent())
          .toContain("保存并重启");
        await w.page
          .getByRole("button", { name: "技术详情", exact: true })
          .first()
          .click();
        expect(await w.page.getByRole("dialog").textContent()).toContain(
          "agent-configuration",
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
