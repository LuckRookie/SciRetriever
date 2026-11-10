import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";

it("hands a connection code over once, shows the device once it pairs, and renames and revokes it", async () => {
  const w = await nextWorkspace({
    path: "/?view=set",
    ready: ".settings-content",
  });
  try {
    const page = w.page;
    await page.getByRole("tab", { name: "设备连接", exact: true }).click();
    await page.getByRole("button", { name: "连接 Agent", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "连接 Agent" });
    const purpose = (name: string) =>
      dialog.getByRole("checkbox", { name, exact: true });
    // Operate can start networked, paid tasks and is never preselected.
    expect(await purpose("导入").isChecked()).toBe(true);
    expect(await purpose("读取").isChecked()).toBe(true);
    expect(await purpose("收藏").isChecked()).toBe(false);
    expect(await purpose("操作").isChecked()).toBe(false);
    await dialog.getByRole("textbox", { name: "名称" }).fill("办公室笔记本");
    await dialog
      .getByRole("button", { name: "生成连接码", exact: true })
      .click();
    const code = (await dialog
      .locator(".settings-device-code code")
      .textContent())!;
    expect(code).toMatch(/^sr-connect1:/u);
    expect(decodeURIComponent(code.split(":")[1]!)).toBe(w.origin);
    await dialog.getByText(/分 \d+ 秒内有效，只能用一次/u).waitFor();
    expect(
      await dialog.locator(".settings-device-brief pre").textContent(),
    ).toContain(code);
    // The code stays in this dialog only: nowhere in the URL or browser storage.
    expect(page.url()).not.toContain("srp1_");
    expect(
      await page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage }),
      ),
    ).not.toContain("srp1_");
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(await page.getByText(code).count()).toBe(0);
    const row = page.getByRole("row", { name: /办公室笔记本/u });
    await row.getByText("待配对").waitFor();
    expect(await row.getByText("导入 · 读取").count()).toBe(1);

    // The Agent on the desktop exchanges the code for its token.
    const exchange = await fetch(
      `${w.origin}/api/v1/device-connections/exchange`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairing_code: code.split(":")[2] }),
      },
    );
    expect(exchange.status).toBe(200);
    // The list follows a fresh code until it pairs.
    await row.getByText("已连接").waitFor();

    await row.getByRole("button", { name: "改名", exact: true }).click();
    const rename = page.getByRole("dialog", { name: "设备改名" });
    await rename.getByRole("textbox", { name: "名称" }).fill("实验室 Agent");
    await rename.getByRole("button", { name: "保存", exact: true }).click();
    const renamed = page.getByRole("row", { name: /实验室 Agent/u });
    await renamed.waitFor();

    await renamed.getByRole("button", { name: "撤销", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "撤销设备连接" });
    await confirm.getByText("该设备的请求会立即被拒绝").waitFor();
    await confirm.getByRole("button", { name: "撤销", exact: true }).click();
    await renamed.getByText("已撤销").waitFor();
    expect(await renamed.getByRole("button").count()).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);

it("preselects capture for the browser extension and requires at least one purpose", async () => {
  const w = await nextWorkspace({
    path: "/?view=set&setting=devices",
    ready: ".settings-device-actions",
  });
  try {
    const page = w.page;
    // Before block 06 builds it, the skill download says so instead of failing.
    await page.getByRole("button", { name: "下载 skill", exact: true }).click();
    await page.getByText("skill 包尚未构建").waitFor();
    await page
      .getByRole("button", { name: "下载扩展安装包", exact: true })
      .click();
    await page.getByText("扩展安装包尚未构建").waitFor();
    await page
      .getByRole("button", { name: "连接浏览器扩展", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "连接浏览器扩展" });
    const capture = dialog.getByRole("checkbox", { name: "收藏", exact: true });
    expect(await capture.isChecked()).toBe(true);
    expect(
      await dialog
        .getByRole("checkbox", { name: "操作", exact: true })
        .isChecked(),
    ).toBe(false);
    await dialog.getByText("收藏", { exact: true }).click();
    expect(await capture.isChecked()).toBe(false);
    expect(
      await dialog
        .getByRole("button", { name: "生成连接码", exact: true })
        .isDisabled(),
    ).toBe(true);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);
