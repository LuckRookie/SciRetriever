import { describe, expect, it } from "vitest";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import type { ExecutionTarget } from "../src/storage/sqlite/worker.js";

const failure = {
  code: "content-completion-unavailable",
  reason: "Synthetic completion configuration is missing.",
  action: "Configure the completion service and explicitly retry.",
  retryable: false,
};

describe("processing skip diagnostics and explicit retry", () => {
  it("reports an already satisfied PDF without a failure or an intervention", async () => {
    const env = await coreProcessingFixture();
    try {
      const job = await env.app.jobService!.create({
        target_kind: "selector",
        selector: {
          kind: "literatures",
          literature_ids: [env.parseRequest.literature_id],
        },
        goal: "pdf",
        policy_version: "fixture",
        policy: { mode: "pause" },
        idempotency_key: "satisfied-pdf",
      });
      const result = await env.app.processingTasks!.run(job.job_id);
      expect(result.job.status).toBe("completed");
      expect(result.failures).toEqual([]);
      expect(result.skipped).toMatchObject([
        { skipped_reason: "already-satisfied", failure: null },
      ]);
      expect(await env.app.jobs!.listInterventions(job.job_id)).toEqual([]);
      await expect(
        env.app.processingTasks!.control(job.job_id, "retry"),
      ).rejects.toMatchObject({ code: "processing-terminal" });
      expect(env.parseCalls).toBe(0);
      expect(env.modelCalls).toBe(0);
    } finally {
      await env.close();
    }
  });

  it("preserves an explicit operator skip and a cancelled terminal task", async () => {
    const env = await coreProcessingFixture();
    try {
      const job = await env.app.jobService!.create({
        target_kind: "selector",
        selector: {
          kind: "literatures",
          literature_ids: [env.parseRequest.literature_id],
        },
        goal: "content",
        policy_version: "fixture",
        policy: { mode: "pause" },
        idempotency_key: "operator-skip",
      });
      expect((await env.app.processingTasks!.run(job.job_id)).job.status).toBe(
        "paused",
      );
      const intervention = (
        await env.app.jobs!.listInterventions(job.job_id)
      )[0]!;
      await env.app.interventions!.resolve(
        intervention.intervention_id,
        "skip",
      );
      await env.app.processingTasks!.control(job.job_id, "retry");
      const settled = await env.app.processingTasks!.run(job.job_id);
      expect(settled.job.status).toBe("completed");
      expect(settled.targets[0]?.stage).toBe("skipped");
      expect(
        await env.app.jobs!.listAttempts(settled.targets[0]!.target_id),
      ).toHaveLength(1);
      expect(settled.failures).toMatchObject([
        { failure: { code: "content-completion-unavailable" } },
      ]);
      await expect(
        env.app.processingTasks!.control(job.job_id, "retry"),
      ).rejects.toMatchObject({ code: "processing-terminal" });

      const cancelled = await env.app.processingTasks!.submit({
        schema_version: 1,
        idempotency_key: "cancelled-retry",
        operations: [
          { operation: "parse-documents", request: env.parseRequest },
        ],
      });
      await env.app.processingTasks!.control(cancelled.job_id, "cancel");
      await expect(
        env.app.processingTasks!.control(cancelled.job_id, "retry"),
      ).rejects.toMatchObject({ code: "processing-terminal" });
      expect(
        (await env.app.processingTasks!.read(cancelled.job_id)).job.status,
      ).toBe("cancelled");
      expect(env.parseCalls).toBe(0);
    } finally {
      await env.close();
    }
  });

  it("requeues only incomplete targets, including legacy skip events, without reviving exhausted budgets or replacing saved results", async () => {
    const env = await coreProcessingFixture();
    try {
      const cases: {
        id: string;
        stage: ExecutionTarget["stage"];
        kind: string;
        payload: Record<string, unknown>;
        queued: boolean;
      }[] = [
        {
          id: "done",
          stage: "completed",
          kind: "attempt-completed",
          payload: { failure: null },
          queued: false,
        },
        {
          id: "satisfied",
          stage: "skipped",
          kind: "attempt-skipped",
          payload: { failure: null, skipped_reason: "already-satisfied" },
          queued: false,
        },
        {
          id: "exhausted",
          stage: "skipped",
          kind: "attempt-skipped",
          payload: { failure, skipped_reason: "manual-pdf-required" },
          queued: false,
        },
        {
          id: "ineligible",
          stage: "skipped",
          kind: "attempt-skipped",
          payload: { failure: null, skipped_reason: "not-eligible" },
          queued: false,
        },
        {
          id: "failure-skip",
          stage: "skipped",
          kind: "attempt-skipped",
          payload: { failure, skipped_reason: null },
          queued: true,
        },
        {
          id: "legacy-skip",
          stage: "skipped",
          kind: "attempt-skipped",
          payload: { failure },
          queued: true,
        },
        {
          id: "failed",
          stage: "failed",
          kind: "attempt-failed",
          payload: { failure },
          queued: true,
        },
        {
          id: "interrupted",
          stage: "interrupted",
          kind: "attempt-interrupted",
          payload: { failure },
          queued: true,
        },
        {
          id: "budget",
          stage: "skipped",
          kind: "target-budget-exhausted",
          payload: {
            failure: { ...failure, code: "execution-budget-exhausted" },
          },
          queued: false,
        },
      ];
      const jobId = "fixture-retry-history";
      await env.app.jobs!.createJob({
        job_id: jobId,
        target_kind: "selector",
        selector: {},
        policy_version: "fixture",
        policy: { mode: "never" },
        idempotency_key: jobId,
        targets: cases.map((item, ordinal) => ({
          job_id: jobId,
          target_id: item.id,
          ordinal,
          literature_id: null,
          version_role: null,
          stage: "queued",
          disposition: "pending",
          next_eligible_at: null,
        })),
      });
      const append = (
        targetId: string,
        kind: string,
        payload: Record<string, unknown>,
        key = kind,
      ) =>
        env.app.jobs!.appendEvent({
          event_id: `${targetId}:${key}`,
          job_id: jobId,
          sequence: -1,
          kind,
          payload: { target_id: targetId, ...payload },
          created_at: new Date().toISOString(),
        });
      for (const item of cases) {
        // An older failed skip cannot override a later successful or budget-exhausted settlement.
        if (["done", "budget"].includes(item.id))
          await append(item.id, "attempt-skipped", { failure }, "old-skip");
        await env.app.jobs!.updateTarget(
          item.id,
          item.stage,
          item.stage as ExecutionTarget["disposition"],
        );
        await append(item.id, item.kind, item.payload);
      }
      await append("done", "processing-result", {
        result: { document_version_id: "immutable-fixture-reference" },
        disposition: "completed",
      });
      await env.app.jobs!.updateJob(jobId, "failed");
      await env.reopen();
      const before = await env.app.processingTasks!.read(jobId);
      const result = await env.app.processingTasks!.control(jobId, "retry");
      expect(result.targets.map((t) => t.stage)).toEqual(
        cases.map((item) => (item.queued ? "queued" : item.stage)),
      );
      expect(result.results).toEqual(before.results);
      expect(result.skipped).toEqual(before.skipped);
      expect(result.failures).toContainEqual(
        expect.objectContaining({ target_id: "legacy-skip", failure }),
      );
      expect(result.failures).toContainEqual(
        expect.objectContaining({
          target_id: "budget",
          failure: expect.objectContaining({
            code: "execution-budget-exhausted",
          }),
        }),
      );
      expect(env.parseCalls).toBe(0);
    } finally {
      await env.close();
    }
  });
});
