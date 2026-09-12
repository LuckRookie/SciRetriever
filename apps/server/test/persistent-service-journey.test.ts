import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../src/bootstrap/application.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const selector = {
  kind: "literatures" as const,
  literature_ids: [FIXTURE_LITERATURE.literature_id],
};

describe("persistent service journey", () => {
  it("keeps durable jobs and interventions across restart and explicit v2 setup", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-persistent-"));
    let app = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
    });
    try {
      await app.database.putLiterature(FIXTURE_LITERATURE);
      const job = await app.jobService!.create({
        target_kind: "selector",
        selector,
        goal: "pdf",
        policy_version: "policy-persistent-1",
        policy: {
          mode: "pause",
          max_retries: 0,
          max_attempts: 10,
          intervention_timeout_ms: 60_000,
        },
        idempotency_key: "persistent-journey-1",
      });
      expect(job.status).toBe("queued");
      const first = await app.taskService!.runJob(job.job_id);
      expect(first).toMatchObject([
        {
          outcome: "interrupted",
          failure: { code: "pdf-acquisition-required" },
        },
      ]);
      expect(await app.jobs!.getJob(job.job_id)).toMatchObject({
        status: "paused",
      });
      const interventions = await app.jobs!.listInterventions(job.job_id);
      expect(interventions).toHaveLength(1);
      expect(interventions[0]).toMatchObject({ status: "open", mode: "pause" });
    } finally {
      await app.close();
    }

    app = await createApplication(home, { executionSchema: "require-v2" });
    try {
      const jobs = await app.jobs!.listJobs();
      expect(jobs).toHaveLength(1);
      const job = jobs[0]!;
      expect(job.status).toBe("paused");
      const open = (await app.jobs!.listInterventions(job.job_id))[0]!;
      await app.interventions!.resolve(open.intervention_id, "skip");
      await app.queue!.resume(job.job_id);
      expect(await app.taskService!.runJob(job.job_id)).toEqual([]);
      expect(await app.jobs!.getJob(job.job_id)).toMatchObject({
        status: "completed",
      });
      expect(await app.jobs!.listTargets(job.job_id)).toMatchObject([
        { stage: "skipped", disposition: "skipped" },
      ]);
      expect(
        await app.database.getLiterature(FIXTURE_LITERATURE.literature_id),
      ).toMatchObject({
        metadata: { title: FIXTURE_LITERATURE.metadata.title },
      });
      expect((await app.database.inspectExecutionRuntime()).migrated).toBe(
        true,
      );
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
