import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseAsset,
  parseLiterature,
  parseLiteratureId,
  parseMetaLiteratureId,
  parseMetadataObservation,
  sha256,
  type DatabaseCompletionReport,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { runCli } from "../src/cli/main.js";
import { DatabaseCompletionService } from "../src/entry/database-completion.js";
import { ExecutionTaskService } from "../src/application/jobs/service.js";
import { WriteAdmissionError } from "../src/storage/write-admission.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import * as acquisitionAssembly from "../src/acquisition/assembly.js";
import { PublicAcquisitionRegistry } from "../src/acquisition/sources/public.js";
import { safeLocator } from "../src/acquisition/sources/locators.js";

const meta = parseMetaLiteratureId("00000000-0000-0000-0000-000000008100");
const first = parseLiteratureId("00000000-0000-0000-0000-000000008101");
const second = parseLiteratureId("00000000-0000-0000-0000-000000008102");
const later = parseLiteratureId("00000000-0000-0000-0000-000000008103");
const selector = {
  kind: "meta-literatures" as const,
  meta_literature_ids: [meta],
};
const literature = (id: string, role: "published" | "preprint") =>
  parseLiterature({
    ...FIXTURE_LITERATURE,
    literature_id: id,
    meta_literature_id: meta,
    version_role: role,
    metadata: {
      ...FIXTURE_LITERATURE.metadata,
      title: "Frozen maintenance fixture",
      identifiers: [],
    },
  });

async function seeded() {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-maintenance-operation-"),
  );
  const app = await createApplication(home, {
    executionSchema: "upgrade-synthetic",
  });
  await app.database.putLiterature(literature(first, "published"));
  await app.database.putLiterature(literature(second, "preprint"));
  return { home, app };
}

async function seededHttpCandidate(origin: string) {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-maintenance-http-candidate-"),
  );
  const app = await createApplication(home, {
    executionSchema: "upgrade-synthetic",
  });
  const published = parseLiterature({
    ...FIXTURE_LITERATURE,
    literature_id: first,
    meta_literature_id: meta,
    // This fixture tests address admission, not external identifier discovery.
    // Later routes now run after candidate rejection, so keep the fixture offline.
    metadata: { ...FIXTURE_LITERATURE.metadata, identifiers: [] },
  });
  await app.database.putLiterature(published);
  await app.observations.publish({
    ...parseMetadataObservation({
      observation_id: "00000000-0000-0000-0000-000000008111",
      provenance: {
        provenance_id: "00000000-0000-0000-0000-000000008112",
        source_kind: "metadata-provider",
        source_name: "fixture",
        source_record_id: "loopback-paper",
        observed_at: "2026-09-28T00:00:00Z",
        input_sha256: "a".repeat(64),
        parameters_sha256: null,
      },
      metadata: published.metadata,
      version_role: "published",
      version_links: [],
      asset_hints: [
        {
          url: `${origin}/paper.pdf`,
          kind: "direct-file",
          media_type: "application/pdf",
          asset_role: "primary-pdf",
          version_role: "published",
          access_status: "open",
          license: null,
        },
      ],
      reference_texts: [],
      declared_keywords: [],
      reference_count: 0,
      cited_by_count: 0,
    }),
    literature_id: first,
  });
  return { home, app };
}

async function seededPublished() {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-maintenance-published-"),
  );
  const app = await createApplication(home, {
    executionSchema: "upgrade-synthetic",
  });
  await app.database.putLiterature(
    parseLiterature({
      ...FIXTURE_LITERATURE,
      literature_id: first,
      meta_literature_id: meta,
    }),
  );
  return { home, app };
}

