import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Page, Request } from "playwright";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { importExport } from "./import-flow-fixture.js";

const record = (key: string, title: string) =>
  `@article{${key},title={${title}},year={2021},doi={10.5555/withdraw-${key}}}`;
/** Withdrawal requests the page sent, by their last path parts, in order. */
function withdrawalLog(page: Page) {
  const sent: string[] = [];
  page.on("request", (request: Request) => {
    const path = new URL(request.url()).pathname;
    // Reading a withdrawn batch's record changes nothing and is left out.
    const m = path.match(
      /\/batches\/[^/]+\/(withdrawal\/preview|withdraw|restore\/preview|restore)$/u,
    );
    if (m) sent.push(m[1]!);
  });
  return sent;
}
const more = (page: Page) =>
  page
    .getByRole("region", { name: "批次", exact: true })
    .getByRole("button", { name: "更多", exact: true })
    .click();

it("withdraws a batch only after its estimate, keeps what came before it, reports, and restores it whole (literature materials 6.4.11)", async () => {
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  try {
    const page = w.page;
    const sent = withdrawalLog(page);
    // One paper first; then a batch with it again and a new one.
    const first = await importExport(page, {
      name: "first.bib",
      content: record("a", "Argyrodite electrolyte one"),
    });
    await first.getByRole("button", { name: "返回找文献" }).click();
    const view = await importExport(page, {
      name: "second.bib",
      content: [
        record("a", "Argyrodite electrolyte one"),
        record("b", "Argyrodite electrolyte two"),
      ].join("\n"),
    });
    const second = page.url();
    const before = (await w.env.app.library.search({ query: {} })).total_count;
    expect(sent).toEqual([]);

    // The estimate first: what goes, what stays and why.
    await more(page);
    await page.getByRole("menuitem", { name: "撤回这一批" }).click();
    const dialog = page.getByRole("dialog", { name: "撤回这一批" });
    await expect
      .poll(() => dialog.getByLabel("将移除").textContent())
      .toBe("文献 1文件 0文件夹 0文件夹成员 0批注 0");
    await dialog.getByText("保留文献 1 篇").waitFor();
    expect(
      await dialog.getByRole("list", { name: "保留的原因" }).textContent(),
    ).toBe("入库前已在库 1 篇");
    await dialog.getByRole("button", { name: /^逐篇列出/u }).click();
    expect(
      await dialog.getByRole("list", { name: "保留的文献" }).textContent(),
    ).toBe("Argyrodite electrolyte one入库前已在库");
    await dialog
      .getByText("撤回只是从文献库中移除，可以恢复；文件不会被删除。")
      .waitFor();
    // Registered: no word about folders and marks left out.
    expect(
      await dialog
        .getByText("本批在登记之前形成，文件夹与批注不在撤回范围内。")
        .count(),
    ).toBe(0);
    expect(sent).toEqual(["withdrawal/preview"]);
    // Cancelling withdraws nothing.
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    expect(sent).toEqual(["withdrawal/preview"]);
    expect((await w.env.app.library.search({ query: {} })).total_count).toBe(
      before,
    );

    // Then the withdrawal: state, the line at the top and the report.
    await more(page);
    await page.getByRole("menuitem", { name: "撤回这一批" }).click();
    await dialog.getByText("保留文献 1 篇").waitFor();
    await dialog.getByRole("button", { name: "撤回", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(sent).toEqual([
      "withdrawal/preview",
      "withdrawal/preview",
      "withdraw",
    ]);
    await view.locator(".intake-batch-state").getByText("已撤回").waitFor();
    await view.getByText(/^这一批已于 .+ 撤回$/u).waitFor();
    const report = view.getByRole("region", { name: "撤回报告" });
    expect(await report.getByLabel("移除").textContent()).toBe(
      "文献 1文件 0文件夹 0文件夹成员 0批注 0",
    );
    await report.getByText("保留文献 1 篇").waitFor();
    expect(
      await view.getByRole("heading", { name: "接着做什么" }).count(),
    ).toBe(0);
    expect((await w.env.app.library.search({ query: {} })).total_count).toBe(
      before - 1,
    );
    // No way to withdraw again, nor any other way around the estimate.
    await more(page);
    expect(
      await page.getByRole("menuitem", { name: "撤回这一批" }).count(),
    ).toBe(0);
    await page.keyboard.press("Escape");
    expect(
      await view.getByRole("button", { name: "撤回", exact: true }).count(),
    ).toBe(0);
    // After a reload, the same: read back from the service.
    await page.reload();
    await view.getByText(/^这一批已于 .+ 撤回$/u).waitFor();
    expect(
      await view
        .getByRole("region", { name: "撤回报告" })
        .getByLabel("移除")
        .textContent(),
    ).toBe("文献 1文件 0文件夹 0文件夹成员 0批注 0");

    // A later batch brings the withdrawn paper back on its own.
    await view.getByRole("button", { name: "返回找文献" }).click();
    const later = await importExport(page, {
      name: "third.bib",
      content: record("b", "Argyrodite electrolyte two"),
    });
    await later.getByLabel("书目计数").getByText("恢复 1").waitFor();
    await page.goto(second);
    await view.getByText(/^这一批已于 .+ 撤回$/u).waitFor();

    // Restoration: said first, then done; the batch returns as it was.
    await view.getByRole("button", { name: "恢复这一批", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "恢复这一批" });
    await expect
      .poll(() => confirm.getByLabel("将恢复").textContent())
      .toBe("文献 0文件 0文件夹 0文件夹成员 0批注 0");
    await confirm.getByText("已被后来的入库恢复的 1 篇不计。").waitFor();
    expect(sent.at(-1)).toBe("restore/preview");
    await confirm.getByRole("button", { name: "恢复", exact: true }).click();
    await view.locator(".intake-batch-state").getByText("完成").waitFor();
    expect(sent.at(-1)).toBe("restore");
    const restored = view.getByRole("region", { name: "恢复报告" });
    await restored.getByLabel("恢复").waitFor();
    expect((await w.env.app.library.search({ query: {} })).total_count).toBe(
      before,
    );
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("offers withdrawal only once a batch has ended, and says so when a task or the state stands in the way", async () => {
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  try {
    const page = w.page;
    const sent = withdrawalLog(page);
    // Awaiting confirmation: the entry is there but not usable, with why.
    await page.getByRole("tab", { name: "文件", exact: true }).click();
    await page.getByLabel("选择文件", { exact: true }).setInputFiles({
      name: "waiting.bib",
      mimeType: "text/plain",
      buffer: Buffer.from(record("w", "Halide electrolyte three")),
    });
    await page.getByRole("button", { name: "继续", exact: true }).click();
    const view = page.getByRole("region", { name: "批次", exact: true });
    await view.getByRole("heading", { name: "waiting.bib" }).waitFor();
    await more(page);
    const entry = page.getByRole("menuitem", { name: /^撤回这一批/u });
    expect(await entry.getAttribute("aria-disabled")).toBe("true");
    await entry.getByText("入库结束后才能撤回").waitFor();
    await page.keyboard.press("Escape");
    expect(sent).toEqual([]);
    // Ended: a task on its papers keeps the withdraw button away.
    await view.getByRole("button", { name: "确认入库", exact: true }).click();
    await page
      .getByRole("dialog", { name: "确认入库" })
      .getByRole("button", { name: "确认入库", exact: true })
      .click();
    await view.locator(".intake-batch-state").getByText("完成").waitFor();
    const reply = (status: number, code: string) => ({
      status,
      contentType: "application/json",
      body: JSON.stringify({ protocol_version: 1, code }),
    });
    const previewRoute = (url: URL) =>
      url.pathname.endsWith("/withdrawal/preview");
    await page.route(previewRoute, (r) =>
      r.fulfill(reply(409, "intake-batch-busy")),
    );
    await more(page);
    await page.getByRole("menuitem", { name: "撤回这一批" }).click();
    const dialog = page.getByRole("dialog", { name: "撤回这一批" });
    await dialog
      .getByText("这一批有文献正在被任务处理，请等任务结束或取消后再撤回。")
      .waitFor();
    expect(
      await dialog.getByRole("button", { name: "撤回", exact: true }).count(),
    ).toBe(0);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.unroute(previewRoute);
    // A batch formed before registration says what is out of reach; a state
    // that changed meanwhile is said as it is, and nothing is withdrawn.
    await page.route(previewRoute, async (r) => {
      const response = await r.fetch();
      const value = (await response.json()) as {
        result: { withdrawal: Record<string, unknown> };
      };
      value.result.withdrawal.registered = false;
      await r.fulfill({ response, json: value });
    });
    const withdrawRoute = (url: URL) => url.pathname.endsWith("/withdraw");
    await page.route(withdrawRoute, (r) =>
      r.fulfill(reply(409, "intake-batch-state")),
    );
    await more(page);
    await page.getByRole("menuitem", { name: "撤回这一批" }).click();
    await dialog
      .getByText("本批在登记之前形成，文件夹与批注不在撤回范围内。")
      .waitFor();
    await dialog.getByRole("button", { name: "撤回", exact: true }).click();
    await dialog
      .getByText("没有撤回：批次状态已变化，请刷新后再操作。")
      .waitFor();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await view.locator(".intake-batch-state").getByText("完成").waitFor();
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("shows the estimate, the withdrawal report and a withdrawn batch (plan 25 block 12.7 screenshots)", async (context) => {
  const output = process.env.SCIRETRIEVER_WEB_WITHDRAW_SHOTS;
  if (!output) return context.skip();
  await mkdir(output, { recursive: true });
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  try {
    const page = w.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const shot = (name: string) =>
      page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
    const first = await importExport(page, {
      name: "first.bib",
      content: record("a", "Argyrodite electrolyte one"),
    });
    await first.getByRole("button", { name: "返回找文献" }).click();
    const view = await importExport(page, {
      name: "second.bib",
      content: [
        record("a", "Argyrodite electrolyte one"),
        record("b", "Argyrodite electrolyte two"),
      ].join("\n"),
    });
    await more(page);
    await page.getByRole("menuitem", { name: "撤回这一批" }).click();
    const dialog = page.getByRole("dialog", { name: "撤回这一批" });
    await dialog.getByText("保留文献 1 篇").waitFor();
    await dialog.getByRole("button", { name: /^逐篇列出/u }).click();
    await shot("withdraw-estimate");
    await dialog.getByRole("button", { name: "撤回", exact: true }).click();
    await view.getByRole("region", { name: "撤回报告" }).waitFor();
    await shot("withdraw-report");
    await page.reload();
    await view.getByText(/^这一批已于 .+ 撤回$/u).waitFor();
    await view.getByRole("region", { name: "撤回报告" }).waitFor();
    await shot("withdrawn-batch");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);
