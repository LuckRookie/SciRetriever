const {
  beginCatalogWrite,
  commitCatalogWrite,
}: typeof import("./catalog-write.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./catalog-write.ts"
      : "./catalog-write.js",
    import.meta.url,
  ).href
);
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { IMPORT_LIMITS } from "@sciretriever/contracts";
import type {
  ImportLibrary,
  ImportSummary,
  ImportRecordResult,
  ImportFileStatus,
  ExternalObjectMapping,
  IntakeBatch,
} from "@sciretriever/contracts";
import type { IntakeWrite } from "./intake-engine.js";
const {
  readIntakeBatch,
  recordResolvedIntakeMember,
}: typeof import("./intake-engine.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./intake-engine.ts"
      : "./intake-engine.js",
    import.meta.url,
  ).href
);
import type { RetiredArtifact } from "../files/reclamation.js";
import type { IntakeItemRead, IntakeItemWrite } from "./intake-items.js";
const { readIntakeItem, writeIntakeItem }: typeof import("./intake-items.js") =
  await import(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./intake-items.ts"
        : "./intake-items.js",
      import.meta.url,
    ).href
  );

type Row = Record<string, SQLOutputValue>;
function summaryJson(summary: unknown): string {
  // Full-text availability is a live read projection, never a persisted fact.
  return JSON.stringify(summary, (key, value) =>
    key === "full_text" ? undefined : value,
  );
}
export interface StoredImportSession {
  readonly batch_id: string;
  readonly library_key: string;
  readonly source: ImportLibrary;
  readonly format: string;
  readonly scope: string;
  readonly file_name: string | null;
  readonly import_user_tags: boolean;
  readonly metadata_only: boolean;
  readonly state: IntakeBatch["state"];
  readonly confirmation: IntakeBatch["confirmation"];
  readonly created_at: string;
  readonly updated_at: string;
  readonly storage_failures: number;
  readonly owner_pid: number | null;
  readonly confirmed_at: string | null;
  readonly finished_at: string | null;
  readonly last_file_at: string | null;
  readonly initiated_by: string;
  readonly metadata_complete: boolean;
  readonly record_count: number;
  readonly processed_records: number;
  readonly pending_files: number;
  readonly origin: "web" | "cli" | "mcp";
  readonly summary: Omit<ImportSummary, "full_text"> | null;
}
export interface ImportReportSnapshot {
  readonly batch: IntakeBatch;
  readonly summary: Omit<ImportSummary, "full_text"> | null;
  readonly counts: Pick<ImportSummary, "records" | "files"> | null;
  readonly items: readonly ImportRecordResult[];
  readonly next_cursor: string | null;
}
export interface ImportPart extends RetiredArtifact {
  readonly artifact_id: string;
  readonly sequence: number;
  readonly record_count: number;
}
export type ImportRead =
  | { op: "items-read"; query: IntakeItemRead }
  | {
      op: "report-snapshot";
      batch_id: string;
      cursor: string | null;
      limit: number;
    }
  | { op: "workflow"; batch_id: string }
  | { op: "batch"; batch_id: string }
  | { op: "owner"; batch_id: string }
  | {
      op: "sessions";
      cursor: string | null;
      limit: number;
      initiated_by: string | null;
    }
  | { op: "active" }
  | { op: "cleanup" }
  | { op: "aggregate"; batch_id: string }
  | { op: "parts"; batch_id: string }
  | {
      op: "mapping";
      library_key: string;
      object_kind: ExternalObjectMapping["object_kind"];
      external_id: string;
    }
  | { op: "results"; batch_id: string; cursor: string | null; limit: number }
  | { op: "result"; batch_id: string; sequence: number; record_index: number }
  | {
      op: "files";
      batch_id: string;
      cursor: string | null;
      limit: number;
      pending: boolean;
    }
  | { op: "file"; batch_id: string; file_id: string }
  | { op: "folder"; folder_id: string | null; parent_id: string | null }
  | { op: "intake-member"; batch_id: string; literature_id: string };
export type ImportWrite =
  | { op: "items-write"; action: IntakeItemWrite }
  | {
      op: "create";
      batch: IntakeBatch;
      library_key: string;
      source: ImportLibrary;
      format: string;
      scope: string;
      file_name: string | null;
      import_user_tags: boolean;
      identity_scope: string;
    }
  | {
      op: "part";
      batch_id: string;
      sequence: number;
      part: RetiredArtifact;
      artifact_id: string;
      records: number;
      keys: readonly { kind: string; id: string }[];
      now: string;
    }
  | {
      op: "begin";
      batch_id: string;
      summary: ImportSummary;
      now: string;
    }
  | { op: "mapping"; mapping: ExternalObjectMapping }
  | {
      op: "processing-failure";
      batch_id: string;
      failures: number;
      storage: boolean;
      now: string;
    }
  | {
      op: "supplement";
      batch: IntakeBatch;
      day: string;
      item_id: string;
      file: ImportFileStatus;
      title: string | null;
    }
  | {
      op: "result" | "resolve-result";
      batch_id: string;
      item: ImportRecordResult;
      item_id: string;
      title: string | null;
      mapping: ExternalObjectMapping | null;
      files: readonly ImportFileStatus[];
      now: string;
    }
  | {
      op: "resolved-file";
      batch_id: string;
      item_id: string;
      file_id: string;
      status: "uploaded" | "existing" | "conflict";
      sha256: string;
      reason: string | null;
      now: string;
    }
  | {
      op: "metadata-done";
      batch_id: string;
      summary: ImportSummary;
      now: string;
    }
  | {
      op: "file-result";
      batch_id: string;
      file_id: string;
      status: "uploaded" | "existing" | "conflict";
      sha256: string;
      internal_id: string | null;
      reason: string | null;
      now: string;
    }
  | {
      op: "finish";
      batch_id: string;
      state: "finished" | "cancelled";
      summary: ImportSummary | null;
      now: string;
    }
  | { op: "retire-parts"; batch_id: string };
