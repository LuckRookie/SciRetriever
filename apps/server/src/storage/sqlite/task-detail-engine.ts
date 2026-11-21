import {
  DatabaseSync,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import {
  ContractValidationError,
  type TaskSourceResults,
} from "@sciretriever/contracts";
import type { ExecutionEvent } from "./worker.js";
import type { TaskResultScratch } from "../execution/task-source-results.js";

const {
  TaskSourceAggregation,
  eventPosition,
}: typeof import("../execution/task-source-results.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "../execution/task-source-results.ts"
      : "../execution/task-source-results.js",
    import.meta.url,
  ).href
);
const {
  SOURCE_RESULT_KINDS,
}: typeof import("../execution/source-result-events.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "../execution/source-result-events.ts"
      : "../execution/source-result-events.js",
    import.meta.url,
  ).href
);

type SourceEvent = Pick<ExecutionEvent, "kind" | "payload">;
const PROCESSING_DETAIL_KINDS = [
  "task-start-requested",
  "archive-progress",
  "processing-result",
  "processing-partial-result",
  "processor-collection",
  "attempt-skipped",
  "target-budget-exhausted",
  "attempt-failed",
  "attempt-interrupted",
  "processing-runtime-failed",
  "attempt-paused-for-assistance",
  "attempt-retry-scheduled",
] as const;
type ProcessingDetailKind = (typeof PROCESSING_DETAIL_KINDS)[number];
type ProcessingDetailEvent = SourceEvent & {
  readonly kind: ProcessingDetailKind;
};
const processingDetailKinds = new Set<string>(PROCESSING_DETAIL_KINDS);

export interface TaskDetailEvents {
  readonly source_results: TaskSourceResults;
  readonly processing: {
    readonly events: readonly ProcessingDetailEvent[];
    readonly first_sequence: number | null;
  };
  readonly acquisition: {
    readonly events: readonly Pick<ExecutionEvent, "payload">[];
    readonly truncated: boolean;
  };
  readonly technical: readonly ExecutionEvent[];
}

export type TaskDetailRead = { readonly rows_read: number } & (
  | { readonly status: "ok"; readonly detail: TaskDetailEvents }
  | { readonly status: "invalid-source" | "budget-exceeded" | "not-found" }
);

const PROCESSING_PAGE_SIZE = 1000;
const PROCESSING_LIMIT = 100_000;
const ACQUISITION_LIMIT = 10_000;
const TECHNICAL_LIMIT = 1000;

/** Private working storage. SQLite spills to disk and unlinks on close. */
class TaskScratch implements TaskResultScratch {
  private readonly db = new DatabaseSync("");
  private readonly insert: StatementSync;
  private readonly get: StatementSync;
  private readonly upsert: StatementSync;
  private readonly remove: StatementSync;
  private readonly removeRange: StatementSync;
  private readonly first: StatementSync;
  private readonly range: StatementSync;

  constructor() {
    this.db.exec(`
      PRAGMA temp_store=FILE;
      PRAGMA cache_size=-512;
      PRAGMA journal_mode=OFF;
      CREATE TABLE entries(key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID
    `);
    this.insert = this.db.prepare(
      "INSERT OR IGNORE INTO entries VALUES(?,NULL)",
    );
    this.get = this.db.prepare("SELECT value FROM entries WHERE key=?");
    this.upsert = this.db.prepare("INSERT OR REPLACE INTO entries VALUES(?,?)");
    this.remove = this.db.prepare("DELETE FROM entries WHERE key=?");
    this.removeRange = this.db.prepare(
      "DELETE FROM entries WHERE key>=? AND key<?",
    );
    this.first = this.db.prepare(
      "SELECT key FROM entries WHERE key>=? AND key<? ORDER BY key LIMIT 1",
    );
    this.range = this.db.prepare(
      "SELECT value FROM entries WHERE key>=? AND key<? ORDER BY key LIMIT ?",
    );
  }

