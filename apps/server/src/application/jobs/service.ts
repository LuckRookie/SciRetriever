import { randomUUID } from "node:crypto";
import type {
  ExecutionAttempt,
  ExecutionAttemptStage,
  ExecutionTarget,
} from "../../storage/sqlite/worker.js";
import {
  ExecutionRepository,
  type CreateExecutionJobInput,
} from "../../storage/execution/repository.js";
import { canonicalJsonBytes, sha256 } from "@sciretriever/contracts";
import {
  selectLiteratures,
  type LiteratureSelector,
} from "../../entry/selectors.js";
import type { LiteratureQueryService } from "../../literature/query.js";
import type { LiteratureCompletionService } from "../../entry/literature-completion.js";
import type { InterventionService } from "./interventions.js";

export interface ExecutionRunResult {
  readonly target_id: string;
  readonly outcome: "completed" | "skipped" | "failed" | "interrupted";
  readonly failure: ExecutionAttempt["failure"];
}

export type ExecutionTargetHandler = (
  target: ExecutionTarget,
  signal: AbortSignal,
) => Promise<"completed" | "skipped">;

/** A stable handler signal for failures that may consume another bounded attempt. */
export class QueueRetryableError extends Error {
  constructor(message = "execution target is retryable") {
    super(message);
    this.name = "QueueRetryableError";
  }
}

export class QueuePausedError extends Error {
  constructor(readonly failure: ExecutionAttempt["failure"]) {
    super("execution paused for assistance");
    this.name = "QueuePausedError";
  }
}

/**
 * Minimal durable queue. It claims one target at a time for a job, persists
 * each attempt and event, and always releases its lease in a finally block.
 * Browser workspaces can therefore remain single writer while independent
 * jobs are scheduled by a caller.
 */
export class ExecutionQueue {
  constructor(private readonly repository: ExecutionRepository) {}

  createJob(input: CreateExecutionJobInput) {
    return this.repository.createJob(input);
  }

  pause(jobId: string) {
    return this.repository.updateJob(jobId, "paused");
  }

  resume(jobId: string) {
    return this.repository.updateJob(jobId, "queued");
  }

  cancel(jobId: string, finishedAt = new Date().toISOString()) {
    return this.repository.updateJob(jobId, "cancelled", finishedAt);
  }

