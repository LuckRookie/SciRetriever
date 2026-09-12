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
  it("creates a confirmed policy, expands targets and shows persisted budget", async () => {
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
        run: (jobId) => application.taskService!.runJob(jobId),
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
      expect(
        await application.jobs!.listTargets(
          (await application.jobs!.listJobs())[0]!.job_id,
        ),
      ).toHaveLength(1);
      expect(errors).toEqual([]);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    } finally {
      await browser.close();
      await server.close();
      await session.close();
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
