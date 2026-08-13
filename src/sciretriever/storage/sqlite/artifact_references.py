"""Read and retire the complete set of formal artifact references.

This adapter is deliberately the only reconciliation component that knows
SQLite.  ``artifact_objects`` is a technical registry, not a formal business
reference: an object is retained only while at least one of the five frozen
reference faces below names its exact descriptor.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from sciretriever.model.primitives import RelativeArtifactPath, Sha256
from sciretriever.storage.files.paths import StoragePathError, content_addressed_reference

from .engine import CatalogEngine, CatalogError

_REFERENCE_SOURCES: Final[frozenset[str]] = frozenset(
    {
        "assets.relative_path",
        "parser_results.markdown_artifact_path",
        "parser_result_resources.artifact_path",
        "literature_contents.structured_artifact_path",
        "literature_contents.markdown_artifact_path",
    }
)

_OBJECT_COLUMNS: Final[str] = "artifact_id,sha256,byte_size,media_type,relative_path"

_REFERENCE_QUERY: Final[str] = (
    "SELECT 'assets.relative_path',relative_path,sha256,size_bytes,media_type FROM assets "
    "UNION ALL "
    "SELECT 'parser_results.markdown_artifact_path',markdown_artifact_path,markdown_sha256,"
    "markdown_byte_size,markdown_media_type FROM parser_results "
    "UNION ALL "
    "SELECT 'parser_result_resources.artifact_path',artifact_path,artifact_sha256,"
    "artifact_byte_size,artifact_media_type FROM parser_result_resources "
    "UNION ALL "
    "SELECT 'literature_contents.structured_artifact_path',structured_artifact_path,"
    "structured_artifact_sha256,structured_artifact_byte_size,"
    "structured_artifact_media_type FROM literature_contents "
    "UNION ALL "
    "SELECT 'literature_contents.markdown_artifact_path',markdown_artifact_path,"
    "markdown_artifact_sha256,markdown_artifact_byte_size,markdown_artifact_media_type "
    "FROM literature_contents ORDER BY 1,2"
)

_REFERENCED_QUERY: Final[str] = (
    "SELECT "
    "EXISTS(SELECT 1 FROM assets WHERE relative_path=?) OR "
    "EXISTS(SELECT 1 FROM parser_results WHERE markdown_artifact_path=?) OR "
    "EXISTS(SELECT 1 FROM parser_result_resources WHERE artifact_path=?) OR "
    "EXISTS(SELECT 1 FROM literature_contents WHERE structured_artifact_path=? "
    "OR markdown_artifact_path=?)"
)


class ArtifactReferenceStoreError(RuntimeError):
    """Stable, path-free reconciliation failure at the Catalog boundary."""

    _MESSAGE = "artifact reference catalog operation failed"

    def __init__(self, _message: object | None = None) -> None:
        del _message
        super().__init__(self._MESSAGE)


class ArtifactReferenceStoreIntegrityError(ArtifactReferenceStoreError):
    """The Catalog contains a non-canonical or internally conflicting fact."""

    _MESSAGE = "artifact reference catalog integrity check failed"


@dataclass(frozen=True, slots=True)
class CatalogArtifactObject:
    """One exact technical object row, without any business ownership."""

    artifact_id: str
    path: RelativeArtifactPath
    sha256: Sha256
    byte_size: int
    media_type: str


@dataclass(frozen=True, slots=True)
class FormalArtifactReference:
    """One row from one of the five frozen formal artifact reference faces."""

    source: str
    path: RelativeArtifactPath
    sha256: Sha256
    byte_size: int
    media_type: str


@dataclass(frozen=True, slots=True)
class ArtifactReferenceSnapshot:
    """A single read-only snapshot of technical objects and formal uses."""

    objects: tuple[CatalogArtifactObject, ...]
    references: tuple[FormalArtifactReference, ...]

    @property
    def referenced_paths(self) -> frozenset[RelativeArtifactPath]:
        return frozenset(reference.path for reference in self.references)


def _integrity_failure() -> ArtifactReferenceStoreIntegrityError:
    return ArtifactReferenceStoreIntegrityError()


def _identifier(value: object) -> str:
    if type(value) is not str:
        raise _integrity_failure()
    result = value.strip()
    if (
        not result
        or result != value
        or any(ord(character) < 32 or ord(character) == 127 for character in result)
    ):
        raise _integrity_failure()
    return result


def _media_type(value: object) -> str:
    if type(value) is not str:
        raise _integrity_failure()
    result = value.strip()
    if (
        not result
        or result != value
        or any(ord(character) < 32 or ord(character) == 127 for character in result)
    ):
        raise _integrity_failure()
    return result


def _descriptor(
    path_value: object,
    sha_value: object,
    size_value: object,
    media_value: object,
) -> tuple[RelativeArtifactPath, Sha256, int, str]:
    if type(path_value) is not str or type(sha_value) is not str:
        raise _integrity_failure()
    if type(size_value) is not int or size_value <= 0:
        raise _integrity_failure()
    try:
        path = RelativeArtifactPath(path_value)
        digest = Sha256(sha_value)
        canonical = content_addressed_reference(digest, size_value)
    except (StoragePathError, TypeError, ValueError) as error:
        raise _integrity_failure() from error
    if path != canonical:
        raise _integrity_failure()
    return path, digest, size_value, _media_type(media_value)


def _object(row: tuple[object, ...]) -> CatalogArtifactObject:
    if len(row) != 5:
        raise _integrity_failure()
    path, digest, size, media_type = _descriptor(row[4], row[1], row[2], row[3])
    return CatalogArtifactObject(
        artifact_id=_identifier(row[0]),
        path=path,
        sha256=digest,
        byte_size=size,
        media_type=media_type,
    )


def _reference(row: tuple[object, ...]) -> FormalArtifactReference:
    if len(row) != 5 or type(row[0]) is not str or row[0] not in _REFERENCE_SOURCES:
        raise _integrity_failure()
    path, digest, size, media_type = _descriptor(row[1], row[2], row[3], row[4])
    return FormalArtifactReference(
        source=row[0],
        path=path,
        sha256=digest,
        byte_size=size,
        media_type=media_type,
    )


def _object_values(value: CatalogArtifactObject) -> tuple[object, ...]:
    if not isinstance(value, CatalogArtifactObject):
        raise TypeError("artifact must be a CatalogArtifactObject")
    canonical = _object(
        (
            value.artifact_id,
            value.sha256.root,
            value.byte_size,
            value.media_type,
            value.path.root,
        )
    )
    return (
        canonical.artifact_id,
        canonical.sha256.root,
        canonical.byte_size,
        canonical.media_type,
        canonical.path.root,
    )


def _is_referenced(connection: sqlite3.Connection, path: str) -> bool:
    row = connection.execute(_REFERENCED_QUERY, (path, path, path, path, path)).fetchone()
    if row is None or len(row) != 1 or type(row[0]) is not int or row[0] not in {0, 1}:
        raise _integrity_failure()
    return bool(row[0])


def _validated_snapshot(connection: sqlite3.Connection) -> ArtifactReferenceSnapshot:
    object_rows = connection.execute(
        f"SELECT {_OBJECT_COLUMNS} FROM artifact_objects ORDER BY relative_path"
    ).fetchall()
    reference_rows = connection.execute(_REFERENCE_QUERY).fetchall()
    objects = tuple(_object(tuple(row)) for row in object_rows)
    references = tuple(_reference(tuple(row)) for row in reference_rows)
    by_path = {item.path: item for item in objects}
    if len(by_path) != len(objects):
        raise _integrity_failure()
    for reference in references:
        owner = by_path.get(reference.path)
        if owner is None or (
            owner.sha256,
            owner.byte_size,
            owner.media_type,
        ) != (
            reference.sha256,
            reference.byte_size,
            reference.media_type,
        ):
            raise _integrity_failure()
    return ArtifactReferenceSnapshot(objects=objects, references=references)


class SqliteArtifactReferenceStore:
    """Catalog half of fail-closed ArtifactStore reconciliation."""

    __slots__ = ("_engine",)

    def __init__(self, engine: CatalogEngine) -> None:
        if not isinstance(engine, CatalogEngine):
            raise TypeError("engine must be a CatalogEngine")
        self._engine = engine

    @property
    def catalog_path(self) -> Path:
        return self._engine.catalog_path

    def snapshot(self) -> ArtifactReferenceSnapshot:
        """Read and cross-check all objects and all five reference faces."""

        try:
            with self._engine.read_snapshot() as connection:
                return _validated_snapshot(connection)
        except ArtifactReferenceStoreError:
            raise
        except (CatalogError, sqlite3.Error, TypeError, ValueError) as error:
            raise ArtifactReferenceStoreError() from error

    def retire_if_unreferenced(self, artifact: CatalogArtifactObject) -> bool:
        """Delete one exact technical row after a transaction-local recheck.

        ``False`` means that the row disappeared or acquired a formal
        reference and therefore must be preserved by the filesystem caller.
        """

        values = _object_values(artifact)
        try:
            with self._engine.write_transaction() as connection:
                row = connection.execute(
                    f"SELECT {_OBJECT_COLUMNS} FROM artifact_objects WHERE relative_path=?",
                    (artifact.path.root,),
                ).fetchone()
                if row is None:
                    return False
                if tuple(row) != values:
                    raise _integrity_failure()
                if _is_referenced(connection, artifact.path.root):
                    return False
                cursor = connection.execute(
                    "DELETE FROM artifact_objects WHERE artifact_id=? AND sha256=? "
                    "AND byte_size=? AND media_type=? AND relative_path=?",
                    values,
                )
                if cursor.rowcount != 1:
                    raise _integrity_failure()
                return True
        except ArtifactReferenceStoreError:
            raise
        except (CatalogError, sqlite3.Error, TypeError, ValueError) as error:
            raise ArtifactReferenceStoreError() from error

    def confirm_filesystem_only(
        self,
        path: RelativeArtifactPath,
        sha256: Sha256,
        byte_size: int,
    ) -> bool:
        """Recheck immediately before unlink that no Catalog fact names bytes.

        Both the canonical path and ``(sha256, byte_size)`` are checked.  They
        denote the same content address in the target schema, but checking
        both fails closed if either unique identity surface is ever damaged.
        """

        try:
            canonical = content_addressed_reference(sha256, byte_size)
        except (StoragePathError, TypeError, ValueError) as error:
            raise _integrity_failure() from error
        if not isinstance(path, RelativeArtifactPath) or path != canonical:
            raise _integrity_failure()
        try:
            with self._engine.read_snapshot() as connection:
                object_row = connection.execute(
                    "SELECT 1 FROM artifact_objects WHERE relative_path=? OR "
                    "(sha256=? AND byte_size=?) LIMIT 1",
                    (path.root, sha256.root, byte_size),
                ).fetchone()
                if object_row is not None or _is_referenced(connection, path.root):
                    return False
                return True
        except ArtifactReferenceStoreError:
            raise
        except (CatalogError, sqlite3.Error, TypeError, ValueError) as error:
            raise ArtifactReferenceStoreError() from error


__all__ = (
    "ArtifactReferenceSnapshot",
    "ArtifactReferenceStoreError",
    "ArtifactReferenceStoreIntegrityError",
    "CatalogArtifactObject",
    "FormalArtifactReference",
    "SqliteArtifactReferenceStore",
)
