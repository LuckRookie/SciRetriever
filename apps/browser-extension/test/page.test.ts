import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { readPage, type WebPageData } from "../src/page.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

/** Serves `html` at `url` and reads it the way the popup injects the reader. */
async function read(url: string, html: string): Promise<WebPageData> {
  const page = await browser.newPage();
  try {
    await page.route("**/*", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: html }),
    );
    await page.goto(url);
    return await page.evaluate(readPage);
  } finally {
    await page.close();
  }
}

it("hands over the page as it is: address, title, every name and property meta, JSON-LD text", async () => {
  const ld =
    '{"@context":"https://schema.org","@type":"ScholarlyArticle","headline":"Argyrodite"}';
  const page = await read(
    "https://journal.test/article/abc?ref=list",
    `<html><head><title>Argyrodite | Journal</title>
      <meta name="citation_title" content="Argyrodite  electrolyte one">
      <meta name="citation_author" content="Smith, Alice">
      <meta name="citation_author" content="Lee, Bo">
      <meta name="citation_doi" content="doi:10.5555/ABC.1">
      <meta property="og:title" content="Argyrodite (og)">
      <meta name="DC.Publisher" content="Synthetic Press">
      <meta name="citation_pdf_url" content="/article/abc/pdf">
      <meta charset="utf-8"><meta http-equiv="refresh" content="999">
      <script type="application/ld+json">${ld}</script>
      <script type="application/ld+json">{not json</script>
    </head><body></body></html>`,
  );
  // Nothing is read into fields: no DOI, no PDF address, no cleaning.
  expect(page).toEqual({
    url: "https://journal.test/article/abc?ref=list",
    title: "Argyrodite | Journal",
    meta: [
      {
        attribute: "name",
        key: "citation_title",
        content: "Argyrodite  electrolyte one",
      },
      { attribute: "name", key: "citation_author", content: "Smith, Alice" },
      { attribute: "name", key: "citation_author", content: "Lee, Bo" },
      { attribute: "name", key: "citation_doi", content: "doi:10.5555/ABC.1" },
      { attribute: "property", key: "og:title", content: "Argyrodite (og)" },
      { attribute: "name", key: "DC.Publisher", content: "Synthetic Press" },
      {
        attribute: "name",
        key: "citation_pdf_url",
        content: "/article/abc/pdf",
      },
    ],
    // Invalid JSON-LD is handed over too: the library leaves it out and counts it.
    json_ld: [ld, "{not json"],
    is_pdf: false,
  });
});

it("says when the page is itself a PDF, and has no title when there is none", async () => {
  const page = await read(
    "https://repository.test/files/10.5555/pdfpage.pdf",
    "<html></html>",
  );
  expect(page).toEqual({
    url: "https://repository.test/files/10.5555/pdfpage.pdf",
    title: null,
    meta: [],
    json_ld: [],
    is_pdf: true,
  });
});

it("keeps within the contract: 500 meta, 5 JSON-LD blocks of 64 KiB, 512 KiB in all", async () => {
  const metas = Array.from(
    { length: 520 },
    (_, i) => `<meta name="k${i}" content="v${i}">`,
  ).join("");
  const big = `{"@type":"Article","text":"${"x".repeat(70 * 1024)}"}`;
  const blocks = [big, ...Array.from({ length: 6 }, (_, i) => `{"n":${i}}`)]
    .map((text) => `<script type="application/ld+json">${text}</script>`)
    .join("");
  const page = await read(
    "https://journal.test/limits",
    `<html><head>${metas}${blocks}</head></html>`,
  );
  expect(page.meta).toHaveLength(500);
  expect(page.meta.at(-1)).toEqual({
    attribute: "name",
    key: "k499",
    content: "v499",
  });
  // The block over 64 KiB is left out whole, then the first five are kept.
  expect(page.json_ld).toEqual(
    Array.from({ length: 5 }, (_, i) => `{"n":${i}}`),
  );
  const total = new TextEncoder().encode(JSON.stringify(page)).byteLength;
  expect(total).toBeLessThanOrEqual(512 * 1024);
});
