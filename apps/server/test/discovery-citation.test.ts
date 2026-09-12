import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseLiterature,
  parseMetadataObservation,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import type {
  MetadataLookupPort,
  RawItemSession,
  ReferenceQueryPort,
} from "../src/metadata/ports.js";

const targetObservation = parseMetadataObservation({
  observation_id: "00000000-0000-4000-9000-000000000001",
  provenance: {
    provenance_id: "00000000-0000-4000-9000-000000000002",
    source_kind: "metadata-provider",
    source_name: "fixture",
    source_record_id: "target-record",
    observed_at: "2026-09-11T00:00:00Z",
    input_sha256:
      "0000000000000000000000000000000000000000000000000000000000000002",
    parameters_sha256: null,
  },
  metadata: {
    title: "Citation target",
    authors: [],
    abstract: null,
    publication_date: "2025-01-01",
    publication_year: 2025,
    document_type: "article",
    language: null,
    venue: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    identifiers: [{ namespace: "doi", value: "10.1000/citation-target" }],
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

const seed = parseLiterature({
  literature_id: "00000000-0000-4000-9000-000000000010",
  meta_literature_id: "00000000-0000-4000-9000-000000000011",
  version_role: "published",
  status: "UNREVIEWED",
  metadata: {
    ...targetObservation.metadata,
    title: "Citation seed",
    identifiers: [{ namespace: "doi", value: "10.1000/citation-seed" }],
  },
});

const rawSession = (value: unknown): RawItemSession => {
  let delivered = false;
  return {
    pull_raw_item: () => {
      if (delivered) return null;
      delivered = true;
      return { raw_item: value, source_exhausted_after: true };
    },
    convert_raw_item: () => ({ observations: [], relations: [] }),
  };
};

describe("citation discovery migration slice", () => {
  it("resolves one provider relation, materializes a Reference and persists a cause", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-citation-"));
    const relation = {
      observation_id: "00000000-0000-4000-9000-000000000003",
      provenance: targetObservation.provenance,
      citing: {
        record_id: null,
        identifiers: [{ namespace: "doi", value: "10.1000/citation-seed" }],
      },
      cited: {
        record_id: null,
        identifiers: [{ namespace: "doi", value: "10.1000/citation-target" }],
      },
    };
    const referencePort: ReferenceQueryPort = {
      provider_name: "fixture",
      open_reference_query: () => ({
        ...rawSession(relation),
        convert_raw_item: () => ({ observations: [], relations: [relation] }),
      }),
    };
    const lookupPort: MetadataLookupPort = {
      provider_name: "fixture",
      open_lookup: () => ({
        ...rawSession(targetObservation),
        convert_raw_item: () => ({
          observations: [targetObservation],
          relations: [],
        }),
      }),
    };
    const application = await createApplication(home, {
      metadata: {
        reference_query_ports: [referencePort],
        lookup_ports: [lookupPort],
      },
    });
    try {
      await application.database.putLiterature(seed);
      const report = await application.citations.run({
        seed_literature_ids: [seed.literature_id],
        direction: "references",
        max_depth: 1,
        result_limit: 5,
        providers: [
          { provider_name: "unavailable-fixture", scan_limit: 5 },
          { provider_name: "fixture", scan_limit: 5 },
        ],
      });
      expect(report.status).toBe("PARTIAL");
      expect(report.result_count).toBe(1);
      expect(report.source_results).toMatchObject([
        { provider_name: "unavailable-fixture", outcome: "FAILED" },
        { provider_name: "fixture", outcome: "EXHAUSTED" },
      ]);
      const durable = await application.database.getDiscovery(
        report.discovery_run_id,
      );
      expect(durable?.run).toMatchObject({
        kind: "citation",
        direction: "references",
        max_depth: 1,
        status: "PARTIAL",
      });
      expect(durable?.source_results).toHaveLength(2);
      expect(durable?.citation_causes).toHaveLength(1);
      expect(
        await application.library.referenceDetail(
          (await application.database.referenceSnapshot())[0]?.reference
            .reference_id ?? "",
        ),
      ).not.toBeNull();
    } finally {
      await application.close();
    }
  });
});
