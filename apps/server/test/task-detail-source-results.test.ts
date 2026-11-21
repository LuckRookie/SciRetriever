import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { ContractValidationError } from "@sciretriever/contracts";
import {
  processingEvents,
  readProcessingTask,
} from "../src/application/jobs/processing.js";
import { SourceResultAggregation } from "../src/application/source-results.js";
import { createTaskReader } from "../src/entry/task-read.js";
import { ExecutionRepository } from "../src/storage/execution/repository.js";
import {
  TaskDetailCache,
  type TaskDetailRead,
} from "../src/storage/sqlite/task-detail-engine.js";
import {
  SqliteWorker,
  type ExecutionEvent,
} from "../src/storage/sqlite/worker.js";

const at = "2026-10-28T00:00:00.000Z";
const afterAt = "2026-10-28T00:01:00.000Z";
const snapshotCatalogIdentity = "snapshot-fixture";
const literature = "00000000-0000-4000-8000-000000000001";
type Event = Pick<ExecutionEvent, "kind" | "payload">;

function progress(
  id: string,
  change: Record<string, unknown>,
  source = "crossref",
  unit = id,
  purpose = "reference-query",
): Event {
  return {
    kind: "metadata-source",
    payload: {
      target_id: "target",
      progress: {
        schema_version: 1,
        record_id: id,
        source,
        purpose,
        role: "primary",
        unit_id: unit,
        at,
        ...change,
      },
    },
  };
}

function finish(result: string, problem: unknown = null) {
  return { phase: "finished", result, problem };
}

function diagnostic(code: string, display = "error") {
  return {
    display,
    technical_details: { diagnostics: [{ code, scope: "metadata" }] },
  };
}

function attempt(
  target: string,
  source: string,
  result: string,
  requested: boolean,
  code?: string,
): Event {
  return {
    kind: "acquisition-attempt",
    payload: {
      target_id: target,
      attempt_id: target + "-attempt",
      literature_id: literature,
      attempt: {
        stage: "publisher-api",
        source,
        result,
        requested,
        started_at: at,
        finished_at: at,
        ...(code ? { code } : {}),
      },
    },
  };
}

function publication(target: string, source: string | null): Event {
  return {
    kind: "pdf-source-result",
    payload: {
      target_id: target,
      result: {
        schema_version: 1,
        literature_id: literature,
        finished_at: at,
        result: source ? "obtained" : "not-obtained",
        source,
        stage: source ? "publisher-api" : null,
        receipt_id: source ? "published-" + target : null,
        technical_details: { diagnostics: [] },
      },
    },
  };
}

function createJob(repository: ExecutionRepository, jobId: string) {
  return repository.createJob({
    job_id: jobId,
    target_kind: "selector",
    selector: {},
    policy_version: "task-detail-fixture",
    policy: {},
    idempotency_key: jobId,
    created_at: at,
  });
}

function append(
  repository: ExecutionRepository,
  jobId: string,
  eventId: string,
  event: Event,
) {
  return repository.appendEvent({
    job_id: jobId,
    event_id: eventId,
    sequence: -1,
    created_at: at,
    ...event,
  });
}

function full(jobId: string, events: readonly Event[]) {
  const totals = new SourceResultAggregation();
  for (const event of events) totals.accept({ job_id: jobId, ...event });
  return totals.task();
}

function syntheticCatalog(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  return db;
}

function readSnapshot(
  cache: TaskDetailCache,
  db: DatabaseSync,
  jobId: string,
  through = afterAt,
) {
  db.exec("BEGIN");
  try {
    return cache.read(
      db,
      snapshotCatalogIdentity,
      jobId,
      through,
      true,
      () => {},
    );
  } finally {
    db.exec("COMMIT");
  }
}

function successful(value: TaskDetailRead) {
  if (value.status !== "ok")
    throw new Error("task projection fixture failed: " + value.status);
  return value;
}

