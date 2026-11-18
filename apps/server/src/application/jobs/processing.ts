import { activityContext, withActivity } from "../../logging/activity.js";
import { taskSourceResults } from "../source-statistics.js";
import {
  canonicalJsonBytes,
  parseProcessingTaskRequest,
  sha256,
  type ProcessingOperation,
  type ProcessingTaskRequest,
} from "@sciretriever/contracts";
import { randomUUID } from "node:crypto";
import type { ArchiveOrchestrator } from "../../archive/orchestrator.js";
import type { DocumentProcessingService } from "../../document/service.js";
import type { ArticleIdentityService } from "../../parsing/article-identity.js";
import type { ExecutionRepository } from "../../storage/execution/repository.js";
import {
  SqliteWorkerError,
  type ExecutionTarget,
} from "../../storage/sqlite/worker.js";
import { WriteAdmissionError } from "../../storage/write-admission.js";
import {
  ExecutionQueue,
  QueueInterruptedError,
  QueueTargetFailureError,
  type ExecutionRunResult,
  type ExecutionTaskService,
} from "./service.js";

export class ProcessingTaskError extends Error {
  constructor(readonly code: string) {
    super("processing task operation failed");
    this.name = "ProcessingTaskError";
  }
}
export interface ProcessingRuntime {
  readonly metadata?: {
    execute(
      request: import("@sciretriever/contracts").MetadataTaskRequest,
      signal: AbortSignal,
      jobId: string,
      targetId: string,
    ): Promise<Record<string, unknown>>;
  };
  readonly tags?: Pick<import("../../tags/service.js").TagService, "backfill">;
  readonly archive?: ArchiveOrchestrator;
  readonly processors?: {
    execute(
      value: unknown,
      signal?: AbortSignal,
    ): Promise<Record<string, unknown>>;
    finish(jobId: string, request: ProcessingTaskRequest): Promise<void>;
  };
  readonly documents: Pick<DocumentProcessingService, "parseDocuments">;
  readonly identity: Pick<ArticleIdentityService, "assess"> | null;
}
export async function processingEvents(
  repository: ExecutionRepository,
  jobId: string,
) {
  const events = [];
  let after = -1;
  for (;;) {
    const page = await repository.listEvents(jobId, after, 1000);
    events.push(
      ...page.filter(
        (e) =>
          ![
            "metadata-source",
            "pdf-source-result",
            "acquisition-attempt",
          ].includes(e.kind),
      ),
    );
    if (page.length < 1000) return events;
    if (events.length >= 100000)
      throw new ProcessingTaskError("processing-result-budget");
    after = page.at(-1)!.sequence;
  }
}
export async function readProcessingTask(
  repository: ExecutionRepository,
  jobId: string,
) {
  const job = await repository.getJob(jobId);
  if (!job) throw new ProcessingTaskError("processing-not-found");
  const targets = await repository.listTargets(jobId, 10000, true);
  const events = await processingEvents(repository, jobId);
  return {
    job,
    targets,
    source_results: await taskSourceResults(repository, jobId),
    archive: {
      schema_version: 2,
      steps: [
        ...new Map(
          events
            .filter((e) => e.kind === "archive-progress")
            .map((e) => {
              const p = e.payload as { attempt_id: string };
              return [p.attempt_id, e.payload];
            }),
        ).values(),
      ],
      events_truncated: events.length >= 1000,
      next_event_cursor:
        events.length >= 1000 ? (events[0]?.sequence ?? null) : null,
    },
    results: events
      .filter((e) => e.kind === "processing-result")
      .map((e) => e.payload),
    partial_results: events
      .filter((e) => e.kind === "processing-partial-result")
      .map((e) => e.payload),
    collections: events
      .filter((e) => e.kind === "processor-collection")
      .map((e) => e.payload),
    skipped: events
      .filter(
        (e) =>
          e.kind === "attempt-skipped" || e.kind === "target-budget-exhausted",
      )
      .map((e) => e.payload),
    failures: events
      .filter(
        (e) =>
          e.kind === "attempt-failed" ||
          e.kind === "attempt-interrupted" ||
          e.kind === "processing-runtime-failed" ||
          ([
            "attempt-skipped",
            "attempt-paused-for-assistance",
            "attempt-retry-scheduled",
            "target-budget-exhausted",
          ].includes(e.kind) &&
            hasFailure(e.payload)),
      )
      .map((e) => e.payload),
  };
}

