import { DatabaseSync } from "node:sqlite";
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

export function readLiteratureStatus(
  db: DatabaseSync,
  id: string,
  maxTags: number,
  profile: "pipeline" | "vlm-engine",
  checkpoint: () => void,
) {
  const fact = archiveStates(db, id, checkpoint, false).get(id);
  return fact ? deriveCurrentState(fact, maxTags, profile).status : null;
}

export function scopedLiteratureStates(
  db: DatabaseSync,
  ids: readonly string[],
  maxTags: number,
  profile: "pipeline" | "vlm-engine",
  checkpoint: () => void,
) {
  const states = new Map<string, ReturnType<typeof deriveCurrentState>>();
  for (const [id, facts] of archiveStates(db, ids, checkpoint, false))
    states.set(id, deriveCurrentState(facts, maxTags, profile));
  return states;
}

/** Disk-backed projection for operations that require one mutable-fact snapshot. */
export function materializeLiteratureStates(
  db: DatabaseSync,
  maxTags: number,
  profile: "pipeline" | "vlm-engine",
  checkpoint: () => void,
) {
  const scratch = new DatabaseSync("");
  try {
    scratch.exec(`
      PRAGMA cache_size=-1024;
      PRAGMA journal_mode=OFF;
      CREATE TABLE states(id TEXT PRIMARY KEY,status TEXT NOT NULL,missing_step TEXT) WITHOUT ROWID;
      BEGIN;
    `);
    const page = db.prepare(
      "SELECT literature_id FROM literature_metadata WHERE literature_id>? ORDER BY literature_id LIMIT 1000",
    );
    const put = scratch.prepare("INSERT INTO states VALUES(?,?,?)");
    let after = "";
    for (;;) {
      checkpoint();
      const ids = page
        .all(after)
        .map(({ literature_id }) => String(literature_id));
      if (!ids.length) break;
      for (const [id, state] of scopedLiteratureStates(
        db,
        ids,
        maxTags,
        profile,
        checkpoint,
      ))
        put.run(id, state.status, state.missing_step);
      after = ids.at(-1)!;
    }
    scratch.exec("COMMIT");
    const get = scratch.prepare(
      "SELECT status,missing_step FROM states WHERE id=?",
    );
    return {
      get: (id: string) => get.get(id),
      close: () => scratch.close(),
    };
  } catch (error) {
    scratch.close();
    throw error;
  }
}

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
