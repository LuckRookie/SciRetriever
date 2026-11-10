import type { DatabaseSync } from "node:sqlite";
import {
  parseIntakeBatchId,
  type CaptureResult,
  type ImportFileStatus,
  type IntakeBatch,
} from "@sciretriever/contracts";
import type * as Intake from "./intake-engine.js";

export interface StoredCapture {
  capture_id: string;
  connection_id: string;
  request_sha256: string;
  batch_id: string;
  literature_id: string | null;
  disposition: CaptureResult["disposition"] | null;
  created_at: string;
  result: Omit<CaptureResult, "file"> | null;
  file: ImportFileStatus | null;
}
export type CaptureRead = { capture_id: string; connection_id: string };
export type CaptureWrite =
  | {
      op: "ensure";
      capture_id: string;
      connection_id: string;
      request_id: string;
      request_sha256: string;
      day: string;
      now: string;
      batch: IntakeBatch;
    }
  | {
      op: "accepted";
      capture_id: string;
      connection_id: string;
      literature_id: string;
      disposition: CaptureResult["disposition"];
      replay: boolean;
      file: ImportFileStatus | null;
      now: string;
    }
  | {
      op: "result";
      capture_id: string;
      connection_id: string;
      result: Omit<CaptureResult, "file">;
    }
  | {
      op: "file";
      capture_id: string;
      connection_id: string;
      file: ImportFileStatus;
    };
function fail(code: string): never {
  throw Object.assign(new Error("capture storage rejected"), { code });
}
export function readCapture(db: DatabaseSync, r: CaptureRead): StoredCapture {
  const row = db
    .prepare(
      "SELECT * FROM capture_items WHERE capture_id=? AND connection_id=?",
    )
    .get(r.capture_id, r.connection_id);
  if (!row) fail("capture-missing");
  return {
    capture_id: String(row.capture_id),
    connection_id: String(row.connection_id),
    request_sha256: String(row.request_sha256),
    batch_id: String(row.batch_id),
    created_at: String(row.created_at),
    literature_id:
      row.literature_id === null ? null : String(row.literature_id),
    disposition: row.disposition as StoredCapture["disposition"],
    result:
      row.result_json === null ? null : JSON.parse(String(row.result_json)),
    file: row.file_json === null ? null : JSON.parse(String(row.file_json)),
  };
}
export function writeCapture(
  db: DatabaseSync,
  r: CaptureWrite,
  intake: typeof Intake,
) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (r.op === "ensure") {
      const old = db
        .prepare(
          "SELECT request_sha256 FROM capture_items WHERE capture_id=? AND connection_id=?",
        )
        .get(r.capture_id, r.connection_id);
      if (old && old.request_sha256 !== r.request_sha256)
        fail("capture-request-conflict");
      if (!old) {
        let batch = db
          .prepare(
            "SELECT batch_id FROM capture_daily_batches WHERE connection_id=? AND day=?",
          )
          .get(r.connection_id, r.day);
        if (!batch) {
          intake.writeIntakeBatch(db, {
            operation: "create",
            batch: r.batch,
            owner_pid: 0,
          });
          db.prepare(
            "UPDATE intake_batches SET status='completed',finished_at=?,owner_pid=NULL WHERE batch_id=?",
          ).run(r.now, r.batch.batch_id);
          db.prepare("INSERT INTO capture_daily_batches VALUES(?,?,?)").run(
            r.connection_id,
            r.day,
            r.batch.batch_id,
          );
          batch = { batch_id: r.batch.batch_id };
        }
        db.prepare(
          "INSERT INTO capture_items(capture_id,connection_id,request_id,request_sha256,batch_id,created_at) VALUES(?,?,?,?,?,?)",
        ).run(
          r.capture_id,
          r.connection_id,
          r.request_id,
          r.request_sha256,
          batch.batch_id!,
          r.now,
        );
      }
    } else {
      const old = readCapture(db, r);
      if (r.op === "accepted" && old.literature_id === null) {
        const member = r.replay
          ? db
              .prepare(
                "SELECT disposition FROM intake_batch_members WHERE batch_id=? AND literature_id=?",
              )
              .get(old.batch_id, r.literature_id)
          : null;
        const disposition = member?.disposition ?? r.disposition;
        db.prepare(
          "UPDATE capture_items SET literature_id=?,disposition=?,file_json=? WHERE capture_id=?",
        ).run(
          r.literature_id,
          disposition,
          r.file === null ? null : JSON.stringify(r.file),
          r.capture_id,
        );
        intake.recordIntakeMember(db, {
          batch_id: parseIntakeBatchId(old.batch_id),
          literature_id: r.literature_id,
          disposition: r.disposition,
        });
        db.prepare(
          "UPDATE intake_batches SET finished_at=? WHERE batch_id=?",
        ).run(r.now, old.batch_id);
      } else if (r.op === "result") {
        db.prepare(
          "UPDATE capture_items SET result_json=coalesce(result_json,?) WHERE capture_id=?",
        ).run(JSON.stringify(r.result), r.capture_id);
      } else if (r.op === "file") {
        if (!old.file) fail("capture-file-missing");
        if (old.file.status !== "pending" && old.file.sha256 !== r.file.sha256)
          fail("capture-file-conflict");
        db.prepare(
          "UPDATE capture_items SET file_json=? WHERE capture_id=?",
        ).run(JSON.stringify(r.file), r.capture_id);
      }
    }
    const value = readCapture(db, r);
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
