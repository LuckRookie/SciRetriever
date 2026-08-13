"""Consumer-owned boundaries used by Entry orchestration.

The values declared here contain only neutral Models and short-lived I/O
capabilities.  Selector snapshots and bounded relation pages are transient
reads; completion target ordering and operation reports remain process-local
Entry state and are never accepted by persistence boundaries.
"""

from __future__ import annotations

from contextlib import AbstractContextManager
from dataclasses import dataclass
from os import PathLike
from typing import BinaryIO, Literal, Protocol, TypeAlias, runtime_checkable

from sciretriever.literature.api import (
    ContentReferenceClosureToken,
    CurrentContentLineage,
    CurrentLiteratureFacts,
    ReferenceCleanupDecision,
)
from sciretriever.model.acquisition import (
    Asset,
    AssetRole,
    AutomaticPdfAcquisitionExhaustion,
    LiteratureAsset,
)
from sciretriever.model.analysis import LiteratureContent, NoUsableContent
from sciretriever.model.discovery import (
    CitationDiscoveryCause,
    DiscoveryCause,
    DiscoveryResult,
    DiscoveryRun,
    DiscoverySourceResult,
    TopicDiscoveryCause,
)
from sciretriever.model.execution import BatchSelector
from sciretriever.model.literature import MetaLiterature
from sciretriever.model.metadata import MetadataObservation
from sciretriever.model.parsing import ParserResult
from sciretriever.model.primitives import (
    AssetId,
    DiscoveryRunId,
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    Sha256,
    UtcTimestamp,
)
from sciretriever.model.record import BibliographicRecord
from sciretriever.model.report import BibliographyFormat, StableFailure

TerminalDiscoveryRunStatus: TypeAlias = Literal[
    "COMPLETED",
    "PARTIAL",
    "FAILED",
    "INTERRUPTED",
]
UserOutputTarget: TypeAlias = str | PathLike[str]


class UserOutputConflictError(RuntimeError):
    """A stable, path-free conflict at a caller-selected output target."""

    _MESSAGE = "user output target conflicts with the requested publication"

    def __init__(self, _message: object | None = None) -> None:
        del _message
        super().__init__(self._MESSAGE)


class WriteAdmissionFailure(RuntimeError):
    """A stable operation-level failure at Entry's core-write boundary."""

    _MESSAGE = "entry write admission failed"

    def __init__(self, failure: StableFailure) -> None:
        if not isinstance(failure, StableFailure):
            raise TypeError("failure must be a StableFailure")
        self.failure = failure
        super().__init__(self._MESSAGE)


def _require_tuple(value: object, *, field_name: str) -> tuple[object, ...]:
    if not isinstance(value, tuple):
        raise TypeError(f"{field_name} must be a tuple")
    return value


def _require_unique_literature_ids(
    value: object,
    *,
    field_name: str,
) -> tuple[object, ...]:
    checked = _require_tuple(value, field_name=field_name)
    if not checked:
        raise ValueError(f"{field_name} must be nonempty")
    if any(not isinstance(item, LiteratureId) for item in checked):
        raise TypeError(f"{field_name} contains an invalid value")
    if len(checked) != len(set(checked)):
        raise ValueError(f"{field_name} must be unique")
    return checked


