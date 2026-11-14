import type { Page } from "playwright";

/** The Web import of an export file: preview, confirm, and wait for the report. */
export async function importExport(
  page: Page,
  file: { name: string; content: string },
) {
  await page.getByRole("tab", { name: "导入", exact: true }).click();
  await page.getByLabel("导出文件", { exact: true }).setInputFiles({
    name: file.name,
    mimeType: "text/plain",
    buffer: Buffer.from(file.content),
  });
  await page.getByRole("button", { name: "预览导入", exact: true }).click();
  const view = page.getByRole("region", { name: "入库批次" });
  await view.getByRole("button", { name: "确认导入", exact: true }).click();
  await page
    .getByRole("dialog", { name: "确认导入" })
    .getByRole("button", { name: "确认导入", exact: true })
    .click();
  await view.getByRole("heading", { name: "报告" }).waitFor();
  return view;
}
