import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

it(
  "edits a corrected document, reruns a stale summary after estimating, observes DSH and finds the new result",
  { timeout: 0 },
  async () => {
    const w = await nextWorkspace();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    try {
      const id = w.env.parseRequest.literature_id;
      let blocked = false;
      w.env.setModel(async (input) => {
        if (blocked) await gate;
        return {
          outcome: "completed",
          title: "Observed summary",
          statements: [
            {
              statement_id: "s1",
              category: "finding",
              epistemic: "reported",
              text: "Observed result.",
              conditions: [],
              quantity: null,
              evidence_segment_ids: [input.segments![0]!.segment_id],
            },
          ],
        };
      });
      const original = await w.env.app.processors!.runBatch({
        schema_version: 1,
        idempotency_key: "monitor-before-edit",
        name: "Before edit",
        processor: { id: "summary", version: "2" },
        spec: {},
        inputs: [{ kind: "literature", literature_id: id }],
      });
      expect(original.failures).toEqual([]);
      const old = (await w.env.app.processorRead!.list()).items[0]!;
      const screenshots = await mkdtemp(
        join(tmpdir(), "sciretriever-review-journey-"),
      );
      const screenshot = (name: string) =>
        w.page.screenshot({
          path: join(screenshots, name + ".png"),
          fullPage: true,
        });
      await w.page.goto(`${w.origin}/?literature=${id}&reader=edit`);
      const editor = w.page.getByRole("region", {
        name: "校订稿编辑",
        exact: true,
      });
      const field = editor.getByRole("textbox", {
        name: "第 1 页校订稿",
        exact: true,
      });
      await field.waitFor();
      // The arranged editor (a6bf978) only saves edits inside existing
      // paragraphs, so correct one instead of appending a new paragraph.
      const text = await field.inputValue(),
        paragraph = text
          .split("\n")
          .find((line) => line.trim() && !line.startsWith("#"))!;
      await field.fill(
        text.replace(
          paragraph,
          paragraph + " Manually corrected measurement: 4.3 eV.",
        ),
      );
      const calls = w.env.modelCalls;
      await editor
        .getByRole("button", { name: "保存修订", exact: true })
        .click();
      await editor
        .getByText("修订已保存，全文已重新生成。", { exact: true })
        .waitFor();
      expect(await field.inputValue()).toContain(
        "Manually corrected measurement: 4.3 eV.",
      );
      expect(w.env.modelCalls).toBe(calls);
      expect(
        (await w.env.app.processorRead!.byId(String(old.result_id)))!.freshness
          ?.state,
      ).toBe("stale");
      await screenshot("editor-desktop");
      await w.page.setViewportSize({ width: 390, height: 844 });
      await screenshot("editor-narrow");
      await w.page.setViewportSize({ width: 1440, height: 1000 });
      await w.page.goto(
        `${w.origin}/?view=ext&result=${old.result_id}&resultHash=${old.content_sha256}`,
      );
      await w.page
        .getByRole("button", { name: "基于新快照重新运行", exact: true })
        .click();
      await w.page
        .getByRole("button", { name: "按原结果范围生成新快照", exact: true })
        .click();
      const estimate = w.page.getByRole("region", {
        name: "启动前用量预估",
        exact: true,
      });
      await estimate.waitFor();
      expect(await estimate.innerText()).toContain("可复用 0 篇");
      expect(await estimate.innerText()).toContain("100–100");
      expect(w.env.modelCalls).toBe(calls);
      await screenshot("estimate-confirmation");
      blocked = true;
      await w.page
        .getByRole("button", { name: "确认启动", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await w.env.app.jobs!.listJobs()).filter(
              (j) => j.status === "running",
            ).length,
          { timeout: 20_000 },
        )
        .toBe(1);
      const job = (await w.env.app.jobs!.listJobs()).find(
        (j) => j.status === "running",
      )!;
      await w.page.goto(`${w.origin}/?view=agent`);
      // Agent sessions live under 任务 since plan 14 (4.1).
      await w.page
        .getByRole("tab", { name: "Agent 会话", selected: true })
        .waitFor();
      const selected = w.page
        .locator(".agent-session-list")
        .getByRole("button")
        .filter({ hasText: "文献总结" })
        .first();
      await selected.waitFor({ timeout: 20_000 });
      await selected.click();
      await w.page
        .getByRole("region", { name: "Agent 过程记录", exact: true })
        .waitFor();
      expect((await w.env.app.jobs!.getJob(job.job_id))!.status).toBe(
        "running",
      );
      await screenshot("agent-running");
      release();
      await expect
        .poll(async () => (await w.env.app.jobs!.getJob(job.job_id))!.status, {
          timeout: 20_000,
        })
        .toBe("completed");
      // The submission appears verbatim in the conversation, inside its raw arguments.
      await expect
        .poll(
          () =>
            w.page
              .getByRole("list", { name: "会话记录", exact: true })
              .textContent(),
          { timeout: 20_000 },
        )
        .toContain("Observed result.");
      await w.page
        .getByRole("button", { name: "所属任务", exact: true })
        .click();
      const run = w.page.getByRole("region", {
        name: "逐篇运行过程",
        exact: true,
      });
      await run.waitFor();
      await run.getByText("新计算完成", { exact: true }).waitFor();
      expect(await run.innerText()).toContain("网页登录 · ");
      expect(await run.innerText()).not.toContain("web-session:");
      expect(await run.innerText()).toContain("输入 100 / 输出 50 token");
      await run
        .getByRole("button", { name: "打开文献", exact: true })
        .waitFor();
      await screenshot("task-run");
      await w.page.goto(`${w.origin}/?view=ext&results=all`);
      const runs = w.page.getByRole("region", {
        name: "算子运行记录",
        exact: true,
      });
      await runs
        .getByRole("button", { name: "查看结果", exact: true })
        .first()
        .waitFor();
      // Only stale runs carry a badge; current runs need no label.
      expect(await runs.innerText()).toContain("已过时");
      await screenshot("runs-desktop");
      await w.page.goto(`${w.origin}/?literature=${id}&reader=results`);
      const paper = w.page.getByRole("region", {
        name: "文献参与的全部结果",
        exact: true,
      });
      // A fresh navigation takes ~1.5 s to load this list; the 1 s poll
      // default is too tight, so use the 15 s used elsewhere in this file.
      await expect
        .poll(
          () =>
            paper
              .getByRole("button", { name: "结果详情", exact: true })
              .count(),
          { timeout: 20_000 },
        )
        .toBe(2);
      expect(
        await w.page
          .getByRole("navigation", { name: "文档目录", exact: true })
          .count(),
      ).toBe(0);
      expect(
        await w.page
          .getByRole("button", { name: "文档内查找", exact: true })
          .isDisabled(),
      ).toBe(true);
      await w.page.setViewportSize({ width: 390, height: 844 });
      await screenshot("paper-results-narrow");
      await paper
        .getByRole("button", { name: "结果详情", exact: true })
        .first()
        .click();
      await w.page
        .locator('table[aria-label="提取结果"] tr[data-highlighted="true"]')
        .first()
        .waitFor();
      console.info(`Review journey screenshots: ${screenshots}`);
      expect(w.errors).toEqual([]);
    } finally {
      release();
      await w.close();
    }
  },
);

