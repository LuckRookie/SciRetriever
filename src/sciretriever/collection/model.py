from __future__ import annotations

from dataclasses import dataclass

from sciretriever.collection.run_results import (
    CollectionCounts,
    CollectionRunStatus,
    CollectionSourceResult,
    FinishCollectionRun,
)
from sciretriever.kernel.errors import BoundaryError
from sciretriever.kernel.json import canonical_json_bytes, parse_canonical_json
from sciretriever.model.primitives import (
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
)