function fail(code: string): never {
  throw Object.assign(new Error("Import storage rejected"), { code });
}
/** Reclassify a finished batch after a retained decision/file is settled, without reopening it. */
function resolvedBatchResult(db: DatabaseSync, id: string) {
  db.prepare(
    "UPDATE intake_batches SET result=CASE WHEN NOT EXISTS(SELECT 1 FROM import_record_results WHERE batch_id=? AND disposition IN ('created','enriched','matched','restored')) THEN 'failed' WHEN EXISTS(SELECT 1 FROM import_record_results WHERE batch_id=? AND disposition IN ('conflict','rejected','pending-decision')) OR EXISTS(SELECT 1 FROM import_files WHERE batch_id=? AND status IN ('pending','conflict')) THEN 'partial' ELSE 'completed' END WHERE batch_id=? AND state='finished' AND result IN ('completed','partial','failed')",
  ).run(id, id, id, id);
}
function retainPendingItems(db: DatabaseSync, id: string, now: string) {
  db.prepare(
    "UPDATE intake_items SET retain_until=? WHERE batch_id=? AND disposition='pending-decision' AND recognition_json IS NOT NULL AND retain_until IS NULL",
  ).run(new Date(Date.parse(now) + 30 * 24 * 60 * 60 * 1000).toISOString(), id);
}
function str(v: SQLOutputValue | undefined): string {
  return String(v);
}
function nullable(v: SQLOutputValue | undefined): string | null {
  return v === null || v === undefined ? null : String(v);
}
function row(db: DatabaseSync, id: string): Row {
  const r = db
    .prepare(
      "SELECT s.batch_id,s.library_key,s.library_json,s.format,s.scope,s.file_name,s.import_user_tags,s.active,s.phase,s.storage_failures,s.created_at,s.updated_at,s.last_file_at,s.metadata_complete,s.record_count,s.summary_json,b.state,b.result,b.confirmation,b.confirmed_at,b.finished_at,b.initiated_by,b.origin,b.owner_pid,coalesce(json_extract(b.request_json,'$.metadata_only'),0) AS metadata_only FROM import_sessions s JOIN intake_batches b USING(batch_id) WHERE batch_id=?",
    )
    .get(id);
  if (!r) fail("intake-batch-state");
  return r;
}
function live(db: DatabaseSync, id: string, states: readonly string[]): Row {
  const r = row(db, id);
  if (!states.includes(str(r.state))) fail("intake-batch-state");
  return r;
}
function session(db: DatabaseSync, r: Row): StoredImportSession {
  const id = str(r.batch_id);
  return {
    batch_id: id,
    library_key: str(r.library_key),
    source: JSON.parse(str(r.library_json)) as ImportLibrary,
    format: str(r.format),
    scope: str(r.scope),
    file_name: nullable(r.file_name),
    import_user_tags: r.import_user_tags === 1,
    metadata_only: r.metadata_only === 1,
    state: r.state as IntakeBatch["state"],
    confirmation: r.confirmation as IntakeBatch["confirmation"],
    created_at: str(r.created_at),
    updated_at: str(r.updated_at),
    storage_failures: Number(r.storage_failures),
    owner_pid: r.owner_pid === null ? null : Number(r.owner_pid),
    confirmed_at: nullable(r.confirmed_at),
    finished_at: nullable(r.finished_at),
    last_file_at: nullable(r.last_file_at),
    initiated_by: str(r.initiated_by),
    metadata_complete: r.metadata_complete === 1,
    record_count: Number(r.record_count),
    processed_records: Number(
      db
        .prepare(
          "SELECT count(*) n FROM import_record_results WHERE batch_id=?",
        )
        .get(id)!.n,
    ),
    pending_files: Number(
      db
        .prepare(
          "SELECT count(*) n FROM import_files WHERE batch_id=? AND status='pending'",
        )
        .get(id)!.n,
    ),
    origin: r.origin as StoredImportSession["origin"],
    summary:
      r.summary_json === null
        ? null
        : (JSON.parse(str(r.summary_json)) as ImportSummary),
  };
}
function parts(db: DatabaseSync, id: string): ImportPart[] {
  return db
    .prepare(
      "SELECT p.batch_id,p.sequence,p.artifact_id,p.record_count,a.relative_path,a.sha256,a.byte_size,a.media_type FROM import_parts p JOIN artifact_objects a USING(artifact_id) WHERE batch_id=? ORDER BY sequence",
    )
    .all(id)
    .map((r) => ({
      artifact_id: str(r.artifact_id),
      sequence: Number(r.sequence),
      record_count: Number(r.record_count),
      reference: str(r.relative_path),
      artifact: {
        sha256: str(r.sha256),
        byte_size: Number(r.byte_size),
        media_type: str(r.media_type),
      } as ImportPart["artifact"],
    }));
}
function file(r: Row): ImportFileStatus {
  return {
    file_id: str(r.file_id),
    external_id: str(r.external_id),
    record_external_id: str(r.record_external_id),
    literature_id: str(r.literature_id),
    file_name: str(r.file_name),
    size_bytes: r.size_bytes === null ? null : Number(r.size_bytes),
    expected_sha256: nullable(r.expected_sha256),
    action: r.action as "upload" | "hash",
    status: r.status as ImportFileStatus["status"],
    sha256: nullable(r.sha256),
    reason: nullable(r.reason),
  };
}
function result(r: Row): ImportRecordResult {
  return {
    sequence: Number(r.sequence),
    record_index: Number(r.record_index),
    external_id: str(r.external_id),
    disposition: r.disposition as ImportRecordResult["disposition"],
    literature_id: nullable(r.literature_id),
    meta_literature_id: nullable(r.meta_literature_id),
    reason: nullable(r.reason),
  };
}
function map(db: DatabaseSync, m: ExternalObjectMapping) {
  db.prepare(
    "INSERT INTO external_object_mappings(library_key,object_kind,external_id,internal_id,content_sha256,observation_id,state) VALUES(?,?,?,?,?,?,?) ON CONFLICT(library_key,object_kind,external_id) DO UPDATE SET internal_id=excluded.internal_id,content_sha256=excluded.content_sha256,observation_id=excluded.observation_id,state=excluded.state",
  ).run(
    m.library_key,
    m.object_kind,
    m.external_id,
    m.internal_id,
    m.content_sha256,
    m.observation_id,
    m.state,
  );
}
export function readImportStorage(
  db: DatabaseSync,
  r: ImportRead,
  profile = "vlm-engine",
): unknown {
  if (r.op === "items-read") return readIntakeItem(db, r.query);
  if (r.op === "report-snapshot") {
    const batch = readIntakeBatch(db, r.batch_id, profile);
    if (batch.kind !== "import" || batch.source === null)
      return {
        batch,
        summary: null,
        counts: null,
        items: [],
        next_cursor: null,
      } satisfies ImportReportSnapshot;
    return {
      batch,
      summary: session(db, row(db, r.batch_id)).summary,
      counts: readImportStorage(
        db,
        { op: "aggregate", batch_id: r.batch_id },
        profile,
      ) as ImportReportSnapshot["counts"],
      ...(readImportStorage(
        db,
        {
          op: "results",
          batch_id: r.batch_id,
          cursor: r.cursor,
          limit: r.limit,
        },
        profile,
      ) as Pick<ImportReportSnapshot, "items" | "next_cursor">),
    } satisfies ImportReportSnapshot;
  }
  if (r.op === "workflow") return session(db, row(db, r.batch_id));
  if (r.op === "batch") return readIntakeBatch(db, r.batch_id, profile);
  if (r.op === "owner") {
    const value = db
      .prepare("SELECT initiated_by FROM intake_batches WHERE batch_id=?")
      .get(r.batch_id);
    if (!value) fail("intake-batch-missing");
    return value;
  }
  if (r.op === "active")
    return db
      .prepare(
        "SELECT s.batch_id,s.library_key,s.library_json,s.format,s.scope,s.file_name,s.import_user_tags,s.active,s.phase,s.storage_failures,s.created_at,s.updated_at,s.last_file_at,s.metadata_complete,s.record_count,s.summary_json,b.state,b.result,b.confirmation,b.confirmed_at,b.finished_at,b.initiated_by,b.origin,b.owner_pid,coalesce(json_extract(b.request_json,'$.metadata_only'),0) AS metadata_only FROM import_sessions s JOIN intake_batches b USING(batch_id) WHERE s.active=1 ORDER BY s.created_at,s.batch_id",
      )
      .all()
      .map((r) => session(db, r));
  if (r.op === "cleanup")
    return db
      .prepare(
        "WITH owners AS MATERIALIZED (SELECT DISTINCT batch_id FROM import_parts UNION SELECT DISTINCT batch_id FROM intake_items WHERE candidate_transfer_id IS NOT NULL OR json_extract(recognition_json,'$.retiring_transfer_id') IS NOT NULL UNION SELECT DISTINCT json_extract(record_json,'$.capture.session_id') FROM execution_candidates WHERE transfer_id LIKE 'intake-%' AND json_extract(record_json,'$.source_name')='import') SELECT s.batch_id FROM owners JOIN intake_batches s USING(batch_id) WHERE s.state IN ('finished','cancelled','withdrawn')",
      )
      .all()
      .map((r) => str(r.batch_id));
  if (r.op === "sessions") {
    const after =
      r.cursor === null
        ? null
        : db
            .prepare(
              "SELECT batch_id,created_at,initiated_by FROM intake_batches WHERE batch_id=?",
            )
            .get(r.cursor);
    if (r.cursor !== null && !after) fail("intake-batch-missing");
    if (
      after &&
      r.initiated_by !== null &&
      after.initiated_by !== r.initiated_by
    )
      fail("intake-batch-missing");
    const conditions = [
      ...(r.initiated_by === null ? [] : ["initiated_by=?"]),
      ...(after ? ["(created_at,batch_id)<(?,?)"] : []),
    ];
    const rows = db
      .prepare(
        `SELECT batch_id FROM intake_batches ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""} ORDER BY created_at DESC,batch_id DESC LIMIT ?`,
      )
      .all(
        ...(r.initiated_by === null ? [] : [r.initiated_by]),
        ...(after ? [after.created_at!, after.batch_id!] : []),
        r.limit + 1,
      );
    return {
      items: rows
        .slice(0, r.limit)
        .map((v) => readIntakeBatch(db, str(v.batch_id), profile)),
      next_cursor:
        rows.length > r.limit ? str(rows[r.limit - 1]!.batch_id) : null,
    };
  }
  if (r.op === "parts") {
    row(db, r.batch_id);
    return parts(db, r.batch_id);
  }
  if (r.op === "mapping")
    return (
      db
        .prepare(
          "SELECT library_key,object_kind,external_id,internal_id,content_sha256,observation_id,state FROM external_object_mappings WHERE library_key=? AND object_kind=? AND external_id=?",
        )
        .get(r.library_key, r.object_kind, r.external_id) ?? null
    );
  if (r.op === "folder")
    return {
      folder:
        r.folder_id === null
          ? null
          : (db
              .prepare(
                "SELECT folder_id,parent_id,name FROM folders WHERE folder_id=?",
              )
              .get(r.folder_id) ?? null),
      names: db
        .prepare("SELECT name FROM folders WHERE parent_id IS ?")
        .all(r.parent_id)
        .map((v) => str(v.name)),
    };
  if (r.op === "intake-member")
    return (
      db
        .prepare(
          "SELECT disposition FROM intake_batch_members WHERE batch_id=? AND literature_id=?",
        )
        .get(r.batch_id, r.literature_id) ?? null
    );
  row(db, r.batch_id);
  if (r.op === "aggregate") {
    const records = db
      .prepare(
        "SELECT count(CASE WHEN disposition='created' THEN 1 END) created,count(CASE WHEN disposition='enriched' THEN 1 END) enriched,count(CASE WHEN disposition='matched' THEN 1 END) matched,count(CASE WHEN disposition='conflict' THEN 1 END) conflicts,count(CASE WHEN disposition='rejected' THEN 1 END) rejected,count(CASE WHEN disposition='restored' THEN 1 END) restored,count(CASE WHEN disposition='pending-decision' THEN 1 END) pending_decision,(SELECT count(*) FROM intake_items WHERE batch_id=? AND json_array_length(possible_duplicates_json)>0) possible_duplicates,(SELECT count(DISTINCT i.literature_id) FROM import_record_results i JOIN literature_needs_metadata n USING(literature_id) WHERE i.batch_id=import_record_results.batch_id) needs_metadata FROM import_record_results WHERE batch_id=?",
      )
      .get(r.batch_id, r.batch_id);
    const files = db
      .prepare(
        "SELECT count(CASE WHEN status='pending' AND NOT EXISTS(SELECT 1 FROM literature_assets a WHERE a.literature_id=f.literature_id AND a.role='primary-pdf') THEN 1 END) upload,count(CASE WHEN status='pending' AND EXISTS(SELECT 1 FROM literature_assets a WHERE a.literature_id=f.literature_id AND a.role='primary-pdf') THEN 1 END) hash,count(CASE WHEN status='uploaded' THEN 1 END) uploaded,count(CASE WHEN status='existing' THEN 1 END) existing,count(CASE WHEN status='conflict' THEN 1 END) conflicts,count(CASE WHEN status='pending' THEN 1 END) missing,0 unpaired FROM import_files f WHERE batch_id=?",
      )
      .get(r.batch_id);
    const unpaired = Number(
      db
        .prepare(
          "SELECT count(*) n FROM intake_items WHERE batch_id=? AND unpaired=1",
        )
        .get(r.batch_id)!.n,
    );
    return { records, files: { ...files, unpaired } };
  }
  if (r.op === "result") {
    const v = db
      .prepare(
        "SELECT batch_id,sequence,record_index,item_id,external_id,disposition,literature_id,meta_literature_id,reason FROM import_record_results WHERE batch_id=? AND sequence=? AND record_index=?",
      )
      .get(r.batch_id, r.sequence, r.record_index);
    return v ? result(v) : null;
  }
  if (r.op === "file") {
    const v = db
      .prepare(
        "SELECT f.file_id,f.batch_id,f.item_id,f.external_id,f.record_external_id,f.literature_id,f.file_name,f.size_bytes,f.expected_sha256,f.action,f.status,f.sha256,f.reason,f.source_url,CASE WHEN f.status='pending' AND EXISTS(SELECT 1 FROM literature_assets a WHERE a.literature_id=f.literature_id AND a.role='primary-pdf') THEN 'hash' ELSE f.action END AS action FROM import_files f WHERE batch_id=? AND file_id=?",
      )
      .get(r.batch_id, r.file_id);
    if (!v) fail("intake-file-missing");
    return file(v);
  }
  if (r.op === "files") {
    const rows = db
      .prepare(
        `SELECT f.file_id,f.batch_id,f.item_id,f.external_id,f.record_external_id,f.literature_id,f.file_name,f.size_bytes,f.expected_sha256,f.action,f.status,f.sha256,f.reason,f.source_url,CASE WHEN f.status='pending' AND EXISTS(SELECT 1 FROM literature_assets a WHERE a.literature_id=f.literature_id AND a.role='primary-pdf') THEN 'hash' ELSE f.action END AS action FROM import_files f WHERE batch_id=? AND file_id>? ${r.pending ? "AND status='pending'" : ""} ORDER BY file_id LIMIT ?`,
      )
      .all(r.batch_id, r.cursor ?? "", r.limit + 1);
    return {
      items: rows.slice(0, r.limit).map(file),
      next_cursor:
        rows.length > r.limit ? str(rows[r.limit - 1]!.file_id) : null,
    };
  }
  const after = r.cursor === null ? [-1, -1] : r.cursor.split(":").map(Number);
  const rows = db
    .prepare(
      "SELECT batch_id,sequence,record_index,item_id,external_id,disposition,literature_id,meta_literature_id,reason FROM import_record_results WHERE batch_id=? AND (sequence,record_index)>(?,?) ORDER BY sequence,record_index LIMIT ?",
    )
    .all(r.batch_id, after[0]!, after[1]!, r.limit + 1);
  const last = rows[r.limit - 1];
  return {
    items: rows.slice(0, r.limit).map(result),
    next_cursor:
      rows.length > r.limit && last
        ? `${last.sequence}:${last.record_index}`
        : null,
  };
}

