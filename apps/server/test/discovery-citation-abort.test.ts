import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  EMPTY_METADATA,
  parseMetadataObservation,
} from "@sciretriever/contracts";
import {
  createApplication,
  type Application,
} from "../src/bootstrap/application.js";
import { withActivity } from "../src/logging/activity.js";
import type { MetadataTransport } from "../src/providers/shared/metadata-transport.js";
import { CitationProgress } from "../src/storage/sqlite/citation-progress.js";

const stopBudgetMs = 20_000;
const doi = (n: number) => `10.5555/citation-abort-${n}`;
const work = (n: number) => ({
  id: `https://openalex.org/W${n}`,
  doi: `https://doi.org/${doi(n)}`,
  title: `Offline citation work ${n}`,
  publication_year: 2026,
  cited_by_count: 1,
});

function options(request: MetadataTransport["request"]) {
  return {
    indexRefreshIntervalMs: null,
    browserHost: () => null,
    metadataAssembly: {
      transportFactory: () => ({ request }),
    },
  };
}

async function submit(app: Application) {
  const observation = parseMetadataObservation({
    source_type: null,
    source_type_mapping_version: null,
    observation_id: "b75374e1-ccad-43f4-8c64-900df1662f27",
    provenance: {
      provenance_id: "a99c367f-ef88-4875-8ba7-221598bdf9fb",
      source_kind: "metadata-provider",
      source_name: "openalex",
      source_record_id: work(101).id,
      observed_at: "2026-11-23T00:00:00Z",
      input_sha256: "a".repeat(64),
      parameters_sha256: null,
    },
    metadata: {
      ...EMPTY_METADATA,
      title: work(101).title,
      identifiers: [{ namespace: "doi", value: doi(101) }],
    },
    version_role: "published",
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });
  const seed = await app.identity.observe(observation);
  if (seed.disposition !== "accepted") throw new Error(seed.reason);
  return withActivity({ actor: "cli:citation-abort-fixture" }, () =>
    app.processingTasks!.submit({
      schema_version: 1,
      idempotency_key: "offline-citation-abort",
      operations: [
        {
          operation: "acquire-metadata",
          request: {
            kind: "citation",
            seed_literature_ids: [seed.literature_id],
            direction: "cited-by",
            max_depth: 2,
            result_limit: null,
            providers: [{ source: "openalex", scan_limit: null }],
          },
        },
      ],
    }),
  );
}