@dataclass(frozen=True, slots=True)
class DiscoveryRunSnapshot:
    """One complete immutable read of a durable discovery run."""

    run: DiscoveryRun
    source_results: tuple[DiscoverySourceResult, ...]
    results: tuple[DiscoveryResult, ...]
    causes: tuple[DiscoveryCause, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.run, DiscoveryRun):
            raise TypeError("run must be a DiscoveryRun")
        for field_name, values, expected in (
            ("source_results", self.source_results, DiscoverySourceResult),
            ("results", self.results, DiscoveryResult),
        ):
            checked = _require_tuple(values, field_name=field_name)
            if any(not isinstance(item, expected) for item in checked):
                raise TypeError(f"{field_name} contains an invalid value")
        causes = _require_tuple(self.causes, field_name="causes")
        if any(
            not isinstance(item, (TopicDiscoveryCause, CitationDiscoveryCause)) for item in causes
        ):
            raise TypeError("causes contains an invalid value")
        if any(
            getattr(item, "discovery_run_id", None) != self.run.discovery_run_id for item in causes
        ):
            raise ValueError("causes must belong to the snapshot run")
        if any(item.discovery_run_id != self.run.discovery_run_id for item in self.source_results):
            raise ValueError("source results must belong to the snapshot run")
        if any(item.discovery_run_id != self.run.discovery_run_id for item in self.results):
            raise ValueError("discovery results must belong to the snapshot run")


@dataclass(frozen=True, slots=True)
class ExecutionCurrentFacts:
    """Current concrete facts plus Completion's transient input closure.

    Metadata observations remain owned by Metadata/Literature persistence.  The
    tuple here is only the complete, ordered closure captured with this Entry
    read snapshot; it is not a second durable read model and is deliberately
    absent from :class:`CurrentLiteratureFacts`.
    """

    current: CurrentLiteratureFacts
    metadata_observations: tuple[MetadataObservation, ...] = ()
    automatic_pdf_exhaustion: AutomaticPdfAcquisitionExhaustion | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.current, CurrentLiteratureFacts):
            raise TypeError("current must be CurrentLiteratureFacts")
        observations = _require_tuple(
            self.metadata_observations,
            field_name="metadata_observations",
        )
        if any(not isinstance(item, MetadataObservation) for item in observations):
            raise TypeError("metadata_observations contains an invalid value")
        observation_ids = tuple(item.observation_id for item in self.metadata_observations)
        if len(observation_ids) != len(set(observation_ids)):
            raise ValueError("metadata_observations must have unique identities")
        if observation_ids != tuple(sorted(observation_ids, key=lambda item: item.root)):
            raise ValueError("metadata_observations must be ordered by identity")
        exhaustion = self.automatic_pdf_exhaustion
        if exhaustion is not None:
            if not isinstance(exhaustion, AutomaticPdfAcquisitionExhaustion):
                raise TypeError("automatic_pdf_exhaustion has an invalid type")
            if exhaustion.literature_id != self.current.literature.literature_id:
                raise ValueError("automatic PDF exhaustion must identify the current Literature")


@dataclass(frozen=True, slots=True)
class NoUsableContentCleanupCommand:
    """Exact CAS inputs for the only authorized destructive content branch."""

    decision: NoUsableContent
    literature_id: LiteratureId
    meta_literature_id: MetaLiteratureId
    metadata_revision: int
    metadata_sha256: Sha256
    primary_asset: Asset
    primary_relation: LiteratureAsset
    parser_result: ParserResult
    current_content: LiteratureContent | None
    current_content_lineage: CurrentContentLineage | None
    reference_cleanup: ReferenceCleanupDecision | None
    reference_closure_token: ContentReferenceClosureToken | None

    def __post_init__(self) -> None:
        _validate_cleanup_identity(self)
        _validate_cleanup_hashes(self)
        _validate_cleanup_content(self)


def _validate_cleanup_identity(command: NoUsableContentCleanupCommand) -> None:
    if not isinstance(command.decision, NoUsableContent):
        raise TypeError("decision must be NoUsableContent")
    if not isinstance(command.literature_id, LiteratureId):
        raise TypeError("literature_id must be LiteratureId")
    if not isinstance(command.meta_literature_id, MetaLiteratureId):
        raise TypeError("meta_literature_id must be MetaLiteratureId")
    if type(command.metadata_revision) is not int or command.metadata_revision < 1:
        raise ValueError("metadata_revision must be a positive integer")
    if not isinstance(command.primary_asset, Asset):
        raise TypeError("primary_asset must be Asset")
    if not isinstance(command.primary_relation, LiteratureAsset):
        raise TypeError("primary_relation must be LiteratureAsset")
    if not isinstance(command.parser_result, ParserResult):
        raise TypeError("parser_result must be ParserResult")
    if command.current_content is not None and not isinstance(
        command.current_content,
        LiteratureContent,
    ):
        raise TypeError("current_content must be LiteratureContent or None")