it("reads the appended rows for a million completed source records and measures detail and adjacent reads", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-task-detail-scale-"));
  const path = join(home, "catalog.sqlite");
  const database = new SqliteWorker(path);
  const repository = new ExecutionRepository(database);
  const jobId = "million-source-records";
  const total = 1_000_000;
  try {
    await createJob(repository, jobId);
    await createJob(repository, "many-targets");
    await repository.updateJob(jobId, "running");
    const seed = syntheticCatalog(path);
    try {
      seed.exec("BEGIN");
      const insert = seed.prepare(`
        WITH RECURSIVE records(n) AS (VALUES(CAST(? AS INTEGER)) UNION ALL SELECT n+1 FROM records WHERE n+1<?),
             phases(offset) AS (VALUES(0),(1))
        INSERT INTO execution_events (event_id, job_id, sequence, kind, payload_json, created_at)
        SELECT 'seed-' || (2*n+offset), ?, 2*n+offset, 'metadata-source',
               json_object('target_id','target','progress',
                 CASE offset WHEN 0 THEN json_object(
                   'schema_version',1,'record_id','call-'||n,'source','crossref',
                   'purpose','reference-query','role','primary','unit_id','unit-'||n,'at',?,
                   'phase','started')
                 ELSE json_object(
                   'schema_version',1,'record_id','call-'||n,'source','crossref',
                   'purpose','reference-query','role','primary','unit_id','unit-'||n,'at',?,
                   'phase','finished','result','miss','problem',NULL)
                 END),
               ?
        FROM records CROSS JOIN phases ORDER BY n, offset
      `);
      for (let offset = 0; offset < total; offset += 10_000)
        insert.run(offset, offset + 10_000, jobId, at, at, at);
      seed
        .prepare(
          `
        INSERT INTO execution_targets VALUES('one-target',?,0,NULL,NULL,'queued','pending',NULL)
      `,
        )
        .run(jobId);
      seed.exec(`
        WITH RECURSIVE targets(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM targets WHERE n<9999)
        INSERT INTO execution_targets SELECT 'target-'||n,'many-targets',n,NULL,NULL,'queued','pending',NULL FROM targets;
        COMMIT
      `);
    } finally {
      seed.close();
    }

    await append(
      repository,
      jobId,
      "append-open",
      progress("open", { phase: "started" }),
    );
    const detailReads = vi.spyOn(repository, "taskDetailEvents");
    const eventPages = vi.spyOn(repository, "listEvents");
    const reader = createTaskReader(repository);
    const started = performance.now();
    const first = await reader.read(jobId);
    const coldMs = performance.now() - started;
    expect(successful(await detailReads.mock.results[0]!.value).rows_read).toBe(
      2 * total + 1,
    );
    expect(first.source_results.metadata).toMatchObject({
      record_count: total + 1,
      records_truncated: true,
      returned: 0,
      sources: [{ source: "crossref", requests: 0, hit_units: 0 }],
    });
    expect(first.source_results.metadata?.records).toHaveLength(200);
    expect(first.source_results.metadata?.records.at(-1)?.record_id).toBe(
      "call-199",
    );

    const delta = [
      progress("open", { phase: "requested" }),
      progress("open", { phase: "returned", count: 3 }),
      progress("open", {
        phase: "included",
        result_id: "paper-1",
        disposition: "related",
      }),
      progress("open", {
        phase: "included",
        result_id: "paper-1",
        disposition: "related",
      }),
      progress("open", { phase: "rejected", count: 2 }),
      progress("open", finish("error", diagnostic("synthetic-error"))),
      { kind: "processing-result", payload: { disposition: "completed" } },
    ];
    for (const [i, event] of delta.entries())
      await append(repository, jobId, "append-" + i, event);
    const warmStarted = performance.now();
    const second = await reader.read(jobId);
    const warmMs = performance.now() - warmStarted;
    expect(successful(await detailReads.mock.results[1]!.value).rows_read).toBe(
      delta.length,
    );
    expect(second.source_results.metadata).toMatchObject({
      record_count: total + 1,
      returned: 3,
      rejected: 2,
      merged: 1,
      sources: [
        {
          source: "crossref",
          requests: 1,
          attempted_units: 1,
          hit_units: 0,
          errors: 1,
          included: 1,
        },
      ],
    });
    expect(second.results).toEqual([{ disposition: "completed" }]);
    expect(eventPages).not.toHaveBeenCalled();
    expect(second.events).toEqual(
      [...(await repository.listEvents(jobId, -1, 1000, "newest"))].reverse(),
    );
    expect(second.events_truncated).toBe(true);

    const externalDelta = [
      progress("external", { phase: "started" }),
      progress("external", { phase: "requested" }),
      progress("external", { phase: "returned", count: 5 }),
      progress("external", finish("hit")),
    ];
    const cliWriter = new SqliteWorker(path);
    const cliRepository = new ExecutionRepository(cliWriter);
    let external: Awaited<ReturnType<typeof reader.read>>;
    let externalMs: number;
    try {
      for (const [i, event] of externalDelta.entries())
        await append(cliRepository, jobId, "external-" + i, event);
      const externalStarted = performance.now();
      external = await reader.read(jobId);
      externalMs = performance.now() - externalStarted;
    } finally {
      await cliWriter.close();
    }
    expect(successful(await detailReads.mock.results[2]!.value).rows_read).toBe(
      externalDelta.length,
    );
    expect(external.job.status).toBe("running");
    expect(external.source_results.metadata).toMatchObject({
      record_count: total + 2,
      returned: 8,
      rejected: 2,
      merged: 1,
      sources: [
        {
          source: "crossref",
          requests: 2,
          attempted_units: 2,
          hit_units: 1,
          errors: 1,
        },
      ],
    });

    const prefixCountMs: number[] = [];
    const counter = new DatabaseSync(path, { readOnly: true });
    try {
      const countSql =
        "SELECT count(*) AS count FROM execution_events WHERE job_id=? AND sequence<=?";
      const tail = second.events.at(-1)!.sequence;
      expect(
        counter.prepare(`EXPLAIN QUERY PLAN ${countSql}`).get(jobId, tail)
          ?.detail,
      ).toMatch(/USING COVERING INDEX .+ \(job_id=\? AND sequence<\?\)/u);
      const count = counter.prepare(countSql);
      for (let i = 0; i < 3; i++) {
        const countStarted = performance.now();
        const prefix = count.get(jobId, tail);
        prefixCountMs.push(performance.now() - countStarted);
        expect(prefix?.count).toBe(2 * total + 1 + delta.length);
      }
    } finally {
      counter.close();
    }

    await repository.updateJob(jobId, "completed", afterAt);
    const done = await reader.read(jobId);
    expect(done.job.status).toBe("completed");
    expect(done.source_results).toEqual(external.source_results);
    expect(successful(await detailReads.mock.results[3]!.value).rows_read).toBe(
      0,
    );

    const coldReader = new SqliteWorker(path, undefined, { readOnly: true });
    let cliMs: number;
    try {
      const cliStarted = performance.now();
      const fresh = await readProcessingTask(
        new ExecutionRepository(coldReader),
        jobId,
      );
      cliMs = performance.now() - cliStarted;
      expect(fresh.source_results).toEqual(external.source_results);
      expect(fresh).toEqual(await readProcessingTask(repository, jobId));
    } finally {
      await coldReader.close();
    }

    const time = async <T>(operation: () => Promise<T>) => {
      const began = performance.now();
      const value = await operation();
      return { value, ms: performance.now() - began };
    };
    const [one, many, oldEvents] = [
      await time(() => repository.listTargets(jobId, 10_000, true)),
      await time(() => repository.listTargets("many-targets", 10_000, true)),
      await time(() => processingEvents(repository, jobId)),
    ];
    expect(one.value).toHaveLength(1);
    expect(many.value).toHaveLength(10_000);
    expect(oldEvents.value).toHaveLength(1);
    console.info(
      "task-detail-scale",
      JSON.stringify({
        records: total,
        cold_ms: coldMs,
        warm_ms: warmMs,
        warm_rows: delta.length,
        external_warm_ms: externalMs,
        external_warm_rows: externalDelta.length,
        prefix_count_rows: 2 * total + 1 + delta.length,
        prefix_count_ms: prefixCountMs,
        one_target_ms: one.ms,
        ten_thousand_targets_ms: many.ms,
        old_processing_events_ms: oldEvents.ms,
        fresh_show_ms: cliMs,
      }),
    );
  } finally {
    await database.close();
    await rm(home, { force: true, recursive: true });
  }
}, 150_000);

