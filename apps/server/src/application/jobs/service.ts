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
  parseLiteratureId,
  parseMetaLiteratureId,
  type BatchGoal,
  type CompletionTarget,
  type StableFailure,
} from "@sciretriever/contracts";
import type { LiteratureSelector } from "../../entry/selectors.js";
import type { LiteratureQueryService } from "../../literature/query.js";
import {
  DatabaseCompletionService,
  type DatabaseCompletionTargetOutcome,
  type FrozenCompletionTarget,
} from "../../entry/database-completion.js";
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

export interface ExecutionRunOptions {
  readonly boot_id?: string;
  readonly workspace_id?: string | null;
  readonly now?: string;
  readonly signal?: AbortSignal;
  readonly max_retries?: number;
  readonly retry_delay_ms?: number;
  readonly stage_for_target?: (
    target: ExecutionTarget,
  ) => ExecutionAttemptStage;
}

export interface ExecutionBatchRunOptions extends ExecutionRunOptions {
  readonly max_targets?: number;
}

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

/** Stable Entry failure propagated into the durable attempt without reclassification. */
export class QueueTargetFailureError extends Error {
  constructor(readonly failure: NonNullable<ExecutionAttempt["failure"]>) {
    super("execution target failed");
    this.name = "QueueTargetFailureError";
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
    return this.repository.controlJob(jobId, "paused");
  }

  resume(jobId: string) {
    return this.repository.updateJob(jobId, "queued");
  }

  cancel(jobId: string, finishedAt = new Date().toISOString()) {
    return this.repository.controlJob(jobId, "cancelled", finishedAt);
  }

  runNext(
    jobId: string,
    handler: ExecutionTargetHandler,
    options: ExecutionRunOptions = {},
  ): Promise<ExecutionRunResult | null> {
    return this.repository.withRuntime(() =>
      this.runNextOwned(jobId, handler, options),
    );
  }

