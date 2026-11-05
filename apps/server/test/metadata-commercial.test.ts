import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CoreRestAdapter,
  ElsevierRestAdapter,
  MetadataService,
  SpringerRestAdapter,
  WebOfScienceStarterRestAdapter,
  WebOfScienceExpandedRestAdapter,
  topicSearchQuery,
} from "../src/index.js";

const ids = () => ({
  observationId: () => "00000000-0000-4000-8e00-000000000001",
  provenanceId: () => "00000000-0000-4000-8e00-000000000002",
  clock: () => "2026-09-11T00:00:00Z",
});

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      resolve("tests/fixtures/metadata/web_of_science", name),
      "utf8",
    ),
  ) as unknown;
}

describe("commercial metadata REST adapters", () => {
  it("uses the canonical CORE search endpoint and maps records with outgoing references", async () => {
    const calls: string[] = [];
    const adapter = new CoreRestAdapter({
      origin: "https://api.core.test",
      apiKey: "fixture-key",
      pageSize: 1,
      ...ids(),
      transport: {
        async request(url, options) {
          expect(new URL(url).pathname).toBe("/v3/search/works/");
          calls.push(`${url}|${JSON.stringify(options?.headers ?? {})}`);
          return {
            totalHits: 1,
            limit: 1,
            offset: 0,
            results: [
              {
                id: 143,
                title: "CORE fixture",
                doi: "DOI:10.1000/CORE",
                authors: [{ name: "Ada Example" }],
                references: [
                  { id: "200", doi: "10.1000/target", raw: "Target" },
                ],
                downloadUrl: "https://core.ac.uk/download/143.pdf",
              },
            ],
          };
        },
      },
    });
    const result = await new MetadataService({
      topic_search_ports: [adapter],
    }).searchTopicProvider("core", topicSearchQuery("retrieval"), 10);
    expect(result.observations[0]?.provenance.source_record_id).toBe(
      "work:143",
    );
    expect(result.relations[0]?.cited.identifiers).toContainEqual({
      namespace: "doi",
      value: "10.1000/target",
    });
    expect(calls[0]).toContain("/v3/search/works/?");
    expect(calls[0]).toContain("Bearer fixture-key");
  });

  it("maps Springer Meta records and drops unsafe asset URLs", async () => {
    const adapter = new SpringerRestAdapter({
      origin: "https://api.springer.test/meta/v2/json",
      apiKey: "springer-key",
      ...ids(),
      transport: {
        async request() {
          return {
            result: [{ total: "1", start: "1", pageLength: "1" }],
            records: [
              {
                identifier: "doi:10.1000/Springer",
                title: "Springer fixture",
                creators: [{ creator: "Ada Example" }],
                publicationName: "Fixture Journal",
                publicationDate: "2026-01-02",
                url: [
                  {
                    format: "pdf",
                    value: "https://link.springer.test/paper.pdf",
                  },
                  {
                    format: "pdf",
                    value:
                      "https://link.springer.test/private.pdf?api_key=secret",
                  },
                ],
              },
            ],
          };
        },
      },
    });
    const result = await new MetadataService({
      topic_search_ports: [adapter],
    }).searchTopicProvider("springer", topicSearchQuery("fixture"), 1);
    expect(result.observations[0]?.metadata.title).toBe("Springer fixture");
    expect(result.observations[0]?.asset_hints).toHaveLength(1);
    expect(result.observations[0]?.provenance.source_record_id).toBe(
      "10.1000/springer",
    );
  });

  it("maps Elsevier Scopus search envelopes and sends credential headers", async () => {
    const calls: { url: string; headers: Readonly<Record<string, string>> }[] =
      [];
    const adapter = new ElsevierRestAdapter({
      origin: "https://api.elsevier.test",
      apiKey: "elsevier-key",
      institutionToken: "institution-token",
      ...ids(),
      transport: {
        async request(url, options) {
          calls.push({ url, headers: options?.headers ?? {} });
          return {
            "search-results": {
              "opensearch:totalResults": "1",
              cursor: { "@current": "*", "@next": null },
              entry: [
                {
                  eid: "2-s2.0-1",
                  "dc:title": "Elsevier fixture",
                  authkeywords: {
                    "author-keyword": [
                      { $: "Spectroscopy" },
                      { $: "Catalysis" },
                    ],
                  },
                  "prism:doi": "DOI:10.1000/Elsevier",
                  "prism:publicationName": "Fixture Journal",
                  "prism:coverDate": "2026-02-03",
                  "citedby-count": "4",
                },
              ],
            },
          };
        },
      },
    });
    const result = await new MetadataService({
      topic_search_ports: [adapter],
    }).searchTopicProvider("elsevier", topicSearchQuery("fixture"), 1);
    expect(result.observations[0]?.metadata.identifiers).toContainEqual({
      namespace: "doi",
      value: "10.1000/elsevier",
    });
    expect(result.observations[0]?.cited_by_count).toBe(4);
    expect(result.observations[0]?.metadata.keywords).toEqual([
      "Spectroscopy",
      "Catalysis",
    ]);
    expect(result.observations[0]?.declared_keywords).toEqual([
      "Spectroscopy",
      "Catalysis",
    ]);
    expect(calls[0]?.headers).toMatchObject({
      "x-els-apikey": "elsevier-key",
      "x-els-insttoken": "institution-token",
    });
  });

  it.each([
    ["array", [{ "@_fa": "true", error: "Result set was empty" }]],
    ["singleton", { "@_fa": "true", error: "Result set was empty" }],
  ])(
    "treats Elsevier's %s empty-result placeholder as exhaustion",
    async (_, entry) => {
      let requests = 0;
      const adapter = new ElsevierRestAdapter({
        ...ids(),
        transport: {
          async request() {
            requests++;
            return {
              "search-results": { "opensearch:totalResults": "0", entry },
            };
          },
        },
      });
      const result = await new MetadataService({
        topic_search_ports: [adapter],
      }).searchTopicProvider(
        "elsevier",
        topicSearchQuery("sciretriever configuration probe"),
        10,
      );
      expect(result).toMatchObject({
        outcome: "EXHAUSTED",
        raw_item_count: 0,
        observations: [],
        relations: [],
        failure: null,
      });
      expect(requests).toBe(1);
    },
  );

  it.each(["singleton", "multiple"] as const)(
    "preserves Elsevier's %s real-record response",
    async (shape) => {
      const first = { eid: "2-s2.0-1", "dc:title": "First Elsevier record" };
      const second = {
        "dc:identifier": "SCOPUS_ID:2",
        "dc:title": "Second Elsevier record",
      };
      const adapter = new ElsevierRestAdapter({
        ...ids(),
        transport: {
          request: async () => ({
            "search-results": {
              entry: shape === "singleton" ? first : [first, second],
            },
          }),
        },
      });
      const result = await new MetadataService({
        topic_search_ports: [adapter],
      }).searchTopicProvider("elsevier", topicSearchQuery("fixture"), 10);
      expect(result).toMatchObject({
        outcome: "EXHAUSTED",
        raw_item_count: shape === "singleton" ? 1 : 2,
        failure: null,
      });
      expect(result.observations.map((o) => o.metadata.title)).toEqual(
        shape === "singleton"
          ? ["First Elsevier record"]
          : ["First Elsevier record", "Second Elsevier record"],
      );
      expect(
        result.observations.map((o) => o.provenance.source_record_id),
      ).toEqual(shape === "singleton" ? ["2-s2.0-1"] : ["2-s2.0-1", "2"]);
    },
  );

  it.each([
    { error: "Result set was empty", "dc:title": "Missing identity" },
    { error: "Result set was empty", eid: null },
    { error: "Result set was empty", coredata: {} },
    { error: "Result set was empty", unexpected: true },
    { error: null },
    {},
  ])(
    "does not hide malformed Elsevier records as empty results: %j",
    async (entry) => {
      const adapter = new ElsevierRestAdapter({
        transport: {
          request: async () => ({ "search-results": { entry: [entry] } }),
        },
      });
      const result = await new MetadataService({
        topic_search_ports: [adapter],
      }).searchTopicProvider("elsevier", topicSearchQuery("fixture"), 10);
      expect(result).toMatchObject({
        outcome: "FAILED",
        raw_item_count: 1,
        observations: [],
        failure: { code: "metadata-record-invalid" },
      });
    },
  );

  it("maps Web of Science Starter pages and DOI/PMID fields", async () => {
    const adapter = new WebOfScienceStarterRestAdapter({
      origin: "https://api.clarivate.test/apis/wos-starter/v2",
      apiKey: "wos-key",
      ...ids(),
      transport: {
        async request() {
          return {
            metadata: { total: 1, page: 1, limit: 1 },
            hits: [
              {
                uid: "WOS:0001",
                title: "WOS fixture",
                identifiers: {
                  doi: "https://doi.org/10.1000/WOS",
                  pmid: "123",
                },
                names: { authors: [{ displayName: "Ada Example" }] },
                source: {
                  sourceTitle: "Fixture Journal",
                  publishYear: 2026,
                  pages: { range: "1-2" },
                },
                citations: [{ db: "WOS", count: 9 }],
                keywords: { authorKeywords: ["retrieval"] },
              },
            ],
          };
        },
      },
    });
    const result = await new MetadataService({
      topic_search_ports: [adapter],
    }).searchTopicProvider("web-of-science", topicSearchQuery("fixture"), 1);
    expect(result.observations[0]?.provenance.source_record_id).toBe(
      "WOS:0001",
    );
    expect(result.observations[0]?.metadata.identifiers).toContainEqual({
      namespace: "doi",
      value: "10.1000/wos",
    });
    expect(result.observations[0]?.cited_by_count).toBe(9);
  });

  it("maps Expanded Full Record fields and paged references with stable directions", async () => {
    const calls: string[] = [];
    const responses = new Map<string, unknown>([
      ["/search:1", await fixture("expanded-search-page-1.json")],
      ["/search:3", await fixture("expanded-search-page-2.json")],
      ["/references:1", await fixture("expanded-references-page-1.json")],
      ["/references:3", await fixture("expanded-references-page-2.json")],
    ]);
    const adapter = new WebOfScienceExpandedRestAdapter({
      origin: "https://wos-api.clarivate.test/api/wos",
      database: "WOS",
      edition: "WOS",
      pageSize: 2,
      ...ids(),
      transport: {
        async request(url) {
          const parsed = new URL(url);
          const first = parsed.searchParams.get("firstRecord") ?? "1";
          const kind = parsed.pathname.endsWith("/references")
            ? "references"
            : "search";
          calls.push(url);
          const value = responses.get(`/${kind}:${first}`);
          if (value === undefined)
            throw new Error(`missing fixture ${kind}:${first}`);
          return value;
        },
      },
    });
    const service = new MetadataService({
      topic_search_ports: [adapter],
      reference_query_ports: [adapter],
    });
    const topic = await service.searchTopicProvider(
      "web-of-science",
      topicSearchQuery("expanded"),
      3,
    );
    expect(topic.outcome).toBe("SCAN_LIMIT_REACHED");
    expect(topic.observations).toHaveLength(3);
    expect(new URL(calls[1]!).searchParams.get("firstRecord")).toBe("3");
    expect(topic.observations[0]?.metadata.title).toBe(
      "A Web of Science Expanded article",
    );
    expect(
      topic.observations[0]?.metadata.authors.map((a) => a.display_name),
    ).toEqual(["Lovelace, Ada", "Turing, Alan"]);
    expect(topic.observations[0]?.metadata.abstract).toContain(
      "First abstract paragraph.",
    );
    expect(topic.observations[0]?.metadata.publisher).toBe(
      "Evidence Publishing",
    );
    expect(topic.observations[0]?.reference_count).toBe(42);
    expect(topic.observations[0]?.cited_by_count).toBe(11);
    expect(topic.observations[0]?.metadata.identifiers).toContainEqual({
      namespace: "doi",
      value: "10.5555/wos.expanded.one",
    });
    const refs = await service.queryReferencesProvider(
      { direction: "references", providers: [] },
      "web-of-science",
      [{ record_id: "WOS:000222222200001", identifiers: [] }],
      3,
    );
    expect(refs.relations).toHaveLength(2);
    expect(refs.relations[0]?.citing.record_id).toBe("WOS:000222222200001");
    expect(refs.relations[0]?.cited.identifiers).toContainEqual({
      namespace: "doi",
      value: "10.5555/wos.reference.one",
    });
    expect(
      calls.some((url) => new URL(url).pathname.endsWith("/references")),
    ).toBe(true);
  });
});