  // Every range prefix ends in '|'. The next byte ends the range.
  private upper(prefix: string) {
    return prefix.slice(0, -1) + "}";
  }
  mark(key: string) {
    return this.insert.run(key).changes === 1;
  }
  has(key: string) {
    return this.get.get(key) !== undefined;
  }
  read<T>(key: string): T | undefined {
    const row = this.get.get(key);
    return row === undefined ? undefined : (JSON.parse(String(row.value)) as T);
  }
  write(key: string, value: unknown) {
    this.upsert.run(key, JSON.stringify(value));
  }
  delete(key: string) {
    this.remove.run(key);
  }
  deletePrefix(prefix: string) {
    this.removeRange.run(prefix, this.upper(prefix));
  }
  firstKey(prefix: string): string | undefined {
    return this.first.get(prefix, this.upper(prefix))?.key as
      | string
      | undefined;
  }
  values<T>(prefix: string, limit: number): T[] {
    const values: T[] = [];
    for (const row of this.range.iterate(prefix, this.upper(prefix), limit))
      values.push(JSON.parse(String(row.value)) as T);
    return values;
  }
  batch<T>(read: () => T): T {
    this.db.exec("BEGIN");
    // The entire scratch connection is discarded on failure.
    const result = read();
    this.db.exec("COMMIT");
    return result;
  }
  close() {
    this.db.close();
  }
}

class ReplayRequired extends Error {}
class ProcessingBudgetExceeded extends Error {}

interface EventHead {
  readonly position: number;
  readonly sequence: number;
  readonly id: string;
}

function eventHead(
  row: Record<string, SQLOutputValue> | undefined,
): EventHead | null {
  return row
    ? {
        position: Number(row.position),
        sequence: Number(row.sequence),
        id: String(row.event_id),
      }
    : null;
}

class TaskHistory {
  private readonly scratch = new TaskScratch();
  private readonly totals = new TaskSourceAggregation(this.scratch);
  private sourceResults: TaskSourceResults | undefined;
  private processed = 0;
  private processingCount = 0;
  private firstProcessing: number | null = null;
  private acquisitionCount = 0;
  head: EventHead | null = null;
  deferred = false;

  get eventCount() {
    return this.processed;
  }

  close() {
    this.scratch.close();
  }

  read(
    db: DatabaseSync,
    jobId: string,
    through: string,
    jobInRange: boolean,
    snapshot: EventHead | null,
    mode: "append" | "full" | "rowid",
    onRow: () => void,
    withActivity: boolean,
  ): TaskDetailEvents {
    return this.scratch.batch(() => {
      if (snapshot) {
        const rows = db
          .prepare(
            `
          SELECT rowid AS position, sequence, kind, payload_json,
                 ${mode === "append" ? "event_id, created_at," : ""}
                 julianday(created_at)<=julianday(?) AS in_range
          FROM execution_events
          WHERE job_id=? AND sequence>? AND sequence<=?
          ORDER BY sequence
        `,
          )
          .iterate(
            through,
            jobId,
            this.head?.sequence ?? -1,
            snapshot.sequence,
          );
        let sequence = this.head?.sequence ?? -1;
        let position = this.head?.position ?? 0;
        for (const row of rows) {
          onRow();
          const next = Number(row.sequence);
          const nextPosition = Number(row.position);
          if (
            mode !== "rowid" &&
            (nextPosition <= position ||
              (mode === "append" && next !== sequence + 1))
          )
            throw new ReplayRequired();
          sequence = next;
          position = nextPosition;
          this.acceptActivity(row);
          if (mode !== "rowid") this.acceptSource(row, jobInRange);
          if (mode === "append" && next > snapshot.sequence - TECHNICAL_LIMIT)
            this.storeTechnical(row, this.processed - 1);
        }
        if (sequence !== snapshot.sequence) throw new ReplayRequired();
        if (mode === "rowid" && jobInRange) {
          for (const row of db
            .prepare(
              `
            SELECT rowid AS position, kind, payload_json, 1 AS in_range
            FROM execution_events
            WHERE job_id=? AND rowid>0 AND kind IN (
              'metadata-source', 'acquisition-attempt', 'pdf-source-result'
            ) AND julianday(created_at)<=julianday(?)
            ORDER BY rowid
          `,
            )
            .iterate(jobId, through)) {
            onRow();
            this.acceptSource(row, true);
          }
        }
      }
      if (mode !== "append" && snapshot) {
        let ordinal = this.processed - 1;
        for (const row of db
          .prepare(
            `
            SELECT event_id, sequence, kind, payload_json, created_at
            FROM execution_events WHERE job_id=? AND sequence<=?
            ORDER BY sequence DESC LIMIT ?
          `,
          )
          .iterate(jobId, snapshot.sequence, TECHNICAL_LIMIT))
          this.storeTechnical(row, ordinal--);
      }
      this.head = snapshot;
      this.sourceResults ??= this.totals.summary();
      return {
        source_results: this.sourceResults,
        processing: {
          events: this.scratch.values<ProcessingDetailEvent>(
            "processing|",
            this.processingCount,
          ),
          first_sequence:
            this.processingCount >= 1000 ? this.firstProcessing : null,
        },
        acquisition: {
          events: withActivity
            ? this.scratch.values<Pick<ExecutionEvent, "payload">>(
                "acquisition|",
                ACQUISITION_LIMIT,
              )
            : [],
          truncated: this.acquisitionCount > ACQUISITION_LIMIT,
        },
        technical: withActivity ? this.technical(jobId) : [],
      };
    });
  }

