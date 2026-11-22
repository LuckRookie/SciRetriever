import type { MissingStep, LiteratureStatus } from "@sciretriever/contracts";
import type { DatabaseSync, StatementSync } from "node:sqlite";

const suffix = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const {
  catalogBackfillPending,
  runCatalogBackfillBatch,
}: typeof import("./catalog-backfill.js") = await import(
  new URL("./catalog-backfill" + suffix, import.meta.url).href
);
const { archiveStates }: typeof import("./archive-engine.js") = await import(
  new URL("./archive-engine" + suffix, import.meta.url).href
);
const { deriveCurrentState }: typeof import("../../literature/state.js") =
  await import(
    new URL("../../literature/state" + suffix, import.meta.url).href
  );
const { registerCatalogWriteHook }: typeof import("./catalog-write.js") =
  await import(new URL("./catalog-write" + suffix, import.meta.url).href);
const {
  collectionTaskTargetSql,
  historicalManualTagSql,
  LIBRARY_SCALE_ADDITION,
}: typeof import("./schema.js") = await import(
  new URL("./schema" + suffix, import.meta.url).href
);
const { visibleLiteratureSql }: typeof import("./intake-visibility.js") =
  await import(new URL("./intake-visibility" + suffix, import.meta.url).href);
const { LibraryCountStore }: typeof import("./library-count-store.js") =
  await import(new URL("./library-count-store" + suffix, import.meta.url).href);
const {
  backfillCollection,
  backfillLibraryPaging,
  initializeLibraryPaging,
  libraryPagingReady,
}: typeof import("./library-paging-state.js") = await import(
  new URL("./library-paging-state" + suffix, import.meta.url).href
);

export const LIBRARY_STATE_BATCH_SIZE = 256;
export interface StateSettings {
  readonly max_tags: number;
  readonly archive_profile: "pipeline" | "vlm-engine";
}
interface StateProgress extends StateSettings {
  generation: number;
  after_id: string;
  ready: number;
  collection_ready: number;
}
interface LiteratureState {
  status: LiteratureStatus;
  missing_step: MissingStep | null;
}

/** Each proof of selection is joined by literature ID, including during migration. */
export function historicalCollectionSql(id: string) {
  return `(
    EXISTS(SELECT 1 FROM intake_batch_members m JOIN intake_batches b USING(batch_id)
      WHERE m.literature_id=${id} AND b.kind='import')
    OR EXISTS(SELECT 1 FROM reading_history WHERE literature_id=${id})
    OR EXISTS(SELECT 1 FROM folder_members WHERE literature_id=${id})
    OR EXISTS(SELECT 1 FROM snapshot_members WHERE literature_id=${id})
    OR EXISTS(SELECT 1 FROM intake_batch_objects WHERE object_kind='folder-member'
      AND CASE WHEN json_valid(object_id) THEN json_extract(object_id,'$[1]') END=${id})
    OR EXISTS(SELECT 1 FROM archive_runs WHERE literature_id=${id})
    OR EXISTS(SELECT 1 FROM execution_targets t JOIN execution_jobs j USING(job_id)
      WHERE t.literature_id=${id} AND ${collectionTaskTargetSql("t", "j")} AND (
        EXISTS(SELECT 1 FROM execution_events e WHERE e.job_id=t.job_id AND e.kind='task-start-requested')
        OR EXISTS(SELECT 1 FROM execution_attempts a WHERE a.target_id=t.target_id)
      ))
    OR EXISTS(SELECT 1 FROM tag_assignment_changes c
      WHERE c.literature_id=${id} AND ${historicalManualTagSql(id)})
  )`;
}

