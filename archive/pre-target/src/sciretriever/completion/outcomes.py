"""Redacted completion stage outcomes and aggregate results."""
from __future__ import annotations
from dataclasses import dataclass
from enum import StrEnum
from typing import TypeAlias
from sciretriever.catalog.completion_facts import CompletionStage
from sciretriever.core.ids import validate_uuid
from .actions import CompletionAction, CompletionStop, required_actions
from .targets import CompletionTarget, DoiTarget, WorkVersionTarget

JsonValue: TypeAlias = str | int | bool | None | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]

_STAGE_ORDER = {stage: index for index, stage in enumerate(CompletionStage)}
_ACTION_TRANSITIONS = {
    CompletionAction.RESOLVE_METADATA: (CompletionStage.METADATA_PENDING, CompletionStage.ASSET_PENDING),
    CompletionAction.ACQUIRE_PRIMARY: (CompletionStage.ASSET_PENDING, CompletionStage.ANALYSIS_PENDING),
    CompletionAction.PROMOTE_ANALYSIS: (CompletionStage.ANALYSIS_PENDING, CompletionStage.COMPLETE),
}
_STOP_STAGES = {
    CompletionStop.METADATA: CompletionStage.ASSET_PENDING,
    CompletionStop.ASSET: CompletionStage.ANALYSIS_PENDING,
    CompletionStop.COMPLETE: CompletionStage.COMPLETE,
}

class OutcomeDisposition(StrEnum):
    ADVANCED = "advanced"
    NOT_ADVANCED = "not_advanced"

class OutcomeReason(StrEnum):
    SUCCEEDED = "succeeded"
    EXHAUSTED = "exhausted"
    ALREADY_SATISFIED = "already_satisfied"
    UNEXPECTED_FAILURE = "unexpected_failure"
    INTERRUPTED = "interrupted"

@dataclass(frozen=True, slots=True)
class StageOutcome:
    action: CompletionAction
    disposition: OutcomeDisposition
    reason: OutcomeReason
    before: CompletionStage
    after: CompletionStage

    def __post_init__(self) -> None:
        expected_before, expected_after = _ACTION_TRANSITIONS[self.action]
        if self.before is not expected_before:
            raise ValueError("completion action does not own the input stage")
        match self.disposition:
            case OutcomeDisposition.ADVANCED:
                if self.reason is not OutcomeReason.SUCCEEDED or self.after is not expected_after:
                    raise ValueError("ADVANCED requires the exact successful action transition")
            case OutcomeDisposition.NOT_ADVANCED:
                if self.reason not in {OutcomeReason.EXHAUSTED, OutcomeReason.ALREADY_SATISFIED}:
                    raise ValueError("NOT_ADVANCED requires an expected non-exception reason")
                if self.after is not self.before:
                    raise ValueError("NOT_ADVANCED requires an unchanged stage")

    def to_dict(self) -> JsonObject:
        return {"action": self.action.value, "disposition": self.disposition.value,
                "reason": self.reason.value, "before": self.before.value, "after": self.after.value}

@dataclass(frozen=True, slots=True)
class CompletionResult:
    target: CompletionTarget
    work_version_id: str
    requested_stop: CompletionStop
    initial_stage: CompletionStage
    final_stage: CompletionStage
    outcomes: tuple[StageOutcome, ...]

    def __post_init__(self) -> None:
        validate_uuid(self.work_version_id, "work_version_id")
        match self.target:
            case WorkVersionTarget(work_version_id=target_id):
                if target_id != self.work_version_id:
                    raise ValueError("WorkVersion target and result identity must match")
            case DoiTarget():
                pass
        if _STAGE_ORDER[self.final_stage] < _STAGE_ORDER[self.initial_stage]:
            raise ValueError("completion stage cannot regress")
        expected = self.initial_stage
        for outcome in self.outcomes:
            if outcome.before is not expected:
                raise ValueError("completion outcomes must form a stage chain")
            expected = outcome.after
        if _STAGE_ORDER[expected] > _STAGE_ORDER[self.final_stage]:
            raise ValueError("completion outcomes cannot exceed final_stage")
        required = required_actions(self.initial_stage, self.requested_stop)
        actual = tuple(outcome.action for outcome in self.outcomes)
        if not required:
            if self.outcomes or self.final_stage is not self.initial_stage:
                raise ValueError("already-satisfied completion must be a no-op")
            return
        if not actual or actual != required[:len(actual)]:
            raise ValueError("completion outcomes must be a required action prefix")
        match self.outcomes[-1].disposition:
            case OutcomeDisposition.NOT_ADVANCED:
                return
            case OutcomeDisposition.ADVANCED:
                if actual != required and _STAGE_ORDER[self.final_stage] < _STAGE_ORDER[_STOP_STAGES[self.requested_stop]]:
                    raise ValueError("successful completion must execute the full required prefix")
                if _STAGE_ORDER[self.final_stage] < _STAGE_ORDER[_STOP_STAGES[self.requested_stop]]:
                    raise ValueError("successful completion must reach the requested ceiling")

    def to_dict(self) -> JsonObject:
        return {"target": self.target.to_dict(), "work_version_id": self.work_version_id,
                "requested_stop": self.requested_stop.value, "initial_stage": self.initial_stage.value,
                "final_stage": self.final_stage.value, "outcomes": [item.to_dict() for item in self.outcomes]}

    @property
    def reached_stop(self) -> bool:
        return _STAGE_ORDER[self.final_stage] >= _STAGE_ORDER[_STOP_STAGES[self.requested_stop]]

__all__ = ("CompletionResult", "OutcomeDisposition", "OutcomeReason", "StageOutcome")
