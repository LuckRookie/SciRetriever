import { parseLiterature } from "@sciretriever/contracts";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import { describe, expect, it, vi } from "vitest";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { ProcessingTaskService } from "../src/application/jobs/processing.js";
import { WriteAdmissionError } from "../src/storage/write-admission.js";

describe("durable product processing tasks", () => {
  it("does not misreport a business write conflict after admission as another runtime's ownership", async () => {
    const env = await coreProcessingFixture();
    try {
      const job = await env.app.processingTasks!.submit({
        schema_version: 1,
        idempotency_key: "write-after-admission",
        operations: [
          { operation: "parse-documents", request: env.rawParseRequest },
        ],
      });
      vi.spyOn(env.app.jobs!, "acquireLease").mockRejectedValueOnce(
        new WriteAdmissionError("write-admission-conflict"),
      );
      await expect(
        env.app.processingTasks!.run(job.job_id),
      ).rejects.toMatchObject({ code: "write-admission-conflict" });
      expect(await env.app.processingTasks!.read(job.job_id)).toMatchObject({
        job: { status: "interrupted" },
        runtime_failure: "processing-runtime-failed",
        failures: [{ code: "processing-runtime-failed" }],
      });
      expect(env.parseCalls).toBe(0);
      await env.app.processingTasks!.control(job.job_id, "retry");
      expect((await env.app.processingTasks!.run(job.job_id)).job.status).toBe(
        "completed",
      );
      expect(env.parseCalls).toBe(2);
    } finally {
      await env.close();
    }
  });
  it.each(["task-service", "queue"] as const)(
    "protects an active direct %s run from another Application's recovery",
    async (entry) => {
      const env = await coreProcessingFixture();
      const controller = new AbortController();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let other: Awaited<ReturnType<typeof env.openAnother>> | undefined;
      let active: Promise<unknown> | undefined;
      try {
        env.setParseHook(() => held);
        const job = await env.app.jobService!.create({
          target_kind: "selector",
          selector: {
            kind: "literatures",
            literature_ids: [env.parseRequest.literature_id],
          },
          goal: "parser",
          policy_version: "fixture",
          policy: { mode: "never", max_retries: 0 },
          idempotency_key: `direct-${entry}`,
        });
        let entered = false;
        active =
          entry === "task-service"
            ? env.app.taskService!.runJob(job.job_id, {
                signal: controller.signal,
              })
            : env.app.queue!.runNext(job.job_id, async () => {
                entered = true;
                await held;
                return "completed";
              });
        await vi.waitFor(() =>
          expect(entry === "task-service" ? env.parseCalls > 0 : entered).toBe(
            true,
          ),
        );
        const target = (await env.app.jobs!.listTargets(job.job_id))[0]!;
        other = await env.openAnother();
        expect(other.executionRecovery).toBeNull();
        expect((await other.jobs!.getJob(job.job_id))?.status).toBe("running");
        expect(await other.jobs!.listAttempts(target.target_id)).toMatchObject([
          { status: "running" },
        ]);
        await expect(
          other.taskService!.runJob(job.job_id),
        ).rejects.toMatchObject({ code: "write-admission-conflict" });
        await expect(
          other.processingTasks!.control(job.job_id, "retry"),
        ).rejects.toMatchObject({ code: "processing-busy" });

        // A different target on the owning connection shares admission without deadlocking.
        // The same asset/profile is intentionally serialized by the raw parser.
        const siblingId = "00000000-0000-4000-9000-000000009876";
        await env.app.database.putLiterature(
          parseLiterature({
            ...FIXTURE_LITERATURE,
            literature_id: siblingId,
            meta_literature_id: "00000000-0000-4000-9000-000000009877",
            metadata: { ...FIXTURE_LITERATURE.metadata, identifiers: [] },
          }),
        );
        await env.app.maintenance!.ingestPdf({
          literature_id: siblingId,
          bytes: workbenchPdf("Independent sibling"),
        });
        const siblingAsset = (await env.app.library.detail(siblingId))
          .primary_pdf!.asset;
        const sibling = await env.app.processingTasks!.submit({
          schema_version: 1,
          idempotency_key: "sibling",
          operations: [
            {
              operation: "parse-documents",
              request: {
                ...env.rawParseRequest,
                literature_id: siblingId,
                asset_id: siblingAsset.asset_id,
                asset_sha256: siblingAsset.sha256,
              },
            },
          ],
        });
        env.setParseHook(async () => {});
        expect(
          (await env.app.processingTasks!.run(sibling.job_id)).job.status,
        ).toBe("completed");
        expect((await other.jobs!.getJob(job.job_id))?.status).toBe("running");
        controller.abort();
        release();
        await active;
        await other.close();
        other = await env.openAnother();
        expect(other.executionRecovery).toMatchObject({
          recovered_attempts: 0,
          released_leases: 0,
        });
        expect(
          await other.jobs!.listAttempts(target.target_id),
        ).not.toContainEqual(expect.objectContaining({ status: "running" }));
      } finally {
        controller.abort();
        release();
        await active;
        await other?.close();
        await env.close();
      }
    },
  );

  it("does not queue capacity-rejected or already-aborted synchronous runs, while explicit background starts still queue", async () => {
    const env = await coreProcessingFixture();
    const service = new ProcessingTaskService(
      env.app.jobs!,
      env.app.queue!,
      {
        documents: env.app.documentProcessing,
        identity: env.app.articleIdentity ?? null,
      },
      null,
      env.app.bootId,
      1,
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const submit = (key: string) =>
        service.submit({
          schema_version: 1,
          idempotency_key: key,
          operations: [
            { operation: "parse-documents", request: env.rawParseRequest },
          ],
        });
      const first = await submit("capacity-first");
      const refused = await submit("capacity-refused");
      const background = await submit("capacity-background");
      env.setParseHook(() => held);
      const running = service.run(first.job_id);
      await vi.waitFor(() => expect(env.parseCalls).toBe(2));
      const controller = new AbortController();
      await expect(
        service.run(refused.job_id, controller.signal),
      ).rejects.toMatchObject({ code: "processing-capacity" });
      controller.abort();
      expect(service.start(background.job_id)).toBe(false);
      release();
      await running;
      await vi.waitFor(async () =>
        expect((await service.read(background.job_id)).job.status).toBe(
          "completed",
        ),
      );
      await service.close();
      expect((await service.read(refused.job_id)).job.status).toBe("queued");
      expect(await env.app.jobs!.listAttempts(`${refused.job_id}:0`)).toEqual(
        [],
      );
      expect(env.parseCalls).toBe(2);

      const cancelled = await env.app.processingTasks!.submit({
        schema_version: 1,
        idempotency_key: "already-aborted",
        operations: [
          { operation: "parse-documents", request: env.rawParseRequest },
        ],
      });
      await expect(
        env.app.processingTasks!.run(cancelled.job_id, controller.signal),
      ).rejects.toMatchObject({ code: "processing-cancelled" });
      expect(
        (await env.app.processingTasks!.read(cancelled.job_id)).job.status,
      ).toBe("queued");
      expect(env.parseCalls).toBe(2);
    } finally {
      release();
      await service.close();
      await env.close();
    }
  });
  it("does not recover another live runtime and observes controls from a second Application", async () => {
    const env = await coreProcessingFixture();
    let other: Awaited<ReturnType<typeof env.openAnother>> | undefined;
    try {
      env.setParseHook(
        (signal) =>
          new Promise((_, reject) =>
            signal!.addEventListener("abort", () => reject(new Error("stop")), {
              once: true,
            }),
          ),
      );
      const first = await env.app.processingTasks!.submit({
        schema_version: 1,
        idempotency_key: "live-owner",
        operations: [
          { operation: "parse-documents", request: env.rawParseRequest },
        ],
      });
      const running = env.app.processingTasks!.run(first.job_id);
      await vi.waitFor(() => expect(env.parseCalls).toBe(2));
      other = await env.openAnother();
      expect(other.executionRecovery).toBeNull();
      expect((await other.jobs!.getJob(first.job_id))?.status).toBe("running");
      await expect(
        other.processingTasks!.run(first.job_id),
      ).rejects.toMatchObject({ code: "processing-runtime-owned" });
      expect((await other.jobs!.getJob(first.job_id))?.status).toBe("running");
      expect(
        (await other.processingTasks!.read(first.job_id)).failures,
      ).toContainEqual({ code: "processing-runtime-owned" });
      await other.processingTasks!.control(first.job_id, "pause");
      expect((await running).job.status).toBe("paused");
      expect(env.parseCalls).toBe(2);
    } finally {
      await other?.close();
      await env.close();
    }
  });
  it("freezes independent operations, preserves partial results, rejects idempotency conflicts and retries only incomplete targets", async () => {
    const env = await coreProcessingFixture();
    try {
      env.setParseHook(async () => {
        if (env.parseCalls === 2)
          throw new Error("synthetic transient parser failure");
      });
      const request = {
        schema_version: 1,
        idempotency_key: "partial",
        operations: [
          {
            operation: "parse-documents",
            request: {
              ...env.rawParseRequest,
              profiles: ["pipeline"],
              force: true,
            },
          },
          {
            operation: "parse-documents",
            request: {
              ...env.rawParseRequest,
              profiles: ["pipeline"],
              force: true,
            },
          },
        ],
      };
      const job = await env.app.processingTasks!.submit(request);
      const result = await env.app.processingTasks!.run(job.job_id);
      expect(result.job.status).toBe("failed");
      expect(result.results).toHaveLength(1);
      expect(result.targets.map((t) => t.stage)).toEqual([
        "completed",
        "failed",
      ]);
      expect((await env.app.processingTasks!.submit(request)).job_id).toBe(
        job.job_id,
      );
      await expect(
        env.app.processingTasks!.submit({
          ...request,
          operations: request.operations.slice(0, 1),
        }),
      ).rejects.toBeDefined();
      await env.reopen();
      await env.app.processingTasks!.control(job.job_id, "retry");
      const retried = await env.app.processingTasks!.run(job.job_id);
      expect(retried.job.status).toBe("completed");
      expect(retried.results).toHaveLength(2);
      expect(env.parseCalls).toBe(3);
      const reader = await createQueryApplication(env.home);
      try {
        expect(await reader.taskRead!(job.job_id)).toMatchObject({
          job: { status: "completed" },
          results: expect.any(Array),
        });
      } finally {
        await reader.close();
      }
      // Simulate a crash after durable result publication but before completion accounting.
      await env.app.jobs!.updateTarget(
        result.targets[0]!.target_id,
        "interrupted",
        "interrupted",
      );
      await env.app.jobs!.updateJob(job.job_id, "interrupted");
      await env.reopen();
      await env.app.processingTasks!.control(job.job_id, "retry");
      expect((await env.app.processingTasks!.run(job.job_id)).job.status).toBe(
        "completed",
      );
      expect(env.parseCalls).toBe(3);
    } finally {
      await env.close();
    }
  });
  it("stops in-flight parsing on pause, leaves later targets unstarted, and resumes against the original frozen requests", async () => {
    const env = await coreProcessingFixture();
    try {
      env.setParseHook(
        (signal) =>
          new Promise((_, reject) => {
            signal!.addEventListener(
              "abort",
              () => reject(new Error("cancelled")),
              { once: true },
            );
          }),
      );
      const job = await env.app.processingTasks!.submit({
        schema_version: 1,
        idempotency_key: "pause",
        operations: [
          { operation: "parse-documents", request: env.rawParseRequest },
          { operation: "parse-documents", request: env.rawParseRequest },
        ],
      });
      env.app.processingTasks!.start(job.job_id);
      await vi.waitFor(() => expect(env.parseCalls).toBe(2));
      const paused = await env.app.processingTasks!.control(
        job.job_id,
        "pause",
      );
      expect(paused.job.status).toBe("paused");
      expect(paused.targets.map((t) => t.stage)).toEqual([
        "interrupted",
        "queued",
      ]);
      expect(paused.results).toEqual([]);
      env.setParseHook(async () => {});
      await env.app.processingTasks!.control(job.job_id, "resume");
      expect((await env.app.processingTasks!.run(job.job_id)).job.status).toBe(
        "completed",
      );
      expect(env.parseCalls).toBe(4);
    } finally {
      await env.close();
    }
  });
});
