"""Neutral runtime Ports for automatic primary-PDF acquisition.

The contracts in this module deliberately stop before HTTP, Browser, vendor
SDK, PDF-reader, filesystem-path, and database types.  Source adapters turn
their private protocol work into :class:`TemporaryPdf`; validation/publication
and exhaustion adapters then provide the two commit boundaries used by the
service.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, BinaryIO, Protocol, runtime_checkable
from urllib.parse import urlsplit

from sciretriever.model.access import has_sensitive_query_parameter
from sciretriever.model.acquisition import (
    AcquiredPrimaryPdf,
    AcquisitionPath,
    Asset,
    AssetRole,
    AutomaticPdfAcquisitionExhaustion,
    LiteratureAsset,
    PdfCandidate,
)
from sciretriever.model.literature import Literature
from sciretriever.model.metadata import MetadataObservation
from sciretriever.model.primitives import (
    AssetId,
    LiteratureAssetId,
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    Sha256,
    SourceKind,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure

if TYPE_CHECKING:
    from sciretriever.acquisition.routing import AcquisitionEvidence

_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")


def _nonblank(value: object, *, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    candidate = value.strip()
    if not candidate:
        raise ValueError(f"{field_name} must be nonblank")
    if _CONTROL_CHARACTER.search(candidate) is not None:
        raise ValueError(f"{field_name} must not contain control characters")
    return candidate


def _safe_source_url(value: object) -> str:
    candidate = _nonblank(value, field_name="safe_source_url")
    try:
        parsed = urlsplit(candidate)
    except ValueError as error:
        raise ValueError("safe_source_url must be an absolute HTTP(S) URL") from error
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("safe_source_url must be an absolute HTTP(S) URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("safe_source_url must not contain URL credentials")
    try:
        if has_sensitive_query_parameter(parsed.query):
            raise ValueError("safe_source_url must not contain credential query parameters")
    except (TypeError, ValueError):
        raise ValueError("safe_source_url query must be safe and well formed") from None
    if parsed.fragment:
        raise ValueError("safe_source_url must not contain a fragment")
    return candidate


def _artifact_id(value: object) -> str:
    return _nonblank(value, field_name="proposed_artifact_id")


class AcquisitionFailure(RuntimeError):
    """A stable, redacted system failure crossing an Acquisition Port."""

    _MESSAGE = "automatic PDF acquisition failed"

    def __init__(self, failure: StableFailure) -> None:
        if not isinstance(failure, StableFailure):
            raise TypeError("failure must be a StableFailure")
        super().__init__(self._MESSAGE)
        self.failure = failure


@dataclass(frozen=True, slots=True)
class AcquisitionExpectedFacts:
    """CAS snapshot required by publication, exhaustion, and explicit retry clear."""

    literature_id: LiteratureId
    meta_literature_id: MetaLiteratureId
    metadata_revision: int
    metadata_sha256: Sha256
    expected_no_primary_pdf: bool

    def __post_init__(self) -> None:
        if not isinstance(self.literature_id, LiteratureId):
            raise TypeError("literature_id must be a LiteratureId")
        if not isinstance(self.meta_literature_id, MetaLiteratureId):
            raise TypeError("meta_literature_id must be a MetaLiteratureId")
        if type(self.metadata_revision) is not int:
            raise TypeError("metadata_revision must be an integer")
        if self.metadata_revision < 1:
            raise ValueError("metadata_revision must be positive")
        if not isinstance(self.metadata_sha256, Sha256):
            raise TypeError("metadata_sha256 must be a Sha256")
        if type(self.expected_no_primary_pdf) is not bool:
            raise TypeError("expected_no_primary_pdf must be a bool")
        if not self.expected_no_primary_pdf:
            raise ValueError("automatic acquisition requires expected-no-primary")


def _landing_origin(value: object) -> str:
    candidate = _nonblank(value, field_name="resolved_landing_origin")
    try:
        parsed = urlsplit(candidate)
        port = parsed.port
    except ValueError as error:
        raise ValueError("resolved_landing_origin must be an HTTP(S) origin") from error
    if parsed.scheme not in {"http", "https"} or parsed.hostname is None:
        raise ValueError("resolved_landing_origin must be an HTTP(S) origin")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("resolved_landing_origin must not contain URL credentials")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("resolved_landing_origin must contain only an origin")
    host = parsed.hostname.casefold()
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    authority = host if port is None else f"{host}:{port}"
    return f"{parsed.scheme.casefold()}://{authority}"


def _observation_closure(value: object) -> tuple[ObservationId, ...]:
    if not isinstance(value, tuple):
        raise TypeError("observations must be a tuple")
    if any(not isinstance(item, MetadataObservation) for item in value):
        raise TypeError("observations must contain MetadataObservation values")
    observations = value
    return tuple(
        sorted(
            {observation.observation_id for observation in observations},
            key=lambda item: item.root,
        )
    )


def _validate_current_assets(
    value: object,
    *,
    literature: Literature,
) -> None:
    if not isinstance(value, tuple):
        raise TypeError("current_assets must be a tuple")
    if any(not isinstance(item, LiteratureAsset) for item in value):
        raise TypeError("current_assets must contain LiteratureAsset values")
    assets = value
    if any(item.literature_id != literature.literature_id for item in assets):
        raise ValueError("current assets must belong to the requested Literature")


def _excluded_candidate_keys(value: object) -> frozenset[str]:
    if not isinstance(value, frozenset):
        raise TypeError("excluded_candidate_keys must be a frozenset")
    return frozenset(_nonblank(item, field_name="excluded candidate key") for item in value)


@dataclass(frozen=True, slots=True)
class AcquisitionRequest:
    """Neutral request for one concrete Literature's automatic PDF acquisition."""

    literature: Literature
    expected_facts: AcquisitionExpectedFacts
    observations: tuple[MetadataObservation, ...] = ()
    observation_closure: tuple[ObservationId, ...] = field(init=False)
    current_assets: tuple[LiteratureAsset, ...] = ()
    resolved_landing_origin: str | None = None
    excluded_candidate_keys: frozenset[str] = frozenset()

    def __post_init__(self) -> None:
        if not isinstance(self.literature, Literature):
            raise TypeError("literature must be a Literature")
        if not isinstance(self.expected_facts, AcquisitionExpectedFacts):
            raise TypeError("expected_facts must be AcquisitionExpectedFacts")
        if (
            self.expected_facts.literature_id != self.literature.literature_id
            or self.expected_facts.meta_literature_id != self.literature.meta_literature_id
        ):
            raise ValueError("expected facts must identify the requested Literature")
        object.__setattr__(
            self,
            "observation_closure",
            _observation_closure(self.observations),
        )
        _validate_current_assets(self.current_assets, literature=self.literature)
        if self.resolved_landing_origin is not None:
            object.__setattr__(
                self,
                "resolved_landing_origin",
                _landing_origin(self.resolved_landing_origin),
            )
        object.__setattr__(
            self,
            "excluded_candidate_keys",
            _excluded_candidate_keys(self.excluded_candidate_keys),
        )


