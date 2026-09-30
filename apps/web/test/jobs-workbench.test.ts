import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { createApplication } from "../../server/src/bootstrap/application.js";
import { TypeScriptConfigurationOwner } from "../../server/src/configuration/owner.js";
import {
  startWorkbenchHttp,
  type WorkbenchStaticAsset,
} from "../../server/src/workbench/http.js";
import { WorkbenchSession } from "../../server/src/workbench/session.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";

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
    let failNextRun = true;
    let runCalls = 0;
    let releaseRun!: () => void;
    let runGate = Promise.resolve();
    const server = await startWorkbenchHttp({
      session,
      configuration,
      library: {
        queries: application.library,
        artifacts: application.literatureArtifacts,
      },
      jobs: {
        list: (limit) => application.jobs!.listJobs(limit),
        get: (jobId) => application.jobs!.getJob(jobId),
        targets: (jobId, limit) => application.jobs!.listTargets(jobId, limit),
        attempts: (targetId, limit) =>
          application.jobs!.listAttempts(targetId, limit),
        events: (jobId, after, limit) =>
          application.jobs!.listEvents(jobId, after, limit),
        policy: (jobId) => application.jobs!.getPolicy(jobId),
        budget: (jobId) => application.jobs!.getBudget(jobId),
        interventions: (jobId, limit) =>
          application.jobs!.listInterventions(jobId, limit),
        run: async (jobId) => {
          runCalls += 1;
          if (failNextRun) {
            failNextRun = false;
            throw new Error("synthetic run failure");
          }
          await runGate;
          return application.queue!.runUntilIdle(
            jobId,
            async () => "completed",
          );
        },
        resolveIntervention: (id, resolution) =>
          application.interventions!.resolve(id, resolution),
        create: (input) => application.jobService!.create(input as never),
        pause: (jobId) => application.queue!.pause(jobId),
        resume: (jobId) => application.queue!.resume(jobId),
        cancel: (jobId) => application.queue!.cancel(jobId),
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
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(server.origin);
      await page.locator("#jobs-tab").click();
      expect(await page.locator("#jobs-workspace").isVisible()).toBe(true);
      await expect
        .poll(() => page.locator("#jobs-list").textContent())
        .toContain("还没有任务");
      expect(await page.locator("#job-policy-summary").textContent()).toContain(
        "重启不会重置已用预算",
      );
      await page.locator("#job-attempts").fill("12");
      await page.locator("#job-retries").fill("1");
      await page.locator("#job-assistance").selectOption("pause");
      await page.locator("#job-confirm").check();
      await page.getByRole("button", { name: "创建持久任务" }).click();
      await expect
        .poll(() => page.locator("#job-create-status").textContent())
        .toBe("任务已持久保存。");
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
      await page
        .locator("#job-detail")
        .getByRole("button", { name: "继续" })
        .click();
      await expect
        .poll(() => page.locator("#job-detail").textContent())
        .toContain("等待执行");
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
        .poll(() => page.locator("#job-detail").textContent())
        .toContain("已完成");
      expect(
        await page
          .locator("#job-detail > .job-actions > button")
          .evaluateAll((buttons) =>
            buttons.every((button) => (button as HTMLButtonElement).disabled),
          ),
      ).toBe(true);

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
          await route.fulfill({ json: { jobs: [] } });
          return;
        }
        await route.continue();
      };
      await page.route("**/api/v1/jobs?limit=100*", staleRoute);
      await page.locator("#jobs-refresh").click();
      await staleRequest;
      await page.locator("#jobs-refresh").click();
      await expect.poll(() => page.locator(".job-list-item").count()).toBe(2);
      releaseStale();
      await expect.poll(() => listCalls).toBe(2);
      await expect.poll(() => page.locator(".job-list-item").count()).toBe(2);
      await page.unroute("**/api/v1/jobs?limit=100*", staleRoute);

      await page.route(
        "**/api/v1/jobs?limit=100*",
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
      expect(errors).toEqual([]);
      await page.setViewportSize({ width: 390, height: 844 });
      const overflow = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("body *")]
          .filter((element) => {
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
    } finally {
      await browser.close();
      await server.close();
      await session.close();
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
