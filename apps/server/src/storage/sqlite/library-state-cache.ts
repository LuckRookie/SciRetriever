import type { DatabaseSync } from "node:sqlite";
import type * as Archive from "./archive-engine.js";
import type * as State from "../../literature/state.js";
import type * as DraftFacts from "./draft-facts.js";
const { readResultFactStamps }: typeof DraftFacts = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./draft-facts.ts" : "./draft-facts.js",
    import.meta.url,
  ).href
);
const { archiveStates }: typeof Archive = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./archive-engine.ts"
      : "./archive-engine.js",
    import.meta.url,
  ).href
);
const { deriveCurrentState }: typeof State = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "../../literature/state.ts"
      : "../../literature/state.js",
    import.meta.url,
  ).href
);

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