export function recordCollectedLiteratures(
  db: DatabaseSync,
  ids: readonly string[],
) {
  db.prepare(
    `INSERT INTO library_collected(literature_id,intake_at)
     SELECT l.literature_id, li.intake_at FROM json_each(?) i CROSS JOIN literatures l ON l.literature_id=i.value
     LEFT JOIN literature_intake li ON li.literature_id=l.literature_id
     WHERE ${visibleLiteratureSql("l.literature_id")} ON CONFLICT(literature_id) DO NOTHING`,
  ).run(JSON.stringify(ids));
}

const states = new WeakMap<DatabaseSync, StoredLibraryState>();
export function storedLibraryState(db: DatabaseSync): StoredLibraryState {
  const state = states.get(db);
  if (!state) throw new Error("library state connection not configured");
  return state;
}

export class StoredLibraryState {
  private readonly statements = new Map<string, StatementSync>();
  private readonly db: DatabaseSync;
  private readonly initial: StateSettings;
  private readonly checkpoint: () => void;
  readonly counts: InstanceType<typeof LibraryCountStore>;

  constructor(
    db: DatabaseSync,
    initial: StateSettings,
    checkpoint: () => void = () => {},
  ) {
    this.db = db;
    this.initial = initial;
    this.checkpoint = checkpoint;
    this.counts = new LibraryCountStore(db);
    states.set(db, this);
    db.function(
      "sr_derive_status",
      (id) => this.derive(String(id))?.status ?? null,
    );
    db.function(
      "sr_derive_missing",
      (id) => this.derive(String(id))?.missing_step ?? null,
    );
    db.function("sr_status", (id) => this.get(String(id))?.status ?? null);
  }

  private statement(sql: string) {
    let result = this.statements.get(sql);
    if (!result) {
      result = this.db.prepare(sql);
      this.statements.set(sql, result);
    }
    return result;
  }

  private progress() {
    return this.statement(
      "SELECT generation,max_tags,archive_profile,after_id,ready,collection_ready FROM library_state_progress WHERE singleton=1",
    ).get() as (StateProgress & Record<string, unknown>) | undefined;
  }

  configure(settings: StateSettings = this.initial) {
    this.statement(
      `INSERT INTO library_state_progress(singleton,generation,max_tags,archive_profile,after_id,ready,collection_ready)
      SELECT 1,1,?,?,'',NOT EXISTS(SELECT 1 FROM literature_metadata),NOT EXISTS(SELECT 1 FROM literature_metadata)
      WHERE true ON CONFLICT(singleton) DO UPDATE SET
        generation=generation+1,max_tags=excluded.max_tags,archive_profile=excluded.archive_profile,after_id='',ready=0
      WHERE max_tags<>excluded.max_tags OR archive_profile<>excluded.archive_profile`,
    ).run(settings.max_tags, settings.archive_profile);
    this.counts.configure();
    initializeLibraryPaging(this.db);
  }

  registerWrites() {
    registerCatalogWriteHook(this.db, () => {
      const position = Number(
        this.statement(
          "SELECT coalesce(max(position),0) AS position FROM library_state_dirty",
        ).get()!.position,
      );
      const countPosition = this.counts.position();
      if (!this.progress()) this.configure();
      else if (!this.counts.configured()) this.counts.configure();
      return () => {
        const progress = this.progress()!;
        for (;;) {
          const ids = this.dirtyIds(position);
          if (ids.length) this.writeStates(ids, progress);
          const counted = this.counts.update(
            ids,
            countPosition,
            LIBRARY_STATE_BATCH_SIZE,
          );
          if (ids.length) this.clearDirty(ids);
          if (
            ids.length < LIBRARY_STATE_BATCH_SIZE &&
            counted < LIBRARY_STATE_BATCH_SIZE
          )
            break;
        }
      };
    });
  }

  countsReady(plan = this.readPlan()) {
    return (
      plan.indexed &&
      plan.collectionReady &&
      !this.counts.backfillPending &&
      this.counts.position() === 0
    );
  }

  maintenancePending() {
    return (
      !this.countsReady() ||
      !libraryPagingReady(this.db) ||
      catalogBackfillPending(this.db, LIBRARY_SCALE_ADDITION)
    );
  }

