import { activityContext, withActivity } from "../../logging/activity.js";
import { randomUUID } from "node:crypto";
import { canonicalJsonBytes, sha256 } from "@sciretriever/contracts";
import {
  SqliteWorker,
  type ExecutionAttempt,
  type ExecutionEvent,
  type ExecutionJob,
  type ExecutionJobListItem,
  type ExecutionJobCursor,
  type ExecutionJobStatus,
  type ExecutionLease,
  type ExecutionBudget,
  type ExecutionBudgetClaim,
  type ExecutionBudgetUsage,
  type ExecutionIntervention,
  type ExecutionPolicySnapshot,
  type ExecutionRuntimeInspection,
  type ExecutionRecoveryResult,
  type ExecutionTarget,
  type ExecutionTargetStage,
} from "../sqlite/worker.js";

export interface CreateExecutionJobInput {
  readonly job_id?: string;
  readonly target_kind: ExecutionJob["target_kind"];
  readonly selector: unknown;
  readonly policy_version: string;
  readonly policy: Partial<ExecutionPolicySnapshot>;
  readonly idempotency_key: string;
  readonly created_at?: string;
  /** Targets are inserted in the same worker transaction as the job when supplied. */
  readonly targets?: readonly ExecutionTarget[];
}

const DEFAULT_POLICY: ExecutionPolicySnapshot = Object.freeze({
  mode: "never",
  max_retries: 0,
  max_attempts: 1000,
  max_network_bytes: 1024 * 1024 * 1024,
  max_model_calls: 1000,
  intervention_timeout_ms: 24 * 60 * 60 * 1000,
});

export function normalizeExecutionPolicy(
  value: Partial<ExecutionPolicySnapshot>,
): ExecutionPolicySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("execution policy is invalid");
  const allowed = new Set(Object.keys(DEFAULT_POLICY));
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new TypeError("execution policy is invalid");
  const policy = { ...DEFAULT_POLICY, ...value };
  const validInteger = (item: number, minimum: number, maximum: number) =>
    Number.isSafeInteger(item) && item >= minimum && item <= maximum;
  if (
    !["never", "notify", "pause"].includes(policy.mode) ||
    !validInteger(policy.max_retries, 0, 100) ||
    !validInteger(policy.max_attempts, 1, 100000) ||
    !validInteger(policy.max_network_bytes, 1, 1_099_511_627_776) ||
    !validInteger(policy.max_model_calls, 0, 100000) ||
    !validInteger(policy.intervention_timeout_ms, 1000, 604_800_000)
  )
    throw new TypeError("execution policy is invalid");
  return Object.freeze(policy);
}

/** Typed repository for the v2 durable execution surface. */
export class ExecutionRepository {
  constructor(private readonly database: SqliteWorker) {}

  withRuntime<T>(operation: () => Promise<T>): Promise<T> {
    return this.database.withExecutionRuntime(operation);
  }

  inspect(): Promise<ExecutionRuntimeInspection> {
    return this.database.inspectExecutionRuntime();
  }

  async createJob(input: CreateExecutionJobInput): Promise<ExecutionJob> {
    const createdAt = input.created_at ?? new Date().toISOString();
    const policy = normalizeExecutionPolicy(input.policy);
    const selectorBytes = canonicalJsonBytes(input.selector);
    // Schema v2 snapshots include the frozen MetaLiterature candidate lists.
    // Ten thousand bounded targets can exceed the legacy selector-only cap.
    const selectorLimit =
      input.selector &&
      typeof input.selector === "object" &&
      "schema_version" in input.selector &&
      (input.selector.schema_version === 2 ||
        input.selector.schema_version === 3)
        ? 4_194_304
        : 65_536;
    if (selectorBytes.byteLength > selectorLimit)
      throw new TypeError("execution selector is invalid");
    const job: ExecutionJob = {
      job_id: input.job_id ?? `job-${randomUUID()}`,
      target_kind: input.target_kind,
      selector: input.selector,
      policy_version: input.policy_version,
      status: "queued",
      idempotency_key: input.idempotency_key,
      created_at: createdAt,
      finished_at: null,
    };
    const context = activityContext();
    return this.database.createExecutionJob(
      job,
      await sha256(canonicalJsonBytes(policy)),
      policy,
      input.targets ?? [],
      { actor: context.actor, operation: context.operation ?? "task-create" },
    );
  }
  async withOrigin<T>(jobId: string, action: () => Promise<T>): Promise<T> {
    const origin = await this.database.review<{
      actor: string;
      operation: string;
    } | null>("job-origin-get", { job_id: jobId });
    return withActivity(
      {
        actor: origin?.actor ?? "historical:unknown",
        job_id: jobId,
        operation: origin?.operation ?? "task-run",
      },
      action,
    );
  }

  getJob(jobId: string): Promise<ExecutionJob | null> {
    return this.database.getExecutionJob(jobId);
  }
  getPolicy(jobId: string): Promise<ExecutionPolicySnapshot | null> {
    return this.database.getExecutionPolicy(jobId);
  }
  getBudget(jobId: string): Promise<ExecutionBudget | null> {
    return this.database.getExecutionBudget(jobId);
  }
  consumeBudget(
    jobId: string,
    usage: ExecutionBudgetUsage,
    now?: string,
  ): Promise<ExecutionBudgetClaim> {
    return this.database.consumeExecutionBudget(jobId, usage, now);
  }

