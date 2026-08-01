"""Stable-order batch completion policy and per-target results."""
from __future__ import annotations
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TypeAlias
from sciretriever.catalog.completion_facts import CompletionStage
from sciretriever.core.ids import validate_uuid
from .outcomes import CompletionResult, OutcomeReason
from .counts import InvocationCounts
from .actions import CompletionStop
from .targets import CompletionTarget

JsonValue: TypeAlias = str | int | bool | None | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]

class BatchItemStatus(StrEnum):
    SUCCEEDED = "succeeded"
    EXHAUSTED = "exhausted"
    DUPLICATE = "duplicate"
    FAILED = "failed"
    INTERRUPTED = "interrupted"

@dataclass(frozen=True, slots=True)
class BatchPolicy:
    continue_after_failure: bool = True
    deduplicate_work_versions: bool = True

    def __post_init__(self) -> None:
        if not self.continue_after_failure or not self.deduplicate_work_versions:
            raise ValueError("completion batch policy requires partial failure and deduplication")

@dataclass(frozen=True, slots=True)
class BatchItemResult:
    target: CompletionTarget
    status: BatchItemStatus
    work_version_id: str | None = None
    final_stage: CompletionStage | None = None
    result: CompletionResult | None = None
    reason: OutcomeReason | None = None
    duplicate_of: int | None = None

    @classmethod
    def succeeded(cls, target: CompletionTarget, work_version_id: str,
                  final_stage: CompletionStage, result: CompletionResult | None = None) -> "BatchItemResult":
        return cls(target, BatchItemStatus.SUCCEEDED, work_version_id, final_stage, result)

    @classmethod
    def duplicate(cls, target: CompletionTarget, work_version_id: str,
                  duplicate_of: int) -> "BatchItemResult":
        return cls(target, BatchItemStatus.DUPLICATE, work_version_id,
                   duplicate_of=duplicate_of)

    @classmethod
    def failed(cls, target: CompletionTarget, reason: OutcomeReason,
               work_version_id: str | None = None,
               final_stage: CompletionStage | None = None) -> "BatchItemResult":
        return cls(target, BatchItemStatus.FAILED, work_version_id, final_stage,
                   reason=reason)

    @classmethod
    def exhausted(cls, target: CompletionTarget, work_version_id: str | None = None,
                  final_stage: CompletionStage | None = None,
                  result: CompletionResult | None = None) -> "BatchItemResult":
        return cls(target, BatchItemStatus.EXHAUSTED, work_version_id, final_stage,
                   result, OutcomeReason.EXHAUSTED)

    @classmethod
    def interrupted(cls, target: CompletionTarget) -> "BatchItemResult":
        return cls(target, BatchItemStatus.INTERRUPTED, reason=OutcomeReason.INTERRUPTED)

    def __post_init__(self) -> None:
        if self.work_version_id is not None:
            validate_uuid(self.work_version_id, "work_version_id")
        match self.status:
            case BatchItemStatus.SUCCEEDED:
                if (self.work_version_id is None or self.final_stage is None or self.reason is not None
                        or self.duplicate_of is not None):
                    raise ValueError("successful batch item requires version and final stage")
                if self.result is not None and (
                    self.result.target != self.target
                    or self.result.work_version_id != self.work_version_id
                    or self.result.final_stage is not self.final_stage
                ):
                    raise ValueError("successful batch item must align with its completion result")
            case BatchItemStatus.DUPLICATE:
                if (self.work_version_id is None or self.duplicate_of is None or self.duplicate_of < 0
                        or self.final_stage is not None or self.result is not None
                        or self.reason is not None):
                    raise ValueError("duplicate batch item requires version and prior index")
            case BatchItemStatus.FAILED:
                unresolved = self.work_version_id is None and self.final_stage is None
                resolved = self.work_version_id is not None and self.final_stage is not None
                if (self.reason is not OutcomeReason.UNEXPECTED_FAILURE
                        or self.result is not None or self.duplicate_of is not None
                        or not (unresolved or resolved)):
                    raise ValueError("failed batch item requires aligned optional resolved facts")
            case BatchItemStatus.EXHAUSTED:
                unresolved = (self.work_version_id is None and self.final_stage is None
                              and self.result is None)
                resolved = (self.work_version_id is not None and self.final_stage is not None
                            and self.result is not None and not self.result.reached_stop
                            and self.result.target == self.target
                            and self.result.work_version_id == self.work_version_id
                            and self.result.final_stage is self.final_stage)
                if (self.reason is not OutcomeReason.EXHAUSTED
                        or self.duplicate_of is not None or not (unresolved or resolved)):
                    raise ValueError("exhausted batch item must be unresolved or stop-short")
            case BatchItemStatus.INTERRUPTED:
                if (self.reason is not OutcomeReason.INTERRUPTED or self.work_version_id is not None
                        or self.final_stage is not None or self.result is not None
                        or self.duplicate_of is not None):
                    raise ValueError("interrupted batch item requires interrupted reason")

    def to_dict(self) -> JsonObject:
        return {
            "target": self.target.to_dict(),
            "status": self.status.value,
            "work_version_id": self.work_version_id,
            "final_stage": None if self.final_stage is None else self.final_stage.value,
            "result": None if self.result is None else self.result.to_dict(),
            "reason": None if self.reason is None else self.reason.value,
            "duplicate_of": self.duplicate_of,
        }

@dataclass(frozen=True, slots=True)
class BatchResult:
    policy: BatchPolicy
    items: tuple[BatchItemResult, ...]
    counts: InvocationCounts = field(init=False)

    def __post_init__(self) -> None:
        interrupted = False
        for index, item in enumerate(self.items):
            if interrupted and item.status is not BatchItemStatus.INTERRUPTED:
                raise ValueError("current and unstarted suffix must be interrupted")
            interrupted = interrupted or item.status is BatchItemStatus.INTERRUPTED
            if item.status is BatchItemStatus.DUPLICATE:
                if item.duplicate_of is None or item.duplicate_of >= index:
                    raise ValueError("duplicate must reference an earlier input")
                previous = self.items[item.duplicate_of]
                if previous.work_version_id != item.work_version_id:
                    raise ValueError("duplicate must resolve to the earlier WorkVersion")
        object.__setattr__(self, "counts", InvocationCounts.from_status_values(
            tuple(item.status.value for item in self.items)))

    @property
    def succeeded(self) -> int:
        return self.counts.succeeded

    @property
    def exhausted(self) -> int:
        return self.counts.exhausted

    @property
    def failed(self) -> int:
        return self.counts.failed

    @property
    def duplicates(self) -> int:
        return self.counts.duplicates

    @property
    def interrupted(self) -> int:
        return self.counts.interrupted

    def to_dict(self, stop: CompletionStop | None = None) -> JsonObject:
        return {"items": [item.to_dict() for item in self.items], **self.counts.to_dict(stop)}

__all__ = ("BatchItemResult", "BatchItemStatus", "BatchPolicy", "BatchResult")
