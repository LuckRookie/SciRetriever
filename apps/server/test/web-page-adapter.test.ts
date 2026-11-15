import { expect, it } from "vitest";
import {
  decodeWebPage,
  webPageAdapter,
} from "../src/literature/web-page-adapter.js";
import type { WebPageData } from "@sciretriever/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/bootstrap/application.js";
const page = (
  url = "https://journal.test/article/abc",
  values: readonly (readonly [string, string])[] = [],
  extra: Partial<WebPageData> = {},
): WebPageData => ({
  url,
  title: null,
  meta: values.map(([key, content]) => ({ attribute: "name", key, content })),
  json_ld: [],
  is_pdf: false,
  ...extra,
});

it("moves the Highwire, Dublin Core and PRISM synthetic page rules to the server", () => {
  const result = decodeWebPage(
    page(undefined, [
      ["citation_title", "Argyrodite  electrolyte one"],
      ["citation_author", "Smith, Alice"],
      ["citation_author", "Lee, Bo"],
      ["citation_doi", "doi:10.5555/ABC.1"],
      ["citation_publication_date", "2021/03/15"],
      ["citation_journal_title", "Journal of Synthetic Results"],
      ["citation_volume", "12"],
      ["citation_issue", "3"],
      ["citation_firstpage", "101"],
      ["citation_lastpage", "110"],
      ["citation_keywords", "Argyrodite; Interface"],
      ["dc.publisher", "Synthetic Press"],
      ["citation_pdf_url", "/article/abc/pdf"],
    ]),
  );
  expect(result.metadata).toMatchObject({
    title: "Argyrodite electrolyte one",
    identifiers: [{ namespace: "doi", value: "10.5555/abc.1" }],
    authors: [{ display_name: "Smith, Alice" }, { display_name: "Lee, Bo" }],
    publication_date: "2021-03-15",
    publication_year: 2021,
    venue: "Journal of Synthetic Results",
    publisher: "Synthetic Press",
    volume: "12",
    issue: "3",
    pages: "101-110",
    keywords: ["Argyrodite", "Interface"],
  });
  expect(result.pdf_url).toBe("https://journal.test/article/abc/pdf");
  expect(result.excluded).toEqual([]);
  expect(
    decodeWebPage(
      page(undefined, [
        ["dc.title", "DC title"],
        ["prism.doi", "10.5555/DC"],
        ["dc.creator", "DC author"],
        ["prism.publicationname", "PRISM journal"],
      ]),
    ).metadata,
  ).toMatchObject({
    title: "DC title",
    venue: "PRISM journal",
    identifiers: [{ namespace: "doi", value: "10.5555/dc" }],
    authors: [{ display_name: "DC author" }],
  });
});
it("reads identifiers from an address and offers arXiv PDF locations without fetching them", () => {
  expect(
    decodeWebPage(page("https://publisher.test/doi/full/10.5555/xyz.42"))
      .metadata.identifiers,
  ).toEqual([{ namespace: "doi", value: "10.5555/xyz.42" }]);
  expect(
    decodeWebPage(
      page("https://arxiv.org/abs/2401.01234v2", [
        ["citation_title", "A preprint"],
      ]),
    ),
  ).toMatchObject({
    metadata: { identifiers: [{ namespace: "arxiv", value: "2401.01234" }] },
    pdf_url: "https://arxiv.org/pdf/2401.01234",
  });
  expect(
    decodeWebPage(
      page(undefined, [
        ["citation_doi", "10.48550/arXiv.2401.01234"],
        ["citation_pdf_url", "javascript:synthetic()"],
      ]),
    ),
  ).toMatchObject({
    metadata: {
      identifiers: [
        { namespace: "doi", value: "10.48550/arxiv.2401.01234" },
        { namespace: "arxiv", value: "2401.01234" },
      ],
    },
    pdf_url: null,
  });
  for (const suffix of [
    ".",
    "/full",
    "/abstract",
    "/pdf",
    "/epdf",
    "/html",
    ".pdf",
  ])
    expect(
      decodeWebPage(
        page(undefined, [["citation_doi", `10.5555/Identifier${suffix}`]]),
      ).metadata.identifiers,
    ).toEqual([{ namespace: "doi", value: "10.5555/identifier" }]);
});
it("routes an actual PDF page toward a file item and retains its exact address as a clue", () => {
  const input = page("https://repository.test/files/10.5555/pdfpage.pdf", [], {
    is_pdf: true,
  });
  expect(decodeWebPage(input)).toMatchObject({
    page: { is_pdf: true },
    pdf_url: input.url,
  });
  expect(webPageAdapter.decode(input, 0).items).toEqual([
    { record_index: 0, reason: "file-required", record: null },
  ]);
});
it("reads supported JSON-LD graphs and nested journal fields, keeping tags ahead of JSON-LD", () => {
  const input = page(undefined, [["og:title", "Lower priority OG title"]], {
    json_ld: [
      JSON.stringify({
        "@graph": [
          { "@type": "Person", name: "Ignored person" },
          {
            "@type": ["Thing", "https://schema.org/MedicalScholarlyArticle"],
            headline: "Structured title",
            author: [
              { name: "A. Synthetic" },
              { givenName: "Bo", familyName: "Tester" },
            ],
            identifier: { propertyID: "DOI", value: "doi:10.5555/STRUCTURED" },
            datePublished: "2020-11-15",
            isPartOf: {
              "@type": "PublicationIssue",
              issueNumber: 2,
              isPartOf: {
                "@type": "PublicationVolume",
                volumeNumber: 8,
                isPartOf: { "@type": "Periodical", name: "Structured journal" },
              },
            },
            publisher: { name: "Structured press" },
            pageStart: 3,
            pageEnd: 9,
            abstract: "Structured abstract",
            inLanguage: "EN",
            keywords: ["First; Second", "Third"],
          },
        ],
      }),
    ],
  });
  const decoded = decodeWebPage(input);
  expect(decoded.metadata).toMatchObject({
    title: "Structured title",
    authors: [{ display_name: "A. Synthetic" }, { display_name: "Bo Tester" }],
    identifiers: [{ namespace: "doi", value: "10.5555/structured" }],
    publication_year: 2020,
    venue: "Structured journal",
    volume: "8",
    issue: "2",
    pages: "3-9",
    language: "en",
    abstract: "Structured abstract",
    publisher: "Structured press",
    keywords: ["First", "Second", "Third"],
  });
  const deep =
    '{"@type":"Article","headline":"Synthetic deep data","author":' +
    "[".repeat(5000) +
    '"Deep Author"' +
    "]".repeat(5000) +
    "}";
  expect(
    decodeWebPage(page(undefined, [], { json_ld: [deep] })).metadata.authors,
  ).toMatchObject([{ display_name: "Deep Author" }]);
  expect(
    decodeWebPage({
      ...input,
      meta: [
        ...input.meta,
        {
          attribute: "name",
          key: "citation_title",
          content: "Preferred tag title",
        },
        { attribute: "name", key: "citation_doi", content: "10.5555/TAG" },
      ],
    }).metadata,
  ).toMatchObject({
    title: "Preferred tag title",
    identifiers: [{ namespace: "doi", value: "10.5555/tag" }],
  });
});
it("counts invalid JSON blocks, ignores unrelated objects, and falls back to the page title", () => {
  const input = page("https://blog.test/post", [], {
    title: "  Only   a page title  ",
    json_ld: [
      "{",
      JSON.stringify({
        "@type": "WebPage",
        headline: "Do not interpret",
        identifier: "10.5555/ignored",
      }),
    ],
  });
  const decoded = decodeWebPage(input);
  expect(decoded).toMatchObject({
    metadata: { title: "Only a page title", identifiers: [] },
    excluded: [{ kind: "invalid-json-ld", count: 1 }],
    pdf_url: null,
  });
  expect(webPageAdapter.decode(input, 9).items[0]!.record).toMatchObject({
    external_id: "page:9",
    metadata: decoded.metadata,
  });
  expect(webPageAdapter.decode(input, 9)).toEqual(
    webPageAdapter.decode(input, 9),
  );
  expect(
    decodeWebPage(
      page(undefined, [], {
        meta: [
          { attribute: "property", key: "OG:TITLE", content: "A blog post" },
        ],
      }),
    ).metadata.title,
  ).toBe("A blog post");
});

