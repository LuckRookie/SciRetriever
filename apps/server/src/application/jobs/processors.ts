import {
  canonicalJsonBytes,
  parseProcessorBatchRequest,
  sha256,
  type ProcessingTaskRequest,
  type ProcessorCollection,
  type ProcessorResultRef,
} from "@sciretriever/contracts";
import {
  type ProcessorService,
  processorError,
  processorIdFromHash,
} from "../../analysis/processor.js";
import type { SqliteProcessorStorage } from "../../storage/processor-results.js";
import type { ExecutionRepository } from "../../storage/execution/repository.js";
import {
  ProcessingTaskService,
  processingJobId,
  readProcessingTask,
} from "./processing.js";

/** Freezes caller intent before enqueue; execution remains owned by durable Jobs. */
export class ProcessorBatchService {
  constructor(
    private readonly service: ProcessorService,
    private readonly results: SqliteProcessorStorage,
    private readonly jobs: ExecutionRepository,
    private readonly tasks: ProcessingTaskService,
  ) {}
  list() {
    return this.service.registry.list();
  }
  async submit(value: unknown, signal?: AbortSignal) {
    const raw = parseProcessorBatchRequest(value);
    const hash = await sha256(canonicalJsonBytes(raw));
    const jobId = await processingJobId(raw.idempotency_key);
    const existing = await this.jobs.getJob(jobId);
    if (existing) {
      const snapshot = existing.selector as { request?: ProcessingTaskRequest };
      if (
        existing.policy_version !== "processing-v1" ||
        snapshot.request?.schema_version !== 2 ||
        snapshot.request.source_request_sha256 !== hash
      )
        processorError("processor-idempotency-conflict");
      await this.results.recordRun(existing.job_id, raw);
      return existing;
    }
    const prepared = await this.service.prepare(raw, signal);
    const job = await this.tasks.submit({
      schema_version: 2,
      idempotency_key: raw.idempotency_key,
      collection_name: raw.name,
      source_request_sha256: hash,
      operations: prepared.invocations.map((request) => ({
        operation: "run-processor",
        request,
      })),
    });
    await this.results.recordRun(job.job_id, raw);
    return job;
  }
  async runBatch(value: unknown, signal?: AbortSignal) {
    const job = await this.submit(value, signal);
    return this.tasks.run(job.job_id, signal);
  }
  rebuild(ids?: readonly string[]) {
    return this.results.rebuild(ids);
  }
}

export function processorRuntime(
  service: ProcessorService,
  store: SqliteProcessorStorage,
  jobs: ExecutionRepository,
) {
  return {
    async execute(value: unknown, signal?: AbortSignal) {
      const result = await service.execute(value, signal);
      // The result is durable before the disposable search projection is built.
      // A retry reuses the published result and repairs its projection.
      await store.rebuild([result.result_id], signal);
      return result;
    },
    async finish(jobId: string, request: ProcessingTaskRequest) {
      const state = await readProcessingTask(jobs, jobId);
      const results = state.results as {
        target_id: string;
        result: {
          result_id: string;
          content_sha256: string;
          reused: boolean;
          coverage: string;
        };
      }[];
      const members: ProcessorCollection["members"] = state.targets.map(
        (target) => {
          const operation = request.operations[target.ordinal];
          if (!operation || operation.operation !== "run-processor")
            processorError("processor-snapshot-invalid");
          const saved = results.find(
            (r) => r.target_id === target.target_id,
          )?.result;
          return {
            target_id: target.target_id,
            inputs: operation.request.inputs,
            result: saved
              ? ({
                  result_id: saved.result_id,
                  content_sha256: saved.content_sha256,
                } satisfies ProcessorResultRef)
              : null,
            gap: saved ? null : target.stage,
          };
        },
      );
      const first = request.operations[0];
      if (!first || first.operation !== "run-processor")
        processorError("processor-snapshot-invalid");
      const identity = {
        run_id: jobId,
        name: request.collection_name!,
        processor: first.request.processor,
        spec: first.request.spec,
        members,
      };
      const digest = await sha256(canonicalJsonBytes(identity));
      const collection_id = processorIdFromHash(digest);
      await store.publishCollection({
        schema_version: 1,
        collection_id,
        ...identity,
      });
      if (
        state.collections.some(
          (value) =>
            !!value &&
            typeof value === "object" &&
            "collection_id" in value &&
            value.collection_id === collection_id,
        )
      )
        return;
      await jobs.appendEvent({
        event_id: `${collection_id}:receipt`,
        job_id: jobId,
        sequence: -1,
        kind: "processor-collection",
        payload: {
          collection_id,
          reused: results.filter((r) => r.result.reused).length,
          computed: results.filter((r) => !r.result.reused).length,
          failed: members.filter((m) => !m.result).length,
          partial: results.filter((r) => r.result.coverage !== "complete")
            .length,
        },
        created_at: new Date().toISOString(),
      });
    },
  };
}
