"""Composite file-first publication of one accepted LiteratureContent view.

The structured JSON bytes are published create-if-absent and the already
published Analysis Markdown is re-opened through its immutable descriptor.
Both artifacts receive registration leases and complete hashes before the
short SQLite transaction.  That transaction registers the two technical
artifact facts, rechecks every Literature/content CAS precondition, replaces
metadata/support/content bindings, retires unreferenced old Catalog rows, and
performs one final lease check before commit.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from contextlib import ExitStack
from dataclasses import dataclass
from typing import Final, TypeAlias

from pydantic import ValidationError

from sciretriever.literature.ports import (
    ContentPublicationCommand,
    StalePreconditionError,
)
from sciretriever.model.analysis import ArtifactRef
from sciretriever.model.primitives import LiteratureId, RelativeArtifactPath
from sciretriever.storage.files.paths import StoragePathError, content_addressed_reference
from sciretriever.storage.files.reader import (
    VerifiedArtifactLease,
    VerifiedReader,
    VerifiedReaderError,
)
from sciretriever.storage.files.store import (
    ArtifactReference,
    ArtifactStore,
    ArtifactStoreError,
)

from .engine import CatalogEngine
from .literature_writer import (
    LiteratureWriter,
    LiteratureWriterConflictError,
    LiteratureWriterError,
    LiteratureWriterIntegrityError,
)

ContentPublicationCheckpoint: TypeAlias = Callable[[str], None]

CONTENT_PUBLICATION_FAILPOINTS: Final[tuple[str, ...]] = (
    "after-artifact-publication",
    "after-lease-prepare",
    "after-artifact-registration",
    "after-cas",
    "after-metadata-replacement",
    "after-cleanup",
    "after-binding",
    "after-orphan-catalog-cleanup",
    "before-commit",
)
_FAILPOINT_SET: Final[frozenset[str]] = frozenset(CONTENT_PUBLICATION_FAILPOINTS)


class ContentPublicationError(RuntimeError):
    """An accepted LiteratureContent view could not be published atomically."""

    _MESSAGE = "content publication failed"

    def __init__(self, _message: object | None = None) -> None:
        super().__init__(self._MESSAGE)


class ContentPublicationConflictError(ContentPublicationError):
    """An immutable artifact identity or current binding conflicts."""

    _MESSAGE = "content publication conflicts with current facts"


class ContentPublicationIntegrityError(ContentPublicationError):
    """A staged or stored publication value is not canonical."""

    _MESSAGE = "content publication value is invalid"


@dataclass(frozen=True, slots=True)
class _RetiredContentBinding:
    artifact_paths: tuple[str, ...]
    provenance_id: str


def _publication_checkpoint(
    callback: ContentPublicationCheckpoint | None,
    name: str,
) -> None:
    if name not in _FAILPOINT_SET:
        raise ContentPublicationIntegrityError()
    if callback is None:
        return
    try:
        callback(name)
    except ContentPublicationError:
        raise
    except Exception as error:
        raise ContentPublicationError() from error


def _fresh_publication_error(error: ContentPublicationError) -> ContentPublicationError:
    """Copy only the stable public taxonomy, never a sensitive exception chain."""

    if isinstance(error, ContentPublicationConflictError):
        return ContentPublicationConflictError()
    if isinstance(error, ContentPublicationIntegrityError):
        return ContentPublicationIntegrityError()
    return ContentPublicationError()


class SqliteContentPublication:
    """Implement Literature's sole public current-content publication Port."""

    __slots__ = ("_engine", "_store", "_reader", "_writer", "_failpoint")

    def __init__(
        self,
        engine: object,
        store: object,
        reader: object,
        *,
        failpoint: ContentPublicationCheckpoint | None = None,
    ) -> None:
        if not isinstance(engine, CatalogEngine):
            raise TypeError("engine must be a CatalogEngine")
        if not isinstance(store, ArtifactStore):
            raise TypeError("store must be an ArtifactStore")
        if not isinstance(reader, VerifiedReader):
            raise TypeError("reader must be a VerifiedReader")
        if failpoint is not None and not callable(failpoint):
            raise TypeError("failpoint must be callable")
        self._engine = engine
        self._store = store
        self._reader = reader
        self._failpoint = failpoint
        self._writer = LiteratureWriter(engine, failpoint=self._checkpoint)

    def _checkpoint(self, name: str) -> None:
        _publication_checkpoint(self._failpoint, name)

    def publish_content(self, command: object) -> None:
        """Publish files first, then commit one complete current content view."""

        if not isinstance(command, ContentPublicationCommand):
            raise TypeError("command must be a ContentPublicationCommand")
        failure: ContentPublicationError
        try:
            structured = self._publish_structured(command)
            markdown = self._republish_markdown(command.replacement.content.markdown)
            self._checkpoint("after-artifact-publication")
            with ExitStack() as stack:
                leases = (
                    stack.enter_context(self._reader.acquire(structured)),
                    stack.enter_context(self._reader.acquire(markdown)),
                )
                for lease in leases:
                    lease.prepare_registration()
                self._checkpoint("after-lease-prepare")
                self._commit(command, leases)
        except StalePreconditionError:
            raise
        except ContentPublicationError as error:
            failure = _fresh_publication_error(error)
        except (sqlite3.IntegrityError, LiteratureWriterConflictError):
            failure = ContentPublicationConflictError()
        except LiteratureWriterIntegrityError:
            failure = ContentPublicationIntegrityError()
        except (
            ArtifactStoreError,
            LiteratureWriterError,
            StoragePathError,
            ValidationError,
            VerifiedReaderError,
            sqlite3.Error,
            TypeError,
            ValueError,
        ):
            failure = ContentPublicationError()
        except Exception:
            failure = ContentPublicationError()
        else:
            return
        # Raise after leaving the handler so Python cannot attach the caught
        # filesystem/SQLite/stream exception as ``__context__``.
        raise failure

    def _publish_structured(
        self,
        command: ContentPublicationCommand,
    ) -> ArtifactReference:
        descriptor = command.structured_artifact
        try:
            with command.structured_content.open() as stream:
                reference = self._store.publish(
                    stream,
                    sha256=descriptor.sha256,
                    byte_size=descriptor.byte_size,
                    media_type=descriptor.media_type,
                )
        except ContentPublicationError:
            raise
        except Exception as error:
            raise ContentPublicationError() from error
        _require_reference(reference, descriptor)
        return reference

    def _republish_markdown(self, descriptor: ArtifactRef) -> ArtifactReference:
        path = content_addressed_reference(descriptor.sha256, descriptor.byte_size)
        try:
            with self._reader.open(
                path,
                sha256=descriptor.sha256,
                byte_size=descriptor.byte_size,
                media_type=descriptor.media_type,
            ) as stream:
                reference = self._store.publish(
                    stream,
                    sha256=descriptor.sha256,
                    byte_size=descriptor.byte_size,
                    media_type=descriptor.media_type,
                )
        except ContentPublicationError:
            raise
        except Exception as error:
            raise ContentPublicationError() from error
        _require_reference(reference, descriptor)
        return reference

    def _commit(
        self,
        command: ContentPublicationCommand,
        leases: tuple[VerifiedArtifactLease, VerifiedArtifactLease],
    ) -> None:
        try:
            with self._engine.write_transaction() as connection:
                _verify_leases(leases)
                for lease in leases:
                    _resolve_artifact(connection, lease)
                self._checkpoint("after-artifact-registration")

                retired = _retired_binding(
                    connection,
                    command.replacement.literature_id,
                )
                self._writer.apply_content_transaction(connection, command)

                if retired is not None:
                    _retire_unreferenced_catalog_rows(connection, retired)
                self._checkpoint("after-orphan-catalog-cleanup")

                _verify_leases(leases)
                self._checkpoint("before-commit")
                # Keep the final named-object check after the last callback
                # and inside the transaction so mutation rolls back all rows.
                _verify_leases(leases)
        except (ContentPublicationError, StalePreconditionError):
            raise
        except sqlite3.IntegrityError as error:
            raise ContentPublicationConflictError() from error
        except LiteratureWriterConflictError as error:
            raise ContentPublicationConflictError() from error
        except LiteratureWriterIntegrityError as error:
            raise ContentPublicationIntegrityError() from error
        except (LiteratureWriterError, VerifiedReaderError, sqlite3.Error) as error:
            raise ContentPublicationError() from error


