import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { createApplication } from "../../server/src/bootstrap/application.js";
import { coreProcessingFixture } from "../../server/test/core-processing-fixture.js";
import { taskHttpAdapters } from "../../server/src/bootstrap/workbench.js";
import { TypeScriptConfigurationOwner } from "../../server/src/configuration/owner.js";
import {
  startWorkbenchHttp,
  type WorkbenchStaticAsset,
} from "../../server/src/workbench/http.js";
import { WorkbenchSession } from "../../server/src/workbench/session.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";

async function taskAssets(): Promise<Map<string, WorkbenchStaticAsset>> {
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
  const bundled = await build({
    entryPoints: [new URL("../src/live.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  assets.set("/live.js", {
    contentType: "text/javascript",
    body: bundled.outputFiles[0]!.contents,
  });
  return assets;
}

describe("durable task workbench", () => {
  it("recovers empty, failed, stale, cancelled and completed task states", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-jobs-ui-"));
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    await application.database.putLiterature(FIXTURE_LITERATURE);
    const session = new WorkbenchSession(
      FIXTURE_LITERATURE.literature_id,
      {
        id: "jobs-ui-page",
        title: async () => "Task fixture",
        url: () => "http://127.0.0.1/task-fixture",
        close: async () => {},
        snapshot: async () => ({
          document_generation: 1,
          url: "http://127.0.0.1/task-fixture",
          title: "Task fixture",
          viewport: { width: 800, height: 600, device_scale_factor: 1 },
          screenshot: null,
        }),
        apply: async () => {},
      },
      {
        max_actions: 2,
        max_model_calls: 1,
        max_retries: 1,
        max_bytes: 1024,
        deadline_ms: 10_000,
      },
    );
    await session.refresh();
    const configuration = new TypeScriptConfigurationOwner(home);
    const assets = await taskAssets();
    let failNextRun = true;
    let runCalls = 0;
    let releaseRun!: () => void;
    let runGate = Promise.resolve();
    const adapters = taskHttpAdapters(application);
    const server = await startWorkbenchHttp({
      session,
      configuration,
      library: {
        queries: application.library,
        artifacts: application.literatureArtifacts,
      },
      ...adapters,
      tasks: {
        ...adapters.tasks!,
        start: async (jobId) => {
          runCalls += 1;
          if (failNextRun) {
            failNextRun = false;
            throw new Error("synthetic run failure");
          }
          await runGate;
          await application.queue!.runUntilIdle(jobId, async () => "completed");
          return { started: true, task: await application.jobs!.getJob(jobId) };
        },
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
        viewport: { width: 1280, height: 900 },
      });
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(server.origin);
      await expect.poll(() => page.locator(".prow").count()).toBe(1);
      await page.locator("#jobs-tab").click();
      await expect
        .poll(() => page.locator("#tasks-list").textContent())
        .toContain("当前没有任务");
      const create = async () => {
        await page.locator("#library-tab").click();
        await page.locator("#ckAll").check();
        await page.locator('[data-op="acquire"]').click();
        await page.locator("#overlay summary").click();
        await page.locator("#acquire-attempts").fill("12");
        await page.locator("#acquire-retries").fill("1");
        await page.locator("#acquire-policy").selectOption("pause");
        await page.locator("#acquire-start").uncheck();
        await page.locator("#op-confirm").click();
        await expect
          .poll(() => page.locator("#op-status").textContent())
          .toBe("任务已保存");
        await page.locator("#op-results [data-task]").click();
        await expect
          .poll(() => page.locator("#task-content").textContent())
          .toContain("已尝试 0/12");
      };
      const control = (name: string) =>
        page
          .locator("#task-controls")
          .getByRole("button", { name, exact: true });
      await create();
      expect(runCalls).toBe(0);
      await control("暂停").click();
      await expect
        .poll(() => page.locator("#task-content").textContent())
        .toContain("等待处理");
      expect(await control("继续").isEnabled()).toBe(true);
      await control("取消").click();
      await expect
        .poll(() => page.locator("#task-content").textContent())
        .toContain("已取消");
      expect(await page.locator("#task-controls button").count()).toBe(0);
      await create();
      await control("启动").click();
      await expect
        .poll(() => page.locator(".toast").textContent())
        .toContain("command-rejected");
      expect(await control("启动").isEnabled()).toBe(true);
      runGate = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      await control("启动").evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
      await expect.poll(() => runCalls).toBe(2);
      releaseRun();
      await expect
        .poll(() => page.locator("#task-content > .tag").textContent())
        .toBe("已完成");
      expect(await page.locator("#task-controls button").count()).toBe(0);
      const completedId = new URL(page.url()).searchParams.get("task")!;
      await page.reload();
      await expect
        .poll(() => page.locator("#task-content").textContent())
        .toContain(completedId);
      await page.locator("#actBtn").click();
      await expect
        .poll(() => page.locator("#activity-list").textContent())
        .toContain("已完成");
      await page.locator(`#activity-list [data-task="${completedId}"]`).click();
      await page
        .locator("#task-content")
        .getByRole("button", { name: "打开文献", exact: true })
        .click();
      await expect
        .poll(() => page.locator("#reader-info h2").textContent())
        .toContain("Synthetic literature");
      expect(new URL(page.url()).searchParams.get("task")).toBe(completedId);
      await page.goBack();
      await expect
        .poll(() => page.locator('[data-page="task"]').isVisible())
        .toBe(true);
      let releaseStale!: () => void;
      let staleStarted!: () => void;
      const staleGate = new Promise<void>((resolve) => {
        releaseStale = resolve;
      });
      const staleRequest = new Promise<void>((resolve) => {
        staleStarted = resolve;
      });
      let listCalls = 0;
      const staleRoute = async (route: import("playwright").Route) => {
        listCalls += 1;
        if (listCalls === 1) {
          staleStarted();
          await staleGate;
          await route.fulfill({ json: { tasks: [] } });
        } else await route.continue();
      };
      await page.route("**/api/tasks?limit=100*", staleRoute);
      await page.locator("#tasks-refresh").click();
      await staleRequest;
      await page.locator("#tasks-refresh").click();
      await expect
        .poll(() => page.locator("#tasks-list [data-task]").count())
        .toBe(2);
      releaseStale();
      await expect.poll(() => listCalls).toBeGreaterThanOrEqual(2);
      await expect
        .poll(() => page.locator("#tasks-list [data-task]").count())
        .toBe(2);
      await page.unroute("**/api/tasks?limit=100*", staleRoute);
      await page.route(
        "**/api/tasks?limit=100*",
        (route) => route.fulfill({ status: 503, json: { code: "fixture" } }),
        { times: 1 },
      );
      await page.locator("#tasks-refresh").click();
      await expect
        .poll(() => page.locator("#tasks-list").textContent())
        .toContain("暂时无法读取");
      await page.locator("#tasks-refresh").click();
      await expect
        .poll(() => page.locator("#tasks-list [data-task]").count())
        .toBe(2);
      expect(
        await application.jobs!.listTargets(
          (await application.jobs!.listJobs())[0]!.job_id,
        ),
      ).toHaveLength(1);
      const createHistory = (key: string) =>
        application.jobService!.create({
          target_kind: "selector",
          goal: "pdf",
          selector: {
            kind: "literatures",
            literature_ids: [FIXTURE_LITERATURE.literature_id],
          },
          policy_version: "history-fixture",
          policy: { mode: "never", max_retries: 0 },
          idempotency_key: key,
        });
      const olderActive = await createHistory(
        "history-active-before-completed-history",
      );
      for (let index = 0; index < 102; index += 1)
        await application.queue!.cancel(
          (await createHistory(`history-fixture-${index}`)).job_id,
        );
      await page.locator("#actBtn").click();
      await expect
        .poll(() =>
          page
            .locator(`#activity-list [data-task="${olderActive.job_id}"]`)
            .count(),
        )
        .toBe(1);
      await page
        .locator(`#activity-list [data-task="${olderActive.job_id}"]`)
        .click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get("task"))
        .toBe(olderActive.job_id);
      await page.locator("#tasks-refresh").click();
      await expect
        .poll(() => page.locator("#tasks-list [data-task]").count())
        .toBe(100);
      await page.locator("#tasks-more").click();
      await expect
        .poll(() => page.locator("#tasks-list [data-task]").count())
        .toBe(105);
      expect(await page.locator("#tasks-more").isHidden()).toBe(true);
      await createHistory("history-new-arrival");
      await page.locator("#tasks-refresh").click();
      await expect
        .poll(() => page.locator("#tasks-list [data-task]").count())
        .toBe(106);
      const loaded = await page
        .locator("#tasks-list [data-task]")
        .evaluateAll((rows) =>
          rows.map((row) => (row as HTMLElement).dataset.task),
        );
      expect(new Set(loaded).size).toBe(106);
      expect(loaded).toContain(completedId);
      await page.locator("#tasks-search").fill(completedId);
      await expect
        .poll(() => page.locator("#tasks-list [data-task]").count())
        .toBe(1);
      await page.locator("#tasks-search").fill("");
      await expect
        .poll(() => page.locator("#tasks-list [data-task]").count())
        .toBe(106);
      expect(errors).toEqual([]);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
    } finally {
      await browser.close();
      await server.close();
      await session.close();
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 30000);
  it("submits fixed processing operations, preserves partial results on failure and retries only the missing operation", async () => {
    const env = await coreProcessingFixture();
    env.setParseHook(async () => {
      if (env.parseCalls === 2)
        throw new Error("synthetic transient parser failure");
    });
    const session = new WorkbenchSession(
      FIXTURE_LITERATURE.literature_id,
      {
        id: "processing-ui-page",
        title: async () => "Processing fixture",
        url: () => "http://127.0.0.1/processing-fixture",
        close: async () => {},
        snapshot: async () => ({
          document_generation: 1,
          url: "http://127.0.0.1/processing-fixture",
          title: "Processing fixture",
          viewport: { width: 800, height: 600, device_scale_factor: 1 },
          screenshot: null,
        }),
        apply: async () => {},
      },
      {
        max_actions: 2,
        max_model_calls: 1,
        max_retries: 1,
        max_bytes: 1024,
        deadline_ms: 10_000,
      },
    );
    await session.refresh();
    const server = await startWorkbenchHttp({
      session,
      configuration: new TypeScriptConfigurationOwner(env.home),
      library: {
        queries: env.app.library,
        artifacts: env.app.literatureArtifacts,
      },
      ...taskHttpAdapters(env.app),
      assets: await taskAssets(),
    });
    const browser = await chromium.launch({
      executablePath:
        process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
        "/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
      headless: true,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${server.origin}/?view=ext&advanced=all`);
      const submit = async (key: string, count: number) => {
        await page.locator('[data-go="ext"]').click();
        await page.locator('[data-tools="all"]').click();
        await page
          .locator("details")
          .filter({ has: page.locator("#raw-processing") })
          .locator("summary")
          .click();
        await page.locator("#raw-processing").fill(
          JSON.stringify({
            schema_version: 1,
            idempotency_key: key,
            operations: Array.from({ length: count }, () => ({
              operation: "parse-documents",
              request: env.parseRequest,
            })),
          }),
        );
        await page.locator("#raw-submit").click();
        await page
          .locator("#raw-status")
          .getByRole("button", { name: "查看任务" })
          .click();
        await expect
          .poll(() => page.locator("#task-content > .tag").textContent())
          .toBe("等待执行");
        return new URL(page.url()).searchParams.get("task")!;
      };
      const control = (name: string) =>
        page
          .locator("#task-controls")
          .getByRole("button", { name, exact: true });
      const jobId = await submit("web-partial-processing", 2);
      expect(env.parseCalls).toBe(0);
      await control("启动").click();
      await expect
        .poll(
          async () => (await env.app.processingTasks!.read(jobId)).job.status,
        )
        .toBe("failed");
      await expect
        .poll(() => page.locator("#task-content").textContent(), {
          timeout: 5000,
        })
        .toContain("1/2 项已完成");
      await expect
        .poll(() => page.locator("#task-results").textContent())
        .toContain("失败 1 项");
      const firstResult = (await env.app.processingTasks!.read(jobId))
        .results[0];
      await page.reload();
      await expect
        .poll(() => page.locator("#task-content").textContent())
        .toContain("1/2 项已完成");
      await control("重试").click();
      await expect
        .poll(
          async () => (await env.app.processingTasks!.read(jobId)).job.status,
        )
        .toBe("completed");
      await expect
        .poll(() => page.locator("#task-content").textContent(), {
          timeout: 5000,
        })
        .toContain("2/2 项已完成");
      const result = await env.app.processingTasks!.read(jobId);
      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toEqual(firstResult);
      expect(env.parseCalls).toBe(3);
      expect(await page.locator("#task-content .tl").textContent()).toContain(
        "processing-result",
      );
      const resumedId = await submit("web-pause-resume", 1);
      await control("暂停").click();
      await expect
        .poll(() => page.locator("#task-content > .tag").textContent())
        .toBe("等待处理");
      expect(env.parseCalls).toBe(3);
      await control("继续").click();
      await expect
        .poll(
          async () =>
            (await env.app.processingTasks!.read(resumedId)).job.status,
        )
        .toBe("completed");
      await expect
        .poll(() => page.locator("#task-content > .tag").textContent(), {
          timeout: 5000,
        })
        .toBe("已完成");
      expect(env.parseCalls).toBe(4);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator("#menuBtn").click();
      await page.keyboard.press("Escape");
      expect(
        await page
          .locator("#side")
          .evaluate((element) => element.classList.contains("open")),
      ).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
      await session.close();
      await env.close();
    }
  }, 30000);
});
