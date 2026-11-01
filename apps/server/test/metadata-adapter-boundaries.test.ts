import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, sha256 } from "@sciretriever/contracts";
import {
  ArxivRestAdapter,
  CoreRestAdapter,
  CrossrefRestAdapter,
  DataCiteRestAdapter,
  ElsevierRestAdapter,
  EuropePmcRestAdapter,
  MetadataService,
  OpenAlexRestAdapter,
  OpenCitationsRestAdapter,
  SemanticScholarRestAdapter,
  SpringerRestAdapter,
  WebOfScienceStarterRestAdapter,
  WebOfScienceExpandedRestAdapter,
  topicSearchQuery,
} from "../src/index.js";
import { createApplication } from "../src/bootstrap/application.js";
import type { TopicSearchPort } from "../src/metadata/ports.js";
import type { MetadataTransport } from "../src/providers/shared/metadata-transport.js";

const query = topicSearchQuery("chemistry");
const doi = "10.1000/field-boundary";
const badTitle = "unusable\u0000title";
const expandedPage = (items: unknown) => ({
  QueryResult: { RecordsFound: Array.isArray(items) ? items.length : 1 },
  Data: { Records: { records: { REC: items } } },
});
type Case = {
  name: string;
  make: (transport: MetadataTransport) => TopicSearchPort;
  record: (title: string) => unknown;
  page: (items: unknown) => unknown;
};
const cases: Case[] = [
  {
    name: "Crossref",
    make: (transport) => new CrossrefRestAdapter({ transport }),
    record: (title) => ({
      DOI: doi,
      title: [title],
      author: [null, { given: "Ada", family: "Example", ORCID: "bad" }],
      published: { "date-parts": [[2024, null, 15]] },
    }),
    page: (items) => ({
      status: "ok",
      "message-type": "work-list",
      message: { items },
    }),
  },
  {
    name: "Europe PMC",
    make: (transport) => new EuropePmcRestAdapter({ transport }),
    record: (title) => ({
      id: "123",
      source: "MED",
      doi,
      title,
      pubYear: "2024 draft",
      keywordList: { keyword: [null, "chemistry"] },
    }),
    page: (items) => ({ resultList: { result: items }, nextCursorMark: null }),
  },
  {
    name: "Semantic Scholar",
    make: (transport) => new SemanticScholarRestAdapter({ transport }),
    record: (title) => ({
      paperId: "fixture-paper",
      title,
      externalIds: { DOI: doi },
      year: "2024 draft",
      citationCount: -1,
      authors: [null, { name: "Ada" }],
    }),
    page: (items) => ({
      offset: 0,
      total: Array.isArray(items) ? items.length : 1,
      data: items,
      next: null,
    }),
  },
  {
    name: "OpenAlex",
    make: (transport) => new OpenAlexRestAdapter({ transport }),
    record: (title) => ({
      id: "https://openalex.org/W123",
      doi,
      title,
      publication_year: "2024 draft",
      authorships: [{ author: { display_name: "Ada", orcid: "bad" } }],
    }),
    page: (items) => ({ results: items, meta: { next_cursor: null } }),
  },
  {
    name: "DataCite",
    make: (transport) => new DataCiteRestAdapter({ transport }),
    record: (title) => ({
      id: doi,
      attributes: {
        doi,
        titles: [{ title }],
        publicationYear: "2024 draft",
        creators: [
          {
            name: "Ada",
            nameIdentifiers: [
              {
                nameIdentifierScheme: "ORCID",
                nameIdentifier: "https://orcid.org/0000-0002-1825-0097",
              },
            ],
          },
        ],
      },
    }),
    page: (items) => ({ data: items, links: {} }),
  },
  {
    name: "CORE",
    make: (transport) => new CoreRestAdapter({ transport }),
    record: (title) => ({
      id: 123,
      doi,
      title,
      yearPublished: "2024 draft",
      authors: [{ name: "Ada", orcid: "bad" }],
    }),
    page: (items) => ({
      results: items,
      totalHits: Array.isArray(items) ? items.length : 1,
      offset: 0,
      limit: 25,
    }),
  },
  {
    name: "Elsevier",
    make: (transport) => new ElsevierRestAdapter({ transport }),
    record: (title) => ({
      eid: "2-s2.0-1",
      "prism:doi": doi,
      "dc:title": title,
      "prism:coverDate": "2024 draft",
      "citedby-count": "unknown",
    }),
    page: (items) => ({
      "search-results": { entry: items, cursor: { "@next": null } },
    }),
  },
  {
    name: "Springer",
    make: (transport) => new SpringerRestAdapter({ transport }),
    record: (title) => ({
      identifier: `doi:${doi}`,
      title,
      year: "2024 draft",
      creators: [{ creator: "Ada", orcid: "bad" }],
    }),
    page: (items) => ({
      records: items,
      result: [
        {
          total: String(Array.isArray(items) ? items.length : 1),
          start: "1",
          pageLength: "25",
        },
      ],
    }),
  },
  {
    name: "WoS Starter",
    make: (transport) => new WebOfScienceStarterRestAdapter({ transport }),
    record: (title) => ({
      uid: "WOS:123",
      title,
      identifiers: { doi },
      source: { publishYear: "2024 draft" },
      names: { authors: [{ displayName: "Ada", orcid: "bad" }] },
    }),
    page: (items) => ({
      hits: items,
      metadata: {
        total: Array.isArray(items) ? items.length : 1,
        page: 1,
        limit: 50,
      },
    }),
  },
  {
    name: "WoS Expanded",
    make: (transport) => new WebOfScienceExpandedRestAdapter({ transport }),
    record: (title) => ({
      UID: "WOS:123",
      static_data: {
        summary: {
          titles: { title: [{ type: "item", content: title }] },
          pub_info: { pubyear: "2024 draft" },
        },
        item: { identifiers: { identifier: [{ type: "doi", value: doi }] } },
      },
    }),
    page: expandedPage,
  },
];
async function search(spec: Case, payload: unknown, limit = 10) {
  const adapter = spec.make({ request: async () => payload });
  return new MetadataService({
    topic_search_ports: [adapter],
  }).searchTopicProvider(adapter.provider_name, query, limit);
}