  private storeTechnical(row: Record<string, SQLOutputValue>, ordinal: number) {
    this.scratch.write(
      "technical|" + eventPosition(ordinal % TECHNICAL_LIMIT),
      {
        event_id: String(row.event_id),
        sequence: Number(row.sequence),
        kind: String(row.kind),
        created_at: String(row.created_at),
        payload_json: String(row.payload_json),
      },
    );
  }

  private technical(jobId: string): ExecutionEvent[] {
    const rows = this.scratch.values<
      Omit<ExecutionEvent, "job_id" | "payload"> & {
        readonly payload_json: string;
      }
    >("technical|", TECHNICAL_LIMIT);
    const start =
      this.processed < TECHNICAL_LIMIT ? 0 : this.processed % TECHNICAL_LIMIT;
    return [...rows.slice(start), ...rows.slice(0, start)].map(
      ({ payload_json, ...row }) => ({
        ...row,
        job_id: jobId,
        payload: JSON.parse(payload_json) as unknown,
      }),
    );
  }

  private acceptActivity(row: Record<string, SQLOutputValue>) {
    const kind = String(row.kind);
    const sequence = Number(row.sequence);
    this.processed++;
    if (!SOURCE_RESULT_KINDS.has(kind)) {
      this.firstProcessing ??= sequence;
      this.processingCount++;
      if (processingDetailKinds.has(kind))
        this.scratch.write("processing|" + eventPosition(sequence), {
          kind,
          payload: JSON.parse(String(row.payload_json)) as unknown,
        });
    } else if (
      kind === "acquisition-attempt" &&
      this.acquisitionCount <= ACQUISITION_LIMIT
    ) {
      if (++this.acquisitionCount <= ACQUISITION_LIMIT)
        this.scratch.write("acquisition|" + eventPosition(sequence), {
          payload: JSON.parse(String(row.payload_json)) as unknown,
        });
    }
    // Preserve the full-page budget of the previous 1,000-event walk.
    if (
      this.processed % PROCESSING_PAGE_SIZE === 0 &&
      this.processingCount >= PROCESSING_LIMIT
    )
      throw new ProcessingBudgetExceeded();
  }

  private acceptSource(
    row: Record<string, SQLOutputValue>,
    jobInRange: boolean,
  ) {
    const kind = String(row.kind);
    if (!SOURCE_RESULT_KINDS.has(kind)) return;
    // A future timestamp can become eligible in a later read of these rows.
    if (!jobInRange || row.in_range !== 1) {
      this.deferred = true;
      return;
    }
    this.totals.accept(
      {
        kind,
        payload: JSON.parse(String(row.payload_json)) as unknown,
      },
      Number(row.position),
    );
    this.sourceResults = undefined;
  }
}

