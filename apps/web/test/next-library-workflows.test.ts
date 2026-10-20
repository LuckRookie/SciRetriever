import { showAllLibraryStatuses } from "./next-workspace-fixture.js";
import { parseLiteratureId } from "@sciretriever/contracts";
import { expect, it } from "vitest";
import type { Page } from "playwright";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { missingId } from "./processor-workspace-fixture.js";
import { workbenchPdf } from "../../server/src/workbench/synthetic-fixture.js";
import { join } from "node:path";
async function select(page: Page, label: string, option: string) {
  await page
    .getByRole("button", { name: new RegExp(label) })
    .and(page.locator('[aria-haspopup="listbox"]'))
    .click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
it("opens keyboard search and live activity without starting work, and preserves filter, sort and preview interactions", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    await page.keyboard.press("Control+k");
    const search = page.getByRole("dialog", {
      name: "搜索文献库",
      exact: true,
    });
    await search
      .getByRole("searchbox", { name: "搜索文献", exact: true })
      .fill("Unparsed");
    await search.getByRole("button", { name: "搜索", exact: true }).click();
    await expect.poll(() => page.locator(".paper-row").count()).toBe(1);
    expect(
      JSON.parse(new URL(page.url()).searchParams.get("query")!),
    ).toMatchObject({ text: "Unparsed" });
    await page.getByRole("button", { name: "全部", exact: true }).click();
    await select(page, "材料状态", "仅元数据");
    await expect.poll(() => page.locator(".paper-row").count()).toBe(1);
    expect(
      JSON.parse(new URL(page.url()).searchParams.get("query")!),
    ).toMatchObject({ statuses: ["UNREVIEWED"] });
    await select(page, "排序", "标题：Z–A");
    expect(new URL(page.url()).searchParams.get("sort")).toBe("title-desc");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "文献预览", exact: true });
    await preview
      .getByRole("heading", { name: "Unparsed source", exact: true })
      .waitFor();
    expect(new URL(page.url()).searchParams.has("literature")).toBe(false);
    expect(w.env.modelCalls).toBe(0);
    await page.keyboard.press("Escape");
    const checked = page.getByRole("checkbox", {
      name: "选择已加载的文献",
      exact: true,
    });
    await checked.focus();
    await page.keyboard.press("Space");
    expect(
      await page.getByRole("region", { name: "文献选择" }).textContent(),
    ).toContain("已选 1 篇");
    await page
      .getByRole("region", { name: "文献选择" })
      .getByRole("button", { name: "用这些文献做…", exact: true })
      .click();
    await expect
      .poll(() =>
        page.getByRole("dialog", { name: "使用所选文献" }).textContent(),
      )
      .toContain("范围已固定：1 篇文献");
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
    await page.getByRole("button", { name: /^活动/ }).click();
    const activity = page.getByRole("dialog", { name: "活动", exact: true });
    await expect
      .poll(() => activity.textContent(), { timeout: 5000 })
      .toContain("获取 PDF");
    await activity
      .getByRole("button", { name: "查看全部任务", exact: true })
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("view"))
      .toBe("task");
    expect((await w.env.app.jobs!.getJob(job.job_id))?.status).toBe("queued");
    expect(w.env.modelCalls).toBe(0);
    expect(w.env.parseCalls).toBe(w.setupCalls.parser);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("loads catalog-scoped saved filters, caps their count and persists deletion without affecting other catalogs", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    let catalog = join(w.env.home, "catalog.sqlite");
    const otherCatalog = join(w.env.home, "other-catalog.sqlite");
    const oldKey = `sciretriever:library-views:v1:${catalog}`;
    const otherKey = `sciretriever:react:sciretriever:library-views:v1:${otherCatalog}`;
    await page.route(
      (url) => url.pathname === "/api/workspace",
      async (route) => {
        const response = await route.fetch();
        const value = await response.json();
        value.workspace.catalog_path = catalog;
        await route.fulfill({ response, json: value });
      },
    );
    const savedViews = JSON.stringify(
      Array.from({ length: 51 }, (_, i) => ({
        id: `saved-${i + 1}`,
        name: `Saved ${i + 1}`,
        query: { text: "Unparsed" },
        sort: "title-desc",
      })),
    );
    await page.evaluate(
      ({ oldKey, otherKey, savedViews }) => {
        localStorage.setItem(`sciretriever:react:${oldKey}`, savedViews);
        localStorage.setItem(oldKey, "obsolete-value-must-not-be-read");
        localStorage.setItem(
          otherKey,
          JSON.stringify([
            {
              id: "different-catalog",
              name: "Different catalog",
              query: {},
              sort: "title-asc",
            },
          ]),
        );
      },
      { oldKey, otherKey, savedViews },
    );
    await page.reload();
    const views = page.getByLabel("已保存的筛选", { exact: true });
    await views.getByRole("button", { name: "Saved 1", exact: true }).waitFor();
    expect(
      await views.getByRole("button", { name: /^Saved \d+$/ }).count(),
    ).toBe(50);
    expect(
      await views
        .getByRole("button", { name: "Saved 51", exact: true })
        .count(),
    ).toBe(0);
    expect(
      await views
        .getByRole("button", { name: "Different catalog", exact: true })
        .count(),
    ).toBe(0);
    await views.getByRole("button", { name: "Saved 1", exact: true }).click();
    await expect.poll(() => page.locator(".paper-row").count()).toBe(1);
    expect(
      JSON.parse(new URL(page.url()).searchParams.get("query")!),
    ).toMatchObject({ text: "Unparsed" });
    expect(new URL(page.url()).searchParams.get("sort")).toBe("title-desc");
    await views
      .getByRole("button", { name: "保存当前筛选", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "保存筛选", exact: true });
    await dialog
      .getByRole("textbox", { name: "筛选名称" })
      .fill("Newest saved view");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await views
      .getByRole("button", { name: "Newest saved view", exact: true })
      .waitFor();
    expect(
      await views.getByRole("button", { name: "Saved 1", exact: true }).count(),
    ).toBe(0);
    const saved = await page.evaluate(
      (key) => localStorage.getItem(`sciretriever:react:${key}`),
      oldKey,
    );
    expect(JSON.parse(saved!)).toHaveLength(50);
    await views
      .getByRole("button", { name: "Newest saved view", exact: true })
      .click();
    await views
      .getByRole("button", { name: "删除已保存筛选", exact: true })
      .click();
    await page.reload();
    await views.getByRole("button", { name: "Saved 2", exact: true }).waitFor();
    expect(
      await views
        .getByRole("button", { name: "Newest saved view", exact: true })
        .count(),
    ).toBe(0);
    expect(
      JSON.parse(
        (await page.evaluate(
          (key) => localStorage.getItem(`sciretriever:react:${key}`),
          oldKey,
        ))!,
      ),
    ).toHaveLength(49);
    expect(
      await page.evaluate((key) => localStorage.getItem(key), oldKey),
    ).toBe("obsolete-value-must-not-be-read");
    expect(
      await page.evaluate((key) => localStorage.getItem(key), otherKey),
    ).toContain("Different catalog");
    catalog = otherCatalog;
    await page.reload();
    await views
      .getByRole("button", { name: "Different catalog", exact: true })
      .waitFor();
    expect(
      await views.getByRole("button", { name: /^Saved \d+$/ }).count(),
    ).toBe(0);
    expect(w.env.modelCalls).toBe(0);
    expect(await w.env.app.jobs!.listJobs(10)).toHaveLength(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

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
    await page
      .getByRole("searchbox", { name: "搜索文献", exact: true })
      .fill("Unparsed");
    await began;
    await page.getByRole("button", { name: "洞察", exact: true }).click();
    await page.locator(".insight-charts").waitFor();
    await expect.poll(() => cancelled, { timeout: 5000 }).toBe(true);
    release();
    await page.unrouteAll({ behavior: "wait" });
    expect(new URL(page.url()).searchParams.get("view")).toBe("ins");
    expect(await page.locator(".insight-charts").count()).toBe(1);
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
      .getByRole("button", { name: "确认上传", exact: true })
      .click();
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
