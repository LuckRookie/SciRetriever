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
      await expect
        .poll(() => page.locator("#overview-workspace").isVisible())
        .toBe(true);
      await expect
        .poll(() => page.locator("#overview-active").textContent())
        .toContain("当前没有运行中的任务");
      await page.locator("#jobs-tab").click();
      expect(await page.locator("#jobs-workspace").isVisible()).toBe(true);
      await expect
        .poll(() => page.locator("#jobs-list").textContent())
        .toContain("还没有任务");
      expect(await page.locator("#job-policy-summary").textContent()).toContain(
        "重启不会重置已用预算",
      );
      await page.locator("#new-task-button").click();
      await page.locator("#job-attempts").fill("12");
      await page.locator("#job-retries").fill("1");
      await page.locator("#job-assistance").selectOption("pause");
      await page.locator("#job-confirm").check();
      await page.getByRole("button", { name: "创建持久任务" }).click();
      await expect
        .poll(() => page.locator("#job-create-status").textContent())
        .toBe("任务已持久保存。点击执行开始处理。");
      await expect.poll(() => page.locator(".job-list-item").count()).toBe(1);
      await expect
        .poll(() => page.locator("#job-detail").textContent())
        .toContain("已尝试 0/12");
      await expect
        .poll(() => page.locator("#job-detail").textContent())
        .toContain(FIXTURE_LITERATURE.literature_id);
      await page
        .locator("#job-detail")
        .getByRole("button", { name: "暂停" })
        .click();
      await expect
        .poll(() => page.locator("#job-detail").textContent())
        .toContain("等待处理");
      expect(
        await page
          .locator("#job-detail")
          .getByRole("button", { name: "继续" })
          .isEnabled(),
      ).toBe(true);
      await page
        .locator("#job-detail")
        .getByRole("button", { name: "取消" })
        .click();
      await expect
        .poll(() => page.locator("#job-detail").textContent())
        .toContain("已取消");
      expect(
        await page
          .locator("#job-detail > .job-actions > button")
          .evaluateAll((buttons) =>
            buttons.every((button) => (button as HTMLButtonElement).disabled),
          ),
      ).toBe(true);

      await page.locator("#new-task-button").click();
      await page.locator("#job-confirm").check();
      await page.getByRole("button", { name: "创建持久任务" }).click();
      await expect.poll(() => page.locator(".job-list-item").count()).toBe(2);
      const runButton = page
        .locator("#job-detail")
        .getByRole("button", { name: "执行" });
      await runButton.click();
      await expect
        .poll(() => page.locator("#job-detail").textContent())
        .toContain("执行未能开始");
      expect(await runButton.isEnabled()).toBe(true);

      runGate = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      await runButton.evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
      await expect.poll(() => runCalls).toBe(2);
      releaseRun();
      await expect
        .poll(() => page.locator("#job-detail > .live-eyebrow").textContent())
        .toBe("已完成");
      expect(
        await page
          .locator("#job-detail > .job-actions > button")
          .evaluateAll((buttons) =>
            buttons.every((button) => (button as HTMLButtonElement).disabled),
          ),
      ).toBe(true);

      const completedId = new URL(page.url()).searchParams.get("job")!;
      await page.reload();
      await expect
        .poll(() => page.locator("#job-detail").textContent())
        .toContain(completedId);
      await expect
        .poll(() => page.locator("#job-detail > .live-eyebrow").textContent())
        .toBe("已完成");
      await page.locator("#overview-tab").click();
      await expect
        .poll(() => page.locator("#overview-recent").textContent())
        .toContain("已完成");
      await page
        .locator('#overview-recent button[data-status="completed"]')
        .first()
        .click();
      await expect
        .poll(() => page.locator("#job-detail").textContent())
        .toContain(completedId);
      await page.getByRole("tab", { name: "结果与材料" }).click();
      await page
        .getByRole("button", { name: "查看文献与结果", exact: true })
        .click();
      await expect
        .poll(() => page.locator("#library-workspace").isVisible())
        .toBe(true);
      expect(new URL(page.url()).searchParams.get("job")).toBe(completedId);
      await page.goBack();
      await expect
        .poll(() => page.locator("#jobs-workspace").isVisible())
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
          return;
        }
        await route.continue();
      };
      await page.route("**/api/tasks?limit=100*", staleRoute);
      await page.locator("#jobs-refresh").click();
      await staleRequest;
      await page.locator("#jobs-refresh").click();
      await expect.poll(() => page.locator(".job-list-item").count()).toBe(2);
      releaseStale();
      await expect.poll(() => listCalls).toBeGreaterThanOrEqual(2);
      await expect.poll(() => page.locator(".job-list-item").count()).toBe(2);
      await page.unroute("**/api/tasks?limit=100*", staleRoute);

      await page.route(
        "**/api/tasks?limit=100*",
        (route) => route.fulfill({ status: 503, json: { code: "fixture" } }),
        { times: 1 },
      );
      await page.locator("#jobs-refresh").click();
      await expect
        .poll(() => page.locator("#jobs-list").textContent())
        .toContain("无法读取任务队列");
      await page.locator("#jobs-refresh").click();
      await expect.poll(() => page.locator(".job-list-item").count()).toBe(2);
      expect(
        await application.jobs!.listTargets(
          (await application.jobs!.listJobs())[0]!.job_id,
        ),
      ).toHaveLength(1);
      const olderActive = await application.jobService!.create({
        target_kind: "selector",
        goal: "pdf",
        selector: {
          kind: "literatures",
          literature_ids: [FIXTURE_LITERATURE.literature_id],
        },
        policy_version: "history-fixture",
        policy: { mode: "never", max_retries: 0 },
        idempotency_key: "history-active-before-completed-history",
      });
      for (let index = 0; index < 102; index += 1) {
        const history = await application.jobService!.create({
          target_kind: "selector",
          goal: "pdf",
          selector: {
            kind: "literatures",
            literature_ids: [FIXTURE_LITERATURE.literature_id],
          },
          policy_version: "history-fixture",
          policy: { mode: "never", max_retries: 0 },
          idempotency_key: `history-fixture-${index}`,
        });
        await application.queue!.cancel(history.job_id);
      }
      await page.locator("#overview-tab").click();
      await expect
        .poll(() =>
          page.locator('#overview-active button[data-status="queued"]').count(),
        )
        .toBe(1);
      await page
        .locator('#overview-active button[data-status="queued"]')
        .click();
      expect(new URL(page.url()).searchParams.get("job")).toBe(
        olderActive.job_id,
      );
      await page.locator("#jobs-refresh").click();
      await expect.poll(() => page.locator(".job-list-item").count()).toBe(100);
      await page.locator("#jobs-more").click();
      await expect.poll(() => page.locator(".job-list-item").count()).toBe(105);
      expect(await page.locator("#jobs-more").isHidden()).toBe(true);
      await application.jobService!.create({
        target_kind: "selector",
        goal: "pdf",
        selector: {
          kind: "literatures",
          literature_ids: [FIXTURE_LITERATURE.literature_id],
        },
        policy_version: "history-fixture",
        policy: { mode: "never", max_retries: 0 },
        idempotency_key: "history-new-arrival",
      });
      await page.locator("#jobs-refresh").click();
      await expect.poll(() => page.locator(".job-list-item").count()).toBe(106);
      const loaded = await page
        .locator(".job-list-item small")
        .allTextContents();
      expect(new Set(loaded).size).toBe(106);
      expect(loaded).toContain(completedId);
      await page.locator("#jobs-search").fill(completedId);
      await expect.poll(() => page.locator(".job-list-item").count()).toBe(1);
      await page.locator("#jobs-search").fill("");
      await expect.poll(() => page.locator(".job-list-item").count()).toBe(106);
      expect(errors).toEqual([]);
      await page.setViewportSize({ width: 390, height: 844 });
      const overflow = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("body *")]
          .filter((element) => {
            if (element.closest("[inert]")) return false;
            const box = element.getBoundingClientRect();
            return box.right > window.innerWidth + 1 || box.left < -1;
          })
          .map((element) => ({
            id: element.id,
            className: element.className,
            tag: element.tagName,
            left: element.getBoundingClientRect().left,
            right: element.getBoundingClientRect().right,
            scrollWidth: element.scrollWidth,
          })),
      );
      expect(overflow).toEqual([]);
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
      await page.goto(server.origin);
      await page.locator("#new-task-button").click();
      await page.locator("#job-goal").selectOption("processing");
      await page.locator("#job-processing-json").fill(
        JSON.stringify({
          schema_version: 1,
          idempotency_key: "web-partial-processing",
          operations: [
            { operation: "parse-documents", request: env.parseRequest },
            { operation: "parse-documents", request: env.parseRequest },
          ],
        }),
      );
      await page.locator("#job-confirm").check();
      await page.getByRole("button", { name: "创建持久任务" }).click();
      await expect
        .poll(() => page.locator("#job-detail").textContent())
        .toContain("解析 PDF · 2 项");
      expect(env.parseCalls).toBe(0);
      const jobId = (await env.app.jobs!.listJobs())[0]!.job_id;
      await page
        .locator("#job-detail")
        .getByRole("button", { name: "执行", exact: true })
        .click();
      await expect
        .poll(
          async () => (await env.app.processingTasks!.read(jobId)).job.status,
        )
        .toBe("failed");
      await page.locator("#jobs-refresh").click();
      await expect
        .poll(() => page.locator("#job-detail").textContent())
        .toContain("1/2 项已完成");
      await page.getByRole("tab", { name: "结果与材料" }).click();
      await expect
        .poll(() => page.locator("#task-detail-panel").textContent())
        .toContain("结果已保存");
      await expect
        .poll(() => page.locator("#task-detail-panel").textContent())
        .toContain("失败与缺口（1）");
      const firstResult = (await env.app.processingTasks!.read(jobId))
        .results[0];
      await page.reload();
      await expect
        .poll(() => page.locator("#job-detail").textContent())
        .toContain("1/2 项已完成");
      await page
        .locator("#job-detail")
        .getByRole("button", { name: "重试未完成项" })
        .click();
      await expect
        .poll(
          async () => (await env.app.processingTasks!.read(jobId)).job.status,
        )
        .toBe("completed");
      await page.locator("#jobs-refresh").click();
      await expect
        .poll(() => page.locator("#job-detail").textContent())
        .toContain("2/2 项已完成");
      const result = await env.app.processingTasks!.read(jobId);
      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toEqual(firstResult);
      expect(env.parseCalls).toBe(3);
      await page.getByRole("tab", { name: "活动记录" }).click();
      await expect
        .poll(() => page.locator("#task-detail-panel").textContent())
        .toContain("processing-result");
      await page.locator("#new-task-button").click();
      await page.locator("#job-goal").selectOption("processing");
      await page.locator("#job-processing-json").fill(
        JSON.stringify({
          schema_version: 1,
          idempotency_key: "web-pause-resume",
          operations: [
            { operation: "parse-documents", request: env.parseRequest },
          ],
        }),
      );
      await page.locator("#job-confirm").check();
      await page.getByRole("button", { name: "创建持久任务" }).click();
      await expect
        .poll(() => page.locator("#job-detail > .live-eyebrow").textContent())
        .toBe("等待执行");
      const resumedId = new URL(page.url()).searchParams.get("job")!;
      await page
        .locator("#job-detail")
        .getByRole("button", { name: "暂停", exact: true })
        .click();
      await expect
        .poll(() => page.locator("#job-detail > .live-eyebrow").textContent())
        .toBe("等待处理");
      expect(env.parseCalls).toBe(3);
      await page
        .locator("#job-detail")
        .getByRole("button", { name: "继续", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await env.app.processingTasks!.read(resumedId)).job.status,
        )
        .toBe("completed");
      await page.locator("#jobs-refresh").click();
      await expect
        .poll(() => page.locator("#job-detail > .live-eyebrow").textContent())
        .toBe("已完成");
      expect(env.parseCalls).toBe(4);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator("#mobile-navigation").click();
      await page.keyboard.press("Escape");
      expect(
        await page
          .locator("#workspace-navigation")
          .evaluate((element) => (element as HTMLElement).inert),
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
      await session.close();
      await env.close();
    }
  }, 30000);
});