def _validate_cleanup_hashes(command: NoUsableContentCleanupCommand) -> None:
    if not isinstance(command.metadata_sha256, Sha256):
        raise TypeError("metadata_sha256 must be Sha256")
    asset = command.primary_asset
    relation = command.primary_relation
    parser_result = command.parser_result
    if (
        relation.literature_id != command.literature_id
        or relation.asset_id != asset.asset_id
        or relation.role is not AssetRole.PRIMARY_PDF
        or asset.media_type != "application/pdf"
    ):
        raise ValueError("cleanup primary Asset/relation binding is invalid")
    if (
        parser_result.source_asset_id != asset.asset_id
        or parser_result.source_sha256 != asset.sha256
    ):
        raise ValueError("cleanup ParserResult must belong to the primary PDF")


def _validate_cleanup_content(command: NoUsableContentCleanupCommand) -> None:
    values = (
        command.current_content,
        command.current_content_lineage,
        command.reference_cleanup,
        command.reference_closure_token,
    )
    if command.current_content is None:
        if any(value is not None for value in values[1:]):
            raise ValueError("content-free cleanup cannot carry content closure values")
        return
    if command.current_content_lineage is None:
        raise ValueError("current content cleanup requires its lineage")
    if command.reference_cleanup is None or command.reference_closure_token is None:
        raise ValueError("current content cleanup requires Literature's Reference closure")
    _validate_cleanup_content_binding(command)
    _validate_cleanup_reference_binding(command)


def _validate_cleanup_content_binding(command: NoUsableContentCleanupCommand) -> None:
    content = command.current_content
    lineage = command.current_content_lineage
    assert content is not None
    assert lineage is not None
    if (
        content.metadata_revision != command.metadata_revision
        or content.metadata_sha256 != command.metadata_sha256
    ):
        raise ValueError("current content must bind the cleanup metadata")
    if lineage.primary_asset_id != command.primary_asset.asset_id:
        raise ValueError("current content lineage must identify the primary Asset")
    if lineage.primary_pdf_sha256 != command.primary_asset.sha256:
        raise ValueError("current content lineage must identify the primary PDF bytes")
    if lineage.parser_result_sha256 != command.parser_result.result_sha256:
        raise ValueError("current content lineage must identify the ParserResult")


def _validate_cleanup_reference_binding(command: NoUsableContentCleanupCommand) -> None:
    content = command.current_content
    cleanup = command.reference_cleanup
    token = command.reference_closure_token
    assert content is not None
    assert cleanup is not None
    assert token is not None
    if cleanup.source_literature_id != command.literature_id:
        raise ValueError("Reference cleanup must identify the cleanup Literature")
    if cleanup.old_content_sha256 != content.literature_content_sha256:
        raise ValueError("Reference cleanup must identify current LiteratureContent")
    if token.source_literature_id != command.literature_id:
        raise ValueError("Reference closure must identify the cleanup Literature")


@dataclass(frozen=True, slots=True)
class NoUsableContentCleanupResult:
    """Successful atomic cleanup of one exact managed current-primary closure."""

    literature_id: LiteratureId
    primary_asset_id: AssetId

    def __post_init__(self) -> None:
        if not isinstance(self.literature_id, LiteratureId):
            raise TypeError("literature_id must be LiteratureId")
        if not isinstance(self.primary_asset_id, AssetId):
            raise TypeError("primary_asset_id must be AssetId")


