import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { readPage, type PageReading } from "../src/page.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

/** Serves `html` at `url` and reads it the way the popup injects the reader. */
async function read(url: string, html: string): Promise<PageReading> {
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

it("reads Highwire, Dublin Core and PRISM tags, resolving the PDF address", async () => {
  const reading = await read(
    "https://journal.test/article/abc",
    `<html><head>
      <meta name="citation_title" content="Argyrodite  electrolyte one">
      <meta name="citation_author" content="Smith, Alice">
      <meta name="citation_author" content="Lee, Bo">
      <meta name="citation_doi" content="doi:10.5555/ABC.1">
      <meta name="citation_publication_date" content="2021/03/15">
      <meta name="citation_journal_title" content="Journal of Synthetic Results">
      <meta name="citation_volume" content="12"><meta name="citation_issue" content="3">
      <meta name="citation_firstpage" content="101"><meta name="citation_lastpage" content="110">
      <meta name="citation_keywords" content="Argyrodite; Interface">
      <meta name="dc.publisher" content="Synthetic Press">
      <meta name="citation_pdf_url" content="/article/abc/pdf">
    </head><body></body></html>`,
  );
  expect(reading).toMatchObject({
    doi: "10.5555/abc.1",
    arxiv: null,
    title: "Argyrodite electrolyte one",
    authors: ["Smith, Alice", "Lee, Bo"],
    date: "2021/03/15",
    journal: "Journal of Synthetic Results",
    publisher: "Synthetic Press",
    volume: "12",
    issue: "3",
    first_page: "101",
    last_page: "110",
    keywords: ["Argyrodite", "Interface"],
    pdf_url: "https://journal.test/article/abc/pdf",
    is_pdf: false,
  });
});

it("takes the DOI from the address when the page has no tags", async () => {
  const reading = await read(
    "https://publisher.test/doi/full/10.5555/xyz.42",
    "<html><head><title>x</title></head></html>",
  );
  expect(reading).toMatchObject({ doi: "10.5555/xyz.42", pdf_url: null });
});

it("reads an arXiv number and offers its PDF", async () => {
  const reading = await read(
    "https://arxiv.org/abs/2401.01234v2",
    '<html><head><meta name="citation_title" content="A preprint"></head></html>',
  );
  expect(reading).toMatchObject({
    arxiv: "2401.01234v2",
    doi: null,
    pdf_url: "https://arxiv.org/pdf/2401.01234v2",
  });
});

it("treats an address ending in .pdf as the PDF itself", async () => {
  const reading = await read(
    "https://repository.test/files/10.5555/pdfpage.pdf",
    "<html></html>",
  );
  expect(reading).toMatchObject({
    is_pdf: true,
    doi: "10.5555/pdfpage",
    pdf_url: "https://repository.test/files/10.5555/pdfpage.pdf",
  });
});

it("finds nothing on a page without identifiers", async () => {
  const reading = await read(
    "https://blog.test/post",
    '<html><head><meta property="og:title" content="A blog post"></head></html>',
  );
  expect(reading).toMatchObject({
    doi: null,
    arxiv: null,
    title: "A blog post",
    pdf_url: null,
  });
});
