import { DatabaseSync } from "node:sqlite";
import {
  parseLiteratureMetadata,
  parseMetadataObservation,
  type LiteratureMetadata,
} from "@sciretriever/contracts";

/** Typed hydration of the current metadata schema, used by metadata publication. */
export function readMetadataRow(
  db: DatabaseSync,
  kind: "literature" | "observation",
  id: string,
): LiteratureMetadata {
  const table =
    kind === "literature" ? "literature_metadata" : "metadata_observations";
  const prefix =
    kind === "literature" ? "literature_metadata" : "metadata_observation";
  const key = kind === "literature" ? "literature_id" : "observation_id";
  const row = db
    .prepare(
      `SELECT title,abstract,publication_date,publication_year,publication_form,article_kind,language,venue,publisher,volume,issue,pages FROM ${table} WHERE ${key}=?`,
    )
    .get(id);
  if (!row) throw new Error("metadata row missing");
  const authors = db
    .prepare(
      `SELECT ordinal,kind,display_name,given_name,family_name,orcid FROM ${prefix}_authors WHERE ${key}=? ORDER BY ordinal`,
    )
    .all(id)
    .map(({ ordinal, ...author }) => ({
      ...author,
      affiliations: db
        .prepare(
          `SELECT name,ror FROM ${prefix}_author_affiliations WHERE ${key}=? AND author_ordinal=? ORDER BY affiliation_ordinal`,
        )
        .all(id, ordinal!),
    }));
  return parseLiteratureMetadata({
    ...row,
    authors,
    identifiers: db
      .prepare(
        `SELECT namespace,value FROM ${prefix}_identifiers WHERE ${key}=? ORDER BY ordinal`,
      )
      .all(id),
    subject_terms: db
      .prepare(
        `SELECT term FROM ${prefix}_subject_terms WHERE ${key}=? ORDER BY ordinal`,
      )
      .all(id)
      .map((row) => row.term),
    keywords: db
      .prepare(
        `SELECT keyword FROM ${prefix}_keywords WHERE ${key}=? ORDER BY ordinal`,
      )
      .all(id)
      .map((row) => row.keyword),
  });
}

export function readObservationRow(db: DatabaseSync, id: string) {
  const row = db
    .prepare(
      "SELECT observation_id,provenance_id,version_role,reference_count,cited_by_count,source_type,source_type_mapping_version FROM metadata_observations WHERE observation_id=?",
    )
    .get(id);
  if (!row) throw new Error("metadata observation missing");
  const { provenance_id, ...observation } = row;
  return parseMetadataObservation({
    ...observation,
    provenance: db
      .prepare("SELECT * FROM provenances WHERE provenance_id=?")
      .get(provenance_id!),
    metadata: readMetadataRow(db, "observation", id),
    declared_keywords: db
      .prepare(
        "SELECT keyword FROM metadata_observation_declared_keywords WHERE observation_id=? ORDER BY ordinal",
      )
      .all(id)
      .map((r) => r.keyword),
    reference_texts: db
      .prepare(
        "SELECT reference_text FROM metadata_observation_reference_texts WHERE observation_id=? ORDER BY reference_index",
      )
      .all(id)
      .map((r) => r.reference_text),
    asset_hints: db
      .prepare(
        "SELECT url,kind,media_type,asset_role,version_role,access_status,license FROM metadata_observation_asset_hints WHERE observation_id=? ORDER BY hint_ordinal",
      )
      .all(id),
    version_links: db
      .prepare(
        "SELECT link_ordinal,record_id FROM metadata_observation_version_links WHERE observation_id=? ORDER BY link_ordinal",
      )
      .all(id)
      .map((link) => ({
        record_id: link.record_id,
        identifiers: db
          .prepare(
            "SELECT namespace,value FROM metadata_observation_version_link_identifiers WHERE observation_id=? AND link_ordinal=? ORDER BY ordinal",
          )
          .all(id, link.link_ordinal!),
      })),
  });
}
