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
import {
  explicitRetryLiteratureIds,
  selectLiteratures,
  type LiteratureSelector,
} from "../src/entry/selectors.js";

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
              authors: [
                {
                  kind: "person",
                  display_name: `Author ${value}`,
                  given_name: "Author",
                  family_name: String(value),
                  orcid: null,
                  affiliations: [{ name: `Institute ${value}`, ror: null }],
                },
              ],
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
      expect(byLiterature.items[1]?.literature.metadata.authors).toEqual([
        expect.objectContaining({
          display_name: "Author 1",
          affiliations: [{ name: "Institute 1", ror: null }],
        }),
      ]);

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

  it("keeps the exhaustion fact through every expansion and clears it only for an explicit retry or new metadata", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-selector-exhaustion-"),
    );
    const app = await createApplication(home);
    try {
      for (let value = 1; value <= 4; value += 1) {
        await app.database.putLiterature(
          parseLiterature({
            ...FIXTURE_LITERATURE,
            literature_id: id(value),
            meta_literature_id: id(1_000 + value),
            metadata: {
              ...FIXTURE_LITERATURE.metadata,
              title: `Exhaustion paper ${value}`,
              identifiers: [
                { namespace: "doi", value: `10.1000/exhaustion.${value}` },
              ],
            },
          }),
        );
      }
      await app.database.setAutomaticPdfExhaustion(id(1));
      await app.database.setAutomaticPdfExhaustion(id(2));

      const allPending = await selectLiteratures(app.library, {
        kind: "all-pending",
      });
      expect(
        allPending.items.map((item) => item.literature.literature_id),
      ).toEqual([id(3), id(4)]);

      const emptyQuery = parseLibraryQuery({
        text: null,
        title: "Exhaustion paper",
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
      // Explicit selection is the retry; wide selectors keep returning the same targets.
      const explicitSelector: LiteratureSelector = {
        kind: "literatures",
        literature_ids: [parseLiteratureId(id(1))],
      };
      const wideSelectors: readonly LiteratureSelector[] = [
        { kind: "all-pending" },
        { kind: "discovery-run", discovery_run_id: id(9_999) },
        { kind: "query", query: emptyQuery },
        {
          kind: "meta-literatures",
          meta_literature_ids: [parseMetaLiteratureId(id(1_001))],
        },
        {
          kind: "import-report",
          meta_literature_ids: [parseMetaLiteratureId(id(1_002))],
        },
      ];
      expect(
        (await selectLiteratures(app.library, explicitSelector)).items.map(
          (item) => item.literature.literature_id,
        ),
      ).toEqual([id(1)]);
      for (const selector of wideSelectors)
        await selectLiteratures(app.library, selector);
      // Wide selectors still return the marked targets; only all-pending skips them.
      expect(
        (
          await selectLiteratures(app.library, {
            kind: "query",
            query: emptyQuery,
          })
        ).items
          .map((item) => item.literature.literature_id)
          .sort(),
      ).toEqual([id(1), id(2), id(3), id(4)]);
      expect(
        (
          await selectLiteratures(app.library, {
            kind: "meta-literatures",
            meta_literature_ids: [parseMetaLiteratureId(id(1_001))],
          })
        ).items.map((item) => item.literature.literature_id),
      ).toEqual([id(1)]);
      // Only a selector that names concrete Literatures may clear an exhaustion fact.
      expect(explicitRetryLiteratureIds(explicitSelector)).toEqual([id(1)]);
      for (const selector of wideSelectors)
        expect(explicitRetryLiteratureIds(selector)).toEqual([]);
      // No expansion above removed any other Literature's fact.
      expect(await app.database.hasAutomaticPdfExhaustion(id(1))).toBe(true);
      expect(await app.database.hasAutomaticPdfExhaustion(id(2))).toBe(true);

      // The explicit retry clears that target only, and all-pending can select it again.
      for (const literatureId of explicitRetryLiteratureIds(explicitSelector))
        await app.database.clearAutomaticPdfExhaustion(literatureId);
      expect(await app.database.hasAutomaticPdfExhaustion(id(1))).toBe(false);
      expect(await app.database.hasAutomaticPdfExhaustion(id(2))).toBe(true);
      expect(
        (
          await selectLiteratures(app.library, { kind: "all-pending" })
        ).items.map((item) => item.literature.literature_id),
      ).toEqual([id(1), id(3), id(4)]);

      // Accepting a new MetadataObservation clears exactly the accepted Literature's fact.
      const observation = parseMetadataObservation({
        observation_id: id(2_001),
        provenance: {
          provenance_id: id(2_002),
          source_kind: "metadata-provider",
          source_name: "selector-exhaustion-fixture",
          source_record_id: "selector-exhaustion-2",
          observed_at: "2026-09-11T00:00:00Z",
          input_sha256:
            "0000000000000000000000000000000000000000000000000000000000002002",
          parameters_sha256: null,
        },
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: "Exhaustion paper 2",
          identifiers: [{ namespace: "doi", value: "10.1000/exhaustion.2" }],
        },
        version_role: "published",
        version_links: [],
        declared_keywords: [],
        reference_texts: [],
        reference_count: null,
        cited_by_count: null,
        asset_hints: [],
      });
      await app.database.setAutomaticPdfExhaustion(id(1));
      expect(await app.identity.observe(observation)).toMatchObject({
        disposition: "accepted",
        literature_id: id(2),
      });
      expect(await app.database.hasAutomaticPdfExhaustion(id(2))).toBe(false);
      expect(await app.database.hasAutomaticPdfExhaustion(id(1))).toBe(true);
      expect(
        (await app.library.detail(id(2))).literature.metadata.identifiers,
      ).toEqual([{ namespace: "doi", value: "10.1000/exhaustion.2" }]);
      // A replayed observation is not new metadata, so it neither clears nor restores a fact.
      await app.database.setAutomaticPdfExhaustion(id(2));
      expect(await app.identity.observe(observation)).toMatchObject({
        outcome: "matched",
      });
      expect(await app.database.hasAutomaticPdfExhaustion(id(2))).toBe(true);
      // The explicit storage acceptance of a stored observation clears the same fact.
      const stored = parseMetadataObservation({
        ...observation,
        observation_id: id(2_003),
        provenance: {
          ...observation.provenance,
          provenance_id: id(2_004),
          source_record_id: "selector-exhaustion-3",
        },
      });
      await app.observations.publish(stored);
      const snapshot = (await app.database.currentFacts(id(2)))!
        .metadata_snapshot;
      await app.observations.accept(
        stored.observation_id,
        id(2),
        snapshot.revision,
        snapshot.sha256,
      );
      expect(await app.database.hasAutomaticPdfExhaustion(id(2))).toBe(false);
      expect(await app.database.hasAutomaticPdfExhaustion(id(1))).toBe(true);
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
