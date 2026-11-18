import { expect, it } from "vitest";
import type { Page } from "playwright";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { shortTime } from "../src/app/strings.js";
import { taskActions, taskStateLabel } from "../src/app/data/tasks.js";

it("keeps active tasks discoverable beyond a full history page and confirms cancellation without starting external work", async () => {
  let activeId = "";
  const w = await nextWorkspace({
    path: "/?view=task",
    ready: ".tasks-page",
    setup: async (env) => {
      const create = (key: string) =>
        env.app.jobService!.create({
          target_kind: "selector",
          goal: "pdf",
          selector: {
            kind: "literatures",
            literature_ids: [env.parseRequest.literature_id],
          },
          policy_version: "react-history-fixture",
          policy: { mode: "never", max_retries: 0 },
          idempotency_key: key,
        });
      activeId = (await create("old-active-react-task")).job_id;
      for (let index = 0; index < 102; index++)
        await env.app.queue!.cancel(
          (await create(`ended-react-task-${index}`)).job_id,
        );
    },
  });
  try {
    await w.page.getByRole("button", { name: "加载更多任务" }).waitFor();
    expect(w.env.modelCalls).toBe(0);
    await w.page.getByRole("button", { name: "加载更多任务" }).click();
    await expect
      .poll(() =>
        w.page
          .getByRole("status")
          .filter({ hasText: "已显示 103 个任务" })
          .count(),
      )
      .toBe(1);
    await w.page.getByRole("button", { name: "进行中", exact: true }).click();
    await expect
      .poll(() =>
        w.page
          .getByRole("status")
          .filter({ hasText: "已显示 1 个任务" })
          .count(),
      )
      .toBe(1);
    await w.page.getByRole("searchbox", { name: "筛选任务" }).fill(activeId);
    // One paper: the task is named after it (page specs “任务与 Agent 会话”).
    await w.page
      .locator(`[data-task-id="${activeId}"] .task-open`)
      .filter({ hasText: /^获取 PDF · (?!1 篇)/u })
      .click();
    const drawer = w.page.getByRole("region", { name: "任务详情" });
    // Saved, never asked to start: 未启动 offers 启动 and 取消任务 only.
    await drawer.getByText("未启动", { exact: true }).first().waitFor();
    expect(
      await drawer
        .locator(".task-actions")
        .first()
        .getByRole("button")
        .allTextContents(),
    ).toEqual(["启动", "取消任务"]);
    // Asked to start, it waits its turn as 排队中 and can be paused.
    await w.env.app.jobs!.requestStart(activeId);
    await drawer
      .getByText("排队中", { exact: true })
      .first()
      .waitFor({ timeout: 20_000 });
    await drawer.getByRole("button", { name: "暂停", exact: true }).click();
    // Background work started here can outlast the 1 s poll default under Full load.
    await expect
      .poll(async () => (await w.env.app.jobs!.getJob(activeId))?.status, {
        timeout: 20_000,
      })
      .toBe("paused");
    await drawer.getByRole("button", { name: "继续", exact: true }).waitFor();
    await drawer.getByText("等你处理", { exact: true }).first().waitFor();
    await drawer.getByRole("button", { name: "取消任务", exact: true }).click();
    expect((await w.env.app.jobs!.getJob(activeId))?.status).toBe("paused");
    await w.page
      .getByRole("dialog", { name: "取消这个任务？" })
      .getByRole("button", { name: "取消任务", exact: true })
      .click();
    // Background work started here can outlast the 1 s poll default under Full load.
    await expect
      .poll(async () => (await w.env.app.jobs!.getJob(activeId))?.status, {
        timeout: 20_000,
      })
      .toBe("cancelled");
    await expect
      .poll(() => drawer.getByText("已取消", { exact: true }).count())
      .toBeGreaterThan(0);
    await w.page.reload();
    await w.page
      .getByRole("region", { name: "任务详情" })
      .getByText("已取消", { exact: true })
      .first()
      .waitFor();
    expect(new URL(w.page.url()).searchParams.get("task")).toBe(activeId);
    expect(w.env.modelCalls).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("words each task state and offers only the controls it can use (page specs “界面用词”, plan 25 block 31)", () => {
  const cases: [string, boolean, string, string[]][] = [
    ["queued", false, "未启动", ["start", "cancel"]],
    ["queued", true, "排队中", ["pause", "cancel"]],
    ["running", true, "进行中", ["pause", "cancel"]],
    ["running", false, "进行中", ["pause", "cancel"]],
    ["paused", true, "等你处理", ["resume", "cancel"]],
    ["interrupted", false, "已中断", ["resume", "cancel"]],
    ["failed", false, "失败", ["retry"]],
    ["completed", true, "已完成", []],
    ["cancelled", false, "已取消", []],
  ];
  for (const [status, start_requested, label, actions] of cases) {
    expect(taskStateLabel({ status, start_requested })).toBe(label);
    expect(taskActions({ status, start_requested })).toEqual(actions);
  }
  // An older server leaves the field out: a queued task reads 未启动.
  expect(taskStateLabel({ status: "queued" })).toBe("未启动");
  // A finished task with skipped failures can be retried.
  expect(taskActions({ status: "completed" }, true)).toEqual(["retry"]);
});

it("writes a time by design core rule 6: today the clock, this year the day, earlier the date", () => {
  const now = new Date(2026, 10, 19, 18, 5);
  expect(shortTime(new Date(2026, 10, 19, 14, 28), now)).toBe("14:28");
  expect(shortTime(new Date(2026, 10, 19, 9, 3), now)).toBe("09:03");
  expect(shortTime(new Date(2026, 0, 2, 14, 28), now)).toBe("1月2日 14:28");
  expect(shortTime(new Date(2026, 10, 18, 23, 59), now)).toBe("11月18日 23:59");
  expect(shortTime(new Date(2025, 10, 19, 14, 28), now)).toBe("2025年11月19日");
  expect(shortTime("not a time", now)).toBe("时间未知");
});

/** A task as the list gives it; `papers` literature ids name what it works on. */
const listed = (
  n: number,
  status: string,
  papers: readonly string[],
  extra: Record<string, unknown> = {},
) => ({
  job_id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
  status,
  start_requested: false,
  actor_label: "网页登录",
  selector: {
    goal: "pdf",
    selector: { kind: "literatures", literature_ids: papers },
  },
  progress: { done: 0, total: papers.length },
  created_at: new Date().toISOString(),
  ...extra,
});
const others = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => `00000000-0000-4000-8000-00000000a${String(i).padStart(3, "0")}`,
  );

it("lists each state's word, names tasks after their paper or count, draws progress only for more than one item and hides a uniform 发起方", async () => {
  let paper = "";
  const w = await nextWorkspace({
    path: "/?view=task",
    ready: ".tasks-page",
    setup: async (env) => {
      paper = env.parseRequest.literature_id;
    },
  });
  try {
    const page = w.page;
    const ten = others(10);
    let tasks = [
      listed(1, "queued", [paper]),
      listed(2, "queued", ten, { start_requested: true }),
      listed(3, "running", ten, { progress: { done: 3, total: 10 } }),
      listed(4, "paused", ten),
      listed(5, "interrupted", ten),
      listed(6, "failed", ten),
      listed(7, "completed", ten, { progress: { done: 10, total: 10 } }),
      listed(8, "cancelled", ten),
    ];
    await page.route("**/api/tasks?*", (route) =>
      route.fulfill({ json: { tasks, next_cursor: null } }),
    );
    await page.reload();
    const row = (n: number) =>
      page.locator(`.task-table [data-task-id="${listed(n, "", []).job_id}"]`);
    await row(1).waitFor();
    const words = [
      "未启动",
      "排队中",
      "进行中",
      "等你处理",
      "已中断",
      "失败",
      "已完成",
      "已取消",
    ];
    for (const [index, word] of words.entries())
      expect(
        await row(index + 1)
          .locator(".ui-badge")
          .textContent(),
      ).toBe(word);
    // One paper: its title once read; several: how many.
    await expect
      .poll(() => row(1).locator(".task-open").textContent())
      .toMatch(/^获取 PDF · (?!1 篇)./u);
    expect(await row(2).locator(".task-open").textContent()).toBe(
      "获取 PDF · 10 篇",
    );
    // A one-item task has no progress bar; ten items have one.
    expect(await row(1).locator(".task-progress-track").count()).toBe(0);
    expect(await row(3).locator(".task-progress-track").count()).toBe(1);
    expect(await row(3).textContent()).toContain("3/10");
    // Everyone was started from the same place: no 发起方 column.
    const headers = () =>
      page.locator(".task-table thead th").allTextContents();
    expect(await headers()).toEqual(["任务", "进度", "状态", "开始"]);
    // The start time is today's clock, the full time on hover.
    const time = row(1).locator("time");
    expect(await time.textContent()).toMatch(/^\d{2}:\d{2}$/u);
    expect(await time.getAttribute("title")).toMatch(/\d{4}/u);
    // Two places: the column comes back.
    tasks = [
      ...tasks.slice(0, 7),
      listed(8, "cancelled", ten, { actor_label: "命令行" }),
    ];
    await page.getByRole("button", { name: "刷新任务", exact: true }).click();
    await expect
      .poll(headers)
      .toEqual(["任务", "发起方", "进度", "状态", "开始"]);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

/** Serve the detail as first read until `thaw`, so the panel goes stale. */
async function freezeDetail(page: Page, id: string) {
  let frozen: string | null = null,
    on = true;
  await page.route(`**/api/tasks/${id}`, async (route) => {
    if (route.request().method() !== "GET" || !on) return route.fallback();
    if (frozen === null) frozen = await (await route.fetch()).text();
    return route.fulfill({
      body: frozen,
      contentType: "application/json",
    });
  });
  return {
    thaw: async () => {
      on = false;
      await page.unroute(`**/api/tasks/${id}`);
    },
  };
}

it("says why a control was refused (processing-terminal, processing-resume-required) and reads the task again", async () => {
  let id = "";
  const w = await nextWorkspace({
    path: "/?view=task",
    ready: ".tasks-page",
    setup: async (env) => {
      id = (
        await env.app.jobService!.create({
          target_kind: "selector",
          goal: "pdf",
          selector: {
            kind: "literatures",
            literature_ids: [env.parseRequest.literature_id],
          },
          policy_version: "react-conflict-fixture",
          policy: { mode: "never", max_retries: 0 },
          idempotency_key: "react-conflict-task",
        })
      ).job_id;
    },
  });
  try {
    const page = w.page;
    const drawer = page.getByRole("region", { name: "任务详情" });
    const actions = () =>
      drawer.locator(".task-actions").first().getByRole("button");
    // The panel still shows 未启动 while the task was paused elsewhere.
    let freeze = await freezeDetail(page, id);
    await page.goto(`${w.origin}/?view=task&task=${id}`);
    await drawer.getByText("未启动", { exact: true }).first().waitFor();
    // Nobody started it: no time has been used.
    expect(await drawer.locator(".task-summary-time").textContent()).toMatch(
      /^未启动/u,
    );
    await w.env.app.queue!.pause(id);
    await freeze.thaw();
    await drawer.getByRole("button", { name: "启动", exact: true }).click();
    await drawer
      .getByRole("status")
      .filter({ hasText: "这个任务要用“继续”恢复" })
      .waitFor();
    await drawer.getByText("等你处理", { exact: true }).first().waitFor();
    expect(await actions().allTextContents()).toEqual(["继续", "取消任务"]);
    // Then it ended elsewhere while the panel still offers 取消任务.
    freeze = await freezeDetail(page, id);
    await page.reload();
    await drawer.getByText("等你处理", { exact: true }).first().waitFor();
    await w.env.app.queue!.cancel(id);
    await freeze.thaw();
    await drawer.getByRole("button", { name: "取消任务", exact: true }).click();
    await page
      .getByRole("dialog", { name: "取消这个任务？" })
      .getByRole("button", { name: "取消任务", exact: true })
      .click();
    await drawer
      .getByRole("status")
      .filter({ hasText: "这个任务已经结束" })
      .waitFor();
    await drawer.getByText("已取消", { exact: true }).first().waitFor();
    expect(await actions().count()).toBe(0);
    expect(w.env.modelCalls).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
