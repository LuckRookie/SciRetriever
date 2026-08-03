from __future__ import annotations

from typing import Protocol

import sciretriever.model.llm as llm_models


class AnalysisModelPort(Protocol):
    def analyze(self, request: llm_models.LLMRequest) -> llm_models.LLMStructuredResponse: ...


__all__ = ("AnalysisModelPort",)
