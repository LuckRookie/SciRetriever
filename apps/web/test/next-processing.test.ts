import { showAllLibraryStatuses } from "./next-workspace-fixture.js";
import { captureFeature } from "./next-feature-capture-fixture.js";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import type { Page } from "playwright";
import { unzipSync, strFromU8 } from "fflate";
import { nextWorkspace, runFromSnapshot } from "./next-workspace-fixture.js";
import { assertMachineReadsWebResult } from "../../server/test/processor-machine-read-fixture.js";
type Workspace = Awaited<ReturnType<typeof nextWorkspace>>;
async function select(page: Page, label: string, option: string) {
  await page
    .getByRole("button", { name: new RegExp(label) })
    .and(page.locator('[aria-haspopup="listbox"]'))
    .click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
const runner = (page: Page) =>
  page.getByRole("dialog", { name: "运行算子", exact: true });
async function next(page: Page) {
  await runner(page)
    .getByRole("button", { name: "下一步", exact: true })
    .click();
}
async function nextReady(page: Page) {
  await expect
    .poll(() =>
      runner(page)
        .getByRole("button", { name: "下一步", exact: true })
        .isEnabled(),
    )
    .toBe(true);
}
async function chooseOperator(page: Page, name: string) {
  await runner(page).getByText(name, { exact: true }).click();
}
/** Open the dialog from the operator page header and stop at the operator step. */
async function openFromPage(page: Page) {
  await page
    .getByRole("main")
    .getByRole("button", { name: "运行算子", exact: true })
    .click();
  await nextReady(page);
  await next(page);
}
/** Select a paper, open the dialog from the selection bar and reach the specification step. */
async function enterSelected(
  w: Workspace,
  missing = false,
  operator = "记录提取",
) {
  if (missing) await showAllLibraryStatuses(w.page);
  const paper = missing
    ? "Unparsed source"
    : (await w.env.app.library.detail(w.env.parseRequest.literature_id))
        .literature.metadata.title!;
  await w.page
    .getByRole("checkbox", { name: `选择 ${paper}`, exact: true })
    .focus();
  await w.page.keyboard.press("Space");
  await w.page
    .getByRole("region", { name: "文献选择", exact: true })
    .getByRole("button", { name: "运行算子…", exact: true })
    .click();
  await nextReady(w.page);
  await chooseOperator(w.page, operator);
  await next(w.page);
}
/** Switch the open dialog to question labels and fill the question. */
async function labels(page: Page) {
  if (!(await runner(page).count())) await openFromPage(page);
  else
    await runner(page)
      .getByRole("button", { name: "上一步", exact: true })
      .click();
  await chooseOperator(page, "问答标注");
  await next(page);
  await page
    .getByRole("textbox", { name: "对每篇文献问一个问题" })
    .fill("Does the source report a measurement?");
}
/** Confirm the specification and start; the final press is the only model trigger. */
async function submit(page: Page) {
  await next(page);
  await runner(page)
    .getByRole("button", { name: "开始运行", exact: true })
    .click();
}
/** Leave and come back: the dialog reopens on the retained draft. */
async function reopen(page: Page) {
  if (await runner(page).count())
    await runner(page)
      .getByRole("button", { name: "关闭对话框", exact: true })
      .click();
  await page
    .getByRole("button", { name: /^文献库/ })
    .first()
    .click();
  await page
    .getByLabel("主导航")
    .getByRole("button", { name: "算子", exact: true })
    .click();
  await openFromPage(page);
  await next(page);
}
async function completed(w: Workspace) {
  // Background work started here can outlast the 1 s poll default under Full load.
  await expect
    .poll(async () => (await w.env.app.jobs!.listJobs(10)).length, {
      timeout: 10000,
    })
    .toBe(1);
  const job = (await w.env.app.jobs!.listJobs(10))[0]!;
  await expect
    .poll(
      async () =>
        (await w.env.app.processingTasks!.read(job.job_id)).collections.length,
      { timeout: 10000 },
    )
    .toBe(1);
  const summary = (await w.env.app.processorRead!.collections(job.job_id))[0]!;
  return (await w.env.app.processorRead!.collection(
    String(summary.collection_id),
  ))!;
}
async function recordForm(w: Workspace) {
  await enterSelected(w);
  await w.page
    .getByRole("textbox", { name: "每条记录代表什么" })
    .fill("Each reported measurement");
  await w.page.getByRole("textbox", { name: "字段 1 名称" }).fill("energy");
  await w.page
    .getByRole("textbox", { name: "字段 1 说明" })
    .fill("Reported energy");
  await select(w.page, "字段 1 类型", "数值");
  await w.page
    .getByRole("textbox", { name: "字段 1 单位说明" })
    .fill("Keep the reported unit");
  await w.page.getByRole("button", { name: "添加字段", exact: true }).click();
  await w.page.getByRole("textbox", { name: "字段 2 名称" }).fill("qualifier");
  await w.page
    .getByRole("textbox", { name: "字段 2 说明" })
    .fill("Unreported qualifier");
}
async function openResult(
  w: Workspace,
  ref: { result_id: string; content_sha256: string },
) {
  const url = new URL(w.page.url());
  url.search = new URLSearchParams({
    view: "ext",
    result: ref.result_id,
    resultHash: ref.content_sha256,
  }).toString();
  await w.page.goto(url.href);
  await w.page.getByRole("table", { name: "提取结果", exact: true }).waitFor();
}
it("validates human records, fixes source inputs, verifies numeric and missing values, and rejects altered result hashes", async () => {
  const w = await nextWorkspace({
    ready: '[aria-label="文献列表"] .paper-row:first-child',
  });
  try {
    await enterSelected(w);
    expect(w.env.modelCalls).toBe(0);
    await next(w.page);
    expect(
      await w.page
        .getByRole("textbox", { name: "每条记录代表什么" })
        .getAttribute("aria-invalid"),
    ).toBe("true");
    expect(w.submissions).toHaveLength(0);
    await w.page
      .getByRole("textbox", { name: "每条记录代表什么" })
      .fill("Each reported measurement");
    await w.page.getByRole("textbox", { name: "字段 1 名称" }).fill("energy");
    await w.page
      .getByRole("textbox", { name: "字段 1 说明" })
      .fill("Reported energy");
    await select(w.page, "字段 1 类型", "数值");
    await w.page
      .getByRole("textbox", { name: "字段 1 单位说明" })
      .fill("Keep original unit");
    await w.page.getByRole("button", { name: "添加字段", exact: true }).click();
    await w.page.getByRole("textbox", { name: "字段 2 名称" }).fill("energy");
    await w.page
      .getByRole("textbox", { name: "字段 2 说明" })
      .fill("Unreported qualifier");
    await next(w.page);
    expect(await w.page.getByRole("alert").last().textContent()).toContain(
      "不能重复",
    );
    await w.page
      .getByRole("textbox", { name: "字段 2 名称" })
      .fill("qualifier");
    w.env.setModel((input) => ({
      records: [
        {
          values: {
            energy: { value: 4.2, raw: "4.2", unit: "eV" },
            qualifier: null,
          },
          evidence: {
            energy: [
              input.segments!.find((segment) => segment.text.includes("4.2"))!
                .segment_id,
            ],
            qualifier: [],
          },
          missing: { energy: null, qualifier: "not-reported" },
        },
      ],
    }));
    await submit(w.page);
    const collection = await completed(w);
    expect(w.submissions[0]!.inputs).toEqual([
      { kind: "literature", literature_id: w.env.parseRequest.literature_id },
    ]);
    expect(w.submissions[0]!.spec.reading).toEqual({
      scope: "full",
      query: null,
    });
    const input = collection.members[0]!.inputs[0]!;
    expect(input.kind).toBe("archive-document");
    if (input.kind !== "archive-document") throw new Error("expected document");
    expect(input.parts[0]!.document_version_id).toBe(
      w.parsed.document.document_version_id,
    );
    expect(input.parts[0]!.asset_sha256).toBe(w.env.asset.sha256);
    const ref = collection.members[0]!.result!;
    const saved = (await w.env.app.processorRead!.byId(ref.result_id))!;
    await assertMachineReadsWebResult(w.env.home, saved);
    await openResult(w, ref);
    expect(
      await w.page.getByRole("table", { name: "提取结果" }).textContent(),
    ).toContain("4.2 eV");
    expect(
      await w.page.getByRole("table", { name: "提取结果" }).textContent(),
    ).toContain("not-reported");
    await w.page.reload();
    await w.page.getByRole("table", { name: "提取结果" }).waitFor();
    const url = new URL(w.page.url());
    url.searchParams.set("resultHash", "0".repeat(64));
    await w.page.goto(url.href);
    await expect
      .poll(() => w.page.getByRole("alert").textContent())
      .toContain("固定处理结果无法验证");
    expect(w.env.modelCalls).toBe(1);
    expect(w.env.parseCalls).toBe(w.setupCalls.parser);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
it("submits enum labels on an explicit search scope and retains unparsed material as a gap", async () => {
  const w = await nextWorkspace({
    path: "/?view=ext&query=%7B%7D",
    ready: ".processing-page",
  });
  try {
    await labels(w.page);
    await select(w.page, "答案类型", "指定选项");
    await w.page
      .getByRole("textbox", { name: "可选答案" })
      .fill("reported\nreported");
    await next(w.page);
    expect(w.submissions).toHaveLength(0);
    expect(
      await w.page
        .getByRole("textbox", { name: "可选答案" })
        .getAttribute("aria-invalid"),
    ).toBe("true");
    await w.page
      .getByRole("textbox", { name: "可选答案" })
      .fill("reported\nunreported");
    await w.page.getByRole("radio", { name: "仅与关键词匹配的片段" }).focus();
    await w.page.keyboard.press("Space");
    await next(w.page);
    expect(await w.page.getByRole("alert").last().textContent()).toContain(
      "关键词",
    );
    await w.page.getByRole("textbox", { name: "片段关键词" }).fill("measured");
    w.env.setModel((input) => ({
      answer: "reported",
      source_ids: [input.segments![0]!.segment_id],
      reason: null,
    }));
    await submit(w.page);
    const collection = await completed(w);
    expect(w.submissions[0]!.inputs).toHaveLength(2);
    expect(collection.members).toHaveLength(2);
    expect(collection.members.filter((item) => item.result)).toHaveLength(2);
    const missing = collection.members.find(
      (item) => item.inputs[0]?.kind === "missing",
    )!;
    expect(
      (await w.env.app.processorRead!.byId(missing.result!.result_id))!.result
        .coverage[0]!.parts,
    ).toContainEqual(
      expect.objectContaining({ outcome: "incomplete", gaps: ["not-ready"] }),
    );
    const ref = collection.members.find(
        (item) => item.inputs[0]?.kind === "archive-document",
      )!.result!,
      saved = (await w.env.app.processorRead!.byId(ref.result_id))!;
    expect(
      saved.result.coverage.some((item) => item.status !== "complete"),
    ).toBe(true);
    expect(saved.result.content).toMatchObject({
      kind: "records",
      records: [{ payload: { answer: "reported" } }],
    });
    await openResult(w, ref);
    expect(
      await w.page.getByRole("table", { name: "提取结果" }).textContent(),
    ).toContain("reported");
    expect(w.env.modelCalls).toBe(1);
    expect(w.env.parseCalls).toBe(w.setupCalls.parser);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
it("retains drafts and idempotent requests after a lost save receipt and a failed start", async () => {
  const w = await nextWorkspace({
    ready: '[aria-label="文献列表"] .paper-row:first-child',
  });
  try {
    await enterSelected(w);
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
    await submit(w.page);
    await expect
      .poll(() => runner(w.page).getByRole("alert").first().textContent())
      .toContain("草稿已保留");
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(1);
    await reopen(w.page);
    expect(
      await w.page
        .getByRole("textbox", { name: "对每篇文献问一个问题" })
        .inputValue(),
    ).toContain("measurement");
    await w.page.route(
      "**/api/tasks/*/start?*",
      (route) =>
        route.fulfill({ status: 503, json: { code: "test-start-failure" } }),
      { times: 1 },
    );
    await submit(w.page);
    await expect
      .poll(() => runner(w.page).textContent())
      .toContain("启动状态未确认");
    expect(w.submissions).toHaveLength(2);
    expect(w.submissions[1]).toEqual(w.submissions[0]);
    const job = (await w.env.app.jobs!.listJobs(10))[0]!;
    expect((await w.env.app.processingTasks!.read(job.job_id)).job.status).toBe(
      "queued",
    );
    expect(w.env.modelCalls).toBe(0);
    await reopen(w.page);
    await submit(w.page);
    await completed(w);
    expect(w.submissions).toHaveLength(2);
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(1);
    expect(w.env.modelCalls).toBe(1);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
it("preserves a valid form and reports a durable model configuration failure without new processing", async () => {
  const w = await nextWorkspace({
    analysisModel: false,
    ready: '[aria-label="文献列表"] .paper-row:first-child',
  });
  try {
    await enterSelected(w);
    await labels(w.page);
    await submit(w.page);
    // Background work started here can outlast the 1 s poll default under Full load.
    await expect
      .poll(async () => (await w.env.app.jobs!.listJobs(10)).length, {
        timeout: 10000,
      })
      .toBe(1);
    const job = (await w.env.app.jobs!.listJobs(10))[0]!;
    // Background work started here can outlast the 1 s poll default under Full load.
    await expect
      .poll(
        async () =>
          (await w.env.app.processingTasks!.read(job.job_id)).job.status,
        { timeout: 10000 },
      )
      .toBe("failed");
    expect(
      (await w.env.app.processingTasks!.read(job.job_id)).failures,
    ).toContainEqual(
      expect.objectContaining({
        failure: expect.objectContaining({ code: "agent-configuration" }),
      }),
    );
    await reopen(w.page);
    expect(
      await w.page
        .getByRole("textbox", { name: "对每篇文献问一个问题" })
        .inputValue(),
    ).toContain("measurement");
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(1);
    expect(w.env.modelCalls).toBe(0);
    expect(w.env.parseCalls).toBe(w.setupCalls.parser);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
it("keeps cross-page selections and fixed evidence while exporting every original record", async () => {
  const w = await nextWorkspace({
    ready: '[aria-label="文献列表"] .paper-row:first-child',
  });
  try {
    await recordForm(w);
    await captureFeature(w.page, "react-processing");
    w.env.setModel((input) => ({
      records: Array.from({ length: 32 }, (_, index) => ({
        values: {
          energy: { value: 4.2, raw: "4.2", unit: "eV" },
          qualifier: `Observation ${index}, quote " and newline\n尾部`,
        },
        evidence: {
          energy: [
            input.segments!.find((segment) => segment.text.includes("4.2"))!
              .segment_id,
          ],
          qualifier: [input.segments![0]!.segment_id],
        },
        missing: { energy: null, qualifier: null },
      })),
    }));
    await submit(w.page);
    const collection = await completed(w),
      ref = collection.members[0]!.result!;
    await openResult(w, ref);
    await captureFeature(w.page, "react-results");
    const queried: Record<string, unknown>[] = [];
    w.page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/v1/query/processors") {
        const payload = request.postDataJSON() as {
          operation: string;
          request: Record<string, unknown>;
        };
        if (payload.operation === "query") queried.push(payload.request);
      }
    });
    await select(w.page, "每页记录数", "10 条 / 页");
    await expect
      .poll(() =>
        w.page
          .getByRole("table", { name: "提取结果" })
          .getByRole("row")
          .count(),
      )
      .toBe(11);
    await w.page
      .getByRole("checkbox", { name: "选择第 1 条结果", exact: true })
      .focus();
    await w.page.keyboard.press("Space");
    await expect
      .poll(() => w.page.getByText(/已选 1 条记录/).textContent())
      .toContain("来自 1 篇");
    await w.page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect.poll(() => w.page.getByText(/第 2 页 · 本页/).count()).toBe(1);
    await w.page
      .getByRole("checkbox", { name: "选择第 1 条结果", exact: true })
      .focus();
    await w.page.keyboard.press("Space");
    await expect.poll(() => w.page.getByText(/已选 2 条记录/).count()).toBe(1);
    await w.page
      .getByRole("button", { name: "4.2 eV", exact: true })
      .first()
      .click();
    await expect
      .poll(() =>
        w.page.getByRole("dialog", { name: "字段证据" }).textContent(),
      )
      .toContain("The measured energy was 4.2 eV.");
    await w.page
      .getByRole("button", { name: "打开这段原文", exact: true })
      .click();
    await expect
      .poll(() => w.page.locator(".reading-article").textContent())
      .toContain("4.2 eV");
    expect(new URL(w.page.url()).searchParams.get("document")).toBe(
      w.parsed.document.document_version_id,
    );
    await w.page.getByRole("button", { name: "返回结果", exact: true }).click();
    await expect.poll(() => w.page.getByText(/第 2 页 · 本页/).count()).toBe(1);
    expect(await w.page.getByText(/已选 2 条记录/).count()).toBe(1);
    await select(w.page, "筛选字段", "/energy/value");
    await select(w.page, "筛选操作", "大于或等于");
    await w.page
      .getByRole("textbox", { name: "筛选值", exact: true })
      .fill("4");
    await select(w.page, "结果排序", "降序");
    await w.page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await expect
      .poll(() => queried.at(-1)?.filters)
      .toEqual([{ field: "/energy/value", operator: "ge", value: 4 }]);
    expect(queried.at(-1)?.sort).toEqual({
      field: "/energy/value",
      direction: "desc",
    });
    const countBeforeDraft = queried.length;
    await w.page
      .getByRole("textbox", { name: "筛选值", exact: true })
      .fill("100");
    expect(queried.length).toBe(countBeforeDraft);
    await w.page
      .getByRole("button", { name: "完整结果", exact: true })
      .first()
      .click();
    await select(w.page, "导出格式", "CSV + 来源说明（ZIP）");
    const downloaded = w.page.waitForEvent("download");
    await w.page
      .getByRole("button", { name: "下载完整结果", exact: true })
      .click();
    const file = await downloaded,
      path = await file.path();
    if (!path) throw new Error("No download");
    const bytes = unzipSync(await readFile(path)),
      csv = strFromU8(bytes["result.csv"]!);
    expect(csv).toContain("Observation 31");
    expect(csv).toContain('""');
    expect(csv).toContain("尾部");
    expect(JSON.parse(strFromU8(bytes["metadata.json"]!)).content_sha256).toBe(
      ref.content_sha256,
    );
    expect(w.env.modelCalls).toBe(1);
    await select(w.page, "导出格式", "JSON");
    const jsonDownload = w.page.waitForEvent("download");
    await w.page
      .getByRole("button", { name: "下载完整结果", exact: true })
      .click();
    const jsonFile = await jsonDownload,
      jsonPath = await jsonFile.path();
    if (!jsonPath) throw new Error("Missing JSON result");
    expect(JSON.parse(await readFile(jsonPath, "utf8"))).toEqual(
      await w.env.app.processorRead!.byId(ref.result_id),
    );
    await w.page
      .getByRole("dialog", { name: "导出这份完整结果" })
      .getByRole("button", { name: "关闭对话框", exact: true })
      .click();
    const original = await w.env.app.processorRead!.byId(ref.result_id);
    const originalJob = (await w.env.app.jobs!.listJobs(10))[0]!.job_id;
    let candidateCount = 0;
    w.env.setModel((input) => {
      if (input.purpose)
        return {
          outcome: "completed",
          title: "Summary",
          statements: [
            {
              statement_id: "s1",
              category: "finding",
              epistemic: "reported",
              text: "Measured energy was 4.2 eV.",
              conditions: [],
              quantity: null,
              evidence_segment_ids: [input.segments![0]!.segment_id],
            },
          ],
        };
      const candidates = input.candidates as {
        id: string;
        independent_literature_ids: string[];
      }[];
      candidateCount = candidates.length;
      expect(
        candidates.map((candidate) => candidate.independent_literature_ids),
      ).toEqual([[w.env.parseRequest.literature_id]]);
      return {
        claims: [
          {
            text: "Evidence from one paper.",
            source_ids: candidates.map((candidate) => candidate.id),
          },
        ],
      };
    });
    await w.page
      .getByRole("button", { name: "选择来源文献", exact: true })
      .click();
    await w.page
      .getByLabel("主导航")
      .getByRole("button", { name: "快照", exact: true })
      .click();
    await w.page
      .getByRole("button", { name: "从当前筛选生成快照", exact: true })
      .click();
    await runFromSnapshot(w.page, "多篇综合", (dialog) =>
      dialog
        .getByRole("textbox", { name: "综合问题", exact: true })
        .fill("Compare chosen measurements"),
    );
    await expect.poll(() => candidateCount, { timeout: 10000 }).toBe(1);
    const snapshot = (
      await w.env.app.snapshots.list({ after: null, limit: 10 })
    ).items[0]!;
    expect(snapshot.member_count).toBe(1);
    expect(w.submissions.at(-1)!.inputs).toEqual([
      { kind: "snapshot", snapshot_id: snapshot.snapshot_id },
    ]);
    const jobs = await w.env.app.jobs!.listJobs(10);
    const synthesisJob = jobs.find((job) => job.job_id !== originalJob);
    expect(synthesisJob).toBeTruthy();
    await expect
      .poll(
        async () =>
          (await w.env.app.processingTasks!.read(synthesisJob!.job_id))
            .collections.length,
        { timeout: 10000 },
      )
      .toBe(1);
    expect(await w.env.app.processorRead!.byId(ref.result_id)).toEqual(
      original,
    );
    expect(w.env.modelCalls).toBe(4);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
it("cancels an explicit processor task and refuses its late model response", async () => {
  const w = await nextWorkspace({
    ready: '[aria-label="文献列表"] .paper-row:first-child',
  });
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
    await enterSelected(w);
    await labels(w.page);
    await submit(w.page);
    // Background work started here can outlast the 1 s poll default under Full load.
    await expect.poll(() => w.env.modelCalls, { timeout: 10000 }).toBe(1);
    const job = (await w.env.app.jobs!.listJobs(10))[0]!;
    await w.page.getByRole("button", { name: "查看任务", exact: true }).click();
    await w.page.getByRole("button", { name: "取消任务", exact: true }).click();
    await w.page
      .getByRole("dialog", { name: "取消这个任务？" })
      .getByRole("button", { name: "取消任务", exact: true })
      .click();
    release();
    // Background work started here can outlast the 1 s poll default under Full load.
    await expect
      .poll(
        async () =>
          (await w.env.app.processingTasks!.read(job.job_id)).job.status,
        { timeout: 10000 },
      )
      .toBe("cancelled");
    const task = await w.env.app.processingTasks!.read(job.job_id);
    expect(task.results).toHaveLength(0);
    expect((await w.env.app.processorRead!.list()).items).toHaveLength(0);
    expect(w.env.parseCalls).toBe(w.setupCalls.parser);
    expect(w.errors).toEqual([]);
  } finally {
    release();
    await w.close();
  }
}, 60000);
it("freezes another snapshot from the same definition and submits the synthesis question and policy from the dialog", async () => {
  const w = await nextWorkspace();
  try {
    await w.page
      .getByLabel("主导航")
      .getByRole("button", { name: "快照", exact: true })
      .click();
    await w.page
      .getByRole("button", { name: "从当前筛选生成快照", exact: true })
      .click();
    await w.page.getByRole("button", { name: "重命名", exact: true }).waitFor();
    const first = (await w.env.app.snapshots.list({ after: null, limit: 10 }))
      .items[0]!;
    // Inside a snapshot, another one is frozen from the same definition
    // without leaving the open snapshot.
    await w.page
      .getByRole("button", { name: "按原条件生成新快照", exact: true })
      .click();
    // Background work started here can outlast the 1 s poll default under Full load.
    await expect
      .poll(
        async () =>
          (await w.env.app.snapshots.list({ after: null, limit: 10 })).items
            .length,
        { timeout: 10000 },
      )
      .toBe(2);
    expect(new URL(w.page.url()).searchParams.get("snapshot")).toBe(
      first.snapshot_id,
    );
    await runFromSnapshot(w.page, "多篇综合", async (dialog) => {
      await dialog
        .getByRole("textbox", { name: "综合问题", exact: true })
        .fill("Which evidence agrees?");
      await select(w.page, "覆盖要求", "带缺口综合");
    });
    await expect.poll(() => w.submissions.length).toBeGreaterThan(0);
    expect(w.submissions.at(-1)).toMatchObject({
      inputs: [{ kind: "snapshot", snapshot_id: first.snapshot_id }],
      spec: { question: "Which evidence agrees?", policy: "allow-partial" },
    });
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("retries a failed processor scope read without submitting or discarding draft fields", async () => {
  const w = await nextWorkspace({
    ready: '[aria-label="文献列表"] .paper-row:first-child',
  });
  try {
    await w.page
      .getByLabel("主导航")
      .getByRole("button", { name: "算子", exact: true })
      .click();
    // The run list reads the registry first; inject the failure for the dialog's own read.
    await w.page
      .getByRole("button", { name: /按算子筛选/ })
      .and(w.page.locator('[aria-haspopup="listbox"]'))
      .waitFor();
    await w.page.waitForTimeout(300);
    let injected = false;
    await w.page.route("**/api/v1/query/processors?*", async (route) => {
      if (!injected && route.request().postDataJSON().operation === "list") {
        injected = true;
        await route.fulfill({
          status: 503,
          json: { protocol_version: 1, code: "service-unavailable" },
        });
      } else await route.continue();
    });
    await openFromPage(w.page);
    await expect
      .poll(() => runner(w.page).textContent())
      .toContain("尚未提交任务");
    await runner(w.page)
      .getByRole("button", { name: "重试", exact: true })
      .click();
    await chooseOperator(w.page, "记录提取");
    await next(w.page);
    await w.page
      .getByRole("textbox", { name: "每条记录代表什么" })
      .fill("A retained draft");
    await runner(w.page)
      .getByRole("button", { name: "上一步", exact: true })
      .click();
    await next(w.page);
    expect(
      await w.page
        .getByRole("textbox", { name: "每条记录代表什么" })
        .inputValue(),
    ).toBe("A retained draft");
    expect(w.submissions).toHaveLength(0);
    expect(w.env.modelCalls).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
