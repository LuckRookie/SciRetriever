import { randomUUID } from "node:crypto";
import {
  ContractValidationError,
  parseMetadataTaskRequest,
} from "@sciretriever/contracts";
import type { Application } from "../bootstrap/application.js";
import { ProcessingTaskError } from "../application/jobs/processing.js";

/** Resolve and freeze source selection at admission, never again during execution. */
export function prepareMetadataTask(app: Application, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractValidationError();
  const { scan_limit, ...r } = value as Record<string, unknown>,
    limit = scan_limit ?? app.configuration.sources.metadata.limit ?? 500;
  if (
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 10000
  )
    throw new ContractValidationError();
  const selection =
    r.kind === "topic"
      ? app.metadata.topic_selection
      : r.kind === "citation"
        ? app.metadata.reference_selection
        : app.metadata.lookup_selection;
  if (r.providers === undefined && !selection.length)
    throw new ProcessingTaskError("metadata-unavailable");
  return parseMetadataTaskRequest({
    ...r,
    providers:
      r.providers ?? selection.map((source) => ({ source, scan_limit: limit })),
  });
}
export async function runMetadataTask(
  app: Application,
  value: unknown,
  signal?: AbortSignal,
  idempotencyKey = `metadata-${randomUUID()}`,
) {
  const runtime = app.processingTasks;
  if (!runtime) throw new ProcessingTaskError("metadata-unavailable");
  const request = prepareMetadataTask(app, value),
    job = await runtime.submit({
      schema_version: 1,
      idempotency_key: idempotencyKey,
      operations: [{ operation: "acquire-metadata", request }],
    });
  await runtime.run(job.job_id, signal);
  const task = await runtime.read(job.job_id);
  const payload = [...task.results, ...task.partial_results].find(
    (value) =>
      value &&
      typeof value === "object" &&
      "operation" in value &&
      value.operation === "acquire-metadata" &&
      "result" in value,
  );
  if (
    !payload ||
    typeof payload !== "object" ||
    !("result" in payload) ||
    !payload.result ||
    typeof payload.result !== "object"
  )
    throw new ProcessingTaskError(
      signal?.aborted ? "operation-cancelled" : "metadata-task-failed",
    );
  return {
    ...payload.result,
    job_id: job.job_id,
    source_summary: task.source_results,
  };
}
