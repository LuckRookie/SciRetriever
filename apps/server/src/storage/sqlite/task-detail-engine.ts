import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  ContractValidationError,
  type StableFailure,
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

interface CitationSourceTransition {
  readonly target_id: string;
  readonly run_id: string;
  readonly source: string;
  readonly status: "cooling" | "disabled" | "recovered" | "retry-ended";
  readonly retries: number;
  readonly next_retry_at: string | null;
  readonly reason: StableFailure | null;
}
interface CitationPendingSample {
  readonly literature_id: string;
  readonly purpose: "reference-query" | "lookup";
  readonly relation_id?: string;
}
interface CitationBacklogChange extends CitationPendingSample {
  readonly source: string;
  readonly work_id: string;
  readonly action: "queued" | "settled";
}
export interface CitationSourceDetail extends CitationSourceTransition {
  readonly pending_count: number;
  readonly pending_sample: readonly CitationPendingSample[];
  readonly pending_truncated: boolean;
}

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
  readonly citation_cooldowns: {
    readonly sources: readonly CitationSourceDetail[];
    readonly truncated: boolean;
  };
}

export type TaskDetailRead = { readonly rows_read: number } & (
  | { readonly status: "ok"; readonly detail: TaskDetailEvents }
  | { readonly status: "invalid-source" | "budget-exceeded" | "not-found" }
);
export type TaskDetailProbe =
  | TaskDetailRead
  | {
      readonly status: "replay-required";
      readonly rows_read: number;
    };

const PROCESSING_PAGE_SIZE = 1000;
const PROCESSING_LIMIT = 100_000;
const ACQUISITION_LIMIT = 10_000;
const TECHNICAL_LIMIT = 1000;
const CITATION_SOURCE_LIMIT = 32;
const CITATION_PENDING_SAMPLE = 20;