def _require_reference(reference: ArtifactReference, descriptor: ArtifactRef) -> None:
    if (
        reference.sha256 != descriptor.sha256
        or reference.byte_size != descriptor.byte_size
        or reference.media_type != descriptor.media_type
        or reference.path != content_addressed_reference(descriptor.sha256, descriptor.byte_size)
    ):
        raise ContentPublicationIntegrityError()


def _verify_leases(
    leases: tuple[VerifiedArtifactLease, VerifiedArtifactLease],
) -> None:
    for lease in leases:
        lease.verify_registration()


def _canonical_lease_path(lease: VerifiedArtifactLease) -> RelativeArtifactPath:
    try:
        path = content_addressed_reference(lease.sha256, lease.byte_size)
    except (StoragePathError, TypeError, ValueError) as error:
        raise ContentPublicationIntegrityError() from error
    if path != lease.path:
        raise ContentPublicationIntegrityError()
    return path


def _resolve_artifact(
    connection: sqlite3.Connection,
    lease: VerifiedArtifactLease,
) -> None:
    path = _canonical_lease_path(lease)
    artifact_id = f"literature-artifact-{lease.sha256.root}-{lease.byte_size}"
    expected_descriptor = (
        lease.sha256.root,
        lease.byte_size,
        lease.media_type,
        path.root,
    )
    columns = "artifact_id,sha256,byte_size,media_type,relative_path"
    by_id = connection.execute(
        f"SELECT {columns} FROM artifact_objects WHERE artifact_id=?",
        (artifact_id,),
    ).fetchone()
    by_hash = connection.execute(
        f"SELECT {columns} FROM artifact_objects WHERE sha256=? AND byte_size=?",
        (lease.sha256.root, lease.byte_size),
    ).fetchone()
    by_path = connection.execute(
        f"SELECT {columns} FROM artifact_objects WHERE relative_path=?",
        (path.root,),
    ).fetchone()
    if by_id is not None and tuple(by_id)[1:] != expected_descriptor:
        raise ContentPublicationConflictError()
    natural = [tuple(row) for row in (by_hash, by_path) if row is not None]
    if natural:
        actual = natural[0]
        if any(row != actual for row in natural) or actual[1:] != expected_descriptor:
            raise ContentPublicationConflictError()
        if by_id is not None and tuple(by_id) != actual:
            raise ContentPublicationConflictError()
        return
    if by_id is not None:
        raise ContentPublicationIntegrityError()
    connection.execute(
        "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) "
        "VALUES(?,?,?,?,?)",
        (artifact_id, *expected_descriptor),
    )


