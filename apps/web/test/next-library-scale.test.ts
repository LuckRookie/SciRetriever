import { expect, it } from "vitest";
import type { Page, Route } from "playwright";
import { parseFolderNode, parseLiterature } from "@sciretriever/contracts";
import { nextWorkspace, openSavedViews } from "./next-workspace-fixture.js";
import { missingId } from "./processor-workspace-fixture.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";

// Page specs “文献库”: the collected papers, the band over them, search
// results with only-discovered papers, counts beyond 10,000 and the sorts
// left there; “获取任务详情”: a citation expansion's rate-limited sources.

const encode = (value: object) => encodeURIComponent(JSON.stringify(value));
const query = (page: Page) =>
  JSON.parse(new URL(page.url()).searchParams.get("query") ?? "{}");
const sort = (page: Page) => new URL(page.url()).searchParams.get("sort");
const DISCOVERED = [
  ["00000000-0000-0000-0000-000000006201", "Discovered sulfide interphase"],
  ["00000000-0000-0000-0000-000000006202", "Discovered sulfide cathodes"],
] as const;
const BATCH = "00000000-0000-0000-0000-000000006401";

/** Two papers only discovered: in the catalog, never chosen by anyone. */
type Env = Parameters<
  NonNullable<NonNullable<Parameters<typeof nextWorkspace>[0]>["setup"]>
>[0];
async function withDiscovered(env: Env) {
  for (const [n, [id, title]] of DISCOVERED.entries())
    await env.app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: id,
        meta_literature_id: `00000000-0000-0000-0000-00000000630${n + 1}`,
        metadata: { ...FIXTURE_LITERATURE.metadata, title, identifiers: [] },
      }),
    );
  const folder = parseFolderNode(
    await env.app.folders.manage({
      operation: "create",
      request: { name: "样例文件夹", parent_id: null, position: null },
    }),
  );
  await env.app.folders.manage({
    operation: "add",
    request: {
      folder_id: folder.folder_id,
      literature_ids: [FIXTURE_LITERATURE.literature_id],
    },
  });
}
/** The sidebar's “文献库” and its number. */
const sidebarCount = (page: Page) =>
  page
    .locator(".application-shell")
    .getByRole("button", { name: /^文献库/u })
    .first()
    .locator(".navigation-count");
/** Rewrites one query route's answer. */
async function rewrite(
  page: Page,
  name: string,
  change: (result: Record<string, unknown>, request: unknown) => unknown,
) {
  await page.route(
    (url) => url.pathname === `/api/v1/query/${name}`,
    async (route: Route) => {
      const response = await route.fetch();
      const value = (await response.json()) as Record<string, unknown>;
      const request = (
        route.request().postDataJSON() as { request: unknown } | null
      )?.request;
      const changed = change(value, request);
      await route.fulfill({ response, json: changed ?? value });
    },
  );
}

