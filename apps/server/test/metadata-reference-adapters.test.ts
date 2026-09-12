import { describe, expect, it } from "vitest";
import {
  DataCiteRestAdapter,
  EuropePmcRestAdapter,
  MetadataService,
  SemanticScholarRestAdapter,
} from "../src/index.js";

const ids = () => ({
  observationId: (() => {
    let i = 0;
    return () => `00000000-0000-4000-8b00-${String(++i).padStart(12, "0")}`;
  })(),
  provenanceId: () => "00000000-0000-4000-8c00-000000000001",
  clock: () => "2026-09-11T00:00:00Z",
});

describe("metadata citation relation adapters", () => {
  it("maps Semantic Scholar references and citations to directed relations", async () => {
    const adapter = new SemanticScholarRestAdapter({
      origin: "https://api.semanticscholar.test/graph/v1",
      pageSize: 2,
      ...ids(),
      transport: {
        async request(url) {
          const parsed = new URL(url);
          if (parsed.pathname.endsWith("/references"))
            return {
              offset: 0,
              next: null,
              data: [{ citedPaper: { paperId: "P2", title: "Target" } }],
            };
          return {
            offset: 0,
            next: null,
            data: [{ citingPaper: { paperId: "P3", title: "Citing" } }],
          };
        },
      },
    });
    const result = await new MetadataService({
      reference_query_ports: [adapter],
    }).queryReferencesProvider(
      { direction: "both", providers: [] },
      "semantic-scholar",
      [{ record_id: "P1", identifiers: [] }],
      10,
    );
    expect(result.outcome).toBe("EXHAUSTED");
    expect(result.relations).toHaveLength(2);
    expect(result.relations[0]?.citing.record_id).toBe("P1");
    expect(result.relations[0]?.cited.record_id).toBe("P2");
    expect(result.relations[1]?.citing.record_id).toBe("P3");
    expect(result.relations[1]?.cited.record_id).toBe("P1");
  });

  it("maps Europe PMC reference and citation envelopes", async () => {
    const adapter = new EuropePmcRestAdapter({
      origin: "https://europepmc.test/rest",
      pageSize: 10,
      ...ids(),
      transport: {
        async request(url) {
          const parsed = new URL(url);
          return parsed.pathname.endsWith("/references")
            ? {
                hitCount: 1,
                request: { offSet: 0 },
                referenceList: {
                  reference: [
                    {
                      source: "MED",
                      id: "2",
                      doi: "10.1000/t",
                      pmid: "2",
                      title: "Referenced title",
                      pubYear: "2020",
                      journalAbbreviation: "J Fixture",
                      volume: "3",
                      issue: "4",
                      pageInfo: "5-9",
                      unstructuredInformation: "Raw cited reference.",
                    },
                  ],
                },
              }
            : {
                hitCount: 1,
                request: { offSet: 0 },
                citationList: {
                  citation: [{ source: "MED", id: "3", doi: "10.1000/c" }],
                },
              };
        },
      },
    });
    const result = await new MetadataService({
      reference_query_ports: [adapter],
    }).queryReferencesProvider(
      { direction: "both", providers: [] },
      "europe-pmc",
      [
        {
          record_id: "MED:1",
          identifiers: [{ namespace: "pmid", value: "1" }],
        },
      ],
      10,
    );
    expect(result.relations).toHaveLength(2);
    expect(result.observations).toHaveLength(3);
    expect(result.relations[0]?.citing.record_id).toBe("MED:1");
    expect(result.relations[1]?.cited.record_id).toBe("MED:1");
    expect(result.observations[0]?.reference_texts).toEqual([
      "Raw cited reference.",
    ]);
    expect(result.observations[0]?.metadata.identifiers).toEqual([
      { namespace: "pmid", value: "1" },
    ]);
    expect(result.observations[0]?.provenance.source_record_id).toBe("MED:1");
    expect(result.observations[1]?.metadata).toMatchObject({
      title: "Referenced title",
      publication_year: 2020,
      venue: "J Fixture",
      volume: "3",
      issue: "4",
      pages: "5-9",
      identifiers: [
        { namespace: "pmid", value: "2" },
        { namespace: "doi", value: "10.1000/t" },
      ],
    });
    expect(result.observations[2]?.reference_texts).toEqual([]);
    expect(result.observations[2]?.metadata.identifiers).toEqual([
      { namespace: "doi", value: "10.1000/c" },
    ]);
  });

  it("retains text-only Europe PMC references without inventing a relation", async () => {
    const adapter = new EuropePmcRestAdapter({
      origin: "https://europepmc.test/rest",
      pageSize: 10,
      ...ids(),
      transport: {
        async request() {
          return {
            hitCount: 1,
            request: { offSet: 0 },
            referenceList: {
              reference: [
                {
                  title: "Text-only record",
                  unstructuredInformation: "Reference without stable target.",
                },
              ],
            },
          };
        },
      },
    });
    const result = await new MetadataService({
      reference_query_ports: [adapter],
    }).queryReferencesProvider(
      { direction: "references", providers: [] },
      "europe-pmc",
      [
        {
          record_id: "MED:1",
          identifiers: [{ namespace: "pmid", value: "1" }],
        },
      ],
      10,
    );
    expect(result.outcome).toBe("EXHAUSTED");
    expect(result.relations).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.reference_texts).toEqual([
      "Reference without stable target.",
    ]);
    expect(result.observations[0]?.metadata.title).toBeNull();
  });

  it("maps DataCite relatedIdentifiers according to the requested direction", async () => {
    const adapter = new DataCiteRestAdapter({
      origin: "https://api.datacite.test",
      ...ids(),
      transport: {
        async request() {
          return {
            data: {
              id: "10.1000/anchor",
              attributes: {
                doi: "10.1000/anchor",
                titles: [{ title: "Anchor" }],
                relatedIdentifiers: [
                  {
                    relatedIdentifier: "10.1000/target",
                    relationType: "Cites",
                    relatedIdentifierType: "DOI",
                  },
                  {
                    relatedIdentifier: "10.1000/source",
                    relationType: "IsCitedBy",
                    relatedIdentifierType: "DOI",
                  },
                ],
              },
            },
          };
        },
      },
    });
    const result = await new MetadataService({
      reference_query_ports: [adapter],
    }).queryReferencesProvider(
      { direction: "both", providers: [] },
      "datacite",
      [
        {
          record_id: "10.1000/anchor",
          identifiers: [{ namespace: "doi", value: "10.1000/anchor" }],
        },
      ],
      10,
    );
    expect(result.relations).toHaveLength(2);
    expect(result.relations[0]?.cited.identifiers[0]?.value).toBe(
      "10.1000/target",
    );
    expect(result.relations[1]?.citing.identifiers[0]?.value).toBe(
      "10.1000/source",
    );
  });

  it("queries every DataCite key instead of silently dropping later anchors", async () => {
    const calls: string[] = [];
    const adapter = new DataCiteRestAdapter({
      origin: "https://api.datacite.test",
      ...ids(),
      transport: {
        async request(url) {
          calls.push(url);
          const anchor = decodeURIComponent(
            new URL(url).pathname.split("/").at(-1)!,
          );
          return {
            data: {
              id: anchor,
              attributes: {
                doi: anchor,
                titles: [{ title: anchor }],
                relatedIdentifiers: [
                  {
                    relatedIdentifier: `${anchor}.target`,
                    relationType: "References",
                    relatedIdentifierType: "DOI",
                  },
                ],
              },
            },
          };
        },
      },
    });
    const result = await new MetadataService({
      reference_query_ports: [adapter],
    }).queryReferencesProvider(
      { direction: "references", providers: [] },
      "datacite",
      ["10.1000/one", "10.1000/two"].map((value) => ({
        record_id: null,
        identifiers: [{ namespace: "doi", value }],
      })),
      10,
    );
    expect(result.outcome).toBe("EXHAUSTED");
    expect(calls).toHaveLength(2);
    expect(
      result.relations.map((item) => item.citing.identifiers[0]?.value),
    ).toEqual(["10.1000/one", "10.1000/two"]);
  });

  it("uses Semantic Scholar identifier namespaces and rejects an empty advancing page", async () => {
    const calls: string[] = [];
    const adapter = new SemanticScholarRestAdapter({
      origin: "https://api.semanticscholar.test/graph/v1",
      pageSize: 2,
      ...ids(),
      transport: {
        async request(url) {
          calls.push(url);
          return { offset: 0, next: 2, data: [] };
        },
      },
    });
    const result = await new MetadataService({
      reference_query_ports: [adapter],
    }).queryReferencesProvider(
      { direction: "references", providers: [] },
      "semantic-scholar",
      [
        {
          record_id: null,
          identifiers: [{ namespace: "doi", value: "10.1000/paper" }],
        },
      ],
      10,
    );
    expect(result.outcome).toBe("FAILED");
    expect(decodeURIComponent(new URL(calls[0]!).pathname)).toContain(
      "/paper/DOI:10.1000/paper/references",
    );
  });

  it("continues Europe PMC relation pages and rejects empty pages before hitCount", async () => {
    const calls: string[] = [];
    const adapter = new EuropePmcRestAdapter({
      origin: "https://europepmc.test/rest",
      pageSize: 1,
      ...ids(),
      transport: {
        async request(url) {
          calls.push(url);
          const page = Number(new URL(url).searchParams.get("page"));
          const offset = page - 1;
          return {
            hitCount: 2,
            request: { offSet: offset },
            referenceList: {
              reference: [
                {
                  source: "MED",
                  id: String(page + 10),
                  doi: `10.1000/${page}`,
                },
              ],
            },
          };
        },
      },
    });
    const result = await new MetadataService({
      reference_query_ports: [adapter],
    }).queryReferencesProvider(
      { direction: "references", providers: [] },
      "europe-pmc",
      [{ record_id: "MED:1", identifiers: [] }],
      10,
    );
    expect(result.outcome).toBe("EXHAUSTED");
    expect(result.relations).toHaveLength(2);
    expect(calls.map((url) => new URL(url).searchParams.get("page"))).toEqual([
      "1",
      "2",
    ]);

    const broken = new EuropePmcRestAdapter({
      origin: "https://europepmc.test/rest",
      pageSize: 1,
      ...ids(),
      transport: {
        async request() {
          return {
            hitCount: 1,
            request: { offSet: 0 },
            referenceList: { reference: [] },
          };
        },
      },
    });
    const failed = await new MetadataService({
      reference_query_ports: [broken],
    }).queryReferencesProvider(
      { direction: "references", providers: [] },
      "europe-pmc",
      [{ record_id: "MED:1", identifiers: [] }],
      10,
    );
    expect(failed.outcome).toBe("FAILED");
  });
});
