// Explicit offline runner: node --experimental-strip-types apps/server/test/scale-supervisor.ts
// Owns only its detached process group; other tests are observed, never signalled.
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  openSync,
  closeSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { hostname, loadavg } from "node:os";
import { DatabaseSync } from "node:sqlite";

const directory = resolve(process.env.SCIRETRIEVER_SCALE_REPORT ?? "");
if (
  !process.env.SCIRETRIEVER_SCALE_REPORT ||
  !process.env.SCIRETRIEVER_SCALE_RECORDS
)
  throw new Error(
    "Explicit scale report directory and record count are required",
  );
await mkdir(directory, { recursive: true });
const logPath = join(directory, "run.log"),
  ledger = join(directory, "pauses.json");
if (existsSync(logPath) || existsSync(join(directory, "scale-report.json")))
  throw new Error("Refusing to overwrite a previous scale run");
type Pause = { start_ms: number; end_ms: number | null };
const pauses: Pause[] = [];
const json = (path: string, value: unknown) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
};
json(ledger, pauses);
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const processes = () =>
  execFileSync("ps", ["-eo", "pid=,ppid=,pgid=,stat=,time=,rss=,comm="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, ppid, pgid, status, cpu_time, rss, ...name] = line
        .trim()
        .split(/\s+/u);
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        status: status!,
        cpu_time,
        rss_kib: Number(rss),
        command: name.join(" "),
      };
    });
const otherTests = (group?: number) =>
  processes().filter(
    (p) =>
      p.pgid !== group &&
      !p.status.startsWith("Z") &&
      /vitest/iu.test(p.command),
  );
const note = (event: string, details: unknown) => {
  const entry = { at: new Date().toISOString(), event, details };
  appendFileSync(
    join(directory, "supervision.jsonl"),
    JSON.stringify(entry) + "\n",
  );
  console.log(JSON.stringify(entry));
};
const requested = Date.now();
while (otherTests().length) {
  note("waiting-for-other-vitest", otherTests());
  if (Date.now() - requested > 60 * 60_000)
    throw new Error("Other Vitest processes did not settle within one hour");
  await wait(55_000);
}
const started = Date.now();
json(join(directory, "before.json"), {
  at: new Date(started).toISOString(),
  load: loadavg(),
  host: hostname(),
  node: process.version,
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  records: process.env.SCIRETRIEVER_SCALE_RECORDS,
  retry_boundary: process.env.SCIRETRIEVER_SCALE_RETRY_BOUNDARY === "1",
});
const log = openSync(logPath, "wx");
const child = spawn(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "apps/server/test/scale-collection.test.ts",
    "--maxWorkers=1",
  ],
  { detached: true, stdio: ["ignore", log, log] },
);
closeSync(log);
if (!child.pid) throw new Error("Scale runner failed to start");
const group = child.pid;
let finished:
  | { code: number | null; signal: NodeJS.Signals | null }
  | undefined;
