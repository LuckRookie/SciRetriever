"""Production Completion inputs built from one transient Entry snapshot.

The builder reshapes already committed neutral facts.  It does not reread
Literature business state, infer a landing origin, choose an acquisition
candidate, or create a second durable read model.  The only live capability it
adds is a sealed parser input whose construction and every open are anchored to
Catalog plus :class:`VerifiedReader` verification.
"""

from __future__ import annotations

import os
from contextlib import AbstractContextManager, suppress
from types import TracebackType
from typing import BinaryIO, Final, NoReturn, TypeAlias

from sciretriever.acquisition.ports import AcquisitionExpectedFacts, AcquisitionRequest
from sciretriever.analysis.ports import ContentAnalysisInput
from sciretriever.entry.ports import ExecutionCurrentFacts
from sciretriever.literature.ports import CurrentPrimaryPdf, derive_status, metadata_sha256
from sciretriever.model.metadata import MetadataObservation
from sciretriever.model.parsing import ParserRequest
from sciretriever.model.primitives import AssetId, SourceKind
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactReference
from sciretriever.storage.literature_artifacts import _descriptor
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.literature_artifact_catalog import (
    verify_literature_artifact_catalog,
)

_TechnicalIdentity: TypeAlias = tuple[int, int, int, int]
_CAPABILITY_CREATION_TOKEN: Final[object] = object()
_DIRECT_CONSTRUCTION_MESSAGE: Final[str] = (
    "verified storage object capability cannot be constructed directly"
)


class CompletionInputError(RuntimeError):
    """A complete public stage input cannot be derived safely."""

    _MESSAGE = "completion input construction failed"

    def __init__(self, _message: object | None = None) -> None:
        super().__init__(self._MESSAGE)

    def __repr__(self) -> str:
        return "<CompletionInputError>"


class VerifiedStorageObjectError(RuntimeError):
    """A sealed parser input cannot be opened and verified safely."""

    _MESSAGE = "verified storage object read failed"

    def __init__(self, _message: object | None = None) -> None:
        super().__init__(self._MESSAGE)

    def __repr__(self) -> str:
        return "<VerifiedStorageObjectError>"


def _completion_failure() -> NoReturn:
    raise CompletionInputError() from None


def _verified_failure() -> NoReturn:
    raise VerifiedStorageObjectError() from None


def _technical_identity(stream: BinaryIO) -> _TechnicalIdentity:
    try:
        metadata = os.fstat(stream.fileno())
    except (OSError, TypeError, ValueError):
        _verified_failure()
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_nlink,
        metadata.st_size,
    )


class _VerifiedStorageReadContext(AbstractContextManager[BinaryIO]):
    """Own one already-entered VerifiedReader context without exposing its path."""

    __slots__ = ("_context", "_stream", "_entered", "_closed")

    def __init__(
        self,
        context: AbstractContextManager[BinaryIO],
        stream: BinaryIO,
    ) -> None:
        self._context = context
        self._stream = stream
        self._entered = False
        self._closed = False

    def __enter__(self) -> BinaryIO:
        if self._entered or self._closed:
            _verified_failure()
        self._entered = True
        return self._stream

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        if not self._entered or self._closed:
            _verified_failure()
        self._closed = True
        try:
            suppressed = self._context.__exit__(exc_type, exc_value, traceback)
        except Exception:
            _verified_failure()
        except BaseException:
            raise
        if suppressed:
            _verified_failure()
        return False

    def __del__(self) -> None:  # pragma: no cover - interpreter/GC fallback.
        try:
            if not self._closed:
                self._closed = True
                self._context.__exit__(None, None, None)
        except BaseException:
            pass