export function insertImportBatch(
  db: DatabaseSync,
  r: Extract<ImportWrite, { op: "create" }>,
  intakeWrite: (db: DatabaseSync, r: IntakeWrite) => unknown,
) {
  if (
    db
      .prepare("SELECT 1 FROM import_sessions WHERE library_key=? AND active=1")
      .get(r.library_key)
  )
    fail("intake-source-busy");
  const l = r.source,
    b = r.batch;
  db.prepare(
    "INSERT INTO import_libraries(library_key,system,external_library_id,identity_scope,name,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(library_key) DO NOTHING",
  ).run(
    r.library_key,
    l.system,
    l.library_id,
    r.identity_scope,
    l.name,
    b.created_at,
  );
  intakeWrite(db, {
    operation: "create",
    batch: b,
    owner_pid: b.confirmation === "per-item" ? null : process.pid,
  });
  db.prepare(
    "INSERT INTO import_sessions(batch_id,library_key,library_json,format,scope,file_name,import_user_tags,active,created_at,updated_at,metadata_complete,record_count,phase) VALUES(?,?,?,?,?,?,?,1,?,?,?,0,?)",
  ).run(
    b.batch_id,
    r.library_key,
    JSON.stringify(l),
    r.format,
    r.scope,
    r.file_name,
    Number(r.import_user_tags),
    b.created_at,
    b.created_at,
    Number(b.confirmation === "per-item"),
    b.confirmation === "per-item" ? "files" : "metadata",
  );
}
export function insertImportFiles(
  db: DatabaseSync,
  batchId: string,
  itemId: string,
  files: readonly ImportFileStatus[],
) {
  for (const f of files)
    db.prepare(
      "INSERT INTO import_files(file_id,batch_id,item_id,external_id,record_external_id,literature_id,file_name,size_bytes,expected_sha256,action,status,sha256,reason,source_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(batch_id,external_id) DO NOTHING",
    ).run(
      f.file_id,
      batchId,
      itemId,
      f.external_id,
      f.record_external_id,
      f.literature_id,
      f.file_name,
      f.size_bytes,
      f.expected_sha256,
      f.action,
      f.status,
      f.sha256,
      f.reason,
    );
}
export function writeImportStorage(
  db: DatabaseSync,
  r: ImportWrite,
  intakeWrite: (db: DatabaseSync, r: IntakeWrite) => unknown,
): unknown {
  beginCatalogWrite(db);
  try {
    let value: unknown = true;
    if (r.op === "items-write") value = writeIntakeItem(db, r.action);
    else if (r.op === "create") {
      insertImportBatch(db, r, intakeWrite);
    } else if (r.op === "mapping") map(db, r.mapping);
    else if (r.op === "part") {
      live(db, r.batch_id, ["collecting", "awaiting-confirmation"]);
      const old = parts(db, r.batch_id).find((p) => p.sequence === r.sequence);
      db.prepare(
        "DELETE FROM import_parts WHERE batch_id=? AND sequence=?",
      ).run(r.batch_id, r.sequence);
      db.prepare(
        "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?) ON CONFLICT(artifact_id) DO NOTHING",
      ).run(
        r.artifact_id,
        r.part.artifact.sha256,
        r.part.artifact.byte_size,
        r.part.artifact.media_type,
        r.part.reference,
      );
      db.prepare(
        "INSERT INTO import_parts(batch_id,sequence,artifact_id,record_count) VALUES(?,?,?,?)",
      ).run(r.batch_id, r.sequence, r.artifact_id, r.records);
      const put = db.prepare(
        "INSERT INTO import_staged_keys(batch_id,object_kind,external_id,sequence) VALUES(?,?,?,?)",
      );
      for (const key of r.keys) {
        if (
          db
            .prepare(
              "SELECT 1 FROM import_staged_keys WHERE batch_id=? AND object_kind=? AND external_id=?",
            )
            .get(r.batch_id, key.kind, key.id)
        )
          fail("intake-data-conflict");
        put.run(r.batch_id, key.kind, key.id, r.sequence);
      }
      const count = Number(
        db
          .prepare(
            "SELECT (SELECT coalesce(sum(record_count),0) FROM import_parts WHERE batch_id=?)+(SELECT count(*) FROM intake_items WHERE batch_id=? AND origin='file' AND json_extract(recognition_json,'$.paired_to') IS NULL) n",
          )
          .get(r.batch_id, r.batch_id)!.n,
      );
      const bytes = Number(
        db
          .prepare(
            "SELECT coalesce(sum(a.byte_size),0) n FROM import_parts p JOIN artifact_objects a USING(artifact_id) WHERE batch_id=?",
          )
          .get(r.batch_id)!.n,
      );
      const groups = Number(
        db
          .prepare(
            "SELECT count(*) n FROM import_staged_keys WHERE batch_id=? AND object_kind='group'",
          )
          .get(r.batch_id)!.n,
      );
      if (
        count > IMPORT_LIMITS.records ||
        bytes > IMPORT_LIMITS.batch_bytes ||
        groups > IMPORT_LIMITS.groups
      )
        fail("intake-batch-limit");
      db.prepare(
        "UPDATE import_sessions SET record_count=?,updated_at=? WHERE batch_id=?",
      ).run(count, r.now, r.batch_id);
      db.prepare(
        "UPDATE intake_batches SET state='awaiting-confirmation' WHERE batch_id=?",
      ).run(r.batch_id);
      if (old)
        db.prepare(
          "DELETE FROM artifact_objects WHERE artifact_id=? AND NOT EXISTS(SELECT 1 FROM import_parts WHERE artifact_id=?)",
        ).run(old.artifact_id, old.artifact_id);
    } else if (r.op === "begin") {
      const s = live(db, r.batch_id, [
        "awaiting-confirmation",
        "running",
        "finished",
      ]);
      if (s.state === "awaiting-confirmation") {
        db.prepare(
          "UPDATE intake_batches SET state='running',confirmed_at=?,owner_pid=? WHERE batch_id=?",
        ).run(r.now, process.pid, r.batch_id);
        db.prepare(
          "UPDATE import_sessions SET phase='metadata',last_file_at=?,updated_at=?,summary_json=? WHERE batch_id=?",
        ).run(r.now, r.now, summaryJson(r.summary), r.batch_id);
      }
    } else if (r.op === "supplement") {
      const opener = `supplement:${r.batch.origin}`;
      const open = db
        .prepare(
          "SELECT batch_id FROM intake_open_batches WHERE opener=? AND day=?",
        )
        .get(opener, r.day);
      const batchId = open ? str(open.batch_id) : r.batch.batch_id;
      if (!open) {
        insertImportBatch(
          db,
          {
            op: "create",
            batch: r.batch,
            library_key: r.batch.batch_id,
            source: r.batch.source!,
            format: "pdf",
            scope: "supplement PDF",
            file_name: null,
            import_user_tags: false,
            identity_scope: `adhoc:${r.batch.batch_id}`,
          },
          intakeWrite,
        );
        db.prepare(
          "INSERT INTO intake_open_batches(opener,day,batch_id) VALUES(?,?,?)",
        ).run(opener, r.day, batchId);
      }
      live(db, batchId, ["running"]);
      const position = Number(
        db
          .prepare(
            "SELECT count(*) n FROM import_record_results WHERE batch_id=?",
          )
          .get(batchId)!.n,
      );
      db.prepare(
        "INSERT INTO intake_items(item_id,batch_id,origin,external_id,title,file_name,disposition,literature_id,created_at) VALUES(?,?,'file',?,?,?,'matched',?,?)",
      ).run(
        r.item_id,
        batchId,
        r.file.external_id,
        r.title,
        r.file.file_name,
        r.file.literature_id,
        r.batch.created_at,
      );
      const meta = db
        .prepare(
          "SELECT meta_literature_id FROM literatures WHERE literature_id=?",
        )
        .get(r.file.literature_id);
      if (!meta) fail("intake-literature-missing");
      db.prepare(
        "INSERT INTO import_record_results(batch_id,sequence,record_index,item_id,external_id,disposition,literature_id,meta_literature_id) VALUES(?,0,?,?,?,'matched',?,?)",
      ).run(
        batchId,
        position,
        r.item_id,
        r.file.external_id,
        r.file.literature_id,
        meta.meta_literature_id!,
      );
      insertImportFiles(db, batchId, r.item_id, [r.file]);
      intakeWrite(db, {
        operation: "member",
        member: {
          batch_id: batchId as IntakeBatch["batch_id"],
          literature_id: r.file.literature_id,
          disposition: "matched",
        },
      });
      db.prepare(
        "UPDATE import_sessions SET record_count=record_count+1,updated_at=? WHERE batch_id=?",
      ).run(r.batch.created_at, batchId);
      value = batchId;
    } else if (r.op === "processing-failure") {
      const s = row(db, r.batch_id);
      if (s.state === "running") {
        const failures = Math.max(Number(s.storage_failures), r.failures);
        db.prepare(
          "UPDATE import_sessions SET storage_failures=?,updated_at=? WHERE batch_id=?",
        ).run(failures, r.now, r.batch_id);
        if (!r.storage || failures >= 3) {
          const summary =
            s.summary_json === null
              ? { excluded: [] }
              : JSON.parse(str(s.summary_json));
          const count = Number(
            db
              .prepare(
                "SELECT count(*) n FROM import_record_results WHERE batch_id=?",
              )
              .get(r.batch_id)!.n,
          );
          summary.excluded = [
            ...summary.excluded,
            {
              kind: r.storage ? "storage-failure" : "processing-failure",
              count: 1,
            },
            {
              kind: "unprocessed-records",
              count: Math.max(0, Number(s.record_count) - count),
            },
          ];
          db.prepare(
            "UPDATE intake_batches SET state='finished',result='failed',finished_at=?,owner_pid=NULL WHERE batch_id=?",
          ).run(r.now, r.batch_id);
          db.prepare(
            "UPDATE import_sessions SET active=0,phase='closing',summary_json=? WHERE batch_id=?",
          ).run(summaryJson(summary), r.batch_id);
          retainPendingItems(db, r.batch_id, r.now);
        }
      }
    } else if (r.op === "result" || r.op === "resolve-result") {
      live(db, r.batch_id, [r.op === "result" ? "running" : "finished"]);
      if (r.op === "resolve-result") {
        const old = db
          .prepare(
            "SELECT item_id,batch_id,origin,sequence,record_index,external_id,title,file_name,candidate_transfer_id,recognition_json,possible_duplicates_json,unpaired,needs_decision,decision_json,decided_by,decided_at,disposition,literature_id,retain_until,created_at FROM intake_items WHERE batch_id=? AND item_id=? AND disposition='pending-decision' AND retain_until>? AND recognition_json IS NOT NULL",
          )
          .get(r.batch_id, r.item_id, r.now);
        if (!old || old.decision_json === null) fail("intake-decision-invalid");
        const decision = JSON.parse(str(old.decision_json));
        if (
          !["new", "merge"].includes(decision.kind) ||
          (decision.kind === "merge" &&
            decision.literature_id !== r.item.literature_id &&
            r.item.literature_id !== null)
        )
          fail("intake-decision-invalid");
        if (r.item.literature_id) {
          if (
            !["created", "matched", "enriched", "restored"].includes(
              r.item.disposition,
            )
          )
            fail("intake-decision-invalid");
          recordResolvedIntakeMember(
            db,
            {
              batch_id: r.batch_id as IntakeBatch["batch_id"],
              literature_id: r.item.literature_id,
              disposition: r.item.disposition as
                | "created"
                | "enriched"
                | "matched"
                | "restored",
            },
            r.item_id,
            r.now,
          );
        }
        db.prepare(
          "DELETE FROM import_record_results WHERE item_id=? AND disposition='pending-decision'",
        ).run(r.item_id);
      }
      const i = r.item;
      db.prepare(
        "INSERT INTO intake_items(item_id,batch_id,origin,sequence,record_index,external_id,title,disposition,literature_id,created_at) VALUES(?,?,'data',?,?,?,?,?,?,?) ON CONFLICT(item_id) DO NOTHING",
      ).run(
        r.item_id,
        r.batch_id,
        i.sequence,
        i.record_index,
        i.external_id,
        r.title,
        i.disposition,
        i.literature_id,
        r.now,
      );
      db.prepare(
        "INSERT INTO import_record_results(batch_id,sequence,record_index,item_id,external_id,disposition,literature_id,meta_literature_id,reason) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      ).run(
        r.batch_id,
        i.sequence,
        i.record_index,
        r.item_id,
        i.external_id,
        i.disposition,
        i.literature_id,
        i.meta_literature_id,
        i.reason,
      );
      if (r.mapping) map(db, r.mapping);
      db.prepare(
        "UPDATE intake_items SET sequence=?,record_index=?,disposition=?,literature_id=?,needs_decision=CASE WHEN ?='pending-decision' THEN needs_decision ELSE 0 END WHERE item_id=?",
      ).run(
        i.sequence,
        i.record_index,
        i.disposition,
        i.literature_id,
        i.disposition,
        r.item_id,
      );
      insertImportFiles(db, r.batch_id, r.item_id, r.files);
      if (r.op === "resolve-result") resolvedBatchResult(db, r.batch_id);
      db.prepare(
        "UPDATE import_sessions SET storage_failures=0,updated_at=? WHERE batch_id=?",
      ).run(r.now, r.batch_id);
    } else if (r.op === "resolved-file") {
      live(db, r.batch_id, ["finished"]);
      const old = db
        .prepare(
          "SELECT f.status FROM import_files f JOIN intake_items i USING(item_id) WHERE f.batch_id=? AND f.file_id=? AND i.item_id=? AND i.retain_until>? AND json_extract(i.decision_json,'$.kind') IN ('new','merge') AND json_array_length(i.possible_duplicates_json)>0 AND i.literature_id=f.literature_id AND i.disposition IN ('created','matched','enriched','restored')",
        )
        .get(r.batch_id, r.file_id, r.item_id, r.now);
      if (!old) fail("intake-batch-state");
      if (old.status === "pending")
        db.prepare(
          "UPDATE import_files SET status=?,sha256=?,reason=? WHERE file_id=?",
        ).run(r.status, r.sha256, r.reason, r.file_id);
      resolvedBatchResult(db, r.batch_id);
    } else if (r.op === "metadata-done") {
      live(db, r.batch_id, ["running"]);
      db.prepare(
        "UPDATE import_sessions SET metadata_complete=1,storage_failures=0,phase='files',summary_json=?,updated_at=? WHERE batch_id=?",
      ).run(summaryJson(r.summary), r.now, r.batch_id);
      db.prepare("UPDATE intake_batches SET rejected=? WHERE batch_id=?").run(
        r.summary.records.rejected,
        r.batch_id,
      );
    } else if (r.op === "file-result") {
      const s = live(db, r.batch_id, ["running"]);
      const old = db
        .prepare(
          "SELECT file_id,batch_id,item_id,external_id,record_external_id,literature_id,file_name,size_bytes,expected_sha256,action,status,sha256,reason,source_url FROM import_files WHERE batch_id=? AND file_id=?",
        )
        .get(r.batch_id, r.file_id);
      if (!old) fail("intake-file-missing");
      if (old.status === "pending") {
        db.prepare(
          "UPDATE import_files SET status=?,sha256=?,reason=? WHERE file_id=?",
        ).run(r.status, r.sha256, r.reason, r.file_id);
        db.prepare(
          "UPDATE import_sessions SET updated_at=?,last_file_at=? WHERE batch_id=?",
        ).run(r.now, r.now, r.batch_id);
        if (
          r.internal_id &&
          (JSON.parse(str(s.library_json)) as ImportLibrary).identity !==
            "adhoc"
        )
          map(db, {
            library_key: str(s.library_key),
            object_kind: "file",
            external_id: str(old.external_id),
            internal_id: r.internal_id,
            content_sha256: r.sha256,
            observation_id: null,
            state: "settled",
          });
      }
    } else if (r.op === "finish") {
      const s = row(db, r.batch_id);
      if (!["finished", "cancelled", "withdrawn"].includes(str(s.state))) {
        const counts = db
          .prepare(
            "SELECT count(*) n,coalesce(sum(disposition IN ('created','enriched','matched','restored')),0) good,coalesce(sum(disposition IN ('conflict','rejected','pending-decision')),0) bad,coalesce(sum(disposition='rejected'),0) rejected FROM import_record_results WHERE batch_id=?",
          )
          .get(r.batch_id)!;
        const files = db
          .prepare(
            "SELECT count(*) n FROM import_files WHERE batch_id=? AND status IN ('pending','conflict')",
          )
          .get(r.batch_id)!.n;
        const result =
          r.state === "cancelled"
            ? null
            : s.metadata_complete !== 1
              ? "interrupted"
              : !Number(counts.good)
                ? "failed"
                : Number(counts.bad) + Number(files)
                  ? "partial"
                  : "completed";
        db.prepare(
          "UPDATE intake_batches SET state=?,result=?,finished_at=?,owner_pid=NULL,rejected=? WHERE batch_id=?",
        ).run(r.state, result, r.now, Number(counts.rejected), r.batch_id);
        db.prepare(
          "UPDATE import_sessions SET active=0,phase='closing',updated_at=?,summary_json=coalesce(?,summary_json) WHERE batch_id=?",
        ).run(
          r.now,
          r.summary === null ? null : summaryJson(r.summary),
          r.batch_id,
        );
        if (r.state === "finished") retainPendingItems(db, r.batch_id, r.now);
      }
    } else {
      const s = live(db, r.batch_id, ["finished", "cancelled", "withdrawn"]);
      void s;
      const retired = parts(db, r.batch_id);
      db.prepare("DELETE FROM import_parts WHERE batch_id=?").run(r.batch_id);
      for (const p of retired)
        db.prepare(
          "DELETE FROM artifact_objects WHERE artifact_id=? AND NOT EXISTS(SELECT 1 FROM import_parts WHERE artifact_id=?)",
        ).run(p.artifact_id, p.artifact_id);
      value = retired;
    }
    commitCatalogWrite(db);
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