@dataclass(frozen=True, slots=True)
class AcquisitionExhaustionPublicationCommand:
    """CAS command for exhaustion, including the exact observation closure."""

    expected_facts: AcquisitionExpectedFacts
    observation_ids: tuple[ObservationId, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.expected_facts, AcquisitionExpectedFacts):
            raise TypeError("expected_facts must be AcquisitionExpectedFacts")
        if not isinstance(self.observation_ids, tuple):
            raise TypeError("observation_ids must be a tuple")
        if any(not isinstance(value, ObservationId) for value in self.observation_ids):
            raise TypeError("observation_ids must contain ObservationId values")
        normalized = tuple(sorted(set(self.observation_ids), key=lambda value: value.root))
        if self.observation_ids != normalized:
            raise ValueError("observation_ids must be sorted and unique")


@dataclass(frozen=True, slots=True)
class PrimaryPdfPublicationResult:
    """The actual Asset and primary relation visible after Catalog commit."""

    asset: Asset
    relation: LiteratureAsset

    def __post_init__(self) -> None:
        if not isinstance(self.asset, Asset):
            raise TypeError("asset must be an Asset")
        if not isinstance(self.relation, LiteratureAsset):
            raise TypeError("relation must be a LiteratureAsset")
        if self.relation.role is not AssetRole.PRIMARY_PDF:
            raise ValueError("relation must be primary-pdf")
        if self.relation.asset_id != self.asset.asset_id:
            raise ValueError("relation must point to the published Asset")


@dataclass(frozen=True, slots=True)
class ValidatedPrimaryPdfPublicationCommand:
    """Candidate-neutral, already-validated decision passed to Storage."""

    expected_facts: AcquisitionExpectedFacts
    proposed_artifact_id: str
    proposed_asset_id: AssetId
    proposed_literature_asset_id: LiteratureAssetId
    provenance: Provenance
    source_url: str | None

    def __post_init__(self) -> None:
        if not isinstance(self.expected_facts, AcquisitionExpectedFacts):
            raise TypeError("expected_facts must be AcquisitionExpectedFacts")
        object.__setattr__(self, "proposed_artifact_id", _artifact_id(self.proposed_artifact_id))
        if not isinstance(self.proposed_asset_id, AssetId):
            raise TypeError("proposed_asset_id must be an AssetId")
        if not isinstance(self.proposed_literature_asset_id, LiteratureAssetId):
            raise TypeError("proposed_literature_asset_id must be a LiteratureAssetId")
        if not isinstance(self.provenance, Provenance):
            raise TypeError("provenance must be a Provenance")
        if self.provenance.input_sha256 is None:
            raise ValueError("publication provenance must carry the validated PDF hash")
        if self.provenance.source_kind not in {SourceKind.ASSET_PROVIDER, SourceKind.USER}:
            raise ValueError("primary PDF provenance must be asset-provider or user")
        if self.source_url is not None:
            object.__setattr__(self, "source_url", _safe_source_url(self.source_url))
        if self.provenance.source_kind is SourceKind.USER:
            if (
                self.provenance.source_name != "manual-pdf"
                or self.provenance.source_record_id is not None
                or self.source_url is not None
            ):
                raise ValueError("manual PDF publication must use path-free manual provenance")


