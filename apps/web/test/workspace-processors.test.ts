import { expect, it } from "vitest";
import type { Page } from "playwright";
import { workspace, missingId } from "./processor-workspace-fixture.js";

async function selectedForm(page: Page, id: string) {
  await page.locator(`[data-ck="${id}"]`).check();
  await page.locator("#capSel").click();
  await page.locator('[data-cap="ext"]').click();
  await expect
    .poll(() => page.locator("#processor-submit").isEnabled())
    .toBe(true);
}
async function labels(page: Page) {
  await page.locator('[data-processor-kind="labels"]').click();
  await page
    .locator("#processor-question")
    .fill("Does the source report a measurement?");
}
async function savedTask(w: Awaited<ReturnType<typeof workspace>>) {
  await expect
    .poll(() => w.page.locator("#processor-feedback").textContent())
    .toContain("任务已保存");
  const jobs = await w.env.app.jobs!.listJobs(10);
  expect(jobs).toHaveLength(1);
  return jobs[0]!.job_id;
}
async function completed(w: Awaited<ReturnType<typeof workspace>>, id: string) {
  await expect
    .poll(
      async () =>
        (await w.env.app.processingTasks!.read(id)).collections.length,
      { timeout: 10000 },
    )
    .toBe(1);
  const summary = (await w.env.app.processorRead!.collections(id))[0]!;
  return (await w.env.app.processorRead!.collection(
    String(summary.collection_id),
  ))!;
}