it("matches full replay for distinct metadata, late outcomes, and replacement PDF deliveries while appends race reads", async () => {
  const database = new SqliteWorker();
  const repository = new ExecutionRepository(database);
  const reader = createTaskReader(repository);
  const jobId = "mixed-sources";
  try {
    await createJob(repository, jobId);
    const initial: Event[] = [
      progress("first", { phase: "started" }, "crossref", "unit"),
      progress("first", { phase: "requested" }, "crossref", "unit"),
      progress(
        "first",
        { phase: "observed", result_id: "same", disposition: "matched" },
        "crossref",
        "unit",
      ),
      progress(
        "first",
        { phase: "included", result_id: "same", disposition: "related" },
        "crossref",
        "unit",
      ),
      progress("first", { phase: "returned", count: 4 }, "crossref", "unit"),
      progress("second", { phase: "started" }, "crossref", "unit"),
      progress("second", { phase: "requested" }, "crossref", "unit"),
      progress(
        "second",
        { phase: "included", result_id: "same", disposition: "related" },
        "crossref",
        "unit",
      ),
      progress("second", finish("hit"), "crossref", "unit"),
      progress("third", { phase: "started" }, "openalex", "unit", "lookup"),
      progress(
        "third",
        { phase: "included", result_id: "same", disposition: "related" },
        "openalex",
        "unit",
        "lookup",
      ),
      progress("fourth", { phase: "started" }),
      progress(
        "fourth",
        finish("unavailable", diagnostic("not-configured", "not-configured")),
      ),
      attempt("pdf-a", "wiley", "hit", false),
      attempt("pdf-b", "elsevier", "rejected", true, "pdf-source-rejected"),
      attempt("pdf-c", "doi-resolution", "hit", true),
      publication("pdf-b", null),
      publication("pdf-d", "old-channel"),
    ];
    for (const [i, event] of initial.entries())
      await append(repository, jobId, "initial-" + i, event);
    expect((await reader.read(jobId)).source_results).toEqual(
      full(jobId, initial),
    );

    const changes: Event[] = [
      progress("first", { phase: "requested" }, "crossref", "unit"),
      progress("first", { phase: "rejected", count: 3 }, "crossref", "unit"),
      progress(
        "first",
        finish("error", diagnostic("failed")),
        "crossref",
        "unit",
      ),
      progress(
        "third",
        { phase: "observed", result_id: "same", disposition: "created" },
        "openalex",
        "unit",
        "lookup",
      ),
      progress("third", finish("cancelled"), "openalex", "unit", "lookup"),
      attempt("pdf-a", "wiley", "failed", true, "execution-cancelled"),
      publication("pdf-a", "elsevier"),
      publication("pdf-a", null),
      publication("pdf-d", "new-channel"),
      attempt("pdf-d", "new-channel", "rejected", true, "later-failure"),
    ];
    const snapshots = [full(jobId, initial)];
    for (const [i, event] of changes.entries()) {
      const [detail] = await Promise.all([
        reader.read(jobId),
        append(repository, jobId, "change-" + i, event),
      ]);
      const next = full(jobId, [...initial, ...changes.slice(0, i + 1)]);
      expect([snapshots.at(-1), next]).toContainEqual(detail.source_results);
      snapshots.push(next);
    }
    const done = await reader.read(jobId);
    expect(done.source_results).toEqual(snapshots.at(-1));
    expect(done.source_results.metadata?.new_literatures).toBe(1);
    expect(done.source_results.metadata?.matched_literatures).toBe(0);
    expect(done.source_results.metadata?.records[0]).toMatchObject({
      result: "error",
      rejected: 3,
    });
    expect(done.source_results.pdf?.sources.map((row) => row.source)).toEqual([
      "wiley",
      "elsevier",
      "new-channel",
    ]);
    expect(done.acquisition_traces).toHaveLength(4);

    await append(
      repository,
      jobId,
      "duplicate",
      progress("first", { phase: "started" }),
    );
    await expect(reader.read(jobId)).rejects.toBeInstanceOf(
      ContractValidationError,
    );
  } finally {
    await database.close();
  }
});

