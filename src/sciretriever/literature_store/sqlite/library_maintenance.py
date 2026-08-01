from __future__ import annotations

import hashlib
import os

from sciretriever.literature_store.sqlite.engine import (
    create_or_open_catalog,
    open_read_only_snapshot,
)

_AUTHORITY_TABLES = (
    "works",
    "work_versions",
    "stable_identifiers",
    "metadata_snapshots",
    "work_version_current_metadata",
    "accepted_primary_assets",
    "light_documents",
    "analysis_artifacts",
    "completion_bundles",
    "reference_sets",
    "tag_sets",
)
_FTS_TABLES = ("metadata_fts", "light_text_fts", "analysis_fts")


def authority_fingerprint(catalog_path: str | os.PathLike[str]) -> str:
    with open_read_only_snapshot(catalog_path) as connection:
        payload = "\n".join(
            str(connection.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall())
            for table in _AUTHORITY_TABLES
        )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def clear_search_indexes(catalog_path: str | os.PathLike[str]) -> None:
    with create_or_open_catalog(catalog_path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        for table in _FTS_TABLES:
            connection.execute(f"DELETE FROM {table}")
        connection.commit()


def rebuild_search_indexes(catalog_path: str | os.PathLike[str]) -> None:
    with create_or_open_catalog(catalog_path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        for table in _FTS_TABLES:
            connection.execute(f"DELETE FROM {table}")
        connection.execute(
            "INSERT INTO metadata_fts SELECT c.work_version_id,s.values_json FROM "
            "work_version_current_metadata c JOIN metadata_snapshots s ON "
            "s.id=c.metadata_snapshot_id"
        )
        connection.execute(
            "INSERT INTO light_text_fts SELECT c.work_version_id,d.document_json FROM "
            "work_version_current_light_document c JOIN light_documents d ON "
            "d.id=c.light_document_id"
        )
        connection.execute(
            "INSERT INTO analysis_fts SELECT b.work_version_id,a.proposal_json FROM "
            "completion_bundles b JOIN analysis_artifacts a ON a.id=b.analysis_artifact_id"
        )
        connection.commit()


__all__ = ("authority_fingerprint", "clear_search_indexes", "rebuild_search_indexes")