describe.each(cases)("$name metadata boundaries", (spec) => {
  it("retains identity when optional fields are unusable", async () => {
    const result = await search(spec, spec.page([spec.record(badTitle)]));
    expect(result).toMatchObject({ outcome: "EXHAUSTED", raw_item_count: 1 });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.metadata).toMatchObject({
      title: null,
      identifiers: [{ namespace: "doi", value: doi }],
    });
    expect(result.observations[0]!.metadata.publication_year).toBe(
      spec.name === "Crossref" ? 2024 : null,
    );
    if (spec.name === "DataCite")
      expect(result.observations[0]!.metadata.authors[0]?.orcid).toBe(
        "0000-0002-1825-0097",
      );
    expect(result.observations[0]!.provenance.input_sha256).toBe(
      await sha256(canonicalJsonBytes(spec.record(badTitle))),
    );
  });
  it("counts invalid raw records and continues to later valid records", async () => {
    const result = await search(
      spec,
      spec.page([null, spec.record("Valid\n title")]),
    );
    expect(result).toMatchObject({ outcome: "FAILED", raw_item_count: 2 });
    expect(result.observations.map((o) => o.metadata.title)).toEqual([
      "Valid title",
    ]);
    const limited = await search(
      spec,
      spec.page([null, spec.record("Beyond budget")]),
      1,
    );
    expect(limited.raw_item_count).toBe(1);
    expect(limited.observations).toEqual([]);
  });
  it("fails malformed response lists instead of claiming exhaustion", async () => {
    expect(await search(spec, spec.page("not-a-list"))).toMatchObject({
      outcome: "FAILED",
      raw_item_count: 0,
    });
  });
});

