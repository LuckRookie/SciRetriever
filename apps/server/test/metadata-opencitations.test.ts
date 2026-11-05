import { describe, expect, it } from "vitest";
import { MetadataService, OpenCitationsRestAdapter } from "../src/index.js";
import type { ProviderLiteratureKey } from "@sciretriever/contracts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createMetadataTransport } from "../src/providers/shared/metadata-transport.js";

const key = (doi: string): ProviderLiteratureKey => ({
  record_id: null,
  identifiers: [{ namespace: "doi", value: doi }],
});

const ids = () => ({
  observationId: () => "00000000-0000-4000-8d00-000000000001",
  provenanceId: () => "00000000-0000-4000-8d00-000000000002",
  clock: () => "2026-09-11T00:00:00Z",
});

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      resolve("tests/fixtures/metadata/opencitations", name),
      "utf8",
    ),
  ) as unknown;
}

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
    expect(new URL(calls[0]!).pathname).toBe(
      "/meta/v1/metadata/doi%3A10.1000%2Fexample",
    );
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
    expect(new URL(calls[0]!).pathname).toBe(
      "/index/v2/references/doi%3A10.1000%2Fsource",
    );
    expect(() =>
      adapter.open_reference_query({
        direction: "cited-by",
        keys: [key("10.1000/source")],
      }),
    ).toThrow("cited-by capability is unavailable");
  });

  it("maps Meta's multi-PID identity and keeps author/container identifiers out of names", async () => {
    const payload = await fixture("lookup.json");
    const adapter = new OpenCitationsRestAdapter({
      ...ids(),
      transport: { request: async () => payload },
    });
    const result = await new MetadataService({
      lookup_ports: [adapter],
    }).lookup({
      provider_name: "opencitations",
      key: key("10.5555/opencitations.lookup"),
      scan_limit: 1,
    });
    expect(result.failure).toBeNull();
    expect(result.observations).toHaveLength(1);
    const record = result.observations[0]!;
    expect(record.provenance.source_record_id).toBe(
      "10.5555/opencitations.lookup",
    );
    expect(record.metadata.identifiers).toEqual([
      { namespace: "doi", value: "10.5555/opencitations.lookup" },
      { namespace: "pmid", value: "12345678" },
      { namespace: "isbn", value: "9781402096327" },
      { namespace: "openalex", value: "W4249829199" },
      { namespace: "omid", value: "br/0612058700" },
    ]);
    expect(record.metadata.authors.map((a) => a.display_name)).toEqual([
      "Ada Meta",
      "Open Citations Consortium",
    ]);
    expect(record.metadata.authors[0]?.orcid).toBe("0000-0002-1825-0097");
    expect(record.metadata.venue).toBe("Journal of Open Citations");
    expect(record.metadata.publisher).toBe("Example Publisher");
    expect(record.metadata.abstract).toBeNull();
    expect(record.metadata.keywords).toEqual([]);
    expect(record.asset_hints).toEqual([]);
  });

  it.each([
    { record_id: "doi:10.1000/Example", identifiers: [] },
    { record_id: "pmid:12345", identifiers: [] },
    { record_id: null, identifiers: [{ namespace: "omid", value: "br/123" }] },
  ])("addresses Meta lookups with a typed PID", async (key) => {
    let requested = "";
    const adapter = new OpenCitationsRestAdapter({
      transport: {
        request: async (url) => {
          requested = url;
          return [];
        },
      },
    });
    await adapter.open_lookup(key).pull_raw_item();
    const expected = key.record_id?.toLowerCase() ?? "omid:br/123";
    expect(new URL(requested).pathname).toBe(
      `/meta/v1/metadata/${encodeURIComponent(expected)}`,
    );
  });

  it("keeps year-only Meta dates and missing fields without inferring author identities from editors", async () => {
    const payload = await fixture("lookup-year-only.json");
    const adapter = new OpenCitationsRestAdapter({
      transport: { request: async () => payload },
    });
    const result = await new MetadataService({
      lookup_ports: [adapter],
    }).lookup({
      provider_name: "opencitations",
      key: key("10.5555/opencitations.year"),
      scan_limit: 1,
    });
    expect(result.failure).toBeNull();
    expect(result.observations[0]?.metadata).toMatchObject({
      title: null,
      authors: [],
      publication_date: "2009",
      publication_year: 2009,
      venue: null,
      publisher: "Springer Science And Business Media Llc",
    });
  });

  it("maps multi-PID references and declared index prefixes without reversing the edge", async () => {
    const payload = await fixture("references.json");
    const adapter = new OpenCitationsRestAdapter({
      transport: { request: async () => payload },
    });
    const result = await new MetadataService({
      reference_query_ports: [adapter],
    }).queryReferencesProvider(
      { direction: "references", providers: [] },
      "opencitations",
      [key("10.5555/opencitations.anchor")],
      10,
    );
    expect(result).toMatchObject({
      outcome: "EXHAUSTED",
      raw_item_count: 3,
      failure: null,
    });
    expect(result.relations).toHaveLength(3);
    expect(result.relations[0]?.citing.identifiers).toContainEqual({
      namespace: "doi",
      value: "10.5555/opencitations.anchor",
    });
    expect(result.relations[1]?.cited.identifiers).toEqual([
      { namespace: "doi", value: "10.5555/opencitations.cited.two" },
      { namespace: "omid", value: "br/061901512049" },
      { namespace: "openalex", value: "W2035776950" },
    ]);
    expect(result.relations[2]?.cited.identifiers).toEqual([
      { namespace: "openalex", value: "W2035776951" },
    ]);
  });

  it.each([
    "unknown-prefix.json",
    "count-only.json",
    "unsupported-endpoint.json",
  ])("rejects invalid OpenCitations relations from %s", async (name) => {
    const payload = await fixture(name);
    const adapter = new OpenCitationsRestAdapter({
      transport: { request: async () => payload },
    });
    const result = await new MetadataService({
      reference_query_ports: [adapter],
    }).queryReferencesProvider(
      { direction: "references", providers: [] },
      "opencitations",
      [key("10.5555/opencitations.anchor")],
      10,
    );
    expect(result).toMatchObject({ outcome: "FAILED", relations: [] });
  });

  it("reports malformed OpenCitations JSON at the shared HTTP boundary", async () => {
    const body = await readFile(
      resolve("tests/fixtures/metadata/opencitations/malformed.json"),
    );
    const adapter = new OpenCitationsRestAdapter({
      transport: createMetadataTransport(async () => ({
        status: 200,
        headers: [["content-type", "application/json"]],
        body,
      })),
    });
    const result = await new MetadataService({
      lookup_ports: [adapter],
    }).lookup({
      provider_name: "opencitations",
      key: key("10.1000/example"),
      scan_limit: 1,
    });
    expect(result).toMatchObject({
      outcome: "FAILED",
      raw_item_count: 0,
      observations: [],
      failure: { code: "metadata-provider-response-invalid" },
    });
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
