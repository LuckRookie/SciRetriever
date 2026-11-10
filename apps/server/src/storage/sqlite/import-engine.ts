import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { IMPORT_LIMITS } from "@sciretriever/contracts";
import type {
  ImportSession,
  ImportLibrary,
  ImportSummary,
  ImportRecordResult,
  ImportFileStatus,
  ExternalObjectMapping,
  IntakeBatch,
} from "@sciretriever/contracts";
import type { IntakeWrite } from "./intake-engine.js";
import type { RetiredArtifact } from "../files/reclamation.js";

type Row = Record<string, SQLOutputValue>;
export interface StoredImportSession extends ImportSession {
  readonly origin: "web" | "cli" | "mcp";
  readonly summary: ImportSummary | null;
}
export interface ImportPart extends RetiredArtifact {
  readonly artifact_id: string;
  readonly sequence: number;
  readonly record_count: number;
}
export type ImportRead =
  | { op: "session"; session_id: string }
  | { op: "sessions"; cursor: string | null; limit: number }
  | { op: "active" }
  | { op: "cleanup" }
  | { op: "aggregate"; session_id: string }
  | { op: "parts"; session_id: string }
  | {
      op: "mapping";
      library_key: string;
      object_kind: ExternalObjectMapping["object_kind"];
      external_id: string;
    }
  | { op: "results"; session_id: string; cursor: string | null; limit: number }
  | { op: "result"; session_id: string; sequence: number; record_index: number }
  | {
      op: "files";
      session_id: string;
      cursor: string | null;
      limit: number;
      pending: boolean;
    }
  | { op: "file"; session_id: string; file_id: string }
  | { op: "folder"; folder_id: string | null; parent_id: string | null }
  | { op: "intake-member"; batch_id: string; literature_id: string };
export type ImportWrite =
  | {
      op: "create";
      session: ImportSession;
      identity_scope: string;
      origin: "web" | "cli" | "mcp";
    }
  | {
      op: "part";
      session_id: string;
      sequence: number;
      part: RetiredArtifact;
      artifact_id: string;
      records: number;
      keys: readonly { kind: string; id: string }[];
      now: string;
    }
  | {
      op: "begin";
      session_id: string;
      batch: IntakeBatch;
      summary: ImportSummary;
      now: string;
    }
  | { op: "mapping"; mapping: ExternalObjectMapping }
  | {
      op: "result";
      session_id: string;
      item: ImportRecordResult;
      mapping: ExternalObjectMapping | null;
      files: readonly ImportFileStatus[];
      now: string;
    }
  | {
      op: "metadata-done";
      session_id: string;
      summary: ImportSummary;
      now: string;
    }
  | {
      op: "file-result";
      session_id: string;
      file_id: string;
      status: "uploaded" | "existing" | "conflict";
      sha256: string;
      internal_id: string | null;
      reason: string | null;
      now: string;
    }
  | {
      op: "finish";
      session_id: string;
      state: "completed" | "cancelled";
      summary: ImportSummary | null;
      now: string;
    }
  | { op: "retire-parts"; session_id: string };