it(
  "opens a paper's complete result list and highlights its evidence-linked result rows",
  { timeout: 0 },
  async () => {
    const w = await nextWorkspace();
    try {
      const id = w.env.parseRequest.literature_id;
      w.env.setModel((input) => ({
        outcome: "completed",
        title: "Reader result",
        statements: [
          {
            statement_id: "s1",
            category: "finding",
            epistemic: "reported",
            text: "Paper-linked claim.",
            conditions: [],
            quantity: null,
            evidence_segment_ids: [input.segments![0]!.segment_id],
          },
        ],
      }));
      const run = await w.env.app.processors!.runBatch({
        schema_version: 1,
        idempotency_key: "paper-results",
        name: "Paper results",
        processor: { id: "summary", version: "2" },
        spec: {},
        inputs: [{ kind: "literature", literature_id: id }],
      });
      expect(run.failures).toEqual([]);
      await w.page.goto(`${w.origin}/?literature=${id}&reader=results`);
      await w.page
        .getByRole("region", { name: "文献参与的全部结果", exact: true })
        .getByRole("button", { name: "结果详情", exact: true })
        .click();
      await w.page
        .locator('table[aria-label="提取结果"] tr[data-highlighted="true"]')
        .first()
        .waitFor();
      expect(new URL(w.page.url()).searchParams.get("focusLiterature")).toBe(
        id,
      );
      await w.page.goto(`${w.origin}/?view=ext&results=all`);
      const runs = w.page.getByRole("region", {
        name: "算子运行记录",
        exact: true,
      });
      await runs
        .getByRole("button", { name: "查看结果", exact: true })
        .waitFor();
      expect(await runs.innerText()).toMatch(/有结果\s*1\b/u);
      expect(w.errors).toEqual([]);
    } finally {
      await w.close();
    }
  },
);

