import { randomUUID } from "node:crypto";
import { parseMetadataObservation } from "@sciretriever/contracts";
import type { ReferenceQueryPort } from "../src/metadata/ports.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

/** Finite synthetic source. A final null pull, rather than a budget, ends it. */
export function citationLimitsSource(count = 3) {
  const stats = { opens: 0, pulls: 0, exhausted: 0 };
  const port: ReferenceQueryPort = {
    provider_name: "crossref",
    open_reference_query(context) {
      stats.opens++;
      let index = 0;
      return {
        pull_raw_item() {
          stats.pulls++;
          if (index === count) {
            stats.exhausted++;
            return null;
          }
          return { raw_item: ++index, source_exhausted_after: false };
        },
        convert_raw_item(raw) {
          const n = Number(raw);
          const observation = parseMetadataObservation({
            source_type: null,
            source_type_mapping_version: null,
            observation_id: randomUUID(),
            provenance: {
              provenance_id: randomUUID(),
              source_kind: "metadata-provider",
              source_name: "crossref",
              source_record_id: `unlimited-${n}`,
              observed_at: "2026-11-19T00:00:00Z",
              input_sha256: "a".repeat(64),
              parameters_sha256: null,
            },
            metadata: {
              ...FIXTURE_LITERATURE.metadata,
              title: `Synthetic citation ${n}`,
              identifiers: [
                { namespace: "doi", value: `10.5555/unlimited-${n}` },
              ],
            },
            version_role: "published",
            version_links: [],
            declared_keywords: [],
            reference_texts: [],
            reference_count: null,
            cited_by_count: null,
            asset_hints: [],
          });
          const anchor = context.keys[0]!;
          const target = {
            record_id: `unlimited-${n}`,
            identifiers: observation.metadata.identifiers,
          };
          return {
            observations: [observation],
            relations: [
              {
                observation_id: randomUUID(),
                provenance: observation.provenance,
                citing: context.direction === "cited-by" ? target : anchor,
                cited: context.direction === "cited-by" ? anchor : target,
              },
            ],
          };
        },
      };
    },
  };
  return { port, stats, count };
}