it("replays after cache eviction, a missing sequence, and deletion inside an unchanged event head", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-task-detail-replay-"),
  );
  const path = join(home, "catalog.sqlite");
  const worker = new SqliteWorker(path);
  const repository = new ExecutionRepository(worker);
  const cache = new TaskDetailCache();
  try {
    await createJob(repository, "target");
    for (let n = 0; n < 32; n++) await createJob(repository, "other-" + n);
    const db = syntheticCatalog(path);
    try {
      const insert = db.prepare(
        "INSERT INTO execution_events VALUES(?,?,?,?,?,?)",
      );
      const started = progress("a", { phase: "started" });
      const returned = progress("a", { phase: "returned", count: 4 });
      const finished = progress("a", finish("miss"));
      for (const [sequence, event] of [started, returned].entries())
        insert.run(
          "fixture-" + sequence,
          "target",
          sequence,
          event.kind,
          JSON.stringify(event.payload),
          at,
        );
      const read = () => successful(readSnapshot(cache, db, "target"));
      expect(read().rows_read).toBe(2);
      expect(read().rows_read).toBe(0);
      // Internal appends allocate consecutive positions. A hole after the
      // cached tail needs a replay even when the old prefix is intact.
      insert.run(
        "fixture-3",
        "target",
        3,
        finished.kind,
        JSON.stringify(finished.payload),
        at,
      );
      const gap = read();
      expect(gap.rows_read).toBeGreaterThan(1);
      expect(gap.detail.source_results).toEqual(
        full("target", [started, returned, finished]),
      );
      expect(read().rows_read).toBe(0);

      const otherConnection = syntheticCatalog(path);
      try {
        otherConnection
          .prepare("DELETE FROM execution_events WHERE event_id='fixture-1'")
          .run();
      } finally {
        otherConnection.close();
      }
      const deleted = read();
      expect(deleted.rows_read).toBe(2);
      expect(deleted.detail.source_results).toEqual(
        full("target", [started, finished]),
      );
      for (let n = 0; n < 32; n++) readSnapshot(cache, db, "other-" + n);
      const evicted = read();
      expect(evicted.rows_read).toBe(2);
      expect(evicted.detail).toEqual(deleted.detail);
    } finally {
      db.close();
    }
  } finally {
    cache.clear();
    await worker.close();
    await rm(home, { force: true, recursive: true });
  }
});