@runtime_checkable
class NoUsableContentCleanupPort(Protocol):
    """Atomically clean one still-current SciRetriever-managed PDF closure."""

    def cleanup_no_usable_content(
        self,
        command: NoUsableContentCleanupCommand,
    ) -> NoUsableContentCleanupResult: ...


class NoUsableContentCleanupFailure(RuntimeError):
    """A stable all-or-nothing cleanup refusal/failure."""

    _MESSAGE = "no-usable-content cleanup failed"

    def __init__(self, failure: StableFailure) -> None:
        if not isinstance(failure, StableFailure):
            raise TypeError("failure must be StableFailure")
        super().__init__(self._MESSAGE)
        self.failure = failure


@dataclass(frozen=True, slots=True)
class MetaSelectorSnapshot:
    """Ordered MetaLiterature selector scope and its complete current members."""

    meta_literature_ids: tuple[MetaLiteratureId, ...]
    meta_literatures: tuple[MetaLiterature, ...]
    current_facts: tuple[ExecutionCurrentFacts, ...]

    def __post_init__(self) -> None:
        for field_name, values, expected in (
            ("meta_literature_ids", self.meta_literature_ids, MetaLiteratureId),
            ("meta_literatures", self.meta_literatures, MetaLiterature),
            ("current_facts", self.current_facts, ExecutionCurrentFacts),
        ):
            checked = _require_tuple(values, field_name=field_name)
            if any(not isinstance(item, expected) for item in checked):
                raise TypeError(f"{field_name} contains an invalid value")


@dataclass(frozen=True, slots=True)
class LiteratureSelectorSnapshot:
    """Ordered explicit Literature scope and only those concrete current facts."""

    literature_ids: tuple[LiteratureId, ...]
    current_facts: tuple[ExecutionCurrentFacts, ...]

    def __post_init__(self) -> None:
        for field_name, values, expected in (
            ("literature_ids", self.literature_ids, LiteratureId),
            ("current_facts", self.current_facts, ExecutionCurrentFacts),
        ):
            checked = _require_tuple(values, field_name=field_name)
            if any(not isinstance(item, expected) for item in checked):
                raise TypeError(f"{field_name} contains an invalid value")


SelectorSnapshot: TypeAlias = MetaSelectorSnapshot | LiteratureSelectorSnapshot


@dataclass(frozen=True, slots=True)
class CurrentFactsSnapshot:
    """All exact current-facts hits for one concrete Literature reread."""

    literature_id: LiteratureId
    current_facts: tuple[ExecutionCurrentFacts, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.literature_id, LiteratureId):
            raise TypeError("literature_id must be LiteratureId")
        checked = _require_tuple(self.current_facts, field_name="current_facts")
        if any(not isinstance(item, ExecutionCurrentFacts) for item in checked):
            raise TypeError("current_facts contains an invalid value")


@dataclass(frozen=True, slots=True)
class ProviderRelationCandidateReadRequest:
    """One bounded provider-relation scan for explicit concrete seeds."""

    seed_literature_ids: tuple[LiteratureId, ...]
    direction: Literal["references", "cited-by", "both"]
    provider_name: str
    limit: int
    after_observation_id: ObservationId | None = None

    def __post_init__(self) -> None:
        _require_unique_literature_ids(
            self.seed_literature_ids,
            field_name="seed_literature_ids",
        )
        if not isinstance(self.direction, str):
            raise TypeError("direction must be a string")
        if self.direction not in ("references", "cited-by", "both"):
            raise ValueError("direction must be references, cited-by, or both")
        if not isinstance(self.provider_name, str):
            raise TypeError("provider_name must be a string")
        if not self.provider_name.strip():
            raise ValueError("provider_name must be nonblank")
        if type(self.limit) is not int:
            raise TypeError("limit must be an integer")
        if self.limit < 1:
            raise ValueError("limit must be at least one")
        if self.after_observation_id is not None and not isinstance(
            self.after_observation_id,
            ObservationId,
        ):
            raise TypeError("after_observation_id must be an ObservationId or None")


