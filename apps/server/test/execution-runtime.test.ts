import { describe, expect, it } from "vitest";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  SCHEMA_V2_FINGERPRINT,
  SCHEMA_V2_MANIFEST,
} from "../src/storage/sqlite/schema-v2.js";
import { createApplication } from "../src/bootstrap/application.js";
import { ExecutionTaskService } from "../src/application/jobs/service.js";
import { DatabaseCompletionService } from "../src/entry/database-completion.js";
import { WriteAdmissionError } from "../src/storage/write-admission.js";
import {
  authorizeExecutionSchema,
  MigrationSafetyError,
  probeCatalogIdentity,
  requireIdentifiableCatalog,
  SYNTHETIC_CATALOG_KIND,
  SYNTHETIC_CATALOG_MARKER_FILE,
  SYNTHETIC_CATALOG_MARKER_VERSION,
  SYNTHETIC_CATALOG_PRODUCT,
  type MigrationSafetyCode,
} from "../src/storage/execution/migration-gate.js";

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

const markerDocument = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    product: SYNTHETIC_CATALOG_PRODUCT,
    kind: SYNTHETIC_CATALOG_KIND,
    marker_version: SYNTHETIC_CATALOG_MARKER_VERSION,
    ...overrides,
  });

async function refusal(
  operation: Promise<unknown>,
): Promise<MigrationSafetyCode> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof MigrationSafetyError) return error.code;
    throw error;
  }
  throw new Error("expected the migration safety gate to refuse");
}

async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function createV1Catalog(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const database = new SqliteWorker(path);
  try {
    await database.schema();
  } finally {
    await database.close();
  }
}

async function driftCatalogIdentity(path: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(path);
  try {
    database
      .prepare(
        "UPDATE schema_identity SET schema_fingerprint=? WHERE singleton=1",
      )
      .run("0".repeat(64));
  } finally {
    database.close();
  }
}

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

