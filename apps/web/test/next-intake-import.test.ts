import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { workbenchPdf } from "../../server/src/workbench/synthetic-fixture.js";
import { nextWorkspace } from "./next-workspace-fixture.js";

const metadata = (title: string, doi: string) => ({
  title,
  authors: [],
  abstract: null,
  publication_date: null,
  publication_year: 2026,
  publication_form: "journal-article",
  article_kind: "research-article",
  language: "en",
  venue: null,
  publisher: null,
  volume: null,
  issue: null,
  pages: null,
  identifiers: [{ namespace: "doi", value: doi }],
  keywords: [],
  subject_terms: [],
});

it("shows an Agent's import session, confirms it on the page, uploads matching PDFs from a folder and reports the rest", async () => {
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  const folder = await mkdtemp(join(tmpdir(), "sciretriever-import-pdfs-"));
  try {
    const page = w.page;
    // An Agent on the desktop pairs and pushes two records, each with one PDF.
    const { connection_code } = await w.env.app.deviceConnections.create({
      address: w.origin,
      name: "办公室笔记本",
      purposes: ["import"],
    });
    const exchange = await fetch(
      `${w.origin}/api/v1/device-connections/exchange`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairing_code: connection_code.split(":")[2] }),
      },
    );
    const { token } = ((await exchange.json()) as { result: { token: string } })
      .result;
    const call = async (path: string, request: unknown) => {
      const response = await fetch(`${w.origin}/api/v1/import/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Sciretriever-Protocol-Version": "1",
        },
        body: JSON.stringify({ protocol_version: 1, request }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { result: Record<string, unknown> })
        .result;
    };
    const { session } = (await call("sessions", {
      format: "records",
      library: {
        system: "zotero",
        library_id: "users/4242",
        identity: "global",
        name: "我的文库",
      },
      scope: "整库",
    })) as { session: { session_id: string } };
    const id = session.session_id;
    await call(`sessions/${id}/data`, {
      sequence: 0,
      data: {
        records: ["one", "two"].map((name) => ({
          external_id: `paper-${name}`,
          metadata: metadata(
            `Imported paper ${name}`,
            `10.5555/import-${name}`,
          ),
          files: [
            {
              external_id: `attachment-${name}`,
              file_name: `${name}.pdf`,
              media_type: "application/pdf",
              preferred: true,
            },
          ],
        })),
      },
    });

    await page.getByRole("tab", { name: "导入", exact: true }).click();
    const sessions = page.getByRole("table", { name: "导入会话" });
    const row = sessions.getByRole("row", { name: /我的文库（Zotero）/u });
    await row.getByText("Agent · 办公室笔记本").waitFor();
    await row.getByText("待确认").waitFor();
    await row.getByRole("button", { name: "我的文库（Zotero）" }).click();

    const view = page.getByRole("region", { name: "导入会话" });
    await view.getByText("你或持有“导入”用途的 Agent 都可以确认").waitFor();
    await view
      .getByText("预览（估计，确认时按当时的文献库重新判定）")
      .waitFor();
    const counts = view.locator(".intake-import-counts");
    await counts.first().getByText("新增 2").waitFor();
    await counts.nth(1).getByText("要上传 2").waitFor();
    // Preview writes nothing.
    expect((await call(`sessions/${id}/status`, {})).session).toMatchObject({
      state: "awaiting-confirmation",
      intake_batch_id: null,
    });

    await view.getByRole("button", { name: "确认导入", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "确认导入" });
    await confirm.getByText("只新增，不删除、不替换已有 PDF。").waitFor();
    await confirm
      .getByRole("button", { name: "确认导入", exact: true })
      .click();
    await view
      .getByText(/导入中/u)
      .first()
      .waitFor();

    // Only one of the two PDFs is in the folder the user picks.
    await writeFile(
      join(folder, "one.pdf"),
      workbenchPdf("10.5555/import-one"),
    );
    await view.getByLabel("选择 PDF 文件夹").setInputFiles(folder);
    await view.getByText("文件夹里没找到 1 个文件").waitFor();
    await view.getByText("本次已交 1 个文件。").waitFor();

    await view.getByRole("button", { name: "结束导入", exact: true }).click();
    await page
      .getByRole("dialog", { name: "结束导入" })
      .getByRole("button", { name: "结束导入", exact: true })
      .click();
    await view.getByRole("heading", { name: "报告" }).waitFor();
    await view.getByText("已上传 1").waitFor();
    await view.getByText("未交 1").waitFor();
    const owed = view.getByRole("table", { name: "冲突与未交的文件" });
    await owed.getByRole("row", { name: /two\.pdf/u }).waitFor();
    await view.getByRole("button", { name: "在文献库查看" }).waitFor();
    expect(w.errors).toEqual([]);
  } finally {
    await rm(folder, { recursive: true, force: true });
    await w.close();
  }
}, 120000);

it("previews an uploaded BibTeX export without writing, then imports it with the PDF it refers to", async () => {
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  const folder = await mkdtemp(join(tmpdir(), "sciretriever-upload-pdfs-"));
  try {
    const page = w.page;
    await page.getByRole("tab", { name: "导入", exact: true }).click();
    await page.getByLabel("导出文件").setInputFiles({
      name: "library.bib",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "@article{one,\n  title = {Uploaded paper},\n  doi = {10.5555/upload-one},\n  year = {2025},\n  file = {Full Text PDF:files/7/upload.pdf:application/pdf}\n}\n",
      ),
    });
    // The format is read from the file once its text has loaded.
    await expect
      .poll(() => page.getByRole("button", { name: "格式" }).textContent())
      .toContain("BibTeX");
    // The PDF the export refers to is in the folder chosen with it.
    await writeFile(
      join(folder, "upload.pdf"),
      workbenchPdf("10.5555/upload-one"),
    );
    await page.getByLabel("PDF 文件夹").setInputFiles(folder);
    await page.getByRole("button", { name: "预览导入", exact: true }).click();
    const view = page.getByRole("region", { name: "导入会话" });
    await view.getByRole("heading", { name: "library.bib" }).waitFor();
    await view
      .locator(".intake-import-counts")
      .first()
      .getByText("新增 1")
      .waitFor();
    await view.getByRole("button", { name: "确认导入", exact: true }).click();
    await page
      .getByRole("dialog", { name: "确认导入" })
      .getByRole("button", { name: "确认导入", exact: true })
      .click();
    await view.getByRole("heading", { name: "报告" }).waitFor();
    await view.getByText("已上传 1").waitFor();
    await view.getByText("完成").first().waitFor();
    await view.getByRole("button", { name: "返回入库" }).click();
    await page
      .getByRole("table", { name: "导入会话" })
      .getByRole("row", { name: /library\.bib/u })
      .getByText("网页")
      .waitFor();
    // The intake record of this import leads back to its report.
    await page
      .locator(".intake-record", { hasText: "library.bib" })
      .getByRole("button", { name: "导入报告" })
      .click();
    await view.getByRole("heading", { name: "报告" }).waitFor();
    expect(w.errors).toEqual([]);
  } finally {
    await rm(folder, { recursive: true, force: true });
    await w.close();
  }
}, 120000);
