import { randomUUID } from "node:crypto";
import {
  parseMetadataSourceProgress,
  type MetadataSourceProgress,
  type MetadataSourcePurpose,
  type MetadataSourceResult,
} from "@sciretriever/contracts";
import type { ExecutionRepository } from "../../storage/execution/repository.js";
import { observeNetworkRequests } from "../../network/request-activity.js";
import { sourceProblem } from "../../providers/shared/source-problem.js";

export class MetadataProgressError extends Error {
  readonly code = "metadata-progress-storage-failed";
  constructor(cause: unknown) {
    super("metadata progress could not be saved", { cause });
  }
}
type Change = MetadataSourceProgress extends infer P
  ? P extends MetadataSourceProgress
    ? Omit<
        P,
        | "schema_version"
        | "record_id"
        | "source"
        | "purpose"
        | "role"
        | "unit_id"
        | "at"
      >
    : never
  : never;

/** One admitted logical source call; Network owns the actual-dispatch fact. */
export class MetadataSourceRecorder {
  readonly recordId = randomUUID();
  requested = false;
  private pending = Promise.resolve();
  private failed: { cause: unknown } | null = null;
  private finished = false;
  constructor(
    private readonly repository: ExecutionRepository,
    private readonly jobId: string,
    private readonly targetId: string,
    readonly source: string,
    readonly purpose: MetadataSourcePurpose,
    readonly unitId: string,
    readonly role: "primary" | "supporting",
  ) {}
  private enqueue(change: Change) {
    const progress = parseMetadataSourceProgress({
      schema_version: 1,
      record_id: this.recordId,
      source: this.source,
      purpose: this.purpose,
      role: this.role,
      unit_id: this.unitId,
      at: new Date().toISOString(),
      ...change,
    });
    this.pending = this.pending.then(async () => {
      if (this.failed) return;
      try {
        await this.repository.appendMetadataEvent({
          event_id: randomUUID(),
          job_id: this.jobId,
          sequence: -1,
          kind: "metadata-source",
          payload: { target_id: this.targetId, progress },
          created_at: progress.at,
        });
      } catch (cause) {
        this.failed = { cause };
      }
    });
  }
  private async flush() {
    await this.pending;
    if (this.failed) throw new MetadataProgressError(this.failed.cause);
  }
  async dispatched() {
    if (!this.requested) {
      this.requested = true;
      this.enqueue({ phase: "requested" });
    }
    await this.flush();
  }
  async start() {
    this.enqueue({ phase: "started" });
    await this.flush();
    return this;
  }
  async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await observeNetworkRequests(() => {
        if (!this.requested) {
          this.requested = true;
          this.enqueue({ phase: "requested" });
        }
      }, action);
    } finally {
      await this.flush();
    }
  }
  async *stream<T>(stream: AsyncGenerator<T>): AsyncGenerator<T> {
    try {
      for (;;) {
        const next = await this.run(() => stream.next());
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await stream.return(undefined);
      await this.flush();
    }
  }
  async returned(count: number) {
    this.enqueue({ phase: "returned", count });
    await this.flush();
  }
  async rejected(count = 1) {
    this.enqueue({ phase: "rejected", count });
    await this.flush();
  }
  async observed(result_id: string, created: boolean) {
    this.enqueue({
      phase: "observed",
      result_id,
      disposition: created ? "created" : "matched",
    });
    await this.flush();
  }
  async included(result_id: string) {
    this.enqueue({ phase: "included", result_id, disposition: "related" });
    await this.flush();
  }
  async finish(result: MetadataSourceResult, code?: string, error?: unknown) {
    if (this.finished) return;
    this.enqueue({
      phase: "finished",
      result,
      problem:
        result === "error" || result === "unavailable"
          ? sourceProblem(code ?? "metadata-source-failed", "metadata", error)
          : null,
    });
    await this.flush();
    this.finished = true;
  }
  async failure(code: string, error?: unknown) {
    const problem = sourceProblem(code, "metadata", error);
    return this.finish(
      !this.requested && problem.display === "not-configured"
        ? "unavailable"
        : !this.requested && code.includes("cooldown")
          ? "cooldown"
          : "error",
      code,
      error,
    );
  }
}
export class MetadataSourceRun {
  constructor(
    private readonly repository: ExecutionRepository,
    private readonly jobId: string,
    private readonly targetId: string,
  ) {}
  async latestCheckpoint() {
    const rows = await this.repository.citationCheckpoints(
      this.jobId,
      this.targetId,
    );
    return rows[0] ?? null;
  }
  checkpoints(after: number, through: number) {
    return this.repository.citationCheckpoints(this.jobId, this.targetId, {
      after,
      through,
    });
  }
  checkpoint(fields: Record<string, unknown>) {
    return this.append("citation-write-checkpoint", fields);
  }
  citationResponseReplaced(
    literatureId: string,
    providerName: string,
    committedRelations: number,
  ) {
    return this.append("citation-response-replaced", {
      literature_id: literatureId,
      provider_name: providerName,
      committed_relations: committedRelations,
      reason:
        "The resumed provider response did not contain the previously partially written citation item. Its committed relations were retained.",
    });
  }
  citationSourceCooldown(fields: Record<string, unknown>) {
    return this.append("citation-source-cooldown", fields);
  }
  citationSourceDeferred(fields: Record<string, unknown>) {
    return this.append("citation-source-deferred", fields);
  }
  private append(
    kind:
      | "citation-write-checkpoint"
      | "citation-response-replaced"
      | "citation-source-cooldown"
      | "citation-source-deferred",
    fields: Record<string, unknown>,
  ) {
    return this.repository.appendMetadataEvent({
      event_id: randomUUID(),
      job_id: this.jobId,
      sequence: -1,
      kind,
      payload: { ...fields, target_id: this.targetId },
      created_at: new Date().toISOString(),
    });
  }
  begin(
    source: string,
    purpose: MetadataSourcePurpose,
    unitId: string,
    role: "primary" | "supporting" = "primary",
  ) {
    return new MetadataSourceRecorder(
      this.repository,
      this.jobId,
      this.targetId,
      source,
      purpose,
      unitId,
      role,
    ).start();
  }
}