@runtime_checkable
class TemporaryPdfContent(Protocol):
    """A bounded stream or owner-only staging object with deterministic cleanup."""

    def open(self) -> AbstractContextManager[BinaryIO]:
        """Open the temporary bytes for validation/publication."""
        ...

    def discard(self) -> None:
        """Idempotently release the temporary bytes without touching user assets."""
        ...


@runtime_checkable
class ValidatedPdfContent(Protocol):
    """The narrow, path-free validated-byte surface consumed by Storage."""

    @property
    def sha256(self) -> Sha256: ...

    @property
    def byte_size(self) -> int: ...

    @property
    def media_type(self) -> str: ...

    def open(self) -> AbstractContextManager[BinaryIO]:
        """Open the checked internal bytes for one file-first commit."""
        ...


@runtime_checkable
class CancellationEvent(Protocol):
    """Operation-local cooperative cancellation checked at safe boundaries."""

    def is_set(self) -> bool: ...


@runtime_checkable
class PdfValidationStage(Protocol):
    """One path-free owner-only stage used only for bounded PDF validation."""

    def write(self, data: bytes) -> int:
        """Write all supplied bytes and return the exact written count."""
        ...

    def flush(self) -> None:
        """Flush staged bytes before the reader boundary."""
        ...

    def open(self) -> AbstractContextManager[BinaryIO]:
        """Open a short read view without exposing a path or descriptor."""
        ...

    def close(self) -> None:
        """Idempotently remove the staged bytes and their private root."""
        ...


@runtime_checkable
class PdfValidationStagingPort(Protocol):
    """Create a fresh validation stage in the system temporary boundary."""

    def create(self) -> PdfValidationStage: ...


@runtime_checkable
class PrimaryPdfPreparation(Protocol):
    """Acquisition-internal validated candidate with an explicit short lifetime."""

    def discard(self) -> None:
        """Idempotently release the validated owner-only staging bytes."""
        ...


@runtime_checkable
class ValidatedPrimaryPdfCommitPort(Protocol):
    """Commit one already validated PDF through files plus one SQLite transaction."""

    def commit_validated_primary_pdf(
        self,
        command: ValidatedPrimaryPdfPublicationCommand,
        validated_pdf: ValidatedPdfContent,
    ) -> PrimaryPdfPublicationResult: ...


@dataclass(frozen=True, slots=True)
class TemporaryPdf:
    """Package-internal neutral delivery produced by a configured PDF Source."""

    candidate: PdfCandidate
    content: TemporaryPdfContent
    safe_source_url: str | None
    provenance: Provenance

    def __post_init__(self) -> None:
        if not isinstance(self.candidate, PdfCandidate):
            raise TypeError("candidate must be a PdfCandidate")
        if not isinstance(self.content, TemporaryPdfContent):
            raise TypeError("content must implement TemporaryPdfContent")
        if self.safe_source_url is not None:
            object.__setattr__(self, "safe_source_url", _safe_source_url(self.safe_source_url))
        if not isinstance(self.provenance, Provenance):
            raise TypeError("provenance must be a Provenance")
        if self.provenance.source_kind is not SourceKind.ASSET_PROVIDER:
            raise ValueError("temporary PDF provenance must use source kind asset-provider")
        if self.provenance.source_name != self.candidate.source_name:
            raise ValueError("temporary PDF provenance must match the candidate source")


class CandidateKeyTracker:
    """Request-local excluded/tried keys shared by serial Source adapters.

    A Source must call :meth:`claim` immediately before each real access.  A
    false return means the action was excluded or already tried and therefore
    must not perform I/O.  The tracker is intentionally process-local and has
    no persistence or failure-detail surface.
    """

    def __init__(self, excluded_candidate_keys: Iterable[str] = ()) -> None:
        try:
            values = tuple(excluded_candidate_keys)
        except TypeError:
            raise TypeError("excluded_candidate_keys must be iterable") from None
        self._candidate_keys: set[str] = set()
        for value in values:
            self._candidate_keys.add(_nonblank(value, field_name="candidate key"))

    def claim(self, candidate_key: str) -> bool:
        """Mark a new candidate tried, returning false when it is already blocked."""

        candidate = _nonblank(candidate_key, field_name="candidate key")
        if candidate in self._candidate_keys:
            return False
        self._candidate_keys.add(candidate)
        return True

    def contains(self, candidate_key: str) -> bool:
        """Return whether a candidate is excluded or has been claimed this request."""

        candidate = _nonblank(candidate_key, field_name="candidate key")
        return candidate in self._candidate_keys

    @property
    def tried_candidate_keys(self) -> frozenset[str]:
        """Expose an immutable request-local snapshot for diagnostics/tests only."""

        return frozenset(self._candidate_keys)


