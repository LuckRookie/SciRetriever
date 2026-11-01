import { captureFeature } from "./next-feature-capture-fixture.js";
import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { missingId } from "./processor-workspace-fixture.js";
import { workbenchPdf } from "../../server/src/workbench/synthetic-fixture.js";
it("keeps discovery and bibliography import explicit and uploads a selected PDF without hidden processing", async () => {
  const w = await nextWorkspace({
    path: "/?view=disc",
    ready: ".intake-form",
  });
  try {
    await captureFeature(w.page, "react-intake");
    const discoveries: unknown[] = [],
      imports: unknown[] = [];
    await w.page.route("**/api/discovery?*", async (route) => {
      discoveries.push(route.request().postDataJSON());
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
    await w.page.route("**/api/import?*", async (route) => {
      imports.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        json: { report: { format: "bibtex", items: [] } },
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
    await w.page.getByRole("button", { name: "开始发现", exact: true }).click();
    await w.page
      .getByRole("dialog", { name: "确认发现文献" })
      .getByRole("button", { name: "确认执行", exact: true })
      .click();
    await expect.poll(() => discoveries.length).toBe(2);
    expect(discoveries[1]).toMatchObject({
      kind: "citation",
      seed_literature_id: w.env.parseRequest.literature_id,
      direction: "references",
    });
    await w.page.getByRole("tab", { name: "导入书目", exact: true }).click();
    await w.page.getByLabel("书目文件", { exact: true }).setInputFiles({
      name: "fixture.bib",
      mimeType: "text/plain",
      buffer: Buffer.from("@article{fixture,title={Synthetic bibliography}}"),
    });
    await w.page.getByRole("button", { name: "导入", exact: true }).click();
    await w.page
      .getByRole("dialog", { name: "导入书目", exact: true })
      .getByRole("button", { name: "确认执行", exact: true })
      .click();
    await expect.poll(() => imports.length).toBe(1);
    expect(imports[0]).toEqual({
      format: "bibtex",
      content: "@article{fixture,title={Synthetic bibliography}}",
      file_name: "fixture.bib",
    });
    await w.page.getByRole("tab", { name: "上传 PDF", exact: true }).click();
    await w.page.getByRole("textbox", { name: "目标文献 ID" }).fill(missingId);
    await w.page.getByLabel("PDF 文件", { exact: true }).setInputFiles({
      name: "fixture.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(workbenchPdf("10.1234/intake-test")),
    });
    await w.page
      .getByRole("button", { name: "选择并上传", exact: true })
      .click();
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
    await page.getByRole("tab", { name: "导入书目", exact: true }).click();
    await page.getByLabel("书目文件", { exact: true }).setInputFiles({
      name: "batch-fixture.bib",
      mimeType: "text/plain",
      buffer: Buffer.from(
        [
          "@article{a,title={Argyrodite electrolyte one},year={2021},doi={10.5555/batch-a},keywords={Argyrodite, Interface}}",
          "@article{b,title={Argyrodite electrolyte two},year={2022},doi={10.5555/batch-b},keywords={Argyrodite}}",
          "@article{c,title={Halide electrolyte three},year={2023},doi={10.5555/batch-c},keywords={Halide}}",
        ].join("\n"),
      ),
    });
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page
      .getByRole("dialog", { name: "导入书目", exact: true })
      .getByRole("button", { name: "确认执行", exact: true })
      .click();
    // The import is a persistent record, not a session receipt.
    const record = page.locator(".intake-record", {
      hasText: "batch-fixture.bib",
    });
    await expect.poll(() => record.textContent()).toContain("命中 3");
    expect(await record.textContent()).toContain("新增 3");
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
