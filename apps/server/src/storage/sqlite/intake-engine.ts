import type { DatabaseSync } from "node:sqlite";
const { recordIntakeObject }: typeof import("./intake-objects.js") =
  await import(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./intake-objects.ts"
        : "./intake-objects.js",
      import.meta.url,
    ).href
  );
const {
  restoreWithdrawnLiterature,
}: typeof import("./intake-withdrawal-engine.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./intake-withdrawal-engine.ts"
      : "./intake-withdrawal-engine.js",
    import.meta.url,
  ).href
);
import {
  ContractValidationError,
  parseIntakeBatch,
  parseIntakeBatchQuery,
  parseIntakeBatchRename,
  type IntakeBatch,
  type IntakeBatchId,
} from "@sciretriever/contracts";
const {
  fullTextCountsProjection,
  fullTextCountsFromRow,
}: typeof import("./full-text-counts.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./full-text-counts.ts"
      : "./full-text-counts.js",
    import.meta.url,
  ).href
);
const { parseDocumentCount }: typeof import("./library-page.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./library-page.ts" : "./library-page.js",
    import.meta.url,
  ).href
);

export interface IntakeMember {
  readonly batch_id: IntakeBatchId;
  readonly literature_id: string;
  readonly disposition: "created" | "enriched" | "matched" | "restored";
  readonly authoritative?: boolean;
  /** A decided retained item uses the existing finished-batch admission check. */
  readonly resolution?: { readonly item_id: string; readonly now: string };
}
export type IntakeWrite =
  | {
      readonly operation: "create";
      readonly batch: IntakeBatch;
      readonly owner_pid: number | null;
    }
  | { readonly operation: "member"; readonly member: IntakeMember }
  | {
      readonly operation: "resume-citation";
      readonly batch_id: IntakeBatchId;
      readonly discovery_run_id: string;
      readonly owner_pid: number;
    }
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
  if (member.resolution) {
    recordResolvedIntakeMember(
      db,
      member,
      member.resolution.item_id,
      member.resolution.now,
    );
    return;
  }
  const batch = db
    .prepare("SELECT state FROM intake_batches WHERE batch_id=?")
    .get(member.batch_id);
  if (batch?.state !== "running")
    throw new Error("intake batch is not running");
  insertIntakeMember(db, member);
}
/** Only resolution of a retained, decided item may add a member to a finished batch. */
export function recordResolvedIntakeMember(
  db: DatabaseSync,
  member: IntakeMember,
  itemId: string,
  now: string,
): void {
  const pending = db
    .prepare(
      "SELECT 1 FROM intake_items i JOIN intake_batches b USING(batch_id) WHERE i.batch_id=? AND i.item_id=? AND b.state='finished' AND i.disposition='pending-decision' AND i.retain_until>? AND json_extract(i.decision_json,'$.kind') IN ('new','merge') AND json_array_length(i.possible_duplicates_json)>0",
    )
    .get(member.batch_id, itemId, now);
  if (!pending)
    throw new Error("intake item is not awaiting a retained decision");
  insertIntakeMember(db, member);
}
function insertIntakeMember(db: DatabaseSync, member: IntakeMember): void {
  if (restoreWithdrawnLiterature(db, member.literature_id))
    member = { ...member, disposition: "restored" };
  db.prepare(
    `INSERT INTO intake_batch_members(batch_id,literature_id,disposition) VALUES(?,?,?) ON CONFLICT(batch_id,literature_id) DO UPDATE SET disposition=${member.authoritative ? "excluded.disposition" : "CASE WHEN disposition='restored' OR excluded.disposition='restored' THEN 'restored' WHEN disposition='created' OR excluded.disposition='created' THEN 'created' WHEN disposition='enriched' OR excluded.disposition='enriched' THEN 'enriched' ELSE 'matched' END"}`,
  ).run(member.batch_id, member.literature_id, member.disposition);
  if (member.disposition === "created")
    recordIntakeObject(db, member.batch_id, "literature", member.literature_id);
}
export function intakeMemberships(db: DatabaseSync, id: string) {
  return db
    .prepare(
      "SELECT b.batch_id,coalesce(b.label,b.default_label) AS label FROM intake_batches b JOIN intake_batch_members m ON m.batch_id=b.batch_id WHERE m.literature_id=? ORDER BY b.created_at DESC,b.batch_id DESC",
    )
    .all(id);
}
export function readIntakeBatch(
  db: DatabaseSync,
  id: string,
  profile = "vlm-engine",
): IntakeBatch {
  const row = db
    .prepare(
      "SELECT batch_id,kind,default_label,label,origin,created_at,finished_at,state,result,confirmation,confirmed_at,initiated_by,request_json,discovery_run_id,rejected,source_failures,owner_pid FROM intake_batches WHERE batch_id=?",
    )
    .get(id);
  if (!row)
    throw Object.assign(new Error("intake batch not found"), {
      code: "intake-batch-missing",
    });
  const matching = {
    sql: "SELECT literature_id FROM intake_batch_members WHERE batch_id=?",
    parameters: [id],
  };
  const fullText = fullTextCountsProjection(
    matching.sql,
    "count(DISTINCT l.meta_literature_id)",
  );
  const counts = db
    .prepare(
      `WITH ${fullText.cte} SELECT ${fullText.columns},count(*) AS hits,coalesce(sum(m.disposition='created'),0) AS created,coalesce(sum(m.disposition='enriched'),0) AS enriched,coalesce(sum(m.disposition='matched'),0) AS matched,coalesce(sum(m.disposition='restored'),0) AS restored,count(n.literature_id) AS needs_metadata,count(p.literature_id) AS has_pdf,coalesce(sum(CASE WHEN p.literature_id IS NULL AND EXISTS(SELECT 1 FROM automatic_pdf_acquisition_exhaustions ex WHERE ex.literature_id=m.literature_id) THEN sr_status(m.literature_id)='UNREVIEWED' ELSE 0 END),0) AS unavailable FROM intake_batch_members m JOIN literatures l ON l.literature_id=m.literature_id LEFT JOIN literature_assets p ON p.literature_id=m.literature_id AND p.role='primary-pdf' LEFT JOIN literature_needs_metadata n ON n.literature_id=m.literature_id WHERE m.batch_id=?`,
    )
    .get(...matching.parameters, id)!;
  const { has_pdf, unavailable, total, obtained, exhausted, ...members } =
    counts;
  const imported =
    row.kind === "import"
      ? db
          .prepare(
            "SELECT batch_id,library_key,library_json,format,scope,file_name,import_user_tags,active,phase,storage_failures,created_at,updated_at,last_file_at,metadata_complete,record_count,summary_json FROM import_sessions WHERE batch_id=?",
          )
          .get(id)
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
  const files = db
    .prepare(
      "SELECT coalesce(sum(status='uploaded'),0) AS uploaded,coalesce(sum(status='existing'),0) AS existing,coalesce(sum(status='conflict'),0) AS conflicts,coalesce(sum(status='pending'),0) AS pending FROM import_files WHERE batch_id=?",
    )
    .get(id)!;
  // Query acquisition skips exactly the two categories already counted here.
  const pendingPdf =
    Number(counts.hits) - Number(has_pdf) - Number(unavailable);
  return parseIntakeBatch({
    full_text: fullTextCountsFromRow({ total, obtained, exhausted }),
    estimates: {
      acquire_pdf: pendingPdf,
      parse:
        Number(has_pdf) === 0 ? 0 : parseDocumentCount(db, matching, profile),
    },
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
      ...members,
      rejected: imported ? Number(records.rejected) : Number(row.rejected),
      conflicts: records.conflicts,
      pending_decision: records.pending_decision,
      possible_duplicates: items.possible_duplicates,
    },
    pdf: {
      has_pdf,
      unavailable,
      pending: pendingPdf,
    },
    discovery_run_id: row.discovery_run_id,
    source_failures: row.source_failures,
  });
}
export function queryIntakeBatches(
  db: DatabaseSync,
  value: unknown,
  profile = "vlm-engine",
) {
  const q = parseIntakeBatchQuery(value);
  if (q.operation === "get")
    return readIntakeBatch(db, q.request.batch_id, profile);
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
      .map((row) => readIntakeBatch(db, String(row.batch_id), profile)),
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
  else if (action.operation === "resume-citation") {
    const resumed = db
      .prepare(
        "UPDATE intake_batches SET state='running',result=NULL,finished_at=NULL,owner_pid=? WHERE batch_id=? AND kind='citation' AND (discovery_run_id IS NULL OR discovery_run_id=?) AND (state='running' OR (state='finished' AND result='interrupted'))",
      )
      .run(action.owner_pid, action.batch_id, action.discovery_run_id);
    if (resumed.changes !== 1) throw new Error("citation intake cannot resume");
  } else if (action.operation === "finish") {
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