class VerifiedStorageObjectRef:
    """Sealed, path-free authority to read one immutable Catalog Asset.

    Direct construction is always rejected.  Instances are minted only by the
    production builder after Catalog and filesystem verification, and retain
    the originally verified inode identity for the lifetime of the capability.
    """

    __slots__ = ("_engine", "_reader", "_reference", "_asset_id", "_identity")

    def __init__(self, *_args: object, **_kwargs: object) -> None:
        raise TypeError(_DIRECT_CONSTRUCTION_MESSAGE)

    @classmethod
    def _create(
        cls,
        token: object,
        engine: CatalogEngine,
        reader: VerifiedReader,
        reference: ArtifactReference,
        asset_id: AssetId,
        identity: _TechnicalIdentity,
    ) -> VerifiedStorageObjectRef:
        if token is not _CAPABILITY_CREATION_TOKEN:
            raise TypeError(_DIRECT_CONSTRUCTION_MESSAGE)
        instance = object.__new__(cls)
        object.__setattr__(instance, "_engine", engine)
        object.__setattr__(instance, "_reader", reader)
        object.__setattr__(instance, "_reference", reference)
        object.__setattr__(instance, "_asset_id", asset_id)
        object.__setattr__(instance, "_identity", identity)
        return instance

    def __setattr__(self, _name: str, _value: object) -> None:
        raise AttributeError("verified storage object capability is immutable")

    def __repr__(self) -> str:
        return "<VerifiedStorageObjectRef>"

    def open(self) -> AbstractContextManager[BinaryIO]:
        """Reverify Catalog, bytes, file safety, TOCTOU, and original inode."""

        context: AbstractContextManager[BinaryIO] | None = None
        try:
            verify_literature_artifact_catalog(
                self._engine,
                self._reference,
                asset_id=self._asset_id,
            )
            context = self._reader.open(self._reference)
            stream = context.__enter__()
            if _technical_identity(stream) != self._identity:
                with suppress(Exception):
                    context.__exit__(None, None, None)
                _verified_failure()
            return _VerifiedStorageReadContext(context, stream)
        except VerifiedStorageObjectError:
            raise
        except Exception:
            if context is not None:
                with suppress(Exception):
                    context.__exit__(None, None, None)
            _verified_failure()


def _initial_identity(
    engine: CatalogEngine,
    reader: VerifiedReader,
    reference: ArtifactReference,
    asset_id: AssetId,
) -> _TechnicalIdentity:
    try:
        verify_literature_artifact_catalog(engine, reference, asset_id=asset_id)
        with reader.open(reference) as stream:
            return _technical_identity(stream)
    except VerifiedStorageObjectError:
        raise
    except Exception:
        _verified_failure()


def _sealed_asset_ref(
    engine: CatalogEngine,
    reader: VerifiedReader,
    primary: CurrentPrimaryPdf,
) -> VerifiedStorageObjectRef:
    try:
        reference, asset_id = _descriptor(
            primary.asset,
            reader.max_artifact_bytes,
        )
        if not isinstance(asset_id, AssetId) or asset_id != primary.asset.asset_id:
            _verified_failure()
        identity = _initial_identity(engine, reader, reference, asset_id)
        return VerifiedStorageObjectRef._create(
            _CAPABILITY_CREATION_TOKEN,
            engine,
            reader,
            reference,
            asset_id,
            identity,
        )
    except VerifiedStorageObjectError:
        raise
    except Exception:
        _verified_failure()


def _validated_observations(
    current: ExecutionCurrentFacts,
) -> tuple[MetadataObservation, ...]:
    observations = current.metadata_observations
    if not isinstance(observations, tuple) or not observations:
        _completion_failure()
    if any(not isinstance(item, MetadataObservation) for item in observations):
        _completion_failure()
    observation_ids = tuple(item.observation_id for item in observations)
    if len(observation_ids) != len(set(observation_ids)) or observation_ids != tuple(
        sorted(observation_ids, key=lambda item: item.root)
    ):
        _completion_failure()
    try:
        rebuilt = tuple(
            MetadataObservation.model_validate(item.model_dump(), strict=True)
            for item in observations
        )
    except Exception:
        _completion_failure()
    if rebuilt != observations:
        _completion_failure()
    return observations


def _validated_current(
    current: object,
) -> tuple[ExecutionCurrentFacts, tuple[MetadataObservation, ...]]:
    if not isinstance(current, ExecutionCurrentFacts):
        _completion_failure()
    observations = _validated_observations(current)
    facts = current.current
    try:
        if metadata_sha256(facts.literature.metadata) != facts.metadata_sha256:
            _completion_failure()
        if derive_status(facts) is not facts.literature.status:
            _completion_failure()
    except CompletionInputError:
        raise
    except Exception:
        _completion_failure()
    primaries = facts.current_primary_pdfs
    if not isinstance(primaries, tuple) or len(primaries) > 1:
        _completion_failure()
    primary = primaries[0] if primaries else None
    if primary is not None and (
        not isinstance(primary, CurrentPrimaryPdf)
        or primary.relation.literature_id != facts.literature.literature_id
        or primary.relation.asset_id != primary.asset.asset_id
        or primary.asset.media_type != "application/pdf"
    ):
        _completion_failure()
    if primary is not None and current.automatic_pdf_exhaustion is not None:
        _completion_failure()
    parser = facts.current_parser_result
    if parser is not None and (
        primary is None
        or parser.source_asset_id != primary.asset.asset_id
        or parser.source_sha256 != primary.asset.sha256
    ):
        _completion_failure()
    return current, observations


