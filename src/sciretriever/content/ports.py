from __future__ import annotations

from typing import Protocol

import sciretriever.model.assets as asset_models
import sciretriever.model.llm as llm_models
import sciretriever.model.parsing as parsing_models


class ParserPort(Protocol):
    def parse(self, request: parsing_models.ParserRequest) -> parsing_models.ParserResult: ...


class AnalysisModelPort(Protocol):
    def analyze(self, request: llm_models.LLMRequest) -> llm_models.LLMStructuredResponse: ...


class ArtifactStorePort(Protocol):
    def publish(self, artifact: asset_models.StagedArtifact) -> asset_models.PublishedArtifact: ...


__all__ = (
    "AnalysisModelPort",
    "ArtifactStorePort",
    "ParserPort",
)
