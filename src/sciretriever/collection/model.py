from __future__ import annotations

from dataclasses import dataclass

from sciretriever.collection.run_results import (
    CollectionCounts,
    CollectionRunStatus,
    CollectionSourceResult,
    FinishCollectionRun,
)
from sciretriever.kernel.errors import BoundaryError, FailureEvidence
from sciretriever.kernel.json import canonical_json_bytes, parse_canonical_json
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import (
    CitationDirection,
    CollectionId,
    CollectionRunId,
    Sha256,
    UtcTimestamp,
    WorkId,
    sha256_digest,
)


@dataclass(frozen=True, slots=True)
class ValidatedTopicConditionSet:
    canonical_json: str
    sha256: Sha256

    def __post_init__(self) -> None:
        payload = canonical_json_bytes(parse_canonical_json(self.canonical_json))
        if payload.decode("ascii") != self.canonical_json or sha256_digest(payload) != self.sha256:
            raise BoundaryError.for_field(
                "topic_conditions", "must be canonical JSON with matching hash"
            )


from sciretriever.collection.citation_input import ValidatedCitationInput  # noqa: E402


@dataclass(frozen=True, slots=True)
class CollectionDefinition:
    collection_id: CollectionId
    name: str
    description: str | None
    topic_conditions: ValidatedTopicConditionSet | None
    created_at: UtcTimestamp


@dataclass(frozen=True, slots=True)
class CreateCollectionDefinition:
    definition: CollectionDefinition


@dataclass(frozen=True, slots=True)
class StartCollectionRun:
    run_id: CollectionRunId
    collection_id: CollectionId
    mode: str
    topic_conditions: ValidatedTopicConditionSet | None
    citation_input: ValidatedCitationInput | None
    requested_advance_to: str


@dataclass(frozen=True, slots=True)
class CollectionRunRecord:
    run_id: CollectionRunId
    collection_id: CollectionId
    mode: str
    requested_advance_to: str
    status: CollectionRunStatus
    stop_reason: str | None
    created_at: UtcTimestamp
    counts: CollectionCounts | None
    source_results: tuple[CollectionSourceResult, ...]


@dataclass(frozen=True, slots=True)
class MembershipPageRequest:
    collection_id: CollectionId
    after_work_id: WorkId | None
    limit: int


@dataclass(frozen=True, slots=True)
class CollectionMember:
    work_id: WorkId
    first_collection_run_id: CollectionRunId


@dataclass(frozen=True, slots=True)
class MembershipPage:
    members: tuple[CollectionMember, ...]
    next_after_work_id: WorkId | None


def _text(value: str, field: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise BoundaryError.for_field(field, "must be nonblank text")


@dataclass(frozen=True, slots=True)
class MetadataDiscoveryRequest:
    query: str
    year_from: int | None
    year_to: int | None
    limit: int

    def __post_init__(self) -> None:
        _text(self.query, "query")
        if not isinstance(self.limit, int) or isinstance(self.limit, bool) or self.limit < 1:
            raise BoundaryError.for_field("limit", "must be a positive integer")
        if (
            self.year_from is not None
            and self.year_to is not None
            and self.year_from > self.year_to
        ):
            raise BoundaryError.for_field("year range", "must be ordered")


@dataclass(frozen=True, slots=True)
class MetadataObservation:
    provider: str
    provider_record_id: str
    title: str
    authors: tuple[str, ...]
    publication_year: int | None
    identifiers: tuple[Identifier, ...]
    abstract: str | None

    def __post_init__(self) -> None:
        _text(self.provider, "provider")
        _text(self.provider_record_id, "provider_record_id")
        _text(self.title, "title")


@dataclass(frozen=True, slots=True)
class ProviderDiscoveryResult:
    provider: str
    observations: tuple[MetadataObservation, ...]
    failure: FailureEvidence | None


@dataclass(frozen=True, slots=True)
class CitationDiscoveryRequest:
    seed: WorkId
    direction: CitationDirection
    limit: int


@dataclass(frozen=True, slots=True)
class CitationObservation:
    provider: str
    source_work_id: WorkId
    target_identifier: Identifier
    direction: CitationDirection


@dataclass(frozen=True, slots=True)
class ProviderCitationResult:
    provider: str
    observations: tuple[CitationObservation, ...]
    failure: FailureEvidence | None


__all__ = (
    "CollectionCounts",
    "CollectionDefinition",
    "CollectionMember",
    "CollectionRunRecord",
    "CollectionRunStatus",
    "CollectionSourceResult",
    "CreateCollectionDefinition",
    "FinishCollectionRun",
    "MembershipPage",
    "MembershipPageRequest",
    "StartCollectionRun",
    "ValidatedCitationInput",
    "ValidatedTopicConditionSet",
    "CitationDiscoveryRequest",
    "CitationObservation",
    "MetadataDiscoveryRequest",
    "MetadataObservation",
    "ProviderCitationResult",
    "ProviderDiscoveryResult",
)
