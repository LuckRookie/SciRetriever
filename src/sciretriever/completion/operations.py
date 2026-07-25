"""Contracts for force analysis and optional asset work."""
from __future__ import annotations
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TypeAlias
from sciretriever.catalog.completion_facts import CompletionStage
from sciretriever.core.ids import validate_uuid
from .outcomes import OutcomeDisposition, OutcomeReason
from .targets import WorkVersionTarget

JsonValue: TypeAlias = str | int | bool | None | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]

@dataclass(frozen=True, slots=True)
class ForceAnalysisRequest:
    target: WorkVersionTarget
    expected_revision: int

    def __post_init__(self) -> None:
        if type(self.expected_revision) is not int or self.expected_revision < 1:
            raise ValueError("expected_revision must be positive")

    def to_dict(self) -> JsonObject:
        return {"target": self.target.to_dict(), "expected_revision": self.expected_revision}

@dataclass(frozen=True, slots=True)
class ForceAnalysisResult:
    request: ForceAnalysisRequest
    previous_revision: int
    current_revision: int
    current_analysis_id: str
    stage_before: CompletionStage = field(default=CompletionStage.COMPLETE, init=False)
    stage_after: CompletionStage = field(default=CompletionStage.COMPLETE, init=False)

    def __post_init__(self) -> None:
        validate_uuid(self.current_analysis_id, "current_analysis_id")
        if self.previous_revision != self.request.expected_revision:
            raise ValueError("force result must replace the expected current revision")
        if self.current_revision != self.previous_revision + 1:
            raise ValueError("force analysis must create exactly one replacement revision")

    def to_dict(self) -> JsonObject:
        return {"request": self.request.to_dict(), "previous_revision": self.previous_revision,
                "current_revision": self.current_revision, "current_analysis_id": self.current_analysis_id,
                "stage_before": self.stage_before.value, "stage_after": self.stage_after.value}

class OptionalAssetKind(StrEnum):
    XML = "xml"
    HTML = "html"

@dataclass(frozen=True, slots=True)
class OptionalAssetRequest:
    target: WorkVersionTarget
    kind: OptionalAssetKind

    def to_dict(self) -> JsonObject:
        return {"target": self.target.to_dict(), "kind": self.kind.value}

@dataclass(frozen=True, slots=True)
class OptionalAssetResult:
    request: OptionalAssetRequest
    disposition: OutcomeDisposition
    reason: OutcomeReason
    stage_before: CompletionStage
    stage_after: CompletionStage = field(init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "stage_after", self.stage_before)
        match self.disposition:
            case OutcomeDisposition.ADVANCED:
                if self.reason is not OutcomeReason.SUCCEEDED:
                    raise ValueError("advanced optional acquisition requires success")
            case OutcomeDisposition.NOT_ADVANCED:
                if self.reason not in {OutcomeReason.EXHAUSTED, OutcomeReason.ALREADY_SATISFIED}:
                    raise ValueError("optional exhaustion must use an expected reason")

    def to_dict(self) -> JsonObject:
        return {"request": self.request.to_dict(), "disposition": self.disposition.value,
                "reason": self.reason.value, "stage_before": self.stage_before.value,
                "stage_after": self.stage_after.value}

__all__ = ("ForceAnalysisRequest", "ForceAnalysisResult", "OptionalAssetKind",
           "OptionalAssetRequest", "OptionalAssetResult")