@dataclass(frozen=True, slots=True)
class ProviderRelationSeedFacts:
    """The complete current MetadataObservation ownership for one seed."""

    literature_id: LiteratureId
    metadata_observations: tuple[MetadataObservation, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.literature_id, LiteratureId):
            raise TypeError("literature_id must be a LiteratureId")
        observations = _require_tuple(
            self.metadata_observations,
            field_name="metadata_observations",
        )
        if not observations:
            raise ValueError("metadata_observations must be nonempty")
        if any(not isinstance(item, MetadataObservation) for item in observations):
            raise TypeError("metadata_observations contains an invalid value")
        observation_ids = tuple(item.observation_id for item in self.metadata_observations)
        if len(observation_ids) != len(set(observation_ids)):
            raise ValueError("metadata_observations must have unique identities")


@dataclass(frozen=True, slots=True)
class ProviderRelationCandidateRef:
    """One raw relation endpoint that may identify one or more input seeds."""

    observation_id: ObservationId
    seed_endpoint: Literal["citing", "cited"]
    candidate_seed_literature_ids: tuple[LiteratureId, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.observation_id, ObservationId):
            raise TypeError("observation_id must be an ObservationId")
        if not isinstance(self.seed_endpoint, str):
            raise TypeError("seed_endpoint must be a string")
        if self.seed_endpoint not in ("citing", "cited"):
            raise ValueError("seed_endpoint must be citing or cited")
        _require_unique_literature_ids(
            self.candidate_seed_literature_ids,
            field_name="candidate_seed_literature_ids",
        )


def _require_candidate_seed_order(
    candidates: tuple[ProviderRelationCandidateRef, ...],
    seed_ids: tuple[LiteratureId, ...],
) -> None:
    seed_order = {literature_id: index for index, literature_id in enumerate(seed_ids)}
    for candidate in candidates:
        if any(
            literature_id not in seed_order
            for literature_id in candidate.candidate_seed_literature_ids
        ):
            raise ValueError("candidate seeds must belong to seed_facts")
        candidate_order = tuple(
            seed_order[literature_id] for literature_id in candidate.candidate_seed_literature_ids
        )
        if candidate_order != tuple(sorted(candidate_order)):
            raise ValueError("candidate seeds must follow seed_facts order")


@dataclass(frozen=True, slots=True)
class ProviderRelationCandidatePage:
    """One ordered relation scan page plus the exact seed facts used for it."""

    seed_facts: tuple[ProviderRelationSeedFacts, ...]
    candidates: tuple[ProviderRelationCandidateRef, ...]
    next_after_observation_id: ObservationId | None

    def __post_init__(self) -> None:
        seed_facts = _require_tuple(self.seed_facts, field_name="seed_facts")
        if not seed_facts:
            raise ValueError("seed_facts must be nonempty")
        if any(not isinstance(item, ProviderRelationSeedFacts) for item in seed_facts):
            raise TypeError("seed_facts contains an invalid value")
        seed_ids = tuple(item.literature_id for item in self.seed_facts)
        if len(seed_ids) != len(set(seed_ids)):
            raise ValueError("seed_facts literature identities must be unique")

        candidates = _require_tuple(self.candidates, field_name="candidates")
        if any(not isinstance(item, ProviderRelationCandidateRef) for item in candidates):
            raise TypeError("candidates contains an invalid value")
        _require_candidate_seed_order(self.candidates, seed_ids)
        candidate_order = tuple(
            (
                item.observation_id.root,
                0 if item.seed_endpoint == "citing" else 1,
            )
            for item in self.candidates
        )
        if len(candidate_order) != len(set(candidate_order)):
            raise ValueError("candidates must not repeat a relation endpoint")
        if candidate_order != tuple(sorted(candidate_order)):
            raise ValueError("candidates must be ordered by relation and endpoint")

        cursor = self.next_after_observation_id
        if cursor is not None and not isinstance(cursor, ObservationId):
            raise TypeError("next_after_observation_id must be an ObservationId or None")
        if cursor is not None and any(
            item.observation_id.root > cursor.root for item in self.candidates
        ):
            raise ValueError("candidates cannot follow the scanned page cursor")


