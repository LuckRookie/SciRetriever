import { captureFeature } from "./next-feature-capture-fixture.js";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import type { Page } from "playwright";
import { unzipSync, strFromU8 } from "fflate";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { assertMachineReadsWebResult } from "../../server/test/processor-machine-read-fixture.js";
type Workspace = Awaited<ReturnType<typeof nextWorkspace>>;
async function select(page: Page, label: string, option: string) {
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function enterSelected(w: Workspace, missing = false) {
  const paper = missing
    ? "Unparsed source"
    : (await w.env.app.library.detail(w.env.parseRequest.literature_id))
        .literature.metadata.title!;
  await w.page
    .getByRole("checkbox", { name: `选择 ${paper}`, exact: true })
    .focus();
  await w.page.keyboard.press("Space");
  await w.page.getByRole("button", { name: "提取", exact: true }).click();
  await expect
    .poll(() =>
      w.page.getByRole("button", { name: "开始提取", exact: true }).isEnabled(),
    )
    .toBe(true);
}
async function labels(page: Page) {
  await page.getByRole("tab", { name: "文献标签", exact: true }).click();
  await page
    .getByRole("textbox", { name: "对每篇文献问一个问题" })
    .fill("Does the source report a measurement?");
}
async function submit(page: Page, name = "开始提取") {
  await page.getByRole("button", { name, exact: true }).click();
  await page
    .getByRole("dialog", { name: "确认处理文献" })
    .getByRole("button", { name: "确认并创建处理任务", exact: true })
    .click();
}
async function completed(w: Workspace) {
  await expect
    .poll(async () => (await w.env.app.jobs!.listJobs(10)).length)
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
    await w.page.getByRole("button", { name: "开始提取", exact: true }).click();
    expect(
      await w.page
        .getByRole("textbox", { name: "每条记录代表什么" })
        .getAttribute("aria-invalid"),
    ).toBe("true");
    expect(w.submissions).toHaveLength(0);
    await w.page
      .getByRole("button", { name: /^文献库/ })
      .first()
      .click();
    await w.page.getByRole("button", { name: "提取", exact: true }).click();
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
    await w.page.getByRole("button", { name: "开始提取", exact: true }).click();
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
    expect(input.kind).toBe("document");
    if (input.kind !== "document") throw new Error("expected document");
    expect(input.document.document_version_id).toBe(
      w.parsed.document.document_version_id,
    );
    expect(input.document.source_material_ref.asset_sha256).toBe(
      w.env.asset.sha256,
    );
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
    expect(w.env.parseCalls).toBe(1);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
it("submits enum labels on an explicit search scope and retains unparsed material as a gap", async () => {
  const w = await nextWorkspace({
    path: "/?view=ext",
    ready: "form.processor-form",
  });
  try {
    await labels(w.page);
    await select(w.page, "答案类型", "指定选项");
    await w.page
      .getByRole("textbox", { name: "可选答案" })
      .fill("reported\nreported");
    await w.page
      .getByRole("button", { name: "生成文献标签", exact: true })
      .click();
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
    await w.page
      .getByRole("button", { name: "生成文献标签", exact: true })
      .click();
    expect(await w.page.getByRole("alert").last().textContent()).toContain(
      "关键词",
    );
    await w.page.getByRole("textbox", { name: "片段关键词" }).fill("measured");
    w.env.setModel((input) => ({
      answer: "reported",
      source_ids: [input.segments![0]!.segment_id],
      reason: null,
    }));
    await submit(w.page, "生成文献标签");
    const collection = await completed(w);
    expect(w.submissions[0]!.inputs).toHaveLength(2);
    expect(collection.members).toHaveLength(2);
    expect(collection.members.filter((item) => item.result)).toHaveLength(1);
    expect(collection.members.find((item) => !item.result)?.gap).toBeTruthy();
    const ref = collection.members.find((item) => item.result)!.result!,
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
    expect(w.env.parseCalls).toBe(1);
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
    await submit(w.page, "生成文献标签");
    await expect
      .poll(() =>
        w.page
          .getByRole("dialog", { name: "确认处理文献" })
          .getByRole("alert")
          .textContent(),
      )
      .toContain("test-lost-receipt");
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(1);
    await w.page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭对话框", exact: true })
      .click();
    await w.page
      .getByRole("button", { name: /^文献库/ })
      .first()
      .click();
    await w.page.getByRole("button", { name: "提取", exact: true }).click();
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
    await submit(w.page, "生成文献标签");
    await expect
      .poll(() =>
        w.page
          .getByRole("complementary", { name: "处理范围与提交" })
          .textContent(),
      )
      .toContain("启动状态未确认");
    expect(w.submissions).toHaveLength(2);
    expect(w.submissions[1]).toEqual(w.submissions[0]);
    const job = (await w.env.app.jobs!.listJobs(10))[0]!;
    expect((await w.env.app.processingTasks!.read(job.job_id)).job.status).toBe(
      "queued",
    );
    expect(w.env.modelCalls).toBe(0);
    await submit(w.page, "生成文献标签");
    await completed(w);
    expect(w.submissions).toHaveLength(2);
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(1);
    expect(w.env.modelCalls).toBe(1);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
it("preserves a valid form when the analysis model is absent and never processes missing documents", async () => {
  const w = await nextWorkspace({
    analysisModel: false,
    ready: '[aria-label="文献列表"] .paper-row:first-child',
  });
  try {
    await enterSelected(w, true);
    await labels(w.page);
    await submit(w.page, "生成文献标签");
    await expect
      .poll(() =>
        w.page
          .getByRole("dialog", { name: "确认处理文献" })
          .getByRole("alert")
          .textContent(),
      )
      .toContain("分析模型配置不可用");
    await w.page.keyboard.press("Escape");
    expect(
      await w.page
        .getByRole("textbox", { name: "对每篇文献问一个问题" })
        .inputValue(),
    ).toContain("measurement");
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(0);
    expect(w.env.modelCalls).toBe(0);
    expect(w.env.parseCalls).toBe(1);
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
    const chosen: string[] = [];
    for (const offset of [0, 10]) {
      const rows = await w.env.app.processorRead!.query({
        collection_id: null,
        result_ids: [ref.result_id],
        filters: [],
        sort: null,
        limit: 10,
        offset,
      });
      chosen.push(rows.items[0]!.record_id);
    }
    let candidateCount = 0;
    w.env.setModel((input) => {
      const candidates = input.candidates as {
        id: string;
        independent_literature_ids: string[];
      }[];
      candidateCount = candidates.length;
      expect(
        candidates.every(
          (item) => item.independent_literature_ids.length === 1,
        ),
      ).toBe(true);
      return {
        statements: [
          {
            text: "Two selected observations from one paper.",
            source_ids: candidates.map((item) => item.id),
          },
        ],
      };
    });
    await w.page
      .getByRole("button", { name: "用所选记录综合", exact: true })
      .click();
    await w.page
      .getByRole("textbox", { name: "研究问题", exact: true })
      .fill("Compare chosen measurements");
    await w.page
      .getByRole("button", { name: "确认并创建综合任务", exact: true })
      .click();
    await expect.poll(() => candidateCount, { timeout: 10000 }).toBe(2);
    expect(w.submissions.at(-1)!.inputs).toEqual([
      { kind: "result", result_id: ref.result_id, record_ids: chosen.sort() },
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
    expect(w.env.modelCalls).toBe(2);
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
    await submit(w.page, "生成文献标签");
    await expect.poll(() => w.env.modelCalls).toBe(1);
    const job = (await w.env.app.jobs!.listJobs(10))[0]!;
    await w.page.getByRole("button", { name: "查看任务", exact: true }).click();
    await w.page.getByRole("button", { name: "取消任务", exact: true }).click();
    await w.page
      .getByRole("dialog", { name: "取消这个任务？" })
      .getByRole("button", { name: "取消任务", exact: true })
      .click();
    release();
    await expect
      .poll(
        async () =>
          (await w.env.app.processingTasks!.read(job.job_id)).job.status,
      )
      .toBe("cancelled");
    const task = await w.env.app.processingTasks!.read(job.job_id);
    expect(task.results).toHaveLength(0);
    expect((await w.env.app.processorRead!.list()).items).toHaveLength(0);
    expect(w.env.parseCalls).toBe(1);
    expect(w.errors).toEqual([]);
  } finally {
    release();
    await w.close();
  }
}, 60000);
it("retains the synthesis question and policy but invalidates fixed inputs when selection changes", async () => {
  const w = await nextWorkspace({
    ready: '[aria-label="文献列表"] .paper-row:first-child',
  });
  try {
    const title = (
      await w.env.app.library.detail(w.env.parseRequest.literature_id)
    ).literature.metadata.title!;
    await w.page
      .getByRole("checkbox", { name: `选择 ${title}`, exact: true })
      .focus();
    await w.page.keyboard.press("Space");
    await w.page.getByRole("button", { name: "综合", exact: true }).click();
    await w.page.getByRole("button", { name: "新建综合", exact: true }).click();
    await w.page
      .getByRole("textbox", { name: "研究问题", exact: true })
      .fill("Which evidence agrees?");
    await select(w.page, "缺口策略", "允许部分覆盖，明确记录缺口");
    await w.page.getByRole("button", { name: "固定输入", exact: true }).click();
    await expect
      .poll(() =>
        w.page
          .getByRole("button", { name: "开始综合", exact: true })
          .isEnabled(),
      )
      .toBe(true);
    await w.page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭对话框", exact: true })
      .click();
    await w.page
      .getByRole("button", { name: /^文献库/ })
      .first()
      .click();
    await w.page
      .getByRole("checkbox", { name: "选择已加载的文献", exact: true })
      .focus();
    await w.page.keyboard.press("Space");
    await w.page.getByRole("button", { name: "综合", exact: true }).click();
    await w.page.getByRole("button", { name: "新建综合", exact: true }).click();
    expect(
      await w.page
        .getByRole("textbox", { name: "研究问题", exact: true })
        .inputValue(),
    ).toBe("Which evidence agrees?");
    expect(
      await w.page.getByRole("button", { name: /缺口策略/ }).textContent(),
    ).toContain("允许部分覆盖");
    expect(
      await w.page
        .getByRole("button", { name: "开始综合", exact: true })
        .isDisabled(),
    ).toBe(true);
    expect(
      await w.page.getByRole("dialog", { name: "新建综合" }).textContent(),
    ).toContain("2 篇文献");
    expect(w.env.modelCalls).toBe(0);
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
    await w.page.getByRole("button", { name: "提取", exact: true }).click();
    await w.page
      .getByRole("textbox", { name: "每条记录代表什么" })
      .fill("A retained draft");
    const side = w.page.getByRole("complementary", { name: "处理范围与提交" });
    await expect.poll(() => side.textContent()).toContain("尚未提交任务");
    await side.getByRole("button", { name: "重试", exact: true }).click();
    await expect
      .poll(() =>
        w.page
          .getByRole("button", { name: "开始提取", exact: true })
          .isEnabled(),
      )
      .toBe(true);
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
