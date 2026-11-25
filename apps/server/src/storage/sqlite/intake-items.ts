import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
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
  IMPORT_LIMITS,
  EMPTY_METADATA,
  INTAKE_CLUES_UNREAD_REASONS,
  emptyIntakeCluesUnread,
  type IntakeCluesUnread,
  type IntakeCluesUnreadReason,
  parseLiteratureId,
  parseLiteratureMetadata,
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
  readonly retained_item_id?: string;
  /** Intent checkpoint before a late decision publishes identity; used only with an observation replay. */
  readonly creates_on_resolution?: boolean;
  /** A `lookup` line; `record` then holds only the given identifier or title. */
  readonly lookup?: IntakeLookupWork;
}
export interface IntakeLookupWork {
  readonly line: number;
  readonly text: string;
  readonly kind: import("@sciretriever/contracts").IntakeLookupKind | null;
  readonly reason:
    | "lookup-unsupported-url"
    | "lookup-too-short"
    | "lookup-too-long"
    | "duplicate-line"
    | null;
}
export interface StoredIntakeItem extends IntakeBatchItem {
  readonly batch_id: string;
  readonly candidate_transfer_id: string | null;
  readonly literature_id: string | null;
  readonly work: IntakeItemWork | null;
  readonly retain_until?: string | null;
}
export type IntakeItemRead =
  | { kind: "duplicate-candidates" }
  | { kind: "pending-resolution-files"; batch_id: string; now: string }
  | { kind: "resolution-file"; batch_id: string; file_id: string; now: string }
  | { kind: "batch-candidates"; batch_id: string; item_id?: string }
  | { kind: "all"; batch_id: string }
  | { kind: "one"; batch_id: string; item_id: string }
  | { kind: "hash"; sha256: string }
  | { kind: "needs"; literature_id: string }
  | { kind: "clues-unread"; batch_id: string }
  | { kind: "needs-pdf-literatures"; limit: number }
  | { kind: "recognition-state"; literature_id: string }
  | { kind: "raw-owners"; asset_id: string }
  | { kind: "source-url"; file_id: string };
export type IntakeItemWrite =
  | { kind: "restore"; literature_id: string }
  | {
      kind: "stage-data";
      batch_id: string;
      items: readonly StoredIntakeItem[];
      now: string;
    }
  | {
      /** Before confirmation: a changed or removed `lookup` line drops its work. */
      kind: "lookup-stage";
      batch_id: string;
      sequences: readonly number[];
      items: readonly StoredIntakeItem[];
      now: string;
    }
  | {
      kind: "duplicates";
      batch_id: string;
      item_id: string;
      candidates: IntakeBatchItem["possible_duplicates"];
      work?: IntakeItemWork;
      now: string;
    }
  | {
      kind: "duplicate-decision";
      batch_id: string;
      item_id: string;
      decision: Extract<IntakeDecision, { kind: "new" | "merge" }>;
      actor: string;
      now: string;
    }
  | { kind: "expire-decisions"; now: string }
  | { kind: "discard-settled-work"; batch_id: string; now: string }
  | {
      kind: "resolution-intent";
      batch_id: string;
      item_id: string;
      creates: boolean;
      now: string;
    }
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
      ((row.origin !== "data" && work && !work.reason) ||
      (work?.lookup && !work.lookup.reason)
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
    retain_until: row.retain_until === null ? null : String(row.retain_until),
  };
}
/** What a later file recognition needs to know about one literature. */
export interface RecognitionState {
  readonly needs_metadata: boolean;
  readonly trashed: boolean;
  readonly withdrawn: boolean;
  /** The name the PDF arrived with, when an intake recorded one. */
  readonly file_name: string | null;
}
// Stored clue reads from before `unread` keep their older `reason`; the same
// mapping as cluesUnreadReason() in literature/file-clues.ts.
const CLUES_UNREAD_SQL = `coalesce(json_extract(recognition_json,'$.clues.unread'),CASE WHEN json_extract(recognition_json,'$.clues.status')='image-only' THEN 'image-only' WHEN json_extract(recognition_json,'$.clues.reason')='clues-timeout' THEN 'reader-timeout' WHEN json_extract(recognition_json,'$.clues.reason')='encrypted-pdf' THEN 'encrypted-pdf' WHEN json_extract(recognition_json,'$.clues.reason') IN ('pdf-invalid','non-pdf-file') THEN 'invalid-pdf' ELSE 'reader-failed' END)`;
const LIVE_LITERATURE_SQL = (column: string) =>
  `NOT EXISTS(SELECT 1 FROM intake_withdrawn_objects w WHERE w.object_kind='literature' AND w.object_id=${column}) AND NOT EXISTS(SELECT 1 FROM library_trash t WHERE t.literature_id=${column})`;
