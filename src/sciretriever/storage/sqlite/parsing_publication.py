"""File-first, stale-CAS publication of one current ParserResult.

All staged Markdown/resources are published and verified before the short
SQLite write transaction begins.  The transaction registers their technical
descriptors, rechecks the current primary Asset ID/hash, and switches the
single ParserResult row plus its complete resource closure.  A failed file
publication, stale comparison, failpoint, or SQLite commit can therefore
leave only unreferenced content-addressed bytes; it cannot expose a partial
new Catalog result.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from contextlib import ExitStack
from dataclasses import dataclass
from typing import Final, TypeAlias, cast

from pydantic import ValidationError

from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserResource,
    ParserResult,
)
from sciretriever.model.primitives import (
    AssetId,
    ProvenanceId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.parsing.ports import ParserResultPublicationCommand
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

from .artifacts import ArtifactObject, _insert_or_verify_provenance
from .engine import CatalogEngine

ParserResultPublicationCheckpoint: TypeAlias = Callable[[str], None]


class ParserResultPublicationError(RuntimeError):
    """A current ParserResult could not be published as one complete fact."""

    _MESSAGE = "parser result publication failed"

    def __init__(self, _message: object | None = None) -> None:
        super().__init__(self._MESSAGE)


class ParserResultPublicationConflictError(ParserResultPublicationError):
    """The current primary or an immutable stored identity conflicts."""

    _MESSAGE = "parser result publication conflicts with current facts"


class ParserResultPublicationIntegrityError(ParserResultPublicationError):
    """A staged or stored publication value cannot be represented safely."""

    _MESSAGE = "parser result publication value is invalid"


PARSER_RESULT_PUBLICATION_FAILPOINTS: Final[tuple[str, ...]] = (
    "after-markdown-publication",
    "after-resource-publication",
    "after-artifact-publication",
    "after-lease-prepare",
    "after-first-file-check",
    "after-preconditions",
    "after-artifact-registration",
    "after-provenance-registration",
    "after-current-replacement",
    "after-resource-replacement",
    "after-orphan-catalog-cleanup",
    "before-commit",
)
_PUBLICATION_FAILPOINT_SET: Final[frozenset[str]] = frozenset(PARSER_RESULT_PUBLICATION_FAILPOINTS)


def _publication_checkpoint(
    callback: ParserResultPublicationCheckpoint | None,
    name: str,
) -> None:
    if name not in _PUBLICATION_FAILPOINT_SET:
        raise ParserResultPublicationIntegrityError()
    if callback is None:
        return
    try:
        callback(name)
    except ParserResultPublicationError:
        raise
    except Exception as error:
        raise ParserResultPublicationError() from error


@dataclass(frozen=True, slots=True)
class _PublishedParserArtifacts:
    markdown: ArtifactReference
    resources: tuple[ArtifactReference, ...]

    @property
    def ordered(self) -> tuple[ArtifactReference, ...]:
        return (self.markdown, *self.resources)


@dataclass(frozen=True, slots=True)
class _RetiredParserBinding:
    artifact_paths: tuple[str, ...]
    provenance_id: str


class SqliteParserResultPublication:
    """Implement Parsing's one current-result Storage Port."""

    __slots__ = ("_engine", "_store", "_reader", "_failpoint")

    def __init__(
        self,
        engine: CatalogEngine,
        store: ArtifactStore,
        reader: VerifiedReader,
        *,
        failpoint: ParserResultPublicationCheckpoint | None = None,
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

    def _checkpoint(self, name: str) -> None:
        _publication_checkpoint(self._failpoint, name)

    def current_primary_matches(
        self,
        source_asset_id: AssetId,
        source_sha256: Sha256,
    ) -> bool:
        """Return whether the exact Asset/hash is still a current primary PDF."""

        if not isinstance(source_asset_id, AssetId):
            raise TypeError("source_asset_id must be an AssetId")
        if not isinstance(source_sha256, Sha256):
            raise TypeError("source_sha256 must be a Sha256")
        try:
            with self._engine.read_snapshot() as connection:
                return _current_primary_matches(connection, source_asset_id, source_sha256)
        except ParserResultPublicationError:
            raise
        except Exception as error:
            raise ParserResultPublicationError() from error

    def publish_current(self, command: ParserResultPublicationCommand) -> ParserResult:
        """Publish every byte first, then atomically replace the current row."""

        if not isinstance(command, ParserResultPublicationCommand):
            raise TypeError("command must be a ParserResultPublicationCommand")
        try:
            published = self._publish_artifacts(command)
            self._checkpoint("after-artifact-publication")
            with ExitStack() as stack:
                leases = tuple(
                    stack.enter_context(self._reader.acquire(reference))
                    for reference in published.ordered
                )
                for lease in leases:
                    lease.prepare_registration()
                self._checkpoint("after-lease-prepare")
                result = self._commit(command, leases)
        except ParserResultPublicationError:
            raise
        except sqlite3.IntegrityError as error:
            raise ParserResultPublicationConflictError() from error
        except (
            ArtifactStoreError,
            StoragePathError,
            VerifiedReaderError,
            ValidationError,
            sqlite3.Error,
            TypeError,
            ValueError,
        ) as error:
            raise ParserResultPublicationError() from error
        except Exception as error:
            raise ParserResultPublicationError() from error
        if not _same_parser_result_manifest(command.result, result):
            raise ParserResultPublicationIntegrityError()
        return result

    def _publish_artifacts(
        self,
        command: ParserResultPublicationCommand,
    ) -> _PublishedParserArtifacts:
        markdown = _publish_staged(self._store, command.markdown)
        self._checkpoint("after-markdown-publication")
        resources: list[ArtifactReference] = []
        for resource in command.resources:
            resources.append(_publish_staged(self._store, resource.artifact))
            self._checkpoint("after-resource-publication")
        return _PublishedParserArtifacts(
            markdown=markdown,
            resources=tuple(resources),
        )

    def _commit(
        self,
        command: ParserResultPublicationCommand,
        leases: tuple[VerifiedArtifactLease, ...],
    ) -> ParserResult:
        if len(leases) != 1 + len(command.resources):
            raise ParserResultPublicationIntegrityError()
        result: ParserResult | None = None
        try:
            with self._engine.write_transaction() as connection:
                _verify_leases(leases)
                self._checkpoint("after-first-file-check")
                _require_current_primary(connection, command.result)
                self._checkpoint("after-preconditions")

                replay = _existing_canonical_replay(connection, command.result)
                if replay is None:
                    for lease in leases:
                        _resolve_artifact(connection, lease)
                    self._checkpoint("after-artifact-registration")

                    _insert_or_verify_provenance(
                        connection,
                        command.result.provenance.provenance,
                    )
                    self._checkpoint("after-provenance-registration")

                    retired = _replace_current_result(connection, command.result)
                    self._checkpoint("after-current-replacement")
                    _replace_current_resources(connection, command.result)
                    self._checkpoint("after-resource-replacement")

                    if retired is not None:
                        _retire_unreferenced_catalog_rows(connection, retired)
                    self._checkpoint("after-orphan-catalog-cleanup")
                    result = command.result
                else:
                    result = replay

                _verify_leases(leases)
                self._checkpoint("before-commit")
                # A callback may mutate a named object without raising.  Keep
                # the final lease check after the last callback and inside the
                # transaction context so such a mutation rolls the row switch
                # back before the engine commits.
                _verify_leases(leases)
        except ParserResultPublicationError:
            raise
        except sqlite3.IntegrityError as error:
            raise ParserResultPublicationConflictError() from error
        except (VerifiedReaderError, sqlite3.Error) as error:
            raise ParserResultPublicationError() from error
        if result is None:
            raise ParserResultPublicationError()
        return result

    def read_current(self, source_asset_id: AssetId) -> ParserResult | None:
        """Reconstruct the one current parser-neutral result for an Asset."""

        if not isinstance(source_asset_id, AssetId):
            raise TypeError("source_asset_id must be an AssetId")
        try:
            with self._engine.read_snapshot() as connection:
                return _read_current(connection, source_asset_id)
        except ParserResultPublicationError:
            raise
        except (ValidationError, sqlite3.Error, TypeError, ValueError) as error:
            raise ParserResultPublicationIntegrityError() from error
        except Exception as error:
            raise ParserResultPublicationError() from error


def _publish_staged(
    store: ArtifactStore,
    staged: object,
) -> ArtifactReference:
    from sciretriever.parsing.ports import StagedParserArtifact

    if not isinstance(staged, StagedParserArtifact):
        raise ParserResultPublicationIntegrityError()
    descriptor = staged.artifact
    try:
        with staged.content.open() as stream:
            reference = store.publish(
                stream,
                sha256=descriptor.sha256,
                byte_size=descriptor.byte_size,
                media_type=descriptor.media_type,
            )
    except ParserResultPublicationError:
        raise
    except Exception as error:
        raise ParserResultPublicationError() from error
    if (
        reference.sha256 != descriptor.sha256
        or reference.byte_size != descriptor.byte_size
        or reference.media_type != descriptor.media_type
    ):
        raise ParserResultPublicationIntegrityError()
    return reference


def _verify_leases(leases: tuple[VerifiedArtifactLease, ...]) -> None:
    for lease in leases:
        lease.verify_registration()


def _current_primary_matches(
    connection: sqlite3.Connection,
    source_asset_id: AssetId,
    source_sha256: Sha256,
) -> bool:
    row = connection.execute(
        "SELECT EXISTS(SELECT 1 FROM assets a JOIN literature_assets la "
        "ON la.asset_id=a.asset_id WHERE a.asset_id=? AND a.sha256=? "
        "AND a.media_type='application/pdf' AND la.role='primary-pdf')",
        (source_asset_id.root, source_sha256.root),
    ).fetchone()
    if row is None or type(row[0]) is not int or row[0] not in {0, 1}:
        raise ParserResultPublicationIntegrityError()
    return bool(row[0])


def _require_current_primary(
    connection: sqlite3.Connection,
    result: ParserResult,
) -> None:
    if not _current_primary_matches(
        connection,
        result.source_asset_id,
        result.source_sha256,
    ):
        raise ParserResultPublicationConflictError()


def _canonical_lease_path(lease: VerifiedArtifactLease) -> RelativeArtifactPath:
    try:
        path = content_addressed_reference(lease.sha256, lease.byte_size)
    except (StoragePathError, TypeError, ValueError) as error:
        raise ParserResultPublicationIntegrityError() from error
    if path != lease.path:
        raise ParserResultPublicationIntegrityError()
    return path


def _artifact_from_row(row: tuple[object, ...]) -> ArtifactObject:
    try:
        return ArtifactObject(
            artifact_id=str(row[0]),
            sha256=Sha256(str(row[1])),
            byte_size=cast(int, row[2]),
            media_type=str(row[3]),
            relative_path=RelativeArtifactPath(str(row[4])),
        )
    except (TypeError, ValueError) as error:
        raise ParserResultPublicationIntegrityError() from error


def _resolve_artifact(
    connection: sqlite3.Connection,
    lease: VerifiedArtifactLease,
) -> ArtifactObject:
    path = _canonical_lease_path(lease)
    artifact_id = f"parser-artifact-{lease.sha256.root}-{lease.byte_size}"
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
        raise ParserResultPublicationConflictError()
    natural = [tuple(row) for row in (by_hash, by_path) if row is not None]
    if natural:
        actual = natural[0]
        if any(row != actual for row in natural) or actual[1:] != expected_descriptor:
            raise ParserResultPublicationConflictError()
        if by_id is not None and tuple(by_id) != actual:
            raise ParserResultPublicationConflictError()
        return _artifact_from_row(actual)
    if by_id is not None:
        raise ParserResultPublicationIntegrityError()
    connection.execute(
        "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) "
        "VALUES(?,?,?,?,?)",
        (artifact_id, *expected_descriptor),
    )
    return ArtifactObject(
        artifact_id=artifact_id,
        sha256=lease.sha256,
        byte_size=lease.byte_size,
        media_type=lease.media_type,
        relative_path=path,
    )


def _result_values(result: ParserResult) -> tuple[object, ...]:
    markdown_path = content_addressed_reference(
        result.markdown.sha256,
        result.markdown.byte_size,
    ).root
    return (
        result.source_asset_id.root,
        result.source_sha256.root,
        result.result_sha256.root,
        result.page_count,
        markdown_path,
        result.markdown.sha256.root,
        result.markdown.byte_size,
        result.markdown.media_type,
        result.provenance.provenance.provenance_id.root,
        result.provenance.parser_version,
        result.provenance.mode,
        result.provenance.model_identity,
    )


def _resource_values(result: ParserResult) -> tuple[tuple[object, ...], ...]:
    return tuple(
        (
            result.source_asset_id.root,
            ordinal,
            resource.reference,
            content_addressed_reference(
                resource.artifact.sha256,
                resource.artifact.byte_size,
            ).root,
            resource.artifact.sha256.root,
            resource.artifact.byte_size,
            resource.artifact.media_type,
        )
        for ordinal, resource in enumerate(result.resources)
    )


def _manifest_identity(result: ParserResult) -> tuple[object, ...]:
    parser_provenance = result.provenance
    shared = parser_provenance.provenance
    return (
        result.result_sha256,
        result.source_asset_id,
        result.source_sha256,
        result.page_count,
        result.markdown,
        result.resources,
        shared.source_kind,
        shared.source_name,
        shared.source_record_id,
        shared.input_sha256,
        shared.parameters_sha256,
        parser_provenance.parser_version,
        parser_provenance.mode,
        parser_provenance.model_identity,
    )


def _same_parser_result_manifest(first: ParserResult, second: ParserResult) -> bool:
    return _manifest_identity(first) == _manifest_identity(second)


def _existing_canonical_replay(
    connection: sqlite3.Connection,
    offered: ParserResult,
) -> ParserResult | None:
    row = connection.execute(
        "SELECT result_sha256 FROM parser_results WHERE source_asset_id=?",
        (offered.source_asset_id.root,),
    ).fetchone()
    if row is None or str(row[0]) != offered.result_sha256.root:
        return None
    try:
        current = _read_current(connection, offered.source_asset_id)
    except ParserResultPublicationError:
        raise
    except (ValidationError, TypeError, ValueError) as error:
        raise ParserResultPublicationIntegrityError() from error
    if current is None or not _same_parser_result_manifest(offered, current):
        raise ParserResultPublicationIntegrityError()
    return current


def _replace_current_result(
    connection: sqlite3.Connection,
    result: ParserResult,
) -> _RetiredParserBinding | None:
    values = _result_values(result)
    existing_row = connection.execute(
        "SELECT source_asset_id,source_sha256,result_sha256,page_count,markdown_artifact_path,"
        "markdown_sha256,markdown_byte_size,markdown_media_type,provenance_id,parser_version,"
        "mode,model_identity FROM parser_results WHERE source_asset_id=?",
        (result.source_asset_id.root,),
    ).fetchone()
    existing_resources = tuple(
        tuple(row)
        for row in connection.execute(
            "SELECT source_asset_id,ordinal,reference,artifact_path,artifact_sha256,"
            "artifact_byte_size,artifact_media_type FROM parser_result_resources "
            "WHERE source_asset_id=? ORDER BY ordinal",
            (result.source_asset_id.root,),
        ).fetchall()
    )
    expected_resources = _resource_values(result)
    if existing_row is not None and tuple(existing_row) == values:
        if existing_resources != expected_resources:
            raise ParserResultPublicationIntegrityError()
        return None
    if existing_row is not None and str(existing_row[2]) == result.result_sha256.root:
        raise ParserResultPublicationIntegrityError()

    retired = None
    if existing_row is not None:
        retired = _RetiredParserBinding(
            artifact_paths=tuple(
                sorted(
                    {
                        str(existing_row[4]),
                        *(str(row[3]) for row in existing_resources),
                    }
                )
            ),
            provenance_id=str(existing_row[8]),
        )
        connection.execute(
            "DELETE FROM parser_result_resources WHERE source_asset_id=?",
            (result.source_asset_id.root,),
        )
        connection.execute(
            "UPDATE parser_results SET source_sha256=?,result_sha256=?,page_count=?,"
            "markdown_artifact_path=?,markdown_sha256=?,markdown_byte_size=?,"
            "markdown_media_type=?,provenance_id=?,parser_version=?,mode=?,model_identity=? "
            "WHERE source_asset_id=?",
            (*values[1:], result.source_asset_id.root),
        )
    else:
        if existing_resources:
            raise ParserResultPublicationIntegrityError()
        connection.execute(
            "INSERT INTO parser_results(source_asset_id,source_sha256,result_sha256,page_count,"
            "markdown_artifact_path,markdown_sha256,markdown_byte_size,markdown_media_type,"
            "provenance_id,parser_version,mode,model_identity) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            values,
        )
    return retired


def _replace_current_resources(
    connection: sqlite3.Connection,
    result: ParserResult,
) -> None:
    current = tuple(
        tuple(row)
        for row in connection.execute(
            "SELECT source_asset_id,ordinal,reference,artifact_path,artifact_sha256,"
            "artifact_byte_size,artifact_media_type FROM parser_result_resources "
            "WHERE source_asset_id=? ORDER BY ordinal",
            (result.source_asset_id.root,),
        ).fetchall()
    )
    expected = _resource_values(result)
    if current == expected:
        return
    if current:
        raise ParserResultPublicationIntegrityError()
    connection.executemany(
        "INSERT INTO parser_result_resources(source_asset_id,ordinal,reference,artifact_path,"
        "artifact_sha256,artifact_byte_size,artifact_media_type) VALUES(?,?,?,?,?,?,?)",
        expected,
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
        raise ParserResultPublicationIntegrityError()
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
        raise ParserResultPublicationIntegrityError()
    return bool(row[0])


def _retire_unreferenced_catalog_rows(
    connection: sqlite3.Connection,
    retired: _RetiredParserBinding,
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


def _catalog_artifact(
    connection: sqlite3.Connection,
    path_value: object,
    sha_value: object,
    size_value: object,
    media_value: object,
) -> ParserArtifactRef:
    if type(size_value) is not int:
        raise ParserResultPublicationIntegrityError()
    path = RelativeArtifactPath(str(path_value))
    sha256 = Sha256(str(sha_value))
    size = cast(int, size_value)
    media_type = str(media_value)
    if path != content_addressed_reference(sha256, size):
        raise ParserResultPublicationIntegrityError()
    row = connection.execute(
        "SELECT sha256,byte_size,media_type FROM artifact_objects WHERE relative_path=?",
        (path.root,),
    ).fetchone()
    if row is None or tuple(row) != (sha256.root, size, media_type):
        raise ParserResultPublicationIntegrityError()
    return ParserArtifactRef(
        sha256=sha256,
        media_type=media_type,
        byte_size=size,
    )


def _provenance(connection: sqlite3.Connection, provenance_id: str) -> Provenance:
    row = connection.execute(
        "SELECT provenance_id,source_kind,source_name,source_record_id,observed_at,"
        "input_sha256,parameters_sha256 FROM provenances WHERE provenance_id=?",
        (provenance_id,),
    ).fetchone()
    if row is None:
        raise ParserResultPublicationIntegrityError()
    return Provenance(
        provenance_id=ProvenanceId(str(row[0])),
        source_kind=SourceKind(str(row[1])),
        source_name=str(row[2]),
        source_record_id=None if row[3] is None else str(row[3]),
        observed_at=UtcTimestamp(str(row[4])),
        input_sha256=None if row[5] is None else Sha256(str(row[5])),
        parameters_sha256=None if row[6] is None else Sha256(str(row[6])),
    )


def _read_current(
    connection: sqlite3.Connection,
    source_asset_id: AssetId,
) -> ParserResult | None:
    row = connection.execute(
        "SELECT source_asset_id,source_sha256,result_sha256,page_count,markdown_artifact_path,"
        "markdown_sha256,markdown_byte_size,markdown_media_type,provenance_id,parser_version,"
        "mode,model_identity FROM parser_results WHERE source_asset_id=?",
        (source_asset_id.root,),
    ).fetchone()
    if row is None:
        return None
    markdown = _catalog_artifact(connection, row[4], row[5], row[6], row[7])
    resource_rows = connection.execute(
        "SELECT ordinal,reference,artifact_path,artifact_sha256,artifact_byte_size,"
        "artifact_media_type FROM parser_result_resources WHERE source_asset_id=? "
        "ORDER BY ordinal",
        (source_asset_id.root,),
    ).fetchall()
    if tuple(cast(int, item[0]) for item in resource_rows) != tuple(range(len(resource_rows))):
        raise ParserResultPublicationIntegrityError()
    resources = tuple(
        ParserResource(
            reference=str(item[1]),
            artifact=_catalog_artifact(connection, item[2], item[3], item[4], item[5]),
        )
        for item in resource_rows
    )
    provenance = _provenance(connection, str(row[8]))
    result = ParserResult(
        source_asset_id=AssetId(str(row[0])),
        source_sha256=Sha256(str(row[1])),
        result_sha256=Sha256(str(row[2])),
        page_count=cast(int, row[3]),
        markdown=markdown,
        resources=resources,
        provenance=ParserProvenance(
            provenance=provenance,
            parser_version=str(row[9]),
            mode=None if row[10] is None else str(row[10]),
            model_identity=None if row[11] is None else str(row[11]),
        ),
    )
    if result.source_asset_id != source_asset_id:
        raise ParserResultPublicationIntegrityError()
    return result


__all__ = (
    "PARSER_RESULT_PUBLICATION_FAILPOINTS",
    "ParserResultPublicationConflictError",
    "ParserResultPublicationError",
    "ParserResultPublicationIntegrityError",
    "SqliteParserResultPublication",
)
