import type { DatabaseSync } from "node:sqlite";
import type { TextLevel } from "@sciretriever/contracts";

export interface DocumentDefaultRequest {
  readonly literature_id: string;
  readonly asset_id: string;
  readonly asset_sha256: string;
  readonly expected_default_revision: number | null;
  /** A corrected publication nominates its new version; eligibility is still rechecked. */
  readonly preferred_proofread_version_id?: string;
}
export function documentDefaultFailure(code: string): never {
  throw Object.assign(new Error("document default update refused"), { code });
}

/**
 * Called inside the owner's raw, draft or corrected publication transaction.
 * Reads and schema migration never invoke this function.
 */
export function recomputeDocumentDefault(
  db: DatabaseSync,
  request: DocumentDefaultRequest,
) {
  if (!db.isTransaction)
    documentDefaultFailure("document-transaction-required");
  const { literature_id, asset_id, asset_sha256 } = request;
  const current = db
    .prepare(
      "SELECT dd.*,d.schema_version FROM document_defaults dd JOIN document_versions d ON d.document_version_id=dd.document_version_id WHERE d.literature_id=? AND d.source_asset_id=? AND d.source_sha256=?",
    )
    .get(literature_id, asset_id, asset_sha256);
  if ((current?.revision ?? null) !== request.expected_default_revision)
    documentDefaultFailure("document-default-conflict");
  if (
    !db
      .prepare(
        "SELECT 1 FROM literature_assets la JOIN assets a ON a.asset_id=la.asset_id WHERE la.literature_id=? AND a.asset_id=? AND a.sha256=? AND a.media_type='application/pdf' AND la.role IN ('primary-pdf','supplementary-pdf')",
      )
      .get(literature_id, asset_id, asset_sha256)
  )
    documentDefaultFailure("document-source-stale");
  const corrected = db
    .prepare(
      "SELECT d.document_id,d.document_version_id,2 AS schema_version FROM document_versions d JOIN proofread_versions source_pv ON source_pv.proofread_id=d.proofread_id AND source_pv.content_sha256=d.proofread_content_sha256 AND source_pv.status='complete' JOIN proofread_current pc ON pc.part_asset_id=d.source_asset_id AND pc.part_sha256=d.source_sha256 JOIN proofread_versions pv ON pv.proofread_id=pc.proofread_id AND pv.content_sha256=d.proofread_content_sha256 AND pv.status='complete' WHERE d.schema_version=2 AND d.literature_id=? AND d.source_asset_id=? AND d.source_sha256=? AND pc.manual_revision=COALESCE((SELECT revision FROM proofread_manual_state WHERE part_asset_id=d.source_asset_id),0) AND NOT EXISTS(SELECT 1 FROM raw_parse_pins pin JOIN raw_parses r ON r.raw_parse_id=pin.raw_parse_id LEFT JOIN raw_parse_current rc ON rc.source_asset_id=r.source_asset_id AND rc.profile=r.profile WHERE pin.proofread_id IN (pc.proofread_id,d.proofread_id) AND (rc.raw_parse_id IS NULL OR rc.raw_parse_id!=r.raw_parse_id)) ORDER BY (d.document_version_id=?) DESC,(d.document_version_id=?) DESC,d.created_at DESC,d.document_version_id DESC LIMIT 1",
    )
    .get(
      literature_id,
      asset_id,
      asset_sha256,
      request.preferred_proofread_version_id ?? "",
      current?.document_version_id ?? "",
    );
  const draft = corrected
    ? null
    : db
        .prepare(
          "SELECT d.document_id,d.document_version_id,3 AS schema_version FROM draft_current dc JOIN document_versions d ON d.document_version_id=dc.document_version_id JOIN raw_parses r ON r.raw_parse_id=d.raw_parse_id AND r.result_sha256=d.raw_parse_result_sha256 AND r.source_asset_id=d.source_asset_id AND r.source_sha256=d.source_sha256 JOIN raw_parse_current rc ON rc.source_asset_id=r.source_asset_id AND rc.source_sha256=r.source_sha256 AND rc.profile=r.profile AND rc.raw_parse_id=r.raw_parse_id WHERE d.schema_version=3 AND d.literature_id=? AND dc.part_asset_id=? AND dc.part_sha256=?",
        )
        .get(literature_id, asset_id, asset_sha256);
  const candidate = corrected ?? draft;
  const changed =
    (current?.document_version_id ?? null) !==
    (candidate?.document_version_id ?? null);
  let revision = current?.revision as number | undefined;
  if (changed) {
    if (!candidate) {
      db.prepare(
        "DELETE FROM document_defaults WHERE document_id=? AND revision=?",
      ).run(current!.document_id!, current!.revision!);
      revision = undefined;
    } else if (current) {
      db.prepare(
        "UPDATE document_defaults SET document_version_id=?,revision=revision+1 WHERE document_id=? AND revision=?",
      ).run(
        candidate.document_version_id!,
        current.document_id!,
        current.revision!,
      );
      revision = Number(current.revision) + 1;
    } else {
      db.prepare(
        "INSERT INTO document_defaults(document_id,document_version_id,revision) VALUES(?,?,1)",
      ).run(candidate.document_id!, candidate.document_version_id!);
      revision = 1;
    }
  }
  return {
    default_changed: changed,
    default_revision: revision ?? null,
    document_version_id: candidate
      ? String(candidate.document_version_id)
      : null,
    text_level: candidate
      ? ((candidate.schema_version === 3 ? "draft" : "proofread") as TextLevel)
      : null,
  };
}

/** A current pointer belongs to an asset; all literature owners are recomputed in this same transaction. */
export function recomputeAssetDocumentDefaults(
  db: DatabaseSync,
  assetId: string,
  assetSha256: string,
  requested?: DocumentDefaultRequest,
) {
  if (!db.isTransaction)
    documentDefaultFailure("document-transaction-required");
  const owners = db
    .prepare(
      "SELECT la.literature_id AS literature_id,a.asset_id AS asset_id,a.sha256 AS asset_sha256,dd.revision AS expected_default_revision FROM literature_assets la JOIN assets a ON a.asset_id=la.asset_id LEFT JOIN (document_defaults dd JOIN document_versions d ON d.document_version_id=dd.document_version_id) ON d.literature_id=la.literature_id AND d.source_asset_id=a.asset_id AND d.source_sha256=a.sha256 WHERE a.asset_id=? AND a.sha256=? AND a.media_type='application/pdf' AND la.role IN ('primary-pdf','supplementary-pdf') ORDER BY la.literature_id",
    )
    .all(assetId, assetSha256);
  if (
    requested &&
    !owners.some((row) => row.literature_id === requested.literature_id)
  )
    documentDefaultFailure("document-source-stale");
  return owners.map((row) => {
    const request: DocumentDefaultRequest = {
      literature_id: String(row.literature_id),
      asset_id: assetId,
      asset_sha256: assetSha256,
      expected_default_revision:
        row.expected_default_revision === null
          ? null
          : Number(row.expected_default_revision),
      ...(requested?.literature_id === row.literature_id ? requested : {}),
    };
    return {
      literature_id: request.literature_id,
      ...recomputeDocumentDefault(db, request),
    };
  });
}
