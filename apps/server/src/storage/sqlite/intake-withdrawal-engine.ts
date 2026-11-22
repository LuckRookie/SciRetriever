import type { DatabaseSync } from "node:sqlite";
import {
  parseIntakeWithdrawalPreview,
  parseIntakeWithdrawalReport,
  parseIntakeRestorePreview,
  type IntakeRestorePreview,
  type IntakeWithdrawalPreview,
  type IntakeWithdrawalCounts,
  type IntakeWithdrawalReason,
  type IntakeWithdrawalReport,
} from "@sciretriever/contracts";
const { readMetadataRow }: typeof import("./metadata-rows.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./metadata-rows.ts"
      : "./metadata-rows.js",
    import.meta.url,
  ).href
);
const { ftsIndexText }: typeof import("../../literature/unicode-casefold.js") =
  await import(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "../../literature/unicode-casefold.ts"
        : "../../literature/unicode-casefold.js",
      import.meta.url,
    ).href
  );
const { literatureWithdrawn }: typeof import("./intake-visibility.js") =
  await import(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./intake-visibility.ts"
        : "./intake-visibility.js",
      import.meta.url,
    ).href
  );
const {
  INSERT_LITERATURE_SEARCH_ROW,
  deleteLiteratureSearchRows,
  literatureSearchRowIds,
}: typeof import("./literature-search-rows.js") = await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./literature-search-rows.ts"
      : "./literature-search-rows.js",
    import.meta.url,
  ).href
);

type ObjectKind =
  | "literature"
  | "literature-asset"
  | "folder"
  | "folder-member"
  | "mark";
