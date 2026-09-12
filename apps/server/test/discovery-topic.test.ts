import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMetadataObservation } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import type { RawItemSession } from "../src/metadata/ports.js";

const observation = parseMetadataObservation({
  observation_id: "00000000-0000-4000-8f00-000000000001",
  provenance: {
    provenance_id: "00000000-0000-4000-8f00-000000000002",
    source_kind: "metadata-provider",
    source_name: "fixture",
    source_record_id: "fixture-1",
    observed_at: "2026-09-11T00:00:00Z",
    input_sha256:
      "0000000000000000000000000000000000000000000000000000000000000001",
    parameters_sha256: null,
  },
  metadata: {
    title: "Discovery fixture",
    authors: [],
    abstract: null,
    publication_date: "2026-01-01",
    publication_year: 2026,
    document_type: "article",
    language: "en",
    venue: "Fixture Journal",
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    identifiers: [{ namespace: "doi", value: "10.1000/discovery-fixture" }],
    keywords: [],
  },
  version_role: "published",
  version_links: [],
  declared_keywords: [],
  reference_texts: [],
  reference_count: null,
  cited_by_count: null,
  asset_hints: [],
});

const session = (): RawItemSession => {
  let delivered = false;
  return {
    pull_raw_item: () => {
      if (delivered) return null;
      delivered = true;
      return { raw_item: observation, source_exhausted_after: true };
    },
    convert_raw_item: () => ({ observations: [observation], relations: [] }),
  };
};

describe("topic discovery migration slice", () => {
  it("publishes provider outcomes, identity causes and a durable run", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-discovery-"));
    const application = await createApplication(home, {
      metadata: {
        topic_search_ports: [
          {
            provider_name: "fixture",
            open_topic_search: () => session(),
          },
        ],
      },
    });
    try {
      const report = await application.discovery.run({
        query: "  retrieval ",
        year_from: 2020,
        year_to: 2026,
        providers: [{ provider_name: "fixture", scan_limit: 5 }],
      });
      expect(report.status).toBe("COMPLETED");
      expect(report.accepted_count).toBe(1);
      expect(report.matched_count).toBe(0);
      const durable = await application.database.getDiscovery(
        report.discovery_run_id,
      );
      expect(durable?.run).toMatchObject({
        kind: "topic",
        status: "COMPLETED",
        query: "retrieval",
      });
      expect(durable?.results).toHaveLength(1);
      expect(durable?.topic_causes).toHaveLength(1);
      expect(
        (await application.database.snapshotCounts()).tables.discovery_runs,
      ).toBe(1);

      const partial = await application.discovery.run({
        query: "retrieval",
        providers: [
          { provider_name: "unavailable-fixture", scan_limit: 2 },
          { provider_name: "fixture", scan_limit: 5 },
        ],
      });
      expect(partial).toMatchObject({
        status: "PARTIAL",
        accepted_count: 0,
        matched_count: 1,
        source_results: [
          { provider_name: "unavailable-fixture", outcome: "FAILED" },
          { provider_name: "fixture", outcome: "EXHAUSTED" },
        ],
      });
      const durablePartial = await application.database.getDiscovery(
        partial.discovery_run_id,
      );
      expect(durablePartial?.run.status).toBe("PARTIAL");
      expect(durablePartial?.results).toHaveLength(1);
      expect(durablePartial?.topic_causes).toHaveLength(1);
      expect(
        await application.database.findLiteratureByIdentifiers([
          { namespace: "doi", value: "10.1000/discovery-fixture" },
        ]),
      ).toHaveLength(1);
    } finally {
      await application.close();
    }
  });
});
