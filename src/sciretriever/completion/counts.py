from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum
from typing import TypeAlias

from sciretriever.catalog.completion_facts import CompletionFacts, CompletionStage
from sciretriever.completion.actions import CompletionStop


JsonCountObject: TypeAlias = dict[str, int]


class ProgressCount(str, Enum):
    PROVIDER_RETURNED = "provider_returned"
    DEDUPLICATED_WORKS = "deduplicated_works"
    CREATED = "created"
    REUSED = "reused"
    SELECTED = "selected"
    UNIQUE_TARGETS = "unique_targets"
    SUCCEEDED = "succeeded"
    EXHAUSTED = "exhausted"
    FAILED = "failed"
    DUPLICATES = "duplicates"
    INTERRUPTED = "interrupted"
    ACCEPTED = "accepted"
    MISSING = "missing"
    ANALYSIS_SUCCEEDED = "analysis_succeeded"
    ANALYSIS_FAILED = "analysis_failed"
    DISCOVERED = "discovered"
    EXISTING = "existing"
    COMPLETED = "completed"


@dataclass(frozen=True, slots=True)
class InvocationCounts:
    selected: int
    unique_targets: int
    succeeded: int
    exhausted: int
    failed: int
    duplicates: int
    interrupted: int

    def __post_init__(self) -> None:
        values = (
            self.selected,
            self.unique_targets,
            self.succeeded,
            self.exhausted,
            self.failed,
            self.duplicates,
            self.interrupted,
        )
        if any(value < 0 for value in values):
            raise ValueError("completion counts cannot be negative")
        terminal = (
            self.succeeded + self.exhausted + self.failed
            + self.duplicates + self.interrupted
        )
        if self.selected != terminal:
            raise ValueError("selected must equal all terminal dispositions")
        if self.unique_targets != self.selected - self.duplicates:
            raise ValueError("unique_targets must equal selected minus duplicates")

    @classmethod
    def from_status_values(cls, statuses: Sequence[str]) -> "InvocationCounts":
        selected = len(statuses)
        duplicates = statuses.count("duplicate")
        return cls(
            selected=selected,
            unique_targets=selected - duplicates,
            succeeded=statuses.count("succeeded"),
            exhausted=statuses.count("exhausted"),
            failed=statuses.count("failed"),
            duplicates=duplicates,
            interrupted=statuses.count("interrupted"),
        )

    @property
    def accepted(self) -> int:
        return self.succeeded

    @property
    def missing(self) -> int:
        return self.exhausted

    @property
    def analysis_succeeded(self) -> int:
        return self.succeeded

    @property
    def analysis_failed(self) -> int:
        return self.exhausted + self.failed

    def to_dict(self, stop: CompletionStop | None = None) -> JsonCountObject:
        values = {
            ProgressCount.SELECTED.value: self.selected,
            ProgressCount.UNIQUE_TARGETS.value: self.unique_targets,
            ProgressCount.SUCCEEDED.value: self.succeeded,
            ProgressCount.EXHAUSTED.value: self.exhausted,
            ProgressCount.FAILED.value: self.failed,
            ProgressCount.DUPLICATES.value: self.duplicates,
            ProgressCount.INTERRUPTED.value: self.interrupted,
        }
        match stop:
            case None:
                values[ProgressCount.ACCEPTED.value] = self.accepted
                values[ProgressCount.MISSING.value] = self.missing
                values[ProgressCount.ANALYSIS_SUCCEEDED.value] = self.analysis_succeeded
                values[ProgressCount.ANALYSIS_FAILED.value] = self.analysis_failed
            case CompletionStop.METADATA:
                pass
            case CompletionStop.ASSET:
                values[ProgressCount.ACCEPTED.value] = self.accepted
                values[ProgressCount.MISSING.value] = self.missing
            case CompletionStop.COMPLETE:
                values[ProgressCount.ANALYSIS_SUCCEEDED.value] = self.analysis_succeeded
                values[ProgressCount.ANALYSIS_FAILED.value] = self.analysis_failed
        return values


@dataclass(frozen=True, slots=True)
class CatalogCounts:
    metadata_pending: int
    asset_pending: int
    analysis_pending: int
    complete: int

    @classmethod
    def from_snapshot(cls, snapshot: Sequence[CompletionFacts]) -> "CatalogCounts":
        stages = tuple(fact.stage for fact in snapshot)
        return cls(
            metadata_pending=stages.count(CompletionStage.METADATA_PENDING),
            asset_pending=stages.count(CompletionStage.ASSET_PENDING),
            analysis_pending=stages.count(CompletionStage.ANALYSIS_PENDING),
            complete=stages.count(CompletionStage.COMPLETE),
        )

    @property
    def total(self) -> int:
        return self.metadata_pending + self.asset_pending + self.analysis_pending + self.complete

    def to_dict(self) -> JsonCountObject:
        return {
            CompletionStage.METADATA_PENDING.value: self.metadata_pending,
            CompletionStage.ASSET_PENDING.value: self.asset_pending,
            CompletionStage.ANALYSIS_PENDING.value: self.analysis_pending,
            CompletionStage.COMPLETE.value: self.complete,
            "total": self.total,
        }


__all__ = ("CatalogCounts", "InvocationCounts", "ProgressCount")
