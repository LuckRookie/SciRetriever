import { describe, expect, it } from "vitest";
import { MetadataService, OpenCitationsRestAdapter } from "../src/index.js";
import type { ProviderLiteratureKey } from "@sciretriever/contracts";

const key = (doi: string): ProviderLiteratureKey => ({
  record_id: null,
  identifiers: [{ namespace: "doi", value: doi }],
});

const ids = () => ({
  observationId: () => "00000000-0000-4000-8d00-000000000001",
  provenanceId: () => "00000000-0000-4000-8d00-000000000002",
  clock: () => "2026-09-11T00:00:00Z",
});

describe("OpenCitations REST metadata adapter", () => {
  it("maps Meta records and DOI lookup through the shared transport", async () => {
    const calls: string[] = [];
    const adapter = new OpenCitationsRestAdapter({
      origin: "https://api.opencitations.test",
      ...ids(),
      transport: {
        async request(url) {
          calls.push(url);
          return [
            {
              oci: "061.123/00000001",
              doi: "https://doi.org/10.1000/Example",
              title: "A metadata fixture",
              author: "Ada Lovelace; Grace Hopper",
              pub_date: "2026-09-11",
              type: "journal article",
              venue: "Fixture Journal",
              volume: "2",
              issue: "3",
              page: "10-20",
            },
          ];
        },
      },
    });
    const result = await new MetadataService({
      lookup_ports: [adapter],
    }).lookup({
      provider_name: "opencitations",
      key: key("10.1000/example"),
      scan_limit: 1,
    });
    expect(result.outcome).toBe("SCAN_LIMIT_REACHED");
    expect(result.observations[0]?.provenance.source_record_id).toBe(
      "10.1000/example",
    );
    expect(
      result.observations[0]?.metadata.authors.map((item) => item.display_name),
    ).toEqual(["Ada Lovelace", "Grace Hopper"]);
    expect(new URL(calls[0]!).pathname).toBe("/meta/v1/10.1000%2Fexample");
  });

  it("maps references, preserves the OCI relation identity, and rejects cited-by", async () => {
    const calls: string[] = [];
    const adapter = new OpenCitationsRestAdapter({
      origin: "https://api.opencitations.test",
      ...ids(),
      transport: {
        async request(url) {
          calls.push(url);
          return [
            {
              oci: "061.123/00000002",
              citing: "10.1000/source",
              cited: "10.1000/target",
            },
          ];
        },
      },
    });
    const result = await new MetadataService({
      reference_query_ports: [adapter],
    }).queryReferences({
      direction: "references",
      providers: [
        {
          provider_name: "opencitations",
          keys: [key("10.1000/source")],
          scan_limit: 10,
        },
      ],
    });
    expect(result.providers[0]?.relations[0]).toMatchObject({
      provenance: {
        source_name: "opencitations",
        source_record_id: "061.123/00000002",
      },
      citing: { identifiers: [{ namespace: "doi", value: "10.1000/source" }] },
      cited: { identifiers: [{ namespace: "doi", value: "10.1000/target" }] },
    });
    expect(new URL(calls[0]!).pathname).toBe("/index/v2/10.1000%2Fsource");
    expect(() =>
      adapter.open_reference_query({
        direction: "cited-by",
        keys: [key("10.1000/source")],
      }),
    ).toThrow("cited-by capability is unavailable");
  });

  it("retains empty and malformed relation responses as provider outcomes", async () => {
    const empty = new OpenCitationsRestAdapter({
      origin: "https://api.opencitations.test",
      transport: {
        async request() {
          return [];
        },
      },
    });
    await expect(
      new MetadataService({ lookup_ports: [empty] }).lookup({
        provider_name: "opencitations",
        key: key("10.1000/empty"),
        scan_limit: 1,
      }),
    ).resolves.toMatchObject({ outcome: "EXHAUSTED", raw_item_count: 0 });

    const malformed = new OpenCitationsRestAdapter({
      origin: "https://api.opencitations.test",
      transport: {
        async request() {
          return [{ oci: "061.123/00000003", citing: "10.1000/source" }];
        },
      },
    });
    const result = await new MetadataService({
      reference_query_ports: [malformed],
    }).queryReferences({
      direction: "references",
      providers: [
        {
          provider_name: "opencitations",
          keys: [key("10.1000/source")],
          scan_limit: 1,
        },
      ],
    });
    expect(result.providers[0]).toMatchObject({
      outcome: "FAILED",
      raw_item_count: 1,
      relations: [],
    });
  });
});
