import type { Page } from "playwright";
import { openType, readerType } from "./reader-controls.js";
import type { DesignSampleIds } from "./design-samples-fixture.js";
import { doubtfulDraft, doubtfulFacts } from "./draft-doubts.js";

export interface DesignSamplePage {
  id: string;
  name: string;
  route: (ids: DesignSampleIds, gallery: boolean) => string;
  interaction?: string;
  prepare?: (page: Page, ids: DesignSampleIds) => Promise<void>;
  ready: string;
  anonymous?: boolean;
}
const route =
  (view: string, extra = "") =>
  () =>
    `/?view=${view}${extra}`;
const reader = (mode: string) => (ids: DesignSampleIds) =>
  `/?literature=${ids.literature}&reader=${mode}`;
const query = (value: object) => encodeURIComponent(JSON.stringify(value));
const stepNames = ["范围", "算子", "规范", "确认"];
/** Two acquisition tasks: one still running, one finished last night. */
function sampleSessions(literature: string) {
  const session = (
    id: string,
    operation: string,
    title: string,
    phase: string,
    queued: string,
    extra: object = {},
  ) => ({
    session_id: id,
    article_id: literature,
    generation: 1,
    phase,
    operation_id: operation,
    title,
    queued_at: queued,
    ...extra,
  });
  const now = "2026-10-26T06:02:00.000Z",
    night = "2026-10-25T13:30:00.000Z";
  // What ran before the Agent: an API miss and a public-site miss.
  const tried = (at: string) => [
    {
      stage: "publisher-api",
      source: "elsevier",
      started_at: at,
      finished_at: at,
      requested: true,
      result: "miss",
    },
    {
      stage: "public-web",
      source: "doi-landing",
      started_at: at,
      finished_at: at,
      requested: true,
      result: "miss",
    },
  ];
  return [
    session(
      "s-1",
      "op-now",
      "[样例] Synthetic spectra under humid storage",
      "deciding",
      now,
      { prior_attempts: tried(now) },
    ),
    session(
      "s-2",
      "op-now",
      "[样例] A quiet atlas of synthetic spectra and evidence",
      "downloading",
      now,
    ),
    session(
      "s-3",
      "op-now",
      "[样例] Interface diffusion in fictional oxide cells",
      "queued",
      now,
    ),
    session(
      "s-4",
      "op-now",
      "[样例] Thermal recovery of imaginary halide electrolytes",
      "closed",
      now,
      {
        closed_at: "2026-10-26T06:09:00.000Z",
        outcome: { kind: "published", code: "published" },
      },
    ),
    session(
      "s-5",
      "op-night",
      "[样例] Moisture-stable argyrodites in a sample world",
      "closed",
      night,
      {
        closed_at: "2026-10-25T13:41:00.000Z",
        outcome: { kind: "published", code: "published" },
      },
    ),
    session(
      "s-6",
      "op-night",
      "[样例] Catholyte interfaces for synthetic lithium metal",
      "closed",
      night,
      {
        closed_at: "2026-10-25T13:44:00.000Z",
        outcome: { kind: "retained", code: "browser-flow-stopped" },
        stop: {
          reason: "blocked",
          explanation:
            "页面要求机构登录，当前会话没有可用的访问权限，未获取 PDF。",
        },
      },
    ),
  ];
}
/** Leaves one API response pending until the page closes: a loading state that stays put. */
async function holdResponse(p: Page, path: string) {
  await p.route(
    // The PDF bytes are read by GET under the route's path (`/:literature/:asset/:sha256`).
    (url) => url.pathname === path || url.pathname.startsWith(`${path}/`),
    async (request) => {
      await new Promise((resolve) => p.once("close", resolve));
      await request.abort().catch(() => undefined);
    },
  );
}
/**
 * A whole-library text search with older raw hits unread (technical 06
 * 2.4): the sample is far below a window of hits, so the service's
 * window receipts are given in their contract shape over its answers. The
 * first window has older hits left; the second is the last.
 */
