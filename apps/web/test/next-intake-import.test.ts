import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Page, Request } from "playwright";
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

/** What the page sent to the intake interface, in order. */
function intakeLog(page: Page) {
  const sent: {
    path: string;
    body: unknown;
    name: string | null;
    relative: string | null;
  }[] = [];
  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/v1/intake/")) return;
    const headers = request.headers();
    const type = headers["content-type"] ?? "";
    sent.push({
      path: url.pathname.replace(/[0-9a-f-]{36}/gu, ":id"),
      body: type.includes("json") ? request.postDataJSON() : null,
      name: headers["x-sciretriever-file-name"]
        ? decodeURIComponent(headers["x-sciretriever-file-name"])
        : null,
      relative: headers["x-sciretriever-relative-path"]
        ? decodeURIComponent(headers["x-sciretriever-relative-path"])
        : null,
    });
  });
  return sent;
}
const filesTab = async (page: Page) =>
  page.getByRole("tab", { name: "文件", exact: true }).click();

it("shows an Agent's intake batch as an intake record, confirms it on its page, uploads matching PDFs from a folder and reports the rest", async () => {
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  const folder = await mkdtemp(join(tmpdir(), "sciretriever-import-pdfs-"));
  try {
    const page = w.page;
    // An Agent on the desktop pairs and pushes two records, each with one PDF.
    const { connection_code } = await w.env.app.deviceConnections.create({
      address: w.origin,
      name: "办公室笔记本",
      purposes: ["intake"],
      kind: "agent",
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
      const response = await fetch(`${w.origin}/api/v1/intake/${path}`, {
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
    const { batch } = (await call("batches", {
      format: "records",
      source: {
        system: "zotero",
        library_id: "users/4242",
        identity: "global",
        name: "我的文库",
      },
      scope: "整库",
    })) as { batch: { batch_id: string; label: string } };
    const id = batch.batch_id;
    await call(`batches/${id}/data`, {
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

    // One kind of row: the Agent's batch shows who started it and its state.
    const row = page.locator(".intake-record", { hasText: batch.label });
    await row.getByText("Agent · 办公室笔记本").waitFor();
    await row.getByText("待确认").waitFor();
    await row
      .getByRole("button", { name: `打开批次：${batch.label}`, exact: true })
      .click();

    const view = page.getByRole("region", { name: "批次", exact: true });
    await view
      .getByText("预览（估计，确认时按当时的文献库重新判定）")
      .waitFor();
    await view.getByLabel("书目计数").getByText("新增 2").waitFor();
    await view.getByLabel("文件计数").getByText("要上传 2").waitFor();
    // Preview writes nothing.
    expect((await call(`batches/${id}/status`, {})).batch).toMatchObject({
      state: "awaiting-confirmation",
      result: null,
      confirmed_at: null,
    });
    // A reload shows the same batch in the same state.
    await page.reload();
    await view.getByLabel("书目计数").getByText("新增 2").waitFor();

    await view.getByRole("button", { name: "确认入库", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "确认入库" });
    await confirm
      .getByText(
        "只新增，不删除、不替换已有 PDF；需要决定而没有决定的条目不入库。",
      )
      .waitFor();
    await confirm
      .getByRole("button", { name: "确认入库", exact: true })
      .click();
    await view.getByText("进行中").first().waitFor();
    await view.getByLabel("文件进度").getByText("待交 2").waitFor();

    // Only one of the two PDFs is in the folder the user picks.
    await writeFile(
      join(folder, "one.pdf"),
      workbenchPdf("10.5555/import-one"),
    );
    await view.getByLabel("选择文件夹").setInputFiles(folder);
    await view.getByText("文件夹里没找到 1 个文件").waitFor();
    await view.getByText("本次已交 1 个文件。").waitFor();

    await view.getByRole("button", { name: "结束入库", exact: true }).click();
    await page
      .getByRole("dialog", { name: "结束入库" })
      .getByRole("button", { name: "结束入库", exact: true })
      .click();
    await view.getByLabel("文件计数").getByText("已上传 1").waitFor();
    await view.getByLabel("文件计数").getByText("未交 1").waitFor();
    const owed = view.getByRole("table", { name: "冲突与未交的文件" });
    await owed.getByRole("row", { name: /two\.pdf/u }).waitFor();
    await view.getByText(/^全文已取得 1 \/ 总数 2，未取得 1/u).waitFor();
    expect(w.errors).toEqual([]);
  } finally {
    await rm(folder, { recursive: true, force: true });
    await w.close();
  }
}, 120000);

it("forms a batch from PDFs alone, each a file-only item, and opens it without writing the library", async () => {
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  try {
    const page = w.page;
    const sent = intakeLog(page);
    const before = (await w.env.app.library.search({ query: {} })).total_count;
    await filesTab(page);
    await page.getByLabel("选择文件", { exact: true }).setInputFiles([
      {
        name: "scan_0041.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from(workbenchPdf("10.5555/drop-one")),
      },
      // No extension, but a PDF by its content.
      {
        name: "scan_0042",
        mimeType: "application/octet-stream",
        buffer: Buffer.from(workbenchPdf("10.5555/drop-two")),
      },
    ]);
    const view = page.getByRole("region", { name: "批次", exact: true });
    await view.getByRole("heading", { level: 2 }).waitFor();
    const create = sent.find((r) => r.path === "/api/v1/intake/batches")!;
    expect(create.body).toMatchObject({
      protocol_version: 1,
      request: { format: "file", source: null, file_name: null },
    });
    expect(
      sent
        .filter((r) => r.path.endsWith("/file-items"))
        .map((r) => [r.name, r.relative]),
    ).toEqual([
      ["scan_0041.pdf", null],
      ["scan_0042", null],
    ]);
    expect(sent.some((r) => r.path.endsWith("/data"))).toBe(false);
    expect(new URL(page.url()).searchParams.get("session")).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
    // Forming the batch writes nothing to the library.
    expect((await w.env.app.library.search({ query: {} })).total_count).toBe(
      before,
    );
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("sends an export alone as the batch's data, its format recognized and changeable before it goes", async () => {
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  try {
    const page = w.page;
    const sent = intakeLog(page);
    await filesTab(page);
    const content =
      "@article{one,\n  title = {Uploaded paper},\n  doi = {10.5555/upload-one},\n  year = {2025}\n}\n";
    await page.getByLabel("选择文件", { exact: true }).setInputFiles({
      name: "library.bib",
      mimeType: "text/plain",
      buffer: Buffer.from(content),
    });
    // The format is shown below the drop zone and nothing is sent yet.
    await expect
      .poll(() => page.getByRole("button", { name: "格式" }).textContent())
      .toContain("BibTeX");
    expect(sent).toEqual([]);
    await page.getByRole("button", { name: "格式" }).click();
    await page.getByRole("option", { name: "BibLaTeX", exact: true }).click();
    await page.getByRole("button", { name: "格式" }).click();
    await page.getByRole("option", { name: "BibTeX", exact: true }).click();
    await page.getByRole("button", { name: "继续", exact: true }).click();
    const view = page.getByRole("region", { name: "批次", exact: true });
    await view.getByRole("heading", { name: "library.bib" }).waitFor();
    expect(sent.slice(0, 2).map((r) => [r.path, r.body])).toEqual([
      [
        "/api/v1/intake/batches",
        {
          protocol_version: 1,
          request: {
            format: "bibtex",
            source: null,
            scope: "网页上传 library.bib",
            file_name: "library.bib",
          },
        },
      ],
      [
        "/api/v1/intake/batches/:id/data",
        { protocol_version: 1, request: { sequence: 0, data: content } },
      ],
    ]);
    expect(sent.some((r) => r.path.endsWith("/file-items"))).toBe(false);
    await view.getByLabel("书目计数").getByText("新增 1").waitFor();
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("pairs an export with the PDFs of the folder put in with it by the path it gives, and imports the pair", async () => {
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  const root = await mkdtemp(join(tmpdir(), "sciretriever-drop-"));
  try {
    const page = w.page;
    const sent = intakeLog(page);
    // A Zotero-style export folder: the export, and its files by key.
    const folder = join(root, "My Library");
    await mkdir(join(folder, "files", "7"), { recursive: true });
    await writeFile(
      join(folder, "My Library.bib"),
      "@article{one,\n  title = {Paired paper},\n  doi = {10.5555/paired-one},\n  year = {2025},\n  file = {Full Text PDF:files/7/paired.pdf:application/pdf}\n}\n",
    );
    await writeFile(
      join(folder, "files", "7", "paired.pdf"),
      workbenchPdf("10.5555/paired-one"),
    );
    await filesTab(page);
    await page.getByLabel("选择文件夹", { exact: true }).setInputFiles(folder);
    await page.getByText(/一同放入 1 个 PDF，按导出里写的路径配对/u).waitFor();
    await page.getByRole("button", { name: "继续", exact: true }).click();
    const view = page.getByRole("region", { name: "批次", exact: true });
    await view.getByRole("heading", { name: "My Library.bib" }).waitFor();
    const items = sent.filter((r) => r.path.endsWith("/file-items"));
    expect(items.map((r) => [r.name, r.relative])).toEqual([
      ["paired.pdf", "My Library/files/7/paired.pdf"],
    ]);
    // Paired, the file is the record's own and not left to decide.
    await view.getByLabel("书目计数").getByText("新增 1").waitFor();
    expect(
      await view.getByRole("group", { name: "未配对的文件" }).count(),
    ).toBe(0);
    await view.getByRole("button", { name: "确认入库", exact: true }).click();
    await page
      .getByRole("dialog", { name: "确认入库" })
      .getByRole("button", { name: "确认入库", exact: true })
      .click();
    await view.getByText(/^全文已取得 1 \/ 总数 1/u).waitFor();
    expect(w.errors).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await w.close();
  }
}, 120000);

it("lists files it cannot recognize, names the supported formats, and sends nothing for them", async () => {
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  try {
    const page = w.page;
    const sent = intakeLog(page);
    await filesTab(page);
    await page.getByLabel("选择文件", { exact: true }).setInputFiles([
      {
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Shopping list: salt, flour."),
      },
      {
        name: "figure.png",
        mimeType: "image/png",
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
    ]);
    const unknown = page.getByRole("list", { name: "没有识别的文件" });
    await unknown.getByText("没有识别出这个文件的格式：notes.txt").waitFor();
    await unknown.getByText("没有识别出这个文件的格式：figure.png").waitFor();
    await unknown
      .getByText(
        "支持 PDF；BibTeX、BibLaTeX、RIS、CSL JSON、EndNote（.enw、.xml）、NoteExpress（.net）导出文件，以及知网、万方、维普导出的 EndNote 与 NoteExpress 文本。",
      )
      .waitFor();
    expect(sent).toEqual([]);
    expect(new URL(page.url()).searchParams.get("session")).toBeNull();
    // An export whose format cannot be told waits for one to be chosen,
    // the three new formats among the choices.
    await page.getByLabel("选择文件", { exact: true }).setInputFiles({
      name: "export.xml",
      mimeType: "application/xml",
      buffer: Buffer.from('<?xml version="1.0"?>\n<catalog/>'),
    });
    await page.getByText("没能识别格式，请选一个。").waitFor();
    const proceed = page.getByRole("button", { name: "继续", exact: true });
    expect(await proceed.isDisabled()).toBe(true);
    await page.getByRole("button", { name: "格式" }).click();
    expect(await page.getByRole("option").allTextContents()).toEqual([
      "请选择",
      "BibTeX",
      "BibLaTeX",
      "RIS",
      "CSL JSON",
      "EndNote（.enw）",
      "EndNote XML",
      "NoteExpress",
    ]);
    await page
      .getByRole("option", { name: "EndNote XML", exact: true })
      .click();
    await expect.poll(() => proceed.isDisabled()).toBe(false);
    expect(sent).toEqual([]);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("reads a GB18030 NoteExpress text from 知网 as its format, says how it was read, and makes the batch with it (literature materials 6.4.14)", async () => {
  const w = await nextWorkspace({ path: "/?view=disc", ready: ".intake-form" });
  const shots = process.env.SCIRETRIEVER_WEB_INTAKE_FORMAT_SHOTS;
  try {
    const page = w.page;
    const sent = intakeLog(page);
    await filesTab(page);
    // The supported formats and what attachment paths are for, below the zone.
    await page
      .getByText(
        "导出文件里的附件路径只用来配对同时放入的 PDF，不读取路径所指的文件。",
      )
      .waitFor();
    if (shots) {
      await mkdir(shots, { recursive: true });
      await page.screenshot({
        path: join(shots, "intake-files-supported.png"),
        fullPage: true,
      });
    }
    // “硝基中文” is not ASCII: CF F5 BB F9 D6 D0 CE C4 in GB18030.
    const title = [0xcf, 0xf5, 0xbb, 0xf9, 0xd6, 0xd0, 0xce, 0xc4];
    const bytes = Buffer.concat([
      Buffer.from("{Reference Type}: Journal Article\r\n{Title}: "),
      Buffer.from(title),
      Buffer.from("\r\n{Year}: 2025\r\n{DOI}: 10.5555/noteexpress-one\r\n"),
    ]);
    const text = new TextDecoder("gb18030").decode(bytes);
    expect(text).toContain("{Title}: 硝基中文");
    await page.getByLabel("选择文件", { exact: true }).setInputFiles({
      name: "CNKI-20261126.txt",
      mimeType: "text/plain",
      buffer: bytes,
    });
    await expect
      .poll(() => page.getByRole("button", { name: "格式" }).textContent())
      .toContain("NoteExpress");
    await page
      .getByText("导出文件 CNKI-20261126.txt · 按 GB18030 编码读出")
      .waitFor();
    if (shots)
      await page.screenshot({
        path: join(shots, "intake-files-recognized.png"),
        fullPage: true,
      });
    // CSL JSON takes UTF-8 only: chosen for this file, the reason is said.
    await page.getByRole("button", { name: "格式" }).click();
    await page.getByRole("option", { name: "CSL JSON", exact: true }).click();
    await page
      .getByRole("alert")
      .getByText(/^这个文件不是 UTF-8 编码，CSL JSON 只接受 UTF-8/u)
      .waitFor();
    const proceed = page.getByRole("button", { name: "继续", exact: true });
    expect(await proceed.isDisabled()).toBe(true);
    if (shots)
      await page.screenshot({
        path: join(shots, "intake-files-encoding-refused.png"),
        fullPage: true,
      });
    await page.getByRole("button", { name: "格式" }).click();
    await page
      .getByRole("option", { name: "NoteExpress", exact: true })
      .click();
    await proceed.click();
    const view = page.getByRole("region", { name: "批次", exact: true });
    await view.getByRole("heading", { name: "CNKI-20261126.txt" }).waitFor();
    expect(sent.slice(0, 2).map((r) => [r.path, r.body])).toEqual([
      [
        "/api/v1/intake/batches",
        {
          protocol_version: 1,
          request: {
            format: "noteexpress",
            source: null,
            scope: "网页上传 CNKI-20261126.txt",
            file_name: "CNKI-20261126.txt",
          },
        },
      ],
      [
        "/api/v1/intake/batches/:id/data",
        { protocol_version: 1, request: { sequence: 0, data: text } },
      ],
    ]);
    await view.getByLabel("书目计数").getByText("新增 1").waitFor();
    // Not a Zotero batch: no annotation data, so no “批注”.
    expect(await view.getByLabel("批注计数").count()).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);