it("keeps the cache across unrelated writes and rebuilds after a middle deletion", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-task-detail-prefix-"),
  );
  const path = join(home, "catalog.sqlite");
  const worker = new SqliteWorker(path);
  const repository = new ExecutionRepository(worker);
  const jobId = "target";
  const started = progress("source", { phase: "started" });
  const returned = progress("source", { phase: "returned", count: 4 });
  const finished = progress("source", finish("hit"));
  const read = async () =>
    successful(await repository.taskDetailEvents(jobId, true));
  try {
    await createJob(repository, jobId);
    for (const [i, event] of [started, returned, finished].entries())
      await append(repository, jobId, "fixture-" + i, event);
    const before = await read();
    expect(before.rows_read).toBe(3);

    const otherConnection = syntheticCatalog(path);
    try {
      otherConnection
        .prepare(
          `
        INSERT INTO operation_records(operation_id,actor,operation,scope_json,result_json,status,created_at,finished_at)
        VALUES('fixture-operation','fixture','fixture-operation','{}','{}','completed',?,?)
      `,
        )
        .run(at, at);
      const unrelatedWrite = await read();
      expect(unrelatedWrite.rows_read).toBe(0);
      expect(unrelatedWrite.detail).toEqual(before.detail);

      otherConnection
        .prepare("DELETE FROM execution_events WHERE event_id='fixture-1'")
        .run();
      const deleted = await read();
      expect(deleted.rows_read).toBe(2);
      expect(deleted.detail.source_results).toEqual(
        full(jobId, [started, finished]),
      );
      expect(deleted.detail.technical.at(-1)).toEqual(
        before.detail.technical.at(-1),
      );
    } finally {
      otherConnection.close();
    }
  } finally {
    await worker.close();
    await rm(home, { force: true, recursive: true });
  }
});

