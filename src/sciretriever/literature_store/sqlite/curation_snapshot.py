from __future__ import annotations

import sqlite3

from sciretriever.kernel import canonical_json_bytes
from sciretriever.kernel.json import CanonicalJsonObject
from sciretriever.model.library import CurationScope, SnapshotToken
from sciretriever.model.primitives import sha256_digest

SqlValue = str | int | float | bytes | None


def _rows(
    connection: sqlite3.Connection, table: str, column: str, values: tuple[str, ...]
) -> tuple[tuple[SqlValue, ...], ...]:
    if not values:
        return ()
    marks = ",".join("?" for _ in values)
    return tuple(
        connection.execute(
            f"SELECT * FROM {table} WHERE {column} IN ({marks}) ORDER BY 1", values
        ).fetchall()
    )


def snapshot_token(connection: sqlite3.Connection, scope: CurationScope) -> SnapshotToken:
    work_ids = tuple(str(value) for value in scope.work_ids)
    version_ids = tuple(str(value) for value in scope.work_version_ids)
    entries: list[tuple[str, str]] = []
    tables = (
        ("works", "id", work_ids),
        ("work_versions", "id", version_ids),
        ("metadata_observations", "work_version_id", version_ids),
        ("stable_identifiers", "work_version_id", version_ids),
        ("metadata_snapshots", "work_version_id", version_ids),
        ("work_version_current_metadata", "work_version_id", version_ids),
        ("work_version_assets", "work_version_id", version_ids),
        ("accepted_primary_assets", "work_version_id", version_ids),
        ("light_documents", "work_version_id", version_ids),
        ("work_version_current_light_document", "work_version_id", version_ids),
        ("analysis_artifacts", "work_version_id", version_ids),
        ("completion_bundles", "work_version_id", version_ids),
        ("reference_sets", "work_version_id", version_ids),
        ("tag_sets", "work_version_id", version_ids),
        ("collection_memberships", "work_id", work_ids),
        ("reference_members", "target_work_id", work_ids),
        ("reference_members", "target_work_version_id", version_ids),
        ("work_version_relations", "left_version_id", version_ids),
        ("work_version_relations", "right_version_id", version_ids),
        ("work_representative_versions", "work_id", work_ids),
    )
    for table, column, values in tables:
        entries.extend((table, repr(row)) for row in _rows(connection, table, column, values))
    if work_ids:
        marks = ",".join("?" for _ in work_ids)
        for table in ("collection_causes", "collection_paths"):
            rows = connection.execute(
                f"SELECT x.* FROM {table} x JOIN collection_memberships m ON m.id=x.membership_id "
                f"WHERE m.work_id IN ({marks}) ORDER BY x.id",
                work_ids,
            ).fetchall()
            entries.extend((table, repr(tuple(row))) for row in rows)
    if version_ids:
        marks = ",".join("?" for _ in version_ids)
        for table in ("reference_members", "unresolved_references", "tag_members"):
            parent = "reference_sets" if table != "tag_members" else "tag_sets"
            foreign_key = "reference_set_id" if table != "tag_members" else "tag_set_id"
            rows = connection.execute(
                f"SELECT x.* FROM {table} x JOIN {parent} p ON p.id=x.{foreign_key} "
                f"WHERE p.work_version_id IN ({marks}) ORDER BY x.id",
                version_ids,
            ).fetchall()
            entries.extend((table, repr(tuple(row))) for row in rows)
        asset_rows = connection.execute(
            f"SELECT a.* FROM artifacts a JOIN work_version_assets w ON w.artifact_id=a.id "
            f"JOIN accepted_primary_assets p ON p.work_version_asset_id=w.id "
            f"WHERE p.work_version_id IN ({marks}) ORDER BY a.id",
            version_ids,
        ).fetchall()
        raw_rows = connection.execute(
            f"SELECT r.* FROM raw_assets r JOIN work_version_assets w ON "
            f"w.artifact_id=r.artifact_id "
            f"JOIN accepted_primary_assets p ON p.work_version_asset_id=w.id "
            f"WHERE p.work_version_id IN ({marks}) ORDER BY r.artifact_id",
            version_ids,
        ).fetchall()
        entries.extend(("artifacts", repr(tuple(row))) for row in asset_rows)
        entries.extend(("raw_assets", repr(tuple(row))) for row in raw_rows)
    entries.sort()
    payload = CanonicalJsonObject((("entries", tuple(f"{table}:{row}" for table, row in entries)),))
    return SnapshotToken(sha256=sha256_digest(canonical_json_bytes(payload)))
