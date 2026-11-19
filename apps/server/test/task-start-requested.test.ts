import { describe, expect, it, vi } from "vitest";
import { ProcessingTaskService } from "../src/application/jobs/processing.js";
import { ExecutionQueue } from "../src/application/jobs/service.js";
import { taskHttpAdapters } from "../src/bootstrap/workbench.js";
import { ExecutionRepository } from "../src/storage/execution/repository.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { activityContext, withActivity } from "../src/logging/activity.js";
import { runCli } from "../src/cli/main.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function memoryFixture() {
  const database = new SqliteWorker();
  const repository = new ExecutionRepository(database);
  let hook: (signal: AbortSignal) => Promise<void> = async () => {};
  const execute = vi.fn(async (_request: unknown, signal: AbortSignal) => {
    await hook(signal);
    return { status: "COMPLETED" };
  });
  const service = new ProcessingTaskService(
    repository,
    new ExecutionQueue(repository),
    {
      documents: {
        parseDocuments: async () => {
          throw new Error("Unexpected synthetic parse");
        },
      },
      identity: null,
      metadata: { execute },
    },
    null,
    "synthetic-start-boot",
    1,
  );
  return {
    database,
    repository,
    service,
    execute,
    setHook(value: typeof hook) {
      hook = value;
    },
    submit: (key: string) =>
      service.submit({
        schema_version: 1,
        idempotency_key: key,
        operations: [
          {
            operation: "acquire-metadata",
            request: {
              kind: "topic",
              query: "synthetic",
              year_from: null,
              year_to: null,
              providers: [{ source: "crossref", scan_limit: 1 }],
            },
          },
        ],
      }),
    async close() {
      await service.close();
      await database.close();
    },
  };
}
const untilAborted = (signal?: AbortSignal) =>
  new Promise<void>((_, reject) => {
    if (signal?.aborted) {
      reject(new Error("Synthetic interruption"));
      return;
    }
    signal?.addEventListener(
      "abort",
      () => reject(new Error("Synthetic interruption")),
      { once: true },
    );
  });

