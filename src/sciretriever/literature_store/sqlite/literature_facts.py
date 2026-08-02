from __future__ import annotations

import os
import sqlite3

from sciretriever.literature_store.sqlite.engine import open_read_only_snapshot
from sciretriever.model.literature import VersionFacts, WorkFacts
from sciretriever.model.primitives import (
    AnalysisArtifactId,
    LightDocumentId,
    MetadataSnapshotId,
    Sha256,
    WorkId,
    WorkVersionAssetId,
    WorkVersionId,
)


def _read_work_facts(connection: sqlite3.Connection, work_id: WorkId) -> WorkFacts | None:
    versions = connection.execute(
        "SELECT id FROM work_versions WHERE work_id=? ORDER BY id", (str(work_id),)
    ).fetchall()
    exists = connection.execute("SELECT 1 FROM works WHERE id=?", (str(work_id),)).fetchone()
    if exists is None:
        return None
    representative = connection.execute(
        "SELECT work_version_id FROM work_representative_versions WHERE work_id=?", (str(work_id),)
    ).fetchone()
    return WorkFacts(
        work_id=work_id,
        representative_version_id=None
        if representative is None
        else WorkVersionId(representative[0]),
        version_ids=tuple(WorkVersionId(row[0]) for row in versions),
    )


def _read_version_facts(
    connection: sqlite3.Connection, version_id: WorkVersionId
) -> VersionFacts | None:
    row = connection.execute(
        "SELECT v.work_id,v.version_role,m.metadata_snapshot_id,s.revision,s.sha256,"
        "p.work_version_asset_id,l.light_document_id,d.sha256,d.primary_asset_id,COALESCE("
        "d.complete,0),b.light_document_id,b.analysis_artifact_id,a.light_document_id,"
        "a.input_sha256,COALESCE(a.nine_categories_complete,0),b.metadata_snapshot_id,"
        "b.reference_set_id,COALESCE(rs.complete,0),b.tag_set_id,COALESCE(ts.complete,0) FROM "
        "work_versions v LEFT JOIN work_version_current_metadata m ON m.work_version_id=v.id "
        "LEFT JOIN metadata_snapshots s ON s.id=m.metadata_snapshot_id LEFT JOIN "
        "accepted_primary_assets p ON p.work_version_id=v.id LEFT JOIN "
        "work_version_current_light_document l ON l.work_version_id=v.id LEFT JOIN "
        "light_documents d ON d.id=l.light_document_id AND d.work_version_id=v.id LEFT JOIN "
        "completion_bundles b ON b.work_version_id=v.id LEFT JOIN analysis_artifacts a ON "
        "a.id=b.analysis_artifact_id AND a.work_version_id=v.id LEFT JOIN reference_sets rs ON "
        "rs.id=b.reference_set_id AND rs.work_version_id=v.id LEFT JOIN tag_sets ts ON "
        "ts.id=b.tag_set_id AND ts.work_version_id=v.id WHERE v.id=?",
        (str(version_id),),
    ).fetchone()
    if row is None:
        return None
    return VersionFacts(
        work_id=WorkId(row[0]),
        work_version_id=version_id,
        version_role=row[1],
        metadata_snapshot_id=None if row[2] is None else MetadataSnapshotId(row[2]),
        metadata_revision=row[3],
        metadata_sha256=None if row[4] is None else Sha256(row[4]),
        accepted_primary_id=None if row[5] is None else WorkVersionAssetId(row[5]),
        current_light_document_id=None if row[6] is None else LightDocumentId(row[6]),
        current_light_sha256=None if row[7] is None else Sha256(row[7]),
        current_light_primary_id=None if row[8] is None else WorkVersionAssetId(row[8]),
        current_light_complete=bool(row[9]),
        completion_light_document_id=None if row[10] is None else LightDocumentId(row[10]),
        completion_analysis_artifact_id=None if row[11] is None else AnalysisArtifactId(row[11]),
        analysis_light_document_id=None if row[12] is None else LightDocumentId(row[12]),
        analysis_input_sha256=None if row[13] is None else Sha256(row[13]),
        analysis_nine_categories_complete=bool(row[14]),
        completion_metadata_snapshot_id=None if row[15] is None else MetadataSnapshotId(row[15]),
        completion_reference_set_id=row[16],
        completion_reference_set_complete=bool(row[17]),
        completion_tag_set_id=row[18],
        completion_tag_set_complete=bool(row[19]),
    )


def get_work_facts(catalog_path: str | os.PathLike[str], work_id: WorkId) -> WorkFacts | None:
    with open_read_only_snapshot(catalog_path) as connection:
        return _read_work_facts(connection, work_id)


def get_version_facts(
    catalog_path: str | os.PathLike[str], version_id: WorkVersionId
) -> VersionFacts | None:
    with open_read_only_snapshot(catalog_path) as connection:
        return _read_version_facts(connection, version_id)
