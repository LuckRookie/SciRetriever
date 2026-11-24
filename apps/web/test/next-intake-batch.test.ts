import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Page, Route } from "playwright";
import { nextWorkspace } from "./next-workspace-fixture.js";

/** A batch from an export of two records, opened on its page. */
async function exportBatch(page: Page) {
  await page.getByRole("tab", { name: "文件", exact: true }).click();
  await page.getByLabel("选择文件", { exact: true }).setInputFiles({
    name: "library.bib",
    mimeType: "text/plain",
    buffer: Buffer.from(
      [
        "@article{a,title={Argyrodite electrolyte one},year={2021},doi={10.5555/state-a}}",
        "@article{b,title={Argyrodite electrolyte two},year={2022},doi={10.5555/state-b}}",
      ].join("\n"),
    ),
  });
  await page.getByRole("button", { name: "继续", exact: true }).click();
  const view = page.getByRole("region", { name: "批次", exact: true });
  await view.getByRole("heading", { name: "library.bib" }).waitFor();
  return {
    view,
    id: new URL(page.url()).searchParams.get("session")!,
  };
}
const bodyOf = (route: Route) =>
  route.request().postDataJSON() as {
    request: { operation?: string; request?: unknown } & Record<
      string,
      unknown
    >;
  };
const batchRead = (url: URL) => url.pathname === "/api/v1/query/intake-batches";
/** The service as it is, with the batch's own read patched by `patch`. */
async function patchBatch(
  page: Page,
  patch: (batch: Record<string, unknown>) => Record<string, unknown>,
) {
  await page.unroute(batchRead);
  await page.route(batchRead, async (route) => {
    if (bodyOf(route).request.operation !== "get") return route.continue();
    try {
      const response = await route.fetch();
      const value = (await response.json()) as {
        protocol_version: 1;
        result: Record<string, unknown>;
      };
      await route.fulfill({
        response,
        json: { ...value, result: patch(value.result) },
      });
    } catch {
      // A reload drops the poll still under way; the page asks again.
      await route.abort().catch(() => undefined);
    }
  });
}
const ok = (result: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ protocol_version: 1, result }),
});
const summary = {
  full_text: { total: 0, obtained: 0, missing: 0, exhausted: 0 },
  records: {
    created: 118,
    enriched: 0,
    matched: 30,
    conflicts: 2,
    rejected: 1,
    restored: 4,
    possible_duplicates: 3,
    pending_decision: 0,
    needs_metadata: 5,
  },
  files: {
    upload: 118,
    hash: 30,
    uploaded: 0,
    existing: 0,
    conflicts: 0,
    missing: 0,
    unpaired: 1,
  },
  annotations: { supported: 7, unsupported: 2, imported: 0, deferred: 0 },
  excluded: [{ kind: "note", count: 6 }],
};
const literatureA = "00000000-0000-4000-8000-0000000000d1",
  literatureB = "00000000-0000-4000-8000-0000000000d2",
  candidate = "c".repeat(64);
