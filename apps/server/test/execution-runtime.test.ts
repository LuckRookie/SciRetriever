import { describe, expect, it } from "vitest";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SCHEMA_V2_FINGERPRINT,
  SCHEMA_V2_MANIFEST,
} from "../src/storage/sqlite/schema-v2.js";

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
    document_type: "article",
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
  it("explicitly migrates an empty runtime and persists bounded job state", async () => {
    const database = new SqliteWorker();
    try {
      await database.schema();
      await expect(database.inspectExecutionRuntime()).resolves.toMatchObject({
        migrated: false,
      });
      await database.upgradeExecutionSchema();
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
      await database.upgradeExecutionSchema();
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

  it("records an auditable migration receipt and validates a consistent backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-runtime-"));
    const databasePath = join(root, "catalog.sqlite");
    const v1BackupPath = join(root, "catalog-v1.sqlite");
    const backupPath = join(root, "catalog-backup.sqlite");
    const rollbackBackupPath = join(root, "catalog-before-rollback.sqlite");
    const database = new SqliteWorker(databasePath);
    try {
      await database.schema();
      await database.putLiterature(literature);
      await database.backup(v1BackupPath);
      await expect(database.restoreCheck(v1BackupPath)).resolves.toMatchObject({
        integrity: "ok",
        schema_version: 1,
        runtime: { catalog_version: 1, migrated: false },
      });
      const preview = await database.migrateExecutionRuntime(true);
      expect(preview).toMatchObject({
        action: "dry-run",
        from_version: 1,
        to_version: 2,
        inspection: { catalog_version: 1, migrated: false },
      });
      expect(await database.inspectExecutionRuntime()).toMatchObject({
        migrated: false,
      });
      await database.upgradeExecutionSchema();
      await expect(database.schema()).resolves.toMatchObject({
        schema_version: 2,
        schema_fingerprint: SCHEMA_V2_FINGERPRINT,
      });
      await expect(
        database.getLiterature(literature.literature_id),
      ).resolves.toMatchObject({ metadata: { title: "Runtime fixture" } });
      const receipt = await database.migrateExecutionRuntime(false);
      expect(receipt).toMatchObject({
        action: "migrate",
        from_version: 1,
        to_version: 2,
        inspection: { catalog_version: 2, migrated: true },
      });
      await database.backup(backupPath);
      await expect(database.restoreCheck(backupPath)).resolves.toMatchObject({
        integrity: "ok",
        schema_version: 2,
        runtime: { catalog_version: 2, migrated: true },
      });
      expect(SCHEMA_V2_MANIFEST[0]).toContain("schema_version=2");
      expect(
        SCHEMA_V2_MANIFEST.some((sql) => sql.includes("execution_jobs")),
      ).toBe(true);
      await database.rollbackExecutionSchema(rollbackBackupPath);
      await expect(database.schema()).resolves.toMatchObject({
        schema_version: 1,
      });
      await expect(
        database.getLiterature(literature.literature_id),
      ).resolves.toMatchObject({ metadata: { title: "Runtime fixture" } });
      await expect(
        database.restoreCheck(rollbackBackupPath),
      ).resolves.toMatchObject({
        schema_version: 2,
        runtime: { migrated: true },
      });
    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
