import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { parseFoldersExportFile } from "@sciretriever/contracts";
import { readerNavigation, readerPanel } from "./reader-controls.js";
import { expect, it } from "vitest";
import type { Page } from "playwright";
import {
  libraryStatus,
  nextWorkspace,
  statusFilterName,
} from "./next-workspace-fixture.js";

const folders = (page: Page) =>
  page.getByRole("group", { name: "文献文件夹", exact: true });
const folderRow = (page: Page, name: string) =>
  folders(page)
    .locator(".folder-row")
    .filter({ has: page.getByRole("button", { name: new RegExp(`^${name}`) }) })
    .first();
async function createFolder(page: Page, name: string) {
  const dialog = page.getByRole("dialog", { name: "新建文件夹", exact: true });
  await dialog
    .getByRole("textbox", { name: "文件夹名称", exact: true })
    .fill(name);
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}

it("organizes papers into nested folders by dialog and drag, scopes the library, and records recent reading", async () => {
  const w = await nextWorkspace();
  try {
    const p = w.page;
    await libraryStatus(p, "全部");
    const rows = p.locator(".paper-row");
    await expect.poll(() => rows.count()).toBeGreaterThan(1);
    // Quick filters show counts that ignore the status filter itself.
    await expect
      .poll(() =>
        p
          .locator(".library-status-filters")
          .getByRole("button", { name: statusFilterName("全部") })
          .textContent(),
      )
      .toMatch(/全部 \d+/);

    await folders(p).getByRole("button", { name: "新建文件夹" }).click();
    await createFolder(p, "表面界面");
    await folderRow(p, "表面界面")
      .getByRole("button", { name: "文件夹操作：表面界面", exact: true })
      .click();
    await p
      .getByRole("menuitem", { name: "新建子文件夹…", exact: true })
      .click();
    await createFolder(p, "碳链");
    await folders(p).getByRole("button", { name: /^碳链/ }).waitFor();

    // Selection bar: add the first paper through the dialog.
    const first = (await rows.first().getAttribute("aria-label"))!;
    const firstId = (await rows.first().getAttribute("data-literature-id"))!;
    await rows.first().focus();
    await p.keyboard.press("Space");
    await p
      .getByRole("region", { name: "文献选择" })
      .getByRole("button", { name: "加入文件夹…", exact: true })
      .click();
    const add = p.getByRole("dialog", { name: "加入文件夹", exact: true });
    await add
      .getByRole("button", { name: /文件夹/ })
      .and(p.locator('[aria-haspopup="listbox"]'))
      .click();
    await p.getByRole("option", { name: "表面界面", exact: true }).click();
    await add.getByRole("button", { name: "加入", exact: true }).click();
    await add.waitFor({ state: "detached" });
    await p
      .getByRole("region", { name: "文献选择" })
      .getByRole("button", { name: "取消选择", exact: true })
      .click();

    // Marquee: pressing an unselected row and moving selects the rows crossed
    // without opening the paper the press started on.
    const title = (n: number) => rows.nth(n).locator(".paper-title");
    const from = (await title(0).boundingBox())!,
      to = (await title(1).boundingBox())!;
    await p.mouse.move(from.x + 20, from.y + from.height / 2);
    await p.mouse.down();
    await p.mouse.move(from.x + 30, to.y + to.height / 2, { steps: 8 });
    await p.mouse.up();
    const selection = p.getByRole("region", { name: "文献选择" });
    await expect
      .poll(() => selection.locator("b").textContent())
      .toBe("已选 2 篇");
    expect(await p.locator(".paper-tab").count()).toBe(0);
    await selection
      .getByRole("button", { name: "取消选择", exact: true })
      .click();

    // Drag: select the second paper, then drag it onto the nested folder.
    const second = (await rows.nth(1).getAttribute("aria-label"))!;
    const secondId = (await rows.nth(1).getAttribute("data-literature-id"))!;
    await rows.nth(1).focus();
    await p.keyboard.press("Space");
    const toast = p.locator(".ui-toast");
    await toast
      .getByRole("button", { name: "关闭提示" })
      .click()
      .catch(() => undefined);
    await rows.nth(1).dragTo(folderRow(p, "碳链"));
    await expect.poll(() => folderRow(p, "碳链").textContent()).toContain("1");
    await expect
      .poll(() => toast.textContent())
      .toContain("已加入「碳链」：新增 1 篇");
    // Undo removes exactly what the drop added; then drop it again.
    await toast.getByRole("button", { name: "撤销" }).click();
    await expect.poll(() => folderRow(p, "碳链").textContent()).toBe("碳链0");
    await rows.nth(1).dragTo(folderRow(p, "碳链"));
    await expect.poll(() => folderRow(p, "碳链").textContent()).toContain("1");
    await selection
      .getByRole("button", { name: "取消选择", exact: true })
      .click();
    await expect
      .poll(() => folderRow(p, "表面界面").textContent())
      .toContain("2");

    // “导出分组” (user organization 9.5): the service writes the whole tree
    // and its members; the page only starts the download and writes nothing.
    const sent: string[] = [];
    const watch = (request: { url(): string; method(): string }) =>
      sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
    const catalog = new DatabaseSync(join(w.env.home, "catalog.sqlite"), {
      readOnly: true,
    });
    const committed = () =>
      catalog.prepare("PRAGMA data_version").get()!.data_version;
    try {
      const version = committed();
      p.on("request", watch);
      const downloading = p.waitForEvent("download");
      await folders(p)
        .getByRole("button", { name: "文件夹一组的操作", exact: true })
        .click();
      await p.getByRole("menuitem", { name: "导出分组", exact: true }).click();
      const file = await downloading;
      p.off("request", watch);
      expect(file.suggestedFilename()).toBe("sciretriever-folders.json");
      const exported = parseFoldersExportFile(
        JSON.parse(await readFile((await file.path())!, "utf8")),
      );
      const surface = exported.folders.find((f) => f.name === "表面界面")!,
        carbon = exported.folders.find((f) => f.name === "碳链")!;
      expect(exported.folders).toHaveLength(2);
      expect(carbon.parent_id).toBe(surface.folder_id);
      // Members under their own folder: the first paper here, the second in
      // the subfolder.
      expect(surface.members.map((m) => m.literature_id)).toEqual([firstId]);
      expect(carbon.members.map((m) => m.literature_id)).toEqual([secondId]);
      expect(
        sent.filter((r) => r.startsWith("POST /api/v1/query/folders-export")),
      ).toHaveLength(1);
      expect(sent.filter((r) => r.includes("/api/v1/maintenance/"))).toEqual(
        [],
      );
      expect(committed()).toBe(version);
    } finally {
      p.off("request", watch);
      catalog.close();
    }
    // A failed export says so, and nothing is saved.
    await p.route(
      (url) => url.pathname === "/api/v1/query/folders-export",
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            protocol_version: 1,
            code: "query-unavailable",
          }),
        }),
      { times: 1 },
    );
    let saved = 0;
    const count = () => saved++;
    p.on("download", count);
    await folders(p)
      .getByRole("button", { name: "文件夹一组的操作", exact: true })
      .click();
    await p.getByRole("menuitem", { name: "导出分组", exact: true }).click();
    await toast.filter({ hasText: "没有导出分组。" }).waitFor();
    p.off("download", count);
    expect(saved).toBe(0);
    // A parent folder includes its subfolders unless "only this level" is on.
    await folders(p)
      .getByRole("button", { name: /^表面界面/ })
      .click();
    await p.getByRole("heading", { name: "表面界面", exact: true }).waitFor();
    await expect.poll(() => rows.count()).toBe(2);
    await p.locator(".library-quick").getByText("只看本层").click();
    await expect.poll(() => rows.count()).toBe(1);
    expect(await rows.first().getAttribute("aria-label")).toBe(first);

    // Remove from the current folder through the selection menu.
    await rows.first().focus();
    await p.keyboard.press("Space");
    await p
      .getByRole("region", { name: "文献选择" })
      .getByRole("button", { name: "更多", exact: true })
      .click();
    await p
      .getByRole("menuitem", { name: "移出「表面界面」", exact: true })
      .click();
    await expect.poll(() => rows.count()).toBe(0);

    // Opening a paper is recorded server-side for "recently read".
    await folders(p).getByRole("button", { name: /^碳链/ }).click();
    await p
      .getByRole("heading", { name: "表面界面 / 碳链", exact: true })
      .waitFor();
    await rows.first().locator(".paper-open").dblclick();
    await readerPanel(p);
    // The reader page's navigation is in its drawer (reading-experience 1.3).
    await readerNavigation(p);
    await folders(p)
      .getByRole("button", { name: /^最近读过/ })
      .click();
    await p.getByRole("heading", { name: "最近读过", exact: true }).waitFor();
    await expect.poll(() => rows.count()).toBe(1);
    expect(await rows.first().getAttribute("aria-label")).toBe(second);
    // Its own order, the last opened first, without one in the address.
    expect(new URL(p.url()).searchParams.get("sort")).toBeNull();
    expect(
      await p
        .getByRole("button", { name: /排序/u })
        .and(p.locator('[aria-haspopup="listbox"]'))
        .textContent(),
    ).toBe("排序：最近读过");

    // Deleting a folder previews the impact and only removes memberships.
    // A right-click on the row opens the same menu as its “⋯” button.
    await folderRow(p, "表面界面").click({ button: "right" });
    await p.getByRole("menuitem", { name: "删除文件夹…", exact: true }).click();
    const remove = p.getByRole("dialog", { name: "删除文件夹", exact: true });
    await expect
      .poll(() => remove.textContent())
      .toContain("及其 1 个子文件夹");
    expect(await remove.textContent()).toContain("文献本身不会删除");
    await remove
      .getByRole("button", { name: "删除文件夹", exact: true })
      .click();
    await expect.poll(() => folders(p).locator(".folder-row").count()).toBe(0);
    await p
      .getByLabel("主导航", { exact: true })
      .getByRole("button", { name: /^文献库/ })
      .click();
    await p.getByRole("heading", { name: "文献库", exact: true }).waitFor();
    await expect.poll(() => rows.count()).toBeGreaterThan(1);
  } finally {
    await w.close();
  }
}, 90000);