it("uses the registered adapter in a real batch and preserves page fields as web-capture provenance", async () => {
  const home = await mkdtemp(
      join(tmpdir(), "sciretriever-page-adapter-batch-"),
    ),
    app = await createApplication(home, {
      indexRefreshIntervalMs: null,
      metadata: { lookup_ports: [] },
    });
  try {
    const batch = await app.importSessions.create(
      { format: "web-page", source: null, scope: "Synthetic page" },
      { kind: "local", origin: "cli" },
    );
    await app.importSessions.putData(
      batch.batch_id,
      0,
      page(undefined, [
        ["citation_title", "Synthetic raw-page title"],
        ["citation_doi", "10.5555/rawpage"],
      ]),
    );
    expect(await app.importSessions.preview(batch.batch_id)).toMatchObject({
      summary: { records: { created: 1 } },
    });
    expect((await app.library.search({ query: {} })).total_count).toBe(0);
    expect(await app.importSessions.confirm(batch.batch_id)).toMatchObject({
      state: "finished",
      result: "completed",
    });
    const found = (await app.library.search({ query: {} })).items[0]!
        .literature,
      detail = await app.library.detail(found.literature_id);
    expect(detail.metadata_observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            title: "Synthetic raw-page title",
          }),
          provenance: expect.objectContaining({
            source_kind: "user",
            source_name: "web-capture",
            input_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          }),
        }),
      ]),
    );
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