  async runNext(
    jobId: string,
    handler: ExecutionTargetHandler,
    options: {
      readonly boot_id?: string;
      readonly workspace_id?: string | null;
      readonly now?: string;
      readonly signal?: AbortSignal;
      readonly max_retries?: number;
      readonly retry_delay_ms?: number;
    } = {},
  ): Promise<ExecutionRunResult | null> {
    const bootId = options.boot_id ?? randomUUID();
    const policy = await this.repository.getPolicy(jobId);
    if (!policy) throw new TypeError("execution policy is unavailable");
    const maxRetries = Math.min(
      options.max_retries ?? policy.max_retries,
      policy.max_retries,
    );
    const retryDelay = options.retry_delay_ms ?? 0;
    if (
      !Number.isSafeInteger(maxRetries) ||
      maxRetries < 0 ||
      maxRetries > 100 ||
      !Number.isSafeInteger(retryDelay) ||
      retryDelay < 0 ||
      retryDelay > 86_400_000
    )
      throw new TypeError("execution retry bounds are invalid");
    const leaseId = `lease-${randomUUID()}`;
    const acquiredAt = new Date().toISOString();
    await this.repository.acquireLease({
      lease_id: leaseId,
      job_id: jobId,
      workspace_id: options.workspace_id ?? null,
      boot_id: bootId,
      control_epoch: 0,
      acquired_at: acquiredAt,
      released_at: null,
    });
    try {
      const target = await this.repository.claimTarget(
        jobId,
        options.now ?? new Date().toISOString(),
      );
      if (!target) {
        await this.finalizeJob(jobId);
        return null;
      }
      const attemptBudget = await this.repository.consumeBudget(
        jobId,
        { attempts: 1, network_bytes: 0, model_calls: 0 },
        options.now ?? new Date().toISOString(),
      );
      if (!attemptBudget.accepted) {
        const failure = {
          code: "execution-budget-exhausted",
          reason: "The frozen job attempt budget is exhausted.",
          action: "Create a new job with an explicitly reviewed policy.",
          retryable: false,
        };
        await this.repository.updateTarget(
          target.target_id,
          "skipped",
          "skipped",
        );
        await this.repository.appendEvent({
          event_id: `event-${randomUUID()}`,
          job_id: jobId,
          sequence: await this.nextSequence(jobId),
          kind: "target-budget-exhausted",
          payload: { target_id: target.target_id, failure },
          created_at: new Date().toISOString(),
        });
        await this.finalizeJob(jobId);
        return { target_id: target.target_id, outcome: "skipped", failure };
      }
      const previousAttempts = (
        await this.repository.listAttempts(target.target_id)
      ).length;
      const attemptId = `attempt-${randomUUID()}`;
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        const attemptStage: ExecutionAttemptStage = [
          "acquisition",
          "parsing",
          "analysis",
          "literature",
        ].includes(target.stage)
          ? (target.stage as ExecutionAttemptStage)
          : "acquisition";
        try {
          await this.repository.startAttempt({
            attempt_id: attemptId,
            target_id: target.target_id,
            stage: attemptStage,
            status: "running",
            started_at: acquiredAt,
            finished_at: null,
            failure: null,
            usage: null,
          });
        } catch (error) {
          const retry = previousAttempts < maxRetries;
          await this.repository.updateTarget(
            target.target_id,
            retry ? "queued" : "interrupted",
            retry ? "pending" : "interrupted",
            retry ? new Date(Date.now() + retryDelay).toISOString() : null,
          );
          throw error;
        }
        await this.repository.appendEvent({
          event_id: `event-${randomUUID()}`,
          job_id: jobId,
          sequence: await this.nextSequence(jobId),
          kind: "attempt-started",
          payload: { target_id: target.target_id, attempt_id: attemptId },
          created_at: acquiredAt,
        });
        let outcome: ExecutionRunResult["outcome"] = "completed";
        let failure: ExecutionRunResult["failure"] = null;
        try {
          if (controller.signal.aborted) throw new QueueInterruptedError();
          const result = await handler(target, controller.signal);
          outcome = result;
          await this.repository.updateTarget(
            target.target_id,
            result === "skipped" ? "skipped" : "completed",
            result === "skipped" ? "skipped" : "completed",
          );
          await this.repository.finishAttempt(
            attemptId,
            "completed",
            new Date().toISOString(),
            null,
            null,
          );
        } catch (error) {
          if (error instanceof QueuePausedError) {
            outcome = "interrupted";
            failure = error.failure;
            await this.repository.updateJob(jobId, "paused");
            await this.repository.updateTarget(
              target.target_id,
              "queued",
              "pending",
            );
            await this.repository.finishAttempt(
              attemptId,
              "interrupted",
              new Date().toISOString(),
              failure,
              null,
            );
            await this.repository.appendEvent({
              event_id: `event-${randomUUID()}`,
              job_id: jobId,
              sequence: await this.nextSequence(jobId),
              kind: "attempt-paused-for-assistance",
              payload: {
                target_id: target.target_id,
                attempt_id: attemptId,
                failure,
              },
              created_at: new Date().toISOString(),
            });
            return { target_id: target.target_id, outcome, failure };
          }
          outcome =
            error instanceof QueueInterruptedError ? "interrupted" : "failed";
          const retryable =
            outcome === "interrupted" || error instanceof QueueRetryableError;
          const retry = retryable && previousAttempts < maxRetries;
          failure = {
            code:
              outcome === "interrupted"
                ? "execution-interrupted"
                : "execution-handler-failed",
            reason: "The execution target did not complete.",
            action: "Retry the target after inspecting its persisted attempt.",
            retryable,
          };
          await this.repository.updateTarget(
            target.target_id,
            retry ? "queued" : outcome,
            retry ? "pending" : outcome,
            retry ? new Date(Date.now() + retryDelay).toISOString() : null,
          );
          await this.repository.finishAttempt(
            attemptId,
            outcome,
            new Date().toISOString(),
            failure,
            null,
          );
        }
        await this.repository.appendEvent({
          event_id: `event-${randomUUID()}`,
          job_id: jobId,
          sequence: await this.nextSequence(jobId),
          kind:
            failure?.retryable &&
            (await this.repository.getTarget(target.target_id))?.stage ===
              "queued"
              ? "attempt-retry-scheduled"
              : `attempt-${outcome}`,
          payload: {
            target_id: target.target_id,
            attempt_id: attemptId,
            failure,
          },
          created_at: new Date().toISOString(),
        });
        await this.finalizeJob(jobId);
        return { target_id: target.target_id, outcome, failure };
      } finally {
        options.signal?.removeEventListener("abort", abort);
      }
    } finally {
      await this.repository.releaseLease(leaseId);
    }
  }

  async recover(bootId = randomUUID(), now = new Date().toISOString()) {
    return this.repository.recover(bootId, now);
  }

  private async finalizeJob(jobId: string): Promise<void> {
    const job = await this.repository.getJob(jobId);
    if (!job || ["paused", "cancelled"].includes(job.status)) return;
    const targets = await this.repository.listTargets(jobId);
    if (
      targets.some((target) =>
        ["queued", "acquisition", "parsing", "analysis", "literature"].includes(
          target.stage,
        ),
      )
    )
      return;
    const status = targets.some((target) => target.stage === "failed")
      ? "failed"
      : targets.some((target) => target.stage === "interrupted")
        ? "interrupted"
        : "completed";
    await this.repository.updateJob(jobId, status, new Date().toISOString());
  }

  async runUntilIdle(
    jobId: string,
    handler: ExecutionTargetHandler,
    options: Parameters<ExecutionQueue["runNext"]>[2] & {
      readonly max_targets?: number;
    } = {},
  ): Promise<readonly ExecutionRunResult[]> {
    const results: ExecutionRunResult[] = [];
    const max = options.max_targets ?? 1000;
    if (!Number.isSafeInteger(max) || max < 1 || max > 10000)
      throw new TypeError("execution queue bound is invalid");
    while (results.length < max) {
      const next = await this.runNext(jobId, handler, options);
      if (!next) break;
      results.push(next);
    }
    return Object.freeze(results);
  }

  private async nextSequence(jobId: string): Promise<number> {
    const last = (await this.repository.listEvents(jobId, -1, 1000)).at(-1);
    return last ? last.sequence + 1 : 0;
  }
}