type ObjectRef = { kind: ObjectKind; id: string };
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function countObjects(objects: readonly ObjectRef[]): IntakeWithdrawalCounts {
  const count = (kind: ObjectKind) =>
    objects.filter((o) => o.kind === kind).length;
  return {
    literatures: count("literature"),
    file_relations: count("literature-asset"),
    folders: count("folder"),
    folder_members: count("folder-member"),
    marks: count("mark"),
  };
}
function getBatch(db: DatabaseSync, id: string) {
  const batch = db
    .prepare(
      "SELECT batch_id,kind,default_label,label,origin,created_at,finished_at,state,result,confirmation,confirmed_at,initiated_by,request_json,discovery_run_id,rejected,source_failures,owner_pid FROM intake_batches WHERE batch_id=?",
    )
    .get(id);
  if (!batch) fail("intake-batch-missing");
  return batch;
}
function requireBatch(db: DatabaseSync, id: string, restore = false) {
  const batch = getBatch(db, id);
  if (
    restore
      ? batch.state !== "withdrawn"
      : !["finished", "cancelled"].includes(String(batch.state))
  )
    fail("intake-batch-state");
  if (
    !restore &&
    db
      .prepare(
        "SELECT 1 FROM execution_targets t JOIN execution_jobs j USING(job_id) JOIN intake_batch_members m USING(literature_id) WHERE m.batch_id=? AND j.status IN ('queued','running') LIMIT 1",
      )
      .get(id)
  )
    fail("intake-batch-busy");
  return batch;
}
function plan(
  db: DatabaseSync,
  batchId: string,
): { preview: IntakeWithdrawalPreview; objects: ObjectRef[] } {
  requireBatch(db, batchId);
  const registered =
    !!db
      .prepare("SELECT 1 FROM intake_batch_objects WHERE batch_id=? LIMIT 1")
      .get(batchId) ||
    !db
      .prepare(
        "SELECT 1 FROM intake_batch_members WHERE batch_id=? AND disposition='created' LIMIT 1",
      )
      .get(batchId);
  const ownership = (kind: string, expression: string) =>
    registered
      ? `NOT EXISTS(SELECT 1 FROM owner o WHERE o.object_kind='${kind}' AND o.object_id=${expression})`
      : "1";
  // The original Meta ID may survive a merge. Also inspect subsequent explicit
  // cross-version links; a source's self-link on re-import is not a merge.
  const sql = `WITH batch AS (SELECT batch_id,kind,default_label,label,origin,created_at,finished_at,state,result,confirmation,confirmed_at,initiated_by,request_json,discovery_run_id,rejected,source_failures,owner_pid FROM intake_batches WHERE batch_id=?),
    members AS (SELECT m.batch_id,m.literature_id,m.disposition,l.meta_literature_id FROM intake_batch_members m
      JOIN literatures l USING(literature_id) JOIN batch b ON b.batch_id=m.batch_id),
    owner AS (SELECT o.object_kind,o.object_id,o.batch_id FROM intake_batch_objects o JOIN batch b USING(batch_id))
    SELECT literature_id,'pre-existing' reason FROM members WHERE disposition<>'created'
    UNION SELECT m.literature_id,'hit-by-later-batch' FROM members m
      JOIN intake_batch_members n USING(literature_id) JOIN intake_batches b ON b.batch_id=n.batch_id
      WHERE julianday(b.created_at)>(SELECT julianday(created_at) FROM batch)
    UNION SELECT m.literature_id,'folder-changed' FROM members m JOIN folder_members fm USING(literature_id)
      WHERE ${ownership("folder-member", "json_array(fm.folder_id,fm.literature_id)")}
    UNION SELECT m.literature_id,'annotated' FROM members m JOIN reading_marks r USING(literature_id)
      WHERE ${ownership("mark", "r.mark_id")}
    UNION SELECT m.literature_id,'opened' FROM members m JOIN reading_history h USING(literature_id)
    UNION SELECT m.literature_id,'processed' FROM members m WHERE
      EXISTS(SELECT 1 FROM literature_assets a JOIN raw_parses p ON p.source_asset_id=a.asset_id WHERE a.literature_id=m.literature_id)
      OR EXISTS(SELECT 1 FROM archive_runs a WHERE a.literature_id=m.literature_id)
      OR EXISTS(SELECT 1 FROM archive_steps a WHERE a.literature_id=m.literature_id)
      OR EXISTS(SELECT 1 FROM literature_assets a JOIN proofread_versions p ON p.part_asset_id=a.asset_id WHERE a.literature_id=m.literature_id)
      OR EXISTS(SELECT 1 FROM literature_tag_assignments a WHERE a.literature_id=m.literature_id)
      OR EXISTS(SELECT 1 FROM processor_result_literatures p WHERE p.literature_id=m.literature_id)
    UNION SELECT m.literature_id,'metadata-edited' FROM members m JOIN literature_metadata_field_states s USING(literature_id)
      WHERE s.locked=1 OR (s.source='manual' AND json_extract(s.evidence_json,'$.provenance.source_name')='manual-metadata')
    UNION SELECT m.literature_id,'identity-merged' FROM members m WHERE
      EXISTS(SELECT 1 FROM import_record_results r WHERE r.batch_id=(SELECT batch_id FROM batch)
        AND r.literature_id=m.literature_id AND r.meta_literature_id<>m.meta_literature_id)
      OR EXISTS(SELECT 1 FROM literature_metadata_observations ownership
        JOIN literatures linked ON linked.literature_id=ownership.literature_id
        JOIN metadata_observations o USING(observation_id) JOIN provenances p ON p.provenance_id=o.provenance_id
        JOIN metadata_observation_version_links v USING(observation_id)
        WHERE linked.meta_literature_id=m.meta_literature_id
          AND julianday(p.observed_at)>(SELECT julianday(finished_at) FROM batch)
          AND EXISTS(SELECT 1 FROM literatures peer WHERE peer.meta_literature_id=linked.meta_literature_id
            AND peer.literature_id<>linked.literature_id AND (
              EXISTS(SELECT 1 FROM metadata_observation_version_link_identifiers vi
                JOIN literature_metadata_identifiers pi USING(namespace,value)
                WHERE vi.observation_id=v.observation_id AND vi.link_ordinal=v.link_ordinal AND pi.literature_id=peer.literature_id)
              OR EXISTS(SELECT 1 FROM literature_metadata_observations po JOIN metadata_observations obs USING(observation_id)
                JOIN provenances pp ON pp.provenance_id=obs.provenance_id WHERE po.literature_id=peer.literature_id
                AND pp.source_name=p.source_name AND pp.source_record_id=v.record_id))))
      OR EXISTS(SELECT 1 FROM intake_items i WHERE json_extract(i.decision_json,'$.kind')='merge'
        AND json_extract(i.decision_json,'$.literature_id')=m.literature_id
        AND julianday(i.decided_at)>(SELECT julianday(finished_at) FROM batch))
    ORDER BY literature_id,reason`;
  const reasons = new Map<string, IntakeWithdrawalReason[]>();
  for (const row of db.prepare(sql).all(batchId)) {
    const id = String(row.literature_id);
    reasons.set(id, [
      ...(reasons.get(id) ?? []),
      String(row.reason) as IntakeWithdrawalReason,
    ]);
  }
  const removed = db
    .prepare(
      "SELECT literature_id FROM intake_batch_members WHERE batch_id=? AND disposition='created' ORDER BY literature_id",
    )
    .all(batchId)
    .map((r) => String(r.literature_id))
    .filter((id) => !reasons.has(id));
  const doomed = new Set(removed),
    objects: ObjectRef[] = removed
      .filter((id) => !literatureWithdrawn(db, id))
      .map((id) => ({ kind: "literature", id }));
  // Relationships of each withdrawn paper, including shared immutable assets.
  for (const row of db
    .prepare(
      "SELECT literature_asset_id FROM literature_assets WHERE literature_id IN (SELECT value FROM json_each(?)) ORDER BY literature_asset_id",
    )
    .all(JSON.stringify(removed)))
    objects.push({
      kind: "literature-asset",
      id: String(row.literature_asset_id),
    });
  if (registered) {
    const owned = db
      .prepare(
        "SELECT object_kind,object_id FROM intake_batch_objects WHERE batch_id=? ORDER BY object_kind,object_id",
      )
      .all(batchId);
    for (const row of owned) {
      const kind = String(row.object_kind),
        id = String(row.object_id);
      const literature =
        kind === "folder-member"
          ? (JSON.parse(id) as string[])[1]
          : kind === "mark"
            ? db
                .prepare(
                  "SELECT literature_id FROM reading_marks WHERE mark_id=?",
                )
                .get(id)?.literature_id
            : null;
      if (literature && doomed.has(String(literature)))
        objects.push({ kind: kind as ObjectKind, id });
    }
    for (const row of owned.filter((row) => row.object_kind === "folder")) {
      const folder = String(row.object_id);
      const descendants = db
        .prepare(
          "WITH RECURSIVE sub AS (SELECT folder_id,parent_id,name,position,created_at,updated_at FROM folders WHERE folder_id=? UNION ALL SELECT f.folder_id,f.parent_id,f.name,f.position,f.created_at,f.updated_at FROM folders f JOIN sub s ON f.parent_id=s.folder_id) SELECT * FROM sub",
        )
        .all(folder);
      if (
        descendants.length &&
        descendants.every(
          (f) =>
            f.created_at === f.updated_at &&
            owned.some(
              (o) => o.object_kind === "folder" && o.object_id === f.folder_id,
            ) &&
            db
              .prepare(
                "SELECT literature_id FROM folder_members WHERE folder_id=?",
              )
              .all(f.folder_id!)
              .every((m) => doomed.has(String(m.literature_id))),
        )
      )
        objects.push({ kind: "folder", id: folder });
    }
  }
  const unique = [
    ...new Map(objects.map((o) => [JSON.stringify(o), o])).values(),
  ].filter(
    (o) =>
      !db
        .prepare(
          "SELECT 1 FROM intake_withdrawn_objects WHERE object_kind=? AND object_id=?",
        )
        .get(o.kind, o.id),
  );
  const by_reason: Partial<Record<IntakeWithdrawalReason, number>> = {};
  for (const values of reasons.values())
    for (const reason of values)
      by_reason[reason] = (by_reason[reason] ?? 0) + 1;
  const kept_items = [...reasons]
    .slice(0, 200)
    .map(([literature_id, reasons]) => ({
      literature_id,
      reasons,
      title:
        db
          .prepare(
            "SELECT title FROM literature_metadata WHERE literature_id=?",
          )
          .get(literature_id)?.title ?? null,
    }));
  return {
    preview: parseIntakeWithdrawalPreview({
      remove: countObjects(unique),
      keep: { literatures: reasons.size, by_reason },
      kept_items,
      registered,
    }),
    objects: unique,
  };
}
/** Restore metadata FTS for a previously unprocessed paper; raw facts never change. */
function restoreFts(db: DatabaseSync, id: string) {
  const m = readMetadataRow(db, "literature", id);
  const text = (s: string | null) => ftsIndexText(s ?? "");
  deleteLiteratureSearchRows(db, literatureSearchRowIds(db, id));
  db.prepare(INSERT_LITERATURE_SEARCH_ROW).run(
    id,
    text(m.title),
    text(m.abstract),
    text(
      m.authors
        .flatMap((a) => [a.display_name, a.given_name, a.family_name, a.orcid])
        .filter(Boolean)
        .join(" "),
    ),
    text(
      m.authors
        .flatMap((a) => a.affiliations.flatMap((f) => [f.name, f.ror]))
        .filter(Boolean)
        .join(" "),
    ),
    text(m.identifiers.flatMap((i) => [i.namespace, i.value]).join(" ")),
    text([...m.keywords, ...(m.subject_terms ?? [])].join(" ")),
    text(m.venue),
    text(m.publisher),
    text(m.volume),
    text(m.issue),
    text(m.pages),
    "",
  );
}
/** In the intake owner's transaction. Keep the original withdrawal/report intact. */
export function restoreWithdrawnLiterature(
  db: DatabaseSync,
  id: string,
): boolean {
  if (!db.isTransaction)
    throw new Error("intake restoration requires a transaction");
  const owner = db
    .prepare(
      "SELECT batch_id FROM intake_withdrawn_objects WHERE object_kind='literature' AND object_id=?",
    )
    .get(id);
  if (!owner) return false;
  db.prepare(
    "DELETE FROM intake_withdrawn_objects WHERE batch_id=? AND ((object_kind='literature' AND object_id=?) OR (object_kind='literature-asset' AND object_id IN (SELECT literature_asset_id FROM literature_assets WHERE literature_id=?)) OR (object_kind='folder-member' AND json_extract(object_id,'$[1]')=?) OR (object_kind='mark' AND object_id IN (SELECT mark_id FROM reading_marks WHERE literature_id=?)))",
  ).run(owner.batch_id!, id, id, id, id);
  db.prepare(
    "DELETE FROM intake_withdrawn_objects WHERE batch_id=? AND object_kind='folder' AND object_id IN (WITH RECURSIVE parents(id) AS (SELECT folder_id FROM folder_members WHERE literature_id=? UNION SELECT f.parent_id FROM folders f JOIN parents p ON f.folder_id=p.id WHERE f.parent_id IS NOT NULL) SELECT id FROM parents)",
  ).run(owner.batch_id!, id);
  restoreFts(db, id);
  return true;
}
export type IntakeWithdrawalCommand = {
  readonly operation:
    | "preview"
    | "withdraw"
    | "restore"
    | "read"
    | "restore-preview";
  readonly batch_id: string;
  readonly at: string;
};
export function isIntakeWithdrawalRead(
  operation: IntakeWithdrawalCommand["operation"],
): boolean {
  return (
    operation === "preview" ||
    operation === "read" ||
    operation === "restore-preview"
  );
}
function savedWithdrawal(db: DatabaseSync, batchId: string) {
  const row = db
    .prepare(
      "SELECT batch_id,prior_state,withdrawn_at,withdrawn_by,restored_at,report_json,restoration_json FROM intake_withdrawals WHERE batch_id=?",
    )
    .get(batchId);
  if (!row) fail("intake-batch-state");
  const report = parseIntakeWithdrawalReport(
    JSON.parse(String(row.report_json)),
  );
  if (!("remove" in report)) fail("intake-batch-state");
  return { row, report };
}
/** Both preview and execution read exactly the objects still owned by this withdrawal. */
function remainingObjects(db: DatabaseSync, batchId: string): ObjectRef[] {
  return db
    .prepare(
      "SELECT object_kind AS kind,object_id AS id FROM intake_withdrawn_objects WHERE batch_id=?",
    )
    .all(batchId) as ObjectRef[];
}
function finishWithdrawalRevision(db: DatabaseSync, literatures: number) {
  // The marker triggers advance the revision for independent SQL writers.
  // A batch action has always published one revision in its own transaction.
  db.prepare(
    "UPDATE retrieval_source_revision SET revision=revision+1-? WHERE singleton=1",
  ).run(literatures);
}
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