child.once("exit", (code, signal) => {
  finished = { code, signal };
});
child.once("error", (error) => {
  note("spawn-error", String(error));
  finished = { code: 1, signal: null };
});
const signal = (name: NodeJS.Signals) => {
  try {
    process.kill(-group, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};
const pausedMs = () =>
  pauses.reduce(
    (n, pause) => n + (pause.end_ms ?? Date.now()) - pause.start_ms,
    0,
  );
let interrupted = false;
process.once("SIGTERM", () => {
  interrupted = true;
});
process.once("SIGINT", () => {
  interrupted = true;
});
const snapshot = () => {
  const own = processes().filter((p) => p.pgid === group);
  let report: {
    current_stage?: string;
    status?: string;
    isolation?: { home: string; catalog: string };
  } = {};
  try {
    report = JSON.parse(
      readFileSync(join(directory, "scale-report.json"), "utf8"),
    );
  } catch {
    /* First stage may not have published yet. */
  }
  const files = [
    logPath,
    join(directory, "scale-report.json"),
    ...(report.isolation
      ? [join(report.isolation.home, "source-requests.jsonl")]
      : []),
  ].flatMap((path) => {
    try {
      const info = statSync(path);
      return [
        { path, bytes: info.size, modified_at: info.mtime.toISOString() },
      ];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [];
    }
  });
  let catalog: unknown = null;
  if (
    report.status === "running" &&
    report.isolation &&
    existsSync(report.isolation.catalog)
  ) {
    try {
      const db = new DatabaseSync(report.isolation.catalog, { readOnly: true });
      try {
        catalog = {
          jobs: db
            .prepare(
              "SELECT status,count(*) n FROM execution_jobs GROUP BY status",
            )
            .all(),
          targets: db
            .prepare(
              "SELECT stage,count(*) n FROM execution_targets GROUP BY stage",
            )
            .all(),
          attempts: db
            .prepare("SELECT count(*) n FROM execution_attempts")
            .get(),
          pdfs: db
            .prepare(
              "SELECT count(*) n FROM literature_assets WHERE role='primary-pdf'",
            )
            .get(),
        };
      } finally {
        db.close();
      }
    } catch (error) {
      // A successful test removes its synthetic home after publishing the final report.
      catalog = { snapshot_error: String(error) };
    }
  }
  return {
    group,
    active_ms: Date.now() - started - pausedMs(),
    paused_ms: pausedMs(),
    load: loadavg(),
    processes: own,
    stage: report.current_stage,
    status: report.status,
    files,
    catalog,
  };
};
let failure: string | null = null,
  lastCheck = started,
  lastProgress = 0;
try {
  note("started", { pid: child.pid, group });
  while (!finished) {
    if (interrupted) throw new Error("Scale supervisor was interrupted");
    const others = otherTests(group),
      currentPause = pauses.at(-1);
    if (others.length && (!currentPause || currentPause.end_ms !== null)) {
      pauses.push({ start_ms: Date.now(), end_ms: null });
      signal("SIGSTOP");
      json(ledger, pauses);
      note("paused-for-other-vitest", others);
    } else if (!others.length && currentPause?.end_ms === null) {
      currentPause.end_ms = Date.now();
      json(ledger, pauses);
      signal("SIGCONT");
      note("resumed", { paused_ms: pausedMs() });
    }
    if (pausedMs() > 60 * 60_000)
      throw new Error("External Vitest pauses exceeded one hour");
    if (Date.now() - started - pausedMs() > 8 * 60 * 60_000)
      throw new Error("Scale run exceeded eight active hours");
    if (Date.now() - lastProgress >= 55_000) {
      note("progress", snapshot());
      lastProgress = Date.now();
    }
    if (Date.now() - lastCheck >= 20 * 60_000) {
      const check = snapshot();
      json(
        join(
          directory,
          `check-${Math.floor((Date.now() - started) / 60_000)}m.json`,
        ),
        check,
      );
      note("twenty-minute-check", check);
      lastCheck = Date.now();
    }
    await wait(5_000);
  }
} catch (error) {
  failure = error instanceof Error ? error.stack! : String(error);
  note("supervisor-failed", failure);
} finally {
  const currentPause = pauses.at(-1);
  if (currentPause?.end_ms === null) {
    currentPause.end_ms = Date.now();
    json(ledger, pauses);
    signal("SIGCONT");
  }
  if (!finished) {
    signal("SIGTERM");
    const stopAt = Date.now();
    while (!finished && Date.now() - stopAt < 20_000) await wait(100);
  }
  // Remove only surviving descendants in the group owned by this runner.
  signal("SIGKILL");
  const completion = {
    finished_at: new Date().toISOString(),
    raw_wall_ms: Date.now() - started,
    paused_ms: pausedMs(),
    active_wall_ms: Date.now() - started - pausedMs(),
    load: loadavg(),
    outcome: finished,
    failure,
  };
  json(join(directory, "completion.json"), completion);
  note("finished", completion);
  process.exitCode = failure || finished?.code !== 0 ? 1 : 0;
}
