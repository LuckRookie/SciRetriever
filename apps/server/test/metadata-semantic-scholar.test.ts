import { expect, it } from "vitest";
import {
  MetadataService,
  SemanticScholarRestAdapter,
  topicSearchQuery,
} from "../src/index.js";

const paper = (id: string, title: string) => ({
  paperId: id,
  title,
  abstract: "Abstract",
  year: 2026,
  publicationDate: "2026-09-11",
  authors: [{ name: "Ada Lovelace" }],
  externalIds: { DOI: `10.1000/${id}`, ArXiv: "2401.12345" },
  venue: "Semantic Journal",
  citationCount: 5,
  openAccessPdf: { url: "https://repository.example/semantic.pdf" },
});

it("maps Semantic Scholar search offsets and lookup without exposing API keys", async () => {
  const calls: { url: string; headers?: Readonly<Record<string, string>> }[] =
    [];
  const adapter = new SemanticScholarRestAdapter({
    origin: "https://api.semantic.test/graph/v1",
    apiKey: "synthetic-api-key",
    pageSize: 1,
    observationId: (() => {
      let i = 0;
      return () => `00000000-0000-4000-8900-${String(++i).padStart(12, "0")}`;
    })(),
    provenanceId: (() => {
      let i = 0;
      return () => `00000000-0000-4000-8a00-${String(++i).padStart(12, "0")}`;
    })(),
    clock: () => "2026-09-11T00:00:00Z",
    transport: {
      async request(url, options) {
        calls.push({
          url,
          ...(options?.headers ? { headers: options.headers } : {}),
        });
        if (!new URL(url).pathname.endsWith("/paper/search"))
          return paper("lookup", "Lookup");
        return calls.length === 1
          ? { total: 2, offset: 0, data: [paper("one", "First")], next: 1 }
          : { total: 2, offset: 1, data: [paper("two", "Second")], next: null };
      },
    },
  });
  const result = await new MetadataService({
    topic_search_ports: [adapter],
  }).searchTopicProvider("semantic-scholar", topicSearchQuery("quantum"), 10);
  expect(result.outcome).toBe("EXHAUSTED");
  expect(result.observations.map((item) => item.metadata.title)).toEqual([
    "First",
    "Second",
  ]);
  expect(result.observations[0]?.metadata.identifiers).toContainEqual({
    namespace: "doi",
    value: "10.1000/one",
  });
  expect(result.observations[0]?.asset_hints[0]?.url).toBe(
    "https://repository.example/semantic.pdf",
  );
  expect(calls[0]?.headers?.["x-api-key"]).toBe("synthetic-api-key");
  expect(JSON.stringify(result)).not.toContain("synthetic-api-key");
  const lookup = await new MetadataService({ lookup_ports: [adapter] }).lookup({
    provider_name: "semantic-scholar",
    key: { record_id: "lookup", identifiers: [] },
    scan_limit: 1,
  });
  expect(lookup.observations[0]?.metadata.title).toBe("Lookup");
});

it("converts bare Semantic Scholar PubMedCentral numbers at the vendor boundary", async () => {
  const records = ["1234567", "PMC7654321"].map((value, index) => ({
    ...paper(`pmc-${index}`, "PMC fixture"),
    externalIds: { DOI: `10.5555/pmc-${index}`, PubMedCentral: value },
  }));
  const adapter = new SemanticScholarRestAdapter({
    transport: {
      request: async () => ({ total: 2, offset: 0, data: records }),
    },
  });
  const result = await new MetadataService({
    topic_search_ports: [adapter],
  }).searchTopicProvider("semantic-scholar", topicSearchQuery("fixture"), 10);
  expect(result).toMatchObject({
    outcome: "EXHAUSTED",
    raw_item_count: 2,
    failure: null,
  });
  expect(
    result.observations.map(
      (item) =>
        item.metadata.identifiers.find(
          (identifier) => identifier.namespace === "pmcid",
        )?.value,
    ),
  ).toEqual(["PMC1234567", "PMC7654321"]);
});

it("uses the same canonical PMCID mapping for reference endpoints and observations", async () => {
  const adapter = new SemanticScholarRestAdapter({
    transport: {
      request: async () => ({
        offset: 0,
        data: [
          {
            citedPaper: {
              ...paper("related", "Related fixture"),
              externalIds: { DOI: "10.5555/related", PubMedCentral: "1234567" },
            },
          },
        ],
      }),
    },
  });
  const result = await new MetadataService({
    reference_query_ports: [adapter],
  }).queryReferencesProvider(
    { direction: "references", providers: [] },
    "semantic-scholar",
    [{ record_id: "anchor", identifiers: [] }],
    10,
  );
  expect(result).toMatchObject({ outcome: "EXHAUSTED", failure: null });
  expect(result.relations[0]?.cited.identifiers).toContainEqual({
    namespace: "pmcid",
    value: "PMC1234567",
  });
  expect(result.observations[0]?.metadata.identifiers).toContainEqual({
    namespace: "pmcid",
    value: "PMC1234567",
  });
});
