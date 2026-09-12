import { describe, expect, it } from "vitest";
import {
  CrossrefRestAdapter,
  MetadataService,
  topicSearchQuery,
} from "../src/index.js";
import { parseCrossrefRecord } from "../src/metadata/crossref-fixture.js";

const record = (doi: string, title: string) => ({
  DOI: doi,
  title: [title],
  author: [
    {
      given: "Ada",
      family: "Lovelace",
      ORCID: "https://orcid.org/0000-0002-1825-0097",
    },
  ],
  published: { "date-parts": [[2026, 9, 11]] },
  type: "journal-article",
  "container-title": ["Fixture Journal"],
  publisher: "Fixture Publisher",
  reference: [{ DOI: "10.1000/reference" }],
  "reference-count": 1,
  "is-referenced-by-count": 2,
});

describe("Crossref REST metadata adapter", () => {
  it("maps Crossref work-list pages into neutral observations", async () => {
    await parseCrossrefRecord(record("10.1000/debug", "Debug"), {
      observation_id: "00000000-0000-4000-8000-000000000001",
      provenance_id: "00000000-0000-4000-8000-000000000002",
      observed_at: "2026-09-11T00:00:00Z",
    });
    const calls: string[] = [];
    const adapter = new CrossrefRestAdapter({
      origin: "https://api.crossref.test",
      mailto: "reader@example.test",
      pageSize: 1,
      observationId: (() => {
        let value = 0;
        return () =>
          `00000000-0000-4000-8001-${String(++value).padStart(12, "0")}`;
      })(),
      provenanceId: (() => {
        let value = 0;
        return () =>
          `00000000-0000-4000-8002-${String(++value).padStart(12, "0")}`;
      })(),
      clock: () => "2026-09-11T00:00:00Z",
      transport: {
        async request(url) {
          calls.push(url);
          return calls.length === 1
            ? {
                status: "ok",
                "message-type": "work-list",
                message: {
                  items: [record("10.1000/one", "First")],
                  "next-cursor": "cursor-2",
                },
              }
            : {
                status: "ok",
                "message-type": "work-list",
                message: {
                  items: [record("10.1000/two", "Second")],
                  "next-cursor": null,
                },
              };
        },
      },
    });

    const result = await new MetadataService({
      topic_search_ports: [adapter],
    }).searchTopicProvider(
      "crossref",
      topicSearchQuery("quantum materials", 2020, 2026),
      10,
    );

    expect(result.outcome).toBe("EXHAUSTED");
    expect(result.raw_item_count).toBe(2);
    expect(
      result.observations.map((item) => item.provenance.source_record_id),
    ).toEqual(["10.1000/one", "10.1000/two"]);
    expect(result.observations[0]?.metadata.title).toBe("First");
    const firstUrl = new URL(calls[0]!);
    expect(firstUrl.pathname).toBe("/works");
    expect(firstUrl.searchParams.get("query.bibliographic")).toBe(
      "quantum materials",
    );
    expect(firstUrl.searchParams.get("filter")).toBe(
      "from-pub-date:2020-01-01,until-pub-date:2026-12-31",
    );
    expect(firstUrl.searchParams.get("mailto")).toBe("reader@example.test");
    expect(new URL(calls[1]!).searchParams.get("cursor")).toBe("cursor-2");
  });

  it("uses DOI lookup and rejects malformed Crossref envelopes", async () => {
    const calls: string[] = [];
    const adapter = new CrossrefRestAdapter({
      origin: "https://api.crossref.test",
      transport: {
        async request(url) {
          calls.push(url);
          return {
            status: "ok",
            "message-type": "work",
            message: record("10.1000/lookup", "Lookup"),
          };
        },
      },
      observationId: () => "00000000-0000-4000-8003-000000000001",
      provenanceId: () => "00000000-0000-4000-8003-000000000002",
      clock: () => "2026-09-11T00:00:00Z",
    });
    const result = await new MetadataService({
      lookup_ports: [adapter],
    }).lookup({
      provider_name: "crossref",
      key: {
        record_id: null,
        identifiers: [{ namespace: "doi", value: "10.1000/lookup" }],
      },
      scan_limit: 1,
    });
    expect(result.observations[0]?.metadata.title).toBe("Lookup");
    expect(new URL(calls[0]!).pathname).toBe("/works/10.1000%2Flookup");

    const invalid = new CrossrefRestAdapter({
      origin: "https://api.crossref.test",
      transport: {
        async request() {
          return { status: "ok", message: {} };
        },
      },
    });
    await expect(
      new MetadataService({
        topic_search_ports: [invalid],
      }).searchTopicProvider("crossref", topicSearchQuery("broken"), 1),
    ).resolves.toMatchObject({ outcome: "FAILED", raw_item_count: 0 });
  });
});
