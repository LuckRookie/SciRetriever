import type { DatabaseSync } from "node:sqlite";
import {
  markTags,
  parseMarkOperation,
  parseReadingMark,
  sortMarks,
  type MarkDocumentAnchor,
  type MarkPdfAnchor,
  type ReadingMark,
} from "@sciretriever/contracts";

/** Deleted marks stay restorable for this long, then the next write removes them. */
const RETAIN_DELETED_MS = 30 * 86400000;

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function present(row: Record<string, unknown>): ReadingMark {
  const note = String(row.note);
  return parseReadingMark({
    mark_id: row.mark_id,
    literature_id: row.literature_id,
    kind: row.kind,
    color: row.color,
    note,
    tags: markTags(note),
    quote: row.quote,
    quote_prefix: row.quote_prefix,
    quote_suffix: row.quote_suffix,
    pdf:
      row.pdf_sha256 === null
        ? null
        : {
            sha256: row.pdf_sha256,
            page: Number(row.pdf_page),
            rects: JSON.parse(String(row.pdf_rects_json)) as unknown,
          },
    document:
      row.document_version_id === null
        ? null
        : {
            document_version_id: row.document_version_id,
            start_utf8: Number(row.document_start_utf8),
            end_utf8: Number(row.document_end_utf8),
          },
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  });
}
function mark(db: DatabaseSync, id: string) {
  const row = db.prepare("SELECT * FROM reading_marks WHERE mark_id=?").get(id);
  if (!row) fail("mark-not-found");
  return row;
}
/** An anchor must name this paper's own PDF or one of its own full-text versions. */
function checkPdf(db: DatabaseSync, literatureId: string, pdf: MarkPdfAnchor) {
  if (
    !db
      .prepare(
        "SELECT 1 FROM literature_assets la JOIN assets a USING(asset_id) WHERE la.literature_id=? AND a.sha256=? AND a.media_type='application/pdf' LIMIT 1",
      )
      .get(literatureId, pdf.sha256)
  )
    fail("mark-anchor-invalid");
}
function checkDocument(
  db: DatabaseSync,
  literatureId: string,
  document: MarkDocumentAnchor,
) {
  const row = db
    .prepare(
      "SELECT literature_id,markdown_byte_size FROM document_versions WHERE document_version_id=?",
    )
    .get(document.document_version_id);
  if (
    !row ||
    row.literature_id !== literatureId ||
    document.end_utf8 > Number(row.markdown_byte_size)
  )
    fail("mark-anchor-invalid");
}
export function runMarkStorage(db: DatabaseSync, value: unknown): unknown {
  const r = value as {
    operation: string;
    request: unknown;
    now?: string;
    actor?: string;
    mark_id?: string;
  };
  const op = parseMarkOperation({ operation: r.operation, request: r.request });
  const write = op.operation !== "list" && op.operation !== "export";
  db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    let result: unknown;
    if (op.operation === "list" || op.operation === "export") {
      if (
        !db
          .prepare("SELECT 1 FROM literatures WHERE literature_id=?")
          .get(op.request.literature_id)
      )
        fail("literature-not-found");
      result = {
        items: sortMarks(
          db
            .prepare(
              "SELECT * FROM reading_marks WHERE literature_id=? AND deleted_at IS NULL ORDER BY created_at,mark_id",
            )
            .all(op.request.literature_id)
            .map(present),
        ),
      };
    } else {
      const now = r.now!;
      db.prepare(
        "DELETE FROM reading_marks WHERE deleted_at IS NOT NULL AND deleted_at<?",
      ).run(new Date(Date.parse(now) - RETAIN_DELETED_MS).toISOString());
      if (op.operation === "create") {
        const q = op.request,
          id = q.mark_id ?? r.mark_id!;
        if (
          !db
            .prepare("SELECT 1 FROM literatures WHERE literature_id=?")
            .get(q.literature_id)
        )
          fail("literature-not-found");
        if (db.prepare("SELECT 1 FROM reading_marks WHERE mark_id=?").get(id))
          fail("mark-exists");
        if (q.pdf) checkPdf(db, q.literature_id, q.pdf);
        if (q.document) checkDocument(db, q.literature_id, q.document);
        db.prepare(
          "INSERT INTO reading_marks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)",
        ).run(
          id,
          q.literature_id,
          q.kind,
          q.color,
          q.note,
          q.quote,
          q.quote_prefix,
          q.quote_suffix,
          q.pdf?.sha256 ?? null,
          q.pdf?.page ?? null,
          q.pdf ? JSON.stringify(q.pdf.rects) : null,
          q.document?.document_version_id ?? null,
          q.document?.start_utf8 ?? null,
          q.document?.end_utf8 ?? null,
          now,
          now,
          r.actor!,
        );
        result = present(mark(db, id));
      } else {
        const old = mark(db, op.request.mark_id),
          literatureId = String(old.literature_id);
        if (op.operation === "update") {
          if (old.deleted_at !== null) fail("mark-deleted");
          const q = op.request;
          if (q.pdf) checkPdf(db, literatureId, q.pdf);
          if (q.document) checkDocument(db, literatureId, q.document);
          if (q.pdf === undefined && old.kind === "region" && q.document)
            fail("mark-anchor-invalid");
          db.prepare(
            "UPDATE reading_marks SET color=?,note=?,pdf_sha256=?,pdf_page=?,pdf_rects_json=?,document_version_id=?,document_start_utf8=?,document_end_utf8=?,updated_at=? WHERE mark_id=?",
          ).run(
            q.color ?? String(old.color),
            q.note ?? String(old.note),
            q.pdf ? q.pdf.sha256 : (old.pdf_sha256 as string | null),
            q.pdf ? q.pdf.page : (old.pdf_page as number | null),
            q.pdf
              ? JSON.stringify(q.pdf.rects)
              : (old.pdf_rects_json as string | null),
            q.document
              ? q.document.document_version_id
              : (old.document_version_id as string | null),
            q.document
              ? q.document.start_utf8
              : (old.document_start_utf8 as number | null),
            q.document
              ? q.document.end_utf8
              : (old.document_end_utf8 as number | null),
            now,
            q.mark_id,
          );
        } else
          db.prepare(
            "UPDATE reading_marks SET deleted_at=?,updated_at=? WHERE mark_id=?",
          ).run(
            op.operation === "delete" ? now : null,
            now,
            op.request.mark_id,
          );
        result = present(mark(db, op.request.mark_id));
      }
    }
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
