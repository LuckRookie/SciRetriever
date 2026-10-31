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
  readerOperation,
  runSummaryFromReader,
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
import { parseDocumentRequest } from "@sciretriever/contracts";

/**
 * The Web has no separate parse action (archiving parses first); raw parsing
 * stays a processing operation, submitted and run here directly.
 */
async function runRawParse(
  app: Awaited<ReturnType<typeof coreProcessingFixture>>["app"],
  source: { literature_id: string; asset_id: string; asset_sha256: string },
  key: string,
) {
  const job = await app.processingTasks!.submit({
    schema_version: 1,
    idempotency_key: key,
    operations: [
      {
        operation: "parse-documents",
        request: parseDocumentRequest({ ...source, force: false }),
      },
    ],
  });
  await app.processingTasks!.run(job.job_id);
  return job.job_id;
}

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
    page.setDefaultTimeout(20_000);
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
    // Choose this paper in the library, then hand its fixed scope to external delivery.
    await page
      .getByRole("button", { name: /^文献库/ })
      .first()
      .click();
    await page
      .getByRole("checkbox", {
        name: "选择 Synthetic literature workbench",
        exact: true,
      })
      .focus();
    await page.keyboard.press("Space");
    await page
      .getByLabel("主导航")
      .getByRole("button", { name: "算子", exact: true })
      .click();
    await page.getByRole("tab", { name: "算子与规范" }).click();
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
    await page.getByRole("button", { name: "更多", exact: true }).click();
    expect(
      await page
        .getByRole("menuitem", { name: "解析 PDF", exact: true })
        .count(),
    ).toBe(0);
    await page.keyboard.press("Escape");
    expect(env.parseCalls).toBe(0);
    const parseJob = await runRawParse(
      env.app,
      {
        literature_id: env.parseRequest.literature_id,
        asset_id: env.asset.asset_id,
        asset_sha256: env.asset.sha256,
      },
      "journey-raw-parse",
    );
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
        { timeout: 20_000 },
      )
      .toEqual({ status: "completed", failures: [] });
    expect(env.parseCalls).toBe(1);
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
    ).toHaveLength(1);
    expect(
      (await env.app.rawParseStorage!.current(env.asset.asset_id))
        .filter((s) => s.result)
        .map((s) => s.profile),
    ).toEqual(["vlm-engine"]);
    await page.goto(`${server.origin}/?view=task&task=${parseJob}`);
    await expect
      .poll(
        () =>
          page
            .getByRole("region", { name: "任务详情", exact: true })
            .textContent(),
        { timeout: 20_000 },
      )
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
    // A fresh reader load takes ~1.9 s here; the 1 s poll default is too
    // tight right after a navigation.
    await expect
      .poll(() => page.locator(".reading-status:visible").textContent(), {
        timeout: 20_000,
      })
      .toContain("全文已加载");
    await page.getByRole("button", { name: "显示目录", exact: true }).click();
    await page.locator(".reader-outline button").first().click();
    expect(await page.locator(".reader-engine-body").textContent()).toContain(
      "A synthetic finding.",
    );
    expect(env.parseCalls).toBe(3);
    await page
      .getByLabel("主导航")
      .getByRole("button", { name: "快照", exact: true })
      .click();
    await page
      .getByRole("button", { name: "从当前筛选生成快照", exact: true })
      .click();
    await page
      .getByRole("button", { name: "运行算子…", exact: true })
      .waitFor();
    // Background work started here can outlast the 1 s poll default under Full load.
    await expect
      .poll(
        async () =>
          (await env.app.snapshots.list({ after: null, limit: 10 })).items
            .length,
        { timeout: 20_000 },
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
    await runSummaryFromReader(page);
    await expect
      .poll(() => page.getByRole("dialog").textContent())
      .toContain("任务已保存并启动");
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
      .poll(() => page.locator(".reader-summary-scroll").textContent(), {
        timeout: 20_000,
      })
      .toContain("A synthetic finding.");
    await page
      .locator(".reader-summary-scroll")
      .getByRole("button", { name: "[1.1]", exact: true })
      .first()
      .click();
    // The cited segment is the finding paragraph; flow X (06ca0af) renders
    // the title as its own section, so the title is no longer in it.
    await expect
      .poll(() => page.locator(".reader-evidence-preview").textContent())
      .toContain("A synthetic finding.");
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
    await readerOperation(page, "核验文章身份");
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
        { timeout: 20_000 },
      )
      .toBe(3);
    await page.reload();
    await expect
      .poll(() => page.locator(".reader-information").textContent(), {
        timeout: 20_000,
      })
      .toContain("已核对：PDF 就是这篇文章");
    await page.getByRole("tab", { name: "结果", exact: true }).click();
    await page.getByRole("button", { name: "阅读总结", exact: true }).click();
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
      const parseJob = analysisModel
        ? await runRawParse(
            w.env.app,
            {
              literature_id: id,
              asset_id: w.env.asset.asset_id,
              asset_sha256: w.env.asset.sha256,
            },
            "reader-raw-parse",
          )
        : null;
      if (!parseJob) {
        await runSummaryFromReader(w.page);
        await expect
          .poll(() => w.page.getByRole("dialog").textContent())
          .toContain("任务已保存并启动");
      }
      const job = (await w.env.app.jobs!.listJobs(10))[0]!;
      // Background work started here can outlast the 1 s poll default under Full load.
      await expect
        .poll(
          async () =>
            (await w.env.app.processingTasks!.read(job.job_id)).job.status,
          { timeout: 20_000 },
        )
        .toBe(analysisModel ? "completed" : "failed");
      if (parseJob)
        await w.page.goto(`${w.origin}/?view=task&task=${parseJob}`);
      else
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
        // A fresh task page load can outlast the 1 s poll default.
        await expect
          .poll(
            () =>
              w.page
                .getByRole("region", { name: "任务详情", exact: true })
                .textContent(),
            { timeout: 20_000 },
          )
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
          .poll(() =>
            w.page
              .getByRole("region", { name: "任务详情", exact: true })
              .textContent(),
          )
          .toContain("保存并重启");
        await w.page
          .getByRole("button", { name: "技术详情", exact: true })
          .first()
          .click();
        expect(
          await w.page
            .getByRole("region", { name: "任务详情", exact: true })
            .textContent(),
        ).toContain("agent-configuration");
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