function fail(code: string): never {
  throw Object.assign(new Error("Import storage rejected"), { code });
}
function str(v: SQLOutputValue | undefined): string {
  return String(v);
}
function nullable(v: SQLOutputValue | undefined): string | null {
  return v === null || v === undefined ? null : String(v);
}
function row(db: DatabaseSync, id: string): Row {
  const r = db
    .prepare("SELECT * FROM import_sessions WHERE session_id=?")
    .get(id);
  if (!r) fail("import-session-missing");
  return r;
}
function live(db: DatabaseSync, id: string, states: readonly string[]): Row {
  const r = row(db, id);
  if (!states.includes(str(r.state))) fail("import-session-state");
  return r;
}
function session(db: DatabaseSync, r: Row): StoredImportSession {
  const id = str(r.session_id);
  return {
    session_id: id,
    library_key: str(r.library_key),
    library: JSON.parse(str(r.library_json)) as ImportLibrary,
    format: str(r.format),
    scope: str(r.scope),
    file_name: nullable(r.file_name),
    import_user_tags: r.import_user_tags === 1,
    state: r.state as ImportSession["state"],
    created_at: str(r.created_at),
    updated_at: str(r.updated_at),
    confirmed_at: nullable(r.confirmed_at),
    finished_at: nullable(r.finished_at),
    last_file_at: nullable(r.last_file_at),
    initiated_by: str(r.initiated_by),
    intake_batch_id: nullable(r.batch_id),
    metadata_complete: r.metadata_complete === 1,
    record_count: Number(r.record_count),
    processed_records: Number(
      db
        .prepare(
          "SELECT count(*) n FROM import_record_results WHERE session_id=?",
        )
        .get(id)!.n,
    ),
    pending_files: Number(
      db
        .prepare(
          "SELECT count(*) n FROM import_files WHERE session_id=? AND status='pending'",
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
      "SELECT p.*,a.relative_path,a.sha256,a.byte_size,a.media_type FROM import_parts p JOIN artifact_objects a USING(artifact_id) WHERE session_id=? ORDER BY sequence",
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
    "INSERT INTO external_object_mappings VALUES(?,?,?,?,?,?) ON CONFLICT(library_key,object_kind,external_id) DO UPDATE SET internal_id=excluded.internal_id,content_sha256=excluded.content_sha256,observation_id=excluded.observation_id",
  ).run(
    m.library_key,
    m.object_kind,
    m.external_id,
    m.internal_id,
    m.content_sha256,
    m.observation_id,
  );
}
export function readImportStorage(db: DatabaseSync, r: ImportRead): unknown {
  if (r.op === "session") return session(db, row(db, r.session_id));
  if (r.op === "active")
    return db
      .prepare(
        "SELECT * FROM import_sessions WHERE state IN ('collecting','awaiting-confirmation','importing') ORDER BY created_at,session_id",
      )
      .all()
      .map((r) => session(db, r));
  if (r.op === "cleanup")
    return db
      .prepare(
        "WITH owners AS MATERIALIZED (SELECT DISTINCT session_id FROM import_parts) SELECT s.session_id FROM owners JOIN import_sessions s USING(session_id) WHERE s.state IN ('completed','cancelled')",
      )
      .all()
      .map((r) => str(r.session_id));
  if (r.op === "sessions") {
    const after = r.cursor === null ? null : row(db, r.cursor);
    const rows = db
      .prepare(
        `SELECT * FROM import_sessions ${after ? "WHERE (created_at,session_id)<(?,?)" : ""} ORDER BY created_at DESC,session_id DESC LIMIT ?`,
      )
      .all(
        ...(after ? [after.created_at!, after.session_id!] : []),
        r.limit + 1,
      );
    return {
      items: rows.slice(0, r.limit).map((r) => session(db, r)),
      next_cursor:
        rows.length > r.limit ? str(rows[r.limit - 1]!.session_id) : null,
    };
  }
  if (r.op === "parts") {
    row(db, r.session_id);
    return parts(db, r.session_id);
  }
  if (r.op === "mapping")
    return (
      db
        .prepare(
          "SELECT * FROM external_object_mappings WHERE library_key=? AND object_kind=? AND external_id=?",
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
  row(db, r.session_id);
  if (r.op === "aggregate") {
    const records = db
      .prepare(
        "SELECT count(CASE WHEN disposition='created' THEN 1 END) created,count(CASE WHEN disposition='enriched' THEN 1 END) enriched,count(CASE WHEN disposition='matched' THEN 1 END) matched,count(CASE WHEN disposition='conflict' THEN 1 END) conflicts,count(CASE WHEN disposition='rejected' THEN 1 END) rejected FROM import_record_results WHERE session_id=?",
      )
      .get(r.session_id);
    const files = db
      .prepare(
        "SELECT count(CASE WHEN status='pending' AND NOT EXISTS(SELECT 1 FROM literature_assets a WHERE a.literature_id=f.literature_id AND a.role='primary-pdf') THEN 1 END) upload,count(CASE WHEN status='pending' AND EXISTS(SELECT 1 FROM literature_assets a WHERE a.literature_id=f.literature_id AND a.role='primary-pdf') THEN 1 END) hash,count(CASE WHEN status='uploaded' THEN 1 END) uploaded,count(CASE WHEN status='existing' THEN 1 END) existing,count(CASE WHEN status='conflict' THEN 1 END) conflicts,count(CASE WHEN status='pending' THEN 1 END) missing FROM import_files f WHERE session_id=?",
      )
      .get(r.session_id);
    return { records, files };
  }
  if (r.op === "result") {
    const v = db
      .prepare(
        "SELECT * FROM import_record_results WHERE session_id=? AND sequence=? AND record_index=?",
      )
      .get(r.session_id, r.sequence, r.record_index);
    return v ? result(v) : null;
  }
  if (r.op === "file") {
    const v = db
      .prepare(
        "SELECT f.*,CASE WHEN f.status='pending' AND EXISTS(SELECT 1 FROM literature_assets a WHERE a.literature_id=f.literature_id AND a.role='primary-pdf') THEN 'hash' ELSE f.action END AS action FROM import_files f WHERE session_id=? AND file_id=?",
      )
      .get(r.session_id, r.file_id);
    if (!v) fail("import-file-missing");
    return file(v);
  }
  if (r.op === "files") {
    const rows = db
      .prepare(
        `SELECT f.*,CASE WHEN f.status='pending' AND EXISTS(SELECT 1 FROM literature_assets a WHERE a.literature_id=f.literature_id AND a.role='primary-pdf') THEN 'hash' ELSE f.action END AS action FROM import_files f WHERE session_id=? AND file_id>? ${r.pending ? "AND status='pending'" : ""} ORDER BY file_id LIMIT ?`,
      )
      .all(r.session_id, r.cursor ?? "", r.limit + 1);
    return {
      items: rows.slice(0, r.limit).map(file),
      next_cursor:
        rows.length > r.limit ? str(rows[r.limit - 1]!.file_id) : null,
    };
  }
  const after = r.cursor === null ? [-1, -1] : r.cursor.split(":").map(Number);
  const rows = db
    .prepare(
      "SELECT * FROM import_record_results WHERE session_id=? AND (sequence,record_index)>(?,?) ORDER BY sequence,record_index LIMIT ?",
    )
    .all(r.session_id, after[0]!, after[1]!, r.limit + 1);
  const last = rows[r.limit - 1];
  return {
    items: rows.slice(0, r.limit).map(result),
    next_cursor:
      rows.length > r.limit && last
        ? `${last.sequence}:${last.record_index}`
        : null,
  };
}
export function writeImportStorage(
  db: DatabaseSync,
  r: ImportWrite,
  intakeWrite: (db: DatabaseSync, r: IntakeWrite) => unknown,
): unknown {
  db.exec("BEGIN IMMEDIATE");
  try {
    let value: unknown = true;
    if (r.op === "create") {
      const s = r.session,
        l = s.library;
      if (
        db
          .prepare(
            "SELECT 1 FROM import_sessions WHERE library_key=? AND state IN ('collecting','awaiting-confirmation','importing')",
          )
          .get(s.library_key)
      )
        fail("import-library-busy");
      db.prepare(
        "INSERT INTO import_libraries VALUES(?,?,?,?,?,?) ON CONFLICT(library_key) DO NOTHING",
      ).run(
        s.library_key,
        l.system,
        l.library_id,
        r.identity_scope,
        l.name,
        s.created_at,
      );
      db.prepare(
        "INSERT INTO import_sessions(session_id,library_key,library_json,format,scope,file_name,import_user_tags,state,created_at,updated_at,initiated_by,origin) VALUES(?,?,?,?,?,?,?,'collecting',?,?,?,?)",
      ).run(
        s.session_id,
        s.library_key,
        JSON.stringify(l),
        s.format,
        s.scope,
        s.file_name,
        Number(s.import_user_tags),
        s.created_at,
        s.updated_at,
        s.initiated_by,
        r.origin,
      );
    } else if (r.op === "mapping") map(db, r.mapping);
    else if (r.op === "part") {
      live(db, r.session_id, ["collecting", "awaiting-confirmation"]);
      const old = parts(db, r.session_id).find(
        (p) => p.sequence === r.sequence,
      );
      db.prepare(
        "DELETE FROM import_parts WHERE session_id=? AND sequence=?",
      ).run(r.session_id, r.sequence);
      db.prepare(
        "INSERT INTO artifact_objects VALUES(?,?,?,?,?) ON CONFLICT(artifact_id) DO NOTHING",
      ).run(
        r.artifact_id,
        r.part.artifact.sha256,
        r.part.artifact.byte_size,
        r.part.artifact.media_type,
        r.part.reference,
      );
      db.prepare("INSERT INTO import_parts VALUES(?,?,?,?)").run(
        r.session_id,
        r.sequence,
        r.artifact_id,
        r.records,
      );
      const put = db.prepare("INSERT INTO import_staged_keys VALUES(?,?,?,?)");
      for (const key of r.keys) {
        if (
          db
            .prepare(
              "SELECT 1 FROM import_staged_keys WHERE session_id=? AND object_kind=? AND external_id=?",
            )
            .get(r.session_id, key.kind, key.id)
        )
          fail("import-data-conflict");
        put.run(r.session_id, key.kind, key.id, r.sequence);
      }
      const count = Number(
        db
          .prepare(
            "SELECT coalesce(sum(record_count),0) n FROM import_parts WHERE session_id=?",
          )
          .get(r.session_id)!.n,
      );
      const bytes = Number(
        db
          .prepare(
            "SELECT coalesce(sum(a.byte_size),0) n FROM import_parts p JOIN artifact_objects a USING(artifact_id) WHERE session_id=?",
          )
          .get(r.session_id)!.n,
      );
      const groups = Number(
        db
          .prepare(
            "SELECT count(*) n FROM import_staged_keys WHERE session_id=? AND object_kind='group'",
          )
          .get(r.session_id)!.n,
      );
      if (
        count > IMPORT_LIMITS.records ||
        bytes > IMPORT_LIMITS.session_bytes ||
        groups > IMPORT_LIMITS.groups
      )
        fail("import-session-limit");
      db.prepare(
        "UPDATE import_sessions SET record_count=?,state='awaiting-confirmation',updated_at=? WHERE session_id=?",
      ).run(count, r.now, r.session_id);
      if (old)
        db.prepare(
          "DELETE FROM artifact_objects WHERE artifact_id=? AND NOT EXISTS(SELECT 1 FROM import_parts WHERE artifact_id=?)",
        ).run(old.artifact_id, old.artifact_id);
    } else if (r.op === "begin") {
      const s = live(db, r.session_id, [
        "awaiting-confirmation",
        "importing",
        "completed",
      ]);
      if (s.state === "awaiting-confirmation") {
        intakeWrite(db, {
          operation: "create",
          batch: r.batch,
          owner_pid: process.pid,
        });
        db.prepare(
          "UPDATE import_sessions SET state='importing',confirmed_at=?,last_file_at=?,updated_at=?,batch_id=?,summary_json=? WHERE session_id=?",
        ).run(
          r.now,
          r.now,
          r.now,
          r.batch.batch_id,
          JSON.stringify(r.summary),
          r.session_id,
        );
      } else if (s.state === "importing")
        db.prepare(
          "UPDATE intake_batches SET owner_pid=? WHERE batch_id=? AND status='running'",
        ).run(process.pid, s.batch_id!);
    } else if (r.op === "result") {
      live(db, r.session_id, ["importing"]);
      const i = r.item;
      db.prepare(
        "INSERT INTO import_record_results VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      ).run(
        r.session_id,
        i.sequence,
        i.record_index,
        i.external_id,
        i.disposition,
        i.literature_id,
        i.meta_literature_id,
        i.reason,
      );
      if (r.mapping) map(db, r.mapping);
      for (const f of r.files)
        db.prepare(
          "INSERT INTO import_files VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,external_id) DO NOTHING",
        ).run(
          f.file_id,
          r.session_id,
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
      db.prepare(
        "UPDATE import_sessions SET updated_at=? WHERE session_id=?",
      ).run(r.now, r.session_id);
    } else if (r.op === "metadata-done") {
      const s = live(db, r.session_id, ["importing"]);
      if (s.metadata_complete !== 1) {
        const bad = r.summary.records.conflicts + r.summary.records.rejected,
          good =
            r.summary.records.created +
            r.summary.records.enriched +
            r.summary.records.matched;
        intakeWrite(db, {
          operation: "finish",
          batch_id: s.batch_id as IntakeBatch["batch_id"],
          status: bad ? (good ? "partial" : "failed") : "completed",
          discovery_run_id: null,
          source_failures: 0,
          rejected: bad,
        });
        db.prepare(
          "UPDATE import_sessions SET metadata_complete=1,summary_json=?,updated_at=? WHERE session_id=?",
        ).run(JSON.stringify(r.summary), r.now, r.session_id);
      }
    } else if (r.op === "file-result") {
      const s = live(db, r.session_id, ["importing"]);
      const old = db
        .prepare("SELECT * FROM import_files WHERE session_id=? AND file_id=?")
        .get(r.session_id, r.file_id);
      if (!old) fail("import-file-missing");
      if (old.status === "pending") {
        db.prepare(
          "UPDATE import_files SET status=?,sha256=?,reason=? WHERE file_id=?",
        ).run(r.status, r.sha256, r.reason, r.file_id);
        db.prepare(
          "UPDATE import_sessions SET updated_at=?,last_file_at=? WHERE session_id=?",
        ).run(r.now, r.now, r.session_id);
        if (r.internal_id)
          map(db, {
            library_key: str(s.library_key),
            object_kind: "file",
            external_id: str(old.external_id),
            internal_id: r.internal_id,
            content_sha256: r.sha256,
            observation_id: null,
          });
      }
    } else if (r.op === "finish") {
      const s = row(db, r.session_id);
      if (s.state !== "completed" && s.state !== "cancelled") {
        if (
          s.batch_id !== null &&
          db
            .prepare("SELECT status FROM intake_batches WHERE batch_id=?")
            .get(s.batch_id!)?.status === "running"
        ) {
          const bad = Number(
            db
              .prepare(
                "SELECT count(*) n FROM import_record_results WHERE session_id=? AND disposition IN ('conflict','rejected')",
              )
              .get(r.session_id)!.n,
          );
          intakeWrite(db, {
            operation: "finish",
            batch_id: s.batch_id as IntakeBatch["batch_id"],
            status: "interrupted",
            discovery_run_id: null,
            source_failures: 0,
            rejected: bad,
          });
        }
        db.prepare(
          "UPDATE import_sessions SET state=?,finished_at=?,updated_at=?,summary_json=coalesce(?,summary_json) WHERE session_id=?",
        ).run(
          r.state,
          r.now,
          r.now,
          r.summary === null ? null : JSON.stringify(r.summary),
          r.session_id,
        );
      }
    } else {
      const s = live(db, r.session_id, ["completed", "cancelled"]);
      void s;
      const retired = parts(db, r.session_id);
      db.prepare("DELETE FROM import_parts WHERE session_id=?").run(
        r.session_id,
      );
      for (const p of retired)
        db.prepare(
          "DELETE FROM artifact_objects WHERE artifact_id=? AND NOT EXISTS(SELECT 1 FROM import_parts WHERE artifact_id=?)",
        ).run(p.artifact_id, p.artifact_id);
      value = retired;
    }
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
