import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** One registered stored translation (ADR 0068); the text lives in the file only. */
export interface DocumentTranslationRow {
  readonly literature_id: string;
  readonly asset_id: string;
  readonly content_version: string;
  readonly target_language: string;
  readonly document_version_id: string;
  readonly annotation_id: string;
  readonly artifact_reference: string;
  readonly sha256: string;
  readonly byte_size: number;
  readonly media_type: "application/json";
  readonly unit_count: number;
  readonly translated_count: number;
  readonly status: "complete" | "partial" | "same-language";
  readonly created_at: string;
  readonly updated_at: string;
}
const COLUMNS =
  "literature_id,asset_id,content_version,target_language,document_version_id,annotation_id,artifact_reference,sha256,byte_size,media_type,unit_count,translated_count,status,created_at,updated_at";
function fail(code: string): never {
  throw Object.assign(new Error("document translation storage refused"), {
    code,
  });
}
const row = (value: Record<string, unknown> | undefined) =>
  value
    ? ({
        ...value,
        byte_size: Number(value.byte_size),
        unit_count: Number(value.unit_count),
        translated_count: Number(value.translated_count),
      } as unknown as DocumentTranslationRow)
    : null;

/** The translation of exactly this content version, or null. */
export function readDocumentTranslation(
  db: DatabaseSync,
  r: Record<string, unknown>,
): DocumentTranslationRow | null {
  return row(
    db
      .prepare(
        `SELECT ${COLUMNS} FROM document_translations WHERE document_version_id=? AND target_language=? AND content_version=?`,
      )
      .get(
        String(r.document_version_id),
        String(r.target_language),
        String(r.content_version),
      ),
  );
}
/** The most recent translation of the literature in a language (reuse and `stale`). */
export function readLatestDocumentTranslation(
  db: DatabaseSync,
  r: Record<string, unknown>,
): DocumentTranslationRow | null {
  return row(
    db
      .prepare(
        `SELECT ${COLUMNS} FROM document_translations INDEXED BY document_translations_latest WHERE literature_id=? AND target_language=? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(String(r.literature_id), String(r.target_language)),
  );
}
/**
 * Register a written file and replace the row for its combination. The
 * replaced file stays registered as an artifact object, as other superseded
 * immutable files do; nothing here deletes bytes.
 */
export function publishDocumentTranslation(
  db: DatabaseSync,
  r: Record<string, unknown>,
): DocumentTranslationRow {
  const v = r.row as DocumentTranslationRow;
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
    fail("translation-document-stale");
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
      fail("translation-artifact-conflict");
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
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO document_translations(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(literature_id,asset_id,content_version,target_language) DO UPDATE SET document_version_id=excluded.document_version_id,annotation_id=excluded.annotation_id,artifact_reference=excluded.artifact_reference,sha256=excluded.sha256,byte_size=excluded.byte_size,media_type=excluded.media_type,unit_count=excluded.unit_count,translated_count=excluded.translated_count,status=excluded.status,updated_at=excluded.updated_at`,
  ).run(
    v.literature_id,
    v.asset_id,
    v.content_version,
    v.target_language,
    v.document_version_id,
    v.annotation_id,
    v.artifact_reference,
    v.sha256,
    v.byte_size,
    v.media_type,
    v.unit_count,
    v.translated_count,
    v.status,
    now,
    now,
  );
  return readDocumentTranslation(db, v as unknown as Record<string, unknown>)!;
}