it.each([
  { guard: "a replaced tail", createdAt: at, tailId: "replacement-tail" },
  {
    guard: "a different creation time",
    createdAt: afterAt,
    tailId: "initial-tail",
  },
])(
  "rebuilds when a job ID is reused with $guard",
  async ({ createdAt, tailId }) => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-task-detail-recreate-"),
    );
    const path = join(home, "catalog.sqlite");
    const worker = new SqliteWorker(path);
    const repository = new ExecutionRepository(worker);
    const jobId = "reused";
    const started = progress("source", { phase: "started" });
    const returned = progress("source", { phase: "returned", count: 4 });
    const replacement = progress("source", { phase: "returned", count: 9 });
    const finished = progress("source", finish("hit"));
    const read = async () =>
      successful(await repository.taskDetailEvents(jobId, true));
    try {
      await createJob(repository, jobId);
      await append(repository, jobId, "initial-start", started);
      await append(repository, jobId, "initial-returned", returned);
      await append(repository, jobId, "initial-tail", finished);
      expect((await read()).detail.source_results).toEqual(
        full(jobId, [started, returned, finished]),
      );

      const otherConnection = syntheticCatalog(path);
      try {
        const tail = otherConnection.prepare(
          "SELECT rowid AS position FROM execution_events WHERE event_id='initial-tail'",
        );
        const position = tail.get()!.position;
        otherConnection.exec("BEGIN");
        otherConnection
          .prepare("DELETE FROM execution_jobs WHERE job_id=?")
          .run(jobId);
        expect(tail.get()).toBeUndefined();
        otherConnection
          .prepare(
            `
        INSERT INTO execution_jobs(job_id,target_kind,selector_json,policy_version,status,idempotency_key,created_at)
        VALUES(?,'selector','{}','task-detail-fixture','queued',?,?)
      `,
          )
          .run(jobId, jobId, createdAt);
        const insert = otherConnection.prepare(
          "INSERT INTO execution_events VALUES(?,?,?,?,?,?)",
        );
        const replacementEvents = [
          ["replacement-start", started],
          ["replacement-returned", replacement],
          [tailId, finished],
        ] as const;
        for (const [sequence, [eventId, event]] of replacementEvents.entries())
          insert.run(
            eventId,
            jobId,
            sequence,
            event.kind,
            JSON.stringify(event.payload),
            at,
          );
        otherConnection.exec("COMMIT");
        expect(
          otherConnection
            .prepare(
              "SELECT rowid AS position FROM execution_events WHERE event_id=?",
            )
            .get(tailId)?.position,
        ).toBe(position);

        const replay = await read();
        expect(replay.rows_read).toBe(3);
        expect(replay.detail.source_results).toEqual(
          full(jobId, [started, replacement, finished]),
        );
      } finally {
        otherConnection.close();
      }
    } finally {
      await worker.close();
      await rm(home, { force: true, recursive: true });
    }
  },
);

