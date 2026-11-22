// Legacy projection used as a migration and trigger regression oracle.
import type { DatabaseSync } from "node:sqlite";
import { archiveStates } from "../src/storage/sqlite/archive-engine.js";
import { draftFactSql } from "../src/storage/sqlite/draft-facts.js";
import { deriveCurrentState } from "../src/literature/state.js";

/** One complete projection per committed input revision; used inside the caller's read transaction. */
export class LibraryStateCache {
  private key: string | null = null;
  private revision = -1;
  private fullRevision = -1;
  private states = new Map<string, ReturnType<typeof deriveCurrentState>>();
  private factStamps = new Map<string, string>();

  read(
    db: DatabaseSync,
    identity: string,
    maxTags: number,
    profile: "pipeline" | "vlm-engine",
    checkpoint: () => void,
  ) {
    checkpoint();
    const stamp = db
      .prepare(
        "SELECT revision,full_revision,tracked_revision FROM library_state_revision WHERE singleton=1",
      )
      .get();
    const revision = Number(stamp?.revision ?? 0);
    const fullRevision = Number(stamp?.full_revision ?? 0);
    const key = JSON.stringify([identity, maxTags, profile]);
    // Output transactions are outside the readiness-trigger schema. Read their
    // indexed version facts in this snapshot; only changed owners lose cache.
    const factStamps = readResultFactStamps(db);
    const factChanges = [
      ...new Set([...factStamps.keys(), ...this.factStamps.keys()]),
    ].filter((id) => factStamps.get(id) !== this.factStamps.get(id));
    if (
      key === this.key &&
      revision === this.revision &&
      fullRevision === this.fullRevision &&
      !factChanges.length
    )
      return this.states;
    let ids: string[] | undefined;
    if (
      key === this.key &&
      revision === this.revision &&
      fullRevision === this.fullRevision &&
      factChanges.length <= 64
    )
      ids = factChanges;
    if (
      key === this.key &&
      revision > this.revision &&
      fullRevision <= this.revision &&
      Number(stamp?.tracked_revision) === revision
    ) {
      const changed = db
        .prepare(
          "SELECT literature_id FROM library_state_changes WHERE revision>? AND revision<=? ORDER BY revision,literature_id LIMIT 65",
        )
        .all(this.revision, revision);
      // Large batches and missing invalidation hints conservatively rebuild.
      if (changed.length > 0 && changed.length <= 64)
        ids = [
          ...new Set([
            ...changed.map((row) => String(row.literature_id)),
            ...factChanges,
          ]),
        ];
      if (ids && ids.length > 64) ids = undefined;
    }
    checkpoint();
    const next = ids
      ? new Map(this.states)
      : new Map<string, ReturnType<typeof deriveCurrentState>>();
    // Tombstones have no FK: deletions must also invalidate older readers.
    for (const id of ids ?? []) next.delete(id);
    const scope = ids?.length === 1 ? ids[0] : ids;
    for (const [id, facts] of archiveStates(db, scope, checkpoint, false)) {
      checkpoint();
      next.set(id, deriveCurrentState(facts, maxTags, profile));
    }
    checkpoint();
    // Never publish a partially computed/cancelled map.
    this.states = next;
    this.key = key;
    this.revision = revision;
    this.fullRevision = fullRevision;
    this.factStamps = factStamps;
    return next;
  }
}

function readResultFactStamps(db: DatabaseSync): Map<string, string> {
  const grouped = new Map<string, unknown[]>();
  for (const row of db
    .prepare(
      `SELECT la.literature_id,a.asset_id,d.document_version_id AS document_version_id,
    ${draftFactSql("citing_results", "d.document_version_id")} AS citing_results,
    ${draftFactSql("unfound_citations", "d.document_version_id")} AS unfound_citations
    FROM literature_assets la JOIN assets a ON a.asset_id=la.asset_id
    JOIN document_versions d ON d.literature_id=la.literature_id AND d.source_asset_id=a.asset_id AND d.source_sha256=a.sha256
    JOIN document_defaults dd ON dd.document_version_id=d.document_version_id
    WHERE d.schema_version=3 AND a.media_type='application/pdf' AND la.role IN ('primary-pdf','supplementary-pdf')
    ORDER BY la.literature_id,a.asset_id`,
    )
    .all()) {
    const id = String(row.literature_id),
      values = grouped.get(id) ?? [];
    values.push([
      row.asset_id,
      row.document_version_id,
      row.citing_results,
      row.unfound_citations,
    ]);
    grouped.set(id, values);
  }
  return new Map(
    [...grouped].map(([id, values]) => [id, JSON.stringify(values)]),
  );
}