export function runIntakeWithdrawal(
  db: DatabaseSync,
  command: IntakeWithdrawalCommand,
):
  | IntakeWithdrawalPreview
  | IntakeWithdrawalReport
  | IntakeRestorePreview
  | null {
  const read = isIntakeWithdrawalRead(command.operation),
    own = !read || !db.isTransaction;
  if (!read) beginCatalogWrite(db);
  else if (own) db.exec("BEGIN");
  try {
    if (command.operation === "read") {
      const batch = getBatch(db, command.batch_id);
      const result =
        batch.state === "withdrawn"
          ? savedWithdrawal(db, command.batch_id).report
          : null;
      if (own) db.exec("COMMIT");
      return result;
    }
    if (command.operation === "restore-preview") {
      requireBatch(db, command.batch_id, true);
      const { report } = savedWithdrawal(db, command.batch_id);
      const restore = countObjects(remainingObjects(db, command.batch_id));
      const result = parseIntakeRestorePreview({
        restore,
        already_restored: {
          literatures: report.remove.literatures - restore.literatures,
        },
      });
      if (own) db.exec("COMMIT");
      return result;
    }
    if (command.operation === "preview") {
      const result = plan(db, command.batch_id).preview;
      if (own) db.exec("COMMIT");
      return result;
    }
    let result: IntakeWithdrawalReport;
    if (command.operation === "withdraw") {
      const batch = requireBatch(db, command.batch_id),
        { preview, objects } = plan(db, command.batch_id);
      result = parseIntakeWithdrawalReport({
        ...preview,
        at: command.at,
        by: "web",
      });
      for (const object of objects)
        db.prepare(
          "INSERT INTO intake_withdrawn_objects(object_kind,object_id,batch_id,withdrawn_at) VALUES(?,?,?,?)",
        ).run(object.kind, object.id, command.batch_id, command.at);
      for (const row of db
        .prepare(
          "SELECT object_id FROM intake_withdrawn_objects WHERE batch_id=? AND object_kind='literature'",
        )
        .iterate(command.batch_id))
        deleteLiteratureSearchRows(
          db,
          literatureSearchRowIds(db, String(row.object_id)),
        );
      finishWithdrawalRevision(db, preview.remove.literatures);
      db.prepare(
        "INSERT INTO intake_withdrawals(batch_id,prior_state,withdrawn_at,withdrawn_by,restored_at,report_json,restoration_json) VALUES(?,?,?,?,NULL,?,NULL) ON CONFLICT(batch_id) DO UPDATE SET prior_state=excluded.prior_state,withdrawn_at=excluded.withdrawn_at,withdrawn_by=excluded.withdrawn_by,restored_at=NULL,report_json=excluded.report_json,restoration_json=NULL",
      ).run(
        command.batch_id,
        batch.state!,
        command.at,
        "web",
        JSON.stringify(result),
      );
      db.prepare(
        "UPDATE intake_batches SET state='withdrawn' WHERE batch_id=?",
      ).run(command.batch_id);
    } else {
      requireBatch(db, command.batch_id, true);
      const { row: old, report: previous } = savedWithdrawal(
        db,
        command.batch_id,
      );
      const objects = remainingObjects(db, command.batch_id);
      const restore = countObjects(objects);
      db.prepare("DELETE FROM intake_withdrawn_objects WHERE batch_id=?").run(
        command.batch_id,
      );
      for (const object of objects)
        if (object.kind === "literature") restoreFts(db, object.id);
      finishWithdrawalRevision(db, restore.literatures);
      result = parseIntakeWithdrawalReport({
        restore,
        keep: previous.keep,
        kept_items: previous.kept_items,
        registered: previous.registered,
        at: command.at,
        by: "web",
      });
      db.prepare(
        "UPDATE intake_withdrawals SET restored_at=?,restoration_json=? WHERE batch_id=?",
      ).run(command.at, JSON.stringify(result), command.batch_id);
      db.prepare("UPDATE intake_batches SET state=? WHERE batch_id=?").run(
        old.prior_state!,
        command.batch_id,
      );
    }
    commitCatalogWrite(db);
    return result;
  } catch (error) {
    if (own && db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