it("rebuilds after a schema cookie change or catalog replacement", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-task-detail-catalog-"),
  );
  const path = join(home, "catalog.sqlite");
  const replacementPath = join(home, "replacement.sqlite");
  const jobId = "target";
  const started = progress("source", { phase: "started" });
  const original = progress("source", { phase: "returned", count: 4 });
  const replacement = progress("source", { phase: "returned", count: 9 });
  const reader = new SqliteWorker(path, undefined, { readOnly: true });
  try {
    for (const [catalogPath, event] of [
      [path, original],
      [replacementPath, replacement],
    ] as const) {
      const writer = new SqliteWorker(catalogPath);
      try {
        const repository = new ExecutionRepository(writer);
        await createJob(repository, jobId);
        await append(repository, jobId, "same-start", started);
        await append(repository, jobId, "same-tail", event);
      } finally {
        await writer.close();
      }
      // The fixture uses rollback journaling so a file replacement leaves no WAL sidecars.
      const db = syntheticCatalog(catalogPath);
      try {
        db.exec("PRAGMA journal_mode=DELETE");
      } finally {
        db.close();
      }
    }
    const repository = new ExecutionRepository(reader);
    const read = async () =>
      successful(await repository.taskDetailEvents(jobId, true));
    const before = await read();
    expect(before.rows_read).toBe(2);
    expect(before.detail.source_results).toEqual(
      full(jobId, [started, original]),
    );
    expect((await read()).rows_read).toBe(0);

    const db = syntheticCatalog(path);
    let nextSchemaVersion: number;
    try {
      nextSchemaVersion =
        Number(db.prepare("PRAGMA schema_version").get()!.schema_version) + 1;
      db.exec(`PRAGMA schema_version=${nextSchemaVersion}`);
    } finally {
      db.close();
    }
    const changed = await read();
    expect(changed.rows_read).toBe(2);
    expect(changed.detail).toEqual(before.detail);
    expect((await read()).rows_read).toBe(0);

    const standby = syntheticCatalog(replacementPath);
    try {
      // Keep the same cookie and tail identity to exercise the file check alone.
      standby.exec(`PRAGMA schema_version=${nextSchemaVersion}`);
    } finally {
      standby.close();
    }
    await rename(replacementPath, path);
    const replaced = await read();
    expect(replaced.rows_read).toBe(2);
    expect(replaced.detail.source_results).toEqual(
      full(jobId, [started, replacement]),
    );
    expect((await read()).rows_read).toBe(0);
  } finally {
    await reader.close();
    await rm(home, { force: true, recursive: true });
  }
});

it("does not skip an event that later enters the timestamp window or change legacy rowid order", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-task-detail-cutoff-"),
  );
  const path = join(home, "catalog.sqlite");
  const worker = new SqliteWorker(path);
  const repository = new ExecutionRepository(worker);
  const cache = new TaskDetailCache();
  try {
    await createJob(repository, "timestamps");
    const db = syntheticCatalog(path);
    try {
      const insert = db.prepare(
        "INSERT INTO execution_events VALUES(?,?,?,?,?,?)",
      );
      const started = progress("window", { phase: "started" });
      const finished = progress("window", finish("miss"));
      insert.run(
        "first",
        "timestamps",
        1,
        started.kind,
        JSON.stringify(started.payload),
        at,
      );
      insert.run(
        "second",
        "timestamps",
        0,
        finished.kind,
        JSON.stringify(finished.payload),
        afterAt,
      );
      const before = successful(readSnapshot(cache, db, "timestamps", at));
      expect(before.detail.source_results).toEqual(
        full("timestamps", [started]),
      );
      const after = successful(readSnapshot(cache, db, "timestamps", afterAt));
      expect(after.detail.source_results).toEqual(
        full("timestamps", [started, finished]),
      );
    } finally {
      db.close();
    }
  } finally {
    cache.clear();
    await worker.close();
    await rm(home, { force: true, recursive: true });
  }
});

