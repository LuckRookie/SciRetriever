import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { missingId } from "./processor-workspace-fixture.js";
import { readerToLibrary } from "./reader-controls.js";
import { workbenchPdf } from "../../server/src/workbench/synthetic-fixture.js";

// Reading experience 6.4: a paper with a PDF and no full text opens the PDF.
// Details read before the PDF arrived must not decide the view.
it("opens the PDF of a paper whose details were cached before its PDF was published", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    const reader = () => new URL(page.url()).searchParams.get("reader");
    const open = () =>
      page
        .locator(`.paper-row[data-literature-id="${missingId}"] .paper-open`)
        .dblclick();
    // First open: no PDF yet, so the bibliography page; its details are
    // now cached in this page.
    await open();
    await expect.poll(reader).toBe("doc");
    await page.getByText("这篇还没有全文。", { exact: true }).waitFor();
    await readerToLibrary(page);
    await page.locator(".paper-row").first().waitFor();
    // The PDF arrives without this page being told (another client, the CLI).
    await w.env.app.maintenance!.ingestPdf({
      literature_id: missingId,
      bytes: Buffer.from(workbenchPdf("10.5555/fresh-detail")),
    });
    // Opened again at once, well inside the cache's freshness: the PDF.
    await open();
    await expect.poll(reader).toBe("pdf");
    await page
      .locator('.reading-pdf-page[data-rendered="true"]')
      .first()
      .waitFor();
    expect(
      await page.getByText("这篇还没有全文。", { exact: true }).count(),
    ).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 90000);
