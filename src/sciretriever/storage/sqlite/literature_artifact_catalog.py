"""SQLite-only Catalog verification for Literature artifact reads.

This internal Storage helper owns the short read snapshot and all SQL needed
to bind one normalized filesystem descriptor to the formal ``artifact_objects``
row and, for an Asset, to its exact ``assets`` row.  It does not open files or
expose a Literature-facing Port.
"""

from __future__ import annotations

import sqlite3

from sciretriever.model.primitives import AssetId
from sciretriever.storage.files.store import ArtifactReference
from sciretriever.storage.sqlite.engine import CatalogEngine


class LiteratureArtifactCatalogError(RuntimeError):
    """Stable, path-free failure for the internal Catalog verification."""

    _DEFAULT_MESSAGE = "literature artifact catalog verification failed"

    def __init__(self, _message: object | None = None) -> None:
        super().__init__(self._DEFAULT_MESSAGE)


def verify_literature_artifact_catalog(
    engine: CatalogEngine,
    reference: ArtifactReference,
    *,
    asset_id: AssetId | None,
) -> None:
    """Verify one normalized descriptor in a single short read snapshot."""

    if not isinstance(engine, CatalogEngine) or not isinstance(reference, ArtifactReference):
        raise LiteratureArtifactCatalogError()
    if asset_id is not None and not isinstance(asset_id, AssetId):
        raise LiteratureArtifactCatalogError()

    expected = (
        reference.path.root,
        reference.sha256.root,
        reference.byte_size,
        reference.media_type,
    )
    try:
        with engine.read_snapshot() as connection:
            artifact_rows = connection.execute(
                "SELECT relative_path,sha256,byte_size,media_type "
                "FROM artifact_objects WHERE relative_path=?",
                (reference.path.root,),
            ).fetchall()
            if len(artifact_rows) != 1 or tuple(artifact_rows[0]) != expected:
                raise LiteratureArtifactCatalogError()
            if asset_id is not None:
                asset_rows = connection.execute(
                    "SELECT relative_path,sha256,size_bytes,media_type "
                    "FROM assets WHERE asset_id=?",
                    (asset_id.root,),
                ).fetchall()
                if len(asset_rows) != 1 or tuple(asset_rows[0]) != expected:
                    raise LiteratureArtifactCatalogError()
    except LiteratureArtifactCatalogError:
        raise
    except sqlite3.Error:
        raise LiteratureArtifactCatalogError() from None
    except Exception:
        raise LiteratureArtifactCatalogError() from None