describe("durable background start requests", () => {
  it("projects false for saved jobs and records the accepting actor before starting", async () => {
    const env = memoryFixture();
    const held = deferred();
    env.setHook(() => held.promise);
    try {
      const job = await env.submit("start-marker");
      expect((await env.service.read(job.job_id)).start_requested).toBe(false);
      expect(await env.repository.listJobs()).toMatchObject([
        { job_id: job.job_id, start_requested: false },
      ]);
      expect(
        await withActivity({ actor: "synthetic:start-owner" }, () =>
          env.service.start(job.job_id),
        ),
      ).toBe(true);
      expect((await env.service.read(job.job_id)).start_requested).toBe(true);
      expect(await env.repository.listEvents(job.job_id)).toContainEqual(
        expect.objectContaining({
          kind: "task-start-requested",
          payload: { actor: "synthetic:start-owner" },
        }),
      );
      const settled = env.service.runResults(job.job_id);
      held.resolve();
      await settled;
      await env.service.close();
      const read = vi.spyOn(env.database, "run");
      expect(await env.repository.listJobs()).toMatchObject([
        { job_id: job.job_id, start_requested: true },
      ]);
      expect(read.mock.calls.map(([command]) => command.kind)).toEqual([
        "execution_list_jobs",
      ]);
    } finally {
      held.resolve();
      await env.close();
    }
  });

  it("persists capacity-waiting starts without attempts and does not append another request on dispatch", async () => {
    const env = memoryFixture();
    const held = deferred();
    env.setHook(() => held.promise);
    try {
      const first = await env.submit("capacity-owner");
      const queued = await env.submit("capacity-waiter");
      expect(await env.service.start(first.job_id)).toBe(true);
      await vi.waitFor(() => expect(env.execute).toHaveBeenCalledOnce(), {
        timeout: 20_000,
      });
      expect(await env.service.start(queued.job_id)).toBe(false);
      expect(await env.service.read(queued.job_id)).toMatchObject({
        job: { status: "queued" },
        start_requested: true,
      });
      expect(await env.repository.listAttempts(`${queued.job_id}:0`)).toEqual(
        [],
      );
      held.resolve();
      await vi.waitFor(
        async () =>
          expect((await env.service.read(queued.job_id)).job.status).toBe(
            "completed",
          ),
        { timeout: 20_000 },
      );
      expect(
        (await env.repository.listEvents(queued.job_id)).filter(
          (e) => e.kind === "task-start-requested",
        ),
      ).toHaveLength(1);
    } finally {
      held.resolve();
      await env.close();
    }
  });

  it("rejects explicit HTTP starts and returns false from background admission without recording requests", async () => {
    const env = await coreProcessingFixture({
      offline: true,
      analysisModel: false,
    });
    const repository = env.app.jobs!;
    const tasks = env.app.processingTasks!;
    const session = new ProductionWorkbenchSession(null, undefined);
    let server: Awaited<ReturnType<typeof startWorkbenchHttp>> | undefined;
    try {
      server = await startWorkbenchHttp({
        ...taskHttpAdapters(env.app),
        access: workbenchTestAccess,
        session,
        assets: new Map([["/", { contentType: "text/html", body: "fixture" }]]),
      });
      const origin = server.origin;
      const auth = await workbenchLogin(origin);
      const landing = await fetch(origin, { headers: { Cookie: auth } });
      expect(landing.status).toBe(200);
      const headers = {
        Cookie: `${auth}; ${landing.headers.get("set-cookie")!.split(";")[0]}`,
        Origin: origin,
        "Content-Type": "application/json",
      };
      const attached = await fetch(`${origin}/api/clients`, {
        method: "POST",
        headers: { ...headers, "X-Workbench-Init": "1" },
        body: "{}",
      });
      expect(attached.status).toBe(201);
      const grant = (await attached.json()) as {
        client_id: string;
        csrf: string;
      };
      const expectRefused = async (
        jobId: string,
        status: number,
        code: string,
      ) => {
        const response = await fetch(
          `${origin}/api/tasks/${jobId}/start?client_id=${grant.client_id}`,
          {
            method: "POST",
            headers: { ...headers, "X-Workbench-Csrf": grant.csrf },
            body: "{}",
          },
        );
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ code });
        expect(await tasks.start(jobId)).toBe(false);
        expect(await repository.listEvents(jobId)).toEqual([]);
      };
      await expectRefused("missing-start", 404, "processing-not-found");
      for (const status of [
        "completed",
        "cancelled",
        "failed",
        "paused",
        "interrupted",
      ] as const) {
        const job = await tasks.submit({
          schema_version: 1,
          idempotency_key: `refused-${status}`,
          operations: [
            { operation: "parse-documents", request: env.rawParseRequest },
          ],
        });
        await repository.updateJob(job.job_id, status);
        await expectRefused(
          job.job_id,
          409,
          status === "completed" || status === "cancelled"
            ? "processing-terminal"
            : "processing-resume-required",
        );
        expect(await tasks.read(job.job_id)).toMatchObject({
          job: { status },
          start_requested: false,
        });
      }
      expect(env.parseCalls).toBe(0);
    } finally {
      await server?.close();
      await session.close();
      await env.close();
    }
  });

  it("checks the current state in the start-request transaction when cancellation wins the race", async () => {
    const env = memoryFixture();
    try {
      const job = await env.submit("start-cancel-race");
      const request = env.repository.requestStart.bind(env.repository);
      vi.spyOn(env.repository, "requestStart").mockImplementationOnce(
        async (id) => {
          await env.service.control(id, "cancel");
          return request(id);
        },
      );
      expect(await env.service.start(job.job_id)).toBe(false);
      expect(
        (await env.repository.listEvents(job.job_id)).some(
          (e) => e.kind === "task-start-requested",
        ),
      ).toBe(false);
      expect((await env.repository.getJob(job.job_id))?.status).toBe(
        "cancelled",
      );
      expect(env.execute).not.toHaveBeenCalled();
    } finally {
      await env.close();
    }
  });

  it("preserves continuation admission without adding start requests for resume or retry", async () => {
    const env = memoryFixture();
    const held = deferred();
    env.setHook(() => held.promise);
    try {
      const first = await env.submit("continuation-owner");
      await env.service.start(first.job_id);
      await vi.waitFor(() => expect(env.execute).toHaveBeenCalledOnce(), {
        timeout: 20_000,
      });
      for (const intent of ["resume", "retry"] as const) {
        const job = await env.submit(`continuation-${intent}`);
        await env.repository.updateJob(
          job.job_id,
          intent === "resume" ? "paused" : "failed",
        );
        await env.service.control(job.job_id, intent);
        expect(await env.service.start(job.job_id, intent)).toBe(false);
        expect(await env.service.read(job.job_id)).toMatchObject({
          job: { status: "queued" },
          start_requested: false,
        });
      }
      expect(await env.repository.listRequestedJobs()).toEqual([]);
    } finally {
      held.resolve();
      await env.close();
    }
  });

  it("leaves requested queued work untouched in default Applications and one-shot foreground CLI runs", async () => {
    const env = await coreProcessingFixture({
      offline: true,
      analysisModel: false,
    });
    try {
      const requested = await env.app.processingTasks!.submit({
        schema_version: 1,
        idempotency_key: "one-shot-must-not-restore",
        operations: [
          { operation: "parse-documents", request: env.rawParseRequest },
        ],
      });
      // Persist the accepted request at the crash point before it is dispatched.
      await env.app.jobs!.requestStart(requested.job_id);
      const job = await env.app.jobs!.getJob(requested.job_id);
      const events = await env.app.jobs!.listEvents(requested.job_id);
      const assertUntouched = async () => {
        expect(await env.app.jobs!.getJob(requested.job_id)).toEqual(job);
        expect(await env.app.jobs!.listEvents(requested.job_id)).toEqual(
          events,
        );
        expect(
          await env.app.jobs!.listAttempts(`${requested.job_id}:0`),
        ).toEqual([]);
        expect(
          (await env.app.processingTasks!.read(requested.job_id))
            .start_requested,
        ).toBe(true);
        expect(env.parseCalls).toBe(0);
      };
      await env.reopen();
      expect(env.app.executionRecovery).toMatchObject({
        recovered_jobs: 0,
        recovered_attempts: 0,
      });
      await assertUntouched();

      const foreground = await env.app.jobService!.create({
        target_kind: "selector",
        selector: {
          kind: "literatures",
          literature_ids: [env.parseRequest.literature_id],
        },
        goal: "pdf",
        policy_version: "one-shot-foreground",
        policy: { mode: "never", max_retries: 0 },
        idempotency_key: "explicit-foreground-only",
      });
      await env.app.close();
      const errors: string[] = [];
      const result = await runCli(["jobs", "run", foreground.job_id], {
        home: env.home,
        stdout: () => {},
        stderr: (text) => errors.push(text),
      });
      expect(result.code, errors.join("\n")).toBe(0);
      await env.reopen();
      expect((await env.app.jobs!.getJob(foreground.job_id))?.status).toBe(
        "completed",
      );
      await assertUntouched();
      expect(env.modelCalls).toBe(0);
    } finally {
      await env.close();
    }
  });

  it("restores only requested queued jobs without attempts in request order and respects configured concurrency", async () => {
    const env = await coreProcessingFixture({
      offline: true,
      analysisModel: false,
      configurationText: "[execution]\nmax_concurrency=1\n",
      restoreRequestedTasks: true,
    });
    const gates = [deferred(), deferred()];
    const observed: string[] = [];
    let concurrent = 0,
      peak = 0;
    const submit = (key: string) =>
      env.app.processingTasks!.submit({
        schema_version: 1,
        idempotency_key: key,
        operations: [
          {
            operation: "parse-documents",
            request: {
              ...env.rawParseRequest,
              profiles: ["pipeline"],
              force: true,
            },
          },
        ],
      });
    try {
      env.setParseHook(untilAborted);
      const running = await submit("restart-owner");
      await env.app.processingTasks!.start(running.job_id);
      await vi.waitFor(() => expect(env.parseCalls).toBe(1), {
        timeout: 20_000,
      });
      const older = await submit("created-first-started-second");
      const newer = await submit("created-second-started-first");
      expect(await env.app.processingTasks!.start(newer.job_id)).toBe(false);
      expect(await env.app.processingTasks!.start(older.job_id)).toBe(false);
      const saved = await submit("never-started");
      const excluded = [];
      for (const status of ["paused", "interrupted"] as const) {
        const job = await submit(`restart-${status}`);
        await env.app.jobs!.requestStart(job.job_id);
        await env.app.jobs!.updateJob(job.job_id, status);
        excluded.push({ job, status });
      }
      const attempted = await submit("queued-with-prior-attempt");
      await env.app.jobs!.requestStart(attempted.job_id);
      await env.app.jobs!.startAttempt({
        attempt_id: "previous-start-attempt",
        target_id: `${attempted.job_id}:0`,
        stage: "parsing",
        status: "completed",
        started_at: "2026-11-19T00:00:00.000Z",
        finished_at: "2026-11-19T00:00:01.000Z",
        failure: null,
        usage: null,
      });
      await env.app.close();
      env.setParseHook(async () => {
        observed.push(activityContext().job_id!);
        peak = Math.max(peak, ++concurrent);
        try {
          await gates[observed.length - 1]!.promise;
        } finally {
          concurrent--;
        }
      });
      await env.reopen();
      expect(env.app.executionRecovery).not.toBeNull();
      await vi.waitFor(() => expect(observed).toEqual([newer.job_id]), {
        timeout: 20_000,
      });
      expect(await env.app.jobs!.listAttempts(`${older.job_id}:0`)).toEqual([]);
      gates[0]!.resolve();
      await vi.waitFor(
        () => expect(observed).toEqual([newer.job_id, older.job_id]),
        { timeout: 20_000 },
      );
      gates[1]!.resolve();
      await vi.waitFor(
        async () =>
          expect((await env.app.jobs!.getJob(older.job_id))?.status).toBe(
            "completed",
          ),
        { timeout: 20_000 },
      );
      expect(peak).toBe(1);
      for (const job of [newer, older]) {
        expect(
          (await env.app.processingTasks!.read(job.job_id)).start_requested,
        ).toBe(true);
        expect(
          (await env.app.jobs!.listEvents(job.job_id)).filter(
            (e) => e.kind === "task-start-requested",
          ),
        ).toHaveLength(1);
      }
      expect((await env.app.jobs!.getJob(running.job_id))?.status).toBe(
        "interrupted",
      );
      for (const { job, status } of excluded) {
        expect((await env.app.jobs!.getJob(job.job_id))?.status).toBe(status);
        expect(await env.app.jobs!.listAttempts(`${job.job_id}:0`)).toEqual([]);
      }
      expect((await env.app.jobs!.getJob(attempted.job_id))?.status).toBe(
        "queued",
      );
      expect(
        await env.app.jobs!.listAttempts(`${attempted.job_id}:0`),
      ).toHaveLength(1);
      expect(await env.app.processingTasks!.read(saved.job_id)).toMatchObject({
        job: { status: "queued" },
        start_requested: false,
      });
      async function* input() {
        yield Buffer.from(JSON.stringify({ job_id: newer.job_id }));
      }
      const inspected = await runCli(
        ["jobs", "inspect", "--request", "-", "--json"],
        { home: env.home, stdin: input(), stdout: () => {}, stderr: () => {} },
      );
      expect(inspected.code).toBe(0);
      expect(inspected.value).toMatchObject({
        result: { start_requested: true },
      });
    } finally {
      for (const gate of gates) gate.resolve();
      await env.close();
    }
  }, 60_000);

  it("persists an archive start while waiting for capacity and replays the cancelled task without another start", async () => {
    const env = await coreProcessingFixture({
      offline: true,
      analysisModel: false,
      configurationText: "[execution]\nmax_concurrency=1\n",
    });
    try {
      env.setParseHook(untilAborted);
      const first = await env.app.processingTasks!.submit({
        schema_version: 1,
        idempotency_key: "archive-start-owner",
        operations: [
          {
            operation: "parse-documents",
            request: { ...env.rawParseRequest, profiles: ["pipeline"] },
          },
        ],
      });
      await env.app.processingTasks!.start(first.job_id);
      await vi.waitFor(() => expect(env.parseCalls).toBe(1), {
        timeout: 20_000,
      });
      const request = {
        schema_version: 2,
        selector: {
          kind: "literatures",
          literature_ids: [env.parseRequest.literature_id],
        },
        mode: "full",
        from_step: null,
        idempotency_key: "archive-start-waiter",
      };
      const archive = await env.app.archive.build(request);
      expect(archive.members).toBe(1);
      expect(
        await env.app.processingTasks!.read(archive.job!.job_id),
      ).toMatchObject({
        job: { status: "queued" },
        start_requested: true,
      });
      expect(
        await env.app.jobs!.listAttempts(`${archive.job!.job_id}:0`),
      ).toEqual([]);
      await env.app.processingTasks!.control(archive.job!.job_id, "cancel");
      const events = await env.app.jobs!.listEvents(archive.job!.job_id);
      expect(await env.app.archive.build(request)).toMatchObject({
        job: { job_id: archive.job!.job_id, status: "cancelled" },
        members: 1,
      });
      expect(await env.app.jobs!.listEvents(archive.job!.job_id)).toEqual(
        events,
      );
      expect(env.modelCalls).toBe(0);
    } finally {
      await env.close();
    }
  });

  it("does not restore a waiting task while another Application owns the runtime", async () => {
    const env = await coreProcessingFixture({
      offline: true,
      analysisModel: false,
      configurationText: "[execution]\nmax_concurrency=1\n",
      restoreRequestedTasks: true,
    });
    let other: Awaited<ReturnType<typeof env.openAnother>> | undefined;
    try {
      env.setParseHook(untilAborted);
      const submit = (key: string) =>
        env.app.processingTasks!.submit({
          schema_version: 1,
          idempotency_key: key,
          operations: [
            {
              operation: "parse-documents",
              request: { ...env.rawParseRequest, profiles: ["pipeline"] },
            },
          ],
        });
      const first = await submit("live-start-owner");
      await env.app.processingTasks!.start(first.job_id);
      await vi.waitFor(() => expect(env.parseCalls).toBe(1), {
        timeout: 20_000,
      });
      const waiting = await submit("live-start-waiter");
      expect(await env.app.processingTasks!.start(waiting.job_id)).toBe(false);
      other = await env.openAnother();
      expect(other.executionRecovery).toBeNull();
      expect(await other.processingTasks!.read(waiting.job_id)).toMatchObject({
        job: { status: "queued" },
        start_requested: true,
      });
      expect(await other.jobs!.listAttempts(`${waiting.job_id}:0`)).toEqual([]);
      await other.close();
      expect(env.parseCalls).toBe(1);
      expect(await env.app.jobs!.listAttempts(`${waiting.job_id}:0`)).toEqual(
        [],
      );
    } finally {
      await other?.close();
      await env.close();
    }
  });
});