def _retired_binding(
    connection: sqlite3.Connection,
    literature_id: LiteratureId,
) -> _RetiredContentBinding | None:
    row = connection.execute(
        "SELECT structured_artifact_path,markdown_artifact_path,analysis_provenance_id "
        "FROM literature_contents WHERE literature_id=?",
        (literature_id.root,),
    ).fetchone()
    if row is None:
        return None
    return _RetiredContentBinding(
        artifact_paths=tuple(sorted({str(row[0]), str(row[1])})),
        provenance_id=str(row[2]),
    )


def _artifact_is_referenced(connection: sqlite3.Connection, path: str) -> bool:
    row = connection.execute(
        "SELECT "
        "EXISTS(SELECT 1 FROM assets WHERE relative_path=?) OR "
        "EXISTS(SELECT 1 FROM parser_results WHERE markdown_artifact_path=?) OR "
        "EXISTS(SELECT 1 FROM parser_result_resources WHERE artifact_path=?) OR "
        "EXISTS(SELECT 1 FROM literature_contents WHERE structured_artifact_path=? "
        "OR markdown_artifact_path=?)",
        (path, path, path, path, path),
    ).fetchone()
    if row is None or type(row[0]) is not int or row[0] not in {0, 1}:
        raise ContentPublicationIntegrityError()
    return bool(row[0])


def _provenance_is_referenced(connection: sqlite3.Connection, provenance_id: str) -> bool:
    row = connection.execute(
        "SELECT "
        "EXISTS(SELECT 1 FROM metadata_observations WHERE provenance_id=?) OR "
        "EXISTS(SELECT 1 FROM provider_relation_observations WHERE provenance_id=?) OR "
        "EXISTS(SELECT 1 FROM literature_assets WHERE provenance_id=?) OR "
        "EXISTS(SELECT 1 FROM parser_results WHERE provenance_id=?) OR "
        "EXISTS(SELECT 1 FROM literature_contents WHERE analysis_provenance_id=?)",
        (provenance_id,) * 5,
    ).fetchone()
    if row is None or type(row[0]) is not int or row[0] not in {0, 1}:
        raise ContentPublicationIntegrityError()
    return bool(row[0])


def _retire_unreferenced_catalog_rows(
    connection: sqlite3.Connection,
    retired: _RetiredContentBinding,
) -> None:
    for path in retired.artifact_paths:
        if _artifact_is_referenced(connection, path):
            continue
        connection.execute(
            "DELETE FROM artifact_objects WHERE relative_path=?",
            (path,),
        )
    if not _provenance_is_referenced(connection, retired.provenance_id):
        connection.execute(
            "DELETE FROM provenances WHERE provenance_id=?",
            (retired.provenance_id,),
        )


__all__ = (
    "CONTENT_PUBLICATION_FAILPOINTS",
    "ContentPublicationConflictError",
    "ContentPublicationError",
    "ContentPublicationIntegrityError",
    "SqliteContentPublication",
)
