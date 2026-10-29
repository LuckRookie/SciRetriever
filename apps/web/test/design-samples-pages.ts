import type { Page } from "playwright";
import type { DesignSampleIds } from "./design-samples-fixture.js";

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
export const designSamplePages: readonly DesignSamplePage[] = [
  {
    id: "intake",
    name: "入库 · 发现与导入",
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
      await p
        .getByRole("button", { name: /^筛选/ })
        .filter({ visible: true })
        .click();
      await p.getByRole("menuitem", { name: "筛选条件…", exact: true }).click();
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
    name: "建档 · 发起前预计消耗",
    route: route("lib", "&sort=title-asc"),
    interaction: "依次勾选，直到选中两篇尚未建档的文献，点“建档”",
    prepare: async (p) => {
      const rows = p.locator(".paper-row");
      await rows.nth(1).waitFor();
      const build = p
        .getByRole("region", { name: "文献选择" })
        .getByRole("button", { name: /^建档 \d+$/ });
      for (let n = 0; n < 40; n++) {
        await rows.nth(n).focus();
        await p.keyboard.press("Space");
        if ((await build.textContent()) === "建档 2") break;
      }
      await build.click();
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
            .getByText(/当前没有可显示的片段/)
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
    id: "task-detail",
    name: "任务 · 详情",
    route: (ids) => `/?view=task&task=${ids.task}`,
    ready: '[aria-label="任务详情"]',
  },
  {
    id: "task-detail-archive",
    name: "任务 · 建档步骤",
    route: (ids) => `/?view=task&task=${ids.archiveTask}`,
    interaction: "滚到建档步骤",
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
    id: "source-statistics",
    name: "任务 · 来源统计",
    route: route("stats"),
    ready: ".source-statistics",
  },
  {
    id: "agents",
    name: "Agent · 会话列表",
    route: route("agent"),
    ready: ".agent-session-list",
  },
  {
    id: "agent-detail",
    name: "Agent · 原样记录",
    route: (ids) => `/?view=agent&agentSession=${ids.agent}`,
    ready: '[aria-label="会话记录"]',
  },
  {
    id: "browser",
    name: "浏览器 · 离线未启动",
    route: route("web"),
    ready: ".browser-workspace, .browser-workbench, .browser-page",
  },
  {
    id: "browser-sessions",
    name: "浏览器 · 会话分组",
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
    name: "建档问题",
    route: route("archive"),
    ready: '[aria-label="建档问题列表"]',
  },
  ...[
    "文献库位置",
    "文献来源",
    "模型",
    "解析与 Browser",
    "建档",
    "凭据",
    "运行状态",
    "外观",
    "高级",
  ].map(
    (name, i): DesignSamplePage => ({
      id: `settings-${i + 1}`,
      name: `设置 · ${name}`,
      route: route("set"),
      interaction: `切换到${name}`,
      prepare: (p) => openSettings(p, name),
      ready:
        name === "文献来源"
          ? ".source-table"
          : ".settings-content .ui-section, .maintenance-page",
    }),
  ),
  {
    id: "settings-sources-expanded",
    name: "设置 · 文献来源 · 展开配置",
    route: route("set"),
    interaction: "展开缺联系邮箱的 Unpaywall",
    prepare: async (p) => {
      await openSettings(p, "文献来源");
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
    interaction: "在建档分区输入一个新数值，不离开输入框",
    prepare: async (p) => {
      await openSettings(p, "建档");
      const field = p.getByRole("textbox", { name: "每篇标签上限" });
      await field.fill("12");
    },
    ready: '.settings-content .ui-button[data-variant="primary"]',
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
