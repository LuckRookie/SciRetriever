from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from sciretriever.kernel.errors import BoundaryError
from sciretriever.kernel.ids import CollectionRunId


class CollectionRunStatus(str, Enum):
    CREATED = "created"
    RUNNING = "running"
    NO_TARGET = "no-target"
    COMPLETED = "completed"
    PARTIAL = "partial"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


@dataclass(frozen=True, slots=True)
class CollectionCounts:
    discovered: int
    accepted: int
    new_members: int
    existing_members: int
    missing: int
    source_failures: int

    def __post_init__(self) -> None:
        values = (
            self.discovered, self.accepted, self.new_members,
            self.existing_members, self.missing, self.source_failures,
        )
        if any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in values):
            raise BoundaryError.for_field("collection counts", "must be nonnegative integers")
        if self.accepted != self.new_members + self.existing_members:
            raise BoundaryError.for_field("accepted", "must equal new_members plus existing_members")
        if self.discovered < self.accepted + self.missing:
            raise BoundaryError.for_field("discovered", "must cover accepted and missing results")


@dataclass(frozen=True, slots=True)
class CollectionSourceResult:
    ordinal: int
    source: str
    discovered: int
    accepted: int
    missing: int
    failure_code: str | None = None
    failure_reason: str | None = None
    failure_action: str | None = None
    retryable: bool | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.ordinal, int) or isinstance(self.ordinal, bool) or self.ordinal < 0:
            raise BoundaryError.for_field("source ordinal", "must be a nonnegative integer")
        if not isinstance(self.source, str) or not self.source.strip():
            raise BoundaryError.for_field("source", "must be nonblank text")
        counts = (self.discovered, self.accepted, self.missing)
        if any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in counts):
            raise BoundaryError.for_field("source counts", "must be nonnegative integers")
        if self.discovered != self.accepted + self.missing:
            raise BoundaryError.for_field("source discovered", "must equal accepted plus missing")
        failure = (self.failure_code, self.failure_reason, self.failure_action, self.retryable)
        if any(value is None for value in failure) != all(value is None for value in failure):
            raise BoundaryError.for_field("source failure", "fields must be all present or all absent")
        if self.failure_code is not None:
            text = (self.failure_code, self.failure_reason, self.failure_action)
            if any(not isinstance(value, str) or not value.strip() for value in text):
                raise BoundaryError.for_field("source failure", "text fields must be nonblank")
            if not isinstance(self.retryable, bool):
                raise BoundaryError.for_field("retryable", "must be a boolean")

    @property
    def failed(self) -> bool:
        return self.failure_code is not None


@dataclass(frozen=True, slots=True)
class FinishCollectionRun:
    run_id: CollectionRunId
    status: CollectionRunStatus
    stop_reason: str | None
    counts: CollectionCounts
    source_results: tuple[CollectionSourceResult, ...]

    def __post_init__(self) -> None:
        terminal = frozenset((
            CollectionRunStatus.NO_TARGET, CollectionRunStatus.COMPLETED,
            CollectionRunStatus.PARTIAL, CollectionRunStatus.FAILED,
            CollectionRunStatus.INTERRUPTED,
        ))
        if self.status not in terminal:
            raise BoundaryError.for_field("status", "must be a terminal collection run status")
        requires_reason = self.status in (
            CollectionRunStatus.PARTIAL, CollectionRunStatus.FAILED,
            CollectionRunStatus.INTERRUPTED,
        )
        if requires_reason and (self.stop_reason is None or not self.stop_reason.strip()):
            raise BoundaryError.for_field("stop_reason", "is required for partial, failed, or interrupted")
        if self.stop_reason is not None and not self.stop_reason.strip():
            raise BoundaryError.for_field("stop_reason", "must be nonblank when present")
        expected_ordinals = tuple(range(len(self.source_results)))
        if tuple(item.ordinal for item in self.source_results) != expected_ordinals:
            raise BoundaryError.for_field("source results", "must use contiguous configured order")
        sources = tuple(item.source for item in self.source_results)
        if len(set(sources)) != len(sources):
            raise BoundaryError.for_field("source results", "must contain unique sources")
        if self.counts.discovered != sum(item.discovered for item in self.source_results):
            raise BoundaryError.for_field("discovered", "must equal source discovered total")
        if self.counts.missing != sum(item.missing for item in self.source_results):
            raise BoundaryError.for_field("missing", "must equal source missing total")
        if self.counts.source_failures != sum(item.failed for item in self.source_results):
            raise BoundaryError.for_field("source_failures", "must equal failed source rows")


__all__ = (
    "CollectionCounts", "CollectionRunStatus", "CollectionSourceResult",
    "FinishCollectionRun",
)
