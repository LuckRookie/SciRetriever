import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** One registered reading-layers result (ADR 0069); points live in the file only. */
export interface DocumentLayersRow {
  readonly literature_id: string;
  readonly asset_id: string;
  readonly content_version: string;
  readonly document_version_id: string;
  readonly annotation_id: string;
  readonly status: "complete" | "not-applicable";
  readonly reason: "long-document" | "too-short" | null;
  /** null for a not-applicable row, which has no file. */
  readonly artifact_reference: string | null;
  readonly sha256: string | null;
  readonly byte_size: number | null;
  readonly media_type: "application/json" | null;
  readonly point_count: number;
  /** The translation part's language and translation file, or null. */
  readonly target_language: string | null;
  readonly translation_sha256: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}
const COLUMNS =
  "literature_id,asset_id,content_version,document_version_id,annotation_id,status,reason,artifact_reference,sha256,byte_size,media_type,point_count,target_language,translation_sha256,created_at,updated_at";
function fail(code: string): never {
  throw Object.assign(new Error("document layers storage refused"), { code });
}
const row = (value: Record<string, unknown> | undefined) =>
  value
    ? ({
        ...value,
        byte_size: value.byte_size === null ? null : Number(value.byte_size),
        point_count: Number(value.point_count),
      } as unknown as DocumentLayersRow)
    : null;

/** The layers of exactly this content version, or null. */
export function readDocumentLayers(
  db: DatabaseSync,
  r: Record<string, unknown>,
): DocumentLayersRow | null {
  return row(
    db
      .prepare(
        `SELECT ${COLUMNS} FROM document_layers WHERE literature_id=? AND asset_id=? AND content_version=? AND document_version_id=?`,
      )
      .get(
        String(r.literature_id),
        String(r.asset_id),
        String(r.content_version),
        String(r.document_version_id),
      ),
  );
}
/** The most recent complete layers of the literature (for `stale`). */
export function readLatestDocumentLayers(
  db: DatabaseSync,
  r: Record<string, unknown>,
): DocumentLayersRow | null {
  return row(
    db
      .prepare(
        `SELECT ${COLUMNS} FROM document_layers INDEXED BY document_layers_latest WHERE literature_id=? AND status='complete' ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(String(r.literature_id)),
  );
}
/**
 * Register a written file (or a not-applicable result) and replace the row
 * for its combination. A replaced file stays registered as an artifact
 * object, like other superseded immutable files; nothing deletes bytes.
 */
export function publishDocumentLayers(
  db: DatabaseSync,
  r: Record<string, unknown>,
): DocumentLayersRow {
  const v = r.row as DocumentLayersRow;
  const document = db
    .prepare(
      "SELECT literature_id,source_asset_id FROM document_versions WHERE document_version_id=?",
    )
    .get(v.document_version_id);
  const primary = db
    .prepare(
      "SELECT 1 FROM literature_assets WHERE literature_id=? AND asset_id=? AND role='primary-pdf'",
    )
    .get(v.literature_id, v.asset_id);
  if (
    !document ||
    document.literature_id !== v.literature_id ||
    document.source_asset_id !== v.asset_id ||
    !primary
  )
    fail("layers-document-stale");
  if (v.sha256 !== null) {
    const old = db
      .prepare(
        "SELECT sha256,byte_size,media_type,relative_path FROM artifact_objects WHERE sha256=? OR relative_path=?",
      )
      .get(v.sha256, v.artifact_reference);
    if (old) {
      if (
        old.sha256 !== v.sha256 ||
        old.relative_path !== v.artifact_reference ||
        Number(old.byte_size) !== v.byte_size ||
        old.media_type !== v.media_type
      )
        fail("layers-artifact-conflict");
    } else
      db.prepare(
        "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?)",
      ).run(
        randomUUID(),
        v.sha256,
        v.byte_size,
        v.media_type,
        v.artifact_reference,
      );
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO document_layers(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(literature_id,asset_id,content_version) DO UPDATE SET document_version_id=excluded.document_version_id,annotation_id=excluded.annotation_id,status=excluded.status,reason=excluded.reason,artifact_reference=excluded.artifact_reference,sha256=excluded.sha256,byte_size=excluded.byte_size,media_type=excluded.media_type,point_count=excluded.point_count,target_language=excluded.target_language,translation_sha256=excluded.translation_sha256,updated_at=excluded.updated_at`,
  ).run(
    v.literature_id,
    v.asset_id,
    v.content_version,
    v.document_version_id,
    v.annotation_id,
    v.status,
    v.reason,
    v.artifact_reference,
    v.sha256,
    v.byte_size,
    v.media_type,
    v.point_count,
    v.target_language,
    v.translation_sha256,
    now,
    now,
  );
  return readDocumentLayers(db, v as unknown as Record<string, unknown>)!;
}