describe("synthetic-only migration gate", () => {
  it("refuses the production catalog location even when a marker is present", async () => {
    const userHome = await mkdtemp(join(tmpdir(), "sciretriever-gate-home-"));
    const configurationHome = join(userHome, ".sciretriever");
    const production = join(configurationHome, "catalog.sqlite");
    await mkdir(configurationHome, { recursive: true });
    await writeFile(
      join(configurationHome, SYNTHETIC_CATALOG_MARKER_FILE),
      markerDocument(),
    );
    try {
      expect(
        await refusal(
          authorizeExecutionSchema("upgrade-synthetic", {
            catalog_path: production,
            scope: { user_home: userHome },
          }),
        ),
      ).toBe("migration-target-production");
      expect(
        await refusal(
          authorizeExecutionSchema("upgrade-synthetic", {
            catalog_path: join(userHome, "catalog.sqlite"),
            scope: { user_home: userHome },
          }),
        ),
      ).toBe("migration-target-production");
      expect(existsSync(production)).toBe(false);
      expect(existsSync(join(userHome, "catalog.sqlite"))).toBe(false);
    } finally {
      await rm(userHome, { recursive: true, force: true });
    }
  });

  it("separates unverified targets from malformed, declared and isolated copies", async () => {
    const userHome = await mkdtemp(join(tmpdir(), "sciretriever-gate-user-"));
    const isolated = await mkdtemp(join(tmpdir(), "sciretriever-gate-area-"));
    const copy = await mkdtemp(join(tmpdir(), "sciretriever-gate-copy-"));
    const markerPath = join(copy, SYNTHETIC_CATALOG_MARKER_FILE);
    const catalog = join(copy, "catalog.sqlite");
    const scope = { user_home: userHome, isolated_root: isolated };
    await mkdir(join(isolated, "copies"), { recursive: true });
    try {
      expect(
        await refusal(
          authorizeExecutionSchema("upgrade-synthetic", {
            catalog_path: catalog,
            scope,
          }),
        ),
      ).toBe("migration-target-unverified");
      expect(existsSync(catalog)).toBe(false);

      await writeFile(markerPath, markerDocument({ product: "other-product" }));
      expect(
        await refusal(
          authorizeExecutionSchema("upgrade-synthetic", {
            catalog_path: catalog,
            scope,
          }),
        ),
      ).toBe("migration-marker-invalid");
      await writeFile(markerPath, markerDocument({ marker_version: 2 }));
      expect(
        await refusal(
          authorizeExecutionSchema("upgrade-synthetic", {
            catalog_path: catalog,
            scope,
          }),
        ),
      ).toBe("migration-marker-invalid");
      await writeFile(markerPath, markerDocument({ extra: true }));
      expect(
        await refusal(
          authorizeExecutionSchema("upgrade-synthetic", {
            catalog_path: catalog,
            scope,
          }),
        ),
      ).toBe("migration-marker-invalid");
      await writeFile(markerPath, "not json");
      expect(
        await refusal(
          authorizeExecutionSchema("upgrade-synthetic", {
            catalog_path: catalog,
            scope,
          }),
        ),
      ).toBe("migration-marker-invalid");
      expect(existsSync(catalog)).toBe(false);

      await writeFile(markerPath, markerDocument());
      await expect(
        authorizeExecutionSchema("upgrade-synthetic", {
          catalog_path: catalog,
          scope,
        }),
      ).resolves.toMatchObject({
        mode: "upgrade-synthetic",
        basis: "marker",
        identity: { state: "absent" },
      });
      expect(existsSync(catalog)).toBe(false);
      await expect(
        authorizeExecutionSchema("upgrade-synthetic", {
          catalog_path: join(isolated, "copies", "catalog.sqlite"),
          scope,
        }),
      ).resolves.toMatchObject({
        basis: "isolated-temp",
        identity: { state: "absent" },
      });
    } finally {
      await Promise.all(
        [userHome, isolated, copy].map((path) =>
          rm(path, { recursive: true, force: true }),
        ),
      );
    }
  });

  it("keeps the identity probe read-only for v1, v2, drifted and foreign targets", async () => {
    const userHome = await mkdtemp(join(tmpdir(), "sciretriever-gate-user2-"));
    const isolated = await mkdtemp(join(tmpdir(), "sciretriever-gate-area2-"));
    const copy = join(isolated, "copy");
    const catalog = join(copy, "catalog.sqlite");
    const scope = { user_home: userHome, isolated_root: isolated };
    const drifted = join(isolated, "drifted", "catalog.sqlite");
    const junk = join(isolated, "junk", "catalog.sqlite");
    await mkdir(copy, { recursive: true });
    await mkdir(dirname(drifted), { recursive: true });
    await mkdir(dirname(junk), { recursive: true });
    try {
      expect(await refusal(requireIdentifiableCatalog(catalog))).toBe(
        "migration-target-missing",
      );
      expect(existsSync(catalog)).toBe(false);

      await createV1Catalog(catalog);
      await expect(
        authorizeExecutionSchema("upgrade-synthetic", {
          catalog_path: catalog,
          scope,
        }),
      ).resolves.toMatchObject({
        basis: "isolated-temp",
        identity: { state: "v1" },
      });
      expect(
        await refusal(
          authorizeExecutionSchema("require-v2", { catalog_path: catalog }),
        ),
      ).toBe("migration-target-v1");
      const v1Digest = await digest(catalog);
      await expect(requireIdentifiableCatalog(catalog)).resolves.toMatchObject({
        state: "v1",
        migration_receipts: 0,
        execution_tables: [],
      });
      expect(await digest(catalog)).toBe(v1Digest);

      const database = new SqliteWorker(catalog);
      try {
        await database.upgradeExecutionSchema();
      } finally {
        await database.close();
      }
      const v2Digest = await digest(catalog);
      await expect(requireIdentifiableCatalog(catalog)).resolves.toMatchObject({
        state: "v2",
        schema_fingerprint: SCHEMA_V2_FINGERPRINT,
        migration_receipts: 1,
      });
      expect(await digest(catalog)).toBe(v2Digest);
      await expect(
        authorizeExecutionSchema("require-v2", { catalog_path: catalog }),
      ).resolves.toMatchObject({
        mode: "require-v2",
        basis: null,
        identity: { state: "v2" },
      });
      expect(await digest(catalog)).toBe(v2Digest);

      await createV1Catalog(drifted);
      await driftCatalogIdentity(drifted);
      const driftedDigest = await digest(drifted);
      expect(
        await refusal(
          authorizeExecutionSchema("upgrade-synthetic", {
            catalog_path: drifted,
            scope,
          }),
        ),
      ).toBe("migration-target-drifted");
      expect(
        await refusal(
          authorizeExecutionSchema("require-v2", { catalog_path: drifted }),
        ),
      ).toBe("migration-target-drifted");
      expect(await refusal(requireIdentifiableCatalog(drifted))).toBe(
        "migration-target-drifted",
      );
      expect(await digest(drifted)).toBe(driftedDigest);

      await writeFile(junk, "not a catalog");
      const junkDigest = await digest(junk);
      expect(
        await refusal(
          authorizeExecutionSchema("upgrade-synthetic", {
            catalog_path: junk,
            scope,
          }),
        ),
      ).toBe("migration-target-unknown");
      expect(await refusal(requireIdentifiableCatalog(junk))).toBe(
        "migration-target-unknown",
      );
      expect(await digest(junk)).toBe(junkDigest);
    } finally {
      await Promise.all(
        [userHome, isolated].map((path) =>
          rm(path, { recursive: true, force: true }),
        ),
      );
    }
  });

  it("gates the assembled application so no route upgrades an unverified target", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-gate-assembly-"));
    const catalog = join(home, "catalog.sqlite");
    const driftedHome = await mkdtemp(
      join(tmpdir(), "sciretriever-gate-drift-"),
    );
    const driftedCatalog = join(driftedHome, "catalog.sqlite");
    try {
      const v1 = await createApplication(home);
      try {
        await v1.database.schema();
      } finally {
        await v1.close();
      }
      expect(
        await refusal(
          createApplication(home, { executionSchema: "require-v2" }),
        ),
      ).toBe("migration-target-v1");
      await expect(probeCatalogIdentity(catalog)).resolves.toMatchObject({
        state: "v1",
        execution_tables: [],
      });

      const migrated = await createApplication(home, {
        executionSchema: "upgrade-synthetic",
      });
      await expect(
        migrated.database.inspectExecutionRuntime(),
      ).resolves.toMatchObject({ catalog_version: 2, migrated: true });
      await migrated.close();
      await expect(probeCatalogIdentity(catalog)).resolves.toMatchObject({
        state: "v2",
        migration_receipts: 1,
      });

      const repeated = await createApplication(home, {
        executionSchema: "upgrade-synthetic",
      });
      await repeated.close();
      await expect(probeCatalogIdentity(catalog)).resolves.toMatchObject({
        state: "v2",
        migration_receipts: 1,
      });

      const readOnly = await createApplication(home, {
        executionSchema: "require-v2",
      });
      try {
        await expect(
          readOnly.database.inspectExecutionRuntime(),
        ).resolves.toMatchObject({ migrated: true });
      } finally {
        await readOnly.close();
      }

      await createV1Catalog(driftedCatalog);
      await driftCatalogIdentity(driftedCatalog);
      const driftedDigest = await digest(driftedCatalog);
      expect(
        await refusal(
          createApplication(driftedHome, {
            executionSchema: "upgrade-synthetic",
          }),
        ),
      ).toBe("migration-target-drifted");
      expect(await digest(driftedCatalog)).toBe(driftedDigest);
      await expect(probeCatalogIdentity(driftedCatalog)).resolves.toMatchObject(
        { state: "drifted" },
      );
    } finally {
      await Promise.all(
        [home, driftedHome].map((path) =>
          rm(path, { recursive: true, force: true }),
        ),
      );
    }
  });
});

describe("durable jobs use the shared completion target unit", () => {
  it("keeps a shared-dependency failure durable instead of turning it into an intervention", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-job-completion-"));
    const application = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    try {
      await application.database.putLiterature(literature);
      const createJob = (key: string) =>
        application.jobService!.create({
          target_kind: "selector",
          selector: {
            kind: "literatures",
            literature_ids: [literature.literature_id],
          },
          goal: "content",
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
          failure: { code: "content-completion-unavailable" },
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