export function readIntakeItem(db: DatabaseSync, r: IntakeItemRead): unknown {
  if (r.kind === "clues-unread") {
    const counts = emptyIntakeCluesUnread() as {
      total: number;
      by_reason: Record<IntakeCluesUnreadReason, number>;
    };
    for (const row of db
      .prepare(
        `SELECT ${CLUES_UNREAD_SQL} AS reason,count(*) AS n FROM intake_items WHERE batch_id=? AND json_type(recognition_json,'$.clues')='object' AND json_extract(recognition_json,'$.clues.status')<>'read' GROUP BY 1`,
      )
      .all(r.batch_id)) {
      const reason = (
        INTAKE_CLUES_UNREAD_REASONS as readonly string[]
      ).includes(String(row.reason))
        ? (String(row.reason) as IntakeCluesUnreadReason)
        : "reader-failed";
      counts.by_reason[reason] += Number(row.n);
      counts.total += Number(row.n);
    }
    return counts satisfies IntakeCluesUnread;
  }
  if (r.kind === "needs-pdf-literatures")
    return db
      .prepare(
        `SELECT n.literature_id FROM literature_needs_metadata n WHERE EXISTS(SELECT 1 FROM literature_assets a WHERE a.literature_id=n.literature_id AND a.role='primary-pdf') AND ${LIVE_LITERATURE_SQL("n.literature_id")} ORDER BY n.literature_id LIMIT ?`,
      )
      .all(r.limit)
      .map((row) => String(row.literature_id));
  if (r.kind === "recognition-state") {
    const row = db
      .prepare(
        "SELECT EXISTS(SELECT 1 FROM literature_needs_metadata n WHERE n.literature_id=l.literature_id) AS needs,EXISTS(SELECT 1 FROM library_trash t WHERE t.literature_id=l.literature_id) AS trashed,EXISTS(SELECT 1 FROM intake_withdrawn_objects w WHERE w.object_kind='literature' AND w.object_id=l.literature_id) AS withdrawn,coalesce((SELECT i.file_name FROM intake_items i WHERE i.literature_id=l.literature_id AND i.file_name IS NOT NULL ORDER BY i.created_at DESC,i.item_id LIMIT 1),(SELECT f.file_name FROM import_files f WHERE f.literature_id=l.literature_id ORDER BY f.file_id LIMIT 1)) AS file_name FROM literatures l WHERE l.literature_id=?",
      )
      .get(r.literature_id);
    return row
      ? ({
          needs_metadata: !!row.needs,
          trashed: !!row.trashed,
          withdrawn: !!row.withdrawn,
          file_name: row.file_name === null ? null : String(row.file_name),
        } satisfies RecognitionState)
      : null;
  }
  if (r.kind === "pending-resolution-files")
    return db
      .prepare(
        "SELECT DISTINCT i.item_id FROM intake_items i JOIN import_files f USING(item_id) WHERE i.batch_id=? AND f.status='pending' AND i.retain_until>? AND json_extract(i.decision_json,'$.kind') IN ('new','merge') AND json_array_length(i.possible_duplicates_json)>0",
      )
      .all(r.batch_id, r.now)
      .map((row) => String(row.item_id));
  if (r.kind === "resolution-file")
    return (
      db
        .prepare(
          "SELECT i.item_id FROM intake_items i JOIN import_files f USING(item_id) JOIN intake_batches b ON b.batch_id=i.batch_id WHERE i.batch_id=? AND f.file_id=? AND b.state='finished' AND i.retain_until>? AND json_array_length(i.possible_duplicates_json)>0 AND json_extract(i.decision_json,'$.kind') IN ('new','merge') AND i.disposition IN ('created','matched','enriched','restored') AND i.literature_id=f.literature_id",
        )
        .get(r.batch_id, r.file_id, r.now)?.item_id ?? null
    );
  if (r.kind === "duplicate-candidates")
    return db
      .prepare(
        "SELECT m.literature_id,m.title,m.publication_year,m.publication_form,(SELECT json_group_array(json_object('kind',kind,'display_name',display_name,'given_name',given_name,'family_name',family_name,'orcid',orcid,'affiliations',json('[]'))) FROM (SELECT literature_id,ordinal,kind,display_name,given_name,family_name,orcid FROM literature_metadata_authors a WHERE a.literature_id=m.literature_id ORDER BY ordinal)) AS authors_json FROM literature_metadata m WHERE m.title IS NOT NULL AND NOT EXISTS(SELECT 1 FROM intake_withdrawn_objects w WHERE w.object_kind='literature' AND w.object_id=m.literature_id) AND NOT EXISTS(SELECT 1 FROM library_trash t WHERE t.literature_id=m.literature_id) ORDER BY m.literature_id",
      )
      .all()
      .map((row) => {
        const metadata = parseLiteratureMetadata({
          ...EMPTY_METADATA,
          title: row.title,
          authors: JSON.parse(String(row.authors_json)),
          publication_year: row.publication_year,
          publication_form: row.publication_form,
        });
        return {
          literature_id: parseLiteratureId(row.literature_id),
          title: metadata.title,
          authors: metadata.authors,
          publication_year: metadata.publication_year,
          publication_form: metadata.publication_form,
        };
      });
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
          "SELECT l.literature_id,a.asset_id,a.role,l.meta_literature_id,(SELECT count(DISTINCT owners.literature_id)>1 FROM literature_assets owners WHERE owners.asset_id=a.asset_id) AS ambiguous,(EXISTS(SELECT 1 FROM intake_withdrawn_objects w WHERE w.object_kind='literature' AND w.object_id=l.literature_id) OR EXISTS(SELECT 1 FROM library_trash t WHERE t.literature_id=l.literature_id)) AS withdrawn FROM literature_assets a JOIN assets s USING(asset_id) JOIN literatures l USING(literature_id) WHERE s.sha256=? ORDER BY (a.role='primary-pdf') DESC,l.literature_id LIMIT 1",
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
      .prepare(
        "SELECT item_id,batch_id,origin,sequence,record_index,external_id,title,file_name,candidate_transfer_id,recognition_json,possible_duplicates_json,unpaired,needs_decision,decision_json,decided_by,decided_at,disposition,literature_id,retain_until,created_at FROM intake_items WHERE batch_id=? AND item_id=?",
      )
      .get(r.batch_id, r.item_id);
    if (!row) fail("intake-item-missing");
    return stored(row);
  }
  return db
    .prepare(
      "SELECT item_id,batch_id,origin,sequence,record_index,external_id,title,file_name,candidate_transfer_id,recognition_json,possible_duplicates_json,unpaired,needs_decision,decision_json,decided_by,decided_at,disposition,literature_id,retain_until,created_at FROM intake_items WHERE batch_id=? ORDER BY created_at,item_id",
    )
    .all(r.batch_id)
    .map(stored);
}
export function writeIntakeItem(db: DatabaseSync, r: IntakeItemWrite): unknown {
  if (r.kind === "resolution-intent") {
    const changed = db
      .prepare(
        "UPDATE intake_items SET recognition_json=json_set(recognition_json,'$.creates_on_resolution',json(?)) WHERE batch_id=? AND item_id=? AND disposition='pending-decision' AND retain_until>? AND json_type(recognition_json,'$.creates_on_resolution') IS NULL AND json_extract(decision_json,'$.kind') IN ('new','merge') AND EXISTS(SELECT 1 FROM intake_batches b WHERE b.batch_id=intake_items.batch_id AND b.state='finished')",
      )
      .run(JSON.stringify(r.creates), r.batch_id, r.item_id, r.now);
    if (!changed.changes) fail("intake-batch-state");
    return true;
  }
  if (r.kind === "discard-settled-work") {
    const state = db
      .prepare("SELECT state FROM intake_batches WHERE batch_id=?")
      .get(r.batch_id)?.state;
    if (!["finished", "cancelled", "withdrawn"].includes(String(state)))
      fail("intake-batch-state");
    db.prepare(
      "UPDATE intake_items SET recognition_json=NULL WHERE batch_id=? AND origin='data' AND (?<>'finished' OR ((disposition IS NULL OR disposition<>'pending-decision') AND (retain_until IS NULL OR retain_until<=? OR NOT EXISTS(SELECT 1 FROM import_files f WHERE f.item_id=intake_items.item_id AND f.status='pending'))))",
    ).run(r.batch_id, String(state), r.now);
    return true;
  }
  if (r.kind === "expire-decisions") {
    const rows = db
      .prepare(
        "SELECT i.item_id,i.batch_id FROM intake_items i JOIN intake_batches b USING(batch_id) WHERE b.state='finished' AND i.disposition='pending-decision' AND i.retain_until<=? AND i.recognition_json IS NOT NULL",
      )
      .all(r.now);
    for (const item of rows) {
      const work = db
        .prepare(
          "SELECT json_extract(recognition_json,'$.retained_item_id') AS paired FROM intake_items WHERE item_id=?",
        )
        .get(item.item_id!)!;
      if (work.paired)
        db.prepare(
          "UPDATE intake_items SET recognition_json=CASE WHEN candidate_transfer_id IS NULL THEN NULL ELSE json_object('retiring_transfer_id',candidate_transfer_id) END,candidate_transfer_id=NULL WHERE item_id=? AND batch_id=?",
        ).run(work.paired, item.batch_id!);
      db.prepare(
        "UPDATE intake_items SET recognition_json=CASE WHEN candidate_transfer_id IS NULL THEN NULL ELSE json_object('retiring_transfer_id',candidate_transfer_id) END,candidate_transfer_id=NULL,needs_decision=0 WHERE item_id=?",
      ).run(item.item_id!);
      db.prepare(
        "UPDATE import_record_results SET reason='decision-expired' WHERE item_id=? AND disposition='pending-decision'",
      ).run(item.item_id!);
    }
    return rows.map((row) => String(row.batch_id));
  }
  if (r.kind === "stage-data") {
    const state = db
      .prepare("SELECT state FROM intake_batches WHERE batch_id=?")
      .get(r.batch_id)?.state;
    if (
      !["collecting", "awaiting-confirmation", "running"].includes(
        String(state),
      )
    )
      fail("intake-batch-state");
    const put = db.prepare(
      "INSERT INTO intake_items(item_id,batch_id,origin,sequence,record_index,external_id,title,recognition_json,created_at) VALUES(?,?,'data',?,?,?,?,?,?) ON CONFLICT(item_id) DO NOTHING",
    );
    for (const item of r.items)
      put.run(
        item.item_id,
        r.batch_id,
        item.sequence,
        item.record_index,
        item.external_id,
        item.title,
        JSON.stringify(item.work),
        r.now,
      );
    return true;
  }
  if (r.kind === "lookup-stage") {
    const state = db
      .prepare("SELECT state FROM intake_batches WHERE batch_id=?")
      .get(r.batch_id)?.state;
    // Confirmed batches keep their staged lines and recognition results.
    if (!["collecting", "awaiting-confirmation"].includes(String(state)))
      return false;
    const wanted = new Map(r.items.map((i) => [i.item_id, i]));
    const line = (work: IntakeItemWork | null | undefined) =>
      JSON.stringify(
        work?.lookup
          ? [work.lookup.line, work.lookup.text, work.lookup.reason]
          : null,
      );
    for (const row of db
      .prepare(
        `SELECT item_id,sequence,recognition_json FROM intake_items WHERE batch_id=? AND origin='data' AND sequence IN (SELECT value FROM json_each(?))`,
      )
      .all(r.batch_id, JSON.stringify(r.sequences))) {
      const next = wanted.get(String(row.item_id));
      const old =
        row.recognition_json === null
          ? null
          : (JSON.parse(String(row.recognition_json)) as IntakeItemWork);
      if (!next || line(old) !== line(next.work))
        db.prepare("DELETE FROM intake_items WHERE item_id=?").run(
          row.item_id!,
        );
    }
    const put = db.prepare(
      "INSERT INTO intake_items(item_id,batch_id,origin,sequence,record_index,external_id,title,recognition_json,created_at) VALUES(?,?,'data',?,?,?,?,?,?) ON CONFLICT(item_id) DO NOTHING",
    );
    for (const item of r.items)
      put.run(
        item.item_id,
        r.batch_id,
        item.sequence,
        item.record_index,
        item.external_id,
        item.title,
        JSON.stringify(item.work),
        r.now,
      );
    return true;
  }
  if (r.kind === "duplicates" || r.kind === "duplicate-decision") {
    const state = db
      .prepare("SELECT state FROM intake_batches WHERE batch_id=?")
      .get(r.batch_id)?.state;
    const old = readIntakeItem(db, {
      kind: "one",
      batch_id: r.batch_id,
      item_id: r.item_id,
    }) as StoredIntakeItem;
    if (r.kind === "duplicates") {
      if (
        !["collecting", "awaiting-confirmation", "running"].includes(
          String(state),
        ) ||
        old.disposition !== null
      )
        fail("intake-batch-state");
      const choice = old.decision;
      const decided =
        choice?.kind === "new" ||
        (choice?.kind === "merge" &&
          r.candidates.some((c) => c.literature_id === choice.literature_id));
      db.prepare(
        "UPDATE intake_items SET possible_duplicates_json=?,needs_decision=?,recognition_json=? WHERE item_id=?",
      ).run(
        JSON.stringify(r.candidates),
        Number(r.candidates.length > 0 && !decided),
        JSON.stringify(r.work ?? old.work),
        r.item_id,
      );
    } else {
      const pending =
        state === "finished" &&
        old.disposition === "pending-decision" &&
        old.retain_until !== null &&
        old.retain_until !== undefined &&
        old.retain_until > r.now &&
        !!old.work?.record;
      if (
        !pending &&
        (!["collecting", "awaiting-confirmation"].includes(String(state)) ||
          old.disposition !== null)
      )
        fail("intake-batch-state");
      const choice = r.decision;
      if (
        !old.possible_duplicates.length ||
        (choice.kind === "merge" &&
          !old.possible_duplicates.some(
            (c) => c.literature_id === choice.literature_id,
          ))
      )
        fail("intake-decision-invalid");
      // A failed checkpoint may follow an already committed identity. Its
      // decision is pinned; retry the same decision without rewriting its audit.
      if (pending && old.work?.creates_on_resolution !== undefined) {
        if (JSON.stringify(old.decision) !== JSON.stringify(choice))
          fail("intake-decision-invalid");
        return old;
      }
      db.prepare(
        "UPDATE intake_items SET decision_json=?,decided_by=?,decided_at=?,needs_decision=0 WHERE item_id=?",
      ).run(JSON.stringify(r.decision), r.actor, r.now, r.item_id);
    }
    return readIntakeItem(db, {
      kind: "one",
      batch_id: r.batch_id,
      item_id: r.item_id,
    });
  }
  if (r.kind === "restore")
    return restoreWithdrawnLiterature(db, r.literature_id);
  if (r.kind === "needs") {
    if (r.needed)
      db.prepare(
        "INSERT INTO literature_needs_metadata(literature_id,set_at,batch_id) VALUES(?,?,?) ON CONFLICT DO NOTHING",
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
      "UPDATE intake_items SET recognition_json=nullif(json_remove(recognition_json,'$.retiring_transfer_id'),'{}') WHERE batch_id=? AND item_id=?",
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
