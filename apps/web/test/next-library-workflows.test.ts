import { mkdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  libraryStatus,
  openMoreConditions,
  openProcessingEntry,
  openSavedViews,
  showAllLibraryStatuses,
  searchLibrary,
} from "./next-workspace-fixture.js";
import {
  parseFiltersExportFile,
  parseLiteratureId,
} from "@sciretriever/contracts";
import { expect, it } from "vitest";
import type { Page } from "playwright";
import { nextWorkspace, selectAllLoaded } from "./next-workspace-fixture.js";
import { missingId } from "./processor-workspace-fixture.js";
import { draftPdf, formDraft } from "./draft-fixture.js";
import { workbenchPdf } from "../../server/src/workbench/synthetic-fixture.js";
async function select(page: Page, label: string, option: string) {
  await page
    .getByRole("button", { name: new RegExp(label) })
    .and(page.locator('[aria-haspopup="listbox"]'))
    .click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
it("opens keyboard search and the task page without starting work, and preserves filter, sort and preview interactions", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    await page.keyboard.press("Control+k");
    const search = page.getByRole("dialog", {
      name: "搜索文献",
      exact: true,
    });
    await search
      .getByRole("combobox", { name: "搜索文献", exact: true })
      .fill("Unparsed");
    await search.getByRole("button", { name: /^在文献库中查看全部/ }).click();
    await expect.poll(() => page.locator(".paper-row").count()).toBe(1);
    expect(
      JSON.parse(new URL(page.url()).searchParams.get("query")!),
    ).toMatchObject({ text: "Unparsed" });
    await libraryStatus(page, "全部");
    await libraryStatus(page, "只有书目");
    await expect.poll(() => page.locator(".paper-row").count()).toBe(1);
    expect(
      JSON.parse(new URL(page.url()).searchParams.get("query")!),
      // “只有书目” is the papers without a primary PDF whose automatic routes
      // are not exhausted; those are “没找到 PDF” (page specs “界面用词”).
    ).toMatchObject({ statuses: ["UNREVIEWED"], needs_manual_pdf: false });
    await select(page, "排序", "标题：Z–A");
    expect(new URL(page.url()).searchParams.get("sort")).toBe("title-desc");
    // The right column shows the current row, without a veil (page specs “右栏”).
    const preview = page.getByRole("region", { name: "文献预览", exact: true });
    await preview
      .getByRole("heading", { name: "Unparsed source", exact: true })
      .waitFor();
    // The sort's list has closed; nothing else lies over the page.
    await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
    expect(new URL(page.url()).searchParams.has("literature")).toBe(false);
    expect(w.env.modelCalls).toBe(0);
    await selectAllLoaded(page);
    expect(
      await page.getByRole("region", { name: "文献选择" }).textContent(),
    ).toContain("已选 1 篇");
    // A metadata-only paper can be fetched, not run: each batch action counts its own papers.
    const bar = page.getByRole("region", { name: "文献选择" });
    expect(await bar.textContent()).toContain("只有书目 1");
    await bar.getByRole("button", { name: "更多", exact: true }).click();
    expect(
      await page
        .getByRole("menuitem", { name: /^运行算子 0/u })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await page.keyboard.press("Escape");
    await bar.getByRole("button", { name: "获取 PDF 1", exact: true }).click();
    await page.getByRole("dialog", { name: "获取 PDF", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(0);
    const job = await w.env.app.jobService!.create({
      target_kind: "selector",
      goal: "pdf",
      selector: {
        kind: "literatures",
        literature_ids: [parseLiteratureId(missingId)],
      },
      policy_version: "activity-fixture",
      policy: { mode: "never", max_retries: 0 },
      idempotency_key: "activity-fixture",
    });
    // No “活动” panel: background work is 任务 in the sidebar and its page.
    expect(await page.getByRole("button", { name: /^活动/ }).count()).toBe(0);
    await page
      .getByRole("complementary", { name: "主导航" })
      .getByRole("button", { name: /^任务/u })
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("view"))
      .toBe("task");
    await expect
      .poll(
        () => page.locator(`[data-task-id="${job.job_id}"]`).textContent(),
        { timeout: 20_000 },
      )
      .toContain("获取 PDF");
    expect((await w.env.app.jobs!.getJob(job.job_id))?.status).toBe("queued");
    expect(w.env.modelCalls).toBe(0);
    expect(w.env.parseCalls).toBe(w.setupCalls.parser);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("keeps saved filters in the catalog: the menu applies, saves and deletes through the service, and imports this browser's old ones once (user organization 9.1)", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    const app = w.env.app as unknown as {
      filters: {
        query(op: unknown): Promise<unknown>;
        manage(op: unknown): Promise<unknown>;
      };
      workspace?: unknown;
    };
    const list = async () =>
      (
        (await app.filters.query({ operation: "list", request: {} })) as {
          items: {
            name: string;
            query: unknown;
            sort: string;
            updated_at: string;
          }[];
        }
      ).items;
    // One made outside the Web (as the CLI would): it shows in the menu.
    await app.filters.manage({
      operation: "create",
      request: {
        name: "Existing",
        query: { text: "Unparsed" },
        sort: "title-desc",
      },
    });
    // The catalog this browser keys its old filters by, as the Web reads it.
    const [workspace] = await Promise.all([
      page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/workspace",
      ),
      page.reload(),
    ]);
    const catalog = (
      (await workspace.json()) as { workspace?: { catalog_path?: string } }
    ).workspace?.catalog_path;
    let views = await openSavedViews(page);
    await views
      .getByRole("menuitem", { name: "Existing", exact: true })
      .waitFor();
    // No old data in this browser: no way to import.
    expect(
      await views.getByRole("menuitem", { name: /^导入这个浏览器/u }).count(),
    ).toBe(0);
    // Applying a filter reads only: nothing in the catalog changes.
    const before = JSON.stringify(await list());
    await views
      .getByRole("menuitem", { name: "Existing", exact: true })
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("sort"))
      .toBe("title-desc");
    expect(JSON.stringify(await list())).toBe(before);
    // “用当前条件更新这项筛选”: the current condition replaces the saved one; the name stays.
    await searchLibrary(page, "Synthetic");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("query") ?? "")
      .toContain("Synthetic");
    views = await openSavedViews(page);
    await views
      .getByRole("menuitem", { name: "用当前条件更新这项筛选", exact: true })
      .click();
    await expect
      .poll(
        async () => (await list()).find((f) => f.name === "Existing")?.query,
      )
      .toMatchObject({ text: "Synthetic" });
    await app.filters.manage({
      operation: "update",
      request: {
        filter_id: (
          (await list()) as unknown as { name: string; filter_id: string }[]
        ).find((f) => f.name === "Existing")!.filter_id,
        query: { text: "Unparsed" },
        sort: "title-desc",
      },
    });
    // Save and delete go to the service and survive a reload.
    views = await openSavedViews(page);
    await views
      .getByRole("menuitem", { name: "保存当前筛选…", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "保存筛选", exact: true });
    await dialog.getByRole("textbox", { name: "筛选名称" }).fill("Newest");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect
      .poll(async () => (await list()).map((f) => f.name))
      .toContain("Newest");
    await page.reload();
    views = await openSavedViews(page);
    await views.getByRole("menuitem", { name: "Newest", exact: true }).click();
    views = await openSavedViews(page);
    await views
      .getByRole("menuitem", { name: "删除当前筛选", exact: true })
      .click();
    await expect
      .poll(async () => (await list()).map((f) => f.name))
      .not.toContain("Newest");
    // “导出筛选” (user organization 9.5): every saved filter as one file, as
    // the service gives it; nothing is written.
    const sent: string[] = [];
    const watch = (request: { url(): string; method(): string }) =>
      sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
    const db = new DatabaseSync(join(w.env.home, "catalog.sqlite"), {
      readOnly: true,
    });
    const committed = () =>
      db.prepare("PRAGMA data_version").get()!.data_version;
    try {
      // The delete above can still commit just after its answer; start from a
      // catalog that has been quiet for a moment, so only the export counts.
      let quiet = committed();
      for (let still = 0; still < 5; ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const now = committed();
        still = now === quiet ? still + 1 : 0;
        quiet = now;
      }
      const version = committed(),
        saved = JSON.stringify(await list());
      views = await openSavedViews(page);
      page.on("request", watch);
      const downloading = page.waitForEvent("download");
      await views
        .getByRole("menuitem", { name: "导出筛选", exact: true })
        .click();
      const file = await downloading;
      page.off("request", watch);
      expect(file.suggestedFilename()).toBe("sciretriever-filters.json");
      const exported = parseFiltersExportFile(
        JSON.parse(await readFile((await file.path())!, "utf8")),
      );
      const direct = parseFiltersExportFile(
        await app.filters.query({ operation: "export", request: {} }),
      );
      expect({ ...exported, exported_at: "" }).toEqual({
        ...direct,
        exported_at: "",
      });
      expect(exported.filters.map((f) => f.name)).toEqual(
        (await list()).map((f) => f.name),
      );
      // The shell's own five-second look at the tasks is not the export's.
      expect(sent.filter((request) => request !== "GET /api/tasks")).toEqual([
        "POST /api/v1/query/filters",
      ]);
      expect(JSON.stringify(await list())).toBe(saved);
      expect(committed()).toBe(version);
    } finally {
      page.off("request", watch);
      db.close();
    }
    // A failed export says so, and nothing is saved.
    const filtersRoute = (url: URL) => url.pathname === "/api/v1/query/filters";
    await page.route(filtersRoute, (route) =>
      (route.request().postDataJSON() as { request?: { operation?: string } })
        ?.request?.operation === "export"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              protocol_version: 1,
              code: "query-unavailable",
            }),
          })
        : route.continue(),
    );
    let downloads = 0;
    const counted = () => downloads++;
    page.on("download", counted);
    views = await openSavedViews(page);
    await views
      .getByRole("menuitem", { name: "导出筛选", exact: true })
      .click();
    await page
      .locator(".ui-toast")
      .filter({ hasText: "没有导出筛选。" })
      .waitFor();
    page.off("download", counted);
    expect(downloads).toBe(0);
    await page.unroute(filtersRoute);
    // This browser's old filters: offered for import, item by item.

    const key = `sciretriever:react:sciretriever:library-views:v1:${catalog ?? "unbound"}`;
    const old = [
      {
        id: "a",
        name: "Existing",
        query: { text: "Unparsed" },
        sort: "title-desc",
      },
      { id: "b", name: "Existing", query: {}, sort: "title-asc" },
      { id: "c", name: "Mine", query: {}, sort: "publication-year-desc" },
      { id: "d", name: "Bad", query: {}, sort: "bogus" },
      7,
    ];
    await page.evaluate(
      ({ key, old }) => localStorage.setItem(key, JSON.stringify(old)),
      { key, old },
    );
    await page.reload();
    views = await openSavedViews(page);
    await views
      .getByRole("menuitem", {
        name: "导入这个浏览器里保存的筛选（5 项）",
        exact: true,
      })
      .click();
    const report = page.getByRole("dialog", {
      name: "导入的筛选",
      exact: true,
    });
    await report.waitFor();
    expect(await report.innerText()).toContain(
      "导入 1 项，改名 1 项，跳过 1 项，未导入 2 项。",
    );
    expect(await report.innerText()).toContain("已改名导入：Existing (2)");
    expect(await report.innerText()).toContain("未导入：条件不合格");
    await page.keyboard.press("Escape");
    // The old data stays, each item marked; the entry is gone.
    const stored = JSON.parse(
      (await page.evaluate((key) => localStorage.getItem(key), key))!,
    ) as Record<string, unknown>[];
    expect(stored).toHaveLength(5);
    expect(stored.map((item) => item.imported)).toEqual([
      "skipped",
      "renamed",
      "imported",
      "invalid",
      "invalid",
    ]);
    expect(stored[0]).toMatchObject({ id: "a", name: "Existing" });
    await page.reload();
    views = await openSavedViews(page);
    await views.getByRole("menuitem", { name: "Mine", exact: true }).waitFor();
    expect(
      await views.getByRole("menuitem", { name: /^导入这个浏览器/u }).count(),
    ).toBe(0);
    await page.keyboard.press("Escape");
    // The same data again creates nothing.
    const count = (await list()).length;
    await app.filters.manage({
      operation: "import",
      request: {
        items: old.slice(0, 3).map((o) => ({
          name: (o as { name: string }).name,
          query: (o as { query: unknown }).query,
          sort: (o as { sort: string }).sort,
        })),
      },
    });
    expect((await list()).length).toBe(count);
    expect(w.env.modelCalls).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("aborts a library search when navigating to another page and ignores its late response", async () => {
  const w = await nextWorkspace();
  let release = () => {};
  try {
    const page = w.page;
    let started = () => {};
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cancelled = false;
    let intercepted = false;
    page.on("requestfailed", (request) => {
      if (
        request.url().includes("/api/v1/query/search") &&
        request.failure()?.errorText.includes("ABORTED")
      )
        cancelled = true;
    });
    await page.route("**/api/v1/query/search?*", async (route) => {
      if (intercepted) return route.continue();
      intercepted = true;
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response }).catch(() => {});
    });
    await searchLibrary(page, "Unparsed");
    await began;
    await openProcessingEntry(page.getByLabel("主导航"), "洞察");
    await page.locator(".insight-figures").waitFor();
    await expect.poll(() => cancelled, { timeout: 20_000 }).toBe(true);
    release();
    await page.unrouteAll({ behavior: "wait" });
    expect(new URL(page.url()).searchParams.get("view")).toBe("ins");
    expect(await page.locator(".insight-figures").count()).toBe(1);
    expect(await page.locator(".paper-row").count()).toBe(0);
    expect(w.env.modelCalls).toBe(0);
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(0);
    expect(w.errors).toEqual([]);
  } finally {
    release();
    await w.close();
  }
}, 60000);
it("requires confirmation before a PDF dropped on a library row is accepted and never processes it implicitly", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page,
      row = page.getByRole("article", { name: "Unparsed source", exact: true });
    await showAllLibraryStatuses(page);
    const pdf = [...workbenchPdf("10.1234/library-drop")];
    await row.evaluate((element, bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], "fixture.pdf", {
          type: "application/pdf",
        }),
      );
      element.dispatchEvent(
        new DragEvent("drop", { bubbles: true, dataTransfer: transfer }),
      );
    }, pdf);
    const confirm = page.getByRole("dialog", { name: "补充 PDF", exact: true });
    await confirm.waitFor();
    expect((await w.env.app.library.detail(missingId)).primary_pdf).toBeNull();
    await confirm
      .getByRole("button", { name: "上传 PDF", exact: true })
      .click();
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

