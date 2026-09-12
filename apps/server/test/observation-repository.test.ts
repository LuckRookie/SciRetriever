import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, sha256 } from "@sciretriever/contracts";
import {
  ObservationRepository,
  type MetadataObservation,
} from "../src/storage/sqlite/repositories.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";

const observation: MetadataObservation = {
  observation_id: "00000000-0000-0000-0000-000000000011",
  provenance: {
    provenance_id: "00000000-0000-0000-0000-000000000012",
    source_kind: "user",
    source_name: "bibliographic-import",
    source_record_id: null,
    observed_at: "2026-09-09T00:00:00Z",
    input_sha256: null,
    parameters_sha256: null,
  },
  version_role: "published",
  reference_count: 1,
  cited_by_count: null,
  metadata: {
    title: "Observed title",
    authors: [
      {
        kind: "person",
        display_name: "Grace Hopper",
        given_name: "Grace",
        family_name: "Hopper",
        orcid: null,
        affiliations: [],
      },
    ],
    abstract: "Observed abstract",
    publication_date: null,
    publication_year: 2026,
    document_type: "article",
    language: "en",
    venue: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    identifiers: [{ namespace: "doi", value: "10.1234/observed" }],
    keywords: ["typed"],
  },
  declared_keywords: ["typed"],
  reference_texts: ["A cited work"],
};

describe("metadata observation repository", () => {
  it("publishes an immutable relation-shaped observation and reads it back", async () => {
    const worker = new SqliteWorker();
    try {
      const repository = new ObservationRepository(worker);
      await expect(repository.publish(observation)).resolves.toBe(true);
      await expect(repository.publish(observation)).resolves.toBe(true);
      await expect(
        repository.get(observation.observation_id),
      ).resolves.toMatchObject({
        observation_id: observation.observation_id,
        provenance: {
          source_kind: "user",
          source_name: "bibliographic-import",
        },
        metadata: {
          title: "Observed title",
          identifiers: [{ namespace: "doi" }],
        },
        declared_keywords: ["typed"],
        reference_texts: ["A cited work"],
      });
      await expect(worker.snapshotCounts()).resolves.toMatchObject({
        tables: { metadata_observations: 1, provenances: 1 },
      });
    } finally {
      await worker.close();
    }
  });

  it("stores provider relation endpoints and preserves their provenance", async () => {
    const worker = new SqliteWorker();
    try {
      const repository = new ObservationRepository(worker);
      const relation = {
        observation_id: "00000000-0000-0000-0000-000000000013",
        provenance: {
          provenance_id: "00000000-0000-0000-0000-000000000014",
          source_kind: "metadata-provider" as const,
          source_name: "citation-provider",
          source_record_id: "relation-1",
          observed_at: "2026-09-09T00:00:00Z",
          input_sha256: null,
          parameters_sha256: null,
        },
        citing: {
          record_id: "citing-1",
          identifiers: [{ namespace: "doi", value: "10.1234/citing" }],
        },
        cited: {
          record_id: "cited-1",
          identifiers: [{ namespace: "doi", value: "10.1234/cited" }],
        },
      };
      await expect(repository.publishProviderRelation(relation)).resolves.toBe(
        true,
      );
      await expect(
        repository.getProviderRelation(relation.observation_id),
      ).resolves.toMatchObject({
        provenance: { source_name: "citation-provider" },
        citing: { identifiers: [{ value: "10.1234/citing" }] },
      });
    } finally {
      await worker.close();
    }
  });

  it("accepts an observation only against the expected current metadata revision", async () => {
    const worker = new SqliteWorker();
    try {
      const literature = {
        literature_id: "00000000-0000-0000-0000-000000000015" as never,
        meta_literature_id: "00000000-0000-0000-0000-000000000016" as never,
        version_role: "published" as const,
        status: "UNREVIEWED" as const,
        metadata: {
          title: "Old title",
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
      };
      await worker.putLiterature(literature);
      const repository = new ObservationRepository(worker);
      const candidate = {
        ...observation,
        observation_id: "00000000-0000-0000-0000-000000000017",
      };
      await repository.publish(candidate);
      const currentHash = await sha256(canonicalJsonBytes(literature.metadata));
      await expect(
        repository.accept(
          candidate.observation_id,
          literature.literature_id,
          1,
          currentHash,
        ),
      ).resolves.toBe(true);
      await expect(
        worker.getLiterature(literature.literature_id),
      ).resolves.toMatchObject({
        metadata: { title: "Observed title" },
      });
      await expect(
        repository.accept(
          candidate.observation_id,
          literature.literature_id,
          1,
          currentHash,
        ),
      ).rejects.toBeDefined();
      await expect(
        worker.getLiterature(literature.literature_id),
      ).resolves.toMatchObject({
        metadata: { title: "Observed title" },
      });
    } finally {
      await worker.close();
    }
  });
});