function hasFailure(payload: unknown): boolean {
  return (
    !!payload &&
    typeof payload === "object" &&
    "failure" in payload &&
    payload.failure !== null &&
    payload.failure !== undefined
  );
}

export async function processingJobId(key: string) {
  return `processing-${(await sha256(canonicalJsonBytes({ idempotency_key: key }))).slice(0, 32)}`;
}

/** Typed product operations on the existing durable queue; no second execution store. */
export class ProcessingTaskService {
  private readonly running = new Map<
    string,
    {
      readonly controller: AbortController;
      readonly promise: Promise<readonly ExecutionRunResult[]>;
    }
  >();
  private stopped = false;
  private readonly waiting = new Set<string>();
  private readonly backgroundFailures = new Map<string, string>();
  constructor(
    private readonly repository: ExecutionRepository,
    private readonly queue: ExecutionQueue,
    private readonly runtime: ProcessingRuntime,
    private readonly legacy: Pick<ExecutionTaskService, "runJob"> | null,
    private readonly bootId: string,
    private readonly maxConcurrent = 4,
  ) {
    if (
      !Number.isSafeInteger(maxConcurrent) ||
      maxConcurrent < 1 ||
      maxConcurrent > 100
    )
      throw new TypeError("processing concurrency is invalid");
  }

