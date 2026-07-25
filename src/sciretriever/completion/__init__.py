"""Typed application contracts for fact-derived literature completion."""
from sciretriever.catalog.completion_facts import CompletionStage
from .actions import CompletionAction, CompletionStop, required_actions
from .batch import BatchItemResult, BatchItemStatus, BatchPolicy, BatchResult
from .operations import ForceAnalysisRequest, ForceAnalysisResult, OptionalAssetKind, OptionalAssetRequest, OptionalAssetResult
from .outcomes import CompletionResult, OutcomeDisposition, OutcomeReason, StageOutcome
from .pipeline import (CompletionInvariantError, CompletionPipeline, CompletionServices,
                       EnsureCompleteResult, MetadataResolutionPolicy, MetadataUnavailableResult)
from .protocols import (AnalysisPromotionRequest, AnalysisPromotionResult, AtomicAnalysisPromotion,
                        CompletionFactInspector, ExactMetadataResolution, OptionalAssetAcquisition,
                         RequiredPrimaryAcquisition, RequiredPrimaryResult,
                         WorkVersionIdentifierLookup)
from .targets import CompletionTarget, DoiTarget, TargetKind, WorkVersionTarget
from .runner import (ForceAnalysisBatchItem, ForceAnalysisBatchResult,
                     run_completion_batch, run_force_analysis_batch)

__all__ = (
    "AnalysisPromotionRequest", "AnalysisPromotionResult", "AtomicAnalysisPromotion",
    "BatchItemResult", "BatchItemStatus", "BatchPolicy", "BatchResult", "CompletionAction",
    "CompletionFactInspector", "CompletionInvariantError", "CompletionPipeline", "CompletionResult", "CompletionServices",
    "CompletionStage", "CompletionStop", "EnsureCompleteResult",
    "CompletionTarget", "DoiTarget", "ExactMetadataResolution", "ForceAnalysisRequest",
    "ForceAnalysisBatchItem", "ForceAnalysisBatchResult", "ForceAnalysisResult",
    "OptionalAssetAcquisition", "OptionalAssetKind", "OptionalAssetRequest",
    "MetadataResolutionPolicy", "MetadataUnavailableResult", "OptionalAssetResult", "OutcomeDisposition", "OutcomeReason", "RequiredPrimaryAcquisition",
    "RequiredPrimaryResult", "StageOutcome", "TargetKind", "WorkVersionTarget", "required_actions",
    "WorkVersionIdentifierLookup", "run_completion_batch", "run_force_analysis_batch",
)