describe("explicit maintenance operation across Application, CLI and durable Jobs", () => {
  it("commits a valid PDF through the shared operation in CLI, Application and Jobs", async () => {
    const url = "https://fixture.example.test/paper.pdf";
    const bytes = workbenchPdf();
    let downloads = 0;
    const source = {
      source_name: "fixture-public",
      ready: true,
      acquisition_tier: "public" as const,
      async discover() {
        return [
          { ...safeLocator("fixture-public", url), source: "fixture-public" },
        ];
      },
      async download_candidate() {
        downloads++;
        return {
          kind: "download" as const,
          locator: {
            namespace: "doi",
            value: "10.5555/sciretriever.fixture",
            declared_media_type: "application/pdf" as const,
            source_record_id: "fixture-pdf",
          },
          bytes,
          media_type: "application/pdf",
          safe_source_url: url,
          entitlement: "granted" as const,
        };
      },
    };
    const assembly = vi
      .spyOn(acquisitionAssembly, "assemblePublicAcquisitionRegistry")
      .mockImplementation(
        () => new PublicAcquisitionRegistry([source], ["fixture-public"]),
      );
    const cli = await seededPublished();
    const direct = await seededPublished();
    const durable = await seededPublished();
    try {
      await cli.app.close();
      const cliResult = await runCli(
        ["complete", "pdf", "--meta-literature-id", meta],
        { home: cli.home },
      );
      const directReport = await direct.app.databaseCompletion!.run({
        selector,
        goal: "ASSET_READY",
      });
      const job = await durable.app.jobService!.create({
        target_kind: "selector",
        selector,
        goal: "pdf",
        policy_version: "maintenance-published",
        policy: { mode: "never" },
        idempotency_key: "maintenance-published",
      });
      const jobResults = await durable.app.taskService!.runJob(job.job_id);
      expect(cliResult.code).toBe(0);
      expect(cliResult.value).toMatchObject({
        completed: [{ literature_id: first }],
        end: { kind: "finished" },
      });
      expect(directReport).toMatchObject({
        completed: [{ literature_id: first }],
        end: { kind: "finished" },
      });
      expect(jobResults).toMatchObject([
        { outcome: "completed", failure: null },
      ]);
      expect(downloads).toBe(3);
      const reopened = await createApplication(cli.home, {
        executionSchema: "require-v2",
      });
      try {
        for (const app of [reopened, direct.app, durable.app]) {
          const pdf = (await app.library.detail(first)).primary_pdf;
          expect(pdf?.asset.sha256).toBe(await sha256(bytes));
          expect(pdf?.asset.size_bytes).toBe(bytes.length);
          expect(await app.database.hasAutomaticPdfExhaustion(first)).toBe(
            false,
          );
        }
      } finally {
        await reopened.close();
      }
      expect(await durable.app.jobs!.getJob(job.job_id)).toMatchObject({
        status: "completed",
      });
    } finally {
      assembly.mockRestore();
      await Promise.allSettled([direct.app.close(), durable.app.close()]);
      await Promise.all(
        [cli.home, direct.home, durable.home].map((home) =>
          rm(home, { recursive: true, force: true }),
        ),
      );
    }
  });

  it("preserves the public-address boundary and reports the same route failure in all three entrances", async () => {
    const origin = "https://127.0.0.1:9";
    const cli = await seededHttpCandidate(origin);
    const direct = await seededHttpCandidate(origin);
    const durable = await seededHttpCandidate(origin);
    try {
      await cli.app.close();
      const cliResult = await runCli(
        ["complete", "pdf", "--meta-literature-id", meta],
        { home: cli.home },
      );
      const directReport = await direct.app.databaseCompletion!.run({
        selector,
        goal: "ASSET_READY",
      });
      const job = await durable.app.jobService!.create({
        target_kind: "selector",
        selector,
        goal: "pdf",
        policy_version: "maintenance-network-failure",
        policy: { mode: "never" },
        idempotency_key: "maintenance-network-failure",
      });
      const jobResults = await durable.app.taskService!.runJob(job.job_id);
      // The operation settles with a failed target; only a shared/system
      // failure terminates the operation and produces CLI exit code 3.
      expect(cliResult.code).toBe(0);
      expect(cliResult.value).toMatchObject({
        failed: [
          {
            literature_id: first,
            failure: { code: "pdf-network-failed" },
          },
        ],
        end: { kind: "finished" },
      });
      expect(directReport).toMatchObject({
        failed: [
          {
            literature_id: first,
            failure: { code: "pdf-network-failed" },
          },
        ],
        end: { kind: "finished" },
      });
      expect(jobResults).toMatchObject([
        { outcome: "skipped", failure: { code: "pdf-network-failed" } },
      ]);
      const reopened = await createApplication(cli.home, {
        executionSchema: "require-v2",
      });
      try {
        for (const app of [reopened, direct.app, durable.app]) {
          expect((await app.library.detail(first)).primary_pdf).toBeNull();
          expect(await app.database.hasAutomaticPdfExhaustion(first)).toBe(
            false,
          );
        }
      } finally {
        await reopened.close();
      }
      expect(await durable.app.jobs!.getJob(job.job_id)).toMatchObject({
        status: "completed",
      });
      expect(
        await durable.app.jobs!.listInterventions(job.job_id),
      ).toMatchObject([
        {
          mode: "never",
          status: "declined",
          failure: { code: "pdf-network-failed" },
          resolution: { kind: "policy-declined" },
        },
      ]);
    } finally {
      await Promise.allSettled([direct.app.close(), durable.app.close()]);
      await Promise.all(
        [cli.home, direct.home, durable.home].map((home) =>
          rm(home, { recursive: true, force: true }),
        ),
      );
    }
  });

  it("freezes the same MetaLiterature request and maps normal exhaustion without expanding a read", async () => {
    const cli = await seeded();
    const direct = await seeded();
    const durable = await seeded();
    try {
      await cli.app.close();
      const read = await runCli(["literature", "search", "--text", "Frozen"], {
        home: cli.home,
      });
      expect(read.code).toBe(0);
      const before = await createApplication(cli.home, {
        executionSchema: "require-v2",
      });
      expect(await before.database.hasAutomaticPdfExhaustion(first)).toBe(
        false,
      );
      expect(await before.database.hasAutomaticPdfExhaustion(second)).toBe(
        false,
      );
      await before.close();

      const cliResult = await runCli(
        ["complete", "pdf", "--meta-literature-id", meta],
        { home: cli.home },
      );
      expect(cliResult.code).toBe(0);
      const cliReport = cliResult.value as DatabaseCompletionReport;
      const directReport = await direct.app.databaseCompletion!.run({
        selector,
        goal: "ASSET_READY",
      });
      const job = await durable.app.jobService!.create({
        target_kind: "selector",
        selector,
        goal: "pdf",
        policy_version: "maintenance-three-entry",
        policy: { mode: "never", max_attempts: 3, max_retries: 0 },
        idempotency_key: "maintenance-three-entry",
      });
      const rows = await durable.app.jobs!.listTargets(job.job_id);
      expect(rows).toHaveLength(1);
      expect(
        (job.selector as { frozen_targets: unknown[] }).frozen_targets,
      ).toHaveLength(1);
      const results = await durable.app.taskService!.runJob(job.job_id);
      expect(results).toMatchObject([
        { outcome: "skipped", failure: { code: "pdf-acquisition-required" } },
      ]);
      expect(await durable.app.jobs!.getJob(job.job_id)).toMatchObject({
        status: "completed",
      });
      expect(
        await durable.app.jobs!.listAttempts(rows[0]!.target_id),
      ).toHaveLength(1);
      expect((await durable.app.jobs!.getBudget(job.job_id))?.attempts).toBe(1);
      expect(
        (await durable.app.jobs!.listEvents(job.job_id)).map(
          (item) => item.kind,
        ),
      ).toEqual(["attempt-started", "attempt-skipped"]);
      for (const report of [cliReport, directReport]) {
        expect(report.end.kind).toBe("finished");
        expect(report.skipped).toMatchObject([
          {
            target: { kind: "meta-literature", meta_literature_id: meta },
            reason: "manual-pdf-required",
            literature_ids: [first, second],
          },
        ]);
        expect(report.completed).toEqual([]);
        expect(report.failed).toEqual([]);
      }
      const cliFacts = await createApplication(cli.home, {
        executionSchema: "require-v2",
      });
      try {
        for (const id of [first, second]) {
          expect(await cliFacts.database.hasAutomaticPdfExhaustion(id)).toBe(
            true,
          );
          expect(await direct.app.database.hasAutomaticPdfExhaustion(id)).toBe(
            true,
          );
          expect(await durable.app.database.hasAutomaticPdfExhaustion(id)).toBe(
            true,
          );
        }
      } finally {
        await cliFacts.close();
      }
    } finally {
      await Promise.allSettled([direct.app.close(), durable.app.close()]);
      await Promise.all(
        [cli.home, direct.home, durable.home].map((home) =>
          rm(home, { recursive: true, force: true }),
        ),
      );
    }
  });

  it("does not add a version inserted after durable target creation", async () => {
    const { home, app } = await seeded();
    try {
      const job = await app.jobService!.create({
        target_kind: "selector",
        selector,
        goal: "pdf",
        policy_version: "frozen-added-version",
        policy: { mode: "never" },
        idempotency_key: "frozen-added-version",
      });
      await app.database.putLiterature(literature(later, "preprint"));
      const repeated = await app.jobService!.create({
        target_kind: "selector",
        selector,
        goal: "pdf",
        policy_version: "frozen-added-version",
        policy: { mode: "never" },
        idempotency_key: "frozen-added-version",
      });
      expect(repeated.job_id).toBe(job.job_id);
      expect(repeated.selector).toEqual(job.selector);
      const frozen = (
        job.selector as { frozen_targets: { candidates: string[] }[] }
      ).frozen_targets;
      expect(frozen[0]?.candidates).toEqual([first, second]);
      await app.taskService!.runJob(job.job_id);
      expect(await app.database.hasAutomaticPdfExhaustion(first)).toBe(true);
      expect(await app.database.hasAutomaticPdfExhaustion(second)).toBe(true);
      expect(await app.database.hasAutomaticPdfExhaustion(later)).toBe(false);
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("bounds attempts and leaves pre-cancelled frozen targets without work", async () => {
    const { home, app } = await seeded();
    try {
      const makeJob = (key: string, policy: { max_attempts: number }) =>
        app.jobService!.create({
          target_kind: "selector",
          selector: { kind: "literatures", literature_ids: [first, second] },
          goal: "pdf",
          policy_version: key,
          policy: { mode: "never", ...policy },
          idempotency_key: key,
        });
      const cancelled = await makeJob("frozen-cancelled", { max_attempts: 2 });
      expect(
        await app.taskService!.runJob(cancelled.job_id, {
          signal: AbortSignal.abort(),
        }),
      ).toEqual([]);
      expect(await app.jobs!.getJob(cancelled.job_id)).toMatchObject({
        status: "interrupted",
      });
      expect((await app.jobs!.getBudget(cancelled.job_id))?.attempts).toBe(0);
      expect(await app.database.hasAutomaticPdfExhaustion(first)).toBe(false);

      const bounded = await makeJob("frozen-budget", { max_attempts: 1 });
      const results = await app.taskService!.runJob(bounded.job_id);
      expect(results).toMatchObject([
        { outcome: "skipped", failure: { code: "pdf-acquisition-required" } },
        { outcome: "skipped", failure: { code: "execution-budget-exhausted" } },
      ]);
      expect((await app.jobs!.getBudget(bounded.job_id))?.attempts).toBe(1);
      expect(await app.database.hasAutomaticPdfExhaustion(first)).toBe(true);
      expect(await app.database.hasAutomaticPdfExhaustion(second)).toBe(false);
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("applies durable pause before admitting the next completion chunk", async () => {
    const { home, app } = await seeded();
    try {
      await app.database.putLiterature(literature(later, "preprint"));
      const job = await app.jobService!.create({
        target_kind: "selector",
        selector: {
          kind: "literatures",
          literature_ids: [first, second, later],
        },
        goal: "pdf",
        policy_version: "frozen-pause-boundary",
        policy: { mode: "pause", max_retries: 0 },
        idempotency_key: "frozen-pause-boundary",
      });
      const called: string[] = [];
      const completion = new DatabaseCompletionService({
        library: app.library,
        database: app.database,
        writes: app.writes,
        completion: null,
        max_concurrency: 1,
        acquisition: {
          acquire: async ({ literature_id }) => {
            called.push(literature_id);
            return { kind: "exhausted" };
          },
        },
      });
      const service = new ExecutionTaskService(
        app.jobs!,
        app.queue!,
        app.interventions!,
        { completion },
      );
      expect(await service.runJob(job.job_id)).toMatchObject([
        {
          outcome: "interrupted",
          failure: { code: "pdf-acquisition-required" },
        },
      ]);
      expect(called).toEqual([first]);
      expect(await app.jobs!.getJob(job.job_id)).toMatchObject({
        status: "paused",
      });
      expect(await app.jobs!.listTargets(job.job_id)).toMatchObject([
        { stage: "queued" },
        { stage: "queued" },
        { stage: "queued" },
      ]);
      expect(await app.jobs!.listInterventions(job.job_id)).toHaveLength(1);
      const firstAttempt = (
        await app.jobs!.listAttempts(
          (await app.jobs!.listTargets(job.job_id))[0]!.target_id,
        )
      )[0]!;
      expect(firstAttempt).toMatchObject({
        status: "interrupted",
        failure: { code: "pdf-acquisition-required" },
      });
      expect(
        (await app.jobs!.listEvents(job.job_id)).map((event) => event.kind),
      ).toContain("attempt-paused-for-assistance");
      expect(await app.database.hasAutomaticPdfExhaustion(first)).toBe(true);
      expect(await app.database.hasAutomaticPdfExhaustion(second)).toBe(false);
      expect(await app.database.hasAutomaticPdfExhaustion(later)).toBe(false);
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each(["pause", "cancel"] as const)(
    "honors external %s during an active target without admitting the next target",
    async (control) => {
      const { home, app } = await seeded();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = 0;
      try {
        const job = await app.jobService!.create({
          target_kind: "selector",
          selector: { kind: "literatures", literature_ids: [first, second] },
          goal: "pdf",
          policy_version: `external-${control}`,
          policy: { mode: "pause", max_retries: 0 },
          idempotency_key: `external-${control}`,
        });
        const completion = new DatabaseCompletionService({
          library: app.library,
          database: app.database,
          writes: app.writes,
          completion: null,
          max_concurrency: 1,
          acquisition: {
            acquire: async () => {
              started++;
              await blocked;
              return { kind: "exhausted" };
            },
          },
        });
        const service = new ExecutionTaskService(
          app.jobs!,
          app.queue!,
          app.interventions!,
          { completion },
        );
        const pending = service.runJob(job.job_id);
        await vi.waitFor(() => expect(started).toBe(1));
        expect(await app.jobs!.getJob(job.job_id)).toMatchObject({
          status: "running",
        });
        const rows = await app.jobs!.listTargets(job.job_id);
        expect(await app.jobs!.listAttempts(rows[0]!.target_id)).toMatchObject([
          { status: "running" },
        ]);
        expect(
          (await app.jobs!.listEvents(job.job_id)).map((event) => event.kind),
        ).toContain("attempt-started");
        if (control === "pause") await app.queue!.pause(job.job_id);
        else await app.queue!.cancel(job.job_id);
        release();
        await pending;
        expect(await app.jobs!.getJob(job.job_id)).toMatchObject({
          status: control === "pause" ? "paused" : "cancelled",
        });
        expect(started).toBe(1);
        expect(await app.jobs!.listAttempts(rows[1]!.target_id)).toEqual([]);
        expect((await app.jobs!.getBudget(job.job_id))?.attempts).toBe(1);
        expect(await app.jobs!.listInterventions(job.job_id)).toEqual([]);
      } finally {
        release();
        await app.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it.each(["pause", "cancel"] as const)(
    "honors external %s between the first Job read and lease acquisition",
    async (control) => {
      const { home, app } = await seeded();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entering = false;
      let pending: Promise<readonly unknown[]> | null = null;
      try {
        const job = await app.jobService!.create({
          target_kind: "selector",
          selector: { kind: "literatures", literature_ids: [first, second] },
          goal: "pdf",
          policy_version: `before-lease-${control}`,
          policy: { mode: "never" },
          idempotency_key: `before-lease-${control}`,
        });
        const acquire = app.jobs!.acquireLease.bind(app.jobs!);
        vi.spyOn(app.jobs!, "acquireLease").mockImplementationOnce(
          async (lease) => {
            entering = true;
            await blocked;
            return acquire(lease);
          },
        );
        pending = app.taskService!.runJob(job.job_id);
        await vi.waitFor(() => expect(entering).toBe(true));
        if (control === "pause") await app.queue!.pause(job.job_id);
        else await app.queue!.cancel(job.job_id);
        release();
        expect(await pending).toEqual([]);
        expect(await app.jobs!.getJob(job.job_id)).toMatchObject({
          status: control === "pause" ? "paused" : "cancelled",
        });
        expect((await app.jobs!.getBudget(job.job_id))?.attempts).toBe(0);
        for (const row of await app.jobs!.listTargets(job.job_id))
          expect(await app.jobs!.listAttempts(row.target_id)).toEqual([]);
      } finally {
        release();
        if (pending) await Promise.allSettled([pending]);
        vi.restoreAllMocks();
        await app.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("keeps the stable retry event and interrupted failure for a durable target", async () => {
    const { home, app } = await seeded();
    try {
      const job = await app.jobService!.create({
        target_kind: "selector",
        selector: { kind: "literatures", literature_ids: [first] },
        goal: "pdf",
        policy_version: "retry-event",
        policy: { mode: "never", max_retries: 1 },
        idempotency_key: "retry-event",
      });
      const completion = new DatabaseCompletionService({
        library: app.library,
        database: app.database,
        writes: app.writes,
        completion: null,
        max_concurrency: 1,
        acquisition: { acquire: async () => ({ kind: "cancelled" }) },
      });
      const service = new ExecutionTaskService(
        app.jobs!,
        app.queue!,
        app.interventions!,
        { completion },
      );
      expect(await service.runJob(job.job_id)).toMatchObject([
        {
          outcome: "interrupted",
          failure: { code: "execution-interrupted", retryable: true },
        },
      ]);
      const row = (await app.jobs!.listTargets(job.job_id))[0]!;
      expect(row).toMatchObject({ stage: "queued", disposition: "pending" });
      expect(await app.jobs!.listAttempts(row.target_id)).toMatchObject([
        {
          status: "interrupted",
          failure: { code: "execution-interrupted", retryable: true },
        },
      ]);
      expect(
        (await app.jobs!.listEvents(job.job_id)).map((event) => event.kind),
      ).toEqual(["attempt-started", "attempt-retry-scheduled"]);
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not create an intervention after cancellation wins the settlement race", async () => {
    const { home, app } = await seeded();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entering = false;
    let pending: Promise<readonly unknown[]> | null = null;
    try {
      const job = await app.jobService!.create({
        target_kind: "selector",
        selector: { kind: "literatures", literature_ids: [first] },
        goal: "pdf",
        policy_version: "cancel-before-intervention",
        policy: { mode: "pause" },
        idempotency_key: "cancel-before-intervention",
      });
      const put = app.jobs!.putInterventionIfActive.bind(app.jobs!);
      vi.spyOn(app.jobs!, "putInterventionIfActive").mockImplementationOnce(
        async (intervention) => {
          entering = true;
          await blocked;
          return put(intervention);
        },
      );
      const completion = new DatabaseCompletionService({
        library: app.library,
        database: app.database,
        writes: app.writes,
        completion: null,
        max_concurrency: 1,
        acquisition: { acquire: async () => ({ kind: "exhausted" }) },
      });
      pending = new ExecutionTaskService(
        app.jobs!,
        app.queue!,
        app.interventions!,
        { completion },
      ).runJob(job.job_id);
      await vi.waitFor(() => expect(entering).toBe(true));
      await app.queue!.cancel(job.job_id);
      release();
      await pending;
      expect(await app.jobs!.listInterventions(job.job_id)).toEqual([]);
      expect(await app.jobs!.getJob(job.job_id)).toMatchObject({
        status: "cancelled",
      });
    } finally {
      release();
      if (pending) await Promise.allSettled([pending]);
      vi.restoreAllMocks();
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("preserves an in-flight success when another target pauses admission", async () => {
    const { home, app } = await seeded();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let secondStarted = false;
    let entered!: () => void;
    const secondEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      await app.database.putLiterature(literature(later, "preprint"));
      const job = await app.jobService!.create({
        target_kind: "selector",
        selector: {
          kind: "literatures",
          literature_ids: [first, second, later],
        },
        goal: "pdf",
        policy_version: "parallel-policy-pause",
        policy: { mode: "pause", max_retries: 0 },
        idempotency_key: "parallel-policy-pause",
      });
      const completion = new DatabaseCompletionService({
        library: app.library,
        database: app.database,
        writes: app.writes,
        completion: null,
        max_concurrency: 2,
        acquisition: {
          acquire: async (request) => {
            const literature_id = request.literature_id;
            if (literature_id === first) {
              await secondEntered;
              return { kind: "exhausted" };
            }
            expect(literature_id).toBe(second);
            secondStarted = true;
            entered();
            await blocked;
            expect(request.signal.aborted).toBe(false);
            const bytes = workbenchPdf();
            const staged = await app.files.stage({ maxBytes: bytes.length });
            await staged.write(bytes);
            const path = `objects/parallel-${literature_id}.pdf`;
            const asset = parseAsset({
              asset_id: randomUUID(),
              sha256: await sha256(bytes),
              size_bytes: bytes.length,
              media_type: "application/pdf",
              path,
            });
            await request.commit!(async () => {
              await app.files.publish(staged, path);
              await app.database.putLiteratureAsset({
                literature_asset_id: randomUUID(),
                literature_id,
                asset,
                role: "primary-pdf",
                source_url: null,
                provenance: {
                  provenance_id: randomUUID(),
                  source_kind: "asset-provider",
                  source_name: "parallel-test",
                  source_record_id: null,
                  observed_at: "2026-09-28T00:00:00Z",
                  input_sha256: asset.sha256,
                  parameters_sha256: null,
                },
              });
            });
            const acquired = {
              kind: "acquired",
              literature_id,
              receipt: {
                receipt_id: `parallel-${literature_id}`,
                literature_id,
                asset_id: asset.asset_id,
                sha256: asset.sha256,
                reference: asset.path,
                created: true,
              },
            } as const;
            return acquired;
          },
        },
      });
      const service = new ExecutionTaskService(
        app.jobs!,
        app.queue!,
        app.interventions!,
        { completion },
      );
      const pending = service.runJob(job.job_id);
      await vi.waitFor(() => expect(secondStarted).toBe(true));
      await vi.waitFor(async () =>
        expect((await app.jobs!.getJob(job.job_id))?.status).toBe("paused"),
      );
      release();
      expect(await pending).toMatchObject([
        {
          outcome: "interrupted",
          failure: { code: "pdf-acquisition-required" },
        },
        { outcome: "completed", failure: null },
      ]);
      const rows = await app.jobs!.listTargets(job.job_id);
      expect(rows).toMatchObject([
        { stage: "queued" },
        { stage: "completed" },
        { stage: "queued" },
      ]);
      expect(await app.jobs!.listAttempts(rows[2]!.target_id)).toEqual([]);
      expect((await app.jobs!.getBudget(job.job_id))?.attempts).toBe(2);
      expect(await app.library.detail(second)).toMatchObject({
        primary_pdf: { asset: { sha256: await sha256(workbenchPdf()) } },
      });
    } finally {
      release();
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("drains in-flight durable targets after cancellation without recording exhaustion", async () => {
    const { home, app } = await seeded();
    const stop = new AbortController();
    let started = 0;
    try {
      const job = await app.jobService!.create({
        target_kind: "selector",
        selector: { kind: "literatures", literature_ids: [first, second] },
        goal: "pdf",
        policy_version: "frozen-in-flight-cancel",
        policy: { mode: "never", max_retries: 0 },
        idempotency_key: "frozen-in-flight-cancel",
      });
      const completion = new DatabaseCompletionService({
        library: app.library,
        database: app.database,
        writes: app.writes,
        completion: null,
        max_concurrency: 2,
        acquisition: {
          acquire: async ({ signal }) => {
            started++;
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
            });
            return { kind: "cancelled" };
          },
        },
      });
      const service = new ExecutionTaskService(
        app.jobs!,
        app.queue!,
        app.interventions!,
        { completion },
      );
      const pending = service.runJob(job.job_id, { signal: stop.signal });
      await vi.waitFor(() => expect(started).toBe(2));
      stop.abort();
      expect(await pending).toMatchObject([
        { outcome: "interrupted" },
        { outcome: "interrupted" },
      ]);
      expect(await app.jobs!.getJob(job.job_id)).toMatchObject({
        status: "interrupted",
      });
      for (const row of await app.jobs!.listTargets(job.job_id))
        expect(await app.jobs!.listAttempts(row.target_id)).toHaveLength(1);
      expect(await app.database.hasAutomaticPdfExhaustion(first)).toBe(false);
      expect(await app.database.hasAutomaticPdfExhaustion(second)).toBe(false);
    } finally {
      stop.abort();
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps an earlier committed exhaustion when a later durable chunk fails", async () => {
    const { home, app } = await seeded();
    try {
      const job = await app.jobService!.create({
        target_kind: "selector",
        selector: { kind: "literatures", literature_ids: [first, second] },
        goal: "pdf",
        policy_version: "frozen-stage-failure",
        policy: { mode: "never", max_retries: 0 },
        idempotency_key: "frozen-stage-failure",
      });
      const completion = new DatabaseCompletionService({
        library: app.library,
        database: app.database,
        writes: app.writes,
        completion: null,
        max_concurrency: 1,
        acquisition: {
          acquire: async ({ literature_id }) => {
            if (literature_id === second)
              throw new WriteAdmissionError("write-admission-closed");
            return { kind: "exhausted" };
          },
        },
      });
      const service = new ExecutionTaskService(
        app.jobs!,
        app.queue!,
        app.interventions!,
        { completion },
      );
      expect(await service.runJob(job.job_id)).toMatchObject([
        { outcome: "skipped", failure: { code: "pdf-acquisition-required" } },
        {
          outcome: "failed",
          failure: { code: "pdf-acquisition-storage-failed" },
        },
      ]);
      expect(await app.jobs!.getJob(job.job_id)).toMatchObject({
        status: "failed",
      });
      expect(await app.database.hasAutomaticPdfExhaustion(first)).toBe(true);
      expect(await app.database.hasAutomaticPdfExhaustion(second)).toBe(false);
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("settles a failed finish hook without losing committed material or the lease", async () => {
    const { home, app } = await seeded();
    let acquired = 0;
    try {
      const job = await app.jobService!.create({
        target_kind: "selector",
        selector: { kind: "literatures", literature_ids: [first, second] },
        goal: "pdf",
        policy_version: "finish-hook-fault",
        policy: { mode: "never" },
        idempotency_key: "finish-hook-fault",
      });
      const append = app.jobs!.appendEvent.bind(app.jobs!);
      let failedOnce = false;
      vi.spyOn(app.jobs!, "appendEvent").mockImplementation(async (event) => {
        if (event.kind === "attempt-completed" && !failedOnce) {
          failedOnce = true;
          throw new Error("synthetic event write fault");
        }
        return append(event);
      });
      const bytes = workbenchPdf();
      const completion = new DatabaseCompletionService({
        library: app.library,
        database: app.database,
        writes: app.writes,
        completion: null,
        max_concurrency: 1,
        acquisition: {
          acquire: async (request) => {
            acquired++;
            const staged = await app.files.stage({ maxBytes: bytes.length });
            await staged.write(bytes);
            const path = `objects/finish-fault-${request.literature_id}.pdf`;
            const asset = parseAsset({
              asset_id: randomUUID(),
              sha256: await sha256(bytes),
              size_bytes: bytes.length,
              media_type: "application/pdf",
              path,
            });
            await request.commit!(async () => {
              await app.files.publish(staged, path);
              await app.database.putLiteratureAsset({
                literature_asset_id: randomUUID(),
                literature_id: request.literature_id,
                asset,
                role: "primary-pdf",
                source_url: null,
                provenance: {
                  provenance_id: randomUUID(),
                  source_kind: "asset-provider",
                  source_name: "finish-fault-test",
                  source_record_id: null,
                  observed_at: "2026-09-28T00:00:00Z",
                  input_sha256: asset.sha256,
                  parameters_sha256: null,
                },
              });
            });
            return {
              kind: "acquired",
              literature_id: request.literature_id,
              receipt: {
                receipt_id: `finish-fault-${request.literature_id}`,
                literature_id: request.literature_id,
                asset_id: asset.asset_id,
                sha256: asset.sha256,
                reference: asset.path,
                created: true,
              },
            };
          },
        },
      });
      const service = new ExecutionTaskService(
        app.jobs!,
        app.queue!,
        app.interventions!,
        { completion },
      );
      expect(await service.runJob(job.job_id)).toMatchObject([
        { outcome: "failed", failure: { code: "completion-operation-failed" } },
      ]);
      expect(acquired).toBe(1);
      const rows = await app.jobs!.listTargets(job.job_id);
      expect(rows).toMatchObject([{ stage: "failed" }, { stage: "queued" }]);
      expect(await app.jobs!.listAttempts(rows[0]!.target_id)).toMatchObject([
        { status: "failed", failure: { code: "completion-operation-failed" } },
      ]);
      expect(await app.jobs!.listAttempts(rows[1]!.target_id)).toEqual([]);
      expect(
        (await app.jobs!.listEvents(job.job_id)).map((event) => event.kind),
      ).toEqual(["attempt-started", "attempt-failed"]);
      expect(await app.library.detail(first)).toMatchObject({
        primary_pdf: { asset: { sha256: await sha256(bytes) } },
      });
      expect(await app.jobs!.getJob(job.job_id)).toMatchObject({
        status: "failed",
      });
      const leaseId = `lease-${randomUUID()}`;
      await expect(
        app.jobs!.acquireLease({
          lease_id: leaseId,
          job_id: job.job_id,
          workspace_id: null,
          boot_id: "finish-fault-check",
          control_epoch: 0,
          acquired_at: new Date().toISOString(),
          released_at: null,
        }),
      ).resolves.toMatchObject({ lease_id: leaseId });
      await app.jobs!.releaseLease(leaseId);
    } finally {
      vi.restoreAllMocks();
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("runs an existing schema-1 durable target through the shared operation", async () => {
    const { home, app } = await seeded();
    try {
      const jobId = "job-existing-schema-one";
      const targetId = "target-existing-schema-one";
      await app.jobs!.createJob({
        job_id: jobId,
        target_kind: "selector",
        selector: {
          schema_version: 1,
          goal: "pdf",
          selector: { kind: "literatures", literature_ids: [first] },
        },
        policy_version: "existing-schema-one",
        policy: { mode: "never" },
        idempotency_key: "existing-schema-one",
        targets: [
          {
            target_id: targetId,
            job_id: jobId,
            ordinal: 0,
            literature_id: first,
            version_role: "published",
            stage: "queued",
            disposition: "pending",
            next_eligible_at: null,
          },
        ],
      });
      await app.database.setAutomaticPdfExhaustion(first);
      const acquisition = vi.spyOn(app.pdfAcquisition!, "acquireCohort");
      expect(await app.taskService!.runJob(jobId)).toMatchObject([
        {
          target_id: targetId,
          outcome: "skipped",
          failure: { code: "pdf-acquisition-required" },
        },
      ]);
      expect(await app.database.hasAutomaticPdfExhaustion(first)).toBe(true);
      expect(acquisition).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
