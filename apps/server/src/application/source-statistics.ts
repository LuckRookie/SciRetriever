import {
  parseSourceStatisticsRequest,
  type SourceStatisticsRequest,
} from "@sciretriever/contracts";
import type { ExecutionRepository } from "../storage/execution/repository.js";
import { SourceResultAggregation } from "./source-results.js";

async function readRecords(
  repository: ExecutionRepository,
  request: SourceStatisticsRequest,
  through: string,
  jobId: string | null,
  signal?: AbortSignal,
) {
  const totals = new SourceResultAggregation(),
    from =
      request.range === "all"
        ? null
        : new Date(Date.parse(through) - 30 * 86400000).toISOString();
  let after = 0,
    snapshot: number | null = null,
    recordedSince: string | null = null;
  for (;;) {
    signal?.throwIfAborted();
    const page = await repository.sourceRecordPage({
      job_id: jobId,
      from,
      through,
      after,
      snapshot,
      limit: 1000,
    });
    if (snapshot !== null && snapshot !== page.snapshot)
      throw new Error("source-record-snapshot-changed");
    snapshot = page.snapshot;
    recordedSince = page.recorded_since;
    for (const event of page.events) totals.accept(event);
    if (page.next_after === null) return { totals, recordedSince };
    if (!Number.isSafeInteger(page.next_after) || page.next_after <= after)
      throw new Error("source-record-cursor-invalid");
    after = page.next_after;
  }
}
export async function sourceStatistics(
  repository: ExecutionRepository,
  value: unknown,
  signal?: AbortSignal,
  clock: () => Date = () => new Date(),
) {
  const request = parseSourceStatisticsRequest(value),
    through = clock().toISOString(),
    { totals, recordedSince } = await readRecords(
      repository,
      request,
      through,
      null,
      signal,
    );
  return totals.statistics(request, through, recordedSince);
}
export async function taskSourceResults(
  repository: ExecutionRepository,
  jobId: string,
  signal?: AbortSignal,
) {
  const { totals } = await readRecords(
    repository,
    { range: "all" },
    new Date().toISOString(),
    jobId,
    signal,
  );
  return totals.task();
}
