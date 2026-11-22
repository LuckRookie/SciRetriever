import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  parseReference,
  type StructureReference,
} from "@sciretriever/contracts";

export interface ArchiveReferencePublication {
  readonly literature_id: string;
  readonly document_version_id: string;
  readonly annotation_id: string;
  readonly expected_default_revision: number;
  readonly links: readonly {
    readonly reference: StructureReference;
    readonly target_literature_id: string;
    readonly target_metadata_revision: number;
    readonly target_metadata_sha256: string;
    readonly basis: "doi" | "stable-identifier" | "strict-fallback";
  }[];
}
/** Historical supports remain pinned until a subsequent explicit reference publication cleans them. */
export const ACTIVE_ARCHIVE_REFERENCE_SUPPORT =
  "SELECT s.reference_id,s.document_version_id,s.annotation_id,s.reference_index,s.segment_ids_json,s.matching_basis,s.target_metadata_revision,s.target_metadata_sha256 FROM archive_reference_text_supports s JOIN literature_references r ON r.reference_id=s.reference_id JOIN document_versions d ON d.document_version_id=s.document_version_id AND d.literature_id=r.source_literature_id JOIN document_defaults f ON f.document_version_id=d.document_version_id JOIN structure_annotation_current c ON c.document_version_id=d.document_version_id AND c.annotation_id=s.annotation_id JOIN literature_assets l ON l.literature_id=d.literature_id AND l.asset_id=d.source_asset_id AND l.role='primary-pdf'";
export function archiveReferenceSupports(db: DatabaseSync, id: string) {
  return db
    .prepare(
      `${ACTIVE_ARCHIVE_REFERENCE_SUPPORT} WHERE s.reference_id=? ORDER BY s.document_version_id,s.reference_index`,
    )
    .all(id)
    .map((row) => ({
      kind: "archive_reference_text" as const,
      document_version_id: String(row.document_version_id),
      reference_index: Number(row.reference_index),
      segment_ids: JSON.parse(
        String(row.segment_ids_json),
      ) as readonly string[],
    }));
}
function fail(): never {
  throw new Error("archive-reference-publication-refused");
}
export function publishArchiveReferences(
  db: DatabaseSync,
  input: ArchiveReferencePublication,
) {
  if (!Array.isArray(input.links as unknown) || input.links.length > 10000)
    fail();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (
      !db
        .prepare(
          "SELECT 1 FROM document_versions d JOIN document_defaults f ON f.document_version_id=d.document_version_id JOIN structure_annotation_current c ON c.document_version_id=d.document_version_id JOIN literature_assets l ON l.literature_id=d.literature_id AND l.asset_id=d.source_asset_id AND l.role='primary-pdf' WHERE d.literature_id=? AND d.document_version_id=? AND d.schema_version=2 AND f.revision=? AND c.annotation_id=?",
        )
        .get(
          input.literature_id,
          input.document_version_id,
          input.expected_default_revision,
          input.annotation_id,
        )
    )
      fail();
    const affected = db
      .prepare(
        "SELECT DISTINCT s.reference_id FROM archive_reference_text_supports s JOIN literature_references r ON r.reference_id=s.reference_id WHERE r.source_literature_id=?",
      )
      .all(input.literature_id)
      .map((row) => String(row.reference_id));
    // Replace only this explicit source's links, in the same transaction as the new first support.
    db.prepare(
      "DELETE FROM archive_reference_text_supports WHERE reference_id IN (SELECT reference_id FROM literature_references WHERE source_literature_id=?)",
    ).run(input.literature_id);
    const indices = new Set<number>();
    for (const link of input.links) {
      if (
        !Number.isSafeInteger(link.reference.reference_index) ||
        link.reference.reference_index < 0 ||
        indices.has(link.reference.reference_index) ||
        !link.reference.segment_ids.length ||
        new Set(link.reference.segment_ids).size !==
          link.reference.segment_ids.length ||
        link.reference.segment_ids.some(
          (s) => typeof s !== "string" || !s.trim(),
        )
      )
        fail();
      indices.add(link.reference.reference_index);
      if (
        !db
          .prepare(
            "SELECT 1 FROM literature_metadata WHERE literature_id=? AND metadata_revision=? AND metadata_sha256=?",
          )
          .get(
            link.target_literature_id,
            link.target_metadata_revision,
            link.target_metadata_sha256,
          )
      )
        fail();
      const existing = db
        .prepare(
          "SELECT reference_id FROM literature_references WHERE source_literature_id=? AND target_literature_id=?",
        )
        .get(input.literature_id, link.target_literature_id);
      const edge = parseReference({
        reference_id: existing?.reference_id ?? randomUUID(),
        source_literature_id: input.literature_id,
        target_literature_id: link.target_literature_id,
      });
      if (edge.source_literature_id === edge.target_literature_id) fail();
      db.prepare(
        "INSERT INTO literature_references(reference_id,source_literature_id,target_literature_id) VALUES(?,?,?) ON CONFLICT DO NOTHING",
      ).run(
        edge.reference_id,
        edge.source_literature_id,
        edge.target_literature_id,
      );
      db.prepare(
        "INSERT INTO archive_reference_text_supports(reference_id,document_version_id,annotation_id,reference_index,segment_ids_json,matching_basis,target_metadata_revision,target_metadata_sha256) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        edge.reference_id,
        input.document_version_id,
        input.annotation_id,
        link.reference.reference_index,
        JSON.stringify(link.reference.segment_ids),
        link.basis,
        link.target_metadata_revision,
        link.target_metadata_sha256,
      );
    }
    for (const id of affected)
      db.prepare(
        "DELETE FROM literature_references WHERE reference_id=? AND NOT EXISTS(SELECT 1 FROM provider_relation_reference_supports p WHERE p.reference_id=literature_references.reference_id) AND NOT EXISTS(SELECT 1 FROM metadata_reference_text_supports m WHERE m.reference_id=literature_references.reference_id) AND NOT EXISTS(SELECT 1 FROM archive_reference_text_supports a WHERE a.reference_id=literature_references.reference_id)",
      ).run(id);
    db.exec("COMMIT");
    return { linked: input.links.length };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
