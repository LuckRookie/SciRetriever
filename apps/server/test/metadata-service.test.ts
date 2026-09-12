import { describe, expect, it } from "vitest";
import {
  MetadataProviderFailure,
  MetadataService,
  CrossrefAdapter,
  createMetadataTransport,
  buildMetadataRegistry,
  configuredMetadataSelections,
  resolveMetadataSelection,
  parseConfiguration,
  topicSearchQuery,
  type RawItemSession,
} from "../src/index.js";
import type { MetadataObservation } from "@sciretriever/contracts";

function session(values: readonly unknown[], exhausted = true): RawItemSession {
  let index = 0;
  return {
    pull_raw_item() {
      if (index >= values.length) return null;
      const item = values[index++];
      return {
        raw_item: item,
        source_exhausted_after: exhausted && index === values.length,
      };
    },
    convert_raw_item(value) {
      if (value === "bad")
        throw new MetadataProviderFailure({
          code: "fixture-invalid",
          reason: "fixture rejected record",
          action: "retry",
          retryable: true,
        });
      return { observations: [], relations: [] };
    },
  };
}

describe("TypeScript Metadata service", () => {
  it("uses the shared AgentTransport boundary for JSON providers", async () => {
    const calls: {
      endpoint: string;
      headers: readonly (readonly [string, string])[];
    }[] = [];
    const transport = createMetadataTransport(async (request) => {
      calls.push({ endpoint: request.endpoint, headers: request.headers });
      return {
        status: 200,
        headers: [],
        body: new TextEncoder().encode('{"items":[],"next_cursor":null}'),
      };
    });
    await expect(
      transport.request("https://api.example.test/works"),
    ).resolves.toEqual({ items: [], next_cursor: null });
    expect(calls[0]?.endpoint).toBe("https://api.example.test/works");
    expect(calls[0]?.headers).toContainEqual(["accept", "application/json"]);
  });

  it("keeps pagination and scan budget inside the provider session", async () => {
    const service = new MetadataService({
      topic_search_ports: [
        {
          provider_name: "fixture",
          open_topic_search: () => session(["one", "two", "three"]),
        },
      ],
    });
    const result = await service.searchTopicProvider(
      "fixture",
      topicSearchQuery("  quantum materials ", 2020, 2024),
      2,
    );
    expect(result).toMatchObject({
      provider_name: "fixture",
      raw_item_count: 2,
      outcome: "SCAN_LIMIT_REACHED",
      failure: null,
    });
  });

  it("retains isolated record failures without leaking vendor values", async () => {
    const service = new MetadataService({
      lookup_ports: [
        {
          provider_name: "fixture",
          open_lookup: () => session(["bad", "good"]),
        },
      ],
    });
    const result = await service.lookup({
      provider_name: "fixture",
      key: { record_id: "fixture-record", identifiers: [] },
      scan_limit: 10,
    });
    expect(result.outcome).toBe("FAILED");
    expect(result.raw_item_count).toBe(2);
    expect(JSON.stringify(result)).not.toContain("bad");
    expect(result.failure?.code).toBe("fixture-invalid");
  });

  it("exposes the closed provider matrix without probing or guessing adapters", () => {
    const registry = buildMetadataRegistry({
      lookup_ports: [
        { provider_name: "opencitations", open_lookup: () => session([]) },
      ],
    });
    expect(registry.statuses).toHaveLength(11);
    expect(
      registry.statuses.find((item) => item.provider_name === "opencitations"),
    ).toMatchObject({
      production_available: false,
      failure_code: "missing-production-adapter",
    });
  });

  it("resolves Auto and Custom metadata source order locally by capability", () => {
    const configuration = parseConfiguration(
      '[sources.metadata]\nmode = "custom"\nproviders = ["core", "crossref"]\n',
    );
    expect(configuredMetadataSelections(configuration)).toEqual({
      topic: ["core", "crossref"],
      reference: ["core"],
    });
    expect(
      resolveMetadataSelection({ mode: "auto", providers: [] }, "topic-search"),
    ).toEqual([
      "crossref",
      "semantic-scholar",
      "arxiv",
      "openalex",
      "europe-pmc",
      "datacite",
      "core",
    ]);
    expect(
      resolveMetadataSelection(
        { mode: "custom", providers: ["opencitations"] },
        "topic-search",
      ),
    ).toEqual([]);
  });

  it("keeps provider pagination and vendor decoding behind the adapter port", async () => {
    const calls: string[] = [];
    const adapter = new CrossrefAdapter(
      {
        async request(url) {
          calls.push(url);
          return calls.length === 1
            ? { items: [{ vendor: "first" }], next_cursor: "next" }
            : { items: [{ vendor: "second" }], next_cursor: null };
        },
      },
      "https://fixture.invalid/api",
      (_value, provider) =>
        ({
          observation_id: "fixture-observation",
          provenance: {
            provenance_id: "fixture-provenance",
            source_kind: "metadata-provider",
            source_name: provider,
            source_record_id: "fixture-record",
            observed_at: "2026-09-11T00:00:00Z",
            input_sha256:
              "0000000000000000000000000000000000000000000000000000000000000000" as never,
            parameters_sha256: null,
          },
          metadata: {
            title: "Fixture",
            authors: [],
            abstract: null,
            publication_date: null,
            publication_year: null,
            document_type: null,
            language: null,
            venue: null,
            publisher: null,
            volume: null,
            issue: null,
            pages: null,
            identifiers: [{ namespace: "doi", value: "10.1000/fixture" }],
            keywords: [],
          },
          version_role: "published",
          version_links: [],
          declared_keywords: [],
          reference_texts: [],
          reference_count: null,
          cited_by_count: null,
          asset_hints: [],
        }) as unknown as MetadataObservation,
    );
    const result = await new MetadataService({
      topic_search_ports: [adapter],
    }).searchTopicProvider("crossref", topicSearchQuery("fixture"), 10);
    expect(result.raw_item_count).toBe(2);
    expect(result.outcome).toBe("EXHAUSTED");
    expect(result.observations).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });
});