async function scanWindows(p: Page, empty = false, members = false) {
  for (const name of ["search", "library-counts", "library-facets"])
    await p.route(
      (url) => url.pathname === `/api/v1/query/${name}`,
      async (route) => {
        const body = route.request().postDataJSON();
        const request = body?.request ?? {};
        if (!request.query?.text || request.query.collection_scope)
          return route.continue();
        const first = typeof request.window_cursor !== "string";
        delete request.window_cursor;
        const response = await route.fetch({ postData: JSON.stringify(body) });
        const value = await response.json();
        if (name === "search") {
          if (empty)
            Object.assign(value.page, {
              items: [],
              total_count: 0,
              next_cursor: null,
            });
          if (first && request.cursor == null)
            Object.assign(value.page, {
              scan_incomplete: true,
              // A large working set is read by its newest members.
              scan_side: members ? "members" : "hits",
              scan_limit: members ? 8000 : 75000,
              next_window_cursor: "sample-window-2",
              ...(members ? {} : { relevance_limit: 1000 }),
            });
        } else {
          // Nothing in the window: its counts and terms are empty too, as
          // the service would answer.
          if (empty && name === "library-counts") {
            const r = value.result;
            for (const key of Object.keys(r.statuses)) r.statuses[key] = 0;
            Object.assign(r, {
              total: 0,
              unavailable_pdf: 0,
              with_primary_pdf: 0,
              recently_opened: 0,
              full_text: { total: 0, obtained: 0, missing: 0, exhausted: 0 },
            });
          }
          if (empty && name === "library-facets")
            Object.assign(value.result, {
              total: 0,
              coverage: { tags: 0, keywords: 0, subject_terms: 0 },
              tags: [],
              keywords: [],
              subject_terms: [],
            });
          if (first) value.result.scan_incomplete = true;
        }
        await route.fulfill({ response, json: value });
      },
    );
  await p.reload();
}
async function openSettings(p: Page, name: string) {
  // Desktop lists sections down the side; narrow screens use a menu.
  const tab = p.getByRole("tab", { name, exact: true });
  await p.locator(".settings-navigation").waitFor();
  if (await tab.isVisible()) await tab.click();
  else {
    await p.locator(".settings-navigation-narrow button").click();
    await p.getByRole("option", { name, exact: true }).click();
  }
}
/** Searches the sample library once its index is current. */
async function searchSample(p: Page, text: string) {
  await p.locator('input[placeholder="输入要查找的问题或关键词"]').fill(text);
  await p
    .getByTestId("retrieval-index")
    .waitFor({ state: "hidden", timeout: 15_000 })
    .catch(() => undefined);
  await p
    .getByRole("main")
    .getByRole("button", { name: "检索", exact: true })
    .click();
  await p.locator(".retrieval-result").first().waitFor();
}
export const designSamplePages: readonly DesignSamplePage[] = [
  {
    id: "intake",
    name: "找文献 · 发现与导入",
    route: route("disc"),
    ready: ".intake-form",
  },
  {
    id: "library",
    name: "文献库 · 默认",
    route: route("lib"),
    ready: ".paper-row",
  },
  {
    id: "library-filters",
    name: "文献库 · 筛选面板",
    route: route("lib"),
    interaction: "展开筛选",
    prepare: async (p) => {
      await p.locator(".paper-row").first().waitFor();
      if (
        await p
          .getByRole("button", { name: "更多操作", exact: true })
          .isVisible()
      )
        await p.getByRole("button", { name: "更多操作", exact: true }).click();
      // One press on “筛选” opens the conditions (page specs “文献库”).
      await p
        .getByRole("button", { name: /^筛选/ })
        .filter({ visible: true })
        .click();
    },
    ready: ".library-filters",
  },
  {
    id: "library-drafts",
    name: "文献库 · 未校对行与新筛选",
    // Plan 21: draft papers, sorted by their differences, the filters open.
    route: () =>
      `/?view=lib&query=${encodeURIComponent(JSON.stringify({ text_levels: ["draft"] }))}&sort=draft-differences-desc`,
    interaction:
      "按文本等级“未校对”筛选、按与 PDF 自带文字的差异排序，展开筛选",
    // The sample's drafts agree with their text layers; the first is given
    // the same simulated doubt as “reader-draft”, so the two pages agree.
    prepare: async (p, ids) => {
      await doubtfulFacts(p, ids.draft);
      await p.reload();
      await p.locator(".paper-row").first().waitFor();
      if (
        await p
          .getByRole("button", { name: "更多操作", exact: true })
          .isVisible()
      )
        await p.getByRole("button", { name: "更多操作", exact: true }).click();
      // One press on “筛选” opens the conditions (page specs “文献库”).
      await p
        .getByRole("button", { name: /^筛选/ })
        .filter({ visible: true })
        .click();
    },
    ready: ".library-filters",
  },
  {
    id: "library-selection",
    name: "文献库 · 选择两篇",
    route: route("lib"),
    interaction: "选择前两行",
    prepare: async (p) => {
      const rows = p.locator(".paper-row");
      await rows.nth(1).waitFor();
      for (const n of [0, 1]) {
        await rows.nth(n).focus();
        await p.keyboard.press("Space");
      }
    },
    ready: '[aria-label="文献选择"]',
  },
  {
    id: "library-selection-mixed",
    name: "文献库 · 混合选择",
    route: route("lib", "&sort=title-asc"),
    interaction: "按住勾选列向下拖过可见的几行，选中状态不一的文献",
    prepare: async (p) => {
      const box = async (n: number) => {
        const b = (await p
          .locator(`.paper-row[data-index="${n}"] .paper-check`)
          .boundingBox())!;
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      };
      // Drag down to the last row fully in view, so the list does not autoscroll.
      await p.locator('.paper-row[data-index="3"]').waitFor();
      const height = p.viewportSize()!.height;
      let last = 0;
      while ((await box(last + 1)).y < height - 160) last++;
      const from = await box(0),
        to = await box(last);
      await p.mouse.move(from.x, from.y);
      await p.mouse.down();
      await p.mouse.move(to.x, to.y, { steps: 8 });
      await p.mouse.up();
    },
    ready: '[aria-label="文献选择"] .selection-group',
  },
  {
    id: "archive-estimate",
    name: "解析全文 · 发起前预计消耗",
    // Only failed archives can be archived again here; the fixture still archives samples 15 and 16.
    route: route(
      "lib",
      `&sort=title-asc&query=${query({ statuses: ["ARCHIVE_FAILED"] })}`,
    ),
    interaction: "在全文解析失败的文献里勾选两篇，点“解析全文”，展开技术详情",
    prepare: async (p) => {
      const rows = p.locator(".paper-row");
      await rows.nth(1).waitFor();
      // Focus each row directly: ArrowDown moves focus only on the next frame.
      for (const n of [0, 1]) {
        await rows.nth(n).focus();
        await p.keyboard.press("Space");
      }
      await p
        .getByRole("region", { name: "文献选择" })
        .getByRole("button", { name: "解析全文 2", exact: true })
        .click();
      // Calls and tokens sit in the dialog's technical details (rule 8).
      await p
        .getByRole("dialog")
        .getByRole("button", { name: "技术详情：预计用量", exact: true })
        .click();
    },
    ready: '[aria-label="启动前用量预估"] table',
  },
  {
    id: "library-folder",
    name: "文献库 · 文件夹",
    route: (ids) =>
      `/?view=lib&query=${query({ folder: { id: ids.folder, include_descendants: true } })}`,
    ready: ".paper-row",
  },
  {
    id: "library-needs-action",
    name: "文献库 · 需处理",
    route: route("lib", `&query=${query({ statuses: ["ARCHIVE_FAILED"] })}`),
    ready: ".paper-row",
  },
  {
    id: "library-empty",
    name: "文献库 · 空结果",
    route: route(
      "lib",
      `&query=${query({ text: "nonexistent-design-sample-query" })}`,
    ),
    ready: ".ui-empty",
  },
  {
    id: "library-search-discovered",
    name: "文献库 · 搜索结果（含候选）",
    route: route("lib", `&query=${query({ text: "Synthetic" })}`),
    interaction:
      "搜索文献；第一页的候选的行排到前面，分别标为来自引用扩展、来自主题搜索与没有来历（来历与排列为模拟）；指针停在第一行候选的文献上",
    // The sample's discovered papers have no discovery batch; the origins
    // are given in the service's shape for this page.
    prepare: async (p) => {
      await p.route(
        (url) => url.pathname === "/api/v1/query/search",
        async (request) => {
          const response = await request.fetch();
          const value = await response.json();
          let n = 0;
          // Bring the first page's discovered rows into view, after two
          // collected ones.
          const items = value.page?.items ?? [];
          if (items.length)
            value.page.items = [
              ...items
                .filter((i: { collected?: boolean }) => i.collected !== false)
                .slice(0, 2),
              ...items.filter(
                (i: { collected?: boolean }) => i.collected === false,
              ),
              ...items
                .filter((i: { collected?: boolean }) => i.collected !== false)
                .slice(2),
            ];
          for (const item of value.page?.items ?? [])
            if (item.collected === false && n++ % 3 !== 2)
              item.discovery_origin = {
                kind: n % 3 === 1 ? "citation" : "topic",
                intake_batch_id: "00000000-0000-0000-0000-000000079001",
              };
          await request.fulfill({ response, json: value });
        },
      );
      await p.reload();
      // “加入文献库” is a row action: the pointer rests on the first discovered
      // row, so the page shows it once, beside that row's status.
      await p
        .locator(".paper-row:has(.paper-discovered)")
        .first()
        .locator(".paper-title")
        .hover();
    },
    // Ready once the discovered rows are drawn; their action is shown only
    // on the touched row.
    ready: ".paper-row .paper-discovered",
  },
  {
    id: "search-window-incomplete",
    name: "搜索 · 更早的命中还没查",
    route: route("lib", `&query=${query({ text: "Synthetic" })}`),
    interaction:
      "整库搜索，最近写入索引的一批之外还有更早的命中（扫描窗口按合同样式模拟）",
    prepare: (p) => scanWindows(p),
    ready: ".library-search-scope .library-relevance-limit .ui-button",
  },
  {
    id: "search-window-empty",
    name: "搜索 · 最近一批命中里没有",
    route: route("lib", `&query=${query({ text: "Synthetic" })}`),
    interaction:
      "搜索文献，文献库里有命中，候选在最近写入索引的一批命中里没有（扫描窗口与零结果均为模拟）",
    prepare: (p) => scanWindows(p, true),
    ready: '.library-window-end .ui-button:has-text("在更早的命中里继续找")',
  },
  {
    id: "search-window-second",
    name: "搜索 · 更早的第 2 批",
    route: route("lib", `&query=${query({ text: "Synthetic" })}`),
    interaction:
      "按“在更早的命中里继续找”，换到更早的第 2 批（扫描窗口按合同样式模拟）",
    prepare: async (p) => {
      await scanWindows(p);
      await p
        .locator(".library-search-scope")
        .getByRole("button", { name: "在更早的命中里继续找", exact: true })
        .click();
      // The pointer leaves the spot, so “回到最近的命中” shows at rest.
      await p.mouse.move(0, 0);
    },
    ready: '.library-search-scope .ui-button:has-text("回到最近的命中")',
  },
  {
    id: "search-window-sort",
    name: "搜索 · 更早的命中还没查时的排序",
    route: route("lib", `&query=${query({ text: "Synthetic" })}`),
    interaction:
      "扫描未完时展开排序菜单：只有相关度可选（扫描窗口按合同样式模拟）",
    prepare: async (p) => {
      await scanWindows(p);
      await p
        .locator(".library-search-scope .library-relevance-limit .ui-button")
        .first()
        .waitFor();
      // On a narrow screen the sort is in “更多操作”.
      const more = p.getByRole("button", { name: "更多操作", exact: true });
      if (await more.isVisible()) await more.click();
      await p
        .getByRole("button", { name: /排序/u })
        .and(p.locator('[aria-haspopup="listbox"]'))
        .filter({ visible: true })
        .click();
    },
    ready: '[role="listbox"]',
  },
  {
    id: "library-folder-scored",
    name: "文献库 · 文件夹内部分打分",
    route: (ids) =>
      `/?view=lib&query=${query({ text: "Synthetic", folder: { id: ids.folder, include_descendants: true } })}`,
    interaction:
      "在文件夹里搜索，相关度只排了前 5 篇，其余按新增时间在后（部分打分的回执按合同样式模拟）",
    prepare: async (p) => {
      await p.route(
        (url) => url.pathname === "/api/v1/query/search",
        async (request) => {
          const asked = request.request().postDataJSON()?.request ?? {};
          const response = await request.fetch();
          const value = await response.json();
          if (
            asked.sort === "relevance" &&
            asked.cursor === null &&
            asked.query?.folder
          )
            value.page.relevance_scored_count = 5;
          await request.fulfill({ response, json: value });
        },
      );
      await p.reload();
      // The line where the ranking stops, in view on a narrow screen too.
      await p.locator(".paper-unranked").scrollIntoViewIfNeeded();
    },
    ready: ".paper-unranked",
  },
  {
    id: "folder-members-window",
    name: "搜索 · 文件夹成员窗口（有结果）",
    route: (ids: DesignSampleIds) =>
      `/?view=lib&query=${query({ text: "Synthetic", folder: { id: ids.folder, include_descendants: true } })}`,
    interaction:
      "在超过一万篇的文件夹里搜索，只查了最近新增的 8,000 篇（成员窗口按合同样式模拟）",
    prepare: (p) => scanWindows(p, false, true),
    ready: ".library-search-scope .library-relevance-limit .ui-button",
  },
  {
    id: "folder-members-empty",
    name: "搜索 · 文件夹成员窗口（零结果）",
    route: (ids: DesignSampleIds) =>
      `/?view=lib&query=${query({ text: "Synthetic", folder: { id: ids.folder, include_descendants: true } })}`,
    interaction:
      "在超过一万篇的文件夹里搜索，最近新增的 8,000 篇里没有（成员窗口与零结果均为模拟）",
    prepare: (p) => scanWindows(p, true, true),
    ready: '.library-empty .ui-button:has-text("在更早新增的文献里继续找")',
  },
  {
    id: "folder-members-second",
    name: "搜索 · 文件夹成员窗口（第 2 批）",
    route: (ids: DesignSampleIds) =>
      `/?view=lib&query=${query({ text: "Synthetic", folder: { id: ids.folder, include_descendants: true } })}`,
    interaction:
      "按“在更早新增的文献里继续找”，换到更早新增的第 2 批（成员窗口按合同样式模拟）",
    prepare: async (p) => {
      await scanWindows(p, false, true);
      await p
        .locator(".library-search-scope")
        .getByRole("button", { name: "在更早新增的文献里继续找", exact: true })
        .click();
      await p.mouse.move(0, 0);
    },
    ready: '.library-search-scope .ui-button:has-text("回到最近新增的文献")',
  },
  {
    id: "library-over-limit",
    name: "文献库 · 超过一万篇",
    route: route("lib", `&query=${query({ author: "Imaginary" })}`),
    interaction:
      "按作者筛选文献库；列表、快速筛选与范围内的词按超过一万篇的截断标记模拟，状态正在更新",
    prepare: async (p) => {
      await p.route(
        (url) => url.pathname === "/api/v1/query/search",
        async (request) => {
          const response = await request.fetch();
          const value = await response.json();
          value.page.total_count = 10000;
          value.page.count_truncated = true;
          value.page.status_updating = true;
          await request.fulfill({ response, json: value });
        },
      );
      await p.route(
        (url) => url.pathname === "/api/v1/query/library-counts",
        async (request) => {
          const response = await request.fetch();
          const value = await response.json();
          const asked = request.request().postDataJSON()?.request?.query ?? {};
          const r = value.result;
          // The filtered counts stop at 10,000; the scope's are counters.
          if (asked.author) {
            const statuses = r.statuses as Record<string, number>;
            for (const key of Object.keys(statuses)) statuses[key] = 0;
            Object.assign(statuses, {
              READY: 3200,
              ASSET_READY: 1800,
              UNREVIEWED: 5000,
            });
            Object.assign(r, {
              total: 10000,
              unavailable_pdf: 0,
              with_primary_pdf: 5000,
              recently_opened: 0,
              full_text: { total: 0, obtained: 0, missing: 0, exhausted: 0 },
              count_truncated: true,
            });
          }
          await request.fulfill({ response, json: value });
        },
      );
      await p.route(
        (url) => url.pathname === "/api/v1/query/library-facets",
        async (request) => {
          const response = await request.fetch();
          const value = await response.json();
          Object.assign(value.result, {
            total: 10000,
            count_truncated: true,
            facets_truncated: true,
          });
          await request.fulfill({ response, json: value });
        },
      );
      await p.reload();
    },
    ready: '.ui-page-count .ui-button:has-text("算出准确数")',
  },
  {
    id: "reader-pdf",
    name: "阅读 · PDF",
    route: reader("pdf"),
    ready: '.reading-pdf-page[data-rendered="true"]',
  },
  {
    id: "reader-text",
    name: "阅读 · 全文",
    route: reader("doc"),
    ready: '.react-reader[data-reading-ready="true"] .reading-article',
  },
  {
    id: "reader-figure",
    name: "阅读 · 正文图片",
    route: reader("doc"),
    interaction: "滚动到正文图，等待可见资源加载",
    prepare: async (page) => {
      await page.locator('.react-reader[data-reading-ready="true"]').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await page
        .locator(".reader-engine-body [data-resource]")
        .first()
        .scrollIntoViewIfNeeded();
    },
    ready: ".reader-engine-body img",
  },
  {
    id: "reader-view-menu",
    name: "阅读 · 顶栏菜单展开",
    route: reader("doc"),
    // Below 640 px the views are one button: its menu open. Wider, “更多” open.
    interaction: "窄屏点开视图按钮，其余宽度点开“更多”",
    prepare: async (p) => {
      await p.locator('.react-reader[data-reading-ready="true"]').waitFor();
      const views = p.getByRole("button", { name: /^视图：/ });
      if (await views.isVisible()) await views.click();
      else await p.getByRole("button", { name: "更多", exact: true }).click();
    },
    ready: ".ui-menu",
  },
  {
    id: "reader-focus-mode",
    name: "阅读 · 专注模式",
    route: reader("doc"),
    // Spec 1.7: the top bar folded up, the side panel closed.
    interaction: "按 F 进入专注模式",
    prepare: async (p) => {
      await p.locator('.react-reader[data-reading-ready="true"]').waitFor();
      await p
        .locator(".reader-engine-body")
        .click({ position: { x: 5, y: 5 } });
      await p.keyboard.press("f");
      await p.waitForTimeout(400);
    },
    ready: "[data-reader-page][data-focus]",
  },
  {
    id: "reader-pdf-column",
    name: "阅读 · PDF 页列（50%）",
    route: reader("pdf"),
    // Spec 3.5: zoomed, the page column and the spine centred on the desk.
    interaction: "排版缩小到 50%",
    prepare: async (p) => {
      await p
        .locator('.reading-pdf-page[data-rendered="true"]')
        .first()
        .waitFor();
      // Spec 1.8.1: 实际大小 (100%), then 缩小 by tens to 50%.
      await readerType(p, "50%");
      await p.waitForTimeout(600);
    },
    ready: '.reading-pdf-page[data-rendered="true"]',
  },
  {
    id: "reader-edit",
    name: "阅读 · 编辑",
    route: reader("edit"),
    ready: ".proofread-editor textarea",
  },
  {
    id: "reader-edit-dropped",
    name: "阅读 · 编辑 · 显示已删除",
    route: reader("edit"),
    interaction: "打开“显示已删除”",
    prepare: async (p) => {
      await p.locator(".proofread-editor textarea").first().waitFor();
      await p.getByText("显示已删除", { exact: true }).click();
    },
    ready: ".dropped-leaf",
  },
  {
    id: "reader-results",
    name: "阅读 · 结果",
    route: reader("results"),
    ready: '[aria-label="文献参与的全部结果"] .paper-result',
  },
  {
    id: "reader-summary",
    name: "阅读 · 总结",
    route: reader("know"),
    ready: '[aria-label="文献总结"] .reader-prose',
  },
  {
    id: "reader-focus",
    name: "阅读 · 收起信息栏",
    route: reader("doc"),
    interaction: "收起文献信息",
    prepare: async (p) => {
      await p.locator('.react-reader[data-reading-ready="true"]').waitFor();
      const close = p.getByRole("button", { name: "收起信息", exact: true });
      if (await close.isVisible()) await close.click();
    },
    ready: '.react-reader[data-reading-ready="true"]',
  },
  {
    id: "reader-information",
    name: "阅读 · 信息栏",
    route: reader("doc"),
    interaction: "显示信息栏，看“材料”一节与时间",
    prepare: async (p) => {
      await p.locator('.react-reader[data-reading-ready="true"]').waitFor();
      const open = p.getByRole("button", { name: "显示信息", exact: true });
      if (await open.isVisible()) await open.click();
      else if (!(await p.locator(".reader-steps").first().isVisible())) {
        // Below 760 px the panel's button is in “更多” (spec 1.3).
        await p.getByRole("button", { name: "更多", exact: true }).click();
        await p
          .getByRole("menuitem", { name: "显示信息", exact: true })
          .click();
      }
    },
    ready: ".reader-steps",
  },
  {
    id: "reader-draft",
    name: "阅读 · 未校对的全文（核对依据与差异浮层）",
    route: (ids) => `/?literature=${ids.draft}&reader=doc`,
    // The sample's page layer agrees with its parse: the doubts come from
    // served replies made doubtful, as in the reader's tests.
    interaction: "显示核对依据，点开第一个“疑点”",
    prepare: async (p) => {
      await doubtfulDraft(p);
      await p.reload();
      await p.locator('.react-reader[data-reading-ready="true"]').waitFor();
      await readerType(p, "显示核对依据");
      // The popover closes when the text scrolls: bring the mark in first.
      const doubt = p.locator("button.reading-doubt").first();
      await doubt.scrollIntoViewIfNeeded();
      await p.waitForTimeout(400);
      await doubt.click();
    },
    ready: ".reader-doubt strong",
  },
  {
    id: "reader-long",
    name: "阅读 · 长文档（分批载入）",
    route: (ids) => `/?literature=${ids.longDocument}&reader=doc`,
    ready:
      '.react-reader[data-reading-ready="true"] .reading-continuation:not([hidden])',
  },
  {
    id: "reader-pdf-only",
    name: "阅读 · 只有 PDF 没有文本",
    route: (ids) => `/?literature=${ids.pdfOnly}&reader=doc`,
    ready: ".reader-surface .ui-empty",
  },
  {
    id: "reader-pdf-default",
    name: "阅读 · 有 PDF 没有全文（默认 PDF）",
    // Opened without a view: the PDF, and “还没有全文 · 解析全文” under the page header (plan 25 block 30).
    route: (ids) => `/?literature=${ids.pdfOnly}`,
    ready: '.reader-page-header-line:has-text("还没有全文")',
  },
  {
    id: "reader-metadata-only",
    name: "阅读 · 书目页",
    // Opened without a view: the bibliography set on the sheet (plan 25 block 30).
    route: (ids) => `/?literature=${ids.metadataOnly}`,
    ready: ".reader-bibliography-sheet .bibliography-title",
  },
  {
    id: "reader-metadata-not-found",
    name: "阅读 · 书目页（没找到 PDF）",
    route: (ids) => `/?literature=${ids.metadataOnly}`,
    // The automatic routes exhausted (三篇样例里的“没找到 PDF”), served for this paper.
    interaction: "把这篇的详情标为“没找到 PDF”后打开",
    prepare: async (p, ids) => {
      await p.route(
        (url) => url.pathname === "/api/v1/query/read",
        async (route) => {
          const response = await route.fetch();
          const value = await response.json();
          const detail = value.detail ?? value.result?.detail;
          if (detail?.literature?.literature_id === ids.metadataOnly)
            detail.needs_manual_pdf = true;
          await route.fulfill({ response, json: value });
        },
      );
      await p.reload();
    },
    ready: '.reader-bibliography-fulltext:has-text("自动找过")',
  },
  {
    id: "reader-type-panel",
    name: "阅读 · 排版面板",
    route: reader("doc"),
    interaction: "点开“排版”",
    prepare: async (p) => {
      await p.locator('.react-reader[data-reading-ready="true"]').waitFor();
      await openType(p);
    },
    ready: ".reader-type-panel",
  },
  ...(
    [
      ["pdf", "PDF", "material-bytes", "下载 PDF"],
      // The first full-text read: nothing of the text shows yet, so the
      // picture does not depend on how far loading got before the shot.
      ["doc", "全文", "document-segments", "读取全文"],
    ] as const
  ).map(
    ([mode, label, operation, status]): DesignSamplePage => ({
      id: `reader-loading-${mode}`,
      name: `阅读 · ${label}加载中`,
      route: reader(mode),
      interaction: `${operation} 的响应一直不返回，停在加载中`,
      prepare: async (p) => {
        await holdResponse(p, `/api/v1/query/${operation}`);
        await p.reload({ waitUntil: "domcontentloaded" });
      },
      // Spec 6.3: the skeleton with the step under way.
      ready: `.reader-preparing .reader-preparing-step[data-state="current"]:has-text("${status}")`,
    }),
  ),
  ...stepNames.map(
    (name, index): DesignSamplePage => ({
      id: `operator-step-${index + 1}`,
      name: `运行算子 · ${name}`,
      route: route("ext"),
      interaction: `打开对话框并到达${name}步骤`,
      prepare: async (p) => {
        await p
          .getByRole("main")
          .getByRole("button", { name: "运行算子", exact: true })
          .click();
        const dialog = p.getByRole("dialog", { name: "运行算子", exact: true });
        for (let n = 0; n < index; n++)
          await dialog
            .getByRole("button", { name: "下一步", exact: true })
            .click();
        await dialog
          .locator('[aria-current="step"]')
          .filter({ hasText: name })
          .waitFor();
      },
      ready: '[role="dialog"] [aria-current="step"]',
    }),
  ),
  {
    id: "operator-runs",
    name: "算子 · 运行记录",
    route: route("ext"),
    ready: '[aria-label="算子运行记录"]',
  },
  {
    id: "operator-runs-source",
    name: "算子 · 来源筛选",
    route: route("ext"),
    interaction: "聚焦来源输入框，列出可选快照",
    prepare: async (p) => {
      await p.locator(".run-list").waitFor();
      await p.getByRole("combobox", { name: "按来源筛选" }).click();
    },
    ready: ".ui-listbox .ui-option",
  },
  {
    id: "result-detail",
    name: "算子 · 结果详情",
    route: (ids) =>
      `/?view=ext&result=${ids.result}&resultHash=${ids.resultHash}`,
    ready: '[aria-label="提取结果"]',
  },
  {
    id: "result-detail-peek",
    name: "算子 · 证据预览",
    route: (ids) =>
      `/?view=ext&result=${ids.result}&resultHash=${ids.resultHash}`,
    interaction: "键盘聚焦第一个取值，预览原文",
    prepare: async (p) => {
      // Columns: selection, source, then the first extracted field.
      const value = p
        .locator('[aria-label="提取结果"] tbody tr')
        .first()
        .locator("td")
        .nth(2)
        .locator(".ui-button")
        .first();
      await value.waitFor();
      await value.focus();
      await p.keyboard.press("Shift+Tab");
      await p.keyboard.press("Tab");
    },
    ready: ".ui-tooltip-wide .evidence-peek blockquote",
  },
  {
    id: "result-detail-peek-math",
    name: "算子 · 证据预览（公式与长取值）",
    route: (ids) =>
      `/?view=ext&result=${ids.result}&resultHash=${ids.resultHash}`,
    interaction: "键盘聚焦长取值，预览含公式的原文",
    prepare: async (p) => {
      // Columns: selection, source, method, missing, then the long note.
      const value = p
        .locator('[aria-label="提取结果"] tbody tr')
        .first()
        .locator("td")
        .nth(4)
        .locator(".ui-button")
        .first();
      await value.waitFor();
      await value.focus();
      await p.keyboard.press("Shift+Tab");
      await p.keyboard.press("Tab");
    },
    ready: ".ui-tooltip-wide .evidence-peek blockquote .katex",
  },
  {
    id: "snapshots",
    name: "快照 · 列表",
    route: route("snapshots"),
    ready: ".snapshot-list",
  },
  {
    id: "snapshot-detail",
    name: "快照 · 详情",
    route: (ids) => `/?view=snapshots&snapshot=${ids.snapshot}`,
    ready: ".snapshot-detail",
  },
  {
    id: "vocabulary",
    name: "标签词表",
    route: route("tags"),
    ready: '[aria-label="两层标签词表"]',
  },
  ...[true, false].map(
    (found): DesignSamplePage => ({
      id: found ? "retrieval-found" : "retrieval-empty",
      name: `全文检索 · ${found ? "有结果" : "无结果"}`,
      route: route("ask"),
      interaction: `检索 ${found ? "spectroscopy" : "nonexistentdesignword"}`,
      prepare: async (p) => {
        await p
          .getByLabel("问题或关键词", { exact: true })
          .fill(found ? "spectroscopy" : "nonexistentdesignword");
        await p
          .getByRole("main")
          .getByRole("button", { name: "检索", exact: true })
          .click();
        if (found) await p.locator(".retrieval-result").first().waitFor();
        else
          await p
            .getByText(/没有找到与/)
            .first()
            .waitFor();
      },
      ready: '[aria-label="检索结果"]',
    }),
  ),
  {
    id: "retrieval-results",
    name: "全文检索 · 算子结果",
    route: route("ask", "&results=all"),
    ready: ".result-pagination",
  },
  {
    id: "retrieval-text",
    name: "全文检索 · 全文命中",
    route: route("ask"),
    // Page specs “全文检索”: each text hit names its version's level.
    interaction: "检索“spectroscopy”",
    prepare: async (p) => {
      const box = p.locator('input[placeholder="输入要查找的问题或关键词"]');
      await box.fill("spectroscopy");
      // Search once the sample's index is current (its status line gone).
      await p
        .getByTestId("retrieval-index")
        .waitFor({ state: "hidden", timeout: 15_000 })
        .catch(() => undefined);
      await p
        .getByRole("main")
        .getByRole("button", { name: "检索", exact: true })
        .click();
    },
    ready: '[data-testid="retrieval-level"]',
  },
  {
    id: "insights",
    name: "洞察",
    route: route("ins"),
    ready: '[aria-label="洞察视图"]',
  },
  {
    id: "tasks",
    name: "任务 · 列表",
    route: route("task"),
    ready: ".task-table",
  },
  {
    id: "navigation-processing",
    name: "加工 · 一页四个标签页",
    route: route("ext"),
    ready: '[aria-label="加工视图"]',
  },
  {
    id: "task-detail",
    name: "任务 · 详情",
    route: (ids) => `/?view=task&task=${ids.task}`,
    ready: '[aria-label="任务详情"]',
  },
  {
    id: "task-detail-archive",
    name: "任务 · 解析全文的步骤",
    route: (ids) => `/?view=task&task=${ids.archiveTask}`,
    interaction: "滚到解析全文的步骤",
    prepare: async (p) => {
      await p.locator(".archive-run-steps").scrollIntoViewIfNeeded();
    },
    ready: ".archive-run-steps",
  },
  {
    id: "task-detail-pdf",
    name: "任务 · 获取 PDF 总结",
    route: (ids) => `/?view=task&task=${ids.pdfTask}`,
    ready: ".task-split",
  },
  {
    id: "task-detail-pdf-channels",
    name: "任务 · 获取 PDF 按渠道",
    route: (ids) => `/?view=task&task=${ids.pdfTask}`,
    interaction: "展开渠道表现",
    prepare: async (p) => {
      await p.getByRole("button", { name: "渠道表现", exact: true }).click();
    },
    ready: ".source-bars",
  },
  {
    id: "task-detail-pdf-table",
    name: "任务 · 获取 PDF 表格",
    route: (ids) => `/?view=task&task=${ids.pdfTask}`,
    interaction: "展开渠道表现并切到表格",
    prepare: async (p) => {
      await p.getByRole("button", { name: "渠道表现", exact: true }).click();
      await p.getByRole("tab", { name: "表格" }).first().click();
    },
    ready: ".source-results-table",
  },
  {
    id: "task-detail-metadata",
    name: "任务 · 主题发现按来源",
    route: (ids) => `/?view=task&task=${ids.metadataTask}`,
    ready: ".source-results-empty",
  },
  {
    id: "task-detail-metadata-running",
    name: "任务 · 主题发现进行中",
    route: (ids) => `/?view=task&task=${ids.metadataRunningTask}`,
    ready: ".source-running",
  },
  {
    id: "task-detail-citation-sources",
    name: "任务 · 引用扩展的来源冷却",
    route: (ids) => `/?view=task&task=${ids.metadataTask}`,
    interaction:
      "任务详情的“来源”一组：冷却中、等待重试、已停用、已恢复、冷却结束重试出错，并展开待补查（来源状态按合同样式模拟）",
    prepare: async (p, ids) => {
      const soon = new Date(Date.now() + 42 * 60_000).toISOString();
      const failure = (code: string) => ({
        code,
        reason: "Synthetic source failure.",
        action: "Retry later.",
        retryable: true,
      });
      const source = (
        name: string,
        status: string,
        retries: number,
        extra: object = {},
      ) => ({
        target_id: "sample-citation-target",
        run_id: "sample-citation-run",
        source: name,
        status,
        retries,
        next_retry_at: null,
        reason: failure("metadata-provider-rate-limited"),
        pending_count: 0,
        pending_sample: [],
        pending_truncated: false,
        ...extra,
      });
      await p.route(
        (url) => url.pathname === `/api/tasks/${ids.metadataTask}`,
        async (request) => {
          const response = await request.fetch();
          const value = await response.json();
          value.task.citation_source_cooldowns = [
            source("openalex", "cooling", 1, {
              next_retry_at: soon,
              pending_count: 37,
              // The service keeps a sample of 20.
              pending_sample: Array.from({ length: 20 }, (_, n) => {
                const literature_id = [
                  ids.literature,
                  ids.draft,
                  ids.metadataOnly,
                ][n % 3]!;
                return n % 3 === 1
                  ? {
                      literature_id,
                      purpose: "lookup",
                      relation_id: `sample-${n}`,
                    }
                  : { literature_id, purpose: "reference-query" };
              }),
              pending_truncated: true,
            }),
            source("semantic-scholar", "cooling", 0, {
              next_retry_at: new Date(Date.now() - 60_000).toISOString(),
            }),
            source("core", "disabled", 6),
            source("crossref", "recovered", 0, { reason: null }),
            source("opencitations", "retry-ended", 1, {
              reason: failure("metadata-provider-unavailable"),
            }),
          ];
          await request.fulfill({ response, json: value });
        },
      );
      await p.reload();
      await p
        .getByRole("button", { name: "待补查 37 项", exact: true })
        .click();
      // The sample's titles are read one by one.
      await p.waitForFunction(
        () =>
          !document
            .querySelector(".citation-source-sample")
            ?.textContent?.includes("正在读取标题…"),
      );
    },
    ready: ".citation-source-sample",
  },
  {
    id: "source-statistics",
    name: "任务 · 来源统计",
    route: route("stats"),
    ready: ".task-page .source-statistics",
  },
  {
    id: "agents",
    name: "任务 · Agent 会话",
    route: route("agent"),
    ready: ".task-page .agent-session-list",
  },
  {
    id: "agent-detail",
    name: "任务 · Agent 会话原样记录",
    route: (ids) => `/?view=agent&agentSession=${ids.agent}`,
    ready: '[aria-label="会话记录"]',
  },
  {
    id: "browser",
    name: "任务 · 浏览器（离线未启动）",
    route: route("web"),
    ready: ".task-page.browser-page .ui-tab-panel",
  },
  {
    id: "browser-sessions",
    name: "任务 · 浏览器会话分组",
    route: route("web"),
    interaction: "注入两个获取任务的合成会话",
    // No real browser runs in the sample library; only the session list in the
    // view is synthetic, so the card's look can be checked without network use.
    prepare: async (p, ids) => {
      await p.route(
        (url) => url.pathname === "/api/view",
        async (request) => {
          const response = await request.fetch();
          const view = (await response.json()) as Record<string, unknown>;
          await request.fulfill({
            response,
            json: {
              ...view,
              sessions: sampleSessions(ids.literature),
            },
          });
        },
      );
      // The sample server pushes its real (empty) view over the event stream;
      // mute those pushes so the synthetic list stays the only source.
      await p.addInitScript(() => {
        const add = EventSource.prototype.addEventListener;
        EventSource.prototype.addEventListener = function (
          this: EventSource,
          type: string,
          ...rest: unknown[]
        ) {
          if (type === "view") return;
          return (add as (...args: unknown[]) => void).call(
            this,
            type,
            ...rest,
          );
        } as typeof add;
      });
      await p.reload({ waitUntil: "domcontentloaded" });
      await p.locator(".browser-sessions .ui-card").first().waitFor();
      for (const trigger of await p
        .locator('[aria-label="已结束"] .ui-disclosure-trigger')
        .all())
        await trigger.click();
    },
    ready: ".browser-sessions .ui-card",
  },
  {
    id: "archive-issues",
    name: "任务 · 需处理",
    route: route("archive"),
    ready: '.task-page.archive-page [aria-label="需处理的问题列表"]',
  },
  ...[
    "外观",
    "模型服务",
    "获取 PDF",
    "解析全文",
    "设备连接",
    "网络",
    "文献库文件",
    "运行状态",
    "高级",
  ].map(
    (name, i): DesignSamplePage => ({
      id: `settings-${i + 1}`,
      name: `设置 · ${name}`,
      route: route("set"),
      interaction: `切换到${name}`,
      prepare: (p) => openSettings(p, name),
      ready:
        name === "获取 PDF"
          ? ".source-table"
          : name === "高级"
            ? ".maintenance-page"
            : ".settings-content .ui-section",
    }),
  ),
  {
    id: "settings-sources-expanded",
    name: "设置 · 文献来源 · 展开配置",
    route: route("set"),
    interaction: "在“获取 PDF”里展开缺联系邮箱的 Unpaywall",
    prepare: async (p) => {
      await openSettings(p, "获取 PDF");
      await p
        .locator(".source-row", { hasText: "Unpaywall" })
        .locator(".source-config-toggle")
        .click();
    },
    ready: ".source-editor",
  },
  {
    id: "settings-dirty",
    name: "设置 · 未保存改动",
    route: route("set"),
    interaction: "在解析全文分区输入一个新数值，不离开输入框",
    prepare: async (p) => {
      await openSettings(p, "解析全文");
      const field = p.getByRole("textbox", { name: "每篇标签上限" });
      await field.fill("12");
    },
    ready: '.settings-content .ui-button[data-variant="primary"]',
  },
  {
    id: "retrieval-unfolded",
    name: "全文检索 · 展开同一篇的其余命中",
    route: route("ask"),
    interaction: "检索“spectroscopy”，展开第一篇的其余命中",
    prepare: async (p) => {
      await searchSample(p, "spectroscopy");
      await p
        .getByRole("button", { name: /^展开另外 \d+ 条$/u })
        .first()
        .click();
    },
    ready: '[data-testid="retrieval-group"] .retrieval-more',
  },
  {
    id: "retrieval-context",
    name: "全文检索 · 选了片段后的上下文",
    route: route("ask"),
    interaction: "检索“spectroscopy”，把第一条命中加入上下文",
    prepare: async (p) => {
      await searchSample(p, "spectroscopy");
      await p.getByTestId("retrieval-basket").first().click();
    },
    ready: '[aria-label="上下文"]',
  },
  ...[false, true].map(
    (advanced): DesignSamplePage => ({
      id: advanced ? "acquire-dialog-advanced" : "acquire-dialog",
      name: `获取 PDF · 对话框${advanced ? "（高级选项展开）" : ""}`,
      // Papers with only a bibliography: the ones a PDF can still be got for.
      route: route(
        "lib",
        `&sort=title-asc&query=${query({ statuses: ["UNREVIEWED"] })}`,
      ),
      interaction: `在只有书目的文献里勾选前两行，点“获取 PDF”${advanced ? "，展开高级选项" : ""}`,
      prepare: async (p) => {
        const rows = p.locator(".paper-row");
        await rows.nth(1).waitFor();
        for (const n of [0, 1]) {
          await rows.nth(n).focus();
          await p.keyboard.press("Space");
        }
        await p
          .getByRole("region", { name: "文献选择" })
          .getByRole("button", { name: /^获取 PDF/u })
          .click();
        if (advanced)
          await p
            .getByRole("dialog")
            .getByRole("button", { name: "高级选项", exact: true })
            .click();
      },
      ready: advanced
        ? '[role="dialog"] .acquire-advanced'
        : '[role="dialog"] .acquire-scope',
    }),
  ),
  {
    id: "discovery-confirm",
    name: "找文献 · 确认发现文献",
    route: route("disc"),
    interaction: "填写主题后点“开始发现”",
    prepare: async (p) => {
      await p
        .getByRole("textbox", { name: "主题或检索式" })
        .fill("synthetic spectroscopy");
      await p.getByRole("button", { name: "开始发现", exact: true }).click();
    },
    ready: '[role="dialog"]',
  },
  {
    id: "invalid-address",
    name: "地址无效",
    route: () => "/?view=lib&reader=not-a-view",
    ready: ".page-not-found",
  },
  {
    id: "login",
    name: "登录",
    route: () => "/auth",
    anonymous: true,
    ready: 'input[type="password"]',
  },
  {
    id: "search",
    name: "快捷搜索",
    route: route("lib"),
    interaction: "Control+K 搜索",
    prepare: async (p) => {
      await p.locator(".paper-row").first().waitFor();
      await p.keyboard.press("Control+k");
    },
    ready: '[role="dialog"]',
  },
  {
    id: "components",
    name: "组件画廊",
    route: (_ids, gallery) => `/?view=${gallery ? "gallery" : "lab"}`,
    ready: ".gallery-page, .lab-page",
  },
];

export async function reachDesignSample(
  page: Page,
  origin: string,
  ids: DesignSampleIds,
  entry: DesignSamplePage,
  gallery = true,
) {
  await page.goto(origin + entry.route(ids, gallery), {
    waitUntil: "domcontentloaded",
  });
  await entry.prepare?.(page, ids);
  await page.locator(entry.ready).first().waitFor({ state: "visible" });
  // The component gallery deliberately exhibits skeletons as a finished example.
  if (entry.id !== "components")
    await page.waitForFunction(() => !document.querySelector(".ui-skeleton"));
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
