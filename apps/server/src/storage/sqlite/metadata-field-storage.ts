import { DatabaseSync } from "node:sqlite";
import {
  canonicalJsonText as json,
  parseMetadataFieldState,
  type LiteratureMetadata,
  type MetadataFieldState,
} from "@sciretriever/contracts";
export function readMetadataFields(
  db: DatabaseSync,
  id: string,
): readonly MetadataFieldState[] {
  return db
    .prepare(
      "SELECT field,value_json,evidence_json,conflict,conflicts_json,locked FROM literature_metadata_field_states WHERE literature_id=? ORDER BY field",
    )
    .all(id)
    .map((row) =>
      parseMetadataFieldState({
        field: row.field,
        value: JSON.parse(String(row.value_json)),
        evidence: JSON.parse(String(row.evidence_json)),
        conflict: row.conflict === 1,
        conflicts: JSON.parse(String(row.conflicts_json)),
        locked: row.locked === 1,
      }),
    );
}
/** Called inside the Literature publication transaction, after its observation has been stored. */
export function writeMetadataFields(
  db: DatabaseSync,
  id: string,
  revision: number,
  metadata: LiteratureMetadata,
  values: readonly MetadataFieldState[],
): void {
  const fields = values.map(parseMetadataFieldState);
  if (new Set(fields.map((f) => f.field)).size !== fields.length)
    throw new Error("duplicate metadata field state");
  const provenances = new Map<string, string>();
  const documents = new Set<string>();
  const valueJson = fields.map((field) => {
    const encoded = json(field.value);
    if (
      field.value !== metadata[field.field] &&
      encoded !== json(metadata[field.field])
    )
      throw new Error("metadata field value mismatch");
    for (const evidence of [
      field.evidence,
      ...field.conflicts.map((c) => c.evidence),
    ]) {
      if (evidence.source === "proofread") {
        if (documents.has(evidence.document_version_id)) continue;
        if (
          !db
            .prepare(
              "SELECT 1 FROM document_versions WHERE document_version_id=? AND literature_id=? AND schema_version=2",
            )
            .get(evidence.document_version_id, id)
        )
          throw new Error("metadata evidence document mismatch");
        documents.add(evidence.document_version_id);
      } else {
        const provenance =
          provenances.get(evidence.observation_id) ??
          db
            .prepare(
              "SELECT o.provenance_id FROM metadata_observations o JOIN literature_metadata_observations l ON l.observation_id=o.observation_id WHERE l.literature_id=? AND o.observation_id=?",
            )
            .get(id, evidence.observation_id)?.provenance_id;
        if (provenance !== evidence.provenance.provenance_id)
          throw new Error("metadata evidence observation mismatch");
        provenances.set(evidence.observation_id, provenance);
      }
    }
    return encoded;
  });
  db.prepare(
    "DELETE FROM literature_metadata_field_states WHERE literature_id=?",
  ).run(id);
  for (const [index, field] of fields.entries())
    db.prepare(
      "INSERT INTO literature_metadata_field_states(literature_id,field,source,value_json,evidence_json,conflict,conflicts_json,locked,revision) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      field.field,
      field.evidence.source,
      valueJson[index]!,
      json(field.evidence),
      field.conflict ? 1 : 0,
      json(field.conflicts),
      field.locked ? 1 : 0,
      revision,
    );
}
