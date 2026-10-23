import type { DatabaseSync } from "node:sqlite";
import type * as Archive from "./archive-engine.js";
import type * as State from "../../literature/state.js";
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
  private states = new Map<string, ReturnType<typeof deriveCurrentState>>();

  read(
    db: DatabaseSync,
    identity: string,
    maxTags: number,
    profile: "pipeline" | "vlm-engine",
    checkpoint: () => void,
  ) {
    checkpoint();
    const revision =
      db
        .prepare(
          "SELECT revision FROM library_state_revision WHERE singleton=1",
        )
        .get()?.revision ?? 0;
    const key = JSON.stringify([identity, revision, maxTags, profile]);
    if (key === this.key) return this.states;
    const next = new Map<string, ReturnType<typeof deriveCurrentState>>();
    for (const [id, facts] of archiveStates(db, undefined, checkpoint)) {
      checkpoint();
      next.set(id, deriveCurrentState(facts, maxTags, profile));
    }
    checkpoint();
    // Never publish a partially computed/cancelled map.
    this.states = next;
    this.key = key;
    return next;
  }
}
