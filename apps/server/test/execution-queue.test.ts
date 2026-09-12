import { describe, expect, it, vi } from "vitest";
import {
  ExecutionQueue,
  ExecutionScheduler,
  QueueRetryableError,
} from "../src/application/jobs/service.js";
import { ExecutionRepository } from "../src/storage/execution/repository.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";

async function setup() {
  const database = new SqliteWorker();
  await database.upgradeExecutionSchema();
  const repository = new ExecutionRepository(database);
  const queue = new ExecutionQueue(repository);
  const job = await repository.createJob({
    job_id: "job-queue-test",
    target_kind: "selector",
    selector: { status: "UNREVIEWED" },
    policy_version: "policy-queue-test",
    policy: { mode: "never", max_retries: 1 },
    idempotency_key: "idempotency-queue-test",
    created_at: "2026-09-11T00:00:00.000Z",
  });
  await repository.putTarget({
    target_id: "target-queue-test",
    job_id: job.job_id,
    ordinal: 0,
    literature_id: null,
    version_role: null,
    stage: "queued",
    disposition: "pending",
    next_eligible_at: null,
  });
  return { database, repository, queue, job };
}

describe("execution queue recovery semantics", () => {
  it("persists a retryable failure and completes the job on the next bounded attempt", async () => {
    const env = await setup();
    try {
      let calls = 0;
      const handler = async () => {
        calls += 1;
        if (calls === 1) throw new QueueRetryableError();
        return "completed" as const;
      };
      await expect(
        env.queue.runNext(env.job.job_id, handler, {
          max_retries: 1,
          retry_delay_ms: 0,
          now: "2026-09-11T00:00:01.000Z",
        }),
      ).resolves.toMatchObject({ outcome: "failed" });
      await expect(
        env.repository.getTarget("target-queue-test"),
      ).resolves.toMatchObject({
        stage: "queued",
        disposition: "pending",
      });
      await expect(
        env.queue.runNext(env.job.job_id, handler, {
          max_retries: 1,
          now: "9999-01-01T00:00:00.000Z",
        }),
      ).resolves.toMatchObject({ outcome: "completed" });
      await expect(
        env.repository.getJob(env.job.job_id),
      ).resolves.toMatchObject({
        status: "completed",
      });
      expect(calls).toBe(2);
    } finally {
      await env.database.close();
    }
  });

  it("marks running attempts outcome-unknown during boot recovery", async () => {
    const env = await setup();
    try {
      await env.repository.updateJob(env.job.job_id, "running");
      await env.repository.updateTarget(
        "target-queue-test",
        "acquisition",
        "pending",
      );
      await env.repository.startAttempt({
        attempt_id: "attempt-recovery",
        target_id: "target-queue-test",
        stage: "acquisition",
        status: "running",
        started_at: "2026-09-11T00:00:01.000Z",
        finished_at: null,
        failure: null,
        usage: { bytes: 7 },
      });
      await expect(
        env.repository.recover("boot-after-crash", "2026-09-11T00:01:00.000Z"),
      ).resolves.toMatchObject({
        recovered_attempts: 1,
        recovered_targets: 1,
        recovered_jobs: 1,
      });
      await expect(
        env.repository.listAttempts("target-queue-test"),
      ).resolves.toMatchObject([
        { status: "unknown", failure: { code: "execution-outcome-unknown" } },
      ]);
      await expect(
        env.repository.getTarget("target-queue-test"),
      ).resolves.toMatchObject({
        stage: "interrupted",
        disposition: "interrupted",
      });
      await expect(
        env.repository.getJob(env.job.job_id),
      ).resolves.toMatchObject({
        status: "interrupted",
      });
    } finally {
      await env.database.close();
    }
  });

  it("fences two jobs using the same Browser workspace", async () => {
    const first = await setup();
    try {
      // The two independent in-memory databases cannot share a lease; this assertion
      // exercises the repository-level fencing contract in one database below.
      await first.repository.createJob({
        job_id: "job-queue-second",
        target_kind: "selector",
        selector: {},
        policy_version: "policy-queue-second",
        policy: {},
        idempotency_key: "idempotency-queue-second",
      });
      await first.repository.putTarget({
        target_id: "target-queue-second",
        job_id: "job-queue-second",
        ordinal: 0,
        literature_id: null,
        version_role: null,
        stage: "queued",
        disposition: "pending",
        next_eligible_at: null,
      });
      let startedResolve!: () => void;
      const started = new Promise<void>((resolve) => {
        startedResolve = resolve;
      });
      const gate = new Promise<void>((resolve) => setTimeout(resolve, 20));
      const firstRun = first.queue.runNext(
        first.job.job_id,
        async () => {
          startedResolve();
          await gate;
          return "completed";
        },
        { workspace_id: "browser-workspace" },
      );
      await started;
      await expect(
        first.queue.runNext("job-queue-second", async () => "completed", {
          workspace_id: "browser-workspace",
        }),
      ).rejects.toBeDefined();
      await firstRun;
    } finally {
      await first.database.close();
    }
  });

  it("runs independent Browser workspaces concurrently within a process bound", async () => {
    const env = await setup();
    try {
      await env.repository.createJob({
        job_id: "job-queue-independent",
        target_kind: "selector",
        selector: {},
        policy_version: "policy-queue-independent",
        policy: {},
        idempotency_key: "idempotency-queue-independent",
      });
      await env.repository.putTarget({
        target_id: "target-queue-independent",
        job_id: "job-queue-independent",
        ordinal: 0,
        literature_id: null,
        version_role: null,
        stage: "queued",
        disposition: "pending",
        next_eligible_at: null,
      });
      const scheduler = new ExecutionScheduler(env.queue, 2);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = 0;
      const first = scheduler.run(
        env.job.job_id,
        async () => {
          started += 1;
          await gate;
          return "completed";
        },
        { workspace_id: "workspace-a" },
      );
      const second = scheduler.run(
        "job-queue-independent",
        async () => {
          started += 1;
          await gate;
          return "completed";
        },
        { workspace_id: "workspace-b" },
      );
      await vi.waitFor(() => expect(started).toBe(2));
      expect(scheduler.activeWorkspaces()).toEqual([
        "workspace-a",
        "workspace-b",
      ]);
      await expect(
        scheduler.run(env.job.job_id, async () => "completed", {
          workspace_id: "workspace-a",
        }),
      ).rejects.toMatchObject({
        reason: "workspace-busy",
      });
      release();
      await Promise.all([first, second]);
      expect(scheduler.activeWorkspaces()).toEqual([]);
    } finally {
      await env.database.close();
    }
  });
});
