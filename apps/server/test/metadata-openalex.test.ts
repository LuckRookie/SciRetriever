import { expect, it } from "vitest";
import {
  MetadataService,
  OpenAlexRestAdapter,
  topicSearchQuery,
} from "../src/index.js";

const work = (id: string, title: string) => ({
  id: `https://openalex.org/${id}`,
  doi: `https://doi.org/10.1000/${id}`,
  title,
  publication_year: 2026,
  publication_date: "2026-09-11",
  type: "article",
  language: "en",
  primary_location: { source: { display_name: "OpenAlex Journal" } },
  biblio: { volume: "1", issue: "2", first_page: "1", last_page: "5" },
  authorships: [
    {
      author: {
        display_name: "Ada Lovelace",
        orcid: "https://orcid.org/0000-0002-1825-0097",
      },
    },
  ],
  concepts: [{ display_name: "quantum" }],
  referenced_works: ["https://openalex.org/W2"],
  cited_by_count: 4,
  best_oa_location: { pdf_url: "https://repository.example/openalex.pdf" },
});

it("maps OpenAlex works pages, cursor tokens and DOI lookup", async () => {
  const calls: string[] = [];
  const adapter = new OpenAlexRestAdapter({
    origin: "https://api.openalex.test",
    pageSize: 1,
    observationId: (() => {
      let i = 0;
      return () => `00000000-0000-4000-8700-${String(++i).padStart(12, "0")}`;
    })(),
    provenanceId: (() => {
      let i = 0;
      return () => `00000000-0000-4000-8800-${String(++i).padStart(12, "0")}`;
    })(),
    clock: () => "2026-09-11T00:00:00Z",
    transport: {
      async request(url) {
        calls.push(url);
        if (new URL(url).pathname !== "/works") return work("W1", "Lookup");
        return calls.length === 1
          ? { results: [work("W1", "First")], meta: { next_cursor: "next" } }
          : { results: [work("W2", "Second")], meta: { next_cursor: null } };
      },
    },
  });
  const result = await new MetadataService({
    topic_search_ports: [adapter],
  }).searchTopicProvider("openalex", topicSearchQuery("quantum"), 10);
  expect(result.outcome).toBe("EXHAUSTED");
  expect(result.observations.map((item) => item.metadata.title)).toEqual([
    "First",
    "Second",
  ]);
  expect(result.observations[0]?.metadata.identifiers[0]).toEqual({
    namespace: "doi",
    value: "10.1000/w1",
  });
  expect(result.observations[0]?.asset_hints[0]?.media_type).toBe(
    "application/pdf",
  );
  expect(new URL(calls[1]!).searchParams.get("cursor")).toBe("next");
  const lookup = await new MetadataService({ lookup_ports: [adapter] }).lookup({
    provider_name: "openalex",
    key: { record_id: "W1", identifiers: [] },
    scan_limit: 1,
  });
  expect(lookup.observations[0]?.metadata.title).toBe("Lookup");
});

it("queries OpenAlex outgoing and incoming citation relations", async () => {
  const anchor = work("W1", "Anchor");
  const target = work("W2", "Referenced");
  const calls: string[] = [];
  const adapter = new OpenAlexRestAdapter({
    origin: "https://api.openalex.test",
    pageSize: 2,
    observationId: (() => {
      let i = 0;
      return () => `00000000-0000-4000-8900-${String(++i).padStart(12, "0")}`;
    })(),
    provenanceId: () => "00000000-0000-4000-8a00-000000000001",
    clock: () => "2026-09-11T00:00:00Z",
    transport: {
      async request(url) {
        calls.push(url);
        const parsed = new URL(url);
        if (parsed.pathname === "/works/W1")
          return { ...anchor, referenced_works: ["https://openalex.org/W2"] };
        if (parsed.searchParams.get("filter") === "cites:W1")
          return { results: [target], meta: { next_cursor: null } };
        throw new Error(`unexpected OpenAlex fixture request: ${url}`);
      },
    },
  });
  const service = new MetadataService({
    reference_query_ports: [adapter],
  });
  const result = await service.queryReferencesProvider(
    { direction: "both", providers: [] },
    "openalex",
    [{ record_id: "https://openalex.org/W1", identifiers: [] }],
    10,
  );
  expect(result.outcome).toBe("EXHAUSTED");
  expect(result.relations).toHaveLength(2);
  expect(result.relations[0]?.citing.record_id).toBe("https://openalex.org/W1");
  expect(result.relations[0]?.cited.record_id).toBe("https://openalex.org/W2");
  expect(result.relations[1]?.citing.record_id).toBe("https://openalex.org/W2");
  expect(result.relations[1]?.cited.record_id).toBe("https://openalex.org/W1");
  expect(calls.some((url) => new URL(url).searchParams.has("filter"))).toBe(
    true,
  );
});

