import { expect, it } from "vitest";
import type { ProviderLiteratureKey } from "@sciretriever/contracts";
import {
  EuropePmcRestAdapter,
  MetadataService,
  topicSearchQuery,
} from "../src/index.js";

const result = (id: string, title: string) => ({
  id,
  pmid: id,
  pmcid: `PMC${id}`,
  doi: `10.1000/${id}`,
  title,
  authorList: {
    author: [
      { fullName: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace" },
    ],
  },
  abstractText: "An abstract.",
  pubYear: "2026",
  firstPublicationDate: "2026-09-11",
  pubType: "journal article",
  journalTitle: "Europe PMC Journal",
  journalVolume: "1",
  issue: "2",
  pageInfo: "1-10",
  citedByCount: 3,
  fullTextUrlList: {
    fullTextUrl: [
      { documentStyle: "pdf", url: "https://europepmc.example/article.pdf" },
    ],
  },
  keywordList: { keyword: ["quantum", "materials"] },
});

it("translates publication years and typed identifiers to Europe PMC field queries", async () => {
  const calls: URL[] = [];
  const adapter = new EuropePmcRestAdapter({
    transport: {
      async request(url) {
        calls.push(new URL(url));
        return { resultList: { result: [] } };
      },
    },
  });
  await adapter
    .open_topic_search(topicSearchQuery("photoredox OR organic", 2015, 2025))
    .pull_raw_item();
  await adapter
    .open_topic_search(topicSearchQuery("photoredox", null, 2025))
    .pull_raw_item();
  const keys: ProviderLiteratureKey[] = [
    { record_id: "MED:12345", identifiers: [] },
    { record_id: "PPR:PPR123", identifiers: [] },
    {
      record_id: null,
      identifiers: [{ namespace: "doi", value: "10.1000/example" }],
    },
    {
      record_id: null,
      identifiers: [{ namespace: "pmcid", value: "PMC12345" }],
    },
    { record_id: null, identifiers: [{ namespace: "pmid", value: "12345" }] },
  ];
  for (const key of keys) await adapter.open_lookup(key).pull_raw_item();
  expect(calls.map((url) => url.searchParams.get("query"))).toEqual([
    "(photoredox OR organic) AND PUB_YEAR:[2015 TO 2025]",
    "(photoredox) AND PUB_YEAR:[1 TO 2025]",
    'EXT_ID:"12345" AND SRC:MED',
    'EXT_ID:"PPR123" AND SRC:PPR',
    'DOI:"10.1000/example"',
    'PMCID:"PMC12345"',
    'EXT_ID:"12345" AND SRC:MED',
  ]);
  expect(
    calls.every(
      (url) =>
        !url.searchParams.has("year_from") && !url.searchParams.has("year_to"),
    ),
  ).toBe(true);
});

it.each(["references", "cited-by"] as const)(
  "uses page ordinals for %s with multiple records per page",
  async (direction) => {
    const calls: URL[] = [];
    const adapter = new EuropePmcRestAdapter({
      pageSize: 2,
      transport: {
        async request(url) {
          const u = new URL(url);
          calls.push(u);
          const page = Number(u.searchParams.get("page"));
          const items = [0, 1].map((i) => ({
            source: "MED",
            id: String(page * 10 + i),
            title: "Related work",
          }));
          return {
            hitCount: 4,
            request: { offSet: direction === "references" ? page : page - 1 },
            ...(direction === "references"
              ? { referenceList: { reference: items } }
              : { citationList: { citation: items } }),
          };
        },
      },
    });
    const output = await new MetadataService({
      reference_query_ports: [adapter],
    }).queryReferencesProvider(
      { direction, providers: [] },
      "europe-pmc",
      [{ record_id: "MED:1", identifiers: [] }],
      10,
    );
    expect(output.outcome).toBe("EXHAUSTED");
    expect(output.relations).toHaveLength(4);
    expect(calls.map((u) => u.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(output.observations[0]?.metadata.identifiers).toContainEqual({
      namespace: "pmid",
      value: "10",
    });
  },
);

it("maps Europe PMC JSON search pages and lookup records", async () => {
  const calls: string[] = [];
  const adapter = new EuropePmcRestAdapter({
    origin: "https://europepmc.test/rest",
    pageSize: 1,
    observationId: (() => {
      let i = 0;
      return () => `00000000-0000-4000-8300-${String(++i).padStart(12, "0")}`;
    })(),
    provenanceId: (() => {
      let i = 0;
      return () => `00000000-0000-4000-8400-${String(++i).padStart(12, "0")}`;
    })(),
    clock: () => "2026-09-11T00:00:00Z",
    transport: {
      async request(url) {
        calls.push(url);
        if (new URL(url).searchParams.get("query")?.startsWith("EXT_ID:"))
          return {
            resultList: { result: [result("1", "Lookup")] },
            nextCursorMark: null,
          };
        return calls.length === 1
          ? {
              resultList: { result: [result("1", "First")] },
              nextCursorMark: "next",
            }
          : {
              resultList: { result: [result("2", "Second")] },
              nextCursorMark: null,
            };
      },
    },
  });
  const search = await new MetadataService({
    topic_search_ports: [adapter],
  }).searchTopicProvider("europe-pmc", topicSearchQuery("quantum"), 10);
  expect(search.outcome).toBe("EXHAUSTED");
  expect(search.observations.map((item) => item.metadata.title)).toEqual([
    "First",
    "Second",
  ]);
  expect(search.observations[0]?.metadata.identifiers).toEqual([
    { namespace: "doi", value: "10.1000/1" },
    { namespace: "pmid", value: "1" },
    { namespace: "pmcid", value: "PMC1" },
  ]);
  expect(search.observations[0]?.asset_hints[0]?.asset_role).toBe(
    "primary-pdf",
  );
  expect(new URL(calls[0]!).searchParams.get("pageSize")).toBe("1");
  expect(new URL(calls[1]!).searchParams.get("cursorMark")).toBe("next");

  const lookup = await new MetadataService({ lookup_ports: [adapter] }).lookup({
    provider_name: "europe-pmc",
    key: { record_id: "123", identifiers: [] },
    scan_limit: 1,
  });
  expect(lookup.observations[0]?.provenance.source_record_id).toBe("1");
});
