import { describe, expect, it } from "vitest";
import {
  ObservationRepository,
  ReferenceRepository,
} from "../src/storage/sqlite/repositories.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";

const makeLiterature = (id: string) => ({
  literature_id: id as never,
  meta_literature_id: "00000000-0000-0000-0000-000000000031" as never,
  version_role: "published" as const,
  status: "UNREVIEWED" as const,
  metadata: {
    title: id,
    authors: [],
    abstract: null,
    publication_date: null,
    publication_year: 2026,
    document_type: "article",
    language: "en",
    venue: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    identifiers: [
      {
        namespace: "doi",
        value: id.endsWith("32") ? "10.1000/source" : "10.1000/target",
      },
    ],
    keywords: [],
  },
});

describe("literature reference repository", () => {
  it("keeps one directed edge and rejects self references", async () => {
    const worker = new SqliteWorker();
    try {
      await worker.putLiterature(
        makeLiterature("00000000-0000-0000-0000-000000000032"),
      );
      await worker.putLiterature(
        makeLiterature("00000000-0000-0000-0000-000000000033"),
      );
      const repository = new ReferenceRepository(worker);
      const edge = {
        reference_id: "00000000-0000-0000-0000-000000000034" as never,
        source_literature_id: "00000000-0000-0000-0000-000000000032" as never,
        target_literature_id: "00000000-0000-0000-0000-000000000033" as never,
      };
      await expect(repository.publish(edge)).resolves.toBe(true);
      await expect(repository.publish(edge)).resolves.toBe(true);
      const observations = new ObservationRepository(worker);
      await observations.publishProviderRelation({
        observation_id: "00000000-0000-0000-0000-000000000036",
        provenance: {
          provenance_id: "00000000-0000-0000-0000-000000000037",
          source_kind: "metadata-provider",
          source_name: "citation-provider",
          source_record_id: "relation-1",
          observed_at: "2026-09-09T00:00:00Z",
          input_sha256: null,
          parameters_sha256: null,
        },
        citing: {
          record_id: "source",
          identifiers: [{ namespace: "doi", value: "10.1000/source" }],
        },
        cited: {
          record_id: "target",
          identifiers: [{ namespace: "doi", value: "10.1000/target" }],
        },
      });
      await expect(
        repository.supportWithProviderObservation(
          edge.reference_id,
          "00000000-0000-0000-0000-000000000036",
        ),
      ).resolves.toBe(true);
      const metadata = new ObservationRepository(worker);
      await metadata.publish({
        observation_id: "00000000-0000-0000-0000-000000000062",
        literature_id: edge.source_literature_id,
        provenance: {
          provenance_id: "00000000-0000-0000-0000-000000000063",
          source_kind: "metadata-provider",
          source_name: "citation-provider",
          source_record_id: "metadata-1",
          observed_at: "2026-09-09T00:00:00Z",
          input_sha256: null,
          parameters_sha256: null,
        },
        version_role: "published",
        reference_count: null,
        cited_by_count: null,
        metadata: {
          title: "Source",
          authors: [],
          abstract: null,
          publication_date: null,
          publication_year: 2026,
          document_type: "article",
          language: "en",
          venue: null,
          publisher: null,
          volume: null,
          issue: null,
          pages: null,
          identifiers: [],
          keywords: [],
        },
        declared_keywords: [],
        reference_texts: ["A source reference text"],
      });
      await expect(
        repository.supportWithMetadataReferenceText(
          edge.reference_id,
          "00000000-0000-0000-0000-000000000062",
          0,
        ),
      ).resolves.toBe(true);
      await expect(
        repository.supportWithMetadataReferenceText(
          edge.reference_id,
          "00000000-0000-0000-0000-000000000062",
          1,
        ),
      ).rejects.toBeDefined();
      await expect(repository.snapshot()).resolves.toEqual([
        {
          reference: edge,
          supports: [
            {
              kind: "provider_relation",
              observation_id: "00000000-0000-0000-0000-000000000036",
            },
            {
              kind: "metadata_reference_text",
              metadata_observation_id: "00000000-0000-0000-0000-000000000062",
              reference_index: 0,
            },
          ],
        },
      ]);
      await expect(
        repository.publish({
          ...edge,
          reference_id: "00000000-0000-0000-0000-000000000035" as never,
          target_literature_id: edge.source_literature_id,
        }),
      ).rejects.toBeDefined();
      await expect(worker.snapshotCounts()).resolves.toMatchObject({
        tables: { literature_references: 1 },
      });
    } finally {
      await worker.close();
    }
  });
});
