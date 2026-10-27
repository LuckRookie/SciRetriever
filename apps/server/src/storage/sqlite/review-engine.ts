import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  PROCESSOR_METHOD_REVISION,
  archivePageCursor,
  parseProcessorOutcomeCounts,
} from "@sciretriever/contracts";

export type ReviewStorageAction =
  | "audit-start"
  | "audit-finish"
  | "audit-list"
  | "job-origin-get"
  | "job-origin-put"
  | "session-start"
  | "session-event"
  | "session-finish"
  | "session-cleanup"
  | "session-list"
  | "session-read"
  | "session-revision"
  | "task-run"
  | "usage-history"
  | "processor-request-put"
  | "processor-runs"
  | "literature-results"
  | "estimate-issues";
function input(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("review-invalid");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    value.includes("\0")
  )
    throw new Error("review-invalid");
  return value;
}
function integer(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max)
    throw new Error("review-invalid");
  return Number(value);
}
export function runReviewStorage(
  db: DatabaseSync,
  action: ReviewStorageAction,
  value: unknown,
): unknown {
  const r = input(value);
  if (action === "session-start") {
    const context = input(r.context),
      subject = input(r.subject);
    let literature = subject.literature_id ?? context.literature_id ?? null;
    if (!literature && typeof subject.asset_id === "string")
      literature =
        db
          .prepare(
            "SELECT literature_id FROM literature_assets WHERE asset_id=? ORDER BY literature_id LIMIT 1",
          )
          .get(subject.asset_id)?.literature_id ?? null;
    db.prepare(
      "INSERT INTO agent_sessions(session_id,role,provider,model,actor,job_id,literature_id,subject_json,status,started_at) VALUES(?,?,?,?,?,?,?,?,'running',?)",
    ).run(
      text(r.session_id),
      text(r.role),
      text(r.provider),
      text(r.model),
      text(context.actor),
      context.job_id ? text(context.job_id) : null,
      literature ? text(literature) : null,
      JSON.stringify(subject),
      text(r.started_at),
    );
    return null;
  }
  if (action === "session-event") {
    const id = text(r.session_id),
      current = db
        .prepare(
          "SELECT event_bytes,status FROM agent_sessions WHERE session_id=?",
        )
        .get(id);
    if (!current || current.status !== "running")
      throw new Error("review-session-ended");
    const payload = JSON.stringify(r.summary),
      bytes = Buffer.byteLength(payload) + 256;
    if (bytes > 65536) throw new Error("review-event-size");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (Number(current.event_bytes) + bytes > 2 * 1024 * 1024)
        db.prepare(
          "UPDATE agent_sessions SET truncated=1 WHERE session_id=?",
        ).run(id);
      else {
        db.prepare(
          "INSERT INTO agent_session_events(session_id,kind,payload_json,created_at,truncated) VALUES(?,?,?,?,?)",
        ).run(
          id,
          text(r.kind),
          payload,
          text(r.created_at),
          r.truncated ? 1 : 0,
        );
        db.prepare(
          "UPDATE agent_sessions SET event_bytes=event_bytes+?,truncated=MAX(truncated,?) WHERE session_id=?",
        ).run(bytes, r.truncated ? 1 : 0, id);
      }
      if (r.kind === "usage") {
        const usage = input(r.summary);
        db.prepare(
          "UPDATE agent_sessions SET calls=?,input_tokens=?,output_tokens=? WHERE session_id=?",
        ).run(
          integer(usage.calls, 0, Number.MAX_SAFE_INTEGER),
          integer(usage.input_tokens, 0, Number.MAX_SAFE_INTEGER),
          integer(usage.output_tokens, 0, Number.MAX_SAFE_INTEGER),
          id,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return null;
  }
  if (action === "session-finish") {
    if (
      !["completed", "failed", "cancelled", "interrupted"].includes(
        String(r.status),
      )
    )
      throw new Error("review-invalid");
    const id = text(r.session_id),
      session = db
        .prepare(
          "SELECT job_id,literature_id,role,status FROM agent_sessions WHERE session_id=?",
        )
        .get(id);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "UPDATE agent_sessions SET status=?,finished_at=?,calls=?,input_tokens=?,output_tokens=? WHERE session_id=? AND status='running'",
      ).run(
        text(r.status),
        text(r.finished_at),
        integer(r.calls, 0, Number.MAX_SAFE_INTEGER),
        integer(r.input_tokens, 0, Number.MAX_SAFE_INTEGER),
        integer(r.output_tokens, 0, Number.MAX_SAFE_INTEGER),
        id,
      );
      if (session?.status === "running" && session.job_id)
        db.prepare(
          "INSERT INTO task_model_usage VALUES(?,?,?,?,?,?) ON CONFLICT(job_id,literature_id,role) DO UPDATE SET calls=calls+excluded.calls,input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens",
        ).run(
          session.job_id,
          session.literature_id ?? "",
          String(session.role),
          Number(r.calls),
          Number(r.input_tokens),
          Number(r.output_tokens),
        );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return null;
  }
  if (action === "session-cleanup")
    return {
      deleted: db
        .prepare(
          "DELETE FROM agent_sessions WHERE finished_at IS NOT NULL AND finished_at<=?",
        )
        .run(text(r.before)).changes,
    };
  if (action === "session-revision")
    return {
      revision: Number(
        db
          .prepare("SELECT revision FROM agent_view_revision WHERE singleton=1")
          .get()?.revision ?? 0,
      ),
    };
  const present = (row: Record<string, unknown>) => {
    const { subject_json, ...rest } = row;
    return { ...rest, subject: JSON.parse(String(subject_json)) };
  };
  if (action === "session-list") {
    const conditions: string[] = [],
      args: SQLInputValue[] = [];
    for (const key of ["job_id", "literature_id", "status"]) {
      if (r[key] !== undefined) {
        conditions.push(`s.${key}=?`);
        args.push(text(r[key]));
      }
    }
    if (r.before !== undefined) {
      conditions.push("s.rowid<?");
      args.push(integer(r.before, 0, Number.MAX_SAFE_INTEGER));
    }
    const limit = integer(r.limit, 50, 200);
    const found = db
      .prepare(
        `SELECT s.rowid AS cursor,s.*,m.title FROM agent_sessions s LEFT JOIN literature_metadata m USING(literature_id) ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY s.rowid DESC LIMIT ?`,
      )
      .all(...args, limit + 1);
    return {
      items: found.slice(0, limit).map(present),
      next_before: found.length > limit ? found[limit - 1]!.cursor : null,
    };
  }
  if (action === "session-read") {
    const id = text(r.session_id),
      session = db
        .prepare(
          "SELECT s.*,m.title FROM agent_sessions s LEFT JOIN literature_metadata m USING(literature_id) WHERE session_id=?",
        )
        .get(id);
    if (!session) return null;
    const limit = integer(r.limit, 50, 100),
      after = integer(r.after, 0, Number.MAX_SAFE_INTEGER);
    const events = db
      .prepare(
        "SELECT * FROM agent_session_events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?",
      )
      .all(id, after, limit + 1);
    const latest = db
      .prepare(
        "SELECT payload_json FROM agent_session_events WHERE session_id=? AND kind='tool-start' AND json_type(payload_json,'$.arguments.page')='integer' ORDER BY sequence DESC LIMIT 1",
      )
      .get(id);
    return {
      session: present(session),
      latest_view: latest
        ? JSON.parse(String(latest.payload_json)).arguments
        : null,
      events: events.slice(0, limit).map(({ payload_json, ...e }) => ({
        ...e,
        value: JSON.parse(String(payload_json)),
      })),
      next_after: events.length > limit ? events[limit - 1]!.sequence : null,
    };
  }
  if (action === "processor-runs") return processorRuns(db, r);
  if (action === "literature-results") {
    const id = text(r.literature_id),
      offset = integer(r.offset, 0, 100000),
      limit = integer(r.limit, 30, 200);
    const found = db
      .prepare(
        "SELECT p.*,f.state AS freshness,s.outcomes_json,s.method_revision,(SELECT count(*) FROM processor_result_literatures l WHERE l.result_id=p.result_id) AS literature_count FROM processor_result_literatures l JOIN processor_results p USING(result_id) LEFT JOIN processor_result_currentness f USING(result_id) LEFT JOIN processor_result_summaries s USING(result_id) WHERE l.literature_id=? ORDER BY p.created_at DESC,p.result_id LIMIT ? OFFSET ?",
      )
      .all(id, limit + 1, offset);
    return {
      items: found.slice(0, limit).map((p) => ({
        result_id: p.result_id,
        content_sha256: p.content_sha256,
        processor_id: p.processor_id,
        created_at: p.created_at,
        freshness: p.freshness,
        complete: p.complete,
        literature_count: p.literature_count,
        outcomes:
          p.outcomes_json && p.method_revision === PROCESSOR_METHOD_REVISION
            ? parseProcessorOutcomeCounts(JSON.parse(String(p.outcomes_json)))
            : null,
      })),
      next_offset: found.length > limit ? offset + limit : null,
    };
  }
  if (action === "task-run") return taskRun(db, r);
  if (action === "estimate-issues") {
    if (!Array.isArray(r.ids) || r.ids.length > 10000)
      throw new Error("review-invalid");
    return db
      .prepare(
        "SELECT DISTINCT literature_id FROM archive_issues WHERE issue_id IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify(r.ids.map((v) => text(v))))
      .map((r) => String(r.literature_id));
  }
  if (action === "processor-request-put") {
    const job = text(r.job_id),
      request = JSON.stringify(r.request),
      old = db
        .prepare(
          "SELECT request_json FROM processor_run_requests WHERE job_id=?",
        )
        .get(job);
    if (old && old.request_json !== request)
      throw new Error("processor-run-conflict");
    if (!old)
      db.prepare("INSERT INTO processor_run_requests VALUES(?,?)").run(
        job,
        request,
      );
    return null;
  }
  if (action === "usage-history") {
    if (r.kind === "archive")
      return db
        .prepare(
          "SELECT step,calls,input_tokens,output_tokens,stats_json FROM archive_attempts WHERE calls>0 ORDER BY attempt_id DESC LIMIT 1000",
        )
        .all()
        .map(({ stats_json, ...a }) => ({
          ...a,
          stats: JSON.parse(String(stats_json)),
        }));
    if (r.kind === "processor")
      return db
        .prepare(
          "SELECT s.usage_json FROM processor_result_summaries s JOIN processor_results p USING(result_id) WHERE p.processor_id=? AND p.producer='internal' AND s.usage_json IS NOT NULL AND json_extract(s.usage_json,'$.calls')>0 ORDER BY p.created_at DESC LIMIT 200",
        )
        .all(text(r.processor))
        .map((row) => JSON.parse(String(row.usage_json)));
    if (r.kind === "tags")
      return db
        .prepare(
          "SELECT calls,input_tokens,output_tokens FROM agent_sessions WHERE role=? AND status='completed' AND calls>0 ORDER BY started_at DESC LIMIT 200",
        )
        .all(text(r.role));
    throw new Error("review-invalid");
  }
  if (action === "job-origin-put") {
    db.prepare(
      "INSERT OR IGNORE INTO job_origins(job_id,actor,operation,created_at) VALUES(?,?,?,?)",
    ).run(text(r.job_id), text(r.actor), text(r.operation), text(r.created_at));
    return null;
  }
  if (action === "job-origin-get")
    return (
      db
        .prepare("SELECT * FROM job_origins WHERE job_id=?")
        .get(text(r.job_id)) ?? null
    );
  if (action === "audit-start") {
    db.prepare(
      "INSERT INTO operation_records(operation_id,actor,operation,scope_json,status,created_at) VALUES(?,?,?,?, 'running',?)",
    ).run(
      text(r.operation_id),
      text(r.actor),
      text(r.operation),
      text(r.scope_json, 65536),
      text(r.created_at),
    );
    return null;
  }
  if (action === "audit-finish") {
    if (!["completed", "failed"].includes(String(r.status)))
      throw new Error("review-invalid");
    db.prepare(
      "UPDATE operation_records SET status=?,result_json=?,finished_at=? WHERE operation_id=? AND status='running'",
    ).run(
      String(r.status),
      text(r.result_json, 65536),
      text(r.finished_at),
      text(r.operation_id),
    );
    return null;
  }
  if (action === "audit-list") {
    const limit = integer(r.limit, 50, 200),
      after = integer(r.after, 0, Number.MAX_SAFE_INTEGER);
    const conditions = ["sequence>?"];
    const args: SQLInputValue[] = [after];
    if (r.actor !== undefined) {
      conditions.push("actor=?");
      args.push(text(r.actor));
    }
    if (r.operation !== undefined) {
      conditions.push("operation=?");
      args.push(text(r.operation));
    }
    const rows = db
      .prepare(
        `SELECT * FROM operation_records WHERE ${conditions.join(" AND ")} ORDER BY sequence LIMIT ?`,
      )
      .all(...args, limit + 1);
    return {
      items: rows
        .slice(0, limit)
        .map(({ scope_json, result_json, ...row }) => ({
          ...row,
          scope: JSON.parse(String(scope_json)),
          result: result_json === null ? null : JSON.parse(String(result_json)),
        })),
      next_after:
        rows.length > limit ? Number(rows[limit - 1]!.sequence) : null,
    };
  }
  throw new Error("review-invalid");
}

function taskRun(db: DatabaseSync, r: Record<string, unknown>) {
  const id = text(r.job_id),
    offset = integer(r.offset, 0, 100000),
    limit = integer(r.limit, 50, 200);
  const job = db
    .prepare(
      "SELECT j.*,o.actor FROM execution_jobs j LEFT JOIN job_origins o USING(job_id) WHERE j.job_id=?",
    )
    .get(id);
  if (!job) return null;
  const selector = JSON.parse(String(job.selector_json));
  const operations = selector.request?.operations ?? [];
  const targetId = r.target_id === undefined ? null : text(r.target_id),
    memberOffset = integer(r.member_offset, 0, 100000),
    memberLimit = integer(r.member_limit, 20, 50);
  if (memberLimit < 1) throw new Error("review-invalid");
  const targetRows = targetId
    ? db
        .prepare(
          "SELECT * FROM execution_targets WHERE job_id=? AND target_id=?",
        )
        .all(id, targetId)
    : db
        .prepare(
          "SELECT * FROM execution_targets WHERE job_id=? ORDER BY ordinal LIMIT ? OFFSET ?",
        )
        .all(id, limit, offset);
  const count = Number(
    db
      .prepare("SELECT count(*) AS n FROM execution_targets WHERE job_id=?")
      .get(id)!.n,
  );
  const totalUsage = db
    .prepare(
      "SELECT COALESCE(sum(calls),0) AS calls,COALESCE(sum(input_tokens),0) AS input_tokens,COALESCE(sum(output_tokens),0) AS output_tokens FROM (SELECT calls,input_tokens,output_tokens FROM task_model_usage WHERE job_id=? UNION ALL SELECT calls,input_tokens,output_tokens FROM agent_sessions WHERE job_id=? AND status='running')",
    )
    .get(id, id);
  const members = targetRows.map((target) => {
    const op = operations[Number(target.ordinal)] ?? {},
      request = op.request ?? {};
    const ids = new Set<string>();
    if (target.literature_id) ids.add(String(target.literature_id));
    for (const source of request.inputs ?? []) {
      if (typeof source.literature_id === "string")
        ids.add(source.literature_id);
      if (source.kind === "snapshot" && typeof source.snapshot_id === "string")
        for (const member of db
          .prepare(
            "SELECT literature_id FROM snapshot_members WHERE snapshot_id=? ORDER BY ordinal",
          )
          .all(source.snapshot_id))
          ids.add(String(member.literature_id));
      for (const mapped of source.mapped_results ?? [])
        if (typeof mapped.literature_id === "string")
          ids.add(mapped.literature_id);
    }
    const synthesis = (request.inputs ?? []).some(
      (source: { kind: string }) => source.kind === "snapshot",
    );
    const literatures = (
      synthesis && !targetId
        ? []
        : [...ids].slice(memberOffset, memberOffset + memberLimit)
    ).map((literature_id) => ({
      literature_id,
      title:
        db
          .prepare(
            "SELECT title FROM literature_metadata WHERE literature_id=?",
          )
          .get(literature_id)?.title ?? null,
    }));
    const latest = db
      .prepare(
        "SELECT kind,payload_json,created_at FROM execution_events WHERE job_id=? AND json_extract(payload_json,'$.target_id')=? AND kind IN ('processing-result','attempt-failed','attempt-interrupted','attempt-skipped','processing-partial-result') ORDER BY sequence DESC LIMIT 1",
      )
      .get(id, String(target.target_id));
    const payload = latest ? JSON.parse(String(latest.payload_json)) : null,
      result = payload?.result;
    const usage = { calls: 0, input_tokens: 0, output_tokens: 0 },
      sessions: Record<string, unknown>[] = [],
      steps: Record<string, unknown>[] = [],
      mappedMembers: Record<string, unknown>[] = [];
    for (const lit of literatures) {
      const memberUsage = { calls: 0, input_tokens: 0, output_tokens: 0 };
      for (const u of db
        .prepare(
          "SELECT calls,input_tokens,output_tokens FROM task_model_usage WHERE job_id=? AND literature_id=? UNION ALL SELECT calls,input_tokens,output_tokens FROM agent_sessions WHERE job_id=? AND literature_id=? AND status='running'",
        )
        .all(id, lit.literature_id, id, lit.literature_id))
        for (const k of ["calls", "input_tokens", "output_tokens"] as const) {
          usage[k] += Number(u[k]);
          memberUsage[k] += Number(u[k]);
        }
      const history = db
        .prepare(
          "SELECT payload_json FROM execution_events WHERE job_id=? AND json_extract(payload_json,'$.target_id')=? AND kind='processor-map-progress' AND json_extract(payload_json,'$.literature_id')=? ORDER BY sequence DESC LIMIT 1",
        )
        .get(id, String(target.target_id), lit.literature_id);
      const progress = history
        ? JSON.parse(String(history.payload_json))
        : null;
      mappedMembers.push({
        ...lit,
        status:
          progress?.status ??
          (target.stage === "queued" || target.stage === "analysis"
            ? "pending"
            : "not-recorded"),
        usage: memberUsage,
        result: progress?.result ?? null,
      });
      sessions.push(
        ...db
          .prepare(
            "SELECT session_id,role,status,subject_json FROM agent_sessions WHERE job_id=? AND literature_id=? ORDER BY started_at DESC LIMIT 30",
          )
          .all(id, lit.literature_id)
          .map(({ subject_json, ...s }) => ({
            ...s,
            subject: JSON.parse(String(subject_json)),
          })),
      );
      steps.push(
        ...db
          .prepare(
            "SELECT * FROM task_steps WHERE job_id=? AND literature_id=? ORDER BY updated_at",
          )
          .all(id, lit.literature_id),
      );
    }
    const aggregate = synthesis
      ? db
          .prepare(
            "SELECT COALESCE(sum(calls),0) AS calls,COALESCE(sum(input_tokens),0) AS input_tokens,COALESCE(sum(output_tokens),0) AS output_tokens FROM (SELECT calls,input_tokens,output_tokens FROM task_model_usage WHERE job_id=? AND literature_id='' UNION ALL SELECT calls,input_tokens,output_tokens FROM agent_sessions WHERE job_id=? AND literature_id IS NULL AND status='running')",
          )
          .get(id, id)
      : null;
    if (synthesis)
      sessions.push(
        ...db
          .prepare(
            "SELECT session_id,role,status,subject_json FROM agent_sessions WHERE job_id=? AND literature_id IS NULL ORDER BY started_at DESC LIMIT 30",
          )
          .all(id)
          .map(({ subject_json, ...s }) => ({
            ...s,
            subject: JSON.parse(String(subject_json)),
          })),
      );
    const archiveRows =
      op.operation === "build-archive"
        ? db
            .prepare(
              "SELECT asset_id,step,status,output_json,reason FROM archive_steps WHERE literature_id=? AND json_extract(output_json,'$.schema_version')=2 ORDER BY asset_id,updated_at",
            )
            .all(request.literature_id)
            .map(({ output_json, ...s }) => {
              // The row's own status wins over any status inside a step's output; source maps stay in the document.
              const {
                pages,
                source_map: _sourceMap,
                ...output
              } = JSON.parse(String(output_json));
              void _sourceMap;
              return {
                ...output,
                ...s,
                pages: Array.isArray(pages)
                  ? {
                      required: pages.filter((p) => p.status !== "not-required")
                        .length,
                      accepted: pages.filter((p) => p.status === "accepted")
                        .length,
                      failed: pages.filter((p) => p.status === "failed").length,
                      pending: pages.filter((p) => p.status === "pending")
                        .length,
                    }
                  : null,
                page_status: Array.isArray(pages)
                  ? {
                      items: pages.slice(0, 200),
                      next_cursor:
                        pages.length > 200
                          ? archivePageCursor(String(output.proofread_id), 200)
                          : null,
                    }
                  : null,
              };
            })
        : null;
    return {
      ...(archiveRows
        ? {
            archive: {
              schema_version: 2,
              literature_id: request.literature_id,
              steps: archiveRows,
              events_truncated: false,
              next_event_cursor: null,
            },
          }
        : {}),
      synthesis,
      aggregate_usage: aggregate,
      target_id: target.target_id,
      status: target.stage,
      operation: op.operation ?? "acquire-pdf",
      processor: request.processor?.id ?? null,
      literatures,
      literature_count: ids.size,
      mapped_members: mappedMembers,
      next_member_offset:
        synthesis && targetId && memberOffset + memberLimit < ids.size
          ? memberOffset + memberLimit
          : null,
      steps,
      sessions,
      usage,
      result: result?.result_id
        ? {
            result_id: result.result_id,
            content_sha256: result.content_sha256,
            reused: result.reused ?? false,
            coverage: result.coverage ?? null,
          }
        : null,
      failure:
        payload?.failure ??
        (target.stage === "failed" ? "processing-failed" : null),
    };
  });
  return {
    job: {
      job_id: id,
      status: job.status,
      actor: job.actor ?? null,
      created_at: job.created_at,
      finished_at: job.finished_at,
    },
    usage: totalUsage,
    items: members,
    total_count: count,
    next_offset: !targetId && offset + limit < count ? offset + limit : null,
    collections: db
      .prepare(
        "SELECT collection_id,name FROM processor_collections WHERE run_id=? ORDER BY created_at",
      )
      .all(id),
  };
}

function processorRuns(db: DatabaseSync, r: Record<string, unknown>) {
  const limit = integer(r.limit, 30, 200),
    offset = integer(r.offset, 0, 100000),
    args: SQLInputValue[] = [],
    where: string[] = [];
  if (r.processor_id) {
    where.push("c.processor_id=?");
    args.push(text(r.processor_id));
  }
  if (r.snapshot_id) {
    where.push(
      "EXISTS(SELECT 1 FROM json_each(q.request_json,'$.inputs') s WHERE json_extract(s.value,'$.snapshot_id')=?)",
    );
    args.push(text(r.snapshot_id));
  }
  if (r.literature_id) {
    where.push(
      "EXISTS(SELECT 1 FROM processor_collection_members m JOIN processor_result_literatures l USING(result_id) WHERE m.collection_id=c.collection_id AND l.literature_id=?)",
    );
    args.push(text(r.literature_id));
  }
  if (r.literature_query) {
    where.push(
      "EXISTS(SELECT 1 FROM processor_collection_members m JOIN processor_result_literatures l USING(result_id) JOIN literature_metadata lm USING(literature_id) WHERE m.collection_id=c.collection_id AND (instr(lower(lm.title),lower(?))>0 OR l.literature_id=?))",
    );
    args.push(text(r.literature_query), text(r.literature_query));
  }
  if (r.stale !== undefined) {
    if (typeof r.stale !== "boolean") throw new Error("review-invalid");
    where.push(
      `${r.stale ? "" : "NOT "}EXISTS(SELECT 1 FROM processor_collection_members m JOIN processor_result_currentness f USING(result_id) WHERE m.collection_id=c.collection_id AND f.state='stale')`,
    );
  }
  const found = db
    .prepare(
      `SELECT c.*,o.actor,q.request_json FROM processor_collections c LEFT JOIN job_origins o ON o.job_id=c.run_id LEFT JOIN processor_run_requests q ON q.job_id=c.run_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.created_at DESC,c.collection_id LIMIT ? OFFSET ?`,
    )
    .all(...args, limit + 1, offset);
  return {
    items: found.slice(0, limit).map((row) => {
      const parts = db
        .prepare(
          "SELECT m.result_id,m.gap,s.outcomes_json,s.method_revision,f.state FROM processor_collection_members m LEFT JOIN processor_result_summaries s USING(result_id) LEFT JOIN processor_result_currentness f USING(result_id) WHERE m.collection_id=?",
        )
        .all(String(row.collection_id));
      const outcomes: Record<string, number> = {
        with_result: 0,
        empty: 0,
        incomplete: 0,
      };
      let known = true;
      for (const part of parts) {
        if (!part.result_id) continue;
        if (
          !part.outcomes_json ||
          part.method_revision !== PROCESSOR_METHOD_REVISION
        ) {
          known = false;
          continue;
        }
        const values = parseProcessorOutcomeCounts(
          JSON.parse(String(part.outcomes_json)),
        );
        for (const [key, value] of Object.entries(values))
          outcomes[key]! += value;
      }
      const request = row.request_json
        ? JSON.parse(String(row.request_json))
        : null;
      const sources = (request?.inputs ?? [])
        .slice(0, 200)
        .map(
          (source: {
            kind: string;
            snapshot_id?: string;
            literature_id?: string;
          }) =>
            source.kind === "snapshot"
              ? { kind: "snapshot", snapshot_id: source.snapshot_id }
              : {
                  kind: "literature",
                  literature_id: source.literature_id,
                  title: source.literature_id
                    ? db
                        .prepare(
                          "SELECT title FROM literature_metadata WHERE literature_id=?",
                        )
                        .get(source.literature_id)?.title
                    : null,
                },
        );
      return {
        collection_id: row.collection_id,
        run_id: row.run_id,
        name: row.name,
        processor_id: row.processor_id,
        created_at: row.created_at,
        actor: row.actor ?? null,
        sources,
        source_count: request?.inputs?.length ?? null,
        outcomes: known ? outcomes : null,
        failed_targets: parts.filter((p) => !p.result_id).length,
        stale: parts.some((p) => p.state === "stale"),
      };
    }),
    next_offset: found.length > limit ? offset + limit : null,
  };
}