@dataclass(frozen=True, slots=True)
class BibliographyRecordFailure:
    """One stabilized codec failure aligned to a zero-based input record."""

    record_index: int
    failure: StableFailure

    def __post_init__(self) -> None:
        if type(self.record_index) is not int or self.record_index < 0:
            raise ValueError("record_index must be a non-negative integer")
        if not isinstance(self.failure, StableFailure):
            raise TypeError("failure must be StableFailure")


DecodedBibliographyItem: TypeAlias = BibliographicRecord | BibliographyRecordFailure


@dataclass(frozen=True, slots=True)
class BibliographyDecodeResult:
    """A complete ordered partition of decoded records and format failures."""

    items: tuple[DecodedBibliographyItem, ...]

    def __post_init__(self) -> None:
        checked = _require_tuple(self.items, field_name="items")
        if any(
            not isinstance(item, (BibliographicRecord, BibliographyRecordFailure))
            for item in checked
        ):
            raise TypeError("items contains an invalid value")
        indexes = tuple(item.record_index for item in self.items)
        if indexes != tuple(range(len(indexes))):
            raise ValueError("decoded items must cover ordered zero-based record indexes")


@dataclass(frozen=True, slots=True)
class BibliographyFieldOmission:
    """One stable field omission aligned to an encoded boundary record."""

    record_index: int
    field: str
    reason: str

    def __post_init__(self) -> None:
        if type(self.record_index) is not int or self.record_index < 0:
            raise ValueError("record_index must be a non-negative integer")
        if not isinstance(self.field, str) or not self.field.strip():
            raise ValueError("field must be nonblank")
        if not isinstance(self.reason, str) or not self.reason.strip():
            raise ValueError("reason must be nonblank")


@dataclass(frozen=True, slots=True)
class BibliographyEncodeResult:
    """Per-record codec outcome after writing one complete staged document."""

    encoded_record_indexes: tuple[int, ...]
    failures: tuple[BibliographyRecordFailure, ...]
    omissions: tuple[BibliographyFieldOmission, ...]

    def __post_init__(self) -> None:
        for field_name, values in (
            ("encoded_record_indexes", self.encoded_record_indexes),
            ("failures", self.failures),
            ("omissions", self.omissions),
        ):
            _require_tuple(values, field_name=field_name)
        if any(type(index) is not int or index < 0 for index in self.encoded_record_indexes):
            raise ValueError("encoded record indexes must be non-negative integers")
        if len(self.encoded_record_indexes) != len(set(self.encoded_record_indexes)):
            raise ValueError("encoded record indexes must be unique")
        if any(not isinstance(item, BibliographyRecordFailure) for item in self.failures):
            raise TypeError("failures contains an invalid value")
        if any(not isinstance(item, BibliographyFieldOmission) for item in self.omissions):
            raise TypeError("omissions contains an invalid value")
        failed_indexes = {item.record_index for item in self.failures}
        if failed_indexes.intersection(self.encoded_record_indexes):
            raise ValueError("encoded and failed record indexes must be disjoint")


@runtime_checkable
class DiscoveryRunRepositoryPort(Protocol):
    """Create a running discovery fact and close it with one terminal state."""

    def create(self, run: DiscoveryRun) -> None: ...

    def finalize(
        self,
        discovery_run_id: DiscoveryRunId,
        status: TerminalDiscoveryRunStatus,
    ) -> DiscoveryRun: ...


@runtime_checkable
class DiscoveryRunReadPort(Protocol):
    """Read one complete discovery snapshot or fail for an unknown identity."""

    def read(self, discovery_run_id: DiscoveryRunId) -> DiscoveryRunSnapshot: ...


