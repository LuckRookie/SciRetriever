import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseLibraryQuery,
  parseLiterature,
  parseLiteratureId,
  parseMetaLiteratureId,
  parseMetadataObservation,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { selectLiteratures } from "../src/entry/selectors.js";

const id = (value: number) =>
  `00000000-0000-4000-9000-${String(value).padStart(12, "0")}`;

describe("six Literature selectors", () => {
  it("expands complete scopes, preserves explicit order and rejects missing IDs", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-selectors-"));
    const app = await createApplication(home);
    try {
      for (let value = 1; value <= 102; value += 1) {
        await app.database.putLiterature(
          parseLiterature({
            ...FIXTURE_LITERATURE,
            literature_id: id(value),
            meta_literature_id: id(1_000 + value),
            metadata: {
              ...FIXTURE_LITERATURE.metadata,
              title: `Selector paper ${String(value).padStart(3, "0")}`,
              identifiers: [
                { namespace: "doi", value: `10.1000/selector.${value}` },
              ],
            },
          }),
        );
      }

      const query = parseLibraryQuery({
        text: "Selector paper",
        title: null,
        author: null,
        author_orcids: [],
        identifiers: [],
        publication_year_from: null,
        publication_year_to: null,
        venue: null,
        publisher: null,
        document_types: [],
        languages: [],
        keywords: [],
        version_roles: [],
        statuses: [],
        missing_steps: [],
        needs_manual_pdf: null,
        discovery_run_ids: [],
      });
      const byQuery = await selectLiteratures(app.library, {
        kind: "query",
        query,
      });
      expect(byQuery.items).toHaveLength(102);
      expect(byQuery.next_cursor).toBeNull();

      const allPending = await selectLiteratures(app.library, {
        kind: "all-pending",
      });
      expect(allPending.items).toHaveLength(102);

      const literatureOrder = [
        parseLiteratureId(id(2)),
        parseLiteratureId(id(1)),
        parseLiteratureId(id(2)),
      ];
      const byLiterature = await selectLiteratures(app.library, {
        kind: "literatures",
        literature_ids: literatureOrder,
      });
      expect(
        byLiterature.items.map((item) => item.literature.literature_id),
      ).toEqual([id(2), id(1)]);

      const metaOrder = [
        parseMetaLiteratureId(id(1_002)),
        parseMetaLiteratureId(id(1_001)),
        parseMetaLiteratureId(id(1_002)),
      ];
      for (const kind of ["meta-literatures", "import-report"] as const) {
        const selected = await selectLiteratures(app.library, {
          kind,
          meta_literature_ids: metaOrder,
        });
        expect(
          selected.items.map((item) => item.literature.meta_literature_id),
        ).toEqual([id(1_002), id(1_001)]);
      }

      await expect(
        selectLiteratures(app.library, {
          kind: "literatures",
          literature_ids: [parseLiteratureId(id(999_999))],
        }),
      ).rejects.toMatchObject({ code: "literature-not-found" });

      const observation = parseMetadataObservation({
        observation_id: id(2_001),
        provenance: {
          provenance_id: id(2_002),
          source_kind: "metadata-provider",
          source_name: "selector-fixture",
          source_record_id: "selector-1",
          observed_at: "2026-09-11T00:00:00Z",
          input_sha256:
            "0000000000000000000000000000000000000000000000000000000000002001",
          parameters_sha256: null,
        },
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: "Selector paper 001",
          identifiers: [{ namespace: "doi", value: "10.1000/selector.1" }],
        },
        version_role: "published",
        version_links: [],
        declared_keywords: [],
        reference_texts: [],
        reference_count: null,
        cited_by_count: null,
        asset_hints: [],
      });
      await app.observations.publish(observation);
      const facts = await app.database.currentFacts(id(1));
      await app.observations.accept(
        observation.observation_id,
        id(1),
        facts!.metadata_snapshot.revision,
        facts!.metadata_snapshot.sha256,
      );
      await app.database.putDiscovery({
        run: {
          discovery_run_id: id(3_001),
          kind: "topic",
          status: "COMPLETED",
          started_at: "2026-09-11T00:00:00Z",
          query: "selector",
          year_from: null,
          year_to: null,
        },
        providers: [],
        source_results: [],
        results: [{ meta_literature_id: id(1_001) }],
        topic_causes: [
          {
            meta_literature_id: id(1_001),
            metadata_observation_id: observation.observation_id,
            actual_literature_id: id(1),
          },
        ],
        citation_causes: [],
      });
      const byRun = await selectLiteratures(app.library, {
        kind: "discovery-run",
        discovery_run_id: id(3_001),
      });
      expect(byRun.items.map((item) => item.literature.literature_id)).toEqual([
        id(1),
      ]);
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
