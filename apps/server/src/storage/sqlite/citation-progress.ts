import { DatabaseSync } from "node:sqlite";
import type { DiscoveryPublication } from "./worker.js";

type CitationCause = DiscoveryPublication["citation_causes"][number];
const QUEUE_PAGE = 64;
const PUBLICATION_PAGE = 256;

/** A disposable, disk-backed projection of the catalog's citation checkpoints. */
export class CitationProgress {
  private readonly db = new DatabaseSync("");
  private readonly maxDepth: number;
  private resultTotal = 0;
  private replayTotal = 0;
  private readonly enqueue;
  private readonly markChecked;
  private readonly queuePage;
  private readonly appendCause;
  private readonly findEdge;
  private readonly causePage;
  private readonly addResult;
  private readonly findResult;
  private readonly addRawItem;
  private readonly takeRawItem;

  constructor(seeds: readonly string[], maxDepth: number) {
    this.maxDepth = maxDepth;
    try {
      this.db.exec(`
        PRAGMA temp_store=FILE;
        PRAGMA cache_size=-2048;
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        CREATE TABLE frontier(
          ordinal INTEGER PRIMARY KEY, literature_id TEXT UNIQUE NOT NULL,
          depth INTEGER NOT NULL, checked INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX pending ON frontier(ordinal) WHERE checked=0;
        CREATE TABLE causes(
          ordinal INTEGER PRIMARY KEY, meta_literature_id TEXT NOT NULL,
          source_literature_id TEXT NOT NULL, target_literature_id TEXT NOT NULL,
          actual_literature_id TEXT NOT NULL, depth INTEGER NOT NULL
        );
        CREATE INDEX edge ON causes(source_literature_id,target_literature_id);
        CREATE TABLE results(meta_literature_id TEXT PRIMARY KEY) WITHOUT ROWID;
        CREATE TABLE replay(key TEXT PRIMARY KEY, remaining INTEGER NOT NULL) WITHOUT ROWID;
      `);
      // The row with a checked flag also serves as the visited entry.
      this.enqueue = this.db.prepare(
        "INSERT INTO frontier(literature_id,depth) VALUES(?,?) ON CONFLICT(literature_id) DO NOTHING",
      );
      this.markChecked = this.db.prepare(
        "UPDATE frontier SET checked=1 WHERE literature_id=?",
      );
      this.queuePage = this.db.prepare(
        "SELECT ordinal,literature_id,depth FROM frontier WHERE checked=0 AND ordinal>? ORDER BY ordinal LIMIT ?",
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
        "INSERT INTO replay VALUES(?,1) ON CONFLICT(key) DO UPDATE SET remaining=remaining+1",
      );
      this.takeRawItem = this.db.prepare(
        "UPDATE replay SET remaining=remaining-1 WHERE key=? AND remaining>0",
      );
      this.db.exec("BEGIN");
      for (const seed of seeds) this.enqueue.run(seed, 0);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  get resultCount() {
    return this.resultTotal;
  }

  get replayCount() {
    return this.replayTotal;
  }

  hasEdge(source: string, target: string) {
    return this.findEdge.get(source, target) !== undefined;
  }

  hasResult(metaId: string) {
    return this.findResult.get(metaId) !== undefined;
  }

  /** Apply only after the matching catalog transaction has committed. */
  record(
    causes: readonly CitationCause[],
    checked: string | null,
    rawItems: readonly string[] = [],
  ) {
    if (causes.length === 0 && checked === null && rawItems.length === 0)
      return;
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
    if (checked !== null) this.markChecked.run(checked);
    for (const key of rawItems) this.addRawItem.run(key);
    this.replayTotal += rawItems.length;
    // On failure the caller discards the projection and replays the catalog.
    this.db.exec("COMMIT");
  }

  consumeRawItem(key: string) {
    return this.takeRawItem.run(key).changes === 1;
  }

  *pending(): IterableIterator<readonly [string, number]> {
    let after = 0;
    for (;;) {
      const page = this.queuePage.all(after, QUEUE_PAGE);
      if (page.length === 0) return;
      for (const row of page)
        yield [String(row.literature_id), Number(row.depth)];
      after = Number(page.at(-1)!.ordinal);
    }
  }

  *publicationPages(): IterableIterator<readonly CitationCause[]> {
    let after = 0;
    for (;;) {
      const page = this.causePage.all(
        after,
        PUBLICATION_PAGE,
      ) as unknown as readonly (CitationCause & { ordinal: number })[];
      if (page.length === 0) return;
      yield page.map(({ ordinal, ...cause }) => {
        void ordinal;
        return cause;
      });
      after = page.at(-1)!.ordinal;
    }
  }

  close() {
    this.db.close();
  }
}
