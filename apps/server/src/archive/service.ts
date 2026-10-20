import { parseInterventionResolution } from "../application/jobs/interventions.js";
import { randomUUID } from "node:crypto";
import {
  parseArchiveBuildRequest,
  parseLibraryQuery,
  parseLiteratureId,
  tagInteger,
  tagRecord,
  tagText,
  type ArchiveVersionEvent,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { ProcessingTaskService } from "../application/jobs/processing.js";
import type { LiteratureQueryService } from "../literature/query.js";
import { ArchiveError, type ArchiveStatus } from "./orchestrator.js";
export class ArchiveReader {
  constructor(protected readonly database: SqliteWorker) {}
  status(id: string, signal?: AbortSignal) {
    return this.database.archive<ArchiveStatus>(
      "state",
      { literature_id: parseLiteratureId(id) },
      signal,
    );
  }
  query(value: unknown, signal?: AbortSignal): Promise<unknown> {
    const r = tagRecord(value, ["operation", "request"]);
    if (r.operation === "revision") {
      tagRecord(r.request, []);
      return this.database.archive("revision", {}, signal);
    }
    if (r.operation === "status") {
      const q = tagRecord(r.request, ["literature_id"]);
      return this.status(parseLiteratureId(q.literature_id), signal);
    }
    if (r.operation === "events") {
      const q = tagRecord(r.request, ["after", "limit"]);
      const limit = tagInteger(q.limit, 1);
      if (limit > 1000) throw new ArchiveError("archive-limit");
      return this.database.archive<ArchiveVersionEvent[]>(
        "events",
        { after: tagInteger(q.after), limit },
        signal,
      );
    }
    if (r.operation === "stats") {
      tagRecord(r.request, []);
      return this.database.archive("stats", {}, signal);
    }
    if (r.operation === "issues") {
      const q = r.request as Record<string, unknown>;
      if (
        !q ||
        typeof q !== "object" ||
        Array.isArray(q) ||
        Object.keys(q).some(
          (k) =>
            ![
              "literature_id",
              "reason",
              "part",
              "offset",
              "limit",
              "include_resolved",
            ].includes(k),
        )
      )
        throw new ArchiveError("archive-invalid");
      if (
        q.part !== undefined &&
        !["main", "supplementary"].includes(String(q.part))
      )
        throw new ArchiveError("archive-invalid");
      if (
        q.include_resolved !== undefined &&
        typeof q.include_resolved !== "boolean"
      )
        throw new ArchiveError("archive-invalid");
      const limit = tagInteger(q.limit ?? 50, 1);
      if (limit > 200) throw new ArchiveError("archive-limit");
      return this.database.archive(
        "issues",
        {
          ...q,
          ...(q.literature_id
            ? { literature_id: parseLiteratureId(q.literature_id) }
            : {}),
          ...(q.reason ? { reason: tagText(q.reason) } : {}),
          limit,
          offset: tagInteger(q.offset ?? 0),
        },
        signal,
      );
    }
    throw new ArchiveError("archive-invalid");
  }
}
export class ArchiveService extends ArchiveReader {
  constructor(
    database: SqliteWorker,
    private readonly tasks: ProcessingTaskService | null,
    private readonly library: LiteratureQueryService,
  ) {
    super(database);
  }
  async build(value: unknown, signal?: AbortSignal) {
    if (!this.tasks) throw new ArchiveError("archive-task-unavailable");
    const r = tagRecord(value, [
        "selector",
        "mode",
        "from_step",
        "idempotency_key",
      ]),
      s = r.selector as Record<string, unknown>;
    if (!s || typeof s !== "object" || Array.isArray(s))
      throw new ArchiveError("archive-selector-invalid");
    let selector:
      | {
          kind: "literatures";
          literature_ids: ReturnType<typeof parseLiteratureId>[];
        }
      | { kind: "query"; query: ReturnType<typeof parseLibraryQuery> };
    if (s.kind === "literatures") {
      tagRecord(s, ["kind", "literature_ids"]);
      if (!Array.isArray(s.literature_ids))
        throw new ArchiveError("archive-invalid");
      selector = {
        kind: "literatures",
        literature_ids: s.literature_ids.map(parseLiteratureId),
      };
    } else if (s.kind === "query") {
      tagRecord(s, ["kind", "query"]);
      selector = { kind: "query", query: parseLibraryQuery(s.query) };
    } else throw new ArchiveError("archive-selector-invalid");
    const selected =
      selector.kind === "literatures"
        ? await this.library.targetedSnapshot({
            literature_ids: selector.literature_ids,
          })
        : await this.library.search({
            query: selector.query,
            sort: "title-asc",
            limit: 10001,
            cursor: null,
          });
    if (selected.items.length > 10000 || selected.next_cursor !== null)
      throw new ArchiveError("archive-batch-limit");
    if (
      selector.kind === "literatures" &&
      (selector.literature_ids.length === 0 ||
        selector.literature_ids.some(
          (id) =>
            !selected.items.some((i) => i.literature.literature_id === id),
        ))
    )
      throw new ArchiveError("archive-literature-missing");
    if (!selected.items.length) return { job: null, members: 0 };
    if (signal?.aborted) throw new ArchiveError("archive-cancelled");
    const job = await this.tasks.submit({
      schema_version: 1,
      idempotency_key: tagText(r.idempotency_key),
      operations: selected.items.map((i) => ({
        operation: "build-archive",
        request: parseArchiveBuildRequest({
          literature_id: i.literature.literature_id,
          mode: r.mode,
          from_step: r.from_step,
        }),
      })),
    });
    this.tasks.start(job.job_id);
    return { job, members: selected.items.length };
  }
  async resume(id: string, signal?: AbortSignal) {
    const current = await this.status(id, signal);
    return this.build(
      {
        selector: { kind: "literatures", literature_ids: [id] },
        mode: current.mode,
        from_step: null,
        idempotency_key: `archive-${randomUUID()}`,
      },
      signal,
    );
  }
  async resolve(value: unknown, signal?: AbortSignal) {
    const r = tagRecord(value, ["issue_ids", "resolution"]);
    if (
      !Array.isArray(r.issue_ids) ||
      !r.issue_ids.length ||
      r.issue_ids.length > 100 ||
      !["continue", "skip", "cancel"].includes(String(r.resolution))
    )
      throw new ArchiveError("archive-invalid");
    const resolution = parseInterventionResolution(r.resolution);
    for (const id of r.issue_ids) {
      const run = await this.database.archive<{
        job_id: string;
        status: string;
      } | null>("resolve", { issue_id: tagText(id), resolution }, signal);
      if (
        resolution === "cancel" &&
        run &&
        ["queued", "running", "paused"].includes(run.status)
      )
        await this.tasks?.control(run.job_id, "cancel");
    }
    // Resolution acknowledges the issue; only current facts can establish readiness.
    return { resolved: r.issue_ids.length, resolution: r.resolution };
  }
}