  readPlan() {
    const p = this.progress();
    return {
      generation: p?.generation ?? 0,
      updating: p?.ready !== 1,
      indexed:
        p?.ready === 1 &&
        !this.statement("SELECT 1 FROM library_state_dirty LIMIT 1").get(),
      collectionReady: p?.collection_ready === 1,
    };
  }

  collected(id: string) {
    if (
      this.statement(
        "SELECT 1 FROM library_collected WHERE literature_id=?",
      ).get(id)
    )
      return true;
    return (
      this.progress()?.collection_ready !== 1 &&
      Boolean(
        this.statement(
          `SELECT 1 FROM literatures l WHERE l.literature_id=? AND ${historicalCollectionSql("l.literature_id")}`,
        ).get(id),
      )
    );
  }

  private derive(id: string) {
    this.checkpoint();
    const main = this.statement(
      `SELECT EXISTS(SELECT 1 FROM literature_assets la JOIN assets a USING(asset_id)
        WHERE la.literature_id=m.literature_id AND la.role='primary-pdf' AND a.media_type='application/pdf') AS present
        FROM literature_metadata m WHERE m.literature_id=?`,
    ).get(id);
    if (!main) return undefined;
    if (!main.present)
      return { status: "UNREVIEWED", missing_step: "primary-pdf" } as const;
    const settings = this.progress() ?? this.initial;
    const facts = archiveStates(this.db, id, this.checkpoint).get(id);
    return (
      facts &&
      deriveCurrentState(facts, settings.max_tags, settings.archive_profile)
    );
  }

  get(id: string): LiteratureState | undefined {
    const row = this.statement(
      `SELECT s.status,s.missing_step FROM library_literature_states s
      JOIN library_state_progress p ON p.singleton=1 AND s.generation=p.generation
      WHERE s.literature_id=? AND NOT EXISTS(SELECT 1 FROM library_state_dirty d WHERE d.literature_id=s.literature_id)`,
    ).get(id);
    return row ? (row as unknown as LiteratureState) : this.derive(id);
  }

  settings(): StateSettings {
    return this.progress() ?? this.initial;
  }

  private dirtyIds(after: number) {
    return this.statement(
      "SELECT literature_id FROM library_state_dirty WHERE position>? ORDER BY position LIMIT ?",
    )
      .all(after, LIBRARY_STATE_BATCH_SIZE)
      .map((row) => String(row.literature_id));
  }

  private clearDirty(ids: readonly string[]) {
    this.statement(
      "DELETE FROM library_state_dirty WHERE literature_id IN (SELECT value FROM json_each(?))",
    ).run(JSON.stringify(ids));
  }

  private writeStates(ids: readonly string[], progress: StateProgress) {
    // The first branch of deriveCurrentState depends only on the main part.
    // Most new intake results have no PDF, so no archive joins are needed.
    const candidates = this.statement(
      `SELECT m.literature_id,i.intake_at,
      EXISTS(SELECT 1 FROM literature_assets la JOIN assets a USING(asset_id)
        WHERE la.literature_id=m.literature_id AND la.role='primary-pdf' AND a.media_type='application/pdf') AS main
      FROM json_each(?) scope CROSS JOIN literature_metadata m ON m.literature_id=scope.value
      LEFT JOIN literature_intake i ON i.literature_id=m.literature_id`,
    ).all(JSON.stringify(ids));
    const withPdf = candidates
      .filter((r) => r.main === 1)
      .map((r) => String(r.literature_id));
    const facts = withPdf.length ? archiveStates(this.db, withPdf) : new Map();
    const upsert = this
      .statement(`INSERT INTO library_literature_states(literature_id,status,missing_step,generation,intake_at) VALUES(?,?,?,?,?)
      ON CONFLICT(literature_id) DO UPDATE SET status=excluded.status,missing_step=excluded.missing_step,generation=excluded.generation,intake_at=excluded.intake_at
      WHERE status<>excluded.status OR missing_step IS NOT excluded.missing_step OR generation<>excluded.generation OR intake_at IS NOT excluded.intake_at`);
    for (const row of candidates) {
      const fact = facts.get(row.literature_id);
      const state = fact
        ? deriveCurrentState(fact, progress.max_tags, progress.archive_profile)
        : { status: "UNREVIEWED", missing_step: "primary-pdf" };
      upsert.run(
        row.literature_id!,
        state.status,
        state.missing_step,
        progress.generation,
        row.intake_at ?? null,
      );
    }
    if (candidates.length !== ids.length)
      this.statement(
        `DELETE FROM library_literature_states WHERE literature_id IN (
        SELECT value FROM json_each(?) WHERE NOT EXISTS(SELECT 1 FROM literature_metadata m WHERE m.literature_id=value))`,
      ).run(JSON.stringify(ids));
  }