it("shows the band only over the collected papers, counts the collected in the sidebar and searches the whole library from it", async () => {
  const w = await nextWorkspace({ setup: withDiscovered });
  try {
    const page = w.page;
    await page
      .getByRole("heading", { level: 1, name: "收进来的文献" })
      .waitFor();
    const band = page.getByRole("region", { name: "整个文献库" });
    const totals = band.locator(".library-band-totals");
    await totals.waitFor();
    const [, all, collected, discovered] =
      /^全库 (\d+) 篇：收进来的 (\d+) 篇，只被发现的 (\d+) 篇（来自引用扩展与主题搜索）$/u.exec(
        (await totals.textContent()) ?? "",
      )!;
    expect(Number(collected) + Number(discovered)).toBe(Number(all));
    expect(Number(discovered)).toBeGreaterThanOrEqual(2);
    // The sidebar counts the collected papers, not the whole library.
    await expect.poll(() => sidebarCount(page).textContent()).toBe(collected);
    // The page's own total is the collected one, once.
    expect(
      await page.locator(".ui-page-header .ui-page-count").textContent(),
    ).toBe(`共 ${collected} 篇`);
    // The working sets with something in them; the folder is one.
    expect(
      await band
        .getByRole("button", { name: "文件夹 · 1", exact: true })
        .count(),
    ).toBe(1);
    // The collected papers are searched from the band only.
    expect(
      await page.locator(".library-toolbar").getByRole("searchbox").count(),
    ).toBe(0);
    expect(
      await page
        .locator(".library-band")
        .getByRole("searchbox", { name: "搜索整个文献库" })
        .count(),
    ).toBe(1);

    // Enter searches the whole library: no band, the scope and relevance.
    const box = band.getByRole("searchbox", { name: "搜索整个文献库" });
    await box.fill("Discovered sulfide");
    await box.press("Enter");
    await page
      .getByRole("heading", { level: 1, name: "搜索“Discovered sulfide”" })
      .waitFor();
    expect(await page.getByRole("region", { name: "整个文献库" }).count()).toBe(
      0,
    );
    expect(sort(page)).toBeNull();
    expect(
      await page
        .getByRole("button", { name: /排序/u })
        .and(page.locator('[aria-haspopup="listbox"]'))
        .textContent(),
    ).toBe("排序：相关度");
    const scope = page.getByRole("radiogroup", { name: "范围" });
    expect(
      await scope.getByRole("radio", { name: "整个文献库" }).isChecked(),
    ).toBe(true);
    await expect
      .poll(() => page.locator(".ui-page-header .ui-page-count").textContent())
      .toBe("2 篇符合");
    // “只看收进来的 · n”: none of the two is collected.
    const only = scope.getByRole("radio", { name: "只看收进来的 · 0" });
    await only.waitFor();
    await only.click({ force: true });
    await expect.poll(() => query(page).collection_scope).toBe("collected");
    expect(query(page).text).toBe("Discovered sulfide");
    await page.getByText("没有符合条件的文献", { exact: true }).waitFor();

    // A working set searches in itself, and can widen to the whole library.
    await page
      .locator(".application-shell")
      .getByRole("button", { name: /^样例文件夹/u })
      .first()
      .click();
    await page.getByRole("heading", { level: 1, name: "样例文件夹" }).waitFor();
    expect(await page.getByRole("region", { name: "整个文献库" }).count()).toBe(
      0,
    );
    const inFolder = page.getByRole("searchbox", {
      name: "在「样例文件夹」里搜索",
    });
    await inFolder.fill("Discovered");
    const folderScope = page.getByRole("radiogroup", { name: "范围" });
    await folderScope.waitFor();
    expect(
      await folderScope
        .getByRole("radio", { name: "「样例文件夹」里" })
        .isChecked(),
    ).toBe(true);
    await folderScope
      .getByRole("radio", { name: "整个文献库" })
      .click({ force: true });
    await expect.poll(() => query(page).folder ?? null).toBeNull();
    expect(query(page).text).toBe("Discovered");
    // The way back stays offered while the search lasts.
    await folderScope
      .getByRole("radio", { name: "「样例文件夹」里" })
      .click({ force: true });
    await expect.poll(() => query(page).folder?.id ?? null).not.toBeNull();
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("marks only-discovered rows with where they came from and collects one in place and several from the selection", async () => {
  const w = await nextWorkspace({ setup: withDiscovered });
  try {
    const page = w.page;
    // The first discovered paper came from a citation expansion; the other
    // has no discovery batch (technical 06 2.1.1).
    await rewrite(page, "search", (value) => {
      const pageValue = value.page as {
        items: Record<string, unknown>[];
      };
      for (const item of pageValue.items) {
        const id = (item.literature as { literature_id: string }).literature_id;
        if (id === DISCOVERED[0][0] && item.collected === false)
          item.discovery_origin = { kind: "citation", intake_batch_id: BATCH };
      }
      return value;
    });
    const collected = Number(await sidebarCount(page).textContent());
    await page.goto(
      new URL(`/?view=lib&query=${encode({ text: "Discovered" })}`, page.url())
        .href,
    );
    const row = (id: string) =>
      page.locator(`.paper-row[data-literature-id="${id}"]`);
    await row(DISCOVERED[0][0]).waitFor();
    expect(
      await row(DISCOVERED[0][0]).locator(".paper-citation").textContent(),
    ).toMatch(/ · 只被发现：来自引用扩展$/u);
    expect(
      await row(DISCOVERED[1][0]).locator(".paper-citation").textContent(),
    ).toMatch(/ · 只被发现$/u);
    // Only a known origin is a link; the other is plain words.
    expect(
      await row(DISCOVERED[1][0])
        .getByRole("button", { name: /^只被发现/u })
        .count(),
    ).toBe(0);

    // One paper: the row changes where it is, and so does the sidebar.
    const requests: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/v1/query/search") requests.push(path);
    });
    // “收进来” is a row action: out of sight until the row is touched or
    // focused, then in the pen's colour beside the other actions.
    const collectOf = (id: string) =>
      row(id).getByRole("button", { name: "收进来", exact: true });
    const shown = (id: string) =>
      collectOf(id).evaluate((el) => getComputedStyle(el).opacity);
    await page.mouse.move(0, 0);
    await expect.poll(() => shown(DISCOVERED[0][0])).toBe("0");
    await row(DISCOVERED[0][0]).hover();
    await expect.poll(() => shown(DISCOVERED[0][0])).toBe("1");
    // The status and the actions share one line on the right.
    expect(
      await row(DISCOVERED[0][0]).locator(".paper-side > .paper-tools").count(),
    ).toBe(1);
    // By keyboard: focused, it shows; Enter collects.
    await page.mouse.move(0, 0);
    await collectOf(DISCOVERED[1][0]).focus();
    await expect.poll(() => shown(DISCOVERED[1][0])).toBe("1");
    await page.keyboard.press("Enter");
    await row(DISCOVERED[1][0])
      .locator(".paper-tools")
      .getByText("已收进来", { exact: true })
      .waitFor();
    expect(await collectOf(DISCOVERED[1][0]).count()).toBe(0);
    expect(
      await row(DISCOVERED[1][0]).locator(".paper-citation").textContent(),
    ).not.toContain("只被发现");
    await expect
      .poll(() => sidebarCount(page).textContent())
      .toBe(String(collected + 1));
    // The list is not read again.
    expect(requests).toEqual([]);

    // Once a selection is on, every row shows its “收进来”.
    await row(DISCOVERED[1][0]).focus();
    await page.keyboard.press("Space");
    await page.mouse.move(0, 0);
    await page
      .locator("body")
      .evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect.poll(() => shown(DISCOVERED[0][0])).toBe("1");
    // Several: “收进来 n” counts only the discovered among the selected.
    await row(DISCOVERED[0][0]).focus();
    await page.keyboard.press("Space");
    const bar = page.getByRole("region", { name: "文献选择" });
    await bar.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("menuitem", { name: "收进来 1", exact: true }).click();
    await row(DISCOVERED[0][0])
      .getByText("已收进来", { exact: true })
      .waitFor();
    await expect
      .poll(() => sidebarCount(page).textContent())
      .toBe(String(collected + 2));
    await bar.getByRole("button", { name: "更多", exact: true }).click();
    expect(await page.getByRole("menuitem", { name: /^收进来/u }).count()).toBe(
      0,
    );
    await page.keyboard.press("Escape");

    // The origin opens that task's discovery batch in the library.
    await page.goto(
      new URL(`/?view=lib&query=${encode({ text: "Discovered" })}`, page.url())
        .href,
    );
    await page.unroute((url) => url.pathname === "/api/v1/query/search");
    await rewrite(page, "search", (value) => {
      const items = (value.page as { items: Record<string, unknown>[] }).items;
      for (const item of items)
        if (
          (item.literature as { literature_id: string }).literature_id ===
          DISCOVERED[0][0]
        ) {
          item.collected = false;
          item.discovery_origin = { kind: "topic", intake_batch_id: BATCH };
        }
      return value;
    });
    await page.reload();
    await row(DISCOVERED[0][0])
      .getByRole("button", { name: "只被发现：来自主题搜索", exact: true })
      .click();
    await expect.poll(() => query(page).intake_batch_ids).toEqual([BATCH]);
    expect(query(page).text ?? null).toBeNull();
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("says “1 万篇以上” beyond 10,000, works the exact number out on request and writes “1 万+” for counts from a sample", async () => {
  const w = await nextWorkspace({ setup: withDiscovered });
  try {
    const page = w.page;
    // The service's own flags, for a scope this fixture cannot reach.
    await rewrite(page, "search", (value) => {
      const p = value.page as Record<string, unknown>;
      p.total_count = 10000;
      p.count_truncated = true;
      p.status_updating = true;
      return value;
    });
    await rewrite(page, "library-counts", (value, request) => {
      const r = value.result as Record<string, unknown>;
      const q = (request as { query: Record<string, unknown> }).query;
      // Filtered counts stop at 10,000; the unfiltered ones are counters.
      if (q.author) {
        const statuses = r.statuses as Record<string, number>;
        for (const key of Object.keys(statuses)) statuses[key] = 0;
        statuses.UNREVIEWED = 10000;
        r.total = 10000;
        r.unavailable_pdf = 0;
        r.with_primary_pdf = 0;
        r.recently_opened = 0;
        r.full_text = { total: 0, obtained: 0, missing: 0, exhausted: 0 };
        r.count_truncated = true;
      }
      return value;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exact: unknown[] = [];
    await page.route(
      (url) => url.pathname === "/api/v1/query/library-exact-count",
      async (route) => {
        exact.push(
          (route.request().postDataJSON() as { request: unknown }).request,
        );
        await held;
        await route.fulfill({
          status: 200,
          json: {
            protocol_version: 1,
            result: {
              kind: "search-total",
              snapshot_at: "2026-11-22T06:32:00.000Z",
              total_count: 12345,
            },
          },
        });
      },
    );
    await page.goto(
      new URL(`/?view=lib&query=${encode({ author: "Imaginary" })}`, page.url())
        .href,
    );
    const count = page.locator(".ui-page-header .ui-page-count");
    await expect
      .poll(() => count.textContent())
      .toMatch(/^符合 1 万篇以上 \/ 共 \d+ 篇算出准确数$/u);
    // The quick filters were counted from the first 10,000 matches.
    const quick = page.locator(".library-status-filters");
    await expect
      .poll(() =>
        quick
          .getByRole("button", { name: /^全部/u })
          .locator(".filter-count")
          .textContent(),
      )
      .toBe("1 万+");
    expect(await quick.textContent()).toContain("状态正在更新，数字可能不准");
    await count
      .getByRole("button", { name: "算出准确数", exact: true })
      .click();
    await count.getByText("正在计算…", { exact: true }).waitFor();
    expect(
      await count.getByRole("button", { name: "算出准确数" }).count(),
    ).toBe(0);
    release();
    await expect
      .poll(() => count.textContent())
      .toMatch(/^符合 12,345 篇（截至 \d\d:\d\d） \/ 共 \d+ 篇$/u);
    // Asked for exactly this query, the collected papers by an author.
    expect(exact).toEqual([
      expect.objectContaining({
        kind: "search-total",
        query: expect.objectContaining({
          author: "Imaginary",
          collection_scope: "collected",
        }),
      }),
    ]);
    // Another condition and the worked-out number is gone.
    await page
      .locator(".library-status-filters")
      .getByRole("button", { name: /^只有书目/u })
      .click();
    await expect
      .poll(() => count.textContent())
      .toMatch(/^符合 1 万篇以上 \/ 共 \d+ 篇算出准确数$/u);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("beyond 10,000 keeps only the view's own sort, and offers it in words when the address asks for another", async () => {
  const w = await nextWorkspace({ setup: withDiscovered });
  try {
    const page = w.page;
    await page.route(
      (url) => url.pathname === "/api/v1/query/search",
      async (route) => {
        const request = (
          route.request().postDataJSON() as {
            request: { sort: string; query: { text: string | null } };
          }
        ).request;
        if (request.sort !== "collected-desc" && !request.query.text)
          return route.fulfill({
            status: 400,
            json: { protocol_version: 1, code: "library-sort-scope-limit" },
          });
        const response = await route.fetch();
        const value = (await response.json()) as {
          page: Record<string, unknown>;
        };
        value.page.total_count = 10000;
        value.page.count_truncated = true;
        return route.fulfill({ response, json: value });
      },
    );
    // An old address with another order: not changed silently.
    await page.goto(new URL("/?view=lib&sort=title-asc", page.url()).href);
    const notice = page.locator(".library-sort-limit");
    await notice.waitFor();
    expect(await notice.locator("p").textContent()).toBe(
      "超过 1 万篇时只能按这几种排序；先加条件，或缩小范围",
    );
    expect(sort(page)).toBe("title-asc");
    await notice
      .getByRole("button", { name: "改按最近收进来", exact: true })
      .click();
    await expect.poll(() => sort(page)).toBe("collected-desc");
    await page.locator(".paper-row").first().waitFor();
    // The menu keeps the other sorts, disabled, saying why.
    await page
      .getByRole("button", { name: /排序/u })
      .and(page.locator('[aria-haspopup="listbox"]'))
      .click();
    const options = page.getByRole("option");
    await options.first().waitFor();
    const states = await options.evaluateAll((items) =>
      items.map((item) => [
        item.querySelector('[slot="label"]')?.textContent ?? "",
        item.getAttribute("aria-disabled") === "true",
      ]),
    );
    expect(states.find(([label]) => label === "最近收进来")?.[1]).toBe(false);
    expect(
      states
        .filter(([label]) => label !== "最近收进来")
        .every(([, disabled]) => disabled),
    ).toBe(true);
    expect(await page.getByRole("listbox").textContent()).toContain(
      "超过 1 万篇时只能按这几种排序；先加条件，或缩小范围",
    );
    await page.keyboard.press("Escape");
    // The table's heads do not sort either.
    await page.getByRole("tab", { name: "表格", exact: true }).click();
    const heads = page.locator(".library-table-sort");
    await heads.first().waitFor();
    expect(
      await heads.evaluateAll((items) =>
        items.every((item) => (item as HTMLButtonElement).disabled),
      ),
    ).toBe(true);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("lists a citation expansion's rate-limited sources under the summary, with their state and the queries they owe", async () => {
  let task = "";
  const w = await nextWorkspace({
    setup: async (env) => {
      await withDiscovered(env);
      task = (
        await env.app.jobService!.create({
          target_kind: "selector",
          goal: "pdf",
          selector: {
            kind: "literatures",
            literature_ids: [env.parseRequest.literature_id],
          },
          policy_version: "cooldown-fixture",
          policy: { mode: "never", max_retries: 0 },
          idempotency_key: "cooldown-fixture-task",
        })
      ).job_id;
    },
  });
  try {
    const page = w.page;
    const soon = new Date(Date.now() + 60 * 60_000).toISOString(),
      past = new Date(Date.now() - 60_000).toISOString();
    const reason = (code: string) => ({
      code,
      reason: "Synthetic provider failure.",
      action: "Retry later.",
      retryable: true,
    });
    await page.route(
      (url) => /^\/api\/tasks\/[^/]+$/u.test(url.pathname),
      async (route) => {
        const response = await route.fetch();
        const value = (await response.json()) as {
          task: Record<string, unknown>;
        };
        value.task.citation_source_cooldowns = [
          {
            target_id: "cooldown-target",
            run_id: "cooldown-run",
            source: "openalex",
            status: "cooling",
            retries: 1,
            next_retry_at: soon,
            reason: reason("metadata-provider-rate-limited"),
            pending_count: 37,
            // The service keeps a sample of 20 (technical 02 “来源冷却”).
            pending_sample: Array.from({ length: 20 }, (_, n) =>
              n % 2
                ? {
                    literature_id: n === 1 ? DISCOVERED[0][0] : missingId,
                    purpose: "lookup",
                    relation_id: `relation-${n}`,
                  }
                : { literature_id: missingId, purpose: "reference-query" },
            ),
            pending_truncated: true,
          },
          {
            target_id: "cooldown-target",
            run_id: "cooldown-run",
            source: "semantic-scholar",
            status: "cooling",
            retries: 0,
            next_retry_at: past,
            reason: reason("metadata-provider-rate-limited"),
            pending_count: 0,
            pending_sample: [],
            pending_truncated: false,
          },
          {
            target_id: "cooldown-target",
            run_id: "cooldown-run",
            source: "core",
            status: "disabled",
            retries: 6,
            next_retry_at: null,
            reason: reason("metadata-provider-rate-limited"),
            pending_count: 0,
            pending_sample: [],
            pending_truncated: false,
          },
          {
            target_id: "cooldown-target",
            run_id: "cooldown-run",
            source: "crossref",
            status: "recovered",
            retries: 0,
            next_retry_at: null,
            reason: null,
            pending_count: 0,
            pending_sample: [],
            pending_truncated: false,
          },
          {
            target_id: "cooldown-target",
            run_id: "cooldown-run",
            source: "opencitations",
            status: "retry-ended",
            retries: 1,
            next_retry_at: null,
            reason: reason("metadata-provider-unavailable"),
            pending_count: 0,
            pending_sample: [],
            pending_truncated: false,
          },
        ];
        await route.fulfill({ response, json: value });
      },
    );
    await page.goto(new URL(`/?view=task&task=${task}`, page.url()).href);
    const sources = page.getByRole("region", { name: "来源", exact: true });
    await sources.waitFor();
    const lines = await sources
      .locator(".citation-source-state")
      .allTextContents();
    const retryAt = new Date(soon).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(lines).toEqual([
      `OpenAlex · 冷却中，${retryAt} 重试（第 2 次） · 待补查 37 项`,
      "Semantic Scholar · 冷却中，等待重试",
      "CORE · 本任务内已停用：连续限流 6 次",
      "Crossref · 已恢复",
      "OpenCitations · 冷却结束，重试出错：错误",
    ]);
    expect(
      await sources.locator('.citation-source[data-status="disabled"]').count(),
    ).toBe(1);
    await sources
      .getByRole("button", { name: "待补查 37 项", exact: true })
      .click();
    const sample = sources.locator(".citation-source-sample");
    await expect
      .poll(() => sample.locator(".citation-source-title").allTextContents())
      .toEqual(
        Array.from({ length: 20 }, (_, n) =>
          n === 1 ? DISCOVERED[0][1] : "Unparsed source",
        ),
      );
    expect(
      (
        await sample.locator(".citation-source-purpose").allTextContents()
      ).slice(0, 2),
    ).toEqual(["查参考文献", "查书目"]);
    expect(await sample.locator(".citation-source-more").textContent()).toBe(
      "只列出前 20 项",
    );
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("saves a filter in the order “最近收进来” and reads it back unchanged", async () => {
  const w = await nextWorkspace({ setup: withDiscovered });
  try {
    const page = w.page;
    const list = async () =>
      (
        (await w.env.app.filters.query({ operation: "list", request: {} })) as {
          items: { name: string; query: unknown; sort: string }[];
        }
      ).items;
    // The collected papers' own order, with a condition.
    await page.goto(
      new URL(
        `/?view=lib&sort=collected-desc&query=${encode({ publication_year_from: 2000 })}`,
        page.url(),
      ).href,
    );
    await page.locator(".paper-row").first().waitFor();
    await (await openSavedViews(page))
      .getByRole("menuitem", { name: "保存当前筛选…", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "保存筛选" });
    await dialog
      .getByRole("textbox", { name: "筛选名称" })
      .fill("最近收进来的");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    // Stored as it was asked, not as another order.
    expect(
      (await list()).find((filter) => filter.name === "最近收进来的")?.sort,
    ).toBe("collected-desc");
    // Applied from another order, it brings its own back.
    await page.goto(new URL("/?view=lib&sort=title-asc", page.url()).href);
    await page.locator(".paper-row").first().waitFor();
    await (await openSavedViews(page))
      .getByRole("menuitem", { name: "最近收进来的", exact: true })
      .click();
    await expect.poll(() => sort(page)).toBe("collected-desc");
    expect(query(page).publication_year_from).toBe(2000);
    expect(
      await page
        .getByRole("button", { name: /排序/u })
        .and(page.locator('[aria-haspopup="listbox"]'))
        .textContent(),
    ).toBe("排序：最近收进来");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

/**
 * Whole-library text search reads windows of raw hits (technical 06 2.4).
 * The fixture is far below the 95,000 hits of a window, so the service's
 * window receipts are given here, in their contract shape, over its answers.
 */
async function scanWindows(
  page: Page,
  options: { empty?: string; truncated?: boolean; lost?: boolean } = {},
) {
  const asked: {
    name: string;
    window: string | null;
    query: Record<string, unknown>;
  }[] = [];
  for (const name of ["search", "library-counts", "library-facets"])
    await page.route(
      (url) => url.pathname === `/api/v1/query/${name}`,
      async (route) => {
        const body = route.request().postDataJSON() as {
          protocol_version: number;
          request: Record<string, unknown> & {
            query?: { text?: string | null };
            cursor?: string | null;
          };
        };
        const request = body.request;
        const text = request.query?.text ?? null;
        const window =
          typeof request.window_cursor === "string"
            ? request.window_cursor
            : null;
        if (
          !text ||
          (request.query as Record<string, unknown> | undefined)
            ?.collection_scope
        )
          return route.continue();
        asked.push({
          name,
          window,
          query: request.query as Record<string, unknown>,
        });
        // An old cursor or other words: the service no longer knows it.
        if (options.lost && window !== null)
          return route.fulfill({
            status: 409,
            json: { protocol_version: 1, code: "query-reference-invalid" },
          });
        const { window_cursor: _drop, ...rest } = request;
        void _drop;
        const response = await route.fetch({
          postData: JSON.stringify({ ...body, request: rest }),
        });
        const value = (await response.json()) as Record<
          string,
          Record<string, unknown>
        >;
        // The first window has older hits left; the second is the last.
        const first = window === null;
        if (name === "search") {
          const p = value.page!;
          if (text === options.empty) {
            p.items = [];
            p.total_count = 0;
            p.next_cursor = null;
          }
          if (first && request.cursor == null) {
            Object.assign(p, {
              scan_incomplete: true,
              scan_limit: 95000,
              next_window_cursor: "window-2",
              relevance_limit: 1000,
              ...(options.truncated
                ? { total_count: 10000, count_truncated: true }
                : {}),
            });
          }
        } else if (first) value.result!.scan_incomplete = true;
        return route.fulfill({ response, json: value });
      },
    );
  return asked;
}

it("says a search with older hits unread finds at least so many, goes on to the earlier hits and back, and keeps relevance alone", async () => {
  const w = await nextWorkspace({ setup: withDiscovered });
  try {
    const page = w.page;
    const asked = await scanWindows(page);
    await page.goto(
      new URL(`/?view=lib&query=${encode({ text: "Discovered" })}`, page.url())
        .href,
    );
    const count = page.locator(".ui-page-header .ui-page-count");
    // A lower bound, never an exact number.
    await expect.poll(() => count.textContent()).toBe("至少 2 篇符合");
    const scope = page.locator(".library-search-scope");
    await expect
      .poll(() => scope.locator(".library-relevance-limit").textContent())
      .toBe(
        "在最近写入索引的 95,000 条命中里按相关度显示前 1,000 条在更早的命中里继续找",
      );
    const quick = page.locator(".library-status-filters");
    await expect
      .poll(() =>
        quick
          .getByRole("button", { name: /^全部/u })
          .locator(".filter-count")
          .textContent(),
      )
      .toMatch(/^\d+\+$/u);
    // At the end of the window, the way on, beside the rows.
    const end = page.locator(".library-window-end");
    await end.getByRole("button", { name: "在更早的命中里继续找" }).waitFor();

    // Only relevance can be paged: the others are disabled, saying why.
    await page
      .getByRole("button", { name: /排序/u })
      .and(page.locator('[aria-haspopup="listbox"]'))
      .click();
    const options = page.getByRole("option");
    await options.first().waitFor();
    const states = await options.evaluateAll((items) =>
      items.map((item) => [
        item.querySelector('[slot="label"]')?.textContent ?? "",
        item.getAttribute("aria-disabled") === "true",
      ]),
    );
    expect(states.find(([label]) => label === "相关度")?.[1]).toBe(false);
    expect(
      states.filter(([label]) => label !== "相关度").every(([, off]) => off),
    ).toBe(true);
    expect(await page.getByRole("listbox").textContent()).toContain(
      "超过 1 万篇时只能按这几种排序；先加条件，或缩小范围",
    );
    await page.keyboard.press("Escape");

    // On to the earlier hits: the list and the counts move together.
    asked.length = 0;
    await end
      .getByRole("button", { name: "在更早的命中里继续找", exact: true })
      .click();
    await expect.poll(() => count.textContent()).toBe("这一批 2 篇符合");
    await expect
      .poll(() =>
        asked.filter((a) => a.window === "window-2").map((a) => a.name),
      )
      .toEqual(expect.arrayContaining(["search", "library-counts"]));
    await expect
      .poll(() => scope.locator(".library-relevance-limit").textContent())
      .toBe("在更早的第 2 批 95,000 条命中里查找回到最近的命中");
    // The last window: nothing older to go on to.
    expect(
      await page.getByRole("button", { name: "在更早的命中里继续找" }).count(),
    ).toBe(0);
    await expect
      .poll(() =>
        quick
          .getByRole("button", { name: /^全部/u })
          .locator(".filter-count")
          .textContent(),
      )
      .toMatch(/^\d+$/u);
    // And back to the newest hits.
    await scope
      .getByRole("button", { name: "回到最近的命中", exact: true })
      .click();
    await expect.poll(() => count.textContent()).toBe("至少 2 篇符合");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("says nothing was found in the newest hits, not in the library, and merges the 10,000 limit into one phrase", async () => {
  const w = await nextWorkspace({ setup: withDiscovered });
  try {
    const page = w.page;
    await scanWindows(page, { empty: "Nothing" });
    await page.goto(
      new URL(`/?view=lib&query=${encode({ text: "Nothing" })}`, page.url())
        .href,
    );
    const empty = page.locator(".library-empty");
    await empty
      .getByText("最近写入索引的 95,000 条命中里没有，更早的还没查", {
        exact: true,
      })
      .waitFor();
    expect(await empty.getByText("没有符合条件的文献").count()).toBe(0);
    // No “至少 0 篇”, and the line beside the sort keeps quiet: the list says it.
    expect(await page.locator(".ui-page-header .ui-page-count").count()).toBe(
      0,
    );
    expect(
      await page
        .locator(".library-search-scope .library-relevance-limit")
        .count(),
    ).toBe(0);
    // None found yet is no number: “0” would say there are none.
    const all = page
      .locator(".library-status-filters")
      .getByRole("button", { name: /^全部/u });
    await all.waitFor();
    expect(await all.textContent()).toBe("全部");
    expect(await all.locator(".filter-count").count()).toBe(0);
    await empty
      .getByRole("button", { name: "在更早的命中里继续找", exact: true })
      .waitFor();
    await page.unrouteAll({ behavior: "wait" });
    // Both limits: the 10,000 one says it, once.
    await scanWindows(page, { truncated: true });
    await page.goto(
      new URL(`/?view=lib&query=${encode({ text: "Discovered" })}`, page.url())
        .href,
    );
    await expect
      .poll(() => page.locator(".ui-page-header .ui-page-count").textContent())
      .toBe("1 万篇以上符合算出准确数");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("counts the quick filters in an earlier window too, and goes back to the newest hits when the service no longer knows the window", async () => {
  const w = await nextWorkspace({ setup: withDiscovered });
  try {
    const page = w.page;
    const asked = await scanWindows(page);
    await page.goto(
      new URL(`/?view=lib&query=${encode({ text: "Discovered" })}`, page.url())
        .href,
    );
    const count = page.locator(".ui-page-header .ui-page-count");
    await expect.poll(() => count.textContent()).toBe("至少 2 篇符合");
    const quick = page.locator(".library-status-filters");
    const chip = (name: RegExp) => quick.getByRole("button", { name });
    await chip(/^只有书目/u).click();
    await expect.poll(() => query(page).statuses).toEqual(["UNREVIEWED"]);
    // A quick filter chosen, on to the earlier hits: its counts follow.
    asked.length = 0;
    await page
      .locator(".library-search-scope")
      .getByRole("button", { name: "在更早的命中里继续找", exact: true })
      .click();
    await expect
      .poll(
        () =>
          asked.find(
            (a) => a.name === "library-counts" && a.window === "window-2",
          )?.query.statuses,
      )
      .toEqual([]);
    // The earlier window counts its own hits: plain numbers.
    await expect
      .poll(() =>
        chip(/^只有书目/u)
          .locator(".filter-count")
          .textContent(),
      )
      .toMatch(/^\d+$/u);
    await expect
      .poll(() => chip(/^全部/u).locator(".filter-count").textContent())
      .toMatch(/^\d+$/u);
    expect(w.errors).toEqual([]);

    // A window the service no longer knows: back to the newest hits.
    await page.unrouteAll({ behavior: "wait" });
    await scanWindows(page, { lost: true });
    await page.goto(
      new URL(`/?view=lib&query=${encode({ text: "Discovered" })}`, page.url())
        .href,
    );
    await expect.poll(() => count.textContent()).toBe("至少 2 篇符合");
    await page
      .locator(".library-search-scope")
      .getByRole("button", { name: "在更早的命中里继续找", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .locator(".library-search-scope .library-relevance-limit")
          .textContent(),
      )
      .toBe(
        "在最近写入索引的 95,000 条命中里按相关度显示前 1,000 条在更早的命中里继续找",
      );
    expect(await count.textContent()).toBe("至少 2 篇符合");
    expect(await page.getByRole("alert").count()).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("says when relevance ranked only part of a working set, with the set's own order for the rest and a line where the ranking stops", async () => {
  let folderId = "";
  const w = await nextWorkspace({
    setup: async (env) => {
      await withDiscovered(env);
      const folder = parseFolderNode(
        await env.app.folders.manage({
          operation: "create",
          request: { name: "排序文件夹", parent_id: null, position: null },
        }),
      );
      folderId = folder.folder_id;
      await env.app.folders.manage({
        operation: "add",
        request: {
          folder_id: folderId,
          literature_ids: DISCOVERED.map(([id]) => id),
        },
      });
    },
  });
  try {
    const page = w.page;
    // The fixture's sets are far below the scoring budget: the service's
    // receipt for a partly ranked set is given here, in its contract shape.
    let scored = 1;
    await page.route(
      (url) => url.pathname === "/api/v1/query/search",
      async (route) => {
        const request = (
          route.request().postDataJSON() as {
            request: {
              sort: string;
              cursor: string | null;
              query: Record<string, unknown>;
            };
          }
        ).request;
        const response = await route.fetch();
        const value = (await response.json()) as {
          page: Record<string, unknown>;
        };
        if (
          request.sort === "relevance" &&
          request.cursor === null &&
          (request.query.folder || request.query.collection_scope)
        )
          value.page.relevance_scored_count = scored;
        return route.fulfill({ response, json: value });
      },
    );
    const open = (query: object) =>
      page.goto(new URL(`/?view=lib&query=${encode(query)}`, page.url()).href);
    await open({
      text: "Discovered",
      folder: { id: folderId, include_descendants: true },
    });
    const note = page.locator(".library-search-scope .library-relevance-limit");
    await expect
      .poll(() => note.textContent())
      .toBe(
        "按相关度排了最近入库的 1 篇，其余 1 篇按入库时间排在后面；先加条件，或缩小范围，可全部按相关度排",
      );
    // A quiet line where the ranked rows end.
    const rows = page.locator(".paper-row");
    await rows.nth(1).waitFor();
    expect(await rows.nth(1).locator(".paper-unranked").textContent()).toBe(
      "以下未按相关度排序",
    );
    expect(await page.locator(".paper-unranked").count()).toBe(1);
    // Other sorts stay open.
    await page
      .getByRole("button", { name: /排序/u })
      .and(page.locator('[aria-haspopup="listbox"]'))
      .click();
    const options = page.getByRole("option");
    await options.first().waitFor();
    expect(
      await options.evaluateAll((items) =>
        items.some((item) => item.getAttribute("aria-disabled") === "true"),
      ),
    ).toBe(false);
    await page.keyboard.press("Escape");

    // None ranked, said too; no line at the top.
    scored = 0;
    await open({
      text: "Discovered",
      collection_scope: "collected",
    });
    await expect
      .poll(() => note.textContent())
      .toBe(
        "没有按相关度排序，按收进时间从近到远排列；先加条件，或缩小范围，可全部按相关度排",
      );
    await rows.first().waitFor();
    expect(await page.locator(".paper-unranked").count()).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);
