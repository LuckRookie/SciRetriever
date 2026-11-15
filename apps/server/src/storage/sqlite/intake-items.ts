import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  IMPORT_LIMITS,
  type IntakeBatchItem,
  type IntakeDecision,
  type ImportRecord,
  type ImportFile,
  type IntakeExcluded,
  type Identifier,
} from "@sciretriever/contracts";
import type { FileClues } from "../../literature/file-clues.js";
import type { RecognitionResult } from "../../literature/intake-recognition.js";

export interface IntakeItemWork {
  readonly relative_path: string | null;
  readonly paired_to: string | null;
  readonly clues: FileClues | null;
  readonly result: RecognitionResult | null;
  readonly reason: string | null;
  readonly source_url: string | null;
  readonly included?: boolean;
  readonly declared_file?: ImportFile;
  readonly excluded?: readonly IntakeExcluded[];
  readonly url_identifiers?: readonly Identifier[];
  readonly retiring_transfer_id?: string;
  readonly page?: import("@sciretriever/contracts").WebPageData;
  readonly folder_ids?: readonly string[];
  readonly record?: ImportRecord;
}
export interface StoredIntakeItem extends IntakeBatchItem {
  readonly batch_id: string;
  readonly candidate_transfer_id: string | null;
  readonly literature_id: string | null;
  readonly work: IntakeItemWork | null;
}
export type IntakeItemRead =
  | { kind: "batch-candidates"; batch_id: string; item_id?: string }
  | { kind: "all"; batch_id: string }
  | { kind: "one"; batch_id: string; item_id: string }
  | { kind: "hash"; sha256: string }
  | { kind: "needs"; literature_id: string }
  | { kind: "raw-owners"; asset_id: string }
  | { kind: "source-url"; file_id: string };
export type IntakeItemWrite =
  | { kind: "restore"; literature_id: string }
  | { kind: "put"; item: StoredIntakeItem; now: string }
  | {
      kind: "update";
      batch_id: string;
      item_id: string;
      work?: IntakeItemWork;
      unpaired?: boolean;
      needs_decision?: boolean;
      decision?: IntakeDecision;
      actor?: string;
      now: string;
    }
  | { kind: "detach"; batch_id: string; item_id: string }
  | { kind: "retired"; batch_id: string; item_id: string }
  | {
      kind: "attach";
      batch_id: string;
      item_id: string;
      transfer_id: string | null;
      work: IntakeItemWork;
    }
  | {
      kind: "needs";
      literature_id: string;
      needed: boolean;
      batch_id: string | null;
      now: string;
    }
  | { kind: "source-url"; file_id: string; url: string | null };
