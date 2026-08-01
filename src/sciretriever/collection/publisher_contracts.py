from __future__ import annotations

from dataclasses import dataclass
from enum import Enum, unique

from sciretriever.bibliography.api import PreparedBibliographyAcceptance
from sciretriever.kernel import (
    BoundaryError,
    CanonicalJsonObject,
    CitationDirection,
    CollectionId,
    CollectionRunId,
    MembershipId,
    WorkId,
)
from sciretriever.kernel.ids import UuidValue


class CollectionAcceptanceConflict(Exception):
    pass


@dataclass(frozen=True, slots=True)
class CollectionCauseId(UuidValue):
    pass


@dataclass(frozen=True, slots=True)
class CollectionPathId(UuidValue):
    pass


@unique
class CollectionCauseKind(str, Enum):
    TOPIC_MATCH = "topic-match"
    SEED = "seed"
    REFERENCE = "reference"
    CITED_BY = "cited-by"


@dataclass(frozen=True, slots=True)
class CollectionMembershipFact:
    membership_id: MembershipId
    collection_id: CollectionId
    work_id: WorkId
    first_run_id: CollectionRunId


@dataclass(frozen=True, slots=True)
class CollectionCauseFact:
    cause_id: CollectionCauseId
    membership_id: MembershipId
    run_id: CollectionRunId
    kind: CollectionCauseKind
    evidence: CanonicalJsonObject
    seed_work_id: WorkId | None


@dataclass(frozen=True, slots=True)
class CollectionPathFact:
    path_id: CollectionPathId
    membership_id: MembershipId
    run_id: CollectionRunId
    direction: CitationDirection | None
    depth: int
    work_ids: tuple[WorkId, ...]


@dataclass(frozen=True, slots=True)
class CollectionAcceptance:
    bibliography: PreparedBibliographyAcceptance
    membership: CollectionMembershipFact
    causes: tuple[CollectionCauseFact, ...]
    paths: tuple[CollectionPathFact, ...]

    def __post_init__(self) -> None:
        if self.membership.work_id != self.bibliography.work_id:
            raise BoundaryError.for_field("membership", "must match accepted bibliography Work")
        if any(
            item.membership_id != self.membership.membership_id for item in self.causes + self.paths
        ):
            raise BoundaryError.for_field("evidence", "must match collection membership")
        if any(item.run_id != self.membership.first_run_id for item in self.causes + self.paths):
            raise BoundaryError.for_field("evidence", "must match collection run")


@dataclass(frozen=True, slots=True)
class ExistingCollectionAcceptance:
    membership: CollectionMembershipFact
    causes: tuple[CollectionCauseFact, ...]
    paths: tuple[CollectionPathFact, ...]

    def __post_init__(self) -> None:
        if any(
            item.membership_id != self.membership.membership_id for item in self.causes + self.paths
        ):
            raise BoundaryError.for_field("evidence", "must match collection membership")
        if any(item.run_id != self.membership.first_run_id for item in self.causes + self.paths):
            raise BoundaryError.for_field("evidence", "must match collection run")


__all__ = (
    "CollectionAcceptance",
    "CollectionAcceptanceConflict",
    "CollectionCauseFact",
    "CollectionCauseId",
    "CollectionCauseKind",
    "CollectionMembershipFact",
    "CollectionPathFact",
    "CollectionPathId",
    "ExistingCollectionAcceptance",
)