it("validates records, fixes the selected document, and opens a verified result with original numeric units and missing values", async () => {
  const w = await workspace();
  try {
    await selectedForm(w.page, w.env.parseRequest.literature_id);
    expect(w.env.modelCalls).toBe(0);
    await w.page.locator("#processor-submit").click();
    expect(
      await w.page.locator("#processor-meaning").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(w.submissions).toHaveLength(0);
    await w.page
      .locator("#processor-meaning")
      .fill("Each reported measurement");
    await w.page.locator('[data-field="name"][data-index="0"]').fill("energy");
    await w.page
      .locator('[data-field="description"][data-index="0"]')
      .fill("Reported energy");
    await w.page
      .locator('[data-field="type"][data-index="0"]')
      .selectOption("number");
    await w.page
      .locator('[data-field="unit"][data-index="0"]')
      .fill("Keep the reported unit");
    await w.page.locator("#processor-add-field").click();
    await w.page.locator('[data-field="name"][data-index="1"]').fill("energy");
    await w.page
      .locator('[data-field="description"][data-index="1"]')
      .fill("Unreported qualifier");
    await w.page.locator("#processor-submit").click();
    expect(
      await w.page.locator("#processor-validation").textContent(),
    ).toContain("不能重复");
    await w.page
      .locator('[data-field="name"][data-index="1"]')
      .fill("qualifier");
    await w.page.locator("#processor-add-field").click();
    await w.page.locator('[data-remove-field="2"]').click();
    w.env.setModel((input) => ({
      records: [
        {
          values: {
            energy: { value: 4.2, raw: "4.2", unit: "eV" },
            qualifier: null,
          },
          evidence: {
            energy: [
              input.segments!.find((s) => s.text.includes("4.2"))!.segment_id,
            ],
            qualifier: [],
          },
          missing: { energy: null, qualifier: "not-reported" },
        },
      ],
    }));
    await w.page.locator("#processor-submit").click();
    const id = await savedTask(w);
    const collection = await completed(w, id);
    expect(w.submissions[0]!.inputs).toEqual([
      { kind: "literature", literature_id: w.env.parseRequest.literature_id },
    ]);
    expect(w.submissions[0]!.spec.reading).toEqual({
      scope: "full",
      query: null,
    });
    const input = collection.members[0]!.inputs[0]!;
    expect(input.kind).toBe("document");
    if (input.kind !== "document") throw new Error("expected document");
    expect(input.document.document_version_id).toBe(
      w.parsed.document.document_version_id,
    );
    expect(input.document.source_material_ref.asset_sha256).toBe(
      w.env.asset.sha256,
    );
    await w.page.getByRole("button", { name: "查看任务", exact: true }).click();
    await expect
      .poll(() => w.page.locator("#task-results").textContent())
      .toContain("新生成 1 项 / 复用 0 项");
    expect(await w.page.locator(".job-policy-summary").count()).toBe(0);
    await w.page
      .getByRole("button", { name: "打开处理结果摘要", exact: true })
      .click();
    await expect
      .poll(() => w.page.locator("#processor-record-preview").textContent())
      .toContain("4.2 eV");
    expect(
      await w.page.locator("#processor-record-preview").textContent(),
    ).toContain("not-reported");
    const resultUrl = w.page.url();
    await w.page.reload();
    await expect
      .poll(() => w.page.locator("#processor-record-preview").textContent())
      .toContain("not-reported");
    const tampered = new URL(resultUrl);
    tampered.searchParams.set("resultHash", "0".repeat(64));
    await w.page.goto(tampered.href);
    await expect
      .poll(() => w.page.locator("#main").textContent())
      .toContain("固定处理结果无法验证");
    expect(w.env.modelCalls).toBe(1);
    expect(w.env.parseCalls).toBe(1);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("submits enum labels over an explicit search scope and keeps missing documents as gaps", async () => {
  const w = await workspace();
  try {
    await w.page.locator("#nav-ext").click();
    await expect
      .poll(() => w.page.locator("#processor-gaps").textContent())
      .toContain("1 篇缺少解析正文");
    await labels(w.page);
    await w.page.locator("#processor-answer-type").selectOption("enum");
    await w.page.locator("#processor-choices").fill("reported\nreported");
    await w.page.locator("#processor-submit").click();
    expect(w.submissions).toHaveLength(0);
    expect(
      await w.page.locator("#processor-choices").getAttribute("aria-invalid"),
    ).toBe("true");
    await w.page.locator("#processor-choices").fill("reported\nunreported");
    await w.page.locator('[name="processor-reading"][value="search"]').check();
    await w.page.locator("#processor-submit").click();
    expect(
      await w.page.locator("#processor-validation").textContent(),
    ).toContain("关键词");
    await w.page.locator("#processor-reading-query").fill("measured");
    w.env.setModel((input) => ({
      answer: "reported",
      source_ids: [input.segments![0]!.segment_id],
      reason: null,
    }));
    expect(w.env.modelCalls).toBe(0);
    await w.page.locator("#processor-submit").click();
    const id = await savedTask(w);
    const collection = await completed(w, id);
    expect(w.submissions[0]!.inputs).toHaveLength(2);
    expect(collection.members).toHaveLength(2);
    expect(collection.members.filter((m) => m.result)).toHaveLength(1);
    expect(collection.members.find((m) => !m.result)?.gap).toBeTruthy();
    const ref = collection.members.find((m) => m.result)!.result!;
    const stored = await w.env.app.processorRead!.byId(ref.result_id);
    expect(stored!.result.coverage.some((c) => c.status !== "complete")).toBe(
      true,
    );
    expect(stored!.result.content).toMatchObject({
      kind: "records",
      records: [{ payload: { answer: "reported" } }],
    });
    await w.page.getByRole("button", { name: "查看任务", exact: true }).click();
    await expect
      .poll(() => w.page.locator("#task-results").textContent())
      .toContain("部分覆盖 1 项");
    await w.page
      .getByRole("button", { name: "查看本次结果", exact: true })
      .click();
    await expect
      .poll(() => w.page.locator("#processor-result-summary").textContent())
      .toContain("2 项输入 · 1 项已有结果 · 1 项缺口");
    await w.page.getByText("查看本次规范与缺口", { exact: true }).click();
    await w.page
      .getByRole("button", { name: "打开结果摘要", exact: true })
      .click();
    await expect
      .poll(() => w.page.locator("#processor-record-preview").textContent())
      .toContain("reported");
    expect(
      await w.page.locator("#processor-result-summary").textContent(),
    ).toContain("部分覆盖");
    expect(w.env.parseCalls).toBe(1);
    expect(w.env.modelCalls).toBe(1);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("preserves drafts and idempotency after a lost save receipt and recovers a saved task whose start failed", async () => {
  const w = await workspace();
  try {
    await selectedForm(w.page, w.env.parseRequest.literature_id);
    await labels(w.page);
    await w.page.route(
      "**/api/v1/maintenance/processor-submit?*",
      async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(202);
        await route.fulfill({
          status: 503,
          json: { protocol_version: 1, code: "test-lost-receipt" },
        });
      },
      { times: 1 },
    );
    await w.page.locator("#processor-submit").click();
    await expect
      .poll(() => w.page.locator("#processor-feedback").textContent())
      .toContain("test-lost-receipt");
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(1);
    await w.page.locator("#library-tab").click();
    await w.page.locator("#nav-ext").click();
    expect(await w.page.locator("#processor-question").inputValue()).toBe(
      "Does the source report a measurement?",
    );
    await expect
      .poll(() => w.page.locator("#processor-submit").isEnabled())
      .toBe(true);
    await w.page.route(
      "**/api/tasks/*/start?*",
      (route) =>
        route.fulfill({ status: 503, json: { code: "test-start-failure" } }),
      { times: 1 },
    );
    await w.page.locator("#processor-submit").click();
    await expect
      .poll(() => w.page.locator("#processor-feedback").textContent())
      .toContain("启动状态未确认");
    const id = await savedTask(w);
    expect(w.submissions).toHaveLength(2);
    expect(w.submissions[1]).toEqual(w.submissions[0]);
    expect((await w.env.app.processingTasks!.read(id)).job.status).toBe(
      "queued",
    );
    expect(w.env.modelCalls).toBe(0);
    await w.page.getByRole("button", { name: "查看任务", exact: true }).click();
    await w.page
      .locator("#task-controls")
      .getByRole("button", { name: "启动", exact: true })
      .click();
    await completed(w, id);
    await w.page.locator("#nav-ext").click();
    await expect
      .poll(() => w.page.locator("#processor-submit").isEnabled())
      .toBe(true);
    await w.page.locator("#processor-submit").click();
    await expect
      .poll(() => w.page.locator("#processor-submit").isEnabled())
      .toBe(true);
    expect(w.submissions).toHaveLength(2);
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(1);
    expect(w.env.modelCalls).toBe(1);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("explains absent model configuration without losing a valid form or processing missing material", async () => {
  const w = await workspace(false);
  try {
    await selectedForm(w.page, missingId);
    expect(await w.page.locator("#processor-gaps").textContent()).toContain(
      "当前范围没有可处理正文",
    );
    await labels(w.page);
    await w.page.locator("#processor-submit").click();
    await expect
      .poll(() => w.page.locator("#processor-feedback").textContent())
      .toContain("分析模型配置不可用");
    expect(await w.page.locator("#processor-question").inputValue()).toContain(
      "measurement",
    );
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(0);
    expect(w.env.modelCalls).toBe(0);
    expect(w.env.parseCalls).toBe(1);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("cancels a processor task from Web and refuses a late model answer", async () => {
  const w = await workspace();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    w.env.setModel(async (input) => {
      await gate;
      return {
        answer: true,
        source_ids: [input.segments![0]!.segment_id],
        reason: null,
      };
    });
    await selectedForm(w.page, w.env.parseRequest.literature_id);
    await labels(w.page);
    await w.page.locator("#processor-submit").click();
    const id = await savedTask(w);
    await expect.poll(() => w.env.modelCalls).toBe(1);
    await w.page.getByRole("button", { name: "查看任务", exact: true }).click();
    await w.page
      .locator("#task-controls")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    release();
    await expect
      .poll(async () => (await w.env.app.processingTasks!.read(id)).job.status)
      .toBe("cancelled");
    await expect
      .poll(() => w.page.locator("#task-content > .tag").textContent())
      .toBe("已取消");
    const task = await w.env.app.processingTasks!.read(id);
    expect(task.results).toHaveLength(0);
    expect((await w.env.app.processorRead!.list()).items).toHaveLength(0);
    expect(w.env.parseCalls).toBe(1);
    expect(w.errors).toEqual([]);
  } finally {
    release();
    await w.close();
  }
}, 60000);
