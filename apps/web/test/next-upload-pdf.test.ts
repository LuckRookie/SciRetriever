import { expect, it } from "vitest";
import type { Page, Request } from "playwright";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { missingId } from "./processor-workspace-fixture.js";
import { workbenchPdf } from "../../server/src/workbench/synthetic-fixture.js";

/** PDF uploads the page sent: the intake supplement route, or the old one. */
function uploads(page: Page) {
  const sent: { path: string; name: string | null }[] = [];
  page.on("request", (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (
      path === "/api/v1/maintenance/ingest-pdf" ||
      /^\/api\/v1\/intake\/literatures\/[^/]+\/pdf$/u.test(path)
    ) {
      const name = request.headers()["x-sciretriever-file-name"];
      sent.push({ path, name: name ? decodeURIComponent(name) : null });
    }
  });
  return sent;
}
/** Over the 16 MiB the page used to refuse: a valid PDF with padding after it. */
const large = () =>
  Buffer.concat([
    Buffer.from(workbenchPdf("10.5555/upload-large")),
    Buffer.alloc(17 * 1024 * 1024, 0x0a),
  ]);

it("uploads a PDF from the reader's “更多” through intake: streamed, over 16 MiB, into the day's supplement batch, never the old route (product interface 2.4.2)", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    const sent = uploads(page);
    await page.goto(`${w.origin}/?literature=${missingId}&reader=pdf`);
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("menuitem", { name: "上传 PDF", exact: true }).click();
    const bytes = large();
    await page.getByLabel("PDF 文件", { exact: true }).setInputFiles({
      name: "large paper.pdf",
      mimeType: "application/pdf",
      buffer: bytes,
    });
    expect((await w.env.app.library.detail(missingId)).primary_pdf).toBeNull();
    await page.getByRole("button", { name: "确认上传", exact: true }).click();
    await page
      .getByText("PDF 已上传，归入今天的“补充文件”批次；原有材料保留。")
      .first()
      .waitFor({ timeout: 60_000 });
    expect(sent).toEqual([
      {
        path: `/api/v1/intake/literatures/${missingId}/pdf`,
        name: "large paper.pdf",
      },
    ]);
    const pdf = (await w.env.app.library.detail(missingId)).primary_pdf;
    expect(pdf?.asset.size_bytes).toBe(bytes.length);
    // It went into the day's open supplement batch.
    const batches = (await w.env.app.library.intakeBatches({
      operation: "list",
      request: { limit: 20, cursor: null },
    })) as unknown as { items: { label: string }[] };
    expect(batches.items.map((b) => b.label)).toContain(
      `补充文件 ${new Date().toLocaleDateString("en-CA")}`,
    );
    expect(w.env.modelCalls).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("says why a supplement was refused and keeps the paper as it was", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    const sent = uploads(page);
    await page.goto(`${w.origin}/?literature=${missingId}&reader=pdf`);
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("menuitem", { name: "上传 PDF", exact: true }).click();
    await page.getByLabel("PDF 文件", { exact: true }).setInputFiles({
      name: "not-a-paper.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("<html>Sign in to read</html>"),
    });
    await page.getByRole("button", { name: "确认上传", exact: true }).click();
    await page.getByText("这个文件不是可接受的 PDF。").waitFor();
    expect(sent.map((r) => r.path)).toEqual([
      `/api/v1/intake/literatures/${missingId}/pdf`,
    ]);
    expect((await w.env.app.library.detail(missingId)).primary_pdf).toBeNull();
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);

it("accepts a PDF from the workspace's advanced tools through intake as well", async () => {
  const w = await nextWorkspace({
    path: "/?view=set&setting=advanced",
    ready: "#maintenance-pdf",
  });
  try {
    const page = w.page;
    const sent = uploads(page);
    await page.getByLabel("文献编号", { exact: true }).fill(missingId);
    const bytes = large();
    await page.locator("#maintenance-pdf").setInputFiles({
      name: "paper.pdf",
      mimeType: "application/pdf",
      buffer: bytes,
    });
    await page.getByRole("button", { name: "接纳 PDF", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "接纳 PDF", exact: true })
      .click();
    await page
      .getByText("PDF 已上传，归入今天的“补充文件”批次；原有材料保留。")
      .first()
      .waitFor({ timeout: 60_000 });
    expect(sent).toEqual([
      {
        path: `/api/v1/intake/literatures/${missingId}/pdf`,
        name: "paper.pdf",
      },
    ]);
    expect(
      (await w.env.app.library.detail(missingId)).primary_pdf?.asset.size_bytes,
    ).toBe(bytes.length);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120000);