  async submit(value: unknown) {
    if (this.stopped) throw new ProcessingTaskError("processing-closed");
    const request = await parseProcessingTaskRequest(value);
    const jobId = await processingJobId(request.idempotency_key);
    const selector = { schema_version: 3, request };
    const existing = async () => {
      const saved = await this.repository.getJob(jobId);
      if (
        saved &&
        (saved.idempotency_key !== request.idempotency_key ||
          saved.policy_version !== "processing-v1" ||
          !Buffer.from(canonicalJsonBytes(saved.selector)).equals(
            Buffer.from(canonicalJsonBytes(selector)),
          ))
      )
        throw new ProcessingTaskError("processing-idempotency-conflict");
      return saved;
    };
    const saved = await existing();
    if (saved) return saved;
    const targets: ExecutionTarget[] = request.operations.map(
      (operation, ordinal) => ({
        job_id: jobId,
        target_id: `${jobId}:${ordinal}`,
        ordinal,
        literature_id:
          "literature_id" in operation.request
            ? operation.request.literature_id
            : null,
        version_role: null,
        stage: "queued",
        disposition: "pending",
        next_eligible_at: null,
      }),
    );
    try {
      return await this.repository.createJob({
        job_id: jobId,
        idempotency_key: request.idempotency_key,
        target_kind: "selector",
        selector,
        targets,
        policy_version: "processing-v1",
        policy: { mode: "never", max_retries: 0, max_attempts: 100000 },
      });
    } catch (error) {
      // A concurrent identical submit may have created and started the job.
      // Return its existing targets rather than attempting to reset their state.
      const raced = await existing();
      if (raced) return raced;
      throw error;
    }
  }
  async read(jobId: string) {
    return {
      ...(await readProcessingTask(this.repository, jobId)),
      runtime_failure: this.backgroundFailures.get(jobId) ?? null,
    };
  }
  start(jobId: string): boolean {
    return this.admit(jobId, true);
  }
  private admit(jobId: string, enqueue: boolean): boolean {
    // Admission happens synchronously, before the first awaited repository read.
    if (this.stopped) throw new ProcessingTaskError("processing-closed");
    if (this.running.has(jobId)) return true;
    if (this.running.size >= this.maxConcurrent) {
      if (enqueue) this.waiting.add(jobId);
      return false;
    }
    this.waiting.delete(jobId);
    this.backgroundFailures.delete(jobId);
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => this.execute(jobId, controller.signal))
      .catch(async (error: unknown) => {
        const ownedElsewhere =
          error instanceof ProcessingTaskError &&
          error.code === "processing-runtime-owned";
        const code = ownedElsewhere
          ? "processing-runtime-owned"
          : "processing-runtime-failed";
        // Ordinary product failures are settled by the queue. Preserve an outer
        // scheduler/storage failure separately, without serializing raw exceptions.
        this.backgroundFailures.set(jobId, code);
        if (await this.repository.getJob(jobId)) {
          await this.repository.appendEvent({
            event_id: `event-${randomUUID()}`,
            job_id: jobId,
            sequence: -1,
            kind: "processing-runtime-failed",
            payload: { code },
            created_at: new Date().toISOString(),
          });
          // A different runtime may own this job. Report the refused launch
          // durably without changing its active state.
          if (!ownedElsewhere)
            await this.repository.updateJobIfActive(jobId, "interrupted");
        }
        throw error;
      })
      .finally(() => {
        this.running.delete(jobId);
        if (!this.stopped)
          for (const queued of this.waiting) {
            if (this.running.size >= this.maxConcurrent) break;
            this.start(queued);
          }
      });
    this.running.set(jobId, { controller, promise });
    // Observe detached rejection even if the store itself failed before recording it.
    void promise.catch((error: unknown) => {
      this.backgroundFailures.set(
        jobId,
        error instanceof ProcessingTaskError
          ? error.code
          : "processing-runtime-failed",
      );
    });
    return true;
  }
  async run(jobId: string, signal?: AbortSignal) {
    await this.runResults(jobId, signal);
    return this.read(jobId);
  }
  /** Preserve the established completion CLI result shape while sharing execution ownership. */
  async runResults(jobId: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new ProcessingTaskError("processing-cancelled");
    if (!this.admit(jobId, false))
      throw new ProcessingTaskError("processing-capacity");
    const active = this.running.get(jobId)!;
    const abort = () => active.controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      return await active.promise;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  async control(
    jobId: string,
    action: "pause" | "cancel" | "resume" | "retry",
  ) {
    await this.repository.appendEvent({
      event_id: `event-${randomUUID()}`,
      job_id: jobId,
      sequence: -1,
      kind: "task-control-requested",
      payload: { action, actor: activityContext().actor },
      created_at: new Date().toISOString(),
    });
    if (action === "pause" || action === "cancel") {
      this.waiting.delete(jobId);
      try {
        if (action === "pause") await this.queue.pause(jobId);
        else await this.queue.cancel(jobId);
      } catch (error) {
        if (
          error instanceof SqliteWorkerError &&
          error.code === "execution-job-terminal"
        )
          throw new ProcessingTaskError("processing-terminal");
        throw error;
      }
      const active = this.running.get(jobId);
      active?.controller.abort();
      if (active) await active.promise;
      return this.read(jobId);
    }
    if (this.running.has(jobId))
      throw new ProcessingTaskError("processing-busy");
    const job = await this.repository.getJob(jobId);
    if (!job) throw new ProcessingTaskError("processing-not-found");
    if (job.status === "running")
      throw new ProcessingTaskError("processing-busy");
    const retrySkipped = new Set<string>();
    if (action === "retry") {
      const latest = new Map<
        string,
        { kind: string; payload: Record<string, unknown> }
      >();
      for (const event of await this.events(jobId)) {
        const payload = event.payload;
        if (
          (event.kind.startsWith("attempt-") ||
            event.kind === "target-budget-exhausted") &&
          payload &&
          typeof payload === "object" &&
          "target_id" in payload &&
          typeof payload.target_id === "string"
        )
          latest.set(payload.target_id, {
            kind: event.kind,
            payload: payload as Record<string, unknown>,
          });
      }
      for (const [id, event] of latest)
        if (
          event.kind === "attempt-skipped" &&
          hasFailure(event.payload) &&
          !["already-satisfied", "manual-pdf-required"].includes(
            String(event.payload.skipped_reason),
          )
        )
          retrySkipped.add(id);
    }
    if (
      job.status === "cancelled" ||
      (job.status === "completed" && retrySkipped.size === 0)
    )
      throw new ProcessingTaskError("processing-terminal");
    for (const target of await this.repository.listTargets(jobId, 10000))
      if (
        target.stage === "interrupted" ||
        (action === "retry" &&
          (target.stage === "failed" ||
            (target.stage === "skipped" && retrySkipped.has(target.target_id))))
      )
        await this.repository.updateTarget(
          target.target_id,
          "queued",
          "pending",
        );
    await this.queue.resume(jobId);
    return this.read(jobId);
  }
  async close() {
    this.stopped = true;
    this.waiting.clear();
    for (const active of this.running.values()) active.controller.abort();
    await Promise.allSettled([...this.running.values()].map((v) => v.promise));
  }
  private async events(jobId: string) {
    return processingEvents(this.repository, jobId);
  }
  private async execute(jobId: string, signal: AbortSignal) {
    let admitted = false;
    try {
      return await this.repository.withRuntime(() => {
        admitted = true;
        return this.repository.withOrigin(jobId, () =>
          this.executeControlled(jobId, signal),
        );
      });
    } catch (error) {
      if (
        !admitted &&
        error instanceof WriteAdmissionError &&
        error.code === "write-admission-conflict"
      )
        throw new ProcessingTaskError("processing-runtime-owned");
      throw error;
    }
  }
  private async executeControlled(jobId: string, signal: AbortSignal) {
    const controller = new AbortController();
    const active = AbortSignal.any([signal, controller.signal]);
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void this.repository
        .getJob(jobId)
        .then(
          (job) => {
            if (!job || ["paused", "cancelled"].includes(job.status))
              controller.abort();
          },
          () => controller.abort(),
        )
        .finally(() => {
          polling = false;
        });
    }, 500);
    try {
      return await this.executeOwned(jobId, active);
    } finally {
      clearInterval(timer);
    }
  }
  private async executeOwned(jobId: string, signal: AbortSignal) {
    const job = await this.repository.getJob(jobId);
    if (!job) throw new ProcessingTaskError("processing-not-found");
    const snapshot = job.selector as {
      schema_version?: unknown;
      request?: unknown;
    };
    if (snapshot?.schema_version !== 3) {
      if (!this.legacy) throw new ProcessingTaskError("processing-unavailable");
      return this.legacy.runJob(jobId, { signal, boot_id: this.bootId });
    }
    const request = await parseProcessingTaskRequest(snapshot.request);
    const hasArchive = request.operations.some(
      (o) => o.operation === "build-archive",
    );
    if (hasArchive)
      await this.runtime.archive?.beginBatch(jobId, this.repository);
    let results: readonly ExecutionRunResult[];
    try {
      results = await this.queue.runUntilIdle(
        jobId,
        async (target, active) => {
          const resultId = `${target.target_id}:result`;
          // The immutable operation receipt wins even if the process died before marking its attempt complete.
          const saved = (await this.events(jobId)).find(
            (e) => e.event_id === resultId,
          );
          if (saved)
            return (saved.payload as { disposition?: unknown }).disposition ===
              "skipped"
              ? "skipped"
              : "completed";
          const operation = request.operations[target.ordinal];
          if (!operation || target.target_id !== `${jobId}:${target.ordinal}`)
            throw new ProcessingTaskError("processing-snapshot-invalid");
          try {
            if (active.aborted) throw new QueueInterruptedError();
            const result = await this.perform(
              operation,
              active,
              jobId,
              target.target_id,
            );
            if (
              operation.operation === "parse-documents" &&
              Array.isArray(result.profiles) &&
              result.profiles.some((p) => p.status === "failed")
            ) {
              await this.repository.appendEvent({
                event_id: `parse-partial:${randomUUID()}`,
                job_id: jobId,
                sequence: -1,
                kind: "processing-partial-result",
                payload: {
                  target_id: target.target_id,
                  operation: operation.operation,
                  result,
                },
                created_at: new Date().toISOString(),
              });
              throw new ProcessingTaskError("parser-partial-failure");
            }
            if (
              operation.operation === "build-archive" &&
              result.outcome === "failed"
            ) {
              await this.repository.appendEvent({
                event_id: `archive-partial:${randomUUID()}`,
                job_id: jobId,
                sequence: -1,
                kind: "processing-partial-result",
                payload: {
                  target_id: target.target_id,
                  operation: operation.operation,
                  result,
                },
                created_at: new Date().toISOString(),
              });
              throw new ProcessingTaskError("archive-failed");
            }
            const disposition = [
              "blocked",
              "needs-parse",
              "needs-pdf",
              "excluded",
            ].includes(String(result.outcome))
              ? ("skipped" as const)
              : ("completed" as const);
            await this.repository.appendEvent({
              event_id: resultId,
              job_id: jobId,
              sequence: -1,
              kind: "processing-result",
              payload: {
                target_id: target.target_id,
                operation: operation.operation,
                result,
                disposition,
              },
              created_at: new Date().toISOString(),
            });
            return disposition;
          } catch (error) {
            if (active.aborted) throw new QueueInterruptedError();
            const code =
              error &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "string" &&
              /^[a-z][a-z0-9-]{1,95}$/u.test(error.code)
                ? error.code
                : "processing-failed";
            const unconfigured = [
              "knowledge-unconfigured",
              "agent-role-unconfigured",
              "agent-unconfigured",
              "agent-configuration",
            ].includes(code);
            throw new QueueTargetFailureError({
              code,
              reason:
                error &&
                typeof error === "object" &&
                "reason" in error &&
                typeof error.reason === "string" &&
                /^agent-[a-z-]{1,56}$/u.test(error.reason)
                  ? error.reason
                  : unconfigured
                    ? "The analysis model binding is missing or unavailable."
                    : "The requested product operation did not complete.",
              action: unconfigured
                ? "Configure the analysis model, restart the service, then explicitly retry the task."
                : "Read the failure and retained artifacts before explicitly retrying.",
              retryable: !!(
                error &&
                typeof error === "object" &&
                "retryable" in error &&
                error.retryable === true
              ),
            });
          }
        },
        {
          signal,
          concurrency: hasArchive ? this.maxConcurrent : 1,
          boot_id: this.bootId,
          workspace_id: `processing:${jobId}`,
          max_retries: 0,
          max_targets: request.operations.length,
          stage_for_target: (target) =>
            request.operations[target.ordinal]?.operation === "parse-documents"
              ? "parsing"
              : ["assess-article-identity", "acquire-metadata"].includes(
                    request.operations[target.ordinal]!.operation,
                  )
                ? "literature"
                : "analysis",
        },
      );
    } finally {
      if (hasArchive)
        await this.runtime.archive?.finish(jobId, this.repository);
    }
    if (request.schema_version === 2) {
      if (!this.runtime.processors)
        throw new ProcessingTaskError("processor-unavailable");
      await this.runtime.processors.finish(jobId, request);
    }
    return results;
  }
  private async perform(
    operation: ProcessingOperation,
    signal: AbortSignal,
    jobId: string,
    targetId: string,
  ): Promise<Record<string, unknown>> {
    const input =
      operation.operation === "run-processor" &&
      operation.request.inputs.length === 1
        ? operation.request.inputs[0]
        : null;
    const literature =
      "literature_id" in operation.request
        ? String(operation.request.literature_id)
        : input?.kind === "archive-document"
          ? input.literature_id
          : undefined;
    return withActivity(
      {
        operation: operation.operation,
        target_id: targetId,
        ...(literature ? { literature_id: literature } : {}),
      },
      async () => {
        switch (operation.operation) {
          case "acquire-metadata": {
            if (!this.runtime.metadata)
              throw new ProcessingTaskError("metadata-unavailable");
            const result = await this.runtime.metadata.execute(
              operation.request,
              signal,
              jobId,
              targetId,
            );
            if (result.status === "INTERRUPTED")
              throw new QueueInterruptedError();
            if (result.status === "FAILED") {
              await this.repository.appendEvent({
                event_id: randomUUID(),
                job_id: jobId,
                sequence: -1,
                kind: "processing-partial-result",
                payload: {
                  target_id: targetId,
                  operation: operation.operation,
                  result,
                },
                created_at: new Date().toISOString(),
              });
              throw new QueueTargetFailureError({
                code: "metadata-sources-failed",
                reason:
                  "The selected metadata sources did not complete the task.",
                action: "Review source details before retrying.",
                retryable: true,
              });
            }
            return result;
          }
          case "backfill-tags": {
            if (!this.runtime.tags)
              throw new ProcessingTaskError("tags-unavailable");
            return this.runtime.tags.backfill(
              operation.request.tag_ids,
              false,
              signal,
            );
          }
          case "build-archive": {
            if (!this.runtime.archive)
              throw new ProcessingTaskError("archive-unavailable");
            return this.runtime.archive.build(operation.request, signal, jobId);
          }
          case "run-processor": {
            if (!this.runtime.processors)
              throw new ProcessingTaskError("processor-unavailable");
            return this.runtime.processors.execute(operation.request, signal);
          }
          case "parse-documents": {
            const r = await this.runtime.documents.parseDocuments(
              operation.request,
              signal,
            );
            return { ...r };
          }
          case "assess-article-identity": {
            if (!this.runtime.identity)
              throw new ProcessingTaskError("article-identity-unavailable");
            const r = await this.runtime.identity.assess(
              operation.request,
              signal,
            );
            return {
              assessment_id: r.assessment.assessment_id,
              status: r.assessment.status,
              published: r.published,
            };
          }
        }
      },
    );
  }
}
