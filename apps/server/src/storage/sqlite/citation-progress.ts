import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEvents } from "node:timers/promises";
import type { DiscoveryPublication } from "./worker.js";

type CitationCause = DiscoveryPublication["citation_causes"][number];
const CAUSE_PAGE = 256;

export interface CitationDeferredEntry {
  readonly id: string;
  readonly provider_name: string;
  readonly relation_id?: string;
}

export interface CitationDeferredChanges<Work extends CitationDeferredEntry> {
  readonly added: readonly Work[];
  readonly completed: string | null;
}

/** A disposable, disk-backed projection of the catalog's citation checkpoints. */
export class CitationProgress<Work extends CitationDeferredEntry> {
  private readonly db: DatabaseSync;
  private readonly maxDepth: number;
  private readonly direction: "references" | "cited-by" | "both";
  private resultTotal = 0;
  private readonly enqueue;
  private readonly markChecked;
  private readonly nextAnchor;
  private readonly anchorDepth;
  private readonly lowered;
  private readonly clearLowered;
  private readonly outgoing;
  private readonly incoming;
  private readonly appendCause;
  private readonly findEdge;
  private readonly causePage;
  private readonly addResult;
  private readonly findResult;
  private readonly addRawItem;
  private readonly takeRawItem;
  private readonly clearRawItems;
  private readonly resetRawItems;
  private readonly countRawItems;
  private readonly addDeferred;
  private readonly completeDeferred;
  private readonly getDeferred;
  private readonly nextDeferred;
  private readonly findDeferred;
  private readonly relatedDeferred;

