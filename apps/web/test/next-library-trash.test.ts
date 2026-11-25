import { expect, it } from "vitest";
import type { Page } from "playwright";
import { libraryStatus, nextWorkspace } from "./next-workspace-fixture.js";

const trashEntry = (page: Page) =>
  page
    .getByRole("group", { name: "文献文件夹", exact: true })
    .getByRole("button", { name: /^最近删除/ });

it("deletes a paper to 最近删除 with an undo, confirms several, and restores from the list (page specs “文献库”)", async () => {
  const w = await nextWorkspace();
  try {
    const p = w.page;
    await libraryStatus(p, "全部");
    const rows = p.locator(".paper-row");
    await expect.poll(() => rows.count()).toBeGreaterThan(1);
    const total = await rows.count();
    // An untouched library shows no bin.
    expect(await trashEntry(p).count()).toBe(0);

    // One paper goes at once from its menu; the notice carries the undo.
    const first = (await rows.first().getAttribute("aria-label"))!;
    await rows.first().locator(".paper-citation").click({ button: "right" });
    await p.getByRole("menuitem", { name: "删除", exact: true }).click();
    const toast = p.locator(".ui-toast");
    await expect
      .poll(() => toast.textContent())
      .toContain(`已删除《${first}》`);
    await expect.poll(() => rows.count()).toBe(total - 1);
    await expect.poll(() => trashEntry(p).textContent()).toContain("1");
    await toast.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(() => rows.count()).toBe(total);
    await expect.poll(() => trashEntry(p).count()).toBe(0);

    // Several are confirmed first, and the dialog says nothing is erased.
    for (const index of [0, 1]) {
      await rows.nth(index).focus();
      await p.keyboard.press("Space");
    }
    const bar = p.getByRole("region", { name: "文献选择" });
    await bar.getByRole("button", { name: "更多", exact: true }).click();
    await p.getByRole("menuitem", { name: "删除 2 篇…", exact: true }).click();
    const confirm = p.getByRole("dialog", { name: "删除文献", exact: true });
    expect(await confirm.textContent()).toContain("已选的 2 篇文献");
    expect(await confirm.textContent()).toContain("都保留");
    await confirm.getByRole("button", { name: "删除", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    await expect.poll(() => rows.count()).toBe(total - 2);
    await bar.waitFor({ state: "detached" });

    // 最近删除 lists them; restoring one brings it back to the library.
    await expect.poll(() => trashEntry(p).textContent()).toContain("2");
    await trashEntry(p).click();
    const bin = p.getByRole("dialog", { name: "最近删除", exact: true });
    await expect.poll(() => bin.locator(".trash-list > li").count()).toBe(2);
    await bin
      .locator(".trash-list > li")
      .first()
      .getByRole("button", { name: /^恢复/ })
      .click();
    await expect.poll(() => bin.locator(".trash-list > li").count()).toBe(1);
    await bin.getByRole("button", { name: "关闭对话框", exact: true }).click();
    await bin.waitFor({ state: "detached" });
    await expect.poll(() => rows.count()).toBe(total - 1);
    await expect.poll(() => trashEntry(p).textContent()).toContain("1");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);
