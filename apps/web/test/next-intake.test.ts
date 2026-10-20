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
            accepted: 0,
            fixture: true,
          },
        },
      });
    });
    await w.page.route("**/api/import?*", async (route) => {
      imports.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        json: { report: { accepted: 0, fixture: true } },
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
    await expect
      .poll(
        async () =>
          (await w.env.app.library.detail(missingId)).primary_pdf !== null,
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

it("retains only the latest 30 discovery reports during a session and clears them on reload", async () => {
  const w = await nextWorkspace({
    path: "/?view=disc",
    ready: ".intake-form",
  });
  try {
    const page = w.page;
    let calls = 0;
    await page.route("**/api/discovery?*", async (route) => {
      calls++;
      await route.fulfill({
        status: 200,
        json: { report: { accepted: calls, fixture: true } },
      });
    });
    await page
      .getByRole("textbox", { name: "主题或检索式" })
      .fill("synthetic history boundary");
    for (let i = 1; i <= 31; i++) {
      await page.getByRole("button", { name: "开始发现", exact: true }).click();
      await page
        .getByRole("dialog", { name: "确认发现文献", exact: true })
        .getByRole("button", { name: "确认执行", exact: true })
        .click();
      await expect
        .poll(() => page.locator(".intake-report").first().textContent())
        .toContain(`已接纳 ${i} 条元数据`);
    }
    expect(calls).toBe(31);
    expect(await page.locator(".intake-report").count()).toBe(30);
    expect(await page.locator(".intake-report").last().textContent()).toContain(
      "已接纳 2 条元数据",
    );
    await page
      .getByRole("button", { name: /^文献库/ })
      .first()
      .click();
    await page.locator(".paper-row").first().waitFor();
    await page.getByRole("button", { name: "发现", exact: true }).click();
    await expect.poll(() => page.locator(".intake-report").count()).toBe(30);
    await page.reload();
    await page.getByText("尚未执行发现或导入。", { exact: true }).waitFor();
    expect(await page.locator(".intake-report").count()).toBe(0);
    expect(calls).toBe(31);
    expect(w.env.modelCalls).toBe(0);
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);
