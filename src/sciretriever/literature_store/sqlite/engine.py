from __future__ import annotations

from collections.abc import Callable
from contextlib import AbstractContextManager, suppress
import hashlib
import os
import sqlite3
from typing import Final
from types import TracebackType
from uuid import uuid4

from sciretriever.literature_store.filesystem import (
    AdvisoryLock,
    CanonicalCatalogPath,
    FilesystemSafetyError,
    canonical_catalog_path,
    verify_catalog_entry,
)
from sciretriever.literature_store.sqlite.bootstrap import recover_bootstrap_temps
from sciretriever.bibliography.api import metadata_snapshot_sha256
from sciretriever.literature_store.sqlite.schema import SCHEMA_FINGERPRINT, SCHEMA_MANIFEST
from sciretriever.literature_store.sqlite.schema_validation import (
    EXPECTED_SCHEMA_OBJECTS,
    schema_objects,
)
from sciretriever.kernel import CanonicalJsonObject, canonical_json_bytes, parse_canonical_json


DEFAULT_BUSY_TIMEOUT_MS: Final = 5_000


class UnsupportedCatalogError(Exception):
    __slots__ = ("reason",)

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)

    def __str__(self) -> str:
        return self.reason


class MetadataSnapshotComponentError(ValueError):
    pass


class CatalogConnection(AbstractContextManager[sqlite3.Connection]):
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def __enter__(self) -> sqlite3.Connection:
        return self._connection

    def __exit__(self, exc_type: type[BaseException] | None, exc_value: BaseException | None, traceback: TracebackType | None) -> None:
        self._connection.close()


def _uri(scope: CanonicalCatalogPath, mode: str, *, immutable: bool = False) -> str:
    immutable_option = "&immutable=1" if immutable else ""
    return f"file:{scope.path.as_posix()}?mode={mode}{immutable_option}"


def _canonicalize_json(payload: str) -> str:
    return canonical_json_bytes(parse_canonical_json(payload)).decode("ascii")


def _sha256_text(payload: str) -> str:
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _metadata_sha256(revision: int, values_json: str, provenance_json: str) -> str:
    values = parse_canonical_json(values_json)
    provenance = parse_canonical_json(provenance_json)
    if not isinstance(values, CanonicalJsonObject) or not isinstance(provenance, CanonicalJsonObject):
        raise MetadataSnapshotComponentError("metadata snapshot components must be JSON objects")
    return str(metadata_snapshot_sha256(revision, values, provenance))


def _configure(connection: sqlite3.Connection, timeout_ms: int) -> None:
    connection.create_function(
        "sciretriever_canonical_json", 1, _canonicalize_json, deterministic=True
    )
    connection.create_function("sciretriever_sha256", 1, _sha256_text, deterministic=True)
    connection.create_function(
        "sciretriever_metadata_sha256", 3, _metadata_sha256, deterministic=True,
    )
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute(f"PRAGMA busy_timeout={timeout_ms}")


def _read_only_connection(
    scope: CanonicalCatalogPath, timeout_ms: int, *, immutable: bool
) -> sqlite3.Connection:
    verify_catalog_entry(scope)
    connection = sqlite3.connect(
        _uri(scope, "ro", immutable=immutable), uri=True, timeout=timeout_ms / 1000
    )
    try:
        verify_catalog_entry(scope)
        _configure(connection, timeout_ms)
        connection.execute("PRAGMA query_only=ON")
    except (FilesystemSafetyError, sqlite3.Error):
        connection.close()
        raise
    return connection


def _validate(connection: sqlite3.Connection) -> None:
    try:
        marker = connection.execute(
            "SELECT product,schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1"
        ).fetchone()
        integrity = connection.execute("PRAGMA integrity_check").fetchone()
        foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
        actual_schema = schema_objects(connection)
        semantic_mismatches = connection.execute(
            "SELECT "
            "(SELECT count(*) FROM metadata_snapshots WHERE sha256<>sciretriever_metadata_sha256(revision,values_json,provenance_json)) + "
            "(SELECT count(*) FROM light_documents d LEFT JOIN artifacts a ON a.id=d.artifact_id WHERE d.sha256<>sciretriever_sha256(sciretriever_canonical_json(d.document_json)) OR a.kind<>'light-document' OR a.sha256<>d.sha256 OR a.byte_size<>length(CAST(sciretriever_canonical_json(d.document_json) AS BLOB))) + "
            "(SELECT count(*) FROM analysis_artifacts d LEFT JOIN artifacts a ON a.id=d.artifact_id WHERE d.sha256<>sciretriever_sha256(sciretriever_canonical_json(d.proposal_json)) OR a.kind<>'analysis' OR a.sha256<>d.sha256 OR a.byte_size<>length(CAST(sciretriever_canonical_json(d.proposal_json) AS BLOB)))"
        ).fetchone()
    except sqlite3.DatabaseError as error:
        raise UnsupportedCatalogError("catalog is not a supported SciRetriever schema") from error
    if marker != ("sciretriever", 2, SCHEMA_FINGERPRINT):
        raise UnsupportedCatalogError("catalog schema marker or fingerprint is unsupported")
    if actual_schema != EXPECTED_SCHEMA_OBJECTS:
        raise UnsupportedCatalogError("catalog objects do not match the target schema manifest")
    if integrity != ("ok",) or foreign_keys or semantic_mismatches != (0,):
        raise UnsupportedCatalogError("catalog integrity validation failed")