it("marks draft rows, filters and sorts by the draft facts, and hands the results to archiving without starting work (plan 21 block 10)", async () => {
  const w = await nextWorkspace({ setup: draftPdf });
  try {
    const page = w.page;
    await formDraft(w);
    const before = {
      parses: w.env.parseCalls,
      models: w.env.modelCalls,
      jobs: (await w.env.app.jobs!.listJobs(50)).length,
    };
    await page.reload();
    await showAllLibraryStatuses(page);
    const draftRow = page.getByRole("article", {
      name: "Unparsed source",
      exact: true,
    });
    // The primary PDF's default text is a draft: said under the status,
    // where “长文档” is, not inside the status badge.
    await expect
      .poll(() => draftRow.locator(".paper-status-note").allInnerTexts())
      .toContain("未校对");
    expect(await draftRow.locator(".paper-status").innerText()).not.toContain(
      "未校对",
    );
    // The sort menu offers the two draft facts processing does not need.
    await page
      .getByRole("button", { name: /排序/ })
      .and(page.locator('[aria-haspopup="listbox"]'))
      .click();
    const sorts = await page.getByRole("option").allInnerTexts();
    expect(sorts).toEqual(
      expect.arrayContaining([
        "与 PDF 自带文字的差异：多到少",
        "扫描页：多到少",
      ]),
    );
    expect(sorts).not.toContain("被结果引用：多到少");
    expect(sorts).not.toContain("找不到的引用：多到少");
    await page.keyboard.press("Escape");
    await select(page, "排序", "与 PDF 自带文字的差异：多到少");
    expect(new URL(page.url()).searchParams.get("sort")).toBe(
      "draft-differences-desc",
    );
    await expect
      .poll(() => draftRow.locator(".paper-status-note").allInnerTexts())
      .toContain("未校对 · 差异 0 段");
    await select(page, "排序", "扫描页：多到少");
    await expect
      .poll(() => draftRow.locator(".paper-status-note").allInnerTexts())
      .toContain("未校对 · 扫描 0 页");
    // The filters: text level, and the two yes-or-no draft facts.
    // The draft facts are among “更多条件”.
    await openMoreConditions(page);
    await select(page, "文本等级", "未校对");
    await select(page, "全文和 PDF 自带的文字不一样", "没有");
    await expect.poll(() => page.locator(".paper-row").count()).toBe(1);
    expect(
      JSON.parse(new URL(page.url()).searchParams.get("query")!),
    ).toMatchObject({ text_levels: ["draft"], has_draft_differences: false });
    const chips = await page.locator(".library-applied").innerText();
    expect(chips).toContain("文本等级：未校对");
    expect(chips).toContain("全文和 PDF 自带的文字不一样：没有");
    // “批量操作 → 解析全文…” opens the archiving scope with its count.
    await page.getByRole("button", { name: "批量操作", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "解析全文…", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("范围已固定：1 篇文献。", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    // Opening, filtering and sorting start nothing.
    expect(w.env.parseCalls).toBe(before.parses);
    expect(w.env.modelCalls).toBe(before.models);
    expect((await w.env.app.jobs!.listJobs(50)).length).toBe(before.jobs);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("shows the filter menu with the import entry and the import report (plan 25 block 09 screenshots)", async (context) => {
  const output = process.env.SCIRETRIEVER_WEB_FILTER_SHOTS;
  if (!output) return context.skip();
  await mkdir(output, { recursive: true });
  const w = await nextWorkspace();
  try {
    const page = w.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    const app = w.env.app as unknown as {
      filters: { manage(op: unknown): Promise<unknown> };
    };
    await app.filters.manage({
      operation: "create",
      request: {
        name: "近五年的含能盐",
        query: { text: "Unparsed" },
        sort: "title-desc",
      },
    });
    const [workspace] = await Promise.all([
      page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/workspace",
      ),
      page.reload(),
    ]);
    const catalog = (
      (await workspace.json()) as { workspace?: { catalog_path?: string } }
    ).workspace?.catalog_path;
    await page.evaluate(
      (key) =>
        localStorage.setItem(
          key,
          JSON.stringify([
            {
              id: "a",
              name: "近五年的含能盐",
              query: { text: "Unparsed" },
              sort: "title-desc",
            },
            { id: "b", name: "近五年的含能盐", query: {}, sort: "title-asc" },
            { id: "c", name: "待读", query: {}, sort: "publication-year-desc" },
            { id: "d", name: "旧格式", query: {}, sort: "bogus" },
          ]),
        ),
      `sciretriever:react:sciretriever:library-views:v1:${catalog ?? "unbound"}`,
    );
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) =>
          localStorage.setItem(
            "sciretriever:react:sciretriever:theme:v1",
            theme,
          ),
        theme,
      );
      await page.reload();
      await openSavedViews(page);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(output, `filter-menu-${theme}.png`) });
      await page.keyboard.press("Escape");
    }
    const views = await openSavedViews(page);
    await views.getByRole("menuitem", { name: /^导入这个浏览器/u }).click();
    await page.getByRole("dialog", { name: "导入的筛选" }).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(output, "import-report-dark.png") });
  } finally {
    await w.close();
  }
}, 120000);