  private async runNextOwned(
    jobId: string,
    handler: ExecutionTargetHandler,
    options: ExecutionRunOptions,
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
          sequence: -1,
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
      if (options.signal?.aborted) abort();
      try {
        const attemptStage: ExecutionAttemptStage =
          options.stage_for_target?.(target) ??
          (["acquisition", "parsing", "analysis", "literature"].includes(
            target.stage,
          )
            ? (target.stage as ExecutionAttemptStage)
            : "acquisition");
        try {
          if (options.stage_for_target)
            await this.repository.updateTarget(
              target.target_id,
              attemptStage,
              "pending",
            );
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
          sequence: -1,
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
              sequence: -1,
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
            outcome === "interrupted" ||
            error instanceof QueueRetryableError ||
            (error instanceof QueueTargetFailureError &&
              error.failure.retryable);
          const retry = retryable && previousAttempts < maxRetries;
          failure =
            error instanceof QueueTargetFailureError
              ? error.failure
              : {
                  code:
                    outcome === "interrupted"
                      ? "execution-interrupted"
                      : "execution-handler-failed",
                  reason: "The execution target did not complete.",
                  action:
                    "Retry the target after inspecting its persisted attempt.",
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
          sequence: -1,
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
    await this.repository.updateJobIfActive(
      jobId,
      status,
      new Date().toISOString(),
    );
  }

  runUntilIdle(
    jobId: string,
    handler: ExecutionTargetHandler,
    options: ExecutionBatchRunOptions = {},
  ): Promise<readonly ExecutionRunResult[]> {
    return this.repository.withRuntime(() =>
      this.runUntilIdleOwned(jobId, handler, options),
    );
  }

  private async runUntilIdleOwned(
    jobId: string,
    handler: ExecutionTargetHandler,
    options: ExecutionBatchRunOptions,
  ): Promise<readonly ExecutionRunResult[]> {
    const results: ExecutionRunResult[] = [];
    const max = options.max_targets ?? 1000;
    if (!Number.isSafeInteger(max) || max < 1 || max > 10000)
      throw new TypeError("execution queue bound is invalid");
    while (results.length < max) {
      if (options.signal?.aborted) break;
      const next = await this.runNext(jobId, handler, options);
      if (!next) break;
      results.push(next);
    }
    return Object.freeze(results);
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
    private readonly completion: DatabaseCompletionService,
    private readonly library: Pick<LiteratureQueryService, "detail">,
  ) {}

  async create(
    input: Omit<CreateExecutionJobInput, "selector"> & {
      readonly selector: LiteratureSelector;
      readonly goal?: "pdf" | "content";
    },
  ) {
    const { selector, goal = "content", ...jobInput } = input;
    const jobId =
      jobInput.job_id ??
      `job-${(
        await sha256(
          canonicalJsonBytes({ idempotency_key: jobInput.idempotency_key }),
        )
      ).slice(0, 32)}`;
    const existing = await this.repository.getJob(jobId);
    if (existing) {
      const saved = existing.selector as { selector?: unknown; goal?: unknown };
      if (
        existing.idempotency_key !== jobInput.idempotency_key ||
        existing.target_kind !== jobInput.target_kind ||
        existing.policy_version !== jobInput.policy_version ||
        saved.goal !== goal ||
        !Buffer.from(canonicalJsonBytes(saved.selector)).equals(
          Buffer.from(canonicalJsonBytes(selector)),
        )
      )
        throw new TypeError("execution job idempotency conflict");
      return this.repository.createJob({
        ...jobInput,
        job_id: jobId,
        selector: existing.selector,
      });
    }
    const frozen = await this.completion.freezeRequest({
      selector,
      goal: goal === "pdf" ? "ASSET_READY" : "CONTENT_READY",
    });
    if (frozen.length > 10_000)
      throw new TypeError("execution selector is too large");
    const targetInputs: ExecutionTarget[] = [];
    for (const [ordinal, item] of frozen.entries()) {
      const digest = await sha256(
        canonicalJsonBytes({
          job_id: jobId,
          target: item.target,
          ordinal,
        }),
      );
      targetInputs.push({
        target_id: `target-${digest.slice(0, 32)}`,
        job_id: jobId,
        ordinal,
        literature_id: item.candidates[0] ?? null,
        version_role: (await this.library.detail(item.candidates[0]!))
          .literature.version_role,
        stage: "queued",
        disposition: "pending",
        next_eligible_at: null,
      });
    }
    return this.repository.createJob({
      ...jobInput,
      job_id: jobId,
      selector: { schema_version: 2, goal, selector, frozen_targets: frozen },
      targets: targetInputs,
    });
  }
}

export interface ExecutionTaskRuntime {
  readonly completion: DatabaseCompletionService;
}

/**
 * Adapts the complete Entry operation to the existing durable Job wire. The
 * operation owns cohort and report decisions; Jobs own leases, budgets,
 * attempts, intervention policy and events.
 */
export class ExecutionTaskService {
  constructor(
    private readonly repository: ExecutionRepository,
    _queue: ExecutionQueue,
    private readonly interventions: InterventionService,
    private readonly runtime: ExecutionTaskRuntime,
  ) {
    // Keep the existing public constructor wire. The complete Entry operation
    // now owns target execution, while this service owns its durable records.
    void _queue;
  }

  runJob(
    jobId: string,
    options: Parameters<ExecutionQueue["runUntilIdle"]>[2] = {},
  ): Promise<readonly ExecutionRunResult[]> {
    return this.repository.withRuntime(() => this.runJobOwned(jobId, options));
  }

  private async runJobOwned(
    jobId: string,
    options: ExecutionBatchRunOptions,
  ): Promise<readonly ExecutionRunResult[]> {
    const job = await this.repository.getJob(jobId);
    if (!job) throw new TypeError("execution job is unavailable");
    if (!["queued", "running"].includes(job.status)) return [];
    const max = options.max_targets ?? 1000;
    if (!Number.isSafeInteger(max) || max < 1 || max > 10000)
      throw new TypeError("execution queue bound is invalid");
    const maxRetries = Math.min(options.max_retries ?? 100, 100);
    const retryDelay = options.retry_delay_ms ?? 0;
    if (
      !Number.isSafeInteger(maxRetries) ||
      maxRetries < 0 ||
      !Number.isSafeInteger(retryDelay) ||
      retryDelay < 0 ||
      retryDelay > 86_400_000
    )
      throw new TypeError("execution retry bounds are invalid");
    const all = await this.repository.listTargets(jobId, 10000);
    const snapshot = decodeCompletionSnapshot(job.selector, all);
    const eligibleAt = options.now ?? new Date().toISOString();
    const eligible = all
      .filter(
        (target) =>
          target.stage === "queued" &&
          (target.next_eligible_at === null ||
            target.next_eligible_at <= eligibleAt),
      )
      .slice(0, max);
    if (!eligible.length) {
      await this.finalize(jobId);
      return [];
    }
    const policy = await this.repository.getPolicy(jobId);
    const budget = await this.repository.getBudget(jobId);
    if (!policy || !budget)
      throw new TypeError("execution policy is unavailable");
    const leaseId = `lease-${randomUUID()}`;
    await this.repository.acquireLease({
      lease_id: leaseId,
      job_id: jobId,
      workspace_id: options.workspace_id ?? null,
      boot_id: options.boot_id ?? randomUUID(),
      control_epoch: 0,
      acquired_at: new Date().toISOString(),
      released_at: null,
    });
    try {
      // The operator may pause or cancel between the initial read and lease.
      if (
        !["queued", "running"].includes(
          (await this.repository.getJob(jobId))!.status,
        )
      )
        return [];
      const available = Math.max(0, budget.max_attempts - budget.attempts);
      const admitted = eligible.slice(0, available);
      const selected = admitted.map((row) => snapshot.targets[row.ordinal]!);
      const selectedRows = new Map(
        selected.map((item, index) => [
          targetKey(item.target),
          admitted[index]!,
        ]),
      );
      const attemptIds = new Map<string, string>();
      const settled = new Map<string, ExecutionRunResult>();
      const report = selected.length
        ? await this.runtime.completion.runFrozen(selected, snapshot.goal, {
            signal: options.signal,
            on_target_start: async (target) => {
              const row = selectedRows.get(targetKey(target));
              if (!row)
                throw new TypeError("frozen execution target is unavailable");
              // The durable claim atomically checks queued/running status and
              // changes the first queued Job to running. A pause/cancel wins
              // by refusing this target before budget or attempt creation.
              const claimed = await this.repository.claimTarget(
                jobId,
                eligibleAt,
                row.target_id,
              );
              if (!claimed) return false;
              const claim = await this.repository.consumeBudget(jobId, {
                attempts: 1,
                network_bytes: 0,
                model_calls: 0,
              });
              if (!claim.accepted)
                throw new TypeError(
                  "execution attempt budget changed during admission",
                );
              const attemptId = `attempt-${randomUUID()}`;
              await this.repository.startAttempt({
                attempt_id: attemptId,
                target_id: row.target_id,
                stage: "acquisition",
                status: "running",
                started_at: new Date().toISOString(),
                finished_at: null,
                failure: null,
                usage: null,
              });
              attemptIds.set(row.target_id, attemptId);
              await this.event(jobId, "attempt-started", {
                target_id: row.target_id,
                attempt_id: attemptId,
              });
              return true;
            },
            on_target_finish: async (target, outcome) => {
              const key = targetKey(target);
              const row = selectedRows.get(key);
              if (!row)
                throw new TypeError("frozen execution target is unavailable");
              const result = await this.settleTarget(
                jobId,
                row,
                attemptIds.get(row.target_id) ?? null,
                outcome,
                snapshot.goal,
                Math.min(policy.max_retries, maxRetries),
                retryDelay,
              );
              settled.set(row.target_id, result.result);
              return result.stopAdmission;
            },
          })
        : null;
      // A failed settlement hook is converted by Entry to an operation failure.
      // Give its attempt a stable terminal record if the repository is still
      // available; do not leave a running attempt merely because UX failed.
      if (report) {
        for (const failed of report.failed) {
          const row = selectedRows.get(targetKey(failed.target));
          if (!row || settled.has(row.target_id)) continue;
          const result = await this.finishFailedSettlement(
            jobId,
            row,
            attemptIds.get(row.target_id) ?? null,
            failed.failure,
          );
          settled.set(row.target_id, result);
        }
      }
      const results: ExecutionRunResult[] = admitted.flatMap((row) => {
        const result = settled.get(row.target_id);
        return result ? [result] : [];
      });
      if (report?.end.kind === "failed")
        await this.repository.updateJobIfActive(
          jobId,
          "failed",
          new Date().toISOString(),
        );
      else if (report?.end.kind === "interrupted") {
        if (
          options.signal?.aborted ||
          !(await this.repository.listTargets(jobId, 10000)).some(
            (row) => row.stage === "queued",
          )
        )
          await this.repository.updateJobIfActive(
            jobId,
            "interrupted",
            new Date().toISOString(),
          );
      } else if (report?.end.kind === "finished" || !report) {
        if (
          !["queued", "running"].includes(
            (await this.repository.getJob(jobId))!.status,
          )
        )
          return Object.freeze(results);
        for (const row of eligible.slice(available)) {
          const failure = {
            code: "execution-budget-exhausted",
            reason: "The frozen job attempt budget is exhausted.",
            action: "Create a new job with an explicitly reviewed policy.",
            retryable: false,
          };
          await this.repository.updateTarget(
            row.target_id,
            "skipped",
            "skipped",
          );
          await this.event(jobId, "target-budget-exhausted", {
            target_id: row.target_id,
            failure,
          });
          results.push({
            target_id: row.target_id,
            outcome: "skipped",
            failure,
          });
        }
        await this.finalize(jobId);
      }
      return Object.freeze(results);
    } finally {
      await this.repository.releaseLease(leaseId);
    }
  }

  private async settleTarget(
    jobId: string,
    row: ExecutionTarget,
    attemptId: string | null,
    outcome: DatabaseCompletionTargetOutcome,
    goal: BatchGoal,
    maxRetries: number,
    retryDelay: number,
  ): Promise<{ result: ExecutionRunResult; stopAdmission: boolean }> {
    const failure =
      outcome.failure ??
      (outcome.partition === "interrupted"
        ? {
            code: "execution-interrupted",
            reason: "The execution target did not complete.",
            action: "Retry the target after inspecting its persisted attempt.",
            retryable: true,
          }
        : outcome.partition === "completed" ||
            (outcome.partition === "skipped" &&
              outcome.skipped_reason !== "manual-pdf-required")
          ? null
          : completionFallback(goal));
    const active = ["queued", "running"].includes(
      (await this.repository.getJob(jobId))!.status,
    );
    let result: ExecutionRunResult;
    let stage: ExecutionTarget["stage"];
    let disposition: ExecutionTarget["disposition"];
    let attemptStatus: ExecutionAttempt["status"];
    let eventKind: string;
    let stopAdmission = !active;
    let nextEligibleAt: string | null = null;
    if (outcome.partition === "completed") {
      result = {
        target_id: row.target_id,
        outcome: "completed",
        failure: null,
      };
      stage = "completed";
      disposition = "completed";
      attemptStatus = "completed";
      eventKind = "attempt-completed";
    } else if (outcome.operation_failure) {
      result = { target_id: row.target_id, outcome: "failed", failure };
      stage = "failed";
      disposition = "failed";
      attemptStatus = "failed";
      eventKind = "attempt-failed";
    } else if (outcome.partition === "interrupted") {
      const previousAttempts = (
        await this.repository.listAttempts(row.target_id)
      ).length;
      const retry = active && previousAttempts <= maxRetries;
      result = { target_id: row.target_id, outcome: "interrupted", failure };
      stage = retry ? "queued" : "interrupted";
      disposition = retry ? "pending" : "interrupted";
      attemptStatus = "interrupted";
      eventKind = retry ? "attempt-retry-scheduled" : "attempt-interrupted";
      nextEligibleAt = retry
        ? new Date(Date.now() + retryDelay).toISOString()
        : null;
    } else if (outcome.partition === "skipped" && failure === null) {
      result = { target_id: row.target_id, outcome: "skipped", failure: null };
      stage = "skipped";
      disposition = "skipped";
      attemptStatus = "completed";
      eventKind = "attempt-skipped";
    } else {
      // A pause or cancel can arrive while this target runs. Its committed
      // materials survive, but no new operator request is created afterwards.
      const intervention = active
        ? await this.interventions.request(
            {
              job_id: jobId,
              target_id: row.target_id,
              failure: failure!,
            },
            true,
          )
        : null;
      const pause =
        intervention?.status === "open" && intervention.mode === "pause";
      if (pause) {
        stopAdmission = true;
      }
      if (active && intervention === null) stopAdmission = true;
      result = {
        target_id: row.target_id,
        outcome: pause ? "interrupted" : "skipped",
        failure,
      };
      stage = pause ? "queued" : "skipped";
      disposition = pause ? "pending" : "skipped";
      attemptStatus = pause ? "interrupted" : "completed";
      eventKind = pause ? "attempt-paused-for-assistance" : "attempt-skipped";
    }
    await this.repository.updateTarget(
      row.target_id,
      stage,
      disposition,
      nextEligibleAt,
    );
    if (attemptId) {
      await this.repository.finishAttempt(
        attemptId,
        attemptStatus,
        new Date().toISOString(),
        attemptStatus === "completed" && result.outcome === "completed"
          ? null
          : failure,
        null,
      );
      await this.event(jobId, eventKind, {
        target_id: row.target_id,
        attempt_id: attemptId,
        failure: result.outcome === "completed" ? null : failure,
        skipped_reason: outcome.skipped_reason,
      });
    }
    return { result, stopAdmission };
  }

  private async finishFailedSettlement(
    jobId: string,
    row: ExecutionTarget,
    attemptId: string | null,
    failure: StableFailure,
  ): Promise<ExecutionRunResult> {
    await this.repository.updateTarget(row.target_id, "failed", "failed");
    if (attemptId) {
      await this.repository.finishAttempt(
        attemptId,
        "failed",
        new Date().toISOString(),
        failure,
        null,
      );
      await this.event(jobId, "attempt-failed", {
        target_id: row.target_id,
        attempt_id: attemptId,
        failure,
      });
    }
    return { target_id: row.target_id, outcome: "failed", failure };
  }

  private async event(
    jobId: string,
    kind: string,
    payload: unknown,
  ): Promise<void> {
    await this.repository.appendEvent({
      event_id: `event-${randomUUID()}`,
      job_id: jobId,
      sequence: -1,
      kind,
      payload,
      created_at: new Date().toISOString(),
    });
  }

  private async finalize(jobId: string): Promise<void> {
    const job = await this.repository.getJob(jobId);
    if (
      !job ||
      ["paused", "cancelled", "failed", "interrupted"].includes(job.status)
    )
      return;
    const targets = await this.repository.listTargets(jobId, 10000);
    if (
      targets.some((target) =>
        ["queued", "acquisition", "parsing", "analysis", "literature"].includes(
          target.stage,
        ),
      )
    )
      return;
    await this.repository.updateJobIfActive(
      jobId,
      targets.some((target) => target.stage === "failed")
        ? "failed"
        : "completed",
      new Date().toISOString(),
    );
  }
}

function targetKey(target: CompletionTarget): string {
  return target.kind === "literature"
    ? `literature:${target.literature_id}`
    : `meta-literature:${target.meta_literature_id}`;
}

function completionFallback(goal: BatchGoal): StableFailure {
  return goal === "ASSET_READY"
    ? {
        code: "pdf-acquisition-required",
        reason: "No durable primary PDF is available for this target.",
        action: "Provide a verified PDF or run an admitted acquisition route.",
        retryable: false,
      }
    : {
        code: "content-completion-unavailable",
        reason:
          "The target cannot continue without the configured completion services.",
        action: "Configure Parsing and Analysis, then resume the task.",
        retryable: false,
      };
}

function decodeCompletionSnapshot(
  selector: unknown,
  rows: readonly ExecutionTarget[],
): { goal: BatchGoal; targets: readonly FrozenCompletionTarget[] } {
  const source =
    selector && typeof selector === "object" && !Array.isArray(selector)
      ? (selector as Record<string, unknown>)
      : {};
  const goal: BatchGoal =
    source.goal === "pdf" ? "ASSET_READY" : "CONTENT_READY";
  if (source.schema_version === undefined || source.schema_version === 1) {
    return {
      goal,
      targets: rows.map((row) => {
        if (!row.literature_id)
          throw new TypeError("legacy execution target is invalid");
        const id = parseLiteratureId(row.literature_id);
        return {
          target: { kind: "literature", literature_id: id },
          candidates: [id],
          // v1 Jobs never cleared a prior automatic exhaustion fact.
          clear_exhaustion: false,
        };
      }),
    };
  }
  if (source.schema_version !== 2)
    throw new TypeError("execution selector version is unsupported");
  if (
    !Array.isArray(source.frozen_targets) ||
    source.frozen_targets.length !== rows.length
  )
    throw new TypeError("frozen execution targets are invalid");
  return {
    goal,
    targets: source.frozen_targets.map((value: unknown, index: number) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("frozen execution target is invalid");
      const item = value as Record<string, unknown>;
      const raw = item.target as Record<string, unknown>;
      if (
        !raw ||
        typeof raw !== "object" ||
        !Array.isArray(item.candidates) ||
        item.candidates.length === 0 ||
        typeof item.clear_exhaustion !== "boolean"
      )
        throw new TypeError("frozen execution target is invalid");
      const target: CompletionTarget =
        raw.kind === "literature"
          ? {
              kind: "literature",
              literature_id: parseLiteratureId(raw.literature_id),
            }
          : raw.kind === "meta-literature"
            ? {
                kind: "meta-literature",
                meta_literature_id: parseMetaLiteratureId(
                  raw.meta_literature_id,
                ),
              }
            : (() => {
                throw new TypeError("frozen execution target is invalid");
              })();
      const candidates = item.candidates.map((id: unknown) =>
        parseLiteratureId(id),
      );
      if (
        rows[index]?.ordinal !== index ||
        rows[index]?.literature_id !== candidates[0]
      )
        throw new TypeError(
          "frozen execution target does not match its durable row",
        );
      return { target, candidates, clear_exhaustion: item.clear_exhaustion };
    }),
  };
}

export class QueueInterruptedError extends Error {
  constructor() {
    super("execution interrupted");
    this.name = "QueueInterruptedError";
  }
}