/** The caller pins a SQLite snapshot for the head check and the entire read. */
export class TaskDetailCache {
  private readonly entries = new Map<
    string,
    { history: TaskHistory; through: string; created: string }
  >();
  private catalogIdentity: string | undefined;
  private schemaVersion: number | undefined;

  clear() {
    for (const entry of this.entries.values()) entry.history.close();
    this.entries.clear();
    this.catalogIdentity = undefined;
    this.schemaVersion = undefined;
  }

  read(
    db: DatabaseSync,
    catalogIdentity: string,
    jobId: string,
    through: string,
    withActivity: boolean,
    checkpoint: () => void,
  ): TaskDetailRead {
    const job = db
      .prepare(
        "SELECT created_at, julianday(created_at)<=julianday(?) AS in_range FROM execution_jobs WHERE job_id=?",
      )
      .get(through, jobId);
    const schemaVersion = Number(
      db.prepare("PRAGMA schema_version").get()!.schema_version,
    );
    // Device and inode detect file replacement or restore. The schema cookie detects DDL.
    if (
      this.catalogIdentity !== catalogIdentity ||
      this.schemaVersion !== schemaVersion
    ) {
      this.clear();
      this.catalogIdentity = catalogIdentity;
      this.schemaVersion = schemaVersion;
    }
    const cached = this.entries.get(jobId);
    this.entries.delete(jobId);
    if (!job) {
      // A deleted job and its cascaded events no longer own a cached history.
      cached?.history.close();
      return { status: "not-found", rows_read: 0 };
    }

    const head = eventHead(
      db
        .prepare(
          "SELECT rowid AS position, sequence, event_id FROM execution_events WHERE job_id=? ORDER BY sequence DESC LIMIT 1",
        )
        .get(jobId),
    );
    const created = String(job.created_at);
    const previousHead = cached?.history.head;
    const anchor =
      previousHead &&
      eventHead(
        db
          .prepare(
            "SELECT rowid AS position, sequence, event_id FROM execution_events WHERE job_id=? AND sequence=?",
          )
          .get(jobId, previousHead.sequence),
      );
    // Application writers only append execution events. Deleting a job cascades
    // to its events. The job creation time detects reuse of a job ID.
    // The tail identity detects a missing or replaced tail. An indexed prefix
    // count also detects rows removed from the middle with the tail intact.
    const canAppend =
      cached &&
      cached.through <= through &&
      cached.created === created &&
      (!previousHead ||
        (anchor?.position === previousHead.position &&
          anchor.id === previousHead.id &&
          head &&
          head.sequence >= previousHead.sequence &&
          db
            .prepare(
              "SELECT count(*) AS count FROM execution_events WHERE job_id=? AND sequence<=?",
            )
            .get(jobId, previousHead.sequence)!.count ===
            cached.history.eventCount));
    let rows = 0;
    const onRow = () => {
      checkpoint();
      rows++;
    };
    const modes = canAppend
      ? (["append", "full", "rowid"] as const)
      : (["full", "rowid"] as const);
    if (!canAppend) cached?.history.close();
    for (const mode of modes) {
      const history = mode === "append" ? cached!.history : new TaskHistory();
      try {
        const detail = history.read(
          db,
          jobId,
          through,
          job.in_range === 1,
          head,
          mode,
          onRow,
          withActivity,
        );
        if (!history.deferred && mode !== "rowid") {
          this.entries.set(jobId, { history, through, created });
          if (this.entries.size > 32) {
            const [oldest, entry] = this.entries.entries().next().value!;
            entry.history.close();
            this.entries.delete(oldest);
          }
        } else history.close();
        return { status: "ok", detail, rows_read: rows };
      } catch (error) {
        history.close();
        if (error instanceof ProcessingBudgetExceeded)
          return { status: "budget-exceeded", rows_read: rows };
        if (
          mode !== "rowid" &&
          (error instanceof ReplayRequired ||
            error instanceof ContractValidationError)
        )
          continue;
        if (error instanceof ContractValidationError)
          return { status: "invalid-source", rows_read: rows };
        throw error;
      }
    }
    throw new Error("task event replay failed");
  }
}