  constructor(
    seeds: readonly string[],
    maxDepth: number,
    direction: "references" | "cited-by" | "both",
  ) {
    // CLI and admission checks can finish before opening any SQLite catalog.
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    this.db = new DatabaseSync("");
    this.maxDepth = maxDepth;
    this.direction = direction;
    try {
      this.db.exec(`
        PRAGMA temp_store=FILE;
        PRAGMA cache_size=-2048;
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        CREATE TABLE frontier(
          ordinal INTEGER PRIMARY KEY, literature_id TEXT UNIQUE NOT NULL,
          depth INTEGER NOT NULL, checked INTEGER NOT NULL DEFAULT 0,
          lowered INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX pending ON frontier(ordinal) WHERE checked=0;
        CREATE INDEX lowered_frontier ON frontier(ordinal) WHERE lowered=1;
        CREATE TABLE causes(
          ordinal INTEGER PRIMARY KEY, meta_literature_id TEXT NOT NULL,
          source_literature_id TEXT NOT NULL, target_literature_id TEXT NOT NULL,
          actual_literature_id TEXT NOT NULL, depth INTEGER NOT NULL
        );
        CREATE INDEX edge ON causes(source_literature_id,target_literature_id);
        CREATE INDEX incoming_edge ON causes(target_literature_id,source_literature_id);
        CREATE TABLE results(meta_literature_id TEXT PRIMARY KEY) WITHOUT ROWID;
        CREATE TABLE replay(
          query_id TEXT NOT NULL, key TEXT NOT NULL,
          committed INTEGER NOT NULL, remaining INTEGER NOT NULL,
          PRIMARY KEY(query_id,key)
        ) WITHOUT ROWID;
        CREATE TABLE deferred(
          ordinal INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL,
          provider_name TEXT NOT NULL, relation_id TEXT, value TEXT NOT NULL
        );
        CREATE INDEX deferred_provider ON deferred(provider_name,ordinal);
        CREATE INDEX deferred_relation ON deferred(relation_id) WHERE relation_id IS NOT NULL;
      `);
      // The row with a checked flag also serves as the visited entry.
      this.enqueue = this.db.prepare(
        `INSERT INTO frontier(literature_id,depth) VALUES(?,?)
         ON CONFLICT(literature_id) DO UPDATE SET depth=excluded.depth, lowered=1
         WHERE frontier.depth>excluded.depth`,
      );
      this.markChecked = this.db.prepare(
        "UPDATE frontier SET checked=1 WHERE literature_id=?",
      );
      this.nextAnchor = this.db.prepare(
        "SELECT literature_id,depth FROM frontier WHERE checked=0 ORDER BY ordinal LIMIT 1",
      );
      this.anchorDepth = this.db.prepare(
        "SELECT depth FROM frontier WHERE literature_id=?",
      );
      this.lowered = this.db.prepare(
        "SELECT literature_id,depth FROM frontier WHERE lowered=1 ORDER BY ordinal LIMIT 1",
      );
      this.clearLowered = this.db.prepare(
        "UPDATE frontier SET lowered=0 WHERE literature_id=?",
      );
      this.outgoing = this.db.prepare(
        "SELECT target_literature_id AS literature_id FROM causes WHERE source_literature_id=?",
      );
      this.incoming = this.db.prepare(
        "SELECT source_literature_id AS literature_id FROM causes WHERE target_literature_id=?",
      );
      this.appendCause = this.db.prepare(
        "INSERT INTO causes(meta_literature_id,source_literature_id,target_literature_id,actual_literature_id,depth) VALUES(?,?,?,?,?)",
      );
      this.findEdge = this.db.prepare(
        "SELECT 1 FROM causes WHERE source_literature_id=? AND target_literature_id=? LIMIT 1",
      );
      this.causePage = this.db.prepare(
        "SELECT * FROM causes WHERE ordinal>? ORDER BY ordinal LIMIT ?",
      );
      this.addResult = this.db.prepare(
        "INSERT OR IGNORE INTO results VALUES(?)",
      );
      this.findResult = this.db.prepare(
        "SELECT 1 FROM results WHERE meta_literature_id=?",
      );
      this.addRawItem = this.db.prepare(
        "INSERT INTO replay VALUES(?,?,1,0) ON CONFLICT(query_id,key) DO UPDATE SET committed=committed+1",
      );
      this.takeRawItem = this.db.prepare(
        "UPDATE replay SET remaining=remaining-1 WHERE query_id=? AND key=? AND remaining>0",
      );
      this.clearRawItems = this.db.prepare(
        "DELETE FROM replay WHERE query_id=?",
      );
      this.resetRawItems = this.db.prepare(
        "UPDATE replay SET remaining=committed WHERE query_id=?",
      );
      this.countRawItems = this.db.prepare(
        "SELECT coalesce(sum(committed),0) AS count FROM replay WHERE query_id=?",
      );
      this.addDeferred = this.db.prepare(
        "INSERT INTO deferred(id,provider_name,relation_id,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      );
      this.completeDeferred = this.db.prepare(
        "DELETE FROM deferred WHERE id=?",
      );
      this.getDeferred = this.db.prepare(
        "SELECT value FROM deferred WHERE id=?",
      );
      this.nextDeferred = this.db.prepare(
        "SELECT ordinal,value FROM deferred WHERE provider_name=? ORDER BY ordinal LIMIT 1",
      );
      this.findDeferred = this.db.prepare("SELECT 1 FROM deferred LIMIT 1");
      this.relatedDeferred = this.db.prepare(
        "SELECT value FROM deferred WHERE relation_id=? AND id<>? ORDER BY ordinal",
      );
      this.db.exec("BEGIN");
      if (maxDepth > 0) for (const seed of seeds) this.enqueue.run(seed, 0);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  get resultCount() {
    return this.resultTotal;
  }

  get hasDeferredWork() {
    return this.findDeferred.get() !== undefined;
  }

  hasEdge(source: string, target: string) {
    return this.findEdge.get(source, target) !== undefined;
  }

  hasResult(metaId: string) {
    return this.findResult.get(metaId) !== undefined;
  }

  /** Apply only after the matching catalog transaction has committed. */
  async record(
    causes: readonly CitationCause[],
    checked: string | null,
    deferred?: CitationDeferredChanges<Work>,
    replay?: { readonly id: string; readonly items: readonly string[] | null },
    signal?: AbortSignal,
  ) {
    if (causes.length === 0 && checked === null && !deferred && !replay) return;
    this.db.exec("BEGIN");
    for (const cause of causes) {
      this.appendCause.run(
        cause.meta_literature_id,
        cause.source_literature_id,
        cause.target_literature_id,
        cause.actual_literature_id,
        cause.depth,
      );
      this.resultTotal += Number(
        this.addResult.run(cause.meta_literature_id).changes,
      );
      if (cause.depth < this.maxDepth)
        this.enqueue.run(cause.actual_literature_id, cause.depth);
    }
    if (causes.length) {
      for (const cancellation of this.propagateShorterPaths(signal)) {
        await yieldToEvents();
        cancellation.throwIfAborted();
      }
    }
    if (checked !== null) this.markChecked.run(checked);
    if (deferred) {
      for (const work of deferred.added)
        this.addDeferred.run(
          work.id,
          work.provider_name,
          work.relation_id ?? null,
          JSON.stringify(work),
        );
      if (deferred.completed !== null)
        this.completeDeferred.run(deferred.completed);
    }
    if (replay) {
      if (replay.items === null) this.clearRawItems.run(replay.id);
      else for (const key of replay.items) this.addRawItem.run(replay.id, key);
    }
    // On failure the caller discards the projection and replays the catalog.
    this.db.exec("COMMIT");
  }

  beginReplay(queryId: string): number {
    this.resetRawItems.run(queryId);
    return Number(this.countRawItems.get(queryId)!.count);
  }

  consumeRawItem(queryId: string, key: string) {
    return this.takeRawItem.run(queryId, key).changes === 1;
  }

  pending(): readonly [string, number] | undefined {
    const row = this.nextAnchor.get();
    if (row) return [String(row.literature_id), Number(row.depth)];
  }

  depthOf(sourceId: string): number | undefined {
    const depth = this.anchorDepth.get(sourceId)?.depth;
    return depth === undefined ? undefined : Number(depth);
  }

  private *propagateShorterPaths(signal?: AbortSignal) {
    // A deferred query can reveal a shorter route after other anchors have
    // already been checked. Reuse their committed edges to reach newly
    // eligible anchors while keeping each recorded cause at its observed depth.
    const edges =
      this.direction === "references"
        ? [this.outgoing]
        : this.direction === "cited-by"
          ? [this.incoming]
          : [this.outgoing, this.incoming];
    let visited = 0;
    let next;
    while ((next = this.lowered.get())) {
      if (signal && ++visited % CAUSE_PAGE === 0) yield signal;
      const anchor = String(next.literature_id);
      const depth = Number(next.depth) + 1;
      this.clearLowered.run(anchor);
      if (depth >= this.maxDepth) continue;
      for (const statement of edges)
        for (const row of statement.iterate(anchor)) {
          this.enqueue.run(String(row.literature_id), depth);
          if (signal && ++visited % CAUSE_PAGE === 0) yield signal;
        }
    }
  }

  deferred(id: string): Work | undefined {
    const row = this.getDeferred.get(id);
    if (row) return JSON.parse(String(row.value)) as Work;
  }

  relatedWork(relation: string, except: string): readonly Work[] {
    return this.relatedDeferred
      .all(relation, except)
      .map((row) => JSON.parse(String(row.value)) as Work);
  }

  oldestDeferred(providerName: string) {
    const row = this.nextDeferred.get(providerName);
    if (row)
      return {
        ordinal: Number(row.ordinal),
        work: JSON.parse(String(row.value)) as Work,
      };
  }

  *publicationCauses(): IterableIterator<CitationCause> {
    let after = 0;
    for (;;) {
      const page = this.causePage.all(
        after,
        CAUSE_PAGE,
      ) as unknown as readonly (CitationCause & { ordinal: number })[];
      if (page.length === 0) return;
      for (const { ordinal, ...cause } of page) {
        after = ordinal;
        yield cause;
      }
    }
  }

  close() {
    this.db.close();
  }
}
