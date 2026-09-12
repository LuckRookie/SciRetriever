import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExecutionQueue,
  QueueRetryableError,
} from "../src/application/jobs/service.js";
import { InterventionService } from "../src/application/jobs/interventions.js";
import { ExecutionRepository } from "../src/storage/execution/repository.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";

async function environment(mode: "never" | "notify" | "pause", attempts = 3) {
  const root = await mkdtemp(
    join(tmpdir(), "sciretriever-execution-recovery-"),
  );
  const path = join(root, "catalog.sqlite");
  const database = new SqliteWorker(path);
  await database.upgradeExecutionSchema();
  const repository = new ExecutionRepository(database);
  const job = await repository.createJob({
    job_id: `job-${mode}`,
    target_kind: "selector",
    selector: { status: "UNREVIEWED" },
    policy_version: `policy-${mode}`,
    policy: {
      mode,
      max_retries: 2,
      max_attempts: attempts,
      intervention_timeout_ms: 1000,
    },
    idempotency_key: `idempotency-${mode}`,
    created_at: "2026-09-11T00:00:00.000Z",
  });
  await repository.putTarget({
    target_id: `target-${mode}`,
    job_id: job.job_id,
    ordinal: 0,
    literature_id: null,
    version_role: null,
    stage: "queued",
    disposition: "pending",
    next_eligible_at: null,
  });
  return { root, path, database, repository, job };
}

const failure = {
  code: "access-needs-operator",
  reason: "The bounded automatic route cannot continue.",
  action: "Review the current page before deciding whether to continue.",
  retryable: true,
};

describe("persistent execution recovery", () => {
  it("does not reset the frozen attempt budget after restart", async () => {
    const env = await environment("never", 1);
    try {
      const first = new ExecutionQueue(env.repository);
      await expect(
        first.runNext(
          env.job.job_id,
          async () => {
            throw new QueueRetryableError();
          },
          { now: "2026-09-11T00:00:01.000Z" },
        ),
      ).resolves.toMatchObject({ outcome: "failed" });
      expect(await env.repository.getBudget(env.job.job_id)).toMatchObject({
        attempts: 1,
        max_attempts: 1,
      });
      await env.database.close();

      const reopened = new SqliteWorker(env.path);
      const repository = new ExecutionRepository(reopened);
      const queue = new ExecutionQueue(repository);
      await expect(
        queue.runNext(env.job.job_id, async () => "completed", {
          now: "9999-01-01T00:00:00.000Z",
        }),
      ).resolves.toMatchObject({
        outcome: "skipped",
        failure: { code: "execution-budget-exhausted" },
      });
      expect(await repository.getBudget(env.job.job_id)).toMatchObject({
        attempts: 1,
      });
      expect(await repository.getJob(env.job.job_id)).toMatchObject({
        status: "completed",
      });
      await reopened.close();
    } finally {
      await env.database.close();
      await rm(env.root, { recursive: true, force: true });
    }
  });

  it("applies never, notify and pause without inventing an entitlement result", async () => {
    for (const mode of ["never", "notify", "pause"] as const) {
      const env = await environment(mode);
      try {
        const service = new InterventionService(env.repository);
        const intervention = await service.request({
          job_id: env.job.job_id,
          target_id: `target-${mode}`,
          failure,
          created_at: "2026-09-11T00:00:00.000Z",
        });
        expect(intervention.status).toBe(
          mode === "never" ? "declined" : "open",
        );
        expect(intervention.failure.code).toBe("access-needs-operator");
        expect((await env.repository.getJob(env.job.job_id))?.status).toBe(
          mode === "pause" ? "paused" : "queued",
        );
        if (mode === "pause") {
          await service.resolve(
            intervention.intervention_id,
            "continue",
            "2026-09-11T00:00:00.500Z",
          );
          expect((await env.repository.getJob(env.job.job_id))?.status).toBe(
            "queued",
          );
        }
      } finally {
        await env.database.close();
        await rm(env.root, { recursive: true, force: true });
      }
    }
  });

  it("invalidates old leases and expires open assistance on a new boot", async () => {
    const env = await environment("notify");
    try {
      const service = new InterventionService(env.repository);
      const intervention = await service.request({
        job_id: env.job.job_id,
        target_id: "target-notify",
        failure,
        created_at: "2026-09-11T00:00:00.000Z",
      });
      await env.repository.acquireLease({
        lease_id: "lease-old-boot",
        job_id: env.job.job_id,
        workspace_id: "profile-main",
        boot_id: "boot-old",
        control_epoch: 2,
        acquired_at: "2026-09-11T00:00:00.000Z",
        released_at: null,
      });
      await expect(
        env.repository.recover("boot-new", "2026-09-11T00:00:02.000Z"),
      ).resolves.toMatchObject({
        released_leases: 1,
        expired_interventions: 1,
      });
      expect(await env.repository.listInterventions(env.job.job_id)).toEqual([
        expect.objectContaining({
          intervention_id: intervention.intervention_id,
          status: "expired",
        }),
      ]);
      await expect(
        env.repository.acquireLease({
          lease_id: "lease-new-boot",
          job_id: env.job.job_id,
          workspace_id: "profile-main",
          boot_id: "boot-new",
          control_epoch: 0,
          acquired_at: "2026-09-11T00:00:02.000Z",
          released_at: null,
        }),
      ).resolves.toMatchObject({ boot_id: "boot-new" });
    } finally {
      await env.database.close();
      await rm(env.root, { recursive: true, force: true });
    }
  });
});
