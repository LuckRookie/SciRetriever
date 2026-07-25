"""Narrow stage-owner capabilities consumed by completion orchestration."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Protocol
from sciretriever.catalog.completion_facts import CompletionFacts
from sciretriever.core.ids import validate_uuid
from sciretriever.discovery.search_contracts import ExactMetadataOutput, ExactMetadataRequest
from .operations import OptionalAssetRequest, OptionalAssetResult
from .outcomes import OutcomeDisposition, OutcomeReason

class CompletionFactInspector(Protocol):
    def get(self, work_version_id: str) -> CompletionFacts: ...

class ExactMetadataResolution(Protocol):
    def resolve(self, request: ExactMetadataRequest) -> ExactMetadataOutput: ...

class WorkVersionIdentifierLookup(Protocol):
    def doi_for(self, work_version_id: str) -> str | None: ...

@dataclass(frozen=True, slots=True)
class RequiredPrimaryResult:
    work_version_id: str
    disposition: OutcomeDisposition
    reason: OutcomeReason

    def __post_init__(self) -> None:
        validate_uuid(self.work_version_id, "work_version_id")
        match self.disposition:
            case OutcomeDisposition.ADVANCED:
                if self.reason is not OutcomeReason.SUCCEEDED:
                    raise ValueError("advanced primary acquisition requires success")
            case OutcomeDisposition.NOT_ADVANCED:
                if self.reason not in {OutcomeReason.EXHAUSTED, OutcomeReason.ALREADY_SATISFIED}:
                    raise ValueError("primary non-advancement requires an expected reason")

class RequiredPrimaryAcquisition(Protocol):
    async def acquire(self, work_version_id: str) -> RequiredPrimaryResult: ...

@dataclass(frozen=True, slots=True)
class AnalysisPromotionRequest:
    work_version_id: str
    expected_current_analysis_id: str | None = None
    replace_current: bool = False

    def __post_init__(self) -> None:
        validate_uuid(self.work_version_id, "work_version_id")
        if self.expected_current_analysis_id is not None:
            validate_uuid(self.expected_current_analysis_id, "expected_current_analysis_id")
        if self.replace_current != (self.expected_current_analysis_id is not None):
            raise ValueError("replace_current requires an expected current analysis identity")

@dataclass(frozen=True, slots=True)
class AnalysisPromotionResult:
    work_version_id: str
    current_analysis_id: str
    revision: int

    def __post_init__(self) -> None:
        validate_uuid(self.work_version_id, "work_version_id")
        validate_uuid(self.current_analysis_id, "current_analysis_id")
        if type(self.revision) is not int or self.revision < 1:
            raise ValueError("revision must be positive")

class AtomicAnalysisPromotion(Protocol):
    def promote(self, request: AnalysisPromotionRequest) -> AnalysisPromotionResult: ...

class OptionalAssetAcquisition(Protocol):
    async def acquire(self, request: OptionalAssetRequest) -> OptionalAssetResult: ...

__all__ = ("AnalysisPromotionRequest", "AnalysisPromotionResult", "AtomicAnalysisPromotion",
           "CompletionFactInspector", "ExactMetadataResolution", "OptionalAssetAcquisition",
           "RequiredPrimaryAcquisition", "RequiredPrimaryResult", "WorkVersionIdentifierLookup")