export class ExecutionSchedulerError extends Error {
  readonly code = "execution-scheduler" as const;
  constructor(readonly reason: "workspace-busy" | "concurrency-limit") {
    super("execution scheduler is busy");
    this.name = "ExecutionSchedulerError";
  }
}

/**
 * Bounded in-process scheduler for independent durable jobs. A Browser
 * workspace has one active run at a time; jobs on different workspaces may
 * progress concurrently up to the configured process limit. Durable leases
 * remain the source of truth, so a restart still goes through queue recovery.
 */
export class ExecutionScheduler {
  private readonly active = new Map<
    string,
    Promise<readonly ExecutionRunResult[]>
  >();

  constructor(
    private readonly queue: ExecutionQueue,
    private readonly maxConcurrent = 4,
  ) {
    if (
      !Number.isSafeInteger(maxConcurrent) ||
      maxConcurrent < 1 ||
      maxConcurrent > 64
    )
      throw new TypeError("execution scheduler bound is invalid");
  }

  activeWorkspaces(): readonly string[] {
    return Object.freeze([...this.active.keys()].sort());
  }

  async run(
    jobId: string,
    handler: ExecutionTargetHandler,
    options: Parameters<ExecutionQueue["runUntilIdle"]>[2] & {
      readonly workspace_id?: string | null;
    } = {},
  ): Promise<readonly ExecutionRunResult[]> {
    const workspace = options.workspace_id ?? `job:${jobId}`;
    if (
      typeof workspace !== "string" ||
      !/^[a-zA-Z0-9._:-]{1,128}$/u.test(workspace)
    )
      throw new TypeError("execution workspace is invalid");
    if (this.active.has(workspace))
      throw new ExecutionSchedulerError("workspace-busy");
    if (this.active.size >= this.maxConcurrent)
      throw new ExecutionSchedulerError("concurrency-limit");
    const run = this.queue.runUntilIdle(jobId, handler, {
      ...options,
      workspace_id: workspace,
    });
    this.active.set(workspace, run);
    try {
      return await run;
    } finally {
      if (this.active.get(workspace) === run) this.active.delete(workspace);
    }
  }
}