def _primary(current: ExecutionCurrentFacts) -> CurrentPrimaryPdf:
    primaries = current.current.current_primary_pdfs
    if len(primaries) != 1:
        _completion_failure()
    return primaries[0]


def _user_observations(
    observations: tuple[MetadataObservation, ...],
) -> tuple[MetadataObservation, ...]:
    return tuple(
        observation
        for observation in observations
        if observation.provenance.source_kind is SourceKind.USER
        and observation.provenance.source_name == "bibliographic-import"
        and observation.provenance.source_record_id is None
        and observation.provenance.input_sha256 is None
        and observation.provenance.parameters_sha256 is None
    )


class CompletionInputBuilder:
    """Build the three public Completion stage inputs from one current view."""

    __slots__ = ("_engine", "_reader")

    def __init__(self, engine: CatalogEngine, verified_reader: VerifiedReader) -> None:
        if not isinstance(engine, CatalogEngine):
            raise TypeError("engine must be a CatalogEngine")
        if not isinstance(verified_reader, VerifiedReader):
            raise TypeError("verified_reader must be a VerifiedReader")
        self._engine = engine
        self._reader = verified_reader

    def __repr__(self) -> str:
        return "<CompletionInputBuilder>"

    def build_acquisition_request(
        self,
        current: ExecutionCurrentFacts,
        *,
        excluded_candidate_keys: frozenset[str],
    ) -> AcquisitionRequest:
        """Carry the exact observation closure without resolving new origins."""

        try:
            checked, observations = _validated_current(current)
            if not isinstance(excluded_candidate_keys, frozenset):
                _completion_failure()
            facts = checked.current
            return AcquisitionRequest(
                literature=facts.literature,
                expected_facts=AcquisitionExpectedFacts(
                    literature_id=facts.literature.literature_id,
                    meta_literature_id=facts.literature.meta_literature_id,
                    metadata_revision=facts.metadata_revision,
                    metadata_sha256=facts.metadata_sha256,
                    expected_no_primary_pdf=True,
                ),
                observations=observations,
                current_assets=tuple(primary.relation for primary in facts.current_primary_pdfs),
                resolved_landing_origin=None,
                excluded_candidate_keys=excluded_candidate_keys,
            )
        except CompletionInputError:
            raise
        except Exception:
            _completion_failure()

    def build_parser_request(
        self,
        current: ExecutionCurrentFacts,
    ) -> ParserRequest:
        """Bind the unique current primary PDF to a sealed Storage reader."""

        try:
            checked, _observations = _validated_current(current)
            primary = _primary(checked)
            content_ref = _sealed_asset_ref(self._engine, self._reader, primary)
            return ParserRequest(
                source_asset_id=primary.asset.asset_id,
                source_sha256=primary.asset.sha256,
                media_type=primary.asset.media_type,
                content_ref=content_ref,
            )
        except CompletionInputError:
            raise
        except VerifiedStorageObjectError:
            _completion_failure()
        except Exception:
            _completion_failure()

    def build_content_analysis_input(
        self,
        current: ExecutionCurrentFacts,
    ) -> ContentAnalysisInput:
        """Bind Analysis to current metadata, PDF, parser, and import evidence."""

        try:
            checked, observations = _validated_current(current)
            facts = checked.current
            primary = _primary(checked)
            parser = facts.current_parser_result
            if parser is None:
                _completion_failure()
            return ContentAnalysisInput(
                literature_id=facts.literature.literature_id,
                primary_asset_id=primary.asset.asset_id,
                primary_pdf_sha256=primary.asset.sha256,
                parser_result=parser,
                initial_metadata=facts.literature.metadata,
                input_metadata_revision=facts.metadata_revision,
                input_metadata_sha256=facts.metadata_sha256,
                user_observations=_user_observations(observations),
            )
        except CompletionInputError:
            raise
        except Exception:
            _completion_failure()


__all__ = (
    "CompletionInputBuilder",
    "CompletionInputError",
    "VerifiedStorageObjectError",
    "VerifiedStorageObjectRef",
)
