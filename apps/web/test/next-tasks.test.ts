import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";

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
    await w.page.getByRole("tab", { name: "进行中" }).click();
    await expect
      .poll(() =>
        w.page
          .getByRole("status")
          .filter({ hasText: "已显示 1 个任务" })
          .count(),
      )
      .toBe(1);
    await w.page.getByRole("searchbox", { name: "筛选任务" }).fill(activeId);
    await w.page
      .getByRole("button", { name: "获取 PDF · 1 篇指定文献", exact: true })
      .click();
    const drawer = w.page.getByRole("dialog", { name: "任务详情" });
    await drawer.getByRole("button", { name: "暂停", exact: true }).click();
    await expect
      .poll(async () => (await w.env.app.jobs!.getJob(activeId))?.status)
      .toBe("paused");
    await drawer.getByRole("button", { name: "继续", exact: true }).waitFor();
    await drawer.getByRole("button", { name: "取消任务", exact: true }).click();
    expect((await w.env.app.jobs!.getJob(activeId))?.status).toBe("paused");
    await w.page
      .getByRole("dialog", { name: "取消这个任务？" })
      .getByRole("button", { name: "取消任务", exact: true })
      .click();
    await expect
      .poll(async () => (await w.env.app.jobs!.getJob(activeId))?.status)
      .toBe("cancelled");
    await expect
      .poll(() => drawer.getByText("已取消", { exact: true }).count())
      .toBeGreaterThan(0);
    await w.page.reload();
    await w.page
      .getByRole("dialog", { name: "任务详情" })
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