@runtime_checkable
class DiscoveryPublicationPort(Protocol):
    """Append durable provider and accepted-discovery facts."""

    def publish_source_result(self, result: DiscoverySourceResult) -> None: ...

    def publish_result_and_cause(
        self,
        result: DiscoveryResult,
        cause: DiscoveryCause,
    ) -> None: ...


@runtime_checkable
class SelectorSnapshotReadPort(Protocol):
    """Expand one typed selector and read its facts in one consistent snapshot."""

    def read_selector(self, selector: BatchSelector) -> SelectorSnapshot: ...


@runtime_checkable
class CurrentFactsSnapshotReadPort(Protocol):
    """Reread exact current facts immediately before one candidate starts."""

    def read_current(self, literature_id: LiteratureId) -> CurrentFactsSnapshot: ...


@runtime_checkable
class ProviderRelationCandidateReadPort(Protocol):
    """Read one bounded page of raw provider-relation seed candidates."""

    def read_provider_relation_candidates(
        self,
        request: ProviderRelationCandidateReadRequest,
    ) -> ProviderRelationCandidatePage: ...


@runtime_checkable
class WriteAdmissionPort(Protocol):
    """Acquire the shared core-write lease without waiting."""

    def acquire_nowait(self) -> AbstractContextManager[None]: ...


@runtime_checkable
class DiscoveryRunRecoveryPort(Protocol):
    """Atomically interrupt every visible running discovery from an earlier process."""

    def interrupt_visible_running(self) -> tuple[DiscoveryRunId, ...]: ...


@runtime_checkable
class ClockPort(Protocol):
    def now(self) -> UtcTimestamp: ...


@runtime_checkable
class BibliographyCodecPort(Protocol):
    """Convert bibliography bytes and existing format-neutral records only."""

    def decode(
        self,
        format: BibliographyFormat,
        source: BinaryIO,
    ) -> BibliographyDecodeResult: ...

    def encode(
        self,
        format: BibliographyFormat,
        records: tuple[BibliographicRecord, ...],
        destination: BinaryIO,
    ) -> BibliographyEncodeResult: ...


@runtime_checkable
class AtomicUserOutputPort(Protocol):
    """Yield a private staged stream and publish it atomically on clean exit."""

    def open_atomic(
        self,
        target: UserOutputTarget,
        *,
        overwrite: bool,
    ) -> AbstractContextManager[BinaryIO]: ...


__all__ = (
    "AtomicUserOutputPort",
    "BibliographyCodecPort",
    "BibliographyDecodeResult",
    "BibliographyEncodeResult",
    "BibliographyFieldOmission",
    "BibliographyRecordFailure",
    "ClockPort",
    "CurrentFactsSnapshot",
    "CurrentFactsSnapshotReadPort",
    "DecodedBibliographyItem",
    "DiscoveryPublicationPort",
    "DiscoveryRunReadPort",
    "DiscoveryRunRepositoryPort",
    "DiscoveryRunSnapshot",
    "ExecutionCurrentFacts",
    "DiscoveryRunRecoveryPort",
    "LiteratureSelectorSnapshot",
    "MetaSelectorSnapshot",
    "NoUsableContentCleanupCommand",
    "NoUsableContentCleanupFailure",
    "NoUsableContentCleanupPort",
    "NoUsableContentCleanupResult",
    "ProviderRelationCandidatePage",
    "ProviderRelationCandidateReadPort",
    "ProviderRelationCandidateReadRequest",
    "ProviderRelationCandidateRef",
    "ProviderRelationSeedFacts",
    "SelectorSnapshot",
    "SelectorSnapshotReadPort",
    "TerminalDiscoveryRunStatus",
    "UserOutputConflictError",
    "UserOutputTarget",
    "WriteAdmissionFailure",
    "WriteAdmissionPort",
)
