import { randomUUID } from "node:crypto";
import {
  EMPTY_METADATA,
  parseMetadataObservation,
  type MetadataObservation,
} from "@sciretriever/contracts";
import type {
  MetadataLookupPort,
  RawItemSession,
  TopicSearchPort,
} from "../../server/src/metadata/ports.js";

/** A work as a metadata source would return it; every value is synthetic. */
export function work(
  title: string,
  doi: string,
  source = "crossref",
  family = "Tester",
) {
  return parseMetadataObservation({
    observation_id: randomUUID(),
    metadata: {
      ...EMPTY_METADATA,
      title,
      publication_year: 2026,
      authors: [
        {
          kind: "person",
          display_name: `Ada ${family}`,
          given_name: "Ada",
          family_name: family,
          orcid: null,
          affiliations: [],
        },
      ],
      identifiers: [{ namespace: "doi", value: doi }],
    },
    provenance: {
      provenance_id: randomUUID(),
      source_kind: "metadata-provider",
      source_name: source,
      source_record_id: doi,
      observed_at: "2026-11-25T00:00:00Z",
      input_sha256: "a".repeat(64),
      parameters_sha256: null,
    },
    source_type: null,
    source_type_mapping_version: null,
    version_role: null,
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });
}
const session = (found: readonly MetadataObservation[]): RawItemSession => {
  let delivered = !found.length;
  return {
    pull_raw_item: () => {
      if (delivered) return null;
      delivered = true;
      return { raw_item: found, source_exhausted_after: true };
    },
    convert_raw_item: () => ({ observations: found, relations: [] }),
  };
};
/**
 * Offline metadata sources for named lines: a DOI lookup and a title search
 * in Crossref and OpenAlex, answering only from `works`. `gate` holds every
 * answer until it resolves, so recognition can be seen under way.
 */
export function lookupSources(
  works: readonly MetadataObservation[],
  gate: () => Promise<void> = async () => {},
) {
  const calls: string[] = [];
  const lookup: MetadataLookupPort = {
    provider_name: "crossref",
    async open_lookup(key) {
      calls.push(`lookup:${key.identifiers.map((i) => i.value).join(",")}`);
      await gate();
      return session(
        works.filter(
          (w) =>
            w.provenance.source_name === "crossref" &&
            key.identifiers.some(
              (id) => id.value === w.metadata.identifiers[0]!.value,
            ),
        ),
      );
    },
  };
  const search = (provider_name: string): TopicSearchPort => ({
    provider_name,
    async open_topic_search(query) {
      calls.push(`search:${provider_name}:${query.query}`);
      await gate();
      return session(
        works.filter(
          (w) =>
            w.provenance.source_name === provider_name &&
            w.metadata.title?.toLowerCase() === query.query.toLowerCase(),
        ),
      );
    },
  });
  return {
    calls,
    core: {
      offline: true,
      metadata: {
        lookup_ports: [lookup],
        topic_search_ports: [search("crossref"), search("openalex")],
        reference_query_ports: [],
      },
    },
  };
}