it("uses one snapshot even when a separate connection commits during the scan", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-task-detail-snapshot-"),
  );
  const path = join(home, "catalog.sqlite");
  const worker = new SqliteWorker(path);
  const repository = new ExecutionRepository(worker);
  const cache = new TaskDetailCache();
  try {
    const jobId = "snapshot";
    await createJob(repository, jobId);
    const first = progress("a", { phase: "started" });
    const returned = progress("a", { phase: "returned", count: 4 });
    const next = progress("a", { phase: "returned", count: 5 });
    const finished = progress("a", finish("hit"));
    await append(repository, jobId, "a-started", first);
    await append(repository, jobId, "a-returned", returned);
    const reader = syntheticCatalog(path);
    const writer = syntheticCatalog(path);
    try {
      let wrote = false;
      reader.exec("BEGIN");
      try {
        const snapshot = successful(
          cache.read(
            reader,
            snapshotCatalogIdentity,
            jobId,
            afterAt,
            true,
            () => {
              if (wrote) return;
              wrote = true;
              writer.exec("BEGIN IMMEDIATE");
              const insert = writer.prepare(
                "INSERT INTO execution_events VALUES(?,?,?,?,?,?)",
              );
              insert.run(
                "a-next",
                jobId,
                2,
                next.kind,
                JSON.stringify(next.payload),
                at,
              );
              insert.run(
                "a-finished",
                jobId,
                3,
                finished.kind,
                JSON.stringify(finished.payload),
                at,
              );
              writer.exec("COMMIT");
            },
          ),
        );
        expect(wrote).toBe(true);
        expect(snapshot.detail.source_results).toEqual(
          full(jobId, [first, returned]),
        );
      } finally {
        reader.exec("COMMIT");
      }
      const refreshed = successful(readSnapshot(cache, reader, jobId));
      expect(refreshed.rows_read).toBe(2);
      expect(refreshed.detail.source_results).toEqual(
        full(jobId, [first, returned, next, finished]),
      );
    } finally {
      reader.close();
      writer.close();
    }
  } finally {
    cache.clear();
    await worker.close();
    await rm(home, { force: true, recursive: true });
  }
});

it("keeps the original diagnostic order and limits after spilled open records finish", async () => {
  const database = new SqliteWorker();
  const repository = new ExecutionRepository(database);
  const jobId = "diagnostics";
  const reader = createTaskReader(repository);
  try {
    await createJob(repository, jobId);
    const started = Array.from({ length: 75 }, (_, n) =>
      progress("call-" + n, { phase: "started" }),
    );
    for (const [i, event] of started.entries())
      await append(repository, jobId, "start-" + i, event);
    expect((await reader.read(jobId)).source_results).toEqual(
      full(jobId, started),
    );
    const finished = started
      .map((_, n) =>
        progress(
          "call-" + n,
          n === 72
            ? finish("cooldown")
            : n === 71
              ? finish("not-enabled")
              : finish("error", diagnostic("error-" + (n % 50))),
        ),
      )
      .reverse();
    for (const [i, event] of finished.entries())
      await append(repository, jobId, "finish-" + i, event);
    const detail = await reader.read(jobId);
    expect(detail.source_results).toEqual(
      full(jobId, [...started, ...finished]),
    );
    expect(
      detail.source_results.metadata?.sources[0]?.problems[0]?.technical_details
        .diagnostics,
    ).toHaveLength(32);
  } finally {
    await database.close();
  }
});