const items = [
  {
    item_id: "item-1",
    origin: "data",
    sequence: 0,
    record_index: 0,
    external_id: "a",
    title: "Solid electrolytes: a review",
    file_name: null,
    recognition: null,
    possible_duplicates: [
      {
        literature_id: literatureA,
        title: "Solid electrolytes, reviewed",
        first_author: "Doe",
        publication_year: 2020,
        similarity: 0.93,
      },
      {
        literature_id: literatureB,
        title: "Solid-state electrolytes",
        first_author: "Roe",
        publication_year: 2019,
        similarity: 0.88,
      },
    ],
    unpaired: false,
    needs_decision: true,
    decision: null,
    disposition: null,
    decided_by: null,
    decided_at: null,
  },
  {
    item_id: "item-2",
    origin: "file",
    sequence: null,
    record_index: null,
    external_id: null,
    title: null,
    file_name: "scan_0041.pdf",
    recognition: {
      state: "candidates",
      step: 3,
      literature_id: null,
      candidates: [
        {
          candidate_id: candidate,
          title: "Argyrodite electrolyte one",
          authors: [
            {
              kind: "person",
              display_name: "Ada Li",
              given_name: "Ada",
              family_name: "Li",
              orcid: null,
              affiliations: [],
            },
          ],
          publication_year: 2021,
          identifiers: [],
          source_name: "crossref",
          similarity: 0.9,
        },
      ],
    },
    possible_duplicates: [],
    unpaired: false,
    needs_decision: true,
    decision: null,
    disposition: null,
    decided_by: null,
    decided_at: null,
  },
  {
    item_id: "item-3",
    origin: "file",
    sequence: null,
    record_index: null,
    external_id: null,
    title: null,
    file_name: "supplement.pdf",
    recognition: null,
    possible_duplicates: [],
    unpaired: true,
    needs_decision: false,
    decision: null,
    disposition: null,
    decided_by: null,
    decided_at: null,
  },
];

