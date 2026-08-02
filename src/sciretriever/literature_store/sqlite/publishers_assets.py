from __future__ import annotations

import sqlite3

from sciretriever.kernel import canonical_json_bytes
from sciretriever.literature_store.sqlite.publisher_support import (
    StalePublicationError,
    StatementFailpoint,
    execute,
)
from sciretriever.model.assets import (
    AssetPublication,
    PrimaryPdfAcceptance,
    SupplementaryAssetAcceptance,
)
from sciretriever.model.primitives import AssetId


def _raw_artifact_id(
    connection: sqlite3.Connection,
    point: StatementFailpoint,
    acceptance: PrimaryPdfAcceptance | SupplementaryAssetAcceptance,
) -> str:
    artifact = acceptance.artifact
    media_type = (
        "application/pdf" if isinstance(acceptance, PrimaryPdfAcceptance) else acceptance.media_type
    )
    existing = connection.execute(
        "SELECT id,storage_path,byte_size,media_type FROM artifacts WHERE kind='raw' AND sha256=?",
        (str(artifact.sha256),),
    ).fetchone()
    expected = (str(artifact.path), artifact.size)
    if existing is not None:
        if existing[1:3] != expected:
            raise StalePublicationError("published artifact identity is inconsistent")
        marker = connection.execute(
            "SELECT 1 FROM raw_assets WHERE artifact_id=?", (existing[0],)
        ).fetchone()
        if marker is None:
            raise StalePublicationError("raw artifact registration is missing")
        return str(existing[0])
    execute(
        connection,
        point,
        "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size,media_type) VALUES(?,?,"
        "?,?,?,?)",
        (
            str(acceptance.artifact_id),
            "raw",
            str(artifact.sha256),
            str(artifact.path),
            artifact.size,
            media_type,
        ),
    )
    execute(
        connection,
        point,
        "INSERT INTO raw_assets(artifact_id) VALUES(?)",
        (str(acceptance.artifact_id),),
    )
    return str(acceptance.artifact_id)


def _existing_relation(
    connection: sqlite3.Connection,
    acceptance: PrimaryPdfAcceptance | SupplementaryAssetAcceptance,
    artifact_id: str,
    source: str,
) -> str | None:
    role = "primary-pdf" if isinstance(acceptance, PrimaryPdfAcceptance) else acceptance.role.value
    row = connection.execute(
        "SELECT id FROM work_version_assets WHERE work_version_id=? AND artifact_id=? AND "
        "role=? AND source_json=?",
        (str(acceptance.work_version_id), artifact_id, role, source),
    ).fetchone()
    return None if row is None else str(row[0])


def publish_primary_asset(
    connection: sqlite3.Connection,
    point: StatementFailpoint,
    acceptance: PrimaryPdfAcceptance,
) -> AssetPublication:
    metadata = connection.execute(
        "SELECT c.metadata_snapshot_id,s.revision,s.sha256 FROM "
        "work_version_current_metadata c JOIN metadata_snapshots s ON "
        "s.id=c.metadata_snapshot_id WHERE c.work_version_id=?",
        (str(acceptance.work_version_id),),
    ).fetchone()
    if metadata != (
        str(acceptance.expected_metadata_id),
        acceptance.expected_metadata_revision,
        str(acceptance.expected_metadata_sha256),
    ):
        raise StalePublicationError("metadata changed")
    if (
        connection.execute(
            "SELECT 1 FROM accepted_primary_assets WHERE work_version_id=?",
            (str(acceptance.work_version_id),),
        ).fetchone()
        is not None
    ):
        raise StalePublicationError("primary asset already accepted")
    artifact_id = _raw_artifact_id(connection, point, acceptance)
    source = canonical_json_bytes(acceptance.source).decode("ascii")
    existing_relation = _existing_relation(connection, acceptance, artifact_id, source)
    if existing_relation is not None:
        return AssetPublication(
            asset_id=AssetId(artifact_id),
            relation_id=acceptance.relation_id.__class__(existing_relation),
            replayed=True,
        )
    execute(
        connection,
        point,
        "INSERT INTO work_version_assets(id,work_version_id,artifact_id,role,source_json) "
        "VALUES(?,?,?,'primary-pdf',?)",
        (
            str(acceptance.relation_id),
            str(acceptance.work_version_id),
            artifact_id,
            source,
        ),
    )
    execute(
        connection,
        point,
        "INSERT INTO accepted_primary_assets(work_version_id,work_version_asset_id) VALUES(?,?)",
        (str(acceptance.work_version_id), str(acceptance.relation_id)),
    )
    return AssetPublication(
        asset_id=AssetId(artifact_id),
        relation_id=acceptance.relation_id,
        replayed=False,
    )


def publish_supplementary_asset(
    connection: sqlite3.Connection,
    point: StatementFailpoint,
    acceptance: SupplementaryAssetAcceptance,
) -> AssetPublication:
    metadata = connection.execute(
        "SELECT c.metadata_snapshot_id,s.revision,s.sha256 FROM "
        "work_version_current_metadata c JOIN metadata_snapshots s ON "
        "s.id=c.metadata_snapshot_id WHERE c.work_version_id=?",
        (str(acceptance.work_version_id),),
    ).fetchone()
    if metadata != (
        str(acceptance.expected_metadata_id),
        acceptance.expected_metadata_revision,
        str(acceptance.expected_metadata_sha256),
    ):
        raise StalePublicationError("metadata changed")
    primary = connection.execute(
        "SELECT a.sha256 FROM accepted_primary_assets p JOIN work_version_assets w ON "
        "w.id=p.work_version_asset_id JOIN artifacts a ON a.id=w.artifact_id WHERE "
        "p.work_version_id=?",
        (str(acceptance.work_version_id),),
    ).fetchone()
    actual_primary = None if primary is None else primary[0]
    expected_primary = (
        None
        if acceptance.expected_primary_sha256 is None
        else str(acceptance.expected_primary_sha256)
    )
    if actual_primary != expected_primary:
        raise StalePublicationError("primary asset changed")
    artifact_id = _raw_artifact_id(connection, point, acceptance)
    source = canonical_json_bytes(acceptance.source).decode("ascii")
    existing_relation = _existing_relation(connection, acceptance, artifact_id, source)
    if existing_relation is not None:
        return AssetPublication(
            asset_id=AssetId(artifact_id),
            relation_id=acceptance.relation_id.__class__(existing_relation),
            replayed=True,
        )
    execute(
        connection,
        point,
        "INSERT INTO work_version_assets(id,work_version_id,artifact_id,role,source_json) "
        "VALUES(?,?,?,?,?)",
        (
            str(acceptance.relation_id),
            str(acceptance.work_version_id),
            artifact_id,
            acceptance.role.value,
            source,
        ),
    )
    return AssetPublication(
        asset_id=AssetId(artifact_id),
        relation_id=acceptance.relation_id,
        replayed=False,
    )
