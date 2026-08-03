from __future__ import annotations

from typing import Protocol

from sciretriever.model import assets as asset_models
from sciretriever.model import execution as execution_models
from sciretriever.model import literature as literature_models
from sciretriever.model import llm as llm_models


class LLMPort(Protocol):
    def analyze(self, request: llm_models.LLMRequest) -> llm_models.LLMStructuredResponse: ...


class AnalysisArtifactStorePort(Protocol):
    def publish(self, artifact: asset_models.StagedArtifact) -> asset_models.PublishedArtifact: ...


class CompletionAcceptancePort(Protocol):
    def publish_completion(
        self,
        submission: literature_models.CompletionSubmission,
        target_projection: execution_models.TargetProjection,
    ) -> literature_models.CompletionOutcome | None: ...


__all__ = (
    "AnalysisArtifactStorePort",
    "CompletionAcceptancePort",
    "LLMPort",
)
