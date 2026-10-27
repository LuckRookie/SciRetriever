import type { RestartAdmission } from "../restart-admission.js";
import { randomUUID } from "node:crypto";
import type { StableFailure } from "@sciretriever/contracts";
import type { ExecutionIntervention } from "../../storage/sqlite/worker.js";
import { ExecutionRepository } from "../../storage/execution/repository.js";

export type InterventionResolution = "continue" | "skip" | "cancel";
export function parseInterventionResolution(
  value: unknown,
): InterventionResolution {
  if (!["continue", "skip", "cancel"].includes(String(value)))
    throw new TypeError("execution intervention resolution is invalid");
  return value as InterventionResolution;
}

/** Applies the frozen assistance policy without turning every failure into user work. */
export class InterventionService {
  constructor(
    private readonly repository: ExecutionRepository,
    private readonly admission?: RestartAdmission,
  ) {}

  request(input: {
    readonly job_id: string;
    readonly target_id?: string | null;
    readonly failure: StableFailure;
    readonly created_at?: string;
  }): Promise<ExecutionIntervention>;
  request(
    input: {
      readonly job_id: string;
      readonly target_id?: string | null;
      readonly failure: StableFailure;
      readonly created_at?: string;
    },
    onlyIfActive: true,
  ): Promise<ExecutionIntervention | null>;
  async request(
    input: {
      readonly job_id: string;
      readonly target_id?: string | null;
      readonly failure: StableFailure;
      readonly created_at?: string;
    },
    onlyIfActive = false,
  ): Promise<ExecutionIntervention | null> {
    const policy = await this.repository.getPolicy(input.job_id);
    if (!policy) throw new TypeError("execution policy is unavailable");
    const createdAt = input.created_at ?? new Date().toISOString();
    const created = Date.parse(createdAt);
    if (
      !Number.isFinite(created) ||
      !input.failure ||
      [input.failure.code, input.failure.reason, input.failure.action].some(
        (value) =>
          typeof value !== "string" || !value.trim() || value.length > 4096,
      ) ||
      typeof input.failure.retryable !== "boolean"
    )
      throw new TypeError("execution intervention is invalid");
    const open = policy.mode !== "never";
    const intervention: ExecutionIntervention = {
      intervention_id: `intervention-${randomUUID()}`,
      job_id: input.job_id,
      target_id: input.target_id ?? null,
      mode: policy.mode,
      status: open ? "open" : "declined",
      failure: structuredClone(input.failure),
      created_at: createdAt,
      expires_at: new Date(
        created + policy.intervention_timeout_ms,
      ).toISOString(),
      resolved_at: open ? null : createdAt,
      resolution: open ? null : { kind: "policy-declined" },
    };
    return onlyIfActive
      ? this.repository.putInterventionIfActive(intervention)
      : this.repository.putIntervention(intervention);
  }

  async resolve(
    interventionId: string,
    resolution: InterventionResolution,
    resolvedAt = new Date().toISOString(),
  ): Promise<ExecutionIntervention> {
    parseInterventionResolution(resolution);
    const work = () =>
      this.resolveOwned(interventionId, resolution, resolvedAt);
    return this.admission
      ? resolution === "cancel"
        ? this.admission.continuation(work)
        : this.admission.newWork(work)
      : work();
  }
  private async resolveOwned(
    interventionId: string,
    resolution: InterventionResolution,
    resolvedAt: string,
  ): Promise<ExecutionIntervention> {
    const result = await this.repository.resolveIntervention(
      interventionId,
      "resolved",
      { kind: resolution },
      resolvedAt,
    );
    if (result.mode === "pause") {
      if (resolution === "continue")
        await this.repository.updateJob(result.job_id, "queued");
      if (resolution === "cancel")
        await this.repository.updateJob(result.job_id, "cancelled", resolvedAt);
      if (resolution === "skip" && result.target_id)
        await this.repository.updateTarget(
          result.target_id,
          "skipped",
          "skipped",
        );
    }
    return result;
  }
}