function fail(code: string): never {
  throw Object.assign(new Error("Intake item rejected"), { code });
}
function stored(row: Record<string, SQLOutputValue>): StoredIntakeItem {
  const work: IntakeItemWork | null =
    row.recognition_json === null
      ? null
      : JSON.parse(String(row.recognition_json));
  return {
    item_id: String(row.item_id),
    batch_id: String(row.batch_id),
    origin: row.origin as StoredIntakeItem["origin"],
    sequence: row.sequence === null ? null : Number(row.sequence),
    record_index: row.record_index === null ? null : Number(row.record_index),
    external_id: row.external_id === null ? null : String(row.external_id),
    title: row.title === null ? null : String(row.title),
    file_name: row.file_name === null ? null : String(row.file_name),
    candidate_transfer_id:
      row.candidate_transfer_id === null
        ? null
        : String(row.candidate_transfer_id),
    recognition:
      work?.result?.recognition ??
      (work && !work.reason
        ? { state: "pending", step: null, literature_id: null, candidates: [] }
        : null),
    possible_duplicates: JSON.parse(String(row.possible_duplicates_json)),
    unpaired: row.unpaired === 1,
    needs_decision: row.needs_decision === 1,
    decision:
      row.decision_json === null ? null : JSON.parse(String(row.decision_json)),
    disposition: row.disposition as StoredIntakeItem["disposition"],
    literature_id:
      row.literature_id === null ? null : String(row.literature_id),
    decided_by: row.decided_by === null ? null : String(row.decided_by),
    decided_at: row.decided_at === null ? null : String(row.decided_at),
    work,
  };
}
export function readIntakeItem(db: DatabaseSync, r: IntakeItemRead): unknown {
  if (r.kind === "batch-candidates")
    return db
      .prepare(
        "SELECT record_json FROM execution_candidates c WHERE transfer_id LIKE 'intake-%' AND json_extract(record_json,'$.source_name')='import' AND json_extract(record_json,'$.capture.session_id')=? AND (? IS NULL OR json_extract(record_json,'$.capture.article_id')=?) AND NOT EXISTS(SELECT 1 FROM execution_receipts p WHERE p.transfer_id=c.transfer_id)",
      )
      .all(r.batch_id, r.item_id ?? null, r.item_id ?? null)
      .map((row) => JSON.parse(String(row.record_json)));
  if (r.kind === "raw-owners")
    return db
      .prepare(
        "SELECT n.literature_id FROM literature_needs_metadata n JOIN literature_assets a USING(literature_id) WHERE a.asset_id=? AND a.role='primary-pdf' ORDER BY n.literature_id",
      )
      .all(r.asset_id)
      .map((row) => String(row.literature_id));
  if (r.kind === "hash")
    return (
      db
        .prepare(
          "SELECT l.literature_id,a.asset_id,a.role,l.meta_literature_id,(SELECT count(DISTINCT owners.literature_id)>1 FROM literature_assets owners WHERE owners.asset_id=a.asset_id) AS ambiguous,EXISTS(SELECT 1 FROM intake_withdrawn_objects w WHERE w.object_kind='literature' AND w.object_id=l.literature_id) AS withdrawn FROM literature_assets a JOIN assets s USING(asset_id) JOIN literatures l USING(literature_id) WHERE s.sha256=? ORDER BY (a.role='primary-pdf') DESC,l.literature_id LIMIT 1",
        )
        .get(r.sha256) ?? null
    );
  if (r.kind === "needs")
    return !!db
      .prepare("SELECT 1 FROM literature_needs_metadata WHERE literature_id=?")
      .get(r.literature_id);
  if (r.kind === "source-url")
    return (
      db
        .prepare("SELECT source_url FROM import_files WHERE file_id=?")
        .get(r.file_id)?.source_url ?? null
    );
  if (r.kind === "one") {
    const row = db
      .prepare("SELECT * FROM intake_items WHERE batch_id=? AND item_id=?")
      .get(r.batch_id, r.item_id);
    if (!row) fail("intake-item-missing");
    return stored(row);
  }
  return db
    .prepare(
      "SELECT * FROM intake_items WHERE batch_id=? ORDER BY created_at,item_id",
    )
    .all(r.batch_id)
    .map(stored);
}
export function writeIntakeItem(db: DatabaseSync, r: IntakeItemWrite): unknown {
  if (r.kind === "restore") {
    const lit = r.literature_id;
    db.prepare(
      "DELETE FROM intake_withdrawn_objects WHERE (object_kind='literature' AND object_id=?) OR (object_kind='literature-asset' AND object_id IN (SELECT literature_asset_id FROM literature_assets WHERE literature_id=?)) OR (object_kind='folder-member' AND json_extract(object_id,'$[1]')=?) OR (object_kind='mark' AND object_id IN (SELECT mark_id FROM reading_marks WHERE literature_id=?)) OR (object_kind='folder' AND object_id IN (WITH RECURSIVE parents(id) AS (SELECT folder_id FROM folder_members WHERE literature_id=? UNION SELECT f.parent_id FROM folders f JOIN parents p ON f.folder_id=p.id WHERE f.parent_id IS NOT NULL) SELECT id FROM parents))",
    ).run(lit, lit, lit, lit, lit);
    return true;
  }
  if (r.kind === "needs") {
    if (r.needed)
      db.prepare(
        "INSERT INTO literature_needs_metadata VALUES(?,?,?) ON CONFLICT DO NOTHING",
      ).run(r.literature_id, r.now, r.batch_id);
    else
      db.prepare(
        "DELETE FROM literature_needs_metadata WHERE literature_id=?",
      ).run(r.literature_id);
    return true;
  }
  if (r.kind === "source-url") {
    db.prepare("UPDATE import_files SET source_url=? WHERE file_id=?").run(
      r.url,
      r.file_id,
    );
    return true;
  }
  if (r.kind === "detach") {
    db.prepare(
      "UPDATE intake_items SET recognition_json=json_set(coalesce(recognition_json,'{}'),'$.retiring_transfer_id',coalesce(candidate_transfer_id,json_extract(recognition_json,'$.retiring_transfer_id'))),candidate_transfer_id=NULL WHERE batch_id=? AND item_id=?",
    ).run(r.batch_id, r.item_id);
    return true;
  }
  if (r.kind === "retired") {
    db.prepare(
      "UPDATE intake_items SET recognition_json=json_remove(recognition_json,'$.retiring_transfer_id') WHERE batch_id=? AND item_id=?",
    ).run(r.batch_id, r.item_id);
    return true;
  }
  if (r.kind === "attach") {
    const state = db
      .prepare("SELECT state FROM intake_batches WHERE batch_id=?")
      .get(r.batch_id)?.state;
    if (state !== "running") fail("intake-batch-state");
    db.prepare(
      "UPDATE intake_items SET candidate_transfer_id=?,recognition_json=? WHERE batch_id=? AND item_id=? AND origin='page' AND disposition IS NULL",
    ).run(r.transfer_id, JSON.stringify(r.work), r.batch_id, r.item_id);
    return readIntakeItem(db, {
      kind: "one",
      batch_id: r.batch_id,
      item_id: r.item_id,
    });
  }
  const id = r.kind === "put" ? r.item.batch_id : r.batch_id;
  const state = db
    .prepare("SELECT state FROM intake_batches WHERE batch_id=?")
    .get(id)?.state;
  if (
    !["collecting", "awaiting-confirmation", "running"].includes(String(state))
  )
    fail("intake-batch-state");
  if (r.kind === "put") {
    if (!["collecting", "awaiting-confirmation"].includes(String(state)))
      fail("intake-batch-state");
    const s = r.item;
    const count = Number(
      db
        .prepare("SELECT record_count FROM import_sessions WHERE batch_id=?")
        .get(id)?.record_count ?? 0,
    );
    if (count >= IMPORT_LIMITS.records) fail("intake-batch-limit");
    db.prepare(
      "INSERT INTO intake_items(item_id,batch_id,origin,external_id,title,file_name,candidate_transfer_id,recognition_json,unpaired,needs_decision,disposition,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      s.item_id,
      id,
      s.origin,
      s.external_id,
      s.title,
      s.file_name,
      s.candidate_transfer_id,
      JSON.stringify(s.work),
      Number(s.unpaired),
      Number(s.needs_decision),
      s.disposition,
      r.now,
    );
    db.prepare(
      "UPDATE intake_batches SET state='awaiting-confirmation' WHERE batch_id=?",
    ).run(id);
  } else {
    const old = readIntakeItem(db, {
      kind: "one",
      batch_id: id,
      item_id: r.item_id,
    }) as StoredIntakeItem;
    const work = r.work ?? old.work;
    db.prepare(
      "UPDATE intake_items SET recognition_json=?,title=?,unpaired=?,needs_decision=?,decision_json=?,decided_by=?,decided_at=? WHERE batch_id=? AND item_id=?",
    ).run(
      JSON.stringify(work),
      work?.result?.metadata.title ?? old.title,
      Number(r.unpaired ?? old.unpaired),
      Number(r.needs_decision ?? old.needs_decision),
      r.decision
        ? JSON.stringify(r.decision)
        : old.decision
          ? JSON.stringify(old.decision)
          : null,
      r.actor ?? old.decided_by,
      r.decision ? r.now : old.decided_at,
      id,
      r.item_id,
    );
  }
  db.prepare(
    "UPDATE import_sessions SET record_count=(SELECT coalesce(sum(record_count),0) FROM import_parts WHERE batch_id=?)+(SELECT count(*) FROM intake_items WHERE batch_id=? AND origin='file' AND json_extract(recognition_json,'$.paired_to') IS NULL),updated_at=? WHERE batch_id=?",
  ).run(id, id, r.now, id);
  return r.kind === "put"
    ? readIntakeItem(db, { kind: "one", batch_id: id, item_id: r.item.item_id })
    : readIntakeItem(db, { kind: "one", batch_id: id, item_id: r.item_id });
}