/** Expands a frozen Literature selector into stable durable targets. */
export class ExecutionJobService {
  constructor(
    private readonly repository: ExecutionRepository,
    private readonly library: Pick<LiteratureQueryService, "search">,
  ) {}

  async create(
    input: Omit<CreateExecutionJobInput, "selector"> & {
      readonly selector: LiteratureSelector;
      readonly goal?: "pdf" | "content";
    },
  ) {
    const selected = await selectLiteratures(this.library, input.selector);
    if (selected.items.length > 10_000)
      throw new TypeError("execution selector is too large");
    const { selector, goal = "content", ...jobInput } = input;
    const job = await this.repository.createJob({
      ...jobInput,
      selector: { schema_version: 1, goal, selector },
    });
    for (const [ordinal, item] of selected.items.entries()) {
      const digest = await sha256(
        canonicalJsonBytes({
          job_id: job.job_id,
          literature_id: item.literature.literature_id,
          ordinal,
        }),
      );
      await this.repository.putTarget({
        target_id: `target-${digest.slice(0, 32)}`,
        job_id: job.job_id,
        ordinal,
        literature_id: item.literature.literature_id,
        version_role: item.literature.version_role,
        stage: "queued",
        disposition: "pending",
        next_eligible_at: null,
      });
    }
    return job;
  }
}

export interface ExecutionTaskRuntime {
  readonly detail: LiteratureQueryService["detail"];
  readonly completion: Pick<LiteratureCompletionService, "complete"> | null;
}

/** Runs durable targets through the existing Literature completion owner. */
export class ExecutionTaskService {
  constructor(
    private readonly repository: ExecutionRepository,
    private readonly queue: ExecutionQueue,
    private readonly interventions: InterventionService,
    private readonly runtime: ExecutionTaskRuntime,
  ) {}

  async runJob(
    jobId: string,
    options: Parameters<ExecutionQueue["runUntilIdle"]>[2] = {},
  ): Promise<readonly ExecutionRunResult[]> {
    const job = await this.repository.getJob(jobId);
    if (!job) throw new TypeError("execution job is unavailable");
    const snapshot =
      job.selector &&
      typeof job.selector === "object" &&
      !Array.isArray(job.selector) &&
      "selector" in job.selector
        ? (job.selector as { selector: unknown; goal?: unknown })
        : { selector: job.selector, goal: "content" as const };
    const goal = snapshot.goal === "pdf" ? "pdf" : "content";
    const failure = {
      code:
        goal === "pdf"
          ? "pdf-acquisition-required"
          : "content-completion-unavailable",
      reason:
        goal === "pdf"
          ? "No durable primary PDF is available for this target."
          : "The target cannot continue without the configured completion services.",
      action:
        goal === "pdf"
          ? "Provide a verified PDF or run an admitted acquisition route."
          : "Configure Parsing and Analysis, then resume the task.",
      retryable: false,
    } as const;
    return this.queue.runUntilIdle(
      jobId,
      async (target, signal) => {
        if (!target.literature_id) return "skipped";
        const detail = await this.runtime.detail(target.literature_id);
        if (goal === "pdf") {
          if (detail.primary_pdf) return "completed";
          const intervention = await this.interventions.request({
            job_id: jobId,
            target_id: target.target_id,
            failure,
          });
          if (intervention.status === "open" && intervention.mode === "pause")
            throw new QueuePausedError(failure);
          return "skipped";
        }
        if (detail.content) return "completed";
        if (!this.runtime.completion) {
          const intervention = await this.interventions.request({
            job_id: jobId,
            target_id: target.target_id,
            failure,
          });
          if (intervention.status === "open" && intervention.mode === "pause")
            throw new QueuePausedError(failure);
          return "skipped";
        }
        const result = await this.runtime.completion.complete(
          { literature_id: target.literature_id, transfer_ids: [] },
          signal,
        );
        if (result.outcome === "content_ready") return "completed";
        const intervention = await this.interventions.request({
          job_id: jobId,
          target_id: target.target_id,
          failure,
        });
        if (intervention.status === "open" && intervention.mode === "pause")
          throw new QueuePausedError(failure);
        return "skipped";
      },
      options,
    );
  }
}

export class QueueInterruptedError extends Error {
  constructor() {
    super("execution interrupted");
    this.name = "QueueInterruptedError";
  }
}