  listJobs(
    limit = 100,
    order: "oldest" | "newest" | "finished" = "oldest",
    before: ExecutionJobCursor | null = null,
    statuses: readonly ExecutionJobStatus[] = [],
  ): Promise<readonly ExecutionJobListItem[]> {
    return this.database.listExecutionJobs(limit, order, before, statuses);
  }
  listTargets(
    jobId: string,
    limit = 1000,
  ): Promise<readonly ExecutionTarget[]> {
    return this.database.listExecutionTargets(jobId, limit);
  }
  listAttempts(
    targetId: string,
    limit = 1000,
  ): Promise<readonly ExecutionAttempt[]> {
    return this.database.listExecutionAttempts(targetId, limit);
  }
  recover(bootId: string, now?: string): Promise<ExecutionRecoveryResult> {
    return this.database.recoverExecution(bootId, now);
  }

  updateJob(
    jobId: string,
    status: ExecutionJobStatus,
    finishedAt: string | null = null,
  ): Promise<ExecutionJob> {
    return this.database.updateExecutionJob(jobId, status, finishedAt);
  }

  /** Operator control uses a short SQLite transaction outside long Entry admission. */
  controlJob(
    jobId: string,
    status: "paused" | "cancelled",
    finishedAt: string | null = null,
  ): Promise<ExecutionJob> {
    return this.database.controlExecutionJob(jobId, status, finishedAt);
  }

  /** Preserve an external pause/cancel that wins the race with finalization. */
  updateJobIfActive(
    jobId: string,
    status: ExecutionJobStatus,
    finishedAt: string | null = null,
  ): Promise<ExecutionJob> {
    return this.database.updateExecutionJob(jobId, status, finishedAt, true);
  }

  putTarget(target: ExecutionTarget): Promise<ExecutionTarget> {
    return this.database.putExecutionTarget(target);
  }

  getTarget(targetId: string): Promise<ExecutionTarget | null> {
    return this.database.getExecutionTarget(targetId);
  }

  claimTarget(
    jobId: string,
    now = new Date().toISOString(),
    targetId: string | null = null,
  ): Promise<ExecutionTarget | null> {
    return this.database.claimExecutionTarget(jobId, now, targetId);
  }

  updateTarget(
    targetId: string,
    stage: ExecutionTargetStage,
    disposition: ExecutionTarget["disposition"],
    nextEligibleAt: string | null = null,
  ): Promise<ExecutionTarget> {
    return this.database.updateExecutionTarget(
      targetId,
      stage,
      disposition,
      nextEligibleAt,
    );
  }

  startAttempt(attempt: ExecutionAttempt): Promise<ExecutionAttempt> {
    return this.database.startExecutionAttempt(attempt);
  }

  finishAttempt(
    attemptId: string,
    status: ExecutionAttempt["status"],
    finishedAt = new Date().toISOString(),
    failure: ExecutionAttempt["failure"] = null,
    usage: unknown = null,
  ): Promise<ExecutionAttempt> {
    return this.database.finishExecutionAttempt(
      attemptId,
      status,
      finishedAt,
      failure,
      usage,
    );
  }

  appendEvent(event: ExecutionEvent): Promise<ExecutionEvent> {
    return this.database.appendExecutionEvent(event);
  }

  listEvents(
    jobId: string,
    after = -1,
    limit = 100,
    order: "oldest" | "newest" = "oldest",
  ): Promise<readonly ExecutionEvent[]> {
    return this.database.listExecutionEvents(jobId, after, limit, order);
  }

  /** Separate from the technical event tail; bounded, oldest-first pagination. */
  async acquisitionEvents(
    jobId: string,
  ): Promise<{ events: readonly ExecutionEvent[]; truncated: boolean }> {
    const events: ExecutionEvent[] = [];
    let after = -1;
    while (events.length < 10000) {
      const page = await this.database.listExecutionEvents(
        jobId,
        after,
        1000,
        "oldest",
        true,
      );
      events.push(...page);
      if (page.length < 1000) return { events, truncated: false };
      after = page.at(-1)!.sequence;
    }
    return {
      events,
      truncated:
        (
          await this.database.listExecutionEvents(
            jobId,
            after,
            1,
            "oldest",
            true,
          )
        ).length > 0,
    };
  }

  putIntervention(
    intervention: ExecutionIntervention,
  ): Promise<ExecutionIntervention> {
    return this.database.putExecutionIntervention(intervention);
  }
  putInterventionIfActive(
    intervention: ExecutionIntervention,
  ): Promise<ExecutionIntervention | null> {
    return this.database.putExecutionInterventionIfActive(intervention);
  }

  listInterventions(
    jobId: string,
    limit = 100,
  ): Promise<readonly ExecutionIntervention[]> {
    return this.database.listExecutionInterventions(jobId, limit);
  }

  resolveIntervention(
    interventionId: string,
    status: "resolved" | "expired",
    resolution: unknown,
    resolvedAt?: string,
  ): Promise<ExecutionIntervention> {
    return this.database.resolveExecutionIntervention(
      interventionId,
      status,
      resolution,
      resolvedAt,
    );
  }

  acquireLease(lease: ExecutionLease): Promise<ExecutionLease> {
    return this.database.acquireExecutionLease(lease);
  }

  releaseLease(
    leaseId: string,
    releasedAt = new Date().toISOString(),
  ): Promise<boolean> {
    return this.database.releaseExecutionLease(leaseId, releasedAt);
  }
}
