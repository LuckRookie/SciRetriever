import type { Page } from "playwright";

/**
 * The Web import of an export file: put it on the intake page's drop zone,
 * continue with its recognized format, confirm, and wait for its result.
 */
export async function importExport(
  page: Page,
  file: { name: string; content: string },
) {
  await page.getByRole("tab", { name: "文件", exact: true }).click();
  await page.getByLabel("选择文件", { exact: true }).setInputFiles({
    name: file.name,
    mimeType: "text/plain",
    buffer: Buffer.from(file.content),
  });
  await page.getByRole("button", { name: "继续", exact: true }).click();
  const view = page.getByRole("region", { name: "入库批次" });
  await view.getByRole("button", { name: "确认入库", exact: true }).click();
  await page
    .getByRole("dialog", { name: "确认入库" })
    .getByRole("button", { name: "确认入库", exact: true })
    .click();
  // The report shows while it runs; the batch is done once it has a result.
  await view
    .locator(".intake-batch-state .ui-badge")
    .filter({ hasText: /^(完成|部分完成|失败|中断)$/u })
    .waitFor();
  return view;
}
