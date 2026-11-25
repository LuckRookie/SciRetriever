import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { parseLibrarySearchRequest } from "@sciretriever/contracts";
import { createLogger } from "../src/logging/index.js";
import { ExecutionRepository } from "../src/storage/execution/repository.js";
import { CatalogWriteAdmission } from "../src/storage/write-admission.js";
import { initializeCurrentCatalog } from "../src/storage/sqlite/catalog-layout.js";
import {
  replayTaskDetail,
  TaskDetailCache,
  type TaskDetailRead,
} from "../src/storage/sqlite/task-detail-engine.js";
import { SqliteReadLane, SqliteWorker } from "../src/storage/sqlite/worker.js";

const at = "2026-11-22T00:00:00.000Z";
const jobId = "read-lane-job";
const query = parseLibrarySearchRequest({ query: {} }).query;
const source = {
  schema_version: 1,
  record_id: "tracked-record",
  source: "crossref",
  purpose: "reference-query",
  role: "primary",
  unit_id: "tracked-unit",
  at,
};

function successful(result: TaskDetailRead) {
  if (result.status !== "ok")
    throw new Error(`Unexpected detail ${result.status}`);
  return result;
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-read-lanes-"));
  const path = join(home, "catalog.sqlite");
  const lane = new SqliteReadLane();
  const admission = new CatalogWriteAdmission(path);
  const lines: string[] = [];
  const worker = new SqliteWorker(path, admission, {
    readLane: lane,
    readLogger: createLogger("sqlite-read", (line) => lines.push(line)),
  });
  return {
    home,
    path,
    lane,
    admission,
    worker,
    lines,
    async close() {
      await worker.close();
      await lane.close();
      await admission.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function seedEvents(worker: SqliteWorker, path: string, events: number) {
  await new ExecutionRepository(worker).createJob({
    job_id: jobId,
    target_kind: "selector",
    selector: {},
    policy_version: "read-lanes-fixture",
    policy: {},
    idempotency_key: jobId,
    created_at: at,
  });
  const db = new DatabaseSync(path);
  try {
    db.prepare(
      `
      WITH RECURSIVE numbers(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM numbers WHERE n+1<?)
      INSERT INTO execution_events(event_id,job_id,sequence,kind,payload_json,created_at)
      SELECT 'event-'||n,?,n,'test-event','{}',? FROM numbers
    `,
    ).run(events, jobId, at);
  } finally {
    db.close();
  }
}

function trackWorkers() {
  const seen = new Map<string, Worker>();
  const realPost = Worker.prototype.postMessage;
  const spy = vi
    .spyOn(Worker.prototype, "postMessage")
    .mockImplementation(function (
      this: Worker,
      message: { readonly command: { readonly kind: string } },
      ...args: Parameters<Worker["postMessage"]> extends [unknown, ...infer R]
        ? R
        : never
    ) {
      seen.set(message.command.kind, this);
      Reflect.apply(realPost, this, [message, ...args]);
    });
  return { seen, spy };
}

it("serves short reads during a cold replay and installs its incremental cache", async () => {
  const f = await fixture();
  const { seen, spy } = trackWorkers();
  try {
    await seedEvents(f.worker, f.path, 75_000);
    await f.worker.appendExecutionEvent({
      job_id: jobId,
      event_id: "open-metadata",
      sequence: -1,
      kind: "metadata-source",
      payload: {
        target_id: "target",
        progress: { ...source, phase: "started" },
      },
      created_at: at,
    });
    let done = false;
    const cold = f.worker.taskDetailEvents(jobId, at, true).finally(() => {
      done = true;
    });
    await vi.waitFor(() =>
      expect(seen.has("execution_task_detail_replay")).toBe(true),
    );
    expect((await f.worker.getExecutionJob(jobId))?.job_id).toBe(jobId);
    expect(seen.get("execution_get_job")).not.toBe(
      seen.get("execution_task_detail_replay"),
    );
    expect(done).toBe(false);
    const first = successful(await cold);
    expect(first.rows_read).toBe(75_001);
    expect(first.detail.technical.at(-1)?.event_id).toBe("open-metadata");
    expect(first.detail.source_results.metadata?.records[0]?.result).toBe(
      "running",
    );
    await f.worker.appendExecutionEvent({
      job_id: jobId,
      event_id: "new-event",
      sequence: -1,
      kind: "metadata-source",
      payload: {
        target_id: "target",
        progress: {
          ...source,
          phase: "finished",
          result: "miss",
          problem: null,
        },
      },
      created_at: at,
    });
    const warm = successful(await f.worker.taskDetailEvents(jobId, at, true));
    expect(warm.rows_read).toBe(1);
    expect(warm.detail.technical.at(-1)?.event_id).toBe("new-event");
    expect(warm.detail.source_results.metadata?.records).toHaveLength(1);
    expect(warm.detail.source_results.metadata?.records[0]?.result).toBe(
      "miss",
    );
    const baseline = new SqliteWorker(f.path);
    try {
      expect(warm.detail).toEqual(
        successful(await baseline.taskDetailEvents(jobId, at, true)).detail,
      );
    } finally {
      await baseline.close();
    }
    expect(f.lines).toEqual([]);
  } finally {
    spy.mockRestore();
    await f.close();
  }
});

it("reports one budget violation with its SQLite request and elapsed time", async () => {
  const f = await fixture();
  try {
    await f.worker.run({ kind: "schema" });
    let clock = 10;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const read = f.worker.getExecutionJob(jobId);
      clock += 5_001;
      await expect(read).resolves.toBeNull();
    } finally {
      now.mockRestore();
    }
    expect(f.lines).toEqual([
      expect.stringContaining(
        "code=sqlite-short-read-slow operation=execution_get_job elapsed_ms=5001",
      ),
    ]);
  } finally {
    await f.close();
  }
});

it("routes the archive issue count to the short worker and its library list to the long worker", async () => {
  const f = await fixture();
  const { seen, spy } = trackWorkers();
  try {
    await f.worker.archive("issues", { limit: 1 });
    const listWorker = seen.get("archive");
    await f.worker.getExecutionJob(jobId);
    await expect(f.worker.archive("issue-count", {})).resolves.toEqual({
      total_count: 0,
    });
    expect(listWorker).toBeDefined();
    expect(seen.get("archive")).not.toBe(listWorker);
    expect(seen.get("archive")).toBe(seen.get("execution_get_job"));
  } finally {
    spy.mockRestore();
    await f.close();
  }
});

it("initializes on the writable worker before the first long read", async () => {
  const f = await fixture();
  const { seen, spy } = trackWorkers();
  try {
    const { tables } = await f.worker.snapshotCounts();
    expect(tables.literatures).toBe(0);
    const writer = seen.get("schema");
    expect(writer).toBeDefined();
    expect(seen.get("snapshot_counts")).not.toBe(writer);
    // An admitted operation must never wait for the independent read queue.
    await f.admission.run(async () => {
      expect((await f.worker.snapshotCounts()).tables).toEqual(tables);
      expect(seen.get("snapshot_counts")).toBe(writer);
    });
  } finally {
    spy.mockRestore();
    await f.close();
  }
});

it("releases the catalog between replay pages and keeps the captured prefix under an external append", async () => {
  const f = await fixture();
  const installed = new TaskDetailCache();
  try {
    await seedEvents(f.worker, f.path, 2100);
    const reader = new DatabaseSync(f.path, { readOnly: true });
    const writer = new DatabaseSync(f.path);
    try {
      let examined = 0;
      let checkpointed = false;
      const scratch = await mkdtemp(join(f.home, "history-"));
      const result = replayTaskDetail(
        reader,
        () => "fixture",
        jobId,
        at,
        true,
        join(scratch, "history.sqlite"),
        () => {
          expect(reader.isTransaction).toBe(false);
          if (++examined !== 1100) return;
          writer
            .prepare(
              "INSERT INTO execution_events VALUES('external-event',?,2100,'test-event','{}',?)",
            )
            .run(jobId, at);
          const wal = writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()!;
          expect(wal.busy).toBe(0);
          checkpointed = true;
        },
      );
      const replayed = successful(result.result);
      expect(checkpointed).toBe(true);
      expect(replayed.rows_read).toBe(2100);
      expect(replayed.detail.technical.at(-1)?.sequence).toBe(2099);
      expect(result.transfer).toBeDefined();
      expect(installed.install(reader, "fixture", result.transfer!)).toBe(true);
      reader.exec("BEGIN");
      try {
        const next = successful(
          installed.read(reader, "fixture", jobId, at, true, () => {}),
        );
        expect(next.rows_read).toBe(1);
        expect(next.detail.technical.at(-1)?.event_id).toBe("external-event");
      } finally {
        reader.exec("COMMIT");
      }
    } finally {
      reader.close();
      writer.close();
    }
  } finally {
    installed.clear();
    await f.close();
  }
});

it("closes short and long workers while reads are pending", async () => {
  const f = await fixture();
  const { seen, spy } = trackWorkers();
  try {
    await seedEvents(f.worker, f.path, 150_000);
    const cold = f.worker
      .taskDetailEvents(jobId, at, true)
      .catch((e: unknown) => e);
    await vi.waitFor(() =>
      expect(seen.has("execution_task_detail_replay")).toBe(true),
    );
    const fast = f.worker.getExecutionJob(jobId).catch((e: unknown) => e);
    const closed = f.worker.close();
    for (const read of [fast, cold])
      await expect(read).resolves.toBeInstanceOf(Error);
    await closed;
    await f.lane.close();
    expect(seen.get("close")).toBe(seen.get("execution_task_detail_replay"));
    await expect(f.worker.getExecutionJob(jobId)).rejects.toBeInstanceOf(Error);
  } finally {
    spy.mockRestore();
    await f.close();
  }
});

it("counts sibling versions as one paper across both read lanes", async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.path);
  const whole = new SqliteWorker(f.path, undefined, { readOnly: true });
  try {
    initializeCurrentCatalog(db);
    db.exec("BEGIN");
    const work = db.prepare("INSERT INTO meta_literatures VALUES(?,?)");
    const version = db.prepare(
      "INSERT INTO literatures VALUES(?,?,'published')",
    );
    const metadata = db.prepare(
      "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title) VALUES(?,1,?,'Synthetic')",
    );
    function add(id: string, workId: string) {
      version.run(id, workId);
      metadata.run(id, "a".repeat(64));
    }
    for (let n = 0; n < 1050; n++) {
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      work.run(id, id);
      add(id, id);
    }
    add(
      "10000000-0000-4000-8000-000000000000",
      "00000000-0000-4000-8000-000000000000",
    );
    db.exec("COMMIT");
    const baseline = await whole.libraryCounts(query, null);
    expect(await f.worker.libraryCounts(query, null)).toEqual(baseline);
    expect(baseline.total).toBe(1051);
    expect(baseline.full_text.total).toBe(1050);
  } finally {
    db.close();
    await whole.close();
    await f.close();
  }
});