function runFacts(home: string) {
  using db = new DatabaseSync(join(home, "catalog.sqlite"), { readOnly: true });
  return db
    .prepare(
      `
    SELECT r.discovery_run_id,r.status,b.state,b.result,
      (SELECT count(*) FROM discovery_results d WHERE d.discovery_run_id=r.discovery_run_id) AS results,
      (SELECT count(*) FROM citation_discovery_causes c WHERE c.discovery_run_id=r.discovery_run_id) AS causes
    FROM discovery_runs r JOIN intake_batches b USING(discovery_run_id)
  `,
    )
    .all();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function startRunner(home: string, jobId: string) {
  const child = fork(
    fileURLToPath(new URL("./citation-abort-child.mjs", import.meta.url)),
    [home, jobId],
    {
      execArgv: [],
      env: {
        COREPACK_ENABLE_NETWORK: "0",
        npm_config_offline: "true",
        HOME: home,
        PATH: "/usr/bin:/bin",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const layer = deferred();
  const drain = deferred();
  const repeated = deferred();
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (text: string) => {
    stderr += text;
    if (stderr.includes("Stop already requested. Finishing shutdown."))
      repeated.resolve();
  });
  child.on("message", (message) => {
    if (message === "second-layer") layer.resolve();
    if (message === "draining") drain.resolve();
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const waitFor = (milestone: Promise<void>) =>
    within(
      Promise.race([
        milestone,
        exited.then((exit) => {
          throw new Error(
            `Unexpected runner exit ${JSON.stringify(exit)}: ${stderr}`,
          );
        }),
      ]),
    );
  return {
    child,
    exited,
    layer: () => waitFor(layer.promise),
    drain: () => waitFor(drain.promise),
    repeated: () => waitFor(repeated.promise),
    async close() {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await within(exited);
    },
  };
}

async function within<T>(operation: Promise<T>, ms = stopBudgetMs) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      operation,
      delay(ms, undefined, { signal: controller.signal }).then(() => {
        throw new Error(`Citation stop exceeded ${ms} ms`);
      }),
    ]);
  } finally {
    controller.abort();
  }
}

it("cancels an in-flight second-layer provider request, settles and resumes without duplicates", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-citation-abort-"));
  const entered = deferred();
  const release = deferred();
  const stop = new AbortController();
  let blocked = true;
  let transportSignal: AbortSignal | undefined;
  const calls: string[] = [];
  const app = await createApplication(
    home,
    options(async (url, opts) => {
      const anchor = new URL(url).searchParams.get("filter")!;
      calls.push(anchor);
      if (anchor === "cites:W101") return { meta: {}, results: [work(102)] };
      if (anchor !== "cites:W102") throw new Error("Unexpected fixture query");
      if (blocked) {
        transportSignal = opts?.signal;
        entered.resolve();
        if (!transportSignal?.aborted) {
          const cancelled = deferred();
          const abort = () => cancelled.resolve();
          transportSignal?.addEventListener("abort", abort, { once: true });
          try {
            await Promise.race([release.promise, cancelled.promise]);
          } finally {
            transportSignal?.removeEventListener("abort", abort);
          }
        }
        transportSignal?.throwIfAborted();
      }
      return { meta: {}, results: [work(103)] };
    }),
  );
  let running:
    | ReturnType<NonNullable<Application["processingTasks"]>["runResults"]>
    | undefined;
  try {
    const job = await submit(app);
    running = app.processingTasks!.runResults(job.job_id, stop.signal);
    await within(
      Promise.race([
        entered.promise,
        running.then((result) => {
          throw new Error(
            `Expansion ended before the second layer: ${JSON.stringify({ calls, result, facts: runFacts(home) })}`,
          );
        }),
      ]),
    );
    const [before] = runFacts(home);
    expect(before).toMatchObject({ status: "RUNNING", results: 1, causes: 1 });
    const began = performance.now();
    stop.abort();
    await expect(within(running)).resolves.toMatchObject([
      { outcome: "interrupted" },
    ]);
    expect(performance.now() - began).toBeLessThan(stopBudgetMs);
    expect(transportSignal?.aborted).toBe(true);
    expect(await app.processingTasks!.read(job.job_id)).toMatchObject({
      job: { status: "interrupted" },
      targets: [{ disposition: "interrupted" }],
    });
    expect(runFacts(home)).toEqual([
      {
        ...before,
        status: "INTERRUPTED",
        state: "finished",
        result: "interrupted",
      },
    ]);

    blocked = false;
    await app.processingTasks!.control(job.job_id, "resume");
    await within(app.processingTasks!.runResults(job.job_id));
    expect(calls).toEqual(["cites:W101", "cites:W102", "cites:W102"]);
    expect(runFacts(home)).toEqual([
      {
        ...before,
        status: "COMPLETED",
        state: "finished",
        result: "completed",
        results: 2,
        causes: 2,
      },
    ]);
  } finally {
    stop.abort();
    release.resolve();
    await running?.catch(() => {});
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
import { fork } from "node:child_process";

async function seededHome(home: string) {
  const app = await createApplication(
    home,
    options(async () => {
      throw new Error(
        "Preparing the offline fixture must not request a provider",
      );
    }),
  );
  try {
    return await submit(app);
  } finally {
    await app.close();
  }
}

it("yields to cancellation while propagating a late shorter path", async () => {
  const progress = new CitationProgress(["seed"], 4, "references");
  const cause = (source: string, target: string, depth: number) => ({
    meta_literature_id: target,
    source_literature_id: source,
    target_literature_id: target,
    actual_literature_id: target,
    depth,
  });
  const stop = new AbortController();
  const scheduled = setImmediate(() => stop.abort());
  try {
    await progress.record([cause("old-anchor", "hub", 2)], null);
    await progress.record(
      Array.from({ length: 512 }, (_, n) => cause("hub", String(n), 3)),
      null,
    );
    await expect(
      progress.record(
        [cause("seed", "hub", 1)],
        null,
        undefined,
        undefined,
        stop.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    clearImmediate(scheduled);
    progress.close();
  }
});

it.each(["SIGTERM", "SIGINT"] as const)(
  "keeps settling the citation run after a repeated %s",
  async (signal) => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-citation-signal-"));
    let runner: ReturnType<typeof startRunner> | undefined;
    let reopened: Application | undefined;
    try {
      const job = await seededHome(home);
      runner = startRunner(home, job.job_id);
      await runner.layer();
      const [before] = runFacts(home);
      expect(before).toMatchObject({
        status: "RUNNING",
        results: 1,
        causes: 1,
      });
      expect(runner.child.kill(signal)).toBe(true);
      await runner.drain();
      expect(runner.child.kill(signal)).toBe(true);
      await runner.repeated();
      runner.child.send("finish-drain");
      expect(await within(runner.exited)).toEqual({ code: 130, signal: null });
      // Check the durable state before opening the app that could otherwise recover it.
      expect(runFacts(home)).toEqual([
        {
          ...before,
          status: "INTERRUPTED",
          state: "finished",
          result: "interrupted",
        },
      ]);
      reopened = await createApplication(
        home,
        options(async () => {
          throw new Error(
            "Reading the interrupted job must not call a provider",
          );
        }),
      );
      expect(reopened.executionRecovery?.recovered_jobs).toBe(0);
      expect(await reopened.processingTasks!.read(job.job_id)).toMatchObject({
        job: { status: "interrupted" },
        targets: [{ disposition: "interrupted" }],
      });
    } finally {
      await runner?.close();
      await reopened?.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);

it("recovers and resumes the same citation run after SIGKILL of a running owner", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-citation-crash-"));
  let runner: ReturnType<typeof startRunner> | undefined;
  let reopened: Application | undefined;
  try {
    const job = await seededHome(home);
    runner = startRunner(home, job.job_id);
    await runner.layer();
    const [before] = runFacts(home);
    expect(before).toMatchObject({ status: "RUNNING", results: 1, causes: 1 });
    expect(runner.child.kill("SIGKILL")).toBe(true);
    expect(await within(runner.exited)).toEqual({
      code: null,
      signal: "SIGKILL",
    });
    using reader = new DatabaseSync(join(home, "catalog.sqlite"), {
      readOnly: true,
    });
    expect(
      reader
        .prepare("SELECT status FROM execution_jobs WHERE job_id=?")
        .get(job.job_id),
    ).toMatchObject({ status: "running" });
    expect(runFacts(home)[0]).toEqual(before);
    const calls: string[] = [];
    reopened = await createApplication(
      home,
      options(async (url) => {
        calls.push(new URL(url).searchParams.get("filter")!);
        return { meta: {}, results: [work(103)] };
      }),
    );
    expect(reopened.executionRecovery).toMatchObject({
      recovered_jobs: 1,
      recovered_attempts: 1,
    });
    expect(runFacts(home)).toEqual([
      {
        ...before,
        status: "INTERRUPTED",
        state: "finished",
        result: "interrupted",
      },
    ]);
    expect(await reopened.processingTasks!.read(job.job_id)).toMatchObject({
      job: { status: "interrupted" },
      targets: [{ disposition: "interrupted" }],
    });
    await reopened.processingTasks!.control(job.job_id, "resume");
    expect(
      await within(reopened.processingTasks!.runResults(job.job_id)),
    ).toMatchObject([{ outcome: "completed" }]);
    expect(calls).toEqual(["cites:W102"]);
    expect(runFacts(home)).toEqual([
      {
        ...before,
        status: "COMPLETED",
        state: "finished",
        result: "completed",
        results: 2,
        causes: 2,
      },
    ]);
  } finally {
    await runner?.close();
    await reopened?.close();
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
