import type { DatabaseSync } from "node:sqlite";
import {
  ContractValidationError,
  parseIntakeBatch,
  parseIntakeBatchQuery,
  parseIntakeBatchRename,
  type IntakeBatch,
  type IntakeBatchId,
} from "@sciretriever/contracts";

export interface IntakeMember {
  readonly batch_id: IntakeBatchId;
  readonly literature_id: string;
  readonly disposition: "created" | "enriched" | "matched";
}
export type IntakeWrite =
  | {
      readonly operation: "create";
      readonly batch: IntakeBatch;
      readonly owner_pid: number | null;
    }
  | { readonly operation: "member"; readonly member: IntakeMember }
  | {
      readonly operation: "finish";
      readonly batch_id: IntakeBatchId;
      readonly result: NonNullable<IntakeBatch["result"]>;
      readonly discovery_run_id: string | null;
      readonly source_failures: number;
      readonly rejected: number;
    }
  | { readonly operation: "rename"; readonly request: unknown };
export function recordIntakeMember(
  db: DatabaseSync,
  member: IntakeMember,
): void {
  const batch = db
    .prepare("SELECT state FROM intake_batches WHERE batch_id=?")
    .get(member.batch_id);
  if (batch?.state !== "running")
    throw new Error("intake batch is not running");
  db.prepare(
    "INSERT INTO intake_batch_members VALUES(?,?,?) ON CONFLICT(batch_id,literature_id) DO UPDATE SET disposition=CASE WHEN disposition='created' OR excluded.disposition='created' THEN 'created' WHEN disposition='enriched' OR excluded.disposition='enriched' THEN 'enriched' ELSE 'matched' END",
  ).run(member.batch_id, member.literature_id, member.disposition);
}
export function intakeMemberships(db: DatabaseSync, id: string) {
  return db
    .prepare(
      "SELECT b.batch_id,coalesce(b.label,b.default_label) AS label FROM intake_batches b JOIN intake_batch_members m ON m.batch_id=b.batch_id WHERE m.literature_id=? ORDER BY b.created_at DESC,b.batch_id DESC",
    )
    .all(id);
}
export function readIntakeBatch(db: DatabaseSync, id: string): IntakeBatch {
  const row = db
    .prepare("SELECT * FROM intake_batches WHERE batch_id=?")
    .get(id);
  if (!row)
    throw Object.assign(new Error("intake batch not found"), {
      code: "intake-batch-missing",
    });
  const counts = db
    .prepare(
      "SELECT count(*) AS hits,coalesce(sum(disposition='created'),0) AS created,coalesce(sum(disposition='enriched'),0) AS enriched,coalesce(sum(disposition='matched'),0) AS matched,coalesce(sum(disposition='restored'),0) AS restored FROM intake_batch_members WHERE batch_id=?",
    )
    .get(id)!;
  const pdf = db
    .prepare(
      "WITH members AS MATERIALIZED (SELECT m.literature_id,EXISTS(SELECT 1 FROM literature_assets p WHERE p.literature_id=m.literature_id AND p.role='primary-pdf') AS has_pdf FROM intake_batch_members m WHERE batch_id=?) SELECT coalesce(sum(has_pdf),0) AS has_pdf,coalesce(sum(NOT has_pdf AND EXISTS(SELECT 1 FROM automatic_pdf_acquisition_exhaustions ex WHERE ex.literature_id=members.literature_id) AND sr_status(literature_id)='UNREVIEWED'),0) AS unavailable FROM members",
    )
    .get(id)!;
  const imported =
    row.kind === "import"
      ? db.prepare("SELECT * FROM import_sessions WHERE batch_id=?").get(id)
      : undefined;
  let state = row.state,
    result = row.result;
  if (state === "running" && !imported && row.owner_pid !== null) {
    try {
      process.kill(Number(row.owner_pid), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        state = "finished";
        result = "interrupted";
      } else throw error;
    }
  }
  const records = db
    .prepare(
      "SELECT count(*) AS processed,coalesce(sum(disposition='rejected'),0) AS rejected,coalesce(sum(disposition='conflict'),0) AS conflicts,coalesce(sum(disposition='pending-decision'),0) AS pending_decision FROM import_record_results WHERE batch_id=?",
    )
    .get(id)!;
  const items = db
    .prepare(
      "SELECT coalesce(sum(json_array_length(possible_duplicates_json)>0),0) AS possible_duplicates FROM intake_items WHERE batch_id=?",
    )
    .get(id)!;
  const needs = db
    .prepare(
      "SELECT count(*) n FROM intake_batch_members m JOIN literature_needs_metadata n USING(literature_id) WHERE m.batch_id=?",
    )
    .get(id)!.n;
  const files = db
    .prepare(
      "SELECT coalesce(sum(status='uploaded'),0) AS uploaded,coalesce(sum(status='existing'),0) AS existing,coalesce(sum(status='conflict'),0) AS conflicts,coalesce(sum(status='pending'),0) AS pending FROM import_files WHERE batch_id=?",
    )
    .get(id)!;
  return parseIntakeBatch({
    batch_id: row.batch_id,
    kind: row.kind,
    label: row.label ?? row.default_label,
    default_label: row.default_label,
    renamed: row.label !== null,
    origin: row.origin,
    created_at: row.created_at,
    finished_at: row.finished_at,
    state,
    result,
    confirmation: row.confirmation,
    confirmed_at: row.confirmed_at,
    initiated_by: row.initiated_by,
    source: imported ? JSON.parse(String(imported.library_json)) : null,
    progress:
      state === "running" && imported
        ? {
            phase: imported.phase,
            processed_items: records.processed,
            total_items: imported.record_count,
            files,
          }
        : null,
    request: JSON.parse(String(row.request_json)),
    counts: {
      ...counts,
      rejected: imported ? Number(records.rejected) : Number(row.rejected),
      conflicts: records.conflicts,
      pending_decision: records.pending_decision,
      possible_duplicates: items.possible_duplicates,
      needs_metadata: needs,
    },
    pdf: {
      ...pdf,
      pending:
        Number(counts.hits) - Number(pdf.has_pdf) - Number(pdf.unavailable),
    },
    discovery_run_id: row.discovery_run_id,
    source_failures: row.source_failures,
  });
}
export function queryIntakeBatches(db: DatabaseSync, value: unknown) {
  const q = parseIntakeBatchQuery(value);
  if (q.operation === "get") return readIntakeBatch(db, q.request.batch_id);
  const { limit, cursor } = q.request;
  let after: { at: string; id: string } | null = null;
  if (cursor !== null) {
    try {
      const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (
        typeof v.at !== "string" ||
        typeof v.id !== "string" ||
        Object.keys(v).sort().join() !== "at,id"
      )
        throw new Error("invalid cursor");
      after = v;
    } catch {
      throw new ContractValidationError();
    }
  }
  const rows = db
    .prepare(
      `SELECT batch_id,created_at FROM intake_batches ${after ? "WHERE (created_at,batch_id)<(?,?)" : ""} ORDER BY created_at DESC,batch_id DESC LIMIT ?`,
    )
    .all(...(after ? [after.at, after.id] : []), limit + 1);
  const last = rows[limit - 1];
  return {
    items: rows
      .slice(0, limit)
      .map((row) => readIntakeBatch(db, String(row.batch_id))),
    next_cursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({ at: last.created_at, id: last.batch_id }),
          ).toString("base64url")
        : null,
  };
}
export function writeIntakeBatch(db: DatabaseSync, action: IntakeWrite) {
  if (action.operation === "create") {
    const b = parseIntakeBatch(action.batch);
    db.prepare(
      "INSERT INTO intake_batches(batch_id,kind,default_label,label,origin,created_at,finished_at,state,result,confirmation,confirmed_at,initiated_by,request_json,discovery_run_id,rejected,source_failures,owner_pid) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      b.batch_id,
      b.kind,
      b.default_label,
      b.renamed ? b.label : null,
      b.origin,
      b.created_at,
      b.finished_at,
      b.state,
      b.result,
      b.confirmation,
      b.confirmed_at,
      b.initiated_by,
      JSON.stringify(b.request),
      b.discovery_run_id,
      b.counts.rejected,
      b.source_failures,
      action.owner_pid,
    );
  } else if (action.operation === "member")
    recordIntakeMember(db, action.member);
  else if (action.operation === "finish") {
    if (
      !["completed", "partial", "failed", "interrupted"].includes(
        action.result,
      ) ||
      !Number.isSafeInteger(action.rejected) ||
      action.rejected < 0 ||
      !Number.isSafeInteger(action.source_failures) ||
      action.source_failures < 0
    )
      throw new ContractValidationError();
    const result = db
      .prepare(
        "UPDATE intake_batches SET state='finished',result=?,finished_at=?,discovery_run_id=?,rejected=?,source_failures=?,owner_pid=NULL WHERE batch_id=? AND state='running'",
      )
      .run(
        action.result,
        new Date().toISOString(),
        action.discovery_run_id,
        action.rejected,
        action.source_failures,
        action.batch_id,
      );
    if (result.changes !== 1) throw new Error("intake batch already settled");
  } else {
    const r = parseIntakeBatchRename(action.request);
    if (
      db
        .prepare("UPDATE intake_batches SET label=? WHERE batch_id=?")
        .run(r.label, r.batch_id).changes !== 1
    )
      throw Object.assign(new Error("intake batch not found"), {
        code: "intake-batch-missing",
      });
  }
  return true;
}
