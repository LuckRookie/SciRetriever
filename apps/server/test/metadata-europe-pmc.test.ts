import { expect, it } from "vitest";
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
