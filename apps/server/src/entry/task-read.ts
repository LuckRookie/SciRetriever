import { parseAcquirePdfScope } from "@sciretriever/contracts";
function taskScope(selector: unknown) {
  return selector && typeof selector === "object" && "scope" in selector
    ? parseAcquirePdfScope(selector.scope)
    : null;
}
import {
  parseAcquisitionAttempt,
  parseAcquisitionTaskTrace,
  MAX_ACQUISITION_ATTEMPTS,
  type AcquisitionAttempt,
} from "@sciretriever/contracts";
import type { ExecutionRepository } from "../storage/execution/repository.js";
import type { ExecutionJobStatus } from "../storage/sqlite/worker.js";
import { readProcessingTask } from "../application/jobs/processing.js";
import { sourceStatistics } from "../application/source-statistics.js";
import { ContractValidationError } from "@sciretriever/contracts";
import { operationRecord as inputRecord } from "./query-operations.js";
import { presentAcquisitionAttempt } from "../providers/shared/source-problem.js";
/** Read-only task projections; no recovery or runtime lock is started. */
export function createTaskReader(repository: ExecutionRepository) {
  const read = async (id: string) => {
    const [task, events, interventions, policy, budget, acquisition] =
      await Promise.all([
        readProcessingTask(repository, id),
        repository.listEvents(id, -1, 1000, "newest"),
        repository.listInterventions(id, 1000),
        repository.getPolicy(id),
        repository.getBudget(id),
        repository.acquisitionEvents(id),
      ]);
    const traces = new Map<
      string,
      {
        target_id: string;
        attempt_id: string;
        literature_id: string;
        attempts: AcquisitionAttempt[];
        truncated: boolean;
      }
    >();
    for (const event of acquisition.events) {
      const payload = inputRecord(event.payload, [
        "target_id",
        "attempt_id",
        "literature_id",
        "attempt",
      ]);
      const parsed = parseAcquisitionTaskTrace({
        target_id: payload.target_id,
        attempt_id: payload.attempt_id,
        literature_id: payload.literature_id,
        attempts: [payload.attempt],
        truncated: false,
      });
      const key = parsed.attempt_id + ":" + parsed.literature_id;
      let row = traces.get(key);
      if (!row) {
        row = { ...parsed, attempts: [] };
        traces.set(key, row);
      }
      if (row.attempts.length >= MAX_ACQUISITION_ATTEMPTS) row.truncated = true;
      else
        row.attempts.push(
          presentAcquisitionAttempt(parseAcquisitionAttempt(payload.attempt)),
        );
    }
    return {
      ...task,
      scope: taskScope(task.job.selector),
      acquisition_traces: [...traces.values()].map(parseAcquisitionTaskTrace),
      acquisition_traces_truncated: acquisition.truncated,
      events: [...events].reverse(),
      events_truncated: (events.at(-1)?.sequence ?? 0) > 0,
      interventions,
      policy,
      budget,
    };
  };
  return {
    sourceStatistics: (value: unknown, signal?: AbortSignal) =>
      sourceStatistics(repository, value, signal),
    list: async (
      limit = 100,
      cursor?: string,
      statusGroup?: "active" | "attention" | "ended",
    ) => {
      const groups: Readonly<
        Record<"active" | "attention" | "ended", readonly ExecutionJobStatus[]>
      > = {
        active: ["queued", "running"],
        attention: ["paused", "interrupted", "failed"],
        ended: ["completed", "cancelled", "failed"],
      };
      const statuses = statusGroup === undefined ? [] : groups[statusGroup];
      const order = statusGroup === "ended" ? "finished" : "newest";
      let before: { timestamp: string; job_id: string } | null = null;
      if (cursor !== undefined) {
        if (!/^[A-Za-z0-9_-]{1,512}$/u.test(cursor))
          throw new ContractValidationError();
        let decoded: unknown;
        try {
          decoded = JSON.parse(
            Buffer.from(cursor, "base64url").toString("utf8"),
          );
        } catch {
          throw new ContractValidationError();
        }
        const r = inputRecord(decoded, ["timestamp", "job_id", "order"]);
        if (
          r.order !== order ||
          typeof r.timestamp !== "string" ||
          !r.timestamp ||
          r.timestamp.length > 64 ||
          typeof r.job_id !== "string" ||
          !/^[A-Za-z0-9._:-]{1,128}$/u.test(r.job_id)
        )
          throw new ContractValidationError();
        before = { timestamp: r.timestamp, job_id: r.job_id };
      }
      const tasks = await repository.listJobs(limit, order, before, statuses);
      const last = tasks.at(-1);
      const next = last
        ? {
            timestamp:
              order === "finished"
                ? (last.finished_at ?? last.created_at)
                : last.created_at,
            job_id: last.job_id,
          }
        : null;
      const hasNext =
        tasks.length === limit &&
        next !== null &&
        (await repository.listJobs(1, order, next, statuses)).length > 0;
      return {
        tasks: tasks.map((task) => ({
          ...task,
          scope: taskScope(task.selector),
        })),
        next_cursor: hasNext
          ? Buffer.from(JSON.stringify({ ...next, order })).toString(
              "base64url",
            )
          : null,
      };
    },
    read,
  };
}
