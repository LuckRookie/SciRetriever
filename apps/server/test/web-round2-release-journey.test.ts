import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  nextWorkspace,
  libraryStatus,
} from "../../web/test/next-workspace-fixture.js";
import { readerMore } from "../../web/test/reader-controls.js";

it(
  "connects intake navigation, filtering, reading, correction, the four-step operator, visible DSH and named snapshots",
  { timeout: 0 },
  async () => {
    const w = await nextWorkspace();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const evidence = await mkdtemp(
      join(tmpdir(), "sciretriever-round2-release-"),
    );
    const capture = async (scene: string) => {
      for (const width of [1440, 390]) {
        await w.page.setViewportSize({ width, height: 1000 });
        await w.page.screenshot({
          path: join(evidence, `${scene}-${width}.png`),
        });
        expect(
          await w.page.evaluate(() => document.documentElement.scrollWidth),
          `${scene}/${width}`,
        ).toBeLessThanOrEqual(width);
      }
      await w.page.setViewportSize({ width: 1440, height: 1000 });
    };
    try {
      const page = w.page,
        id = w.env.parseRequest.literature_id;
      const beforeCalls = w.env.modelCalls;
      await page.getByRole("button", { name: "入库", exact: true }).click();
      await page.locator(".intake-form").waitFor();
      await capture("intake");
      await page
        .getByLabel("主导航", { exact: true })
        .getByRole("button", { name: /^文献库/ })
        .click();
      await libraryStatus(page, "已就绪");
      await page.locator(`[data-literature-id="${id}"]`).waitFor();
      await capture("library-filter");
      await page.locator(`[data-literature-id="${id}"] .paper-open`).click();
      // A paper with text opens its full text (reading-experience 6.4); the
      // views are the top bar's 原文 and PDF, the rest are in “更多” (1.3).
      await page.locator(".reading-article").waitFor();
      await page.getByRole("tab", { name: "PDF", exact: true }).click();
      await page
        .locator('.reading-pdf-page[data-rendered="true"]')
        .first()
        .waitFor();
      await capture("reader-pdf");
      await page.getByRole("tab", { name: "原文", exact: true }).click();
      await page.locator(".reading-article").waitFor();
      await capture("reader-text");
      await readerMore(page, "加工结果");
      await page
        .getByRole("region", { name: "文献参与的全部结果", exact: true })
        .waitFor();
      await page.getByRole("tab", { name: "原文", exact: true }).click();
      await readerMore(page, "编辑校订稿");
      const editor = page.getByRole("region", {
        name: "校订稿编辑",
        exact: true,
      });
      const input = editor.getByRole("textbox", {
        name: "第 1 页校订稿",
        exact: true,
      });
      await input.waitFor();
      // The arranged editor (a6bf978) only saves edits inside existing
      // paragraphs, so correct one instead of appending a new paragraph.
      const text = await input.inputValue(),
        paragraph = text
          .split("\n")
          .find((line) => line.trim() && !line.startsWith("#"))!;
      await input.fill(
        text.replace(
          paragraph,
          paragraph + " Verified synthetic observation: 4.3 eV.",
        ),
      );
      await editor
        .getByRole("button", { name: "保存修订", exact: true })
        .click();
      await editor
        .getByText("修订已保存，全文已重新生成。", { exact: true })
        .waitFor();
      expect(w.env.modelCalls).toBe(beforeCalls);
      await capture("reader-saved");
      w.env.setModel(async (input) => {
        await gate;
        return {
          outcome: "completed",
          title: "Release summary",
          statements: [
            {
              statement_id: "s1",
              category: "finding",
              epistemic: "reported",
              text: "A synthetic finding.",
              conditions: [],
              quantity: null,
              evidence_segment_ids: [input.segments![0]!.segment_id],
            },
          ],
        };
      });
      await page.goto(
        `${w.origin}/?view=ext&query=${encodeURIComponent(JSON.stringify({ statuses: ["READY"] }))}`,
      );
      await page.getByRole("button", { name: "运行算子", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: "运行算子",
        exact: true,
      });
      const next = dialog.getByRole("button", { name: "下一步", exact: true });
      await expect.poll(() => next.isEnabled()).toBe(true);
      await next.click();
      await dialog.getByText("全文总结", { exact: true }).click();
      await next.click();
      await next.click();
      expect(w.env.modelCalls).toBe(beforeCalls);
      await capture("operator-confirmation");
      await dialog
        .getByRole("button", { name: "开始运行", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await w.env.app.jobs!.listJobs()).some(
              (job) => job.status === "running",
            ),
          { timeout: 20_000 },
        )
        .toBe(true);
      const job = (await w.env.app.jobs!.listJobs()).find(
        (job) => job.status === "running",
      )!;
      await page.goto(`${w.origin}/?view=agent`);
      const session = page
        .locator(".agent-session-list")
        .getByRole("button")
        .filter({ hasText: "文献总结" })
        .first();
      await session.waitFor();
      await session.click();
      const conversation = page.getByRole("list", {
        name: "会话记录",
        exact: true,
      });
      await conversation.waitFor();
      await conversation.locator('[data-role="user"]').first().waitFor();
      const system = conversation
        .getByRole("button", { name: /^系统提示词 ·/ })
        .first();
      expect(await system.getAttribute("aria-expanded")).toBe("false");
      await capture("agent-running");
      release();
      await expect
        .poll(async () => (await w.env.app.jobs!.getJob(job.job_id))!.status, {
          timeout: 20_000,
        })
        .toBe("completed");
      await expect
        .poll(() => conversation.textContent(), { timeout: 20_000 })
        .toContain("A synthetic finding.");
      await page.getByRole("button", { name: "所属任务", exact: true }).click();
      const task = page.getByRole("region", {
        name: "逐篇运行过程",
        exact: true,
      });
      await task.getByText("新计算完成", { exact: true }).waitFor();
      expect(await task.innerText()).toContain("网页登录 · ");
      expect(await task.innerText()).not.toContain("web-session:");
      await capture("task-result");
      await page.goto(`${w.origin}/?view=ext`);
      const runs = page.getByRole("region", {
        name: "算子运行记录",
        exact: true,
      });
      await runs
        .getByRole("button", { name: "查看结果", exact: true })
        .first()
        .waitFor();
      expect(await runs.innerText()).toContain("有结果");
      await capture("operator-runs");
      await page.goto(`${w.origin}/?literature=${id}&reader=results`);
      await page
        .getByRole("region", { name: "文献参与的全部结果", exact: true })
        .getByRole("button", { name: "结果详情", exact: true })
        .first()
        .click();
      await page
        .getByRole("table", { name: "提取结果", exact: true })
        .waitFor();
      await capture("result-checks");
      await page.goto(w.origin);
      await libraryStatus(page, "全部");
      await page
        .getByRole("button", { name: "用当前结果", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "生成快照", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "全部文献 · 1 篇", exact: true })
        .waitFor();
      const snapshot = new URL(page.url()).searchParams.get("snapshot")!;
      const original = await w.env.app.snapshots.all(snapshot);
      await page.getByRole("button", { name: "重命名", exact: true }).click();
      const rename = page.getByRole("dialog", {
        name: "重命名快照",
        exact: true,
      });
      await rename
        .getByRole("textbox", { name: "快照名称", exact: true })
        .fill("复验快照");
      await rename.getByRole("button", { name: "保存", exact: true }).click();
      await page
        .getByRole("heading", { name: "复验快照", exact: true })
        .waitFor();
      expect((await w.env.app.snapshots.all(snapshot)).content_sha256).toBe(
        original.content_sha256,
      );
      await capture("named-snapshot");
      await page.getByRole("button", { name: "重命名", exact: true }).click();
      await rename
        .getByRole("button", { name: "恢复默认名称", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "全部文献 · 1 篇", exact: true })
        .waitFor();
      expect(w.errors).toEqual([]);
      console.info(`Round-two release screenshots: ${evidence}`);
    } finally {
      release();
      await w.close();
    }
  },
);