it("keeps bounded arXiv Atom parsing, isolates bad entries and accepts an empty feed", async () => {
  const scan = async (response: string) => {
    const adapter = new ArxivRestAdapter({
      transport: { request: async () => response },
    });
    return new MetadataService({
      topic_search_ports: [adapter],
    }).searchTopicProvider("arxiv", query, 10);
  };
  const result = await scan(
    '<feed xmlns="http://www.w3.org/2005/Atom"><entry/><entry><id>https://arxiv.org/abs/2401.12345</id><title>Good\n title</title><published>2024-01-02T00:00:00Z</published></entry></feed>',
  );
  expect(result).toMatchObject({ outcome: "FAILED", raw_item_count: 2 });
  expect(result.observations[0]?.metadata).toMatchObject({
    title: "Good title",
    publication_date: "2024-01-02",
    publication_year: 2024,
  });
  expect(
    await scan(
      "<feed><entry><id>https://arxiv.org/abs/2401.12345</id><title>bad\u0000</title></entry></feed>",
    ),
  ).toMatchObject({
    outcome: "EXHAUSTED",
    observations: [{ metadata: { title: null } }],
  });
  expect(
    await scan('<feed xmlns="http://www.w3.org/2005/Atom"/>'),
  ).toMatchObject({ outcome: "EXHAUSTED", raw_item_count: 0 });
  expect(await scan("<html>Service unavailable</html>")).toMatchObject({
    outcome: "FAILED",
    raw_item_count: 0,
  });
  expect(
    await scan("<feed><entry><title>Incomplete entry</title></feed>"),
  ).toMatchObject({ outcome: "FAILED", raw_item_count: 0 });
});

it("isolates OpenCitations records and enforces the relation raw budget", async () => {
  const adapter = new OpenCitationsRestAdapter({
    transport: {
      request: async () => [
        null,
        { doi, title: badTitle },
        { doi, title: "Valid" },
      ],
    },
  });
  const result = await new MetadataService({ lookup_ports: [adapter] }).lookup({
    provider_name: "opencitations",
    key: { record_id: doi, identifiers: [] },
    scan_limit: 10,
  });
  expect(result).toMatchObject({ outcome: "FAILED", raw_item_count: 3 });
  expect(result.observations.map((o) => o.metadata.title)).toEqual([
    null,
    "Valid",
  ]);
  const references = new OpenCitationsRestAdapter({
    transport: {
      request: async () => [
        { oci: "oci-one", citing: doi, cited: "10.1000/one" },
        { oci: "oci-bad", citing: doi, cited: "invalid-doi" },
        { oci: "oci-two", citing: doi, cited: "10.1000/two" },
      ],
    },
  });
  const service = new MetadataService({ reference_query_ports: [references] });
  const limited = await service.queryReferencesProvider(
    { direction: "references", providers: [] },
    "opencitations",
    [{ record_id: doi, identifiers: [] }],
    1,
  );
  expect(limited).toMatchObject({ raw_item_count: 1 });
  expect(limited.relations).toHaveLength(1);
  const all = await service.queryReferencesProvider(
    { direction: "references", providers: [] },
    "opencitations",
    [{ record_id: doi, identifiers: [] }],
    10,
  );
  expect(all).toMatchObject({ outcome: "FAILED", raw_item_count: 3 });
  expect(all.relations).toHaveLength(2);
});

it("rejects invalid paging rather than repairing protocol controls as metadata", async () => {
  const pages = [
    ["DataCite", { data: [], links: { next: 42 } }],
    ["DataCite", { data: [], links: "bad" }],
    ["CORE", { totalHits: null, offset: 0, limit: 25, results: [] }],
    ["CORE", { totalHits: 5, offset: 0, limit: 25, results: [] }],
    ["Springer", { records: [], result: [{}] }],
    [
      "Springer",
      { records: [], result: [{ total: "5", start: "1", pageLength: "25" }] },
    ],
    [
      "WoS Starter",
      { hits: [], metadata: { total: false, page: 1, limit: 50 } },
    ],
    ["Elsevier", { "search-results": { entry: [], cursor: { "@next": 4 } } }],
  ] as const;
  for (const [name, payload] of pages) {
    expect(
      await search(cases.find((spec) => spec.name === name)!, payload),
      name,
    ).toMatchObject({ outcome: "FAILED", raw_item_count: 0 });
  }
});

