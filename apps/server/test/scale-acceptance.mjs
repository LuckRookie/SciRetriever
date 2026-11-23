// Opt-in performance acceptance. Run the built server on the prepared 14.1
// copy. The runbook records the metrics, timing boundaries, and environment.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once, on } from "node:events";
import { readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { loadavg, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";
import {
  canonicalJsonBytes,
  EMPTY_METADATA,
  parseMetadataObservation,
} from "@sciretriever/contracts";
import { createApplication } from "../dist/bootstrap/application.js";
import { startProductionWorkbench } from "../dist/bootstrap/workbench.js";
import { parseCredentialText } from "../dist/configuration/credentials.js";
import { activityContext, withActivity } from "../dist/logging/activity.js";
import { acquireExecutionRuntime } from "../dist/storage/execution/runtime-owner.js";
import { SHORT_READ_LIMIT_MS } from "../dist/storage/sqlite/read-lanes.js";
import { SqliteWorker } from "../dist/storage/sqlite/worker.js";
import { CatalogWriteAdmission } from "../dist/storage/write-admission.js";

const [mode, directory, destination, reference] = process.argv.slice(2);
const root = resolve(directory);
assert.equal(dirname(root), resolve("sandbox/runs"));
assert.match(basename(root), /^scale-acceptance-(10k|1m)-\w+$/u);
assert.equal(await realpath(root), root);
const { scale, fixture, folder, corpus } = JSON.parse(
  await readFile(join(root, "prepared.json"), "utf8"),
);
const catalog = join(root, "catalog.sqlite");
assert.equal(fixture.catalog, catalog);
assert.equal(fixture.home, join(root, "home"));
assert.equal(fixture.artifacts, join(root, "artifacts"));
assert.equal(await realpath(catalog), catalog);
assert.equal(corpus.papers, scale === "10k" ? 10_000 : 1_000_000);
assert.equal(corpus.obtained, corpus.papers / 10);
const password = "synthetic-scale-acceptance-only";
const stop = new AbortController();
process.once("SIGTERM", () =>
  stop.abort(new Error("Scale acceptance interrupted")),
);
const options = {
  metadata: {},
  browserHost: () => null,
  startupCredentials: parseCredentialText(""),
};

const objectives = {
  home: 1000,
  counts: 200,
  workset: 1000,
  search: 1500,
  task: 500,
};
// A fixed query and response size are used at both scales. Three times the
// small-catalog P95 leaves room for index depth and filesystem variation.
const ratioLimit = 3;
const trials = 20;
const batchSize = 25;
// Offer approximately 104 papers/s to leave room for pacing variation. Check
// the actual rate of committed new papers during the read window.
const batchPeriod = 240;

function preparedObservation(sequence, stamp, run) {
  const record = `${run}-${sequence}`;
  const metadata = {
    ...EMPTY_METADATA,
    title: `Scale acceptance instrumental calibration ${record}`,
    abstract:
      "Offline observations compare the reproducibility of instrument calibration. "
        .repeat(6)
        .trim(),
    publication_year: 2026,
    publication_form: "journal-article",
    language: "en",
    venue: "Synthetic Instrumentation Reports",
    identifiers: [{ namespace: "doi", value: `10.7788/${record}` }],
  };
  return parseMetadataObservation({
    observation_id: randomUUID(),
    provenance: {
      provenance_id: randomUUID(),
      source_kind: "metadata-provider",
      source_name: "synthetic-scale",
      source_record_id: record,
      observed_at: stamp,
      input_sha256: createHash("sha256")
        .update(canonicalJsonBytes(metadata))
        .digest("hex"),
      parameters_sha256: null,
    },
    metadata,
    version_role: "published",
    source_type: null,
    source_type_mapping_version: null,
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });
}

function watchParent() {
  process.on("message", (value) => {
    if (value === "stop") stop.abort();
  });
  process.once("disconnect", () => stop.abort());
}

function traceBackfill() {
  const run = CatalogWriteAdmission.prototype.runBackfill;
  CatalogWriteAdmission.prototype.runBackfill = function (batch, signal) {
    return run.call(
      this,
      async () => {
        const started = Date.now();
        const admitted = performance.now();
        const more = await batch();
        if (process.connected)
          process.send({
            backfill: { started, held_ms: performance.now() - admitted, more },
          });
        return more;
      },
      signal,
    );
  };
}

async function serve() {
  watchParent();
  if (destination === "count-backfill") traceBackfill();
  const traceWrites = destination === "trace-writes";
  if (destination === "trace-wal") {
    const idle = SqliteWorker.prototype.idleWalCheckpoint;
    SqliteWorker.prototype.idleWalCheckpoint = async function () {
      const file = await stat(catalog + "-wal").catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      const idle_ms = file ? Date.now() - file.mtimeMs : null;
      const truncated = await idle.call(this);
      if (process.connected)
        process.send({
          wal_check: { idle_ms, truncated, size: file?.size ?? 0 },
        });
      return truncated;
    };
  }
  if (traceWrites) {
    const run = CatalogWriteAdmission.prototype.run;
    CatalogWriteAdmission.prototype.run = async function (operation, signal) {
      if (
        this.catalogPath !== catalog ||
        this.ownsWriteAdmission ||
        !activityContext().actor.startsWith("web-session:")
      )
        return run.call(this, operation, signal);
      const queued = performance.now();
      let wait_ms;
      try {
        return await run.call(
          this,
          () => {
            wait_ms = performance.now() - queued;
            return operation();
          },
          signal,
        );
      } finally {
        if (process.connected)
          process.send({
            http_write: {
              admitted: wait_ms !== undefined,
              wait_ms: wait_ms ?? performance.now() - queued,
            },
          });
      }
    };
  }
  const server = await startProductionWorkbench({
    home: fixture.home,
    port: 0,
    access: { host: "127.0.0.1", password },
    applicationOptions: ["count-backfill", "index-disabled"].includes(
      destination,
    )
      ? { ...options, indexRefreshIntervalMs: null }
      : options,
  });
  try {
    process.send({ origin: server.origin });
    if (!stop.signal.aborted) await once(stop.signal, "abort");
  } finally {
    await server.close();
    if (process.connected) process.disconnect();
  }
}

async function write() {
  watchParent();
  if (destination === "saturate-count-backfill") traceBackfill();
  const app = await createApplication(fixture.home, {
    ...options,
    indexRefreshIntervalMs: null,
  });
  const reader = new DatabaseSync(catalog, { readOnly: true });
  reader.exec("PRAGMA busy_timeout=1000");
  const revision = reader.prepare(
    "SELECT revision FROM retrieval_source_revision WHERE singleton=1",
  );
  const start = performance.now();
  const run = randomUUID();
  const period = destination?.startsWith("saturate") ? 0 : batchPeriod;
  let papers = 0;
  let total = 0;
  try {
    await withActivity({ actor: "cli:synthetic-scale" }, async () => {
      for (let batch = 0; !stop.signal.aborted; batch++) {
        const stamp = new Date().toISOString();
        const records = Array.from({ length: batchSize }, () =>
          preparedObservation(++total, stamp, run),
        );
        let offset = 0;
        while (!stop.signal.aborted && offset < records.length) {
          const queued = performance.now();
          let admitted;
          try {
            await app.database.writeMetadataSegment(async (expired) => {
              admitted = performance.now();
              do {
                const result = await app.identity.observe(records[offset++]);
                assert.equal(result.disposition, "accepted");
                assert.equal(result.outcome, "created");
              } while (offset < records.length && !expired());
            });
          } catch (error) {
            if (process.connected)
              process.send({
                write_error: {
                  code: error.code ?? error.name,
                  waited_ms: (admitted ?? performance.now()) - queued,
                },
              });
            throw error;
          }
          const committed = Date.now();
          papers = total - (records.length - offset);
          if (process.connected)
            process.send({
              papers,
              committed,
              revision: revision.get().revision,
              wait_ms: admitted - queued,
              held_ms: performance.now() - admitted,
            });
        }
        await wait(
          Math.max(0, start + (batch + 1) * period - performance.now()),
        );
      }
    });
  } finally {
    reader.close();
    await app.close();
    if (process.connected) process.disconnect();
  }
}

function spawn(role, warnings, flag) {
  const child = fork(
    import.meta.filename,
    [role, root, ...(flag ? [flag] : [])],
    {
      execArgv: [],
      env: {
        PATH: "/usr/bin:/bin",
        COREPACK_ENABLE_NETWORK: "0",
        npm_config_offline: "true",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  child.stderr.setEncoding("utf8");
  let line = "";
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    line += chunk;
    for (;;) {
      const newline = line.indexOf("\n");
      if (newline < 0) break;
      const event = line.slice(0, newline);
      line = line.slice(newline + 1);
      if (event.includes("sqlite-short-read-slow")) warnings.push(event);
    }
  });
  const exit = once(child, "exit");
  const first = async (accept = () => true) => {
    const ended = new AbortController();
    void exit.then(() => ended.abort());
    for await (const [message] of on(child, "message", {
      signal: AbortSignal.any([
        stop.signal,
        ended.signal,
        AbortSignal.timeout(45_000),
      ]),
    }))
      if (accept(message)) return message;
  };
  return {
    child,
    first,
    async close() {
      if (child.connected) child.send("stop");
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      try {
        const [code, signal] = await exit;
        assert.equal(code, 0, `${role} exit: ${code ?? signal}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function client(origin) {
  const endpoint = new URL(origin);
  assert.equal(endpoint.protocol, "http:");
  assert.equal(endpoint.hostname, "127.0.0.1");
  assert.notEqual(endpoint.port, "4174");
  const common = {
    Origin: origin,
    "Content-Type": "application/json",
    "X-Workbench-Init": "1",
  };
  const local = (path, init) => {
    const url = new URL(path, origin);
    assert.equal(url.origin, origin);
    return fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(45_000)]),
    });
  };
  const cookies = (r) =>
    r.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
  const login = await local("/auth/login", {
    method: "POST",
    headers: common,
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  await login.arrayBuffer();
  const landing = await local("/", { headers: { Cookie: cookies(login) } });
  assert.equal(landing.status, 200);
  const Cookie = [cookies(login), cookies(landing)].join("; ");
  await landing.arrayBuffer();
  const attach = await local("/api/clients", {
    method: "POST",
    headers: { ...common, Cookie },
    body: "{}",
  });
  assert.equal(attach.status, 201);
  const grant = await attach.json();
  return async (path, input, range) => {
    const url = new URL(path, origin);
    if (!range) url.searchParams.set("client_id", grant.client_id);
    const response = await local(url, {
      method: input ? "POST" : "GET",
      headers: {
        ...common,
        Cookie,
        "X-Workbench-Csrf": grant.csrf,
        "X-Sciretriever-Protocol-Version": "1",
        ...(range
          ? { Range: range, "X-Sciretriever-Client-Id": grant.client_id }
          : {}),
      },
      ...(input
        ? { body: JSON.stringify({ protocol_version: 1, request: input }) }
        : {}),
    });
    if (response.status !== (range ? 206 : 200)) {
      const body = await response.json().catch(() => null);
      const code = body?.error?.code ?? body?.code;
      throw Object.assign(
        new Error(`${url.pathname}: HTTP ${response.status}`),
        {
          status: response.status,
          code:
            typeof code === "string" && /^[a-z][a-z0-9-]+$/u.test(code)
              ? code
              : null,
        },
      );
    }
    return range
      ? (await response.arrayBuffer()).byteLength
      : await response.json();
  };
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p) =>
    sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return {
    n: sorted.length,
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    max_ms: sorted.at(-1) ?? null,
  };
}

async function measure(work) {
  const started = performance.now();
  await work();
  return performance.now() - started;
}

function taskBands() {
  assert.equal(scale, "1m");
  assert.equal(fixture.source_records, 1_000_000);
  const source = fixture.jobs.running;
  const db = new DatabaseSync(catalog);
  const tasks = [10_000, 100_000].map((records) => ({
    records,
    jobId: `${source}-${records}`,
  }));
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    for (const { records, jobId } of tasks) {
      // Use prefixes of the original fixture, including both events for each source record.
      db.prepare("DELETE FROM execution_jobs WHERE job_id=?").run(jobId);
      db.prepare(
        `
        INSERT INTO execution_jobs(job_id,target_kind,selector_json,policy_version,status,idempotency_key,created_at,finished_at)
        SELECT ?,target_kind,selector_json,policy_version,status,?,created_at,finished_at
        FROM execution_jobs WHERE job_id=?
      `,
      ).run(jobId, jobId, source);
      db.prepare(
        `
        INSERT INTO execution_targets(target_id,job_id,ordinal,literature_id,version_role,stage,disposition,next_eligible_at)
        SELECT ?,?,ordinal,literature_id,version_role,stage,disposition,next_eligible_at
        FROM execution_targets WHERE job_id=? AND ordinal=0
      `,
      ).run(`${jobId}:0`, jobId, source);
      db.prepare(
        `
        INSERT INTO execution_budgets(job_id,max_attempts,max_network_bytes,max_model_calls,used_attempts,used_network_bytes,used_model_calls,updated_at)
        SELECT ?,max_attempts,max_network_bytes,max_model_calls,used_attempts,used_network_bytes,used_model_calls,updated_at
        FROM execution_budgets WHERE job_id=?
      `,
      ).run(jobId, source);
      const { changes } = db
        .prepare(
          `
        INSERT INTO execution_events(event_id,job_id,sequence,kind,payload_json,created_at)
        SELECT ? || ':' || sequence,?,sequence,kind,
          CASE WHEN kind='metadata-source' THEN json_set(payload_json,'$.target_id',?) ELSE payload_json END,created_at
        FROM execution_events WHERE job_id=? AND sequence<=? ORDER BY sequence
      `,
        )
        .run(jobId, jobId, `${jobId}:0`, source, 2 * records);
      assert.equal(changes, 2 * records + 1);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return [...tasks, { records: fixture.source_records, jobId: source }];
}

async function inspectTask() {
  watchParent();
  const { runCli } = await import("../dist/cli/main.js");
  const job = JSON.stringify({ job_id: destination });
  const { code, value } = await runCli(
    ["jobs", "inspect", "--request", "-", "--json"],
    {
      home: fixture.home,
      signal: stop.signal,
      stdin: (async function* () {
        yield Buffer.from(job);
      })(),
    },
  );
  assert.equal(code, 0, "CLI task inspection failed");
  process.send({ fingerprint: taskFingerprint(value.result) });
  if (!stop.signal.aborted) await once(stop.signal, "abort");
  if (process.connected) process.disconnect();
}

function taskFingerprint(task) {
  assert.equal(task.job.status, "running");
  return createHash("sha256")
    .update(canonicalJsonBytes(JSON.parse(JSON.stringify(task))))
    .digest("hex");
}

async function taskSidecar() {
  const output = resolve(destination);
  assert.ok(output.startsWith(resolve("sandbox/reports") + "/"));
  const tasks = taskBands();
  const directory = join(fixture.home, ".sciretriever", "cache", "task-detail");
  const result = {
    scale,
    corpus,
    node: process.version,
    load_start: loadavg(),
    objective_ms: objectives.task,
    points: [],
    warnings: [],
    tasks: {},
    failures: [],
  };
  const runtime = await acquireExecutionRuntime(catalog);
  const withServer = async (work) => {
    const server = spawn("serve", result.warnings);
    try {
      const { origin } = await server.first();
      const request = await client(origin);
      return await work(async (jobId) => {
        const { task } = await request(`/api/tasks/${jobId}`);
        assert.equal(task.job.status, "running");
        return task;
      });
    } finally {
      await server.close();
    }
  };
  const fileFor = (jobId) =>
    join(
      directory,
      createHash("sha256")
        .update(JSON.stringify([catalog, jobId]))
        .digest("hex") + ".checkpoint",
    );
  const writer = spawn("writer", result.warnings);
  writer.child.on("message", (point) => result.points.push(point));
  try {
    await writer.first();
    await wait(2500);
    const began = Date.now();
    for (const { records, jobId } of tasks) {
      const path = fileFor(jobId);
      const entry = (result.tasks[records] = { samples: [] });
      await rm(path, { force: true });
      let expected;
      entry.rebuild_ms = await withServer((read) =>
        measure(async () => {
          expected = await read(jobId);
        }),
      );
      const published = await stat(path, { bigint: true });
      entry.bytes = Number(published.size);
      for (let trial = 0; trial < trials; trial++) {
        entry.samples.push(
          await withServer(async (read) => {
            let task;
            const elapsed = await measure(async () => {
              task = await read(jobId);
            });
            assert.deepEqual(task, expected);
            return elapsed;
          }),
        );
      }
      assert.equal((await stat(path, { bigint: true })).ino, published.ino);
      Object.assign(entry, stats(entry.samples));
      if (entry.p95_ms > objectives.task)
        result.failures.push(
          `${records} records P95 ${entry.p95_ms.toFixed(1)} ms exceeds ${objectives.task} ms`,
        );
      console.log(scale, records, JSON.stringify(stats(entry.samples)));
    }
    const finished = Date.now();
    const points = result.points.filter(
      (point) => point.committed >= began && point.committed <= finished,
    );
    const first = points[0];
    const last = points.at(-1);
    result.papers_per_second =
      last?.committed > first?.committed
        ? (1000 * (last.papers - first.papers)) /
          (last.committed - first.committed)
        : 0;
    if (result.papers_per_second < 100)
      result.failures.push("Write load below 100 committed papers/s");

    const { jobId } = tasks[1];
    const cliFingerprint = async (concurrentRead) => {
      const cli = spawn("inspect-task", result.warnings, jobId);
      try {
        const [{ fingerprint }, task] = await Promise.all([
          cli.first(),
          concurrentRead?.(),
        ]);
        if (task) assert.equal(fingerprint, taskFingerprint(task));
        return fingerprint;
      } finally {
        await cli.close();
      }
    };
    await rm(fileFor(jobId), { force: true });
    const cliPublished = await cliFingerprint();
    await stat(fileFor(jobId));
    await rm(fileFor(jobId), { force: true });
    const concurrent = await withServer((read) =>
      cliFingerprint(() => read(jobId)),
    );
    assert.equal(concurrent, cliPublished);
    const shared = await stat(fileFor(jobId), { bigint: true });
    await withServer(async (read) =>
      assert.equal(taskFingerprint(await read(jobId)), concurrent),
    );
    assert.equal(await cliFingerprint(), concurrent);
    assert.equal(
      (await stat(fileFor(jobId), { bigint: true })).ino,
      shared.ino,
    );
    result.concurrent_cli_http_agree = true;
    await measureCheckpointWrites(directory, tasks, fileFor, result.tasks);
  } catch (error) {
    result.failures.push(error.stack ?? String(error));
  } finally {
    try {
      await writer.close();
    } finally {
      await runtime.release();
      result.load_finish = loadavg();
      if (result.warnings.length)
        result.failures.push("Short SQLite read budget log emitted");
      await writeFile(output, JSON.stringify(result, null, 2) + "\n", {
        mode: 0o600,
      });
    }
  }
  assert.deepEqual(result.failures, []);
}

async function measureCheckpointWrites(directory, tasks, fileFor, entries) {
  const { TaskDetailSidecars, removeTaskScratch } = await import(
    "../dist/storage/sqlite/task-detail-sidecar.js"
  );
  const { taskDetailCatalogIdentity } = await import(
    "../dist/storage/sqlite/task-detail-engine.js"
  );
  const { EXECUTION_SCHEMA_VERSION, EXECUTION_RUNTIME_SCHEMA_VERSION } =
    await import("../dist/storage/sqlite/execution-schema.js");
  const { dev, ino } = await stat(catalog);
  const db = new DatabaseSync(catalog, { readOnly: true });
  try {
    const identity = taskDetailCatalogIdentity(
      db,
      `${dev}:${ino}`,
      EXECUTION_SCHEMA_VERSION,
      EXECUTION_RUNTIME_SCHEMA_VERSION,
    );
    const { schema_version: schemaVersion } = db
      .prepare("PRAGMA schema_version")
      .get();
    const sidecars = new TaskDetailSidecars(directory, catalog);
    for (const { records, jobId } of tasks) {
      const loaded = sidecars.load(
        jobId,
        identity,
        schemaVersion,
        new Date().toISOString(),
      );
      assert.ok(loaded, "Could not reopen the published checkpoint");
      const samples = [];
      let inode = loaded.file.ino;
      try {
        for (let trial = 0; trial < 5; trial++) {
          samples.push(await measure(() => sidecars.save(loaded.transfer)));
          const current = await stat(fileFor(jobId), { bigint: true });
          assert.notEqual(current.ino, inode);
          inode = current.ino;
        }
      } finally {
        removeTaskScratch(loaded.transfer.path);
      }
      entries[records].checkpoint_write = { ...stats(samples), samples };
    }
  } finally {
    db.close();
  }
}

function indexProbe(points, lag) {
  const db = new DatabaseSync(catalog, { readOnly: true });
  db.exec("PRAGMA busy_timeout=1000");
  const latest =
    db.prepare(`SELECT (SELECT revision FROM retrieval_source_revision WHERE singleton=1) AS source,
       (SELECT g.source_revision FROM retrieval_generations g JOIN retrieval_active_generation a USING(generation_id)) AS indexed`);
  let covered = 0;
  let error;
  const scan = () => {
    if (error) throw error;
    const now = Date.now();
    const current = latest.get();
    while (points[covered]?.revision <= current.indexed) {
      lag.upper_bounds_ms.push(Math.max(0, now - points[covered++].committed));
    }
    const oldest = points[covered];
    if (oldest)
      assert.ok(
        now - oldest.committed <= 120_000,
        "Search index is more than two minutes behind",
      );
    return current.source === current.indexed && covered === points.length;
  };
  const timer = setInterval(() => {
    try {
      scan();
    } catch (failure) {
      error = failure;
    }
  }, 250);
  return {
    async drain() {
      const timeout = Date.now() + 120_000;
      while (!scan()) {
        assert.ok(Date.now() < timeout, "Search index failed to settle");
        await wait(250);
      }
    },
    close() {
      clearInterval(timer);
      db.close();
    },
  };
}

async function run() {
  assert.equal(mode, scale);
  const output = resolve(destination);
  const reports = resolve("sandbox/reports") + "/";
  assert.ok(output.startsWith(reports));
  let previous;
  if (scale === "1m") {
    const baseline = resolve(reference);
    assert.ok(baseline.startsWith(reports));
    previous = JSON.parse(await readFile(baseline, "utf8"));
    assert.equal(previous.scale, "10k");
  }
  const result = {
    scale,
    corpus,
    environment: {
      node: process.version,
      os: release(),
      load_start: loadavg(),
    },
    objectives,
    ratio_limit: ratioLimit,
    trials,
    operations: {},
    failures: [],
    warnings: [],
    points: [],
    index: { upper_bounds_ms: [] },
    short_reads: {},
  };
  const save = () =>
    writeFile(output, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  const runtime = await acquireExecutionRuntime(catalog);
  let server, writer, probe;
  try {
    server = spawn("serve", result.warnings);
    const { origin } = await server.first();
    const request = await client(origin);
    const search = async (input) => {
      const { page } = await request("/api/v1/query/search", input);
      assert.ok(page.items.length);
      return page;
    };
    const counts = async (query) => {
      const { result } = await request("/api/v1/query/library-counts", {
        query,
      });
      assert.ok(
        result.total > 0 &&
          !result.counts_backfill_pending &&
          !result.status_updating,
      );
      return result;
    };
    const all = { collection_scope: "all" };
    const collected = { collection_scope: "collected" };
    const scoped = {
      ...all,
      folder: { id: folder, include_descendants: false },
      statuses: ["UNREVIEWED"],
    };
    const list = { query: {}, limit: 50 };
    const collectedPage = async () => {
      const page = await search(list);
      assert.ok(page.items.every((item) => item.collected === true));
      return page;
    };
    const initial = await counts(all);
    assert.equal(initial.full_text.total, corpus.papers);
    assert.equal(initial.full_text.obtained, corpus.obtained);
    const operations = {
      home: () => Promise.all([collectedPage(), counts(collected)]),
      counts: () => counts(all),
      workset: async () => {
        const input = { query: scoped, limit: 50, sort: "intake-desc" };
        const [first] = await Promise.all([
          search(input),
          counts(scoped),
          request("/api/v1/query/library-facets", { query: scoped, limit: 20 }),
        ]);
        assert.ok(first.next_cursor);
        const second = await search({ ...input, cursor: first.next_cursor });
        assert.notEqual(
          first.items[0].literature.literature_id,
          second.items[0].literature.literature_id,
        );
      },
      search: () =>
        search({
          query: { ...all, text: "spectroscopy" },
          limit: 50,
          sort: "relevance",
        }),
      task: async () => {
        const { task } = await request(`/api/tasks/${fixture.jobs.running}`);
        assert.equal(task.job.status, "running");
      },
    };
    writer = spawn("writer", result.warnings);
    writer.child.on("message", (point) => result.points.push(point));
    await writer.first();
    probe = indexProbe(result.points, result.index);
    await wait(2500);
    const began = Date.now();
    for (const [name, work] of Object.entries(operations)) {
      const samples = [];
      result.operations[name] = { samples };
      if (name === "task") {
        let pending = true;
        const cold = measure(work).finally(() => {
          pending = false;
        });
        const short = {
          page: collectedPage,
          article: () =>
            request("/api/v1/query/read", {
              literature_id: fixture.pdf.literature_id,
            }),
          status: () => request("/api/view"),
          pdf: async () =>
            assert.equal(
              await request(
                `/api/v1/query/material-bytes/${fixture.pdf.literature_id}/${fixture.pdf.asset}/${fixture.pdf.artifact.sha256}`,
                undefined,
                "bytes=0-1023",
              ),
              1024,
            ),
        };
        const cutoff = performance.now() + 10 * objectives.task;
        while (pending && performance.now() < cutoff) {
          for (const [shortName, read] of Object.entries(short)) {
            (result.short_reads[shortName] ??= []).push(await measure(read));
          }
          await wait(100);
        }
        const ms = await cold;
        samples.push(ms);
        result.operations.task.cold_ms = ms;
        if (ms > objectives.task)
          result.failures.push(
            `task cold ${ms.toFixed(1)} ms > ${objectives.task} ms`,
          );
      }
      if (samples.some((duration) => duration > 10 * objectives[name])) {
        // This diagnostic read isolates warm-cache behavior after the stop. It
        // is not an acceptance sample and does not dilute the cold read.
        if (name === "task")
          result.operations.task.followup_ms = await measure(work);
      } else
        while (samples.length < trials) {
          const duration = await measure(work);
          samples.push(duration);
          if (duration > 10 * objectives[name]) break;
          await wait(40);
        }
      const distribution = stats(samples);
      if (distribution.n !== trials) {
        distribution.p50_ms = null;
        distribution.p95_ms = null;
      }
      Object.assign(result.operations[name], distribution);
      console.log(scale, name, JSON.stringify(distribution));
      if (
        scale === "1m" &&
        distribution.n === trials &&
        distribution.p95_ms > objectives[name]
      )
        result.failures.push(
          `${name} P95 ${distribution.p95_ms.toFixed(1)} ms > ${objectives[name]} ms`,
        );
      if (previous && distribution.n === trials) {
        const baseline = previous.operations[name];
        if (baseline?.n === trials && baseline.p95_ms > 0) {
          const ratio = distribution.p95_ms / baseline.p95_ms;
          result.operations[name].ratio = ratio;
          if (ratio > ratioLimit)
            result.failures.push(
              `${name} P95 ratio ${ratio.toFixed(2)} > ${ratioLimit}`,
            );
        } else result.failures.push(`No complete 10k P95 for ${name}`);
      }
      await save();
      if (samples.some((duration) => duration > 10 * objectives[name])) {
        result.stopped_at = name;
        result.failures.push(
          `Stopped at ${name}: latency over ten times target`,
        );
        break;
      }
    }
    const finished = Date.now();
    const inWindow = result.points.filter(
      (point) => point.committed >= began && point.committed <= finished,
    );
    const first = inWindow[0],
      last = inWindow.at(-1);
    result.papers_per_second =
      first && last && last.committed > first.committed
        ? ((last.papers - first.papers) * 1000) /
          (last.committed - first.committed)
        : 0;
    if (result.papers_per_second < 100)
      result.failures.push("Write load below 100 committed papers/s");
    for (const [name, values] of Object.entries(result.short_reads)) {
      const distribution = stats(values);
      result.short_reads[name] = { samples: values, ...distribution };
      if (distribution.max_ms > SHORT_READ_LIMIT_MS)
        result.failures.push(
          `Short read ${name} exceeded ${SHORT_READ_LIMIT_MS} ms`,
        );
      if (name === "page" && distribution.p95_ms > objectives.home)
        result.failures.push("Short page P95 exceeded 1 s during a long read");
    }
  } catch (error) {
    result.failures.push(error.stack ?? String(error));
  } finally {
    try {
      await writer?.close();
      await probe?.drain();
      result.index.max_upper_bound_ms = Math.max(
        0,
        ...result.index.upper_bounds_ms,
      );
      if (result.index.max_upper_bound_ms > 120_000)
        result.failures.push("Index lag exceeded 2 minutes");
    } catch (error) {
      result.failures.push(String(error));
    } finally {
      probe?.close();
    }
    try {
      await server?.close();
    } catch (error) {
      result.failures.push(String(error));
    } finally {
      await runtime.release();
    }
    if (result.warnings.length)
      result.failures.push("Short SQLite read budget log emitted");
    result.environment.load_finish = loadavg();
    await save();
  }
  assert.deepEqual(result.failures, []);
}

export { catalog, client, fixture, folder, measure, root, spawn, stats, stop };

if (resolve(process.argv[1]) === import.meta.filename) {
  if (mode === "serve") await serve();
  else if (mode === "writer") await write();
  else if (mode === "inspect-task") await inspectTask();
  else if (mode === "task-sidecar") await taskSidecar();
  else await run();
}
