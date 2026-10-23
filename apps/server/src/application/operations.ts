import type { ProcessorMapProgress } from "../analysis/processor.js";
import { ExecutionRepository } from "../storage/execution/repository.js";
import { randomUUID } from "node:crypto";
import { activityContext, withActivity } from "../logging/activity.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";

/** Keep fixed identifiers, never document payloads, secrets or transport headers. */
export function operationScope(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allowed = new Set([
    "literature_id",
    "asset_id",
    "proofread_id",
    "document_version_id",
    "job_id",
    "result_id",
    "collection_id",
    "snapshot_id",
    "folder_id",
    "parent_id",
    "tag_id",
    "expected_revision",
    "expected_manual_revision",
    "metadata_revision",
    "revision",
    "change_version",
    "decision_id",
    "operation",
    "kind",
  ]);
  if (value && typeof value === "object" && !Array.isArray(value))
    for (const [key, item] of Object.entries(value)) {
      if (
        allowed.has(key) &&
        ((typeof item === "string" && item.length <= 256) ||
          (typeof item === "number" && Number.isSafeInteger(item)))
      )
        out[key] = item;
      else if (["request", "job", "task"].includes(key))
        out[key] = operationScope(item);
    }
  return out;
}
/** An interrupted action remains 'running'; history never claims a false rollback. */
export async function recordOperation<T>(
  database: SqliteWorker,
  operation: string,
  input: unknown,
  perform: () => Promise<T>,
): Promise<T> {
  const operation_id = randomUUID(),
    actor = activityContext().actor;
  await database.review("audit-start", {
    operation_id,
    actor,
    operation,
    scope_json: JSON.stringify(operationScope(input)),
    created_at: new Date().toISOString(),
  });
  let result: T;
  try {
    result = await withActivity({ operation }, perform);
  } catch (error) {
    await database.review("audit-finish", {
      operation_id,
      status: "failed",
      result_json: "{}",
      finished_at: new Date().toISOString(),
    });
    throw error;
  }
  await database.review("audit-finish", {
    operation_id,
    status: "completed",
    result_json: JSON.stringify(operationScope(result)),
    finished_at: new Date().toISOString(),
  });
  return result;
}

/** Persist mapping progress separately from the final synthesis receipt. */
export async function recordMapProgress(
  database: SqliteWorker,
  progress: ProcessorMapProgress,
) {
  const context = activityContext();
  if (!context.job_id || !context.target_id) return;
  await new ExecutionRepository(database).appendEvent({
    event_id: randomUUID(),
    job_id: context.job_id,
    sequence: -1,
    kind: "processor-map-progress",
    payload: { target_id: context.target_id, ...progress },
    created_at: new Date().toISOString(),
  });
}
