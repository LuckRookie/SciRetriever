import {
  selectAllLoaded,
  showAllLibraryStatuses,
} from "./next-workspace-fixture.js";
import {
  workbenchTestAccess,
  loginWorkbenchPage,
} from "../../server/test/workbench-auth-fixture.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextAssets, motionOptions } from "./next-workspace-fixture.js";
import { readingAssets } from "./reading-assets-fixture.js";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import {
  createApplication,
  createQueryApplication,
} from "../../server/src/bootstrap/application.js";
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
  return new Map([...(await readingAssets()), ...(await nextAssets())]);
}

describe("durable task workbench", () => {
  it("recovers empty, failed, stale, cancelled and completed task states", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-jobs-ui-"));
    const application = await createApplication(home, {});
    await application.database.putLiterature(FIXTURE_LITERATURE);
    // The paper is in hand: the library lists the collected papers
    // (ADR 0065 §2, page specs “文献库”).
    await application.database.collectLiteratures([
      FIXTURE_LITERATURE.literature_id,
    ]);
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
    const query = await createQueryApplication(home);
    let failNextRun = true;
    let runCalls = 0;
    let releaseRun!: () => void;
    let runGate = Promise.resolve();
    const adapters = taskHttpAdapters(application);
    const server = await startWorkbenchHttp({
      access: workbenchTestAccess,
      session,
      query: { application: query },
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
      ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    try {
      const page = await browser.newPage({
        ...motionOptions(),
        viewport: { width: 1280, height: 900 },
      });
      page.setDefaultTimeout(20_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await loginWorkbenchPage(page, server.origin);
      await page.goto(`${server.origin}/?view=task`);
      await page.getByText("当前没有任务", { exact: true }).waitFor();
      const drawer = page.getByRole("region", {
        name: "任务详情",
        exact: true,
      });
      const create = async () => {
        // The task detail is a modal drawer; close it before using the shell.
        if (await drawer.isVisible()) {
          await page.keyboard.press("Escape");
          await drawer.waitFor({ state: "hidden" });
        }
        await page
          .getByLabel("主导航", { exact: true })
          .getByRole("button", { name: /文献库/ })
          .click();
        await showAllLibraryStatuses(page);
        await selectAllLoaded(page);
        await page
          .getByRole("region", { name: "文献选择" })
          .getByRole("button", { name: /^获取 PDF \d+$/ })
          .click();
        const form = page.getByRole("dialog", {
          name: "获取 PDF",
          exact: true,
        });
        await form
          .getByRole("button", { name: "高级选项", exact: true })
          .click();
        await form.getByLabel("尝试上限", { exact: true }).fill("12");
        await form.getByLabel("重试上限", { exact: true }).fill("1");
        await form.getByRole("button", { name: /受阻时/ }).click();
        await page
          .getByRole("option", { name: "暂停等待人工", exact: true })
          .click();
        await form
          .getByRole("checkbox", { name: "保存后立即执行", exact: true })
          .press("Space");
        await form.getByRole("button", { name: /^获取 \d+ 篇$/ }).click();
        await form
          .getByRole("button", { name: "查看任务", exact: true })
          .click();
        // The attempt budget is a technical detail, folded away at the end.
        await drawer
          .getByRole("button", { name: "技术详情", exact: true })
          .last()
          .click();
        await expect
          .poll(() => drawer.innerText(), { timeout: 20_000 })
          .toContain("尝试 0 / 12");
      };
      const control = (name: string) =>
        drawer
          .locator(".task-actions")
          .first()
          .getByRole("button", { name, exact: true });
      await create();
      expect(runCalls).toBe(0);
      // Saved and never asked to start: 未启动, with only 启动 and 取消任务.
      await drawer.getByText("未启动", { exact: true }).first().waitFor();
      expect(
        await drawer
          .locator(".task-actions")
          .first()
          .getByRole("button")
          .allTextContents(),
      ).toEqual(["启动", "取消任务"]);
      // Asked to start, it waits its turn (排队中) and can be paused.
      await application.jobs!.requestStart(
        new URL(page.url()).searchParams.get("task")!,
      );
      await drawer
        .getByText("排队中", { exact: true })
        .first()
        .waitFor({ timeout: 20_000 });
      await control("暂停").click();
      await drawer.getByText("等你处理", { exact: true }).first().waitFor();
      expect(await control("继续").isEnabled()).toBe(true);
      await control("取消任务").click();
      await page
        .getByRole("dialog", { name: "取消这个任务？", exact: true })
        .getByRole("button", { name: "取消任务", exact: true })
        .click();
      await drawer.getByText("已取消", { exact: true }).first().waitFor();
      expect(
        await drawer
          .locator(".task-actions")
          .first()
          .getByRole("button")
          .count(),
      ).toBe(0);
      await create();
      await control("启动").click();
      await expect
        .poll(() => drawer.getByRole("alert").allTextContents())
        .toContainEqual(expect.stringContaining("任务操作未被接受"));
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
      await drawer.getByText("已完成", { exact: true }).first().waitFor();
      expect(
        await drawer
          .locator(".task-actions")
          .first()
          .getByRole("button")
          .count(),
      ).toBe(0);
      const completedId = new URL(page.url()).searchParams.get("task")!;
      await page.reload();
      await drawer.getByText("已完成", { exact: true }).first().waitFor();
      expect(new URL(page.url()).searchParams.get("task")).toBe(completedId);
      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "hidden" });
      // No “活动” panel: the task is opened again from its row on the task page.
      expect(await page.getByRole("button", { name: /^活动/ }).count()).toBe(0);
      await page
        .locator(`.task-table [data-task-id="${completedId}"] .task-open`)
        .click();
      await drawer
        .getByRole("button", { name: "打开文献", exact: true })
        .click();
      await page
        .getByRole("navigation", { name: "阅读标签", exact: true })
        .getByRole("button", {
          name: "Synthetic literature workbench",
          exact: true,
        })
        .waitFor();
      expect(new URL(page.url()).searchParams.get("task")).toBe(completedId);
      await page.goBack();
      await drawer.waitFor();
      let releaseStale!: () => void;
      const staleGate = new Promise<void>((resolve) => {
        releaseStale = resolve;
      });
      let listCalls = 0;
      const staleRoute = async (route: import("playwright").Route) => {
        listCalls++;
        if (listCalls === 1) {
          await staleGate;
          await route.fulfill({ json: { tasks: [] } });
        } else await route.continue();
      };
      const listUrl = (url: URL) =>
        url.pathname === "/api/tasks" &&
        url.searchParams.get("limit") === "100" &&
        !url.searchParams.has("status_group") &&
        !url.searchParams.has("cursor");
      await page.route(listUrl, staleRoute);
      await page.getByRole("button", { name: "刷新任务", exact: true }).click();
      await expect.poll(() => listCalls).toBe(1);
      await page.getByRole("button", { name: "已结束", exact: true }).click();
      await expect
        .poll(() => page.locator(".task-table [data-task-id]").count(), {
          timeout: 10_000,
        })
        .toBe(2);
      releaseStale();
      await page.getByRole("button", { name: "全部", exact: true }).click();
      await page.getByRole("button", { name: "刷新任务", exact: true }).click();
      await expect
        .poll(() => page.locator(".task-table [data-task-id]").count(), {
          timeout: 10_000,
        })
        .toBe(2);
      await page.unroute(listUrl, staleRoute);
      const failedList = (route: import("playwright").Route) =>
        route.fulfill({ status: 503, json: { code: "fixture" } });
      await page.route(listUrl, failedList);
      await page.getByRole("button", { name: "刷新任务", exact: true }).click();
      await expect
        .poll(
          () =>
            page.locator(".tasks-page").getByRole("alert").allTextContents(),
          { timeout: 20_000 },
        )
        .toContainEqual(expect.stringContaining("操作未完成"));
      expect(await page.locator(".task-table [data-task-id]").count()).toBe(2);
      await page.unroute(listUrl, failedList);
      await page.getByRole("button", { name: "刷新任务", exact: true }).click();
      await expect
        .poll(() => page.locator(".tasks-page").getByRole("alert").count())
        .toBe(0);
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
      for (let index = 0; index < 102; index++)
        await application.queue!.cancel(
          (await createHistory(`history-fixture-${index}`)).job_id,
        );
      // The task page's “进行中” finds the active task behind 102 newer ones.
      const quick = (name: RegExp) =>
        page.locator(".tasks-page").getByRole("button", { name }).first();
      await quick(/^进行中/u).click();
      await page
        .locator(
          `.task-table [data-task-id="${olderActive.job_id}"] .task-open`,
        )
        .click();
      expect(new URL(page.url()).searchParams.get("task")).toBe(
        olderActive.job_id,
      );
      // Pages of 100 tasks and their re-renders can take longer than the
      // default one-second poll on a loaded machine.
      await quick(/^全部/u).click();
      await page.getByRole("button", { name: "刷新任务", exact: true }).click();
      await expect
        .poll(() => page.locator(".task-table [data-task-id]").count(), {
          timeout: 10_000,
        })
        .toBe(100);
      await page
        .getByRole("button", { name: "加载更多任务", exact: true })
        .click();
      await expect
        .poll(() => page.locator(".task-table [data-task-id]").count(), {
          timeout: 10_000,
        })
        .toBe(105);
      expect(
        await page
          .getByRole("button", { name: "加载更多任务", exact: true })
          .count(),
      ).toBe(0);
      await createHistory("history-new-arrival");
      await page.getByRole("button", { name: "刷新任务", exact: true }).click();
      await expect
        .poll(() => page.locator(".task-table [data-task-id]").count(), {
          timeout: 10_000,
        })
        .toBe(106);
      const loaded = await page
        .locator(".task-table [data-task-id]")
        .evaluateAll((rows) =>
          rows.map((row) => (row as HTMLElement).dataset.taskId),
        );
      expect(new Set(loaded).size).toBe(106);
      expect(loaded).toContain(completedId);
      await page
        .getByRole("searchbox", { name: "筛选任务", exact: true })
        .fill(completedId);
      await expect
        .poll(() => page.locator(".task-table [data-task-id]").count(), {
          timeout: 10_000,
        })
        .toBe(1);
      await page
        .getByRole("searchbox", { name: "筛选任务", exact: true })
        .fill("");
      await expect
        .poll(() => page.locator(".task-table [data-task-id]").count(), {
          timeout: 10_000,
        })
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
      await query.close();
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 90000);
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
    const query = await createQueryApplication(env.home);
    const server = await startWorkbenchHttp({
      access: workbenchTestAccess,
      session,
      query: { application: query },
      configuration: new TypeScriptConfigurationOwner(env.home),
      library: {
        queries: env.app.library,
        artifacts: env.app.literatureArtifacts,
      },
      ...taskHttpAdapters(env.app),
      assets: await taskAssets(),
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
        viewport: { width: 1280, height: 900 },
      });
      page.setDefaultTimeout(20_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await loginWorkbenchPage(page, server.origin);
      const drawer = page.getByRole("region", {
        name: "任务详情",
        exact: true,
      });
      const submit = async (key: string, count: number) => {
        await page.goto(`${server.origin}/?view=set&setting=advanced`);
        await page
          .getByRole("tab", { name: "索引与请求", exact: true })
          .click();
        await page.getByLabel("加工请求 JSON", { exact: true }).fill(
          JSON.stringify({
            schema_version: 1,
            idempotency_key: key,
            operations: Array.from({ length: count }, () => ({
              operation: "parse-documents",
              request: {
                ...env.rawParseRequest,
                profiles: ["pipeline"],
                force: true,
              },
            })),
          }),
        );
        await page
          .getByRole("button", { name: "提交任务", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "提交加工任务？", exact: true })
          .getByRole("button", { name: "提交任务", exact: true })
          .click();
        await page
          .getByRole("button", { name: "查看任务", exact: true })
          .click();
        await drawer.getByText("未启动", { exact: true }).first().waitFor();
        return new URL(page.url()).searchParams.get("task")!;
      };
      const control = (name: string) =>
        drawer
          .locator(".task-actions")
          .first()
          .getByRole("button", { name, exact: true });
      const jobId = await submit("web-partial-processing", 2);
      expect(env.parseCalls).toBe(0);
      await control("启动").click();
      // Background work started here can outlast the 1 s poll default under Full load.
      await expect
        .poll(
          async () => (await env.app.processingTasks!.read(jobId)).job.status,
          { timeout: 20_000 },
        )
        .toBe("failed");
      await expect
        .poll(() => drawer.innerText(), { timeout: 20_000 })
        .toContain("完成 1 项，失败 1 项");
      await drawer
        .getByRole("button", { name: "失败 1 项", exact: true })
        .waitFor();
      const firstResult = (await env.app.processingTasks!.read(jobId))
        .results[0];
      await page.reload();
      await expect
        .poll(() => drawer.innerText(), { timeout: 20_000 })
        .toContain("完成 1 项，失败 1 项");
      await control("重试").click();
      // Background work started here can outlast the 1 s poll default under Full load.
      await expect
        .poll(
          async () => (await env.app.processingTasks!.read(jobId)).job.status,
          { timeout: 20_000 },
        )
        .toBe("completed");
      await expect
        .poll(() => drawer.innerText(), { timeout: 20_000 })
        .toContain("完成 2 项");
      const result = await env.app.processingTasks!.read(jobId);
      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toEqual(firstResult);
      expect(env.parseCalls).toBe(3);
      await drawer
        .getByRole("button", { name: "技术活动记录", exact: true })
        .click();
      expect(await drawer.locator(".task-events").innerText()).toContain(
        "processing-result",
      );
      const resumedId = await submit("web-pause-resume", 1);
      // 未启动 has nothing to pause; once asked to start it is 排队中.
      expect(await control("暂停").count()).toBe(0);
      await env.app.jobs!.requestStart(resumedId);
      await drawer
        .getByText("排队中", { exact: true })
        .first()
        .waitFor({ timeout: 20_000 });
      await control("暂停").click();
      await drawer.getByText("等你处理", { exact: true }).first().waitFor();
      expect(env.parseCalls).toBe(3);
      await control("继续").click();
      // Background work started here can outlast the 1 s poll default under Full load.
      await expect
        .poll(
          async () =>
            (await env.app.processingTasks!.read(resumedId)).job.status,
          { timeout: 20_000 },
        )
        .toBe("completed");
      await drawer.getByText("已完成", { exact: true }).first().waitFor();
      expect(env.parseCalls).toBe(4);
      await page.setViewportSize({ width: 390, height: 844 });
      // The task detail is a modal drawer; close it before using the shell.
      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
      await page.keyboard.press("Escape");
      await page
        .getByRole("dialog", { name: "导航", exact: true })
        .waitFor({ state: "hidden" });
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
      await session.close();
      await query.close();
      await env.close();
    }
  }, 90000);
});
