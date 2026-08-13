"""Acquisition-specific file-first, single-transaction publication adapter.

This adapter intentionally does not compose the existing independent artifact,
Asset, LiteratureAsset, and exhaustion writers.  A primary publication uses
one verified filesystem lease and one short ``BEGIN IMMEDIATE`` transaction;
exhaustion publication and explicit retry clear each use their own smaller CAS
transaction.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from typing import TypeAlias

from sciretriever.acquisition.ports import (
    AcquisitionExhaustionPublicationCommand,
    AcquisitionExpectedFacts,
    PrimaryPdfPublicationResult,
    ValidatedPdfContent,
    ValidatedPrimaryPdfPublicationCommand,
)
from sciretriever.model.acquisition import (
    Asset,
    AssetRole,
    AutomaticPdfAcquisitionExhaustion,
    LiteratureAsset,
)
from sciretriever.model.primitives import (
    AssetId,
    LiteratureAssetId,
    RelativeArtifactPath,
    Sha256,
)
from sciretriever.storage.files.paths import StoragePathError, content_addressed_reference
from sciretriever.storage.files.reader import VerifiedArtifactLease, VerifiedReader
from sciretriever.storage.files.store import ArtifactStore

from .artifacts import ArtifactObject, _insert_or_verify_provenance
from .engine import CatalogEngine

Checkpoint: TypeAlias = Callable[[str], None]


class AcquisitionPublicationError(RuntimeError):
    """Stable, path-free failure at the composite Acquisition storage boundary."""

    _MESSAGE = "acquisition publication failed"

    def __init__(self, _message: object | None = None) -> None:
        super().__init__(self._MESSAGE)


class AcquisitionPublicationConflictError(AcquisitionPublicationError):
    """Current CAS facts or an immutable identity conflict with the request."""

    _MESSAGE = "acquisition publication conflicts with current facts"


class AcquisitionPublicationIntegrityError(AcquisitionPublicationError):
    """The requested or stored fact cannot be represented safely."""

    _MESSAGE = "acquisition publication value is invalid"


class SqliteAcquisitionPublication:
    """Implement Acquisition's primary, exhaustion, and retry-clear commit Ports."""

    __slots__ = ("_engine", "_store", "_reader", "_failpoint")

    def __init__(
        self,
        engine: CatalogEngine,
        store: ArtifactStore,
        reader: VerifiedReader,
        *,
        failpoint: Checkpoint | None = None,
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
        if self._failpoint is None:
            return
        try:
            self._failpoint(name)
        except AcquisitionPublicationError:
            raise
        except Exception as error:
            raise AcquisitionPublicationError() from error

    def commit_validated_primary_pdf(
        self,
        command: ValidatedPrimaryPdfPublicationCommand,
        validated_pdf: ValidatedPdfContent,
    ) -> PrimaryPdfPublicationResult:
        """Publish validated bytes, then atomically commit the actual primary facts."""

        if not isinstance(command, ValidatedPrimaryPdfPublicationCommand):
            raise TypeError("command must be ValidatedPrimaryPdfPublicationCommand")
        if not isinstance(validated_pdf, ValidatedPdfContent):
            raise TypeError("validated_pdf must implement ValidatedPdfContent")
        if command.provenance.input_sha256 != validated_pdf.sha256:
            raise AcquisitionPublicationIntegrityError()

        result: PrimaryPdfPublicationResult | None = None
        try:
            # The A2 stage is opened exactly once, and no code in this adapter
            # can return to the original TemporaryPdf source.
            with validated_pdf.open() as stream:
                reference = self._store.publish(
                    stream,
                    sha256=validated_pdf.sha256,
                    byte_size=validated_pdf.byte_size,
                    media_type=validated_pdf.media_type,
                )

            with self._reader.acquire(reference) as lease:
                self._checkpoint("primary-before-prepare")
                # Complete file rehash immediately before BEGIN IMMEDIATE.
                lease.prepare_registration()
                self._checkpoint("primary-after-prepare")
                result = self._commit_primary_transaction(command, lease)
        except AcquisitionPublicationError:
            raise
        except Exception as error:
            raise AcquisitionPublicationError() from error
        if result is None:
            raise AcquisitionPublicationError()
        return result

    def _commit_primary_transaction(
        self,
        command: ValidatedPrimaryPdfPublicationCommand,
        lease: VerifiedArtifactLease,
    ) -> PrimaryPdfPublicationResult:
        result: PrimaryPdfPublicationResult | None = None
        try:
            with self._engine.write_transaction() as connection:
                lease.verify_registration()
                self._checkpoint("primary-after-first-file-check")
                _check_primary_preconditions(connection, command, lease)
                self._checkpoint("primary-after-preconditions")

                artifact = _resolve_artifact(
                    connection,
                    command.proposed_artifact_id,
                    lease,
                )
                self._checkpoint("primary-after-artifact")
                asset = _resolve_asset(
                    connection,
                    command.proposed_asset_id,
                    artifact,
                )
                self._checkpoint("primary-after-asset")

                _insert_or_verify_provenance(connection, command.provenance)
                self._checkpoint("primary-after-provenance")
                relation = _resolve_primary_relation(connection, command, asset)
                self._checkpoint("primary-after-relation")

                connection.execute(
                    "DELETE FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
                    (command.expected_facts.literature_id.root,),
                )
                self._checkpoint("primary-after-exhaustion-clear")

                lease.verify_registration()
                self._checkpoint("primary-after-final-file-check")
                self._checkpoint("primary-before-commit")
                # A callback that mutates without raising is still caught.  The
                # engine commits only after this final named-object check.
                lease.verify_registration()
                result = PrimaryPdfPublicationResult(asset=asset, relation=relation)
        except AcquisitionPublicationError:
            raise
        except Exception as error:
            raise AcquisitionPublicationError() from error
        if result is None:
            raise AcquisitionPublicationError()
        return result

    def publish_exhaustion(
        self,
        command: AcquisitionExhaustionPublicationCommand,
    ) -> AutomaticPdfAcquisitionExhaustion:
        """CAS and commit the field-minimal exhaustion fact idempotently."""

        if not isinstance(command, AcquisitionExhaustionPublicationCommand):
            raise TypeError("command must be AcquisitionExhaustionPublicationCommand")
        facts = command.expected_facts
        try:
            with self._engine.write_transaction() as connection:
                _check_strict_no_primary_preconditions(connection, facts)
                self._checkpoint("exhaustion-after-preconditions")
                current_observations = tuple(
                    str(row[0])
                    for row in connection.execute(
                        "SELECT observation_id FROM literature_metadata_observations "
                        "WHERE literature_id=? ORDER BY observation_id",
                        (facts.literature_id.root,),
                    ).fetchall()
                )
                expected_observations = tuple(value.root for value in command.observation_ids)
                if current_observations != expected_observations:
                    raise AcquisitionPublicationConflictError()
                self._checkpoint("exhaustion-after-observation-closure")
                connection.execute(
                    "INSERT OR IGNORE INTO automatic_pdf_acquisition_exhaustions(literature_id) "
                    "VALUES(?)",
                    (facts.literature_id.root,),
                )
                self._checkpoint("exhaustion-after-insert")
                self._checkpoint("exhaustion-before-commit")
        except AcquisitionPublicationError:
            raise
        except Exception as error:
            raise AcquisitionPublicationError() from error
        return AutomaticPdfAcquisitionExhaustion(literature_id=facts.literature_id)

    def clear_exhaustion(self, expected_facts: AcquisitionExpectedFacts) -> None:
        """CAS and idempotently clear exhaustion for one explicit retry."""

        if not isinstance(expected_facts, AcquisitionExpectedFacts):
            raise TypeError("expected_facts must be AcquisitionExpectedFacts")
        try:
            with self._engine.write_transaction() as connection:
                _check_strict_no_primary_preconditions(connection, expected_facts)
                self._checkpoint("retry-after-preconditions")
                connection.execute(
                    "DELETE FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
                    (expected_facts.literature_id.root,),
                )
                self._checkpoint("retry-after-delete")
                self._checkpoint("retry-before-commit")
        except AcquisitionPublicationError:
            raise
        except Exception as error:
            raise AcquisitionPublicationError() from error


def _check_expected_facts(
    connection: sqlite3.Connection,
    expected: AcquisitionExpectedFacts,
) -> None:
    row = connection.execute(
        "SELECT l.meta_literature_id,m.metadata_revision,m.metadata_sha256 "
        "FROM literatures l "
        "JOIN meta_literatures ml ON ml.meta_literature_id=l.meta_literature_id "
        "JOIN literature_metadata m ON m.literature_id=l.literature_id "
        "WHERE l.literature_id=?",
        (expected.literature_id.root,),
    ).fetchone()
    desired = (
        expected.meta_literature_id.root,
        expected.metadata_revision,
        expected.metadata_sha256.root,
    )
    if row is None or tuple(row) != desired:
        raise AcquisitionPublicationConflictError()


def _has_content(connection: sqlite3.Connection, expected: AcquisitionExpectedFacts) -> bool:
    return (
        connection.execute(
            "SELECT 1 FROM literature_contents WHERE literature_id=?",
            (expected.literature_id.root,),
        ).fetchone()
        is not None
    )


def _primary_row(
    connection: sqlite3.Connection,
    expected: AcquisitionExpectedFacts,
) -> tuple[object, ...] | None:
    rows = connection.execute(
        "SELECT la.literature_asset_id,la.asset_id,la.provenance_id,la.source_url,"
        "a.sha256,a.size_bytes,a.media_type,a.relative_path,"
        "p.source_kind,p.source_name,p.source_record_id,p.observed_at,"
        "p.input_sha256,p.parameters_sha256 "
        "FROM literature_assets la "
        "JOIN assets a ON a.asset_id=la.asset_id "
        "JOIN provenances p ON p.provenance_id=la.provenance_id "
        "WHERE la.literature_id=? AND la.role='primary-pdf'",
        (expected.literature_id.root,),
    ).fetchall()
    if len(rows) > 1:
        raise AcquisitionPublicationIntegrityError()
    return None if not rows else tuple(rows[0])


def _check_primary_preconditions(
    connection: sqlite3.Connection,
    command: ValidatedPrimaryPdfPublicationCommand,
    lease: VerifiedArtifactLease,
) -> None:
    expected = command.expected_facts
    _check_expected_facts(connection, expected)
    if _has_content(connection, expected):
        raise AcquisitionPublicationConflictError()
    primary = _primary_row(connection, expected)
    if primary is None:
        return

    provenance = command.provenance
    exact_replay = (
        primary[4] == lease.sha256.root
        and primary[5] == lease.byte_size
        and primary[6] == lease.media_type
        and primary[7] == lease.path.root
        and primary[2] == provenance.provenance_id.root
        and primary[3] == command.source_url
        and primary[8] == provenance.source_kind.value
        and primary[9] == provenance.source_name
        and primary[10] == provenance.source_record_id
        and primary[11] == provenance.observed_at.root
        and primary[12]
        == (None if provenance.input_sha256 is None else provenance.input_sha256.root)
        and primary[13]
        == (None if provenance.parameters_sha256 is None else provenance.parameters_sha256.root)
    )
    # expected-no-primary remains a strict CAS except for an exact replay of a
    # possibly committed response whose caller never observed the return.
    if not exact_replay:
        raise AcquisitionPublicationConflictError()


def _check_strict_no_primary_preconditions(
    connection: sqlite3.Connection,
    expected: AcquisitionExpectedFacts,
) -> None:
    _check_expected_facts(connection, expected)
    if _has_content(connection, expected) or _primary_row(connection, expected) is not None:
        raise AcquisitionPublicationConflictError()


def _canonical_lease_path(lease: VerifiedArtifactLease) -> RelativeArtifactPath:
    try:
        canonical = content_addressed_reference(lease.sha256, lease.byte_size)
    except (StoragePathError, TypeError, ValueError) as error:
        raise AcquisitionPublicationIntegrityError() from error
    if canonical != lease.path:
        raise AcquisitionPublicationIntegrityError()
    return canonical


def _artifact_from_row(row: tuple[object, ...]) -> ArtifactObject:
    try:
        return ArtifactObject(
            artifact_id=str(row[0]),
            sha256=Sha256(str(row[1])),
            byte_size=int(str(row[2])),
            media_type=str(row[3]),
            relative_path=RelativeArtifactPath(str(row[4])),
        )
    except (TypeError, ValueError) as error:
        raise AcquisitionPublicationIntegrityError() from error


def _resolve_artifact(
    connection: sqlite3.Connection,
    proposed_id: str,
    lease: VerifiedArtifactLease,
) -> ArtifactObject:
    path = _canonical_lease_path(lease)
    expected_descriptor = (
        lease.sha256.root,
        lease.byte_size,
        lease.media_type,
        path.root,
    )
    columns = "artifact_id,sha256,byte_size,media_type,relative_path"
    by_id = connection.execute(
        f"SELECT {columns} FROM artifact_objects WHERE artifact_id=?",
        (proposed_id,),
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
        raise AcquisitionPublicationConflictError()
    natural = [tuple(row) for row in (by_hash, by_path) if row is not None]
    if natural:
        actual = natural[0]
        if any(row != actual for row in natural) or actual[1:] != expected_descriptor:
            raise AcquisitionPublicationConflictError()
        if by_id is not None and tuple(by_id) != actual:
            raise AcquisitionPublicationConflictError()
        return _artifact_from_row(actual)
    if by_id is not None:
        # A matching ID would necessarily have been found by both natural keys.
        raise AcquisitionPublicationIntegrityError()

    connection.execute(
        "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) "
        "VALUES(?,?,?,?,?)",
        (proposed_id, *expected_descriptor),
    )
    return ArtifactObject(
        artifact_id=proposed_id,
        sha256=lease.sha256,
        byte_size=lease.byte_size,
        media_type=lease.media_type,
        relative_path=path,
    )


def _asset_from_row(row: tuple[object, ...]) -> Asset:
    try:
        return Asset(
            asset_id=AssetId(str(row[0])),
            sha256=Sha256(str(row[1])),
            size_bytes=int(str(row[2])),
            media_type=str(row[3]),
            path=RelativeArtifactPath(str(row[4])),
        )
    except (TypeError, ValueError) as error:
        raise AcquisitionPublicationIntegrityError() from error


def _resolve_asset(
    connection: sqlite3.Connection,
    proposed_id: AssetId,
    artifact: ArtifactObject,
) -> Asset:
    expected_descriptor = (
        artifact.sha256.root,
        artifact.byte_size,
        artifact.media_type,
        artifact.relative_path.root,
    )
    columns = "asset_id,sha256,size_bytes,media_type,relative_path"
    by_id = connection.execute(
        f"SELECT {columns} FROM assets WHERE asset_id=?",
        (proposed_id.root,),
    ).fetchone()
    by_hash = connection.execute(
        f"SELECT {columns} FROM assets WHERE sha256=? AND size_bytes=?",
        (artifact.sha256.root, artifact.byte_size),
    ).fetchone()
    by_path = connection.execute(
        f"SELECT {columns} FROM assets WHERE relative_path=?",
        (artifact.relative_path.root,),
    ).fetchone()

    if by_id is not None and tuple(by_id)[1:] != expected_descriptor:
        raise AcquisitionPublicationConflictError()
    natural = [tuple(row) for row in (by_hash, by_path) if row is not None]
    if natural:
        actual = natural[0]
        if any(row != actual for row in natural) or actual[1:] != expected_descriptor:
            raise AcquisitionPublicationConflictError()
        if by_id is not None and tuple(by_id) != actual:
            raise AcquisitionPublicationConflictError()
        return _asset_from_row(actual)
    if by_id is not None:
        raise AcquisitionPublicationIntegrityError()

    connection.execute(
        "INSERT INTO assets(asset_id,sha256,size_bytes,media_type,relative_path) VALUES(?,?,?,?,?)",
        (proposed_id.root, *expected_descriptor),
    )
    return Asset(
        asset_id=proposed_id,
        sha256=artifact.sha256,
        size_bytes=artifact.byte_size,
        media_type=artifact.media_type,
        path=artifact.relative_path,
    )


def _resolve_primary_relation(
    connection: sqlite3.Connection,
    command: ValidatedPrimaryPdfPublicationCommand,
    asset: Asset,
) -> LiteratureAsset:
    expected = command.expected_facts
    semantic = (
        expected.literature_id.root,
        asset.asset_id.root,
        AssetRole.PRIMARY_PDF.value,
        command.provenance.provenance_id.root,
        command.source_url,
    )
    columns = "literature_asset_id,literature_id,asset_id,role,provenance_id,source_url"
    by_id = connection.execute(
        f"SELECT {columns} FROM literature_assets WHERE literature_asset_id=?",
        (command.proposed_literature_asset_id.root,),
    ).fetchone()
    by_natural = connection.execute(
        f"SELECT {columns} FROM literature_assets "
        "WHERE literature_id=? AND asset_id=? AND role='primary-pdf'",
        (expected.literature_id.root, asset.asset_id.root),
    ).fetchone()
    current = connection.execute(
        f"SELECT {columns} FROM literature_assets WHERE literature_id=? AND role='primary-pdf'",
        (expected.literature_id.root,),
    ).fetchone()

    if by_id is not None and tuple(by_id)[1:] != semantic:
        raise AcquisitionPublicationConflictError()
    natural = [tuple(row) for row in (by_natural, current) if row is not None]
    if natural:
        actual = natural[0]
        if any(row != actual for row in natural) or actual[1:] != semantic:
            raise AcquisitionPublicationConflictError()
        if by_id is not None and tuple(by_id) != actual:
            raise AcquisitionPublicationConflictError()
        actual_id = LiteratureAssetId(str(actual[0]))
    else:
        if by_id is not None:
            raise AcquisitionPublicationIntegrityError()
        actual_id = command.proposed_literature_asset_id
        connection.execute(
            "INSERT INTO literature_assets(literature_asset_id,literature_id,asset_id,role,"
            "provenance_id,source_url) VALUES(?,?,?,?,?,?)",
            (actual_id.root, *semantic),
        )

    return LiteratureAsset(
        literature_asset_id=actual_id,
        literature_id=expected.literature_id,
        asset_id=asset.asset_id,
        role=AssetRole.PRIMARY_PDF,
        provenance=command.provenance,
        source_url=command.source_url,
    )


__all__ = (
    "AcquisitionPublicationConflictError",
    "AcquisitionPublicationError",
    "AcquisitionPublicationIntegrityError",
    "SqliteAcquisitionPublication",
)