it("shows a batch awaiting confirmation: estimated counts, recognition that blocks confirming, and decisions item by item (page specs “批次页”)", async () => {
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  try {
    const page = w.page;
    const { view, id } = await exportBatch(page);
    const decided: unknown[] = [],
      cancelled: string[] = [];
    let recognizing = true;
    const route = (action: string) => (url: URL) =>
      url.pathname === `/api/v1/intake/batches/${id}/${action}`;
    await page.route(route("preview"), (r) =>
      r.fulfill(
        ok({
          batch: null,
          estimated: true,
          summary,
          recognition: recognizing
            ? { state: "running", recognized: 3, total: 10 }
            : { state: "done", recognized: 10, total: 10 },
        }),
      ),
    );
    await page.route(route("preview/cancel"), (r) => {
      cancelled.push(r.request().url());
      recognizing = false;
      return r.fulfill(ok({ batch: null, recognition: null }));
    });
    await page.route(route("items"), (r) => {
      const needs = (bodyOf(r).request as { needs?: string }).needs;
      return r.fulfill(
        ok({
          items: items.filter((item) =>
            needs === "unpaired" ? item.unpaired : item.needs_decision,
          ),
          next_cursor: null,
        }),
      );
    });
    await page.route(
      (url) =>
        url.pathname.startsWith(`/api/v1/intake/batches/${id}/items/`) &&
        url.pathname.endsWith("/decide"),
      (r) => {
        const item = r.request().url().split("/items/")[1]!.split("/")[0]!;
        decided.push([
          item,
          (bodyOf(r).request as { decision: unknown }).decision,
        ]);
        return r.fulfill(
          ok({ item: { ...items.find((i) => i.item_id === item) } }),
        );
      },
    );
    await page.reload();

    // Counts, as estimates, in the spec's categories and order.
    await view
      .getByText("预览（估计，确认时按当时的文献库重新判定）")
      .waitFor();
    await expect
      .poll(() => view.getByLabel("书目计数").textContent())
      .toBe("新增 118已在库 30恢复 4冲突 2可能重复 3书目不全 5未接纳 1");
    expect(await view.getByLabel("文件计数").textContent()).toBe(
      "要上传 118只核对 30",
    );
    expect(await view.getByLabel("批注计数").textContent()).toBe(
      "可导入 7不能导入 2",
    );
    expect(await view.getByLabel("不导入的内容计数").textContent()).toBe(
      "笔记 6",
    );
    // Recognition runs: it can be stopped, and confirming waits for it.
    await view.getByText("正在识别文件 3 / 10").waitFor();
    const confirm = view.getByRole("button", { name: "确认入库", exact: true });
    expect(await confirm.isDisabled()).toBe(true);
    expect(await view.locator(".intake-batch-wait").textContent()).toBe(
      "正在识别文件，完成后才能确认",
    );

    // Three kinds of decision, each headed with its count.
    await view.getByRole("heading", { name: "需要决定（3）" }).waitFor();
    const duplicates = view.getByRole("group", { name: "可能重复" }),
      candidates = view.getByRole("group", { name: "可能是这一篇" }),
      unpaired = view.getByRole("group", { name: "未配对的文件" });
    await duplicates.getByText("Solid electrolytes: a review").waitFor();
    await duplicates.getByRole("button", { name: "并入" }).click();
    expect(await page.getByRole("menuitem").allTextContents()).toEqual([
      "Solid electrolytes, reviewed · Doe · 2020",
      "Solid-state electrolytes · Roe · 2019",
    ]);
    await page
      .getByRole("menuitem", { name: "Solid-state electrolytes · Roe · 2019" })
      .click();
    await duplicates.getByRole("button", { name: "新增", exact: true }).click();
    await candidates.getByText("scan_0041.pdf").waitFor();
    await candidates.getByRole("button", { name: "采用" }).click();
    await page
      .getByRole("menuitem", {
        name: "Argyrodite electrolyte one · Ada Li · 2021",
      })
      .click();
    await candidates
      .getByRole("button", { name: "都不是", exact: true })
      .click();
    await unpaired
      .getByRole("button", { name: "作为单独的文献入库", exact: true })
      .click();
    await unpaired.getByRole("button", { name: "不入库", exact: true }).click();
    await expect.poll(() => decided.length).toBe(6);
    expect(decided).toEqual([
      ["item-1", { kind: "merge", literature_id: literatureB }],
      ["item-1", { kind: "new" }],
      ["item-2", { kind: "candidate", candidate_id: candidate }],
      ["item-2", { kind: "unrecognized" }],
      ["item-3", { kind: "include" }],
      ["item-3", { kind: "exclude" }],
    ]);

    // Stopping recognition lets the batch be confirmed.
    await view.getByRole("button", { name: "停止识别", exact: true }).click();
    await expect.poll(() => cancelled.length).toBe(1);
    await expect.poll(() => confirm.isDisabled()).toBe(false);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("confirms without blocking, follows the progress by polling, restores after a reload, and starts nothing networked by itself", async () => {
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  try {
    const page = w.page;
    const { view, id } = await exportBatch(page);
    // Everything that could fetch, parse or spend.
    const started: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      // Reading the task list starts nothing.
      if (request.method() === "GET") return;
      if (
        path.startsWith("/api/tasks") ||
        path.startsWith("/api/discovery") ||
        path === "/api/v1/query/acquire-pdf-preview"
      )
        started.push(`${request.method()} ${path}`);
    });
    // Once confirmed, the batch reads as running for a while, one record
    // processed and then both; then as it is. Polls every 3 s follow it.
    let since = 0;
    await patchBatch(page, (batch) => {
      if (batch.state !== "running" && batch.state !== "finished") return batch;
      since ||= Date.now();
      const elapsed = Date.now() - since;
      if (elapsed > 8000) return batch;
      return {
        ...batch,
        state: "running",
        result: null,
        finished_at: null,
        progress: {
          phase: "metadata",
          processed_items: elapsed < 4000 ? 1 : 2,
          total_items: 2,
          files: { uploaded: 0, existing: 0, conflicts: 0, pending: 0 },
        },
      };
    });
    await view.getByRole("button", { name: "确认入库", exact: true }).click();
    await page
      .getByRole("dialog", { name: "确认入库" })
      .getByRole("button", { name: "确认入库", exact: true })
      .click();
    // The dialog closes at once; the page keeps answering while it runs.
    await page.getByRole("dialog", { name: "确认入库" }).waitFor({
      state: "hidden",
    });
    await view.getByText(/^书目入库 · 已处理 1 \/ 2$/u).waitFor();
    await view.getByText(/^书目入库 · 已处理 2 \/ 2$/u).waitFor();
    await view.getByRole("button", { name: "返回找文献" }).waitFor();
    // Then it finishes: the result, the report and what can follow.
    await view.getByText("完成").first().waitFor();
    await view.getByText(/^全文已取得 0 \/ 总数 2，未取得 2/u).waitFor();
    const acquire = view.getByRole("button", { name: "获取全文 2 篇" }),
      parse = view.getByRole("button", { name: "解析并形成未校对的全文 0 篇" });
    await acquire.waitFor();
    expect(await parse.isDisabled()).toBe(true);
    await view.getByText("会联网，可能花费。").waitFor();
    // A reload shows the same finished batch.
    await page.reload();
    await view.getByText(/^全文已取得 0 \/ 总数 2/u).waitFor();
    expect(new URL(page.url()).searchParams.get("session")).toBe(id);
    // Running, finished and reloaded: nothing was started by itself.
    expect(started).toEqual([]);

    // “获取全文” states its scope first, as on the library page.
    await acquire.click();
    const dialog = page.getByRole("dialog", { name: "获取 PDF", exact: true });
    await expect
      .poll(() => dialog.locator(".acquire-scope").textContent())
      .toContain("批次：library.bib");
    expect(started).toEqual(["POST /api/v1/query/acquire-pdf-preview"]);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    expect(started).toEqual(["POST /api/v1/query/acquire-pdf-preview"]);
    expect(w.env.modelCalls).toBe(0);
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("parses a batch's PDFs only from its dialog: one parse-documents task scoped to the batch", async () => {
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  try {
    const page = w.page;
    const { view, id } = await exportBatch(page);
    await view.getByRole("button", { name: "确认入库", exact: true }).click();
    await page
      .getByRole("dialog", { name: "确认入库" })
      .getByRole("button", { name: "确认入库", exact: true })
      .click();
    await view.getByText(/^全文已取得/u).waitFor();
    // Suppose two of its papers had PDFs not yet parsed.
    await patchBatch(page, (batch) => ({
      ...batch,
      estimates: { acquire_pdf: 0, parse: 2 },
    }));
    const tasks: [string, unknown][] = [];
    await page.route(
      (url) => url.pathname.startsWith("/api/tasks"),
      (route) => {
        // Reading the task list is not starting anything.
        if (route.request().method() !== "POST") return route.continue();
        const path = new URL(route.request().url()).pathname;
        tasks.push([path, route.request().postDataJSON()]);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            path === "/api/tasks" ? { task: { job_id: "job-parse-1" } } : {},
          ),
        });
      },
    );
    const parse = view.getByRole("button", {
      name: "解析并形成未校对的全文 2 篇",
    });
    await parse.click();
    const dialog = page.getByRole("dialog", { name: "解析并形成未校对的全文" });
    await dialog.getByText("批次：library.bib").waitFor();
    await dialog
      .getByText(
        "会把 PDF 交给 MinerU 解析，可能花费；解析完成后自动形成未校对的全文，不调用模型。",
      )
      .waitFor();
    expect(tasks).toEqual([]);
    await dialog
      .getByRole("button", { name: "解析 2 篇", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "查看任务", exact: true })
      .waitFor();
    const created = tasks.filter(([path]) => path === "/api/tasks");
    expect(created).toHaveLength(1);
    expect(created[0]![1]).toMatchObject({
      kind: "parse-documents",
      selector: {
        kind: "query",
        query: { intake_batch_ids: [id] },
        limit: null,
      },
    });
    // Started as getting PDFs is.
    expect(tasks.map(([path]) => path)).toEqual([
      "/api/tasks",
      "/api/tasks/job-parse-1/start",
    ]);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("shows each state's parts: collecting, running with files owed, cancelled and withdrawn", async () => {
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  try {
    const page = w.page;
    const { view } = await exportBatch(page);
    // Collecting: nothing handed in yet, only “取消”.
    await patchBatch(page, (batch) => ({ ...batch, state: "collecting" }));
    await page.reload();
    await view.getByText("还没有交来条目。").waitFor();
    await view.getByText("收集中").first().waitFor();
    expect(
      await view.getByRole("button", { name: "确认入库", exact: true }).count(),
    ).toBe(0);
    await view.getByRole("button", { name: "取消", exact: true }).waitFor();
    expect(
      await view.getByRole("heading", { name: "接着做什么" }).count(),
    ).toBe(0);
    // Confirm for real, then show it as still waiting for files.
    await page.unroute(batchRead);
    await page.reload();
    await view.getByRole("button", { name: "确认入库", exact: true }).click();
    await page
      .getByRole("dialog", { name: "确认入库" })
      .getByRole("button", { name: "确认入库", exact: true })
      .click();
    await view.getByText(/^全文已取得/u).waitFor();
    await patchBatch(page, (batch) => ({
      ...batch,
      state: "running",
      result: null,
      finished_at: null,
      progress: {
        phase: "files",
        processed_items: 2,
        total_items: 2,
        files: { uploaded: 1, existing: 1, conflicts: 1, pending: 3 },
      },
    }));
    await page.reload();
    await view.getByText("等待文件 · 已处理 2 / 2").waitFor();
    expect(await view.getByLabel("文件进度").textContent()).toBe(
      "已上传 1已有 1冲突 1待交 3",
    );
    await view.getByLabel("选择文件夹").waitFor();
    await view.getByRole("button", { name: "结束入库", exact: true }).waitFor();
    await view.getByRole("heading", { name: "接着做什么" }).waitFor();
    // Cancelled: the report and what can follow, no actions.
    await patchBatch(page, (batch) => ({
      ...batch,
      state: "cancelled",
      result: null,
    }));
    await page.reload();
    await view.getByText("已取消").first().waitFor();
    await view.getByRole("heading", { name: "报告" }).waitFor();
    await view.getByRole("heading", { name: "接着做什么" }).waitFor();
    expect(
      await view.getByRole("button", { name: "取消", exact: true }).count(),
    ).toBe(0);
    // Withdrawn: the counts only.
    await patchBatch(page, (batch) => ({ ...batch, state: "withdrawn" }));
    await page.reload();
    await view.getByText("已撤回").first().waitFor();
    await view.getByLabel("书目计数").getByText("新增 2").waitFor();
    expect(await view.getByRole("heading", { name: "报告" }).count()).toBe(0);
    expect(
      await view.getByRole("heading", { name: "接着做什么" }).count(),
    ).toBe(0);
    // In the records, the same row whatever the state.
    await view.getByRole("button", { name: "返回找文献" }).click();
    await page
      .locator(".intake-record", { hasText: "library.bib" })
      .getByText("网页")
      .waitFor();
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("shows the intake page's four parts, the drop zone and the batch page in each state (plan 25 block 12 screenshots)", async (context) => {
  const output = process.env.SCIRETRIEVER_WEB_INTAKE_SHOTS;
  if (!output) return context.skip();
  await mkdir(output, { recursive: true });
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  try {
    const page = w.page;
    await page.emulateMedia({ reducedMotion: "reduce" });
    const shot = async (name: string, width = 1440) => {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await page.screenshot({
        path: join(output, `${name}.png`),
        fullPage: true,
      });
    };
    const tab = (name: string) =>
      page.getByRole("tab", { name, exact: true }).click();
    // The four parts.
    await shot("intake-search");
    await tab("文件");
    await shot("intake-files");
    await tab("Zotero");
    await page.getByText("没有连接扩展").waitFor();
    await shot("intake-zotero");
    await tab("网页");
    await shot("intake-web");
    // The drop zone holding an export, a PDF and a file it cannot tell.
    await tab("文件");
    await page.getByLabel("选择文件", { exact: true }).setInputFiles([
      {
        name: "library.bib",
        mimeType: "text/plain",
        buffer: Buffer.from("@article{a,title={A},file={files/7/a.pdf}}"),
      },
      {
        name: "a.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.7\n"),
      },
      {
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("salt, flour"),
      },
    ]);
    await page.getByRole("button", { name: "继续", exact: true }).waitFor();
    await shot("intake-drop");
    await shot("intake-drop-390", 390);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    // Awaiting confirmation, with recognition running and items to decide.
    const { view, id } = await exportBatch(page);
    const route = (action: string) => (url: URL) =>
      url.pathname === `/api/v1/intake/batches/${id}/${action}`;
    const previewRoute = route("preview"),
      itemsRoute = route("items");
    await page.route(previewRoute, (r) =>
      r.fulfill(
        ok({
          batch: null,
          estimated: true,
          summary,
          recognition: { state: "running", recognized: 3, total: 10 },
        }),
      ),
    );
    await page.route(itemsRoute, (r) => {
      const needs = (bodyOf(r).request as { needs?: string }).needs;
      return r.fulfill(
        ok({
          items: items.filter((item) =>
            needs === "unpaired" ? item.unpaired : item.needs_decision,
          ),
          next_cursor: null,
        }),
      );
    });
    await page.reload();
    await view.getByRole("heading", { name: "需要决定（3）" }).waitFor();
    await shot("batch-awaiting");
    await shot("batch-awaiting-390", 390);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.unroute(previewRoute);
    await page.unroute(itemsRoute);
    // Collecting.
    await patchBatch(page, (batch) => ({ ...batch, state: "collecting" }));
    await page.reload();
    await view.getByText("还没有交来条目。").waitFor();
    await shot("batch-collecting");
    await page.unroute(batchRead);
    await page.reload();
    await view.getByRole("button", { name: "确认入库", exact: true }).click();
    await page
      .getByRole("dialog", { name: "确认入库" })
      .getByRole("button", { name: "确认入库", exact: true })
      .click();
    await view
      .locator(".intake-batch-state .ui-badge")
      .filter({ hasText: "完成" })
      .waitFor();
    // Finished.
    await shot("batch-finished");
    // Running, files still owed.
    await patchBatch(page, (batch) => ({
      ...batch,
      state: "running",
      result: null,
      finished_at: null,
      progress: {
        phase: "files",
        processed_items: 2,
        total_items: 2,
        files: { uploaded: 1, existing: 1, conflicts: 1, pending: 3 },
      },
    }));
    await page.reload();
    await view.getByText("等待文件 · 已处理 2 / 2").waitFor();
    await shot("batch-running");
    // Cancelled and withdrawn.
    await patchBatch(page, (batch) => ({
      ...batch,
      state: "cancelled",
      result: null,
    }));
    await page.reload();
    await view.getByText("已取消").first().waitFor();
    await shot("batch-cancelled");
    await patchBatch(page, (batch) => ({ ...batch, state: "withdrawn" }));
    await page.reload();
    await view.getByText("已撤回").first().waitFor();
    await shot("batch-withdrawn");
    // The records, one kind of row.
    await page.unroute(batchRead);
    await view.getByRole("button", { name: "返回找文献" }).click();
    await page.locator(".intake-record").first().waitFor();
    await shot("intake-records");
    // The two dialogs of what can follow.
    await page
      .locator(".intake-record", { hasText: "library.bib" })
      .getByRole("button", { name: /^打开批次/u })
      .click();
    await patchBatch(page, (batch) => ({
      ...batch,
      estimates: { acquire_pdf: 2, parse: 2 },
    }));
    await page.reload();
    await view
      .getByRole("button", { name: "解析并形成未校对的全文 2 篇" })
      .click();
    await page
      .getByRole("dialog", { name: "解析并形成未校对的全文" })
      .waitFor();
    await shot("batch-parse-dialog");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 180000);