def _scope(path: str | os.PathLike[str], *, require_unique: bool = True) -> CanonicalCatalogPath:
    try:
        return canonical_catalog_path(path, require_unique=require_unique)
    except FilesystemSafetyError as error:
        raise UnsupportedCatalogError(str(error)) from error


def _validate_path(
    path: str | os.PathLike[str], timeout_ms: int, *, require_unique: bool
) -> None:
    scope = _scope(path, require_unique=require_unique)
    if not scope.path.exists():
        raise FileNotFoundError(scope.path)
    connection = _read_only_connection(scope, timeout_ms, immutable=True)
    try:
        _validate(connection)
    finally:
        connection.close()


def validate_catalog(
    path: str | os.PathLike[str], *, busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS
) -> None:
    _validate_path(path, busy_timeout_ms, require_unique=True)


def open_read_only_snapshot(
    path: str | os.PathLike[str], *, busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS
) -> CatalogConnection:
    validate_catalog(path, busy_timeout_ms=busy_timeout_ms)
    scope = _scope(path)
    connection = _read_only_connection(scope, busy_timeout_ms, immutable=False)
    try:
        _validate(connection)
    except UnsupportedCatalogError:
        connection.close()
        raise
    return CatalogConnection(connection)


def _writable_connection(scope: CanonicalCatalogPath, timeout_ms: int) -> sqlite3.Connection:
    verify_catalog_entry(scope)
    connection = sqlite3.connect(_uri(scope, "rw"), uri=True, timeout=timeout_ms / 1000)
    try:
        verify_catalog_entry(scope)
        _configure(connection, timeout_ms)
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA journal_mode=WAL")
    except (FilesystemSafetyError, sqlite3.Error):
        connection.close()
        raise
    return connection


def _initialize_temporary(scope: CanonicalCatalogPath, temporary_name: str) -> None:
    temporary = scope.parent / temporary_name
    descriptor = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    os.close(descriptor)
    connection = sqlite3.connect(temporary)
    try:
        _configure(connection, DEFAULT_BUSY_TIMEOUT_MS)
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("BEGIN IMMEDIATE")
        for statement in SCHEMA_MANIFEST:
            connection.execute(statement)
        connection.execute(
            "INSERT INTO schema_identity(singleton,product,schema_version,schema_fingerprint) VALUES (1,'sciretriever',2,?)",
            (SCHEMA_FINGERPRINT,),
        )
        connection.commit()
        _validate(connection)
    finally:
        connection.close()
    descriptor = os.open(temporary, os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _publish(
    scope: CanonicalCatalogPath,
    temporary_name: str,
    checkpoint: Callable[[str], None] | None,
) -> bool:
    parent = os.open(scope.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        try:
            os.link(temporary_name, scope.basename, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        except FileExistsError:
            return False
        if checkpoint is not None:
            checkpoint("after-publication")
        os.fsync(parent)
        return True
    finally:
        os.close(parent)


def _create(
    scope: CanonicalCatalogPath, checkpoint: Callable[[str], None] | None
) -> None:
    temporary_name = f".{scope.basename}.bootstrap-{uuid4()}.tmp"
    try:
        _initialize_temporary(scope, temporary_name)
        if checkpoint is not None:
            checkpoint("after-temporary-fsync")
        published = _publish(scope, temporary_name, checkpoint)
        if not published:
            with open_read_only_snapshot(scope.path):
                pass
    finally:
        with suppress(FileNotFoundError):
            os.unlink(scope.parent / temporary_name)


def create_or_open_catalog(
    path: str | os.PathLike[str],
    *,
    busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS,
    checkpoint: Callable[[str], None] | None = None,
) -> CatalogConnection:
    try:
        scope = canonical_catalog_path(path, require_unique=False)
    except FilesystemSafetyError as error:
        raise UnsupportedCatalogError(str(error)) from error
    with AdvisoryLock(scope, "catalog-bootstrap").acquire():
        def valid_bootstrap(candidate: str) -> bool:
            try:
                _validate_path(candidate, busy_timeout_ms, require_unique=False)
            except (FileNotFoundError, UnsupportedCatalogError, FilesystemSafetyError):
                return False
            return True

        recover_bootstrap_temps(scope, valid_bootstrap)
        if scope.path.exists():
            validate_catalog(scope.path, busy_timeout_ms=busy_timeout_ms)
        else:
            _create(scope, checkpoint)
        refreshed = canonical_catalog_path(scope.path)
        try:
            connection = _writable_connection(refreshed, busy_timeout_ms)
        except FilesystemSafetyError as error:
            raise UnsupportedCatalogError(str(error)) from error
        try:
            _validate(connection)
        except UnsupportedCatalogError:
            connection.close()
            raise
        return CatalogConnection(connection)