it("supports DOI outgoing queries, continues cited-by cursors and removes overlapping self edges", async () => {
  const calls: string[] = [];
  const adapter = new OpenAlexRestAdapter({
    origin: "https://api.openalex.test",
    pageSize: 1,
    observationId: (() => {
      let i = 0;
      return () => `00000000-0000-4000-8d00-${String(++i).padStart(12, "0")}`;
    })(),
    provenanceId: () => "00000000-0000-4000-8e00-000000000001",
    clock: () => "2026-09-11T00:00:00Z",
    transport: {
      async request(url) {
        calls.push(url);
        const parsed = new URL(url);
        if (
          parsed.pathname.includes("doi%3A") ||
          parsed.pathname.includes("doi:")
        )
          return {
            ...work("W1", "DOI anchor"),
            doi: "https://doi.org/10.1000/anchor",
            referenced_works: ["https://openalex.org/W9"],
          };
        const cursor = parsed.searchParams.get("cursor");
        return cursor === "*"
          ? {
              results: [
                {
                  ...work("W2", "Overlapping"),
                  doi: "https://doi.org/10.1000/anchor",
                },
              ],
              meta: { next_cursor: "two" },
            }
          : {
              results: [work("W3", "Citing")],
              meta: { next_cursor: null },
            };
      },
    },
  });
  const service = new MetadataService({ reference_query_ports: [adapter] });
  const outgoing = await service.queryReferencesProvider(
    { direction: "references", providers: [] },
    "openalex",
    [
      {
        record_id: null,
        identifiers: [{ namespace: "doi", value: "10.1000/anchor" }],
      },
    ],
    10,
  );
  expect(outgoing.outcome).toBe("EXHAUSTED");
  expect(outgoing.relations).toHaveLength(1);
  expect(decodeURIComponent(new URL(calls[0]!).pathname)).toBe(
    "/works/doi:10.1000/anchor",
  );

  calls.length = 0;
  const incoming = await service.queryReferencesProvider(
    { direction: "cited-by", providers: [] },
    "openalex",
    [
      {
        record_id: "https://openalex.org/W1",
        identifiers: [{ namespace: "doi", value: "10.1000/anchor" }],
      },
    ],
    10,
  );
  expect(incoming.outcome).toBe("EXHAUSTED");
  expect(incoming.relations).toHaveLength(1);
  expect(incoming.relations[0]?.citing.record_id).toBe(
    "https://openalex.org/W3",
  );
  expect(calls.map((url) => new URL(url).searchParams.get("cursor"))).toEqual([
    "*",
    "two",
  ]);
});

it("fails an OpenAlex cited-by page that replays its cursor", async () => {
  const adapter = new OpenAlexRestAdapter({
    origin: "https://api.openalex.test",
    pageSize: 1,
    transport: {
      async request() {
        return { results: [work("W2", "Replay")], meta: { next_cursor: "*" } };
      },
    },
  });
  const result = await new MetadataService({
    reference_query_ports: [adapter],
  }).queryReferencesProvider(
    { direction: "cited-by", providers: [] },
    "openalex",
    [{ record_id: "https://openalex.org/W1", identifiers: [] }],
    10,
  );
  expect(result.outcome).toBe("FAILED");
});
