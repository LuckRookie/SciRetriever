"""Technical helpers for the shared artifact and provenance tables.

This module records facts that have already crossed the filesystem
publication boundary.  It does not inspect bytes, assign business ownership,
publish files, or build an Asset/Literature relation.  A caller supplies a
verified filesystem lease and a public seven-field :class:`Provenance`;
replays are accepted only when every stored scalar is identical.
"""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from typing import TypeAlias, cast

from sciretriever.model.primitives import (
    ProvenanceId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.storage.files.reader import VerifiedArtifactLease, VerifiedReaderError

from .engine import CatalogEngine

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_HEX = re.compile(r"^[0-9a-f]{64}$", re.ASCII)
_IDENTITY = re.compile(r"^[^/\\?#:@\x00-\x1f\x7f]+$", re.ASCII)


CatalogTarget: TypeAlias = CatalogEngine


class ArtifactCatalogError(RuntimeError):
    """Stable, path-free error at the shared table boundary."""

    _DEFAULT_MESSAGE = "artifact catalog operation failed"

    def __init__(self, _message: object | None = None) -> None:
        super().__init__(self._DEFAULT_MESSAGE)


class ArtifactCatalogConflictError(ArtifactCatalogError):
    """An identity/path/hash/size/media or provenance replay conflicts."""

    _DEFAULT_MESSAGE = "artifact catalog identity conflicts"


class ArtifactCatalogIntegrityError(ArtifactCatalogError):
    """A caller supplied value is not a canonical technical fact."""

    _DEFAULT_MESSAGE = "artifact catalog identity is invalid"


@dataclass(frozen=True, slots=True)
class ArtifactObject:
    """Neutral row-shaped artifact data; it contains no SQLite type."""

    artifact_id: str
    sha256: Sha256
    byte_size: int
    media_type: str
    relative_path: RelativeArtifactPath


def _artifact_failure() -> ArtifactCatalogIntegrityError:
    return ArtifactCatalogIntegrityError()


def _conflict_failure() -> ArtifactCatalogConflictError:
    return ArtifactCatalogConflictError()


def _text_identity(value: object) -> str:
    root = getattr(value, "root", None)
    candidate = root if isinstance(root, str) else value if isinstance(value, str) else str(value)
    if (
        not isinstance(candidate, str)
        or not candidate.strip()
        or _IDENTITY.fullmatch(candidate) is None
    ):
        raise _artifact_failure()
    return candidate


def _relative_path(value: RelativeArtifactPath | str) -> RelativeArtifactPath:
    try:
        if isinstance(value, RelativeArtifactPath):
            return value
        return RelativeArtifactPath(value)
    except (TypeError, ValueError) as error:
        raise _artifact_failure() from error


def _sha(value: Sha256 | str) -> Sha256:
    try:
        result = value if isinstance(value, Sha256) else Sha256(value)
    except (TypeError, ValueError) as error:
        raise _artifact_failure() from error
    if _HEX.fullmatch(result.root) is None:
        raise _artifact_failure()
    return result


def _media_type(value: str) -> str:
    if type(value) is not str:
        raise _artifact_failure()
    candidate = value.strip()
    if not candidate or _CONTROL.search(candidate) is not None:
        raise _artifact_failure()
    return candidate


def _artifact_values(
    artifact_id: object,
    verified_lease: object,
) -> tuple[ArtifactObject, VerifiedArtifactLease]:
    identifier = _text_identity(artifact_id)
    if not isinstance(verified_lease, VerifiedArtifactLease):
        raise _artifact_failure()
    try:
        path = _relative_path(verified_lease.path)
        digest = _sha(verified_lease.sha256)
        size = verified_lease.byte_size
        kind = verified_lease.media_type
    except (ArtifactCatalogError, VerifiedReaderError, TypeError, ValueError) as error:
        if isinstance(error, ArtifactCatalogError):
            raise
        raise _artifact_failure() from error
    if type(size) is not int or size <= 0:
        raise _artifact_failure()
    return (
        ArtifactObject(
            artifact_id=identifier,
            sha256=digest,
            byte_size=size,
            media_type=_media_type(kind),
            relative_path=path,
        ),
        verified_lease,
    )


def _provenance_values(provenance: Provenance) -> tuple[object, ...]:
    if not isinstance(provenance, Provenance):
        raise _artifact_failure()
    values = (
        str(provenance.provenance_id),
        provenance.source_kind.value,
        provenance.source_name,
        provenance.source_record_id,
        str(provenance.observed_at),
        str(provenance.input_sha256) if provenance.input_sha256 is not None else None,
        str(provenance.parameters_sha256) if provenance.parameters_sha256 is not None else None,
    )
    if _CONTROL.search(values[0]) or _CONTROL.search(values[2]):
        raise _artifact_failure()
    return values


def _run_write(target: CatalogTarget, operation: Callable[[sqlite3.Connection], object]) -> object:
    from .engine import CatalogEngine

    if not isinstance(target, CatalogEngine):
        raise TypeError("target must be a CatalogEngine")
    try:
        with target.write_transaction() as connection:
            return operation(connection)
    except (ArtifactCatalogError, sqlite3.Error):
        raise
    except Exception as error:
        raise ArtifactCatalogError() from error


def _provenance_record(row: tuple[object, ...]) -> Provenance:
    try:
        return Provenance(
            provenance_id=ProvenanceId(cast(str, row[0])),
            source_kind=SourceKind(cast(str, row[1])),
            source_name=cast(str, row[2]),
            source_record_id=cast(str | None, row[3]),
            observed_at=UtcTimestamp(cast(str, row[4])),
            input_sha256=(None if row[5] is None else Sha256(cast(str, row[5]))),
            parameters_sha256=(None if row[6] is None else Sha256(cast(str, row[6]))),
        )
    except (TypeError, ValueError) as error:
        raise ArtifactCatalogError() from error


def _insert_or_verify_provenance(
    connection: sqlite3.Connection, provenance: Provenance
) -> Provenance:
    values = _provenance_values(provenance)
    try:
        row = connection.execute(
            "SELECT provenance_id,source_kind,source_name,source_record_id,observed_at,"
            "input_sha256,parameters_sha256 FROM provenances WHERE provenance_id=?",
            (values[0],),
        ).fetchone()
    except sqlite3.Error as error:
        raise ArtifactCatalogError() from error
    if row is None:
        try:
            connection.execute(
                "INSERT INTO provenances(provenance_id,source_kind,source_name,"
                "source_record_id,observed_at,input_sha256,parameters_sha256) "
                "VALUES (?,?,?,?,?,?,?)",
                values,
            )
        except sqlite3.IntegrityError as error:
            raise _conflict_failure() from error
        except sqlite3.Error as error:
            raise ArtifactCatalogError() from error
        return provenance
    if tuple(row) != values:
        raise _conflict_failure()
    return provenance


def register_provenance(target: CatalogTarget, provenance: Provenance) -> Provenance:
    """Idempotently register one exact public Provenance row."""

    return cast(
        Provenance,
        _run_write(
            target,
            lambda connection: _insert_or_verify_provenance(connection, provenance),
        ),
    )


def _artifact_record(row: tuple[object, ...]) -> ArtifactObject:
    try:
        return ArtifactObject(
            artifact_id=_text_identity(cast(str, row[0])),
            sha256=_sha(cast(str, row[1])),
            byte_size=cast(int, row[2]),
            media_type=_media_type(cast(str, row[3])),
            relative_path=_relative_path(cast(str, row[4])),
        )
    except (ArtifactCatalogError, TypeError, ValueError) as error:
        if isinstance(error, ArtifactCatalogError):
            raise
        raise ArtifactCatalogError() from error


def _insert_or_verify_artifact(
    connection: sqlite3.Connection, artifact: ArtifactObject
) -> ArtifactObject:
    values = (
        artifact.artifact_id,
        artifact.sha256.root,
        artifact.byte_size,
        artifact.media_type,
        artifact.relative_path.root,
    )
    columns = "artifact_id,sha256,byte_size,media_type,relative_path"
    try:
        existing = connection.execute(
            f"SELECT {columns} FROM artifact_objects WHERE artifact_id=?",
            (artifact.artifact_id,),
        ).fetchone()
        if existing is None:
            existing = connection.execute(
                f"SELECT {columns} FROM artifact_objects WHERE sha256=? AND byte_size=?",
                (artifact.sha256.root, artifact.byte_size),
            ).fetchone()
        if existing is None:
            existing = connection.execute(
                f"SELECT {columns} FROM artifact_objects WHERE relative_path=?",
                (artifact.relative_path.root,),
            ).fetchone()
    except sqlite3.Error as error:
        raise ArtifactCatalogError() from error
    if existing is not None:
        if tuple(existing) == values:
            return _artifact_record(tuple(existing))
        raise _conflict_failure()
    try:
        connection.execute(
            "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,"
            "relative_path) VALUES (?,?,?,?,?)",
            values,
        )
    except sqlite3.IntegrityError as error:
        raise _conflict_failure() from error
    except sqlite3.Error as error:
        raise ArtifactCatalogError() from error
    return artifact


def register_artifact(
    target: CatalogTarget,
    artifact_id: object,
    verified_lease: VerifiedArtifactLease,
    provenance: Provenance | None = None,
) -> ArtifactObject:
    """Idempotently register an already-published artifact technical fact.

    Only a lease created by :class:`VerifiedReader` is accepted.  The lease
    has already completed a descriptor hash outside SQLite; it is rehashed
    immediately before the transaction and then performs metadata-only
    identity checks before the transaction commits.  The optional Provenance
    is written in the same short transaction as the artifact row.
    """

    artifact, lease = _artifact_values(artifact_id, verified_lease)
    try:
        # Hashing and the potentially long filesystem read must complete
        # before _run_write starts BEGIN IMMEDIATE.
        lease.prepare_registration()
    except VerifiedReaderError as error:
        raise _artifact_failure() from error

    def operation(connection: sqlite3.Connection) -> ArtifactObject:
        try:
            lease.verify_registration()
            if provenance is not None:
                _insert_or_verify_provenance(connection, provenance)
            result = _insert_or_verify_artifact(connection, artifact)
            # This is the final named-object check immediately before the
            # engine's context manager commits the short transaction.
            lease.verify_registration()
            return result
        except VerifiedReaderError as error:
            raise _artifact_failure() from error

    return cast(ArtifactObject, _run_write(target, operation))


def get_artifact(target: CatalogEngine, artifact_id: object) -> ArtifactObject | None:
    """Read one technical artifact row from a validated snapshot."""

    identifier = _text_identity(artifact_id)
    from .engine import CatalogEngine

    if not isinstance(target, CatalogEngine):
        raise TypeError("target must be a CatalogEngine")
    try:
        with target.read_snapshot() as connection:
            row = connection.execute(
                "SELECT artifact_id,sha256,byte_size,media_type,relative_path "
                "FROM artifact_objects WHERE artifact_id=?",
                (identifier,),
            ).fetchone()
    except (ArtifactCatalogError, sqlite3.Error) as error:
        if isinstance(error, ArtifactCatalogError):
            raise
        raise ArtifactCatalogError() from error
    return None if row is None else _artifact_record(tuple(row))


def get_provenance(target: CatalogEngine, provenance_id: object) -> Provenance | None:
    """Read one public Provenance row from a validated snapshot."""

    identifier = _text_identity(provenance_id)
    from .engine import CatalogEngine

    if not isinstance(target, CatalogEngine):
        raise TypeError("target must be a CatalogEngine")
    try:
        with target.read_snapshot() as connection:
            row = connection.execute(
                "SELECT provenance_id,source_kind,source_name,source_record_id,observed_at,"
                "input_sha256,parameters_sha256 FROM provenances WHERE provenance_id=?",
                (identifier,),
            ).fetchone()
    except (ArtifactCatalogError, sqlite3.Error) as error:
        if isinstance(error, ArtifactCatalogError):
            raise
        raise ArtifactCatalogError() from error
    return None if row is None else _provenance_record(tuple(row))


__all__ = (
    "ArtifactCatalogConflictError",
    "ArtifactCatalogError",
    "ArtifactCatalogIntegrityError",
    "ArtifactObject",
    "get_artifact",
    "get_provenance",
    "register_artifact",
    "register_provenance",
)
