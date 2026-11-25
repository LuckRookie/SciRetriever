import { expect, it } from "vitest";
import type { Page } from "playwright";
import {
  libraryStatus,
  nextWorkspace,
  searchLibrary,
} from "./next-workspace-fixture.js";

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

it("opens every selected paper from the selection's menu and lets the selection go on a click in empty space (page specs “连续选择与选择栏”)", async () => {
  const w = await nextWorkspace();
  try {
    const p = w.page;
    await libraryStatus(p, "全部");
    const rows = p.locator(".paper-row");
    await expect.poll(() => rows.count()).toBeGreaterThan(1);
    const bar = p.getByRole("region", { name: "文献选择" });
    const select = async () => {
      for (const index of [0, 1]) {
        await rows.nth(index).focus();
        await p.keyboard.press("Space");
      }
      await bar.getByText("已选 2 篇").waitFor();
    };
    // A click on the page's empty space is “取消选择”; a click on a row is not.
    await select();
    await rows.nth(1).locator(".paper-citation").click();
    expect(await bar.count()).toBe(1);
    await p.locator(".library-quick").click({ position: { x: 2, y: 2 } });
    await bar.waitFor({ state: "detached" });

    // On a selected row the menu is the selection's: it opens them all.
    await select();
    const second = (await rows.nth(1).getAttribute("data-literature-id"))!;
    await rows.nth(1).locator(".paper-citation").click({ button: "right" });
    const labels = await p.getByRole("menuitem").allTextContents();
    expect(labels.slice(0, 5)).toEqual([
      "打开阅读 2 篇",
      "移动…",
      "导出…",
      "移出文献库 2…",
      "删除 2 篇…",
    ]);
    await p
      .getByRole("menuitem", { name: "打开阅读 2 篇", exact: true })
      .click();
    await expect.poll(() => p.locator(".paper-tab").count()).toBe(2);
    // The paper that was right-clicked is the one shown.
    expect(new URL(p.url()).searchParams.get("literature")).toBe(second);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("takes a paper out of the library to the candidates and adds it back from a search (ADR 0067 sections 4, 5 and 7)", async () => {
  const w = await nextWorkspace();
  try {
    const p = w.page;
    await libraryStatus(p, "全部");
    const rows = p.locator(".paper-row");
    await expect.poll(() => rows.count()).toBeGreaterThan(1);
    const total = await rows.count();
    const candidates = p.locator(".library-candidates");
    const before = (await candidates.count())
      ? Number((await candidates.textContent())!.replace(/\D/g, ""))
      : 0;

    // It is confirmed, and the dialog says what stays and what does not.
    const title = (await rows.first().getAttribute("aria-label"))!;
    const id = (await rows.first().getAttribute("data-literature-id"))!;
    await rows.first().locator(".paper-citation").click({ button: "right" });
    await p.getByRole("menuitem", { name: "移出文献库…", exact: true }).click();
    const confirm = p.getByRole("dialog", { name: "移出文献库", exact: true });
    expect(await confirm.textContent()).toContain(`《${title}》`);
    expect(await confirm.textContent()).toContain("回到候选");
    expect(await confirm.textContent()).toContain("文件夹不会恢复");
    await confirm.getByRole("button", { name: "移出", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    await expect
      .poll(() => p.locator(".ui-toast").textContent())
      .toContain("移出文献库");
    await expect.poll(() => rows.count()).toBe(total - 1);
    // The library says how many candidates stand behind it.
    await expect
      .poll(async () =>
        (await candidates.count())
          ? Number((await candidates.textContent())!.replace(/\D/g, ""))
          : 0,
      )
      .toBe(before + 1);

    // A search still finds it, as a candidate one press from the library.
    await searchLibrary(p, title.split(/\s+/).slice(0, 3).join(" "));
    const found = p.locator(`.paper-row[data-literature-id="${id}"]`);
    await found.waitFor();
    // A candidate is not moved into a folder: its menu adds it, and has no 移动.
    await found.locator(".paper-citation").click({ button: "right" });
    const labels = await p.getByRole("menuitem").allTextContents();
    expect(labels.slice(0, 2)).toEqual(["打开阅读", "加入文献库"]);
    expect(labels).not.toContain("移动…");
    await p.keyboard.press("Escape");
    // Chosen, the bar's one primary button adds it, and 移动 says why not.
    await found.focus();
    await p.keyboard.press("Space");
    const bar = p.getByRole("region", { name: "文献选择" });
    const add = bar.getByRole("button", { name: /^加入文献库/ });
    expect(await add.getAttribute("data-variant")).toBe("primary");
    expect(
      await bar.locator('.ui-button[data-variant="primary"]').count(),
    ).toBe(1);
    const move = bar.getByRole("button", { name: /^移动/ });
    expect(
      await move.evaluate((node) =>
        node.matches(":disabled,[aria-disabled=true],[data-disabled=true]"),
      ),
    ).toBe(true);
    await add.click();
    await expect.poll(() => found.textContent()).toContain("已加入");
    await expect.poll(() => add.count()).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);