  /** One write transaction under catalog admission. Both cursors survive restart. */
  refreshBatch() {
    return (
      runCatalogBackfillBatch(this.db, LIBRARY_SCALE_ADDITION, {
        "library-projections": () => {
          const value = this.refreshProjectionsBatch();
          const state = this.progress()!;
          const counts =
            this.statement(
              "SELECT after_id,ready FROM library_count_progress WHERE singleton=1",
            ).get() ?? null;
          const paging =
            this.statement(
              "SELECT stage,CAST(after_rowid AS TEXT) AS after_rowid FROM library_paging_progress WHERE singleton=1",
            ).get() ?? null;
          return {
            value,
            done:
              state.ready === 1 &&
              state.collection_ready === 1 &&
              counts?.ready === 1 &&
              libraryPagingReady(this.db),
            cursor: { state, counts, paging },
          };
        },
      }) ?? this.refreshProjectionsBatch()
    );
  }

  private refreshProjectionsBatch() {
    if (!this.progress()) this.configure();
    else if (!this.counts.configured()) this.counts.configure();
    const p = this.progress()!;
    const dirty = this.dirtyIds(0);
    if (dirty.length) {
      this.writeStates(dirty, p);
      this.clearDirty(dirty);
    }
    let rebuilt = 0;
    if (!p.ready) {
      const ids = this.statement(
        "SELECT literature_id FROM literature_metadata WHERE literature_id>? ORDER BY literature_id LIMIT ?",
      )
        .all(p.after_id, LIBRARY_STATE_BATCH_SIZE)
        .map((row) => String(row.literature_id));
      rebuilt = ids.length;
      this.writeStates(ids, p);
      if (!p.collection_ready)
        backfillCollection(
          this.db,
          JSON.stringify(ids),
          historicalCollectionSql("l.literature_id"),
        );
      // During the first backfill the count cursor will visit these papers
      // after state and historical collection are complete. On a settings
      // change, repair any previously counted papers in this transaction.
      if (p.collection_ready)
        this.counts.update(ids, 0, LIBRARY_STATE_BATCH_SIZE);
      const done = ids.length < LIBRARY_STATE_BATCH_SIZE ? 1 : 0;
      this.statement(
        "UPDATE library_state_progress SET after_id=?,ready=?,collection_ready=max(collection_ready,?) WHERE singleton=1",
      ).run(ids.at(-1) ?? p.after_id, done, done);
    }
    this.counts.update(dirty, 0, LIBRARY_STATE_BATCH_SIZE);
    if (p.ready && p.collection_ready)
      this.counts.backfill(LIBRARY_STATE_BATCH_SIZE);
    if (this.countsReady() && !libraryPagingReady(this.db))
      backfillLibraryPaging(this.db, LIBRARY_STATE_BATCH_SIZE);
    return {
      rebuilt,
      repaired: dirty.length,
      more: !this.countsReady() || !libraryPagingReady(this.db),
    };
  }
}