@dataclass(frozen=True, slots=True)
class SourceReadiness:
    """A local readiness decision produced before Acquisition performs I/O."""

    is_ready: bool
    failure: StableFailure | None = None

    def __post_init__(self) -> None:
        if type(self.is_ready) is not bool:
            raise TypeError("is_ready must be a bool")
        if self.failure is not None and not isinstance(self.failure, StableFailure):
            raise TypeError("failure must be a StableFailure or None")
        if self.is_ready and self.failure is not None:
            raise ValueError("a ready Source cannot carry a readiness failure")


@runtime_checkable
class PdfSource(Protocol):
    """One capability-scoped Source in exactly one automatic acquisition stage."""

    @property
    def source_name(self) -> str: ...

    @property
    def acquisition_path(self) -> AcquisitionPath: ...

    def is_applicable(self, evidence: "AcquisitionEvidence") -> bool:
        """Interpret only prebuilt local evidence; this method must perform no I/O."""
        ...

    def acquire(
        self,
        request: "AcquisitionRequest",
        evidence: "AcquisitionEvidence",
        candidate_keys: CandidateKeyTracker,
    ) -> Iterable[TemporaryPdf]:
        """Yield temporary PDFs serially after claiming each real candidate action."""
        ...


@dataclass(frozen=True, slots=True)
class PdfSourceBinding:
    """Configuration/assembly state for one potential Source capability."""

    source_name: str
    acquisition_path: AcquisitionPath
    enabled: bool
    production: bool
    readiness: SourceReadiness | None
    source: PdfSource | None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "source_name",
            _nonblank(self.source_name, field_name="source_name"),
        )
        if not isinstance(self.acquisition_path, AcquisitionPath):
            raise TypeError("acquisition_path must be an AcquisitionPath")
        if type(self.enabled) is not bool:
            raise TypeError("enabled must be a bool")
        if type(self.production) is not bool:
            raise TypeError("production must be a bool")
        if self.readiness is not None and not isinstance(self.readiness, SourceReadiness):
            raise TypeError("readiness must be a SourceReadiness or None")
        if self.source is not None and not isinstance(self.source, PdfSource):
            raise TypeError("source must implement PdfSource or be None")


@runtime_checkable
class PrimaryPdfPreparationPort(Protocol):
    """Validate now and commit later without exposing staging outside Acquisition."""

    def prepare_primary_pdf(
        self,
        request: "AcquisitionRequest",
        temporary_pdf: TemporaryPdf,
        *,
        cancel_event: CancellationEvent | None = None,
    ) -> PrimaryPdfPreparation | None: ...

    def commit_primary_pdf(
        self,
        prepared: PrimaryPdfPreparation,
    ) -> AcquiredPrimaryPdf: ...


@runtime_checkable
class AcquisitionExhaustionPublicationPort(Protocol):
    """Commit the minimal exhaustion fact after every applicable path ends normally."""

    def publish_exhaustion(
        self,
        command: AcquisitionExhaustionPublicationCommand,
    ) -> AutomaticPdfAcquisitionExhaustion: ...


@runtime_checkable
class AcquisitionExhaustionClearPort(Protocol):
    """Clear exhaustion for an explicit retry under the same CAS snapshot."""

    def clear_exhaustion(self, expected_facts: AcquisitionExpectedFacts) -> None: ...


__all__ = (
    "AcquisitionExpectedFacts",
    "AcquisitionRequest",
    "AcquisitionExhaustionPublicationCommand",
    "AcquisitionExhaustionClearPort",
    "AcquisitionExhaustionPublicationPort",
    "AcquisitionFailure",
    "CancellationEvent",
    "CandidateKeyTracker",
    "PdfSource",
    "PdfSourceBinding",
    "PdfValidationStage",
    "PdfValidationStagingPort",
    "PrimaryPdfPublicationResult",
    "PrimaryPdfPreparation",
    "PrimaryPdfPreparationPort",
    "SourceReadiness",
    "TemporaryPdf",
    "TemporaryPdfContent",
    "ValidatedPdfContent",
    "ValidatedPrimaryPdfCommitPort",
    "ValidatedPrimaryPdfPublicationCommand",
)
