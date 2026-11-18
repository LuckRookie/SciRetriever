import { captureFeature } from "./next-feature-capture-fixture.js";
import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { importExport } from "./import-flow-fixture.js";
import { missingId } from "./processor-workspace-fixture.js";
import { workbenchPdf } from "../../server/src/workbench/synthetic-fixture.js";
it("keeps discovery and import explicit and uploads a selected PDF without hidden processing", async () => {
  const w = await nextWorkspace({
    path: "/?view=disc",
    ready: ".intake-form",
  });
  try {
    await captureFeature(w.page, "react-intake");
    // Four ways in, by where papers come from (page specs “入库”).
    expect(
      await w.page
        .getByRole("tablist", { name: "入库方式" })
        .getByRole("tab")
        .allTextContents(),
    ).toEqual(["检索", "文件", "Zotero", "网页"]);
    const discoveries: unknown[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await w.page.route("**/api/discovery?*", async (route) => {
      discoveries.push(route.request().postDataJSON());
      // The first discovery stays open, as a slow source would keep it.
      if (discoveries.length === 1) await held;
      await route.fulfill({
        status: 200,
        json: {
          report: {
            discovery_run_id: "00000000-0000-0000-0000-000000000981",
            status: "COMPLETED",
            accepted_count: 0,
            matched_count: 0,
            source_results: [],
            fixture: true,
          },
        },
      });
    });
    await w.page
      .getByRole("textbox", { name: "主题或检索式" })
      .fill("photoredox catalysis");
    await w.page.getByRole("textbox", { name: "年份起" }).fill("2018");
    await w.page.getByRole("button", { name: "开始发现", exact: true }).click();
    await w.page.getByRole("button", { name: "取消", exact: true }).click();
    expect(discoveries).toHaveLength(0);
    await w.page.getByRole("button", { name: "开始发现", exact: true }).click();
    await w.page
      .getByRole("dialog", { name: "确认发现文献" })
      .getByRole("button", { name: "确认执行", exact: true })
      .click();
    await expect.poll(() => discoveries.length).toBe(1);
    // The dialog closes at once; the running batch is followed in the records.
    await w.page
      .getByRole("dialog", { name: "确认发现文献" })
      .waitFor({ state: "hidden" });
    const running = w.page.getByRole("button", {
      name: "正在发现…",
      exact: true,
    });
    expect(await running.isDisabled()).toBe(true);
    expect(await w.page.getByText("正在查找，进度见下方入库记录").count()).toBe(
      1,
    );
    release();
    await w.page
      .getByRole("button", { name: "开始发现", exact: true })
      .waitFor();
    expect(discoveries[0]).toEqual({
      query: "photoredox catalysis",
      scan_limit: 200,
      year_from: 2018,
      year_to: null,
    });
    await w.page.getByRole("tab", { name: "引用扩展", exact: true }).click();
    await w.page
      .getByRole("textbox", { name: "种子文献 ID" })
      .fill(w.env.parseRequest.literature_id);
    await w.page.getByRole("button", { name: "开始扩展", exact: true }).click();
    await w.page
      .getByRole("dialog", { name: "确认发现文献" })
      .getByRole("button", { name: "开始扩展", exact: true })
      .click();
    await expect.poll(() => discoveries.length).toBe(2);
    expect(discoveries[1]).toMatchObject({
      kind: "citation",
      seed_literature_id: w.env.parseRequest.literature_id,
      direction: "references",
    });
    // An export file goes through its batch and the batch's report.
    const imported = await importExport(w.page, {
      name: "fixture.bib",
      content: "@article{fixture,title={Synthetic bibliography}}",
    });
    await imported.getByText("新增 1").waitFor();
    await imported.getByRole("button", { name: "返回入库" }).click();
    // The intake page has no upload tab; a PDF is added from the paper's reader.
    expect(
      await w.page.getByRole("tab", { name: "上传 PDF", exact: true }).count(),
    ).toBe(0);
    await w.page.goto(`${w.origin}/?literature=${missingId}&reader=pdf`);
    await w.page.getByRole("button", { name: "更多", exact: true }).click();
    await w.page
      .getByRole("menuitem", { name: "上传 PDF", exact: true })
      .click();
    await w.page.getByLabel("PDF 文件", { exact: true }).setInputFiles({
      name: "fixture.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(workbenchPdf("10.1234/intake-test")),
    });
    expect((await w.env.app.library.detail(missingId)).primary_pdf).toBeNull();
    await w.page.getByRole("button", { name: "确认上传", exact: true }).click();
    // Background work started here can outlast the 1 s poll default under Full load.
    await expect
      .poll(
        async () =>
          (await w.env.app.library.detail(missingId)).primary_pdf !== null,
        { timeout: 20_000 },
      )
      .toBe(true);
    expect(w.env.modelCalls).toBe(0);
    expect(w.env.parseCalls).toBe(w.setupCalls.parser);
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("records each import as a batch, narrows it by its keywords and gets PDFs for exactly the stated scope", async () => {
  const w = await nextWorkspace({
    path: "/?view=disc",
    ready: ".intake-form",
  });
  try {
    const page = w.page;
    const imported = await importExport(page, {
      name: "batch-fixture.bib",
      content: [
        "@article{a,title={Argyrodite electrolyte one},year={2021},doi={10.5555/batch-a},keywords={Argyrodite, Interface}}",
        "@article{b,title={Argyrodite electrolyte two},year={2022},doi={10.5555/batch-b},keywords={Argyrodite}}",
        "@article{c,title={Halide electrolyte three},year={2023},doi={10.5555/batch-c},keywords={Halide}}",
      ].join("\n"),
    });
    await imported.getByRole("button", { name: "返回入库" }).click();
    // The import is a persistent record, not a session receipt.
    const record = page.locator(".intake-record", {
      hasText: "batch-fixture.bib",
    });
    await expect.poll(() => record.textContent()).toContain("新增 3");
    expect(await record.textContent()).toContain("待获取 3");
    await page.reload();
    await record.waitFor();
    // The sidebar lists it under the newest batches.
    await page
      .getByRole("group", { name: "最近入库" })
      .getByRole("button", { name: /batch-fixture\.bib/ })
      .click();
    await expect.poll(() => page.locator(".paper-row").count()).toBe(3);
    const query = JSON.parse(new URL(page.url()).searchParams.get("query")!);
    expect(query.intake_batch_ids).toHaveLength(1);
    await page.getByRole("heading", { name: /batch-fixture\.bib/ }).waitFor();
    // The commonest terms in scope narrow it further.
    const terms = page.getByRole("region", { name: "范围内的词" });
    await terms
      .getByRole("button", { name: "作者关键词 Argyrodite，2 篇", exact: true })
      .click();
    await expect.poll(() => page.locator(".paper-row").count()).toBe(2);
    // “Current results” takes the whole filter, and the dialog states it before submitting.
    await page.getByRole("button", { name: /^用当前结果/ }).click();
    await page
      .getByRole("menuitem", { name: "获取 PDF…", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "获取 PDF", exact: true });
    await expect
      .poll(() => dialog.locator(".acquire-scope").textContent())
      .toContain("2 篇");
    expect(await dialog.locator(".acquire-scope").textContent()).toContain(
      "作者关键词：Argyrodite",
    );
    await dialog.getByRole("textbox", { name: "本次最多" }).fill("1");
    await expect
      .poll(() => dialog.locator(".acquire-scope").textContent())
      .toContain("1 篇超出本次上限");
    await dialog
      .getByRole("checkbox", { name: "保存后立即执行", exact: true })
      .press("Space");
    await dialog
      .getByRole("button", { name: "获取 1 篇", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "查看任务", exact: true })
      .waitFor();
    const jobs = await w.env.app.jobs!.listJobs(10);
    expect(jobs).toHaveLength(1);
    expect(JSON.stringify(jobs[0])).toContain("intake_batch_ids");
    await dialog.getByRole("button", { name: "查看任务", exact: true }).click();
    await page.locator(".task-scope").waitFor();
    expect(await page.locator(".task-scope").textContent()).toContain(
      "作者关键词：Argyrodite",
    );
    expect(w.env.modelCalls).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("says how to connect the extension until one is connected, then where Zotero and web pages come in (page specs “入库”)", async () => {
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  try {
    const page = w.page;
    await page.getByRole("tab", { name: "Zotero", exact: true }).click();
    const panel = page.getByRole("tabpanel");
    await panel.getByText("没有连接扩展").waitFor();
    const steps = panel.locator(".intake-extension-steps > li");
    expect(await steps.count()).toBe(3);
    await steps
      .nth(0)
      .getByRole("button", { name: "下载扩展安装包", exact: true })
      .click();
    await steps.nth(0).getByText("扩展安装包尚未构建").waitFor();
    await steps
      .nth(1)
      .getByRole("button", { name: "复制扩展页面地址", exact: true })
      .waitFor();
    await steps
      .nth(2)
      .getByRole("button", { name: "前往设备连接", exact: true })
      .waitFor();
    await page.getByRole("tab", { name: "网页", exact: true }).click();
    await panel
      .getByText(
        "在出版社或预印本的文献页面上，点浏览器工具栏里的扩展按钮即可收藏。",
      )
      .waitFor();
    await panel.getByText("没有连接扩展").waitFor();
    // Paired connections: an Agent, and one made before kinds existed, are
    // not the extension; the extension is.
    const pair = async (name: string, kind?: "extension" | "agent") => {
      const { connection_code } = await w.env.app.deviceConnections.create({
        address: w.origin,
        name,
        purposes: ["intake"],
        ...(kind ? { kind } : {}),
      });
      await fetch(`${w.origin}/api/v1/device-connections/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairing_code: connection_code.split(":")[2] }),
      });
    };
    await pair("办公室笔记本", "agent");
    await pair("旧连接");
    await page.reload();
    await page.getByRole("tab", { name: "Zotero", exact: true }).click();
    await panel.getByText("没有连接扩展").waitFor();
    await pair("Chrome 扩展", "extension");
    await page.reload();
    await page.getByRole("tab", { name: "Zotero", exact: true }).click();
    await panel.getByText("已连接扩展 · Chrome 扩展").waitFor();
    await panel
      .getByText(
        "在扩展里选择要导入的库和分组。导入开始后，这里的入库记录会出现这一批。",
      )
      .waitFor();
    expect(await steps.count()).toBe(0);
    // 网页 says the same.
    await page.getByRole("tab", { name: "网页", exact: true }).click();
    await panel.getByText("已连接扩展 · Chrome 扩展").waitFor();
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("takes any scan limit of at least 1, 50,000 included, as the discovery's scan_limit, and sends citation limits only when filled in (ADR 0022 §3, ADR 0064)", async () => {
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  try {
    const page = w.page;
    const discoveries: unknown[] = [];
    await page.route("**/api/discovery?*", async (route) => {
      discoveries.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        json: {
          report: {
            discovery_run_id: "00000000-0000-0000-0000-000000000982",
            status: "COMPLETED",
            accepted_count: 0,
            matched_count: 0,
            source_results: [],
            fixture: true,
          },
        },
      });
    });
    await page.getByText("每个来源最多扫描的原始条数，不少于 1。").waitFor();
    await page.getByRole("textbox", { name: "主题或检索式" }).fill("halide");
    const limit = page.getByRole("textbox", { name: "逐来源扫描上限" });
    await limit.fill("50000");
    await limit.press("Tab");
    await page.getByRole("button", { name: "开始发现", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "确认发现文献" });
    await dialog.getByText("每来源最多 50000 条").waitFor();
    await dialog.getByRole("button", { name: "确认执行", exact: true }).click();
    await expect.poll(() => discoveries.length).toBe(1);
    expect(discoveries[0]).toMatchObject({
      query: "halide",
      scan_limit: 50000,
    });
    // Citation expansion is bounded by depth: 1 by default, and its count
    // limits are left out unless filled in, meaning no limit (ADR 0064).
    await page.getByRole("tab", { name: "引用扩展", exact: true }).click();
    await page.getByText("从种子往外扩展几层引用。", { exact: true }).waitFor();
    await page
      .getByRole("textbox", { name: "种子文献 ID" })
      .fill(w.env.parseRequest.literature_id);
    expect(
      await page
        .getByRole("textbox", { name: "层数", exact: true })
        .inputValue(),
    ).toBe("1");
    for (const name of ["结果上限", "扫描上限"]) {
      const field = page.getByRole("textbox", { name, exact: true });
      expect(await field.inputValue()).toBe("");
      // Optional limits have no plus and minus buttons (design core rule 11).
      expect(
        await page
          .locator(".ui-field", { has: field })
          .getByRole("button", { name: "增加" })
          .count(),
      ).toBe(0);
    }
    expect(
      await page
        .locator(".ui-field", {
          has: page.getByRole("textbox", { name: "层数", exact: true }),
        })
        .getByRole("button", { name: "增加" })
        .count(),
    ).toBe(1);
    await page.getByRole("button", { name: "开始扩展", exact: true }).click();
    const expand = page.getByRole("dialog", { name: "确认发现文献" });
    await expand.getByText("处理范围：1 层 · 不限条数").waitFor();
    await expand.getByRole("button", { name: "开始扩展", exact: true }).click();
    await expect.poll(() => discoveries.length).toBe(2);
    expect(discoveries[1]).toEqual({
      kind: "citation",
      seed_literature_id: w.env.parseRequest.literature_id,
      direction: "references",
      max_depth: 1,
    });
    await page.getByRole("button", { name: "开始扩展", exact: true }).waitFor();
    const depth = page.getByRole("textbox", { name: "层数", exact: true });
    await depth.fill("3");
    await depth.press("Tab");
    const cited = page.getByRole("textbox", { name: "扫描上限", exact: true });
    await cited.fill("50000");
    await cited.press("Tab");
    await page.getByRole("button", { name: "开始扩展", exact: true }).click();
    await expand.getByText("处理范围：3 层 · 每来源最多 50,000 条").waitFor();
    await expand.getByRole("button", { name: "开始扩展", exact: true }).click();
    await expect.poll(() => discoveries.length).toBe(3);
    expect(discoveries[2]).toEqual({
      kind: "citation",
      seed_literature_id: w.env.parseRequest.literature_id,
      direction: "references",
      max_depth: 3,
      scan_limit: 50000,
    });
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("reads a citation expansion's null limits back as 不限 in the task details (ADR 0064)", async () => {
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  try {
    const job = await w.env.app.processingTasks!.submit({
      schema_version: 1,
      idempotency_key: "web-citation-unbounded",
      operations: [
        {
          operation: "acquire-metadata",
          request: {
            kind: "citation",
            seed_literature_ids: [w.env.parseRequest.literature_id],
            direction: "references",
            max_depth: 2,
            result_limit: null,
            providers: [{ source: "openalex", scan_limit: null }],
          },
        },
      ],
    });
    await w.page.goto(
      `${w.origin}/?view=task&task=${encodeURIComponent(job.job_id)}`,
    );
    const scope = w.page
      .getByRole("region", { name: "任务详情" })
      .getByLabel("扩展范围");
    await scope.waitFor();
    expect(await scope.locator("dd").allTextContents()).toEqual([
      "2 层",
      "不限",
      "不限",
    ]);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
