import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  parseIntakeBatchId,
  type IntakePageResult as CaptureResult,
  type ImportFileStatus,
  type IntakeBatch,
} from "@sciretriever/contracts";
import type * as Intake from "./intake-engine.js";
const {
  insertImportBatch,
  insertImportFiles,
  readImportStorage,
}: typeof import("./import-engine.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./import-engine.ts"
      : "./import-engine.js",
    import.meta.url,
  ).href
);

export interface StoredCapture {
  item_id: string;
  connection_id: string;
  request_sha256: string;
  batch_id: string;
  literature_id: string | null;
  disposition: CaptureResult["disposition"];
  created_at: string;
  result: Omit<CaptureResult, "file"> | null;
  file: ImportFileStatus | null;
}
export type CaptureRead = { item_id: string; connection_id: string };
export type CaptureWrite =
  | {
      op: "ensure";
      item_id: string;
      connection_id: string;
      request_id: string;
      request_sha256: string;
      day: string;
      now: string;
      title: string | null;
      file_name: string | null;
      batch: IntakeBatch;
    }
  | {
      op: "accepted";
      item_id: string;
      connection_id: string;
      literature_id: string;
      disposition: NonNullable<CaptureResult["disposition"]>;
      replay: boolean;
      file: ImportFileStatus | null;
      now: string;
    }
  | {
      op: "result";
      item_id: string;
      connection_id: string;
      result: Omit<CaptureResult, "file">;
    };
function fail(code: string): never {
  throw Object.assign(new Error("Intake page storage rejected"), { code });
}
export function readCapture(db: DatabaseSync, r: CaptureRead): StoredCapture {
  const row = db
    .prepare(
      "SELECT p.*,i.literature_id,i.disposition,i.created_at FROM intake_page_requests p JOIN intake_items i USING(item_id) WHERE p.item_id=? AND p.connection_id=?",
    )
    .get(r.item_id, r.connection_id);
  if (!row) fail("intake-item-missing");
  const file = db
    .prepare("SELECT file_id FROM import_files WHERE item_id=?")
    .get(r.item_id);
  return {
    item_id: String(row.item_id),
    connection_id: String(row.connection_id),
    request_sha256: String(row.request_sha256),
    batch_id: String(row.batch_id),
    literature_id:
      row.literature_id === null ? null : String(row.literature_id),
    disposition: row.disposition as StoredCapture["disposition"],
    created_at: String(row.created_at),
    result:
      row.result_json === null ? null : JSON.parse(String(row.result_json)),
    file: file
      ? (readImportStorage(db, {
          op: "file",
          batch_id: String(row.batch_id),
          file_id: String(file.file_id),
        }) as ImportFileStatus)
      : null,
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
          "SELECT request_sha256 FROM intake_page_requests WHERE connection_id=? AND request_id=?",
        )
        .get(r.connection_id, r.request_id);
      if (old && old.request_sha256 !== r.request_sha256)
        fail("intake-request-conflict");
      if (!old) {
        let opened = db
          .prepare(
            "SELECT batch_id FROM intake_open_batches WHERE opener=? AND day=?",
          )
          .get(`device:${r.connection_id}`, r.day);
        if (!opened) {
          const source = {
            system: "web-page",
            library_id: "",
            identity: "adhoc" as const,
            name: "网页收藏",
          };
          insertImportBatch(
            db,
            {
              op: "create",
              batch: r.batch,
              library_key: createHash("sha256")
                .update(r.batch.batch_id)
                .digest("hex"),
              source,
              format: "web-page",
              scope: "single-page capture",
              file_name: null,
              import_user_tags: false,
              identity_scope: `adhoc:${r.batch.batch_id}`,
            },
            intake.writeIntakeBatch,
          );
          db.prepare("INSERT INTO intake_open_batches VALUES(?,?,?)").run(
            `device:${r.connection_id}`,
            r.day,
            r.batch.batch_id,
          );
          opened = { batch_id: r.batch.batch_id };
        }
        const batchId = String(opened.batch_id);
        if (
          db
            .prepare("SELECT state FROM intake_batches WHERE batch_id=?")
            .get(batchId)?.state !== "running"
        )
          fail("intake-batch-state");
        db.prepare(
          "INSERT INTO intake_items(item_id,batch_id,origin,external_id,title,file_name,created_at) VALUES(?,?,'page',?,?,?,?)",
        ).run(r.item_id, batchId, r.item_id, r.title, r.file_name, r.now);
        db.prepare(
          "INSERT INTO intake_page_requests(connection_id,request_id,request_sha256,item_id,batch_id) VALUES(?,?,?,?,?)",
        ).run(
          r.connection_id,
          r.request_id,
          r.request_sha256,
          r.item_id,
          batchId,
        );
        db.prepare(
          "UPDATE import_sessions SET record_count=record_count+1,updated_at=? WHERE batch_id=?",
        ).run(r.now, batchId);
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
          "UPDATE intake_items SET literature_id=?,disposition=? WHERE item_id=?",
        ).run(r.literature_id, disposition, r.item_id);
        const position = Number(
          db
            .prepare(
              "SELECT coalesce(max(record_index),-1)+1 n FROM import_record_results WHERE batch_id=? AND sequence=0",
            )
            .get(old.batch_id)!.n,
        );
        const meta = db
          .prepare(
            "SELECT meta_literature_id FROM literatures WHERE literature_id=?",
          )
          .get(r.literature_id)!.meta_literature_id;
        db.prepare(
          "INSERT INTO import_record_results(batch_id,sequence,record_index,item_id,external_id,disposition,literature_id,meta_literature_id,reason) VALUES(?,0,?,?,?,?,?,?,NULL)",
        ).run(
          old.batch_id,
          position,
          r.item_id,
          r.item_id,
          disposition,
          r.literature_id,
          meta!,
        );
        if (r.file) insertImportFiles(db, old.batch_id, r.item_id, [r.file]);
        intake.recordIntakeMember(db, {
          batch_id: parseIntakeBatchId(old.batch_id),
          literature_id: r.literature_id,
          disposition: r.disposition,
        });
        db.prepare(
          "UPDATE import_sessions SET updated_at=? WHERE batch_id=?",
        ).run(r.now, old.batch_id);
      } else if (r.op === "result") {
        db.prepare(
          "UPDATE intake_page_requests SET result_json=coalesce(result_json,?) WHERE item_id=? AND connection_id=?",
        ).run(JSON.stringify(r.result), r.item_id, r.connection_id);
      }
    }
    const value = readCapture(db, r);
    db.exec("COMMIT");
    return value;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