it(
  "shows each mapped paper while the synthesis stage is still running",
  { timeout: 0 },
  async () => {
    const w = await nextWorkspace();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const id = w.env.parseRequest.literature_id;
      w.env.setModel(async (input) => {
        if (input.purpose)
          return {
            outcome: "completed",
            title: "Mapped paper",
            statements: [
              {
                statement_id: "s1",
                category: "finding",
                epistemic: "reported",
                text: "Map evidence.",
                conditions: [],
                quantity: null,
                evidence_segment_ids: [input.segments![0]!.segment_id],
              },
            ],
          };
        await gate;
        return {
          claims: [
            {
              text: "Combined evidence.",
              source_ids: (input.candidates as { id: string }[]).map(
                (c) => c.id,
              ),
            },
          ],
        };
      });
      await w.env.app.processors!.runBatch({
        schema_version: 1,
        idempotency_key: "mapped-before-synthesis",
        name: "Prepare map",
        processor: { id: "summary", version: "2" },
        spec: {},
        inputs: [{ kind: "literature", literature_id: id }],
      });
      const snapshot = await w.env.app.snapshots.create({
        kind: "literatures",
        literature_ids: [id],
      });
      const job = await w.env.app.processors!.submit({
        schema_version: 1,
        idempotency_key: "observe-mapped-stage",
        name: "Map progress",
        processor: { id: "knowledge-synthesis", version: "2" },
        spec: { question: "What is reported?", policy: "allow-partial" },
        inputs: [{ kind: "snapshot", snapshot_id: snapshot.snapshot_id }],
      });
      w.env.app.processingTasks!.start(job.job_id);
      await w.page.goto(`${w.origin}/?view=task&task=${job.job_id}`);
      const papers = w.page.getByRole("region", {
        name: "综合逐篇进度",
        exact: true,
      });
      await expect
        .poll(() => papers.innerText(), { timeout: 20_000 })
        .toContain("复用已有结果");
      expect((await w.env.app.jobs!.getJob(job.job_id))!.status).toBe(
        "running",
      );
      await papers
        .getByRole("button", { name: "打开单篇结果", exact: true })
        .waitFor();
      release();
      await expect
        .poll(async () => (await w.env.app.jobs!.getJob(job.job_id))!.status, {
          timeout: 20_000,
        })
        .toBe("completed");
      await w.page.reload();
      // Same too-tight 1 s default after a reload (~1.5 s to load).
      await expect
        .poll(() => papers.innerText(), { timeout: 20_000 })
        .toContain("复用已有结果");
      await w.page.setViewportSize({ width: 390, height: 844 });
      expect(
        await w.page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      const directory = await mkdtemp(
        join(tmpdir(), "sciretriever-mapped-progress-"),
      );
      await w.page.screenshot({
        path: join(directory, "mapped-narrow.png"),
        fullPage: true,
      });
      await w.page.setViewportSize({ width: 1440, height: 1000 });
      await w.page.screenshot({
        path: join(directory, "mapped-desktop.png"),
        fullPage: true,
      });
      console.info(`Mapped progress screenshots: ${directory}`);
      expect(w.errors).toEqual([]);
    } finally {
      release();
      await w.close();
    }
  },
);
