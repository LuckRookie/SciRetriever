from __future__ import annotations

import os

from sciretriever.infrastructure.storage.sqlite.engine import open_read_only_snapshot
from sciretriever.model.primitives import RelativeArtifactPath


class SqliteArtifactReferenceReader:
    def __init__(self, catalog_path: str | os.PathLike[str]) -> None:
        self._catalog_path = catalog_path

    def referenced_artifact_paths(self) -> tuple[RelativeArtifactPath, ...]:
        with open_read_only_snapshot(self._catalog_path) as connection:
            rows = connection.execute("SELECT storage_path FROM artifacts").fetchall()
        return tuple(RelativeArtifactPath(row[0]) for row in rows)


__all__ = ("SqliteArtifactReferenceReader",)
