import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";

/** A task as the active list gives it: saved, or actually running. */
const task = (n: number, status: "queued" | "running") => ({
  job_id: `00000000-0000-4000-8000-00000000000${n}`,
  status,
  selector: {
    goal: "pdf",
    selector: {
      kind: "literatures",
      literature_ids: ["00000000-0000-0000-0000-000000000001"],
    },
  },
  created_at: "2026-11-18T00:00:00.000Z",
});

it("counts only running tasks beside “任务” and in “活动 · n”; queued ones stay listed as 等待执行 (page specs “任务”)", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    // Three saved and never started: queued, nothing running.
    let active = [1, 2, 3].map((n) => task(n, "queued"));
    await page.route("**/api/tasks?*", (route) =>
      new URL(route.request().url()).searchParams.get("status_group") ===
      "active"
        ? route.fulfill({ json: { tasks: active, next_cursor: null } })
        : route.continue(),
    );
    const served = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/tasks" &&
        new URL(r.url()).searchParams.get("status_group") === "active",
    );
    await page.reload();
    await served;
    const tasks = page
      .getByRole("complementary", { name: "主导航" })
      .getByRole("button", { name: /^任务/u });
    const activity = page.getByRole("button", { name: /^活动/u });
    await activity.waitFor();
    // Wait a refresh past the first answer, so the numbers had their chance.
    await page.waitForResponse(
      (r) => new URL(r.url()).searchParams.get("status_group") === "active",
    );
    expect(await tasks.textContent()).toBe("任务");
    expect(await activity.textContent()).toBe("活动");
    // The panel lists them all the same, each as 等待执行.
    await activity.click();
    const panel = page.getByRole("dialog", { name: "活动" });
    const listed = panel.locator("[data-task-id]");
    await expect.poll(() => listed.count()).toBe(3);
    expect(await panel.getByText("等待执行").count()).toBe(3);
    await panel.getByRole("button", { name: "关闭抽屉" }).click();
    // One starts: one in progress, two still waiting.
    active = [task(1, "running"), task(2, "queued"), task(3, "queued")];
    await expect
      .poll(() => tasks.textContent(), { timeout: 15_000 })
      .toBe("任务1 进行中");
    expect(await activity.textContent()).toBe("活动 · 1");
    await activity.click();
    await expect.poll(() => listed.count()).toBe(3);
    await expect.poll(() => panel.getByText("等待执行").count()).toBe(2);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
