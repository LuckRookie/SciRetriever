import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";

/** A task as the active list gives it: saved, or actually running. */
const task = (
  n: number,
  status: "queued" | "running",
  start_requested = false,
) => ({
  job_id: `00000000-0000-4000-8000-00000000000${n}`,
  status,
  start_requested,
  selector: {
    goal: "pdf",
    selector: {
      kind: "literatures",
      literature_ids: ["00000000-0000-0000-0000-000000000001"],
    },
  },
  created_at: "2026-11-18T00:00:00.000Z",
});

it("counts only running tasks beside “任务”, with no “活动” panel; queued ones stay listed on the task page as 未启动 or 排队中 (page specs “任务”)", async () => {
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
    await tasks.waitFor();
    // Wait a refresh past the first answer, so the numbers had their chance.
    await page.waitForResponse(
      (r) => new URL(r.url()).searchParams.get("status_group") === "active",
    );
    expect(await tasks.textContent()).toBe("任务");
    // The background is the sidebar's number and the task page; no “活动”.
    expect(await page.getByRole("button", { name: /^活动/u }).count()).toBe(0);
    // The task page's “进行中” lists them all the same, each as 未启动:
    // nobody asked them to start.
    await tasks.click();
    await page
      .locator(".tasks-page, .task-page")
      .getByRole("button", { name: /^进行中/u })
      .click();
    const listed = page.locator("[data-task-id]");
    await expect.poll(() => listed.count()).toBe(3);
    expect(await listed.getByText("未启动", { exact: true }).count()).toBe(3);
    // One starts, one is asked to start and waits its turn (排队中), one stays 未启动.
    active = [task(1, "running"), task(2, "queued", true), task(3, "queued")];
    await expect
      .poll(() => tasks.textContent(), { timeout: 15_000 })
      .toBe("任务1 进行中");
    await expect
      .poll(() => listed.getByText("排队中", { exact: true }).count(), {
        timeout: 15_000,
      })
      .toBe(1);
    expect(await listed.count()).toBe(3);
    expect(await listed.getByText("未启动", { exact: true }).count()).toBe(1);
    expect(await listed.getByText("进行中", { exact: true }).count()).toBe(1);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("titles 任务 and Agent 会话 with the running tasks only, not the queued ones", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    let active = [1, 2, 3].map((n) => task(n, "queued"));
    await page.route("**/api/tasks?*", (route) =>
      new URL(route.request().url()).searchParams.get("status_group") ===
      "active"
        ? route.fulfill({ json: { tasks: active, next_cursor: null } })
        : route.continue(),
    );
    const answered = () =>
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/api/tasks" &&
          new URL(r.url()).searchParams.get("status_group") === "active",
      );
    const count = page.locator(".ui-page-header .ui-page-count");
    for (const view of ["task", "agent"]) {
      active = [1, 2, 3].map((n) => task(n, "queued"));
      const served = answered();
      await page.goto(`${w.origin}/?view=${view}`);
      await served;
      await page.getByRole("heading", { level: 1, name: "任务" }).waitFor();
      // A refresh past the first answer, so the title had its chance.
      await answered();
      expect(await count.count()).toBe(0);
      // A queued task asked to start (排队中) is not in progress either.
      active = [task(1, "running"), task(2, "queued", true), task(3, "queued")];
      await expect
        .poll(() => count.textContent(), { timeout: 15_000 })
        .toBe("1 个进行中");
    }
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
