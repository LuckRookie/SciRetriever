import { describe, expect, it } from "vitest";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../src/bootstrap/application.js";
import { ExecutionTaskService } from "../src/application/jobs/service.js";
import { DatabaseCompletionService } from "../src/entry/database-completion.js";
import { WriteAdmissionError } from "../src/storage/write-admission.js";

const literature = {
  literature_id: "00000000-0000-0000-0000-000000000901" as never,
  meta_literature_id: "00000000-0000-0000-0000-000000000902" as never,
  version_role: "published" as const,
  status: "UNREVIEWED" as const,
  metadata: {
    title: "Runtime fixture",
    authors: [],
    abstract: null,
    publication_date: null,
    publication_year: 2026,
    publication_form: "journal-article" as const,
    article_kind: null,
    language: "en",
    venue: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    identifiers: [],
    keywords: [],
  },
};

const policy = {
  mode: "notify" as const,
  max_retries: 2,
  max_attempts: 20,
  max_network_bytes: 1_000_000,
  max_model_calls: 20,
  intervention_timeout_ms: 60_000,
};

describe("durable execution runtime", () => {
  it("initializes the current runtime and persists bounded job state", async () => {
    const database = new SqliteWorker();
    try {
      await database.schema();
      await expect(database.inspectExecutionRuntime()).resolves.toMatchObject({
        migrated: true,
      });

      await expect(database.inspectExecutionRuntime()).resolves.toMatchObject({
        migrated: true,
        counts: { execution_jobs: 0, execution_events: 0 },
      });
      await database.putLiterature(literature);
      const job = await database.createExecutionJob(
        {
          job_id: "job-runtime-1",
          target_kind: "literature",
          selector: { literature_id: literature.literature_id },
          policy_version: "policy-1",
          status: "queued",
          idempotency_key: "idempotency-runtime-1",
          created_at: "2026-09-11T00:00:00.000Z",
          finished_at: null,
        },
        "a".repeat(64),
        policy,
      );
      expect(job.status).toBe("queued");
      await expect(
        database.createExecutionJob(job, "a".repeat(64), {
          ...policy,
        }),
      ).resolves.toMatchObject({ job_id: job.job_id });
      await expect(
        database.createExecutionJob(
          { ...job, job_id: "job-runtime-idempotent-retry" },
          "a".repeat(64),
          policy,
        ),
      ).resolves.toMatchObject({ job_id: job.job_id });
      await database.putExecutionTarget({
        target_id: "target-runtime-1",
        job_id: job.job_id,
        ordinal: 0,
        literature_id: literature.literature_id,
        version_role: "published",
        stage: "queued",
        disposition: "pending",
        next_eligible_at: null,
      });
      const claimed = await database.claimExecutionTarget(
        job.job_id,
        "2026-09-11T00:00:01.000Z",
      );
      expect(claimed).toMatchObject({ stage: "acquisition" });
      expect(
        await database.claimExecutionTarget(
          job.job_id,
          "2026-09-11T00:00:01.000Z",
        ),
      ).toBeNull();
      await database.startExecutionAttempt({
        attempt_id: "attempt-runtime-1",
        target_id: "target-runtime-1",
        stage: "acquisition",
        status: "running",
        started_at: "2026-09-11T00:00:02.000Z",
        finished_at: null,
        failure: null,
        usage: { bytes: 0 },
      });
      await database.finishExecutionAttempt(
        "attempt-runtime-1",
        "completed",
        "2026-09-11T00:00:03.000Z",
        null,
        { bytes: 123 },
      );
      await database.appendExecutionEvent({
        event_id: "event-runtime-1",
        job_id: job.job_id,
        sequence: 0,
        kind: "target-claimed",
        payload: { target_id: "target-runtime-1" },
        created_at: "2026-09-11T00:00:01.000Z",
      });
      await expect(
        database.appendExecutionEvent({
          event_id: "event-runtime-gap",
          job_id: job.job_id,
          sequence: 2,
          kind: "gap",
          payload: {},
          created_at: "2026-09-11T00:00:02.000Z",
        }),
      ).rejects.toBeDefined();
      expect(await database.listExecutionEvents(job.job_id)).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it("fences concurrent leases and releases them explicitly", async () => {
    const database = new SqliteWorker();
    try {
      await database.createExecutionJob(
        {
          job_id: "job-runtime-lease",
          target_kind: "selector",
          selector: { status: "UNREVIEWED" },
          policy_version: "policy-lease",
          status: "queued",
          idempotency_key: "idempotency-runtime-lease",
          created_at: "2026-09-11T00:00:00.000Z",
          finished_at: null,
        },
        "b".repeat(64),
        { ...policy, mode: "never" },
      );
      await database.acquireExecutionLease({
        lease_id: "lease-runtime-1",
        job_id: "job-runtime-lease",
        workspace_id: "workspace-1",
        boot_id: "boot-1",
        control_epoch: 1,
        acquired_at: "2026-09-11T00:00:01.000Z",
        released_at: null,
      });
      await expect(
        database.acquireExecutionLease({
          lease_id: "lease-runtime-2",
          job_id: "job-runtime-lease",
          workspace_id: "workspace-1",
          boot_id: "boot-2",
          control_epoch: 2,
          acquired_at: "2026-09-11T00:00:02.000Z",
          released_at: null,
        }),
      ).rejects.toBeDefined();
      await database.releaseExecutionLease(
        "lease-runtime-1",
        "2026-09-11T00:00:03.000Z",
      );
      await expect(
        database.acquireExecutionLease({
          lease_id: "lease-runtime-2",
          job_id: "job-runtime-lease",
          workspace_id: "workspace-1",
          boot_id: "boot-2",
          control_epoch: 2,
          acquired_at: "2026-09-11T00:00:04.000Z",
          released_at: null,
        }),
      ).resolves.toMatchObject({ boot_id: "boot-2" });
    } finally {
      await database.close();
    }
  });
});

describe("durable jobs use the shared completion target unit", () => {
  it("keeps a shared-dependency failure durable instead of turning it into an intervention", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-job-completion-"));
    const application = await createApplication(home, {});
    try {
      await application.database.putLiterature(literature);
      const createJob = (key: string) =>
        application.jobService!.create({
          target_kind: "selector",
          selector: {
            kind: "literatures",
            literature_ids: [literature.literature_id],
          },
          goal: "parser",
          policy_version: `policy-${key}`,
          policy: {
            mode: "pause",
            max_retries: 0,
            max_attempts: 10,
            intervention_timeout_ms: 60_000,
          },
          idempotency_key: key,
        });

      const interventionJob = await createJob("t18-intervention");
      const withoutCompletion = new ExecutionTaskService(
        application.jobs!,
        application.queue!,
        application.interventions!,
        {
          completion: new DatabaseCompletionService({
            library: application.library,
            database: application.database,
            writes: application.writes,
            completion: null,
            acquisition: null,
          }),
        },
      );
      const paused = await withoutCompletion.runJob(interventionJob.job_id);
      // The stable failure comes from the shared Entry target unit.
      expect(paused).toMatchObject([
        {
          outcome: "interrupted",
          failure: { code: "parser-completion-unavailable" },
        },
      ]);
      expect(
        await application.jobs!.listInterventions(interventionJob.job_id),
      ).toHaveLength(1);

      const failureJob = await createJob("t18-storage-failure");
      const failing = new ExecutionTaskService(
        application.jobs!,
        application.queue!,
        application.interventions!,
        {
          completion: new DatabaseCompletionService({
            library: application.library,
            database: application.database,
            writes: application.writes,
            completion: {
              isReady: async () => false,
              complete: async () => {
                throw new WriteAdmissionError("write-admission-closed");
              },
            },
            acquisition: null,
          }),
        },
      );
      const failed = await failing.runJob(failureJob.job_id);
      expect(failed).toMatchObject([
        { outcome: "failed", failure: { code: "completion-storage-failed" } },
      ]);
      // A shared-dependency failure never becomes an operator intervention.
      expect(
        await application.jobs!.listInterventions(failureJob.job_id),
      ).toHaveLength(0);
      expect(await application.jobs!.getJob(failureJob.job_id)).toMatchObject({
        status: "failed",
      });
    } finally {
      await application.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