function citationScope(...parts: string[]) {
  return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

function pendingCitationPrefix(target: string, run: string, source: string) {
  return `citation-pending|${citationScope(target, run, source)}|`;
}

/** Private working storage. SQLite spills to disk and unlinks on close. */
class TaskScratch implements TaskResultScratch {
  private readonly db: DatabaseSync;
  private readonly path: string | undefined;
  private readonly insert: StatementSync;
  private readonly get: StatementSync;
  private readonly upsert: StatementSync;
  private readonly remove: StatementSync;
  private readonly removeRange: StatementSync;
  private readonly first: StatementSync;
  private readonly range: StatementSync;

  constructor(path?: string, restored = false) {
    this.path = path;
    this.db = new DatabaseSync(path ?? "");
    this.db.exec(`
      PRAGMA temp_store=FILE;
      PRAGMA cache_size=-512;
      PRAGMA journal_mode=OFF;
    `);
    if (!restored)
      this.db.exec(
        "CREATE TABLE entries(key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID",
      );
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
  close(keep = false) {
    try {
      this.db.close();
    } finally {
      if (this.path && !keep)
        rmSync(dirname(this.path), { recursive: true, force: true });
    }
  }
}

class ReplayRequired extends Error {}
class ProcessingBudgetExceeded extends Error {}

interface EventHead {
  readonly position: number;
  readonly sequence: number;
  readonly id: string;
}

interface HistoryState {
  readonly totals: ReturnType<
    InstanceType<typeof TaskSourceAggregation>["state"]
  >;
  readonly processed: number;
  readonly storedEvents: number;
  readonly processingCount: number;
  readonly firstProcessing: number | null;
  readonly acquisitionCount: number;
  readonly head: EventHead | null;
}
export interface TaskHistoryTransfer {
  readonly path: string;
  readonly jobId: string;
  readonly identity: string;
  readonly schemaVersion: number;
  readonly through: string;
  readonly created: string;
  readonly state: HistoryState;
}
export interface TaskDetailReplay {
  readonly result: TaskDetailRead;
  readonly transfer?: TaskHistoryTransfer;
}

/** Materialize a bounded page, then aggregate without a live catalog snapshot. */
function* eventPages(
  query: StatementSync,
  params: readonly SQLInputValue[],
  cursor: number,
  key: "sequence" | "position",
) {
  for (;;) {
    const page = query.all(...params, cursor, PROCESSING_PAGE_SIZE);
    yield* page;
    if (page.length < PROCESSING_PAGE_SIZE) return;
    cursor = Number(page.at(-1)![key]);
  }
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
  private readonly scratch: TaskScratch;
  private readonly totals: InstanceType<typeof TaskSourceAggregation>;
  private sourceResults: TaskSourceResults | undefined;
  private processed = 0;
  private storedEvents = 0;
  private processingCount = 0;
  private firstProcessing: number | null = null;
  private acquisitionCount = 0;
  head: EventHead | null = null;
  deferred = false;

  constructor(path?: string, state?: HistoryState) {
    this.scratch = new TaskScratch(path, state !== undefined);
    this.totals = new TaskSourceAggregation(this.scratch, state?.totals);
    if (state) {
      this.processed = state.processed;
      this.storedEvents = state.storedEvents;
      this.processingCount = state.processingCount;
      this.firstProcessing = state.firstProcessing;
      this.acquisitionCount = state.acquisitionCount;
      this.head = state.head;
    }
  }

  state(): HistoryState {
    return {
      totals: this.totals.state(),
      processed: this.processed,
      storedEvents: this.storedEvents,
      processingCount: this.processingCount,
      firstProcessing: this.firstProcessing,
      acquisitionCount: this.acquisitionCount,
      head: this.head,
    };
  }

  get eventCount() {
    return this.storedEvents;
  }

  close(keep = false) {
    this.scratch.close(keep);
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
    paged = false,
    checkpoint = onRow,
  ): TaskDetailEvents {
    return this.scratch.batch(() => {
      const appendTechnical =
        mode === "append" &&
        !!snapshot &&
        !!this.head &&
        snapshot.sequence - this.head.sequence <= TECHNICAL_LIMIT;
      if (snapshot) {
        const query = db.prepare(
          `
          SELECT rowid AS position, sequence, kind, payload_json,
                 ${mode === "append" ? "event_id, created_at," : ""}
                 julianday(created_at)<=julianday(?) AS in_range
          FROM execution_events
          WHERE job_id=? AND sequence<=? AND sequence>?
          ORDER BY sequence LIMIT ?
        `,
        );
        const params = [through, jobId, snapshot.sequence] as const;
        const after = this.head?.sequence ?? -1;
        const rows = paged
          ? eventPages(query, params, after, "sequence")
          : query.iterate(...params, after, -1);
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
          this.storedEvents++;
          if (row.kind === "citation-write-checkpoint") continue;
          this.acceptActivity(row);
          if (mode !== "rowid") this.acceptSource(row, jobInRange);
          if (appendTechnical) this.storeTechnical(row, this.processed - 1);
        }
        if (sequence !== snapshot.sequence) throw new ReplayRequired();
        if (mode === "rowid" && jobInRange) {
          const query = db.prepare(
            `
            SELECT rowid AS position, kind, payload_json, 1 AS in_range
            FROM execution_events ${paged ? "NOT INDEXED" : ""}
            WHERE job_id=? AND sequence<=? AND kind IN (
              'metadata-source', 'acquisition-attempt', 'pdf-source-result'
            ) AND julianday(created_at)<=julianday(?) AND rowid>?
            ORDER BY rowid LIMIT ?
          `,
          );
          const params = [jobId, snapshot.sequence, through] as const;
          const rows = paged
            ? eventPages(query, params, 0, "position")
            : query.iterate(...params, 0, -1);
          for (const row of rows) {
            onRow();
            this.acceptSource(row, true);
          }
        }
      }
      if (!appendTechnical && snapshot) {
        let ordinal = this.processed - 1;
        const query = db.prepare(
          `
            SELECT event_id, sequence, kind, payload_json, created_at
            FROM execution_events WHERE job_id=? AND sequence<=? AND sequence<?
              ${paged ? "" : "AND kind<>'citation-write-checkpoint'"}
            ORDER BY sequence DESC LIMIT ?
          `,
        );
        const rows = paged
          ? eventPages(
              query,
              [jobId, snapshot.sequence],
              snapshot.sequence + 1,
              "sequence",
            )
          : query.iterate(
              jobId,
              snapshot.sequence,
              snapshot.sequence + 1,
              TECHNICAL_LIMIT,
            );
        for (const row of rows) {
          if (paged) checkpoint();
          if (row.kind === "citation-write-checkpoint") continue;
          this.storeTechnical(row, ordinal--);
          if (this.processed - ordinal - 1 === TECHNICAL_LIMIT) break;
        }
      }
      this.head = snapshot;
      const source_results = (this.sourceResults ??= this.totals.summary());
      const citationSources = withActivity ? this.citationSources() : [];
      return {
        source_results,
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
        citation_cooldowns: {
          sources: citationSources.slice(0, CITATION_SOURCE_LIMIT),
          truncated: citationSources.length > CITATION_SOURCE_LIMIT,
        },
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
    if (kind === "citation-source-cooldown") {
      const event = JSON.parse(
        String(row.payload_json),
      ) as CitationSourceTransition;
      this.scratch.write(
        "citation-source|" + citationScope(event.target_id, event.source),
        event,
      );
    } else if (kind === "citation-source-deferred") {
      const event = JSON.parse(String(row.payload_json)) as {
        target_id: string;
        run_id: string;
        changes: readonly CitationBacklogChange[];
      };
      for (const { source, work_id, action, ...pending } of event.changes) {
        const prefix = pendingCitationPrefix(
          event.target_id,
          event.run_id,
          source,
        );
        const key = prefix + citationScope(work_id);
        const had = this.scratch.has(key);
        if ((action === "queued") === had) continue;
        const countKey = "citation-count|" + prefix;
        const count = this.scratch.read<number>(countKey) ?? 0;
        if (action === "queued") this.scratch.write(key, pending);
        else this.scratch.delete(key);
        this.scratch.write(countKey, count + (action === "queued" ? 1 : -1));
      }
    } else if (!SOURCE_RESULT_KINDS.has(kind)) {
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

  private citationSources(): CitationSourceDetail[] {
    return this.scratch
      .values<CitationSourceTransition>(
        "citation-source|",
        CITATION_SOURCE_LIMIT + 1,
      )
      .map((event) => {
        const prefix = pendingCitationPrefix(
          event.target_id,
          event.run_id,
          event.source,
        );
        const pending_count =
          this.scratch.read<number>("citation-count|" + prefix) ?? 0;
        const pending_sample = this.scratch.values<CitationPendingSample>(
          prefix,
          CITATION_PENDING_SAMPLE,
        );
        return {
          ...event,
          pending_count,
          pending_sample,
          pending_truncated: pending_count > pending_sample.length,
        };
      });
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

  private establishIdentity(identity: string, schemaVersion: number) {
    if (
      this.catalogIdentity !== identity ||
      this.schemaVersion !== schemaVersion
    ) {
      this.clear();
      this.catalogIdentity = identity;
      this.schemaVersion = schemaVersion;
    }
  }

  private remember(
    jobId: string,
    history: TaskHistory,
    through: string,
    created: string,
  ) {
    this.entries.set(jobId, { history, through, created });
    if (this.entries.size > 32) {
      const [oldest, entry] = this.entries.entries().next().value!;
      entry.history.close();
      this.entries.delete(oldest);
    }
  }

  install(
    db: DatabaseSync,
    identity: string,
    value: TaskHistoryTransfer,
  ): boolean {
    const cookie = Number(
      db.prepare("PRAGMA schema_version").get()!.schema_version,
    );
    this.establishIdentity(identity, cookie);
    if (identity !== value.identity || cookie !== value.schemaVersion)
      return false;
    const previous = this.entries.get(value.jobId);
    if (
      previous &&
      (previous.through > value.through ||
        (previous.history.head?.sequence ?? -1) >
          (value.state.head?.sequence ?? -1))
    )
      return false;
    const history = new TaskHistory(value.path, value.state);
    previous?.history.close();
    this.entries.delete(value.jobId);
    this.remember(value.jobId, history, value.through, value.created);
    return true;
  }

  read(
    db: DatabaseSync,
    catalogIdentity: string,
    jobId: string,
    through: string,
    withActivity: boolean,
    checkpoint: () => void,
    incrementalOnly?: false,
  ): TaskDetailRead;
  read(
    db: DatabaseSync,
    catalogIdentity: string,
    jobId: string,
    through: string,
    withActivity: boolean,
    checkpoint: () => void,
    incrementalOnly: boolean,
  ): TaskDetailProbe;
  read(
    db: DatabaseSync,
    catalogIdentity: string,
    jobId: string,
    through: string,
    withActivity: boolean,
    checkpoint: () => void,
    incrementalOnly = false,
  ): TaskDetailProbe {
    const job = db
      .prepare(
        "SELECT created_at, julianday(created_at)<=julianday(?) AS in_range FROM execution_jobs WHERE job_id=?",
      )
      .get(through, jobId);
    const schemaVersion = Number(
      db.prepare("PRAGMA schema_version").get()!.schema_version,
    );
    // Device and inode detect file replacement or restore. The schema cookie detects DDL.
    this.establishIdentity(catalogIdentity, schemaVersion);
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
    if (incrementalOnly && !canAppend) {
      cached?.history.close();
      return { status: "replay-required", rows_read: 0 };
    }
    const modes = incrementalOnly
      ? (["append"] as const)
      : canAppend
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
          this.remember(jobId, history, through, created);
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
        ) {
          if (incrementalOnly)
            return { status: "replay-required", rows_read: rows };
          continue;
        }
        if (error instanceof ContractValidationError)
          return { status: "invalid-source", rows_read: rows };
        throw error;
      }
    }
    throw new Error("task event replay failed");
  }
}

function taskBoundary(
  db: DatabaseSync,
  jobId: string,
  through: string,
  previous?: EventHead | null,
) {
  db.exec("BEGIN");
  try {
    const job = db
      .prepare(
        "SELECT created_at,julianday(created_at)<=julianday(?) AS in_range FROM execution_jobs WHERE job_id=?",
      )
      .get(through, jobId);
    if (!job) return null;
    const head =
      previous === undefined
        ? eventHead(
            db
              .prepare(
                "SELECT rowid AS position,sequence,event_id FROM execution_events WHERE job_id=? ORDER BY sequence DESC LIMIT 1",
              )
              .get(jobId),
          )
        : previous &&
          eventHead(
            db
              .prepare(
                "SELECT rowid AS position,sequence,event_id FROM execution_events WHERE job_id=? AND sequence=?",
              )
              .get(jobId, previous.sequence),
          );
    const count = head
      ? Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM execution_events WHERE job_id=? AND sequence<=?",
            )
            .get(jobId, head.sequence)!.n,
        )
      : 0;
    const schemaVersion = Number(
      db.prepare("PRAGMA schema_version").get()!.schema_version,
    );
    return {
      created: String(job.created_at),
      inRange: job.in_range === 1,
      head,
      count,
      schemaVersion,
    };
  } finally {
    db.exec("COMMIT");
  }
}

/** A captured append-only prefix is equivalent to one read snapshot. The
 * position, job lifetime and range count also detect concurrent deletion. */
export function replayTaskDetail(
  db: DatabaseSync,
  catalogIdentity: () => string,
  jobId: string,
  through: string,
  withActivity: boolean,
  path: string,
  checkpoint: () => void,
): TaskDetailReplay {
  for (let attempt = 0; attempt < 2; attempt++) {
    const identity = catalogIdentity();
    const boundary = taskBoundary(db, jobId, through);
    if (!boundary) return { result: { status: "not-found", rows_read: 0 } };
    let rows = 0;
    const onRow = () => {
      checkpoint();
      rows++;
    };
    let changed = false;
    for (const mode of ["full", "rowid"] as const) {
      checkpoint();
      const history = new TaskHistory(path);
      let keep = false;
      try {
        const detail = history.read(
          db,
          jobId,
          through,
          boundary.inRange,
          boundary.head,
          mode,
          onRow,
          withActivity,
          true,
          checkpoint,
        );
        const after = taskBoundary(db, jobId, through, boundary.head);
        if (
          catalogIdentity() !== identity ||
          JSON.stringify(after) !== JSON.stringify(boundary)
        ) {
          changed = true;
          break;
        }
        const result = { status: "ok" as const, detail, rows_read: rows };
        if (history.deferred || mode === "rowid") return { result };
        keep = true;
        return {
          result,
          transfer: {
            path,
            jobId,
            identity,
            schemaVersion: boundary.schemaVersion,
            through,
            created: boundary.created,
            state: history.state(),
          },
        };
      } catch (error) {
        checkpoint();
        const after = taskBoundary(db, jobId, through, boundary.head);
        if (
          catalogIdentity() !== identity ||
          JSON.stringify(after) !== JSON.stringify(boundary)
        ) {
          changed = true;
          break;
        }
        if (error instanceof ProcessingBudgetExceeded)
          return { result: { status: "budget-exceeded", rows_read: rows } };
        if (
          mode === "full" &&
          (error instanceof ReplayRequired ||
            error instanceof ContractValidationError)
        )
          continue;
        if (error instanceof ContractValidationError)
          return { result: { status: "invalid-source", rows_read: rows } };
        throw error;
      } finally {
        history.close(true);
        if (!keep) rmSync(path, { force: true });
      }
    }
    if (!changed) break;
  }
  throw new Error("task event replay snapshot changed");
}
