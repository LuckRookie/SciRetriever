from __future__ import annotations

from dataclasses import dataclass

from sciretriever.collection.publisher_contracts import (
    CollectionCauseFact, CollectionCauseId, CollectionPathFact, CollectionPathId,
)
from sciretriever.kernel import BoundaryError, CollectionId


@dataclass(frozen=True, slots=True)
class CausePageRequest:
    collection_id: CollectionId
    after_cause_id: CollectionCauseId | None
    limit: int

    def __post_init__(self) -> None:
        if not 1 <= self.limit <= 1000:
            raise BoundaryError.for_field("limit", "must be from 1 through 1000")


@dataclass(frozen=True, slots=True)
class CausePage:
    causes: tuple[CollectionCauseFact, ...]
    next_after_cause_id: CollectionCauseId | None


@dataclass(frozen=True, slots=True)
class PathPageRequest:
    collection_id: CollectionId
    after_path_id: CollectionPathId | None
    limit: int

    def __post_init__(self) -> None:
        if not 1 <= self.limit <= 1000:
            raise BoundaryError.for_field("limit", "must be from 1 through 1000")


@dataclass(frozen=True, slots=True)
class PathPage:
    paths: tuple[CollectionPathFact, ...]
    next_after_path_id: CollectionPathId | None


__all__ = ("CausePage", "CausePageRequest", "PathPage", "PathPageRequest")