it("uses CORE's reported progress when the service returns smaller pages", async () => {
  const offsets: string[] = [];
  const adapter = new CoreRestAdapter({
    pageSize: 25,
    transport: {
      request: async (url) => {
        const offset = new URL(url).searchParams.get("offset")!;
        offsets.push(offset);
        return {
          totalHits: 2,
          offset: Number(offset),
          limit: 1,
          results: [{ id: Number(offset) + 1, title: `Record ${offset}` }],
        };
      },
    },
  });
  const result = await new MetadataService({
    topic_search_ports: [adapter],
  }).searchTopicProvider("core", query, 10);
  expect(result).toMatchObject({ outcome: "EXHAUSTED", raw_item_count: 2 });
  expect(result.observations).toHaveLength(2);
  expect(offsets).toEqual(["0", "1"]);
});

it("retains WoS Expanded identity without optional bibliographic containers", async () => {
  const spec = cases.find((c) => c.name === "WoS Expanded")!;
  const result = await search(
    spec,
    expandedPage([{ UID: "WOS:123", static_data: { summary: null } }]),
  );
  expect(result).toMatchObject({
    outcome: "EXHAUSTED",
    observations: [
      {
        provenance: { source_record_id: "WOS:123" },
        metadata: { title: null },
      },
    ],
  });
});

it("persists valid observations and provenance through discovery despite another bad identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-field-boundaries-"));
  const records = [
    {
      DOI: doi,
      title: ["Useful\n title"],
      abstract: "bad\u0000",
      author: [{ name: "Ada", ORCID: "invalid" }],
      published: { "date-parts": [[2024, null, 12]] },
    },
    { DOI: "not-a-doi", title: ["Rejected identity"] },
    { DOI: "10.1000/after-bad-record", title: ["Later record"] },
  ];
  const adapter = new CrossrefRestAdapter({
    transport: { request: async () => cases[0]!.page(records) },
  });
  const app = await createApplication(home, {
    metadata: { topic_search_ports: [adapter] },
  });
  let literatureId: string;
  let observationId: string;
  try {
    const report = await app.discovery.run({
      origin: "cli",
      query: "chemistry",
      providers: [{ provider_name: "crossref", scan_limit: 10 }],
    });
    expect(report).toMatchObject({
      status: "FAILED",
      accepted_count: 2,
      source_results: [{ outcome: "FAILED" }],
    });
    const literatures = await app.database.findLiteratureByIdentifiers([
      { namespace: "doi", value: doi },
    ]);
    expect(literatures).toHaveLength(1);
    const literature = literatures[0]!;
    literatureId = literature.literature_id;
    expect(literature.metadata).toMatchObject({
      title: "Useful title",
      abstract: null,
      publication_date: "2024",
      authors: [{ display_name: "Ada", orcid: null }],
    });
    const durable = await app.database.getDiscovery(report.discovery_run_id);
    observationId = durable!.topic_causes.find(
      (r) => r.actual_literature_id === literatureId,
    )!.metadata_observation_id;
    const stored = await app.database.getObservation(observationId);
    expect(stored?.provenance.input_sha256).toBe(
      await sha256(canonicalJsonBytes(records[0])),
    );
  } finally {
    await app.close();
  }
  const reopened = await createApplication(home);
  try {
    expect(
      (await reopened.database.getLiterature(literatureId))?.metadata.title,
    ).toBe("Useful title");
    expect(
      (await reopened.database.getObservation(observationId))?.metadata
        .abstract,
    ).toBeNull();
  } finally {
    await reopened.close();
    await rm(home, { recursive: true, force: true });
  }
});
