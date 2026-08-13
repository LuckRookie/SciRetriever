"""Public Analysis operations used by Entry.

The façade exposes only the two Analysis business use cases and their stable
failures.  Services, stages, LLM Ports, prompts, providers, and staged bytes
remain private implementation details assembled outside this module.
"""

from __future__ import annotations

import threading
from typing import TypeAlias

from sciretriever.analysis.content import ContentAnalysisFailure
from sciretriever.analysis.ports import ContentAnalysisInput
from sciretriever.analysis.references import (
    ReferenceLookupFailure,
)
from sciretriever.analysis.references import (
    ReferenceLookupStage as _ReferenceLookupStage,
)
from sciretriever.analysis.service import AnalysisService as _AnalysisService
from sciretriever.model.analysis import (
    LiteratureContentProposal as _LiteratureContentProposal,
)
from sciretriever.model.analysis import (
    NoUsableContent as _NoUsableContent,
)
from sciretriever.model.analysis import (
    ReferenceLookup as _ReferenceLookup,
)

ContentAnalysisResult: TypeAlias = _NoUsableContent | _LiteratureContentProposal


class AnalysisApi:
    """Thin public boundary over explicitly assembled Analysis use cases."""

    def __init__(
        self,
        *,
        content_service: object,
        reference_lookup_stage: object,
    ) -> None:
        if not isinstance(content_service, _AnalysisService):
            raise TypeError("content_service must be an AnalysisService")
        if not isinstance(reference_lookup_stage, _ReferenceLookupStage):
            raise TypeError("reference_lookup_stage must be a ReferenceLookupStage")
        self._content_service = content_service
        self._reference_lookup_stage = reference_lookup_stage

    @classmethod
    def for_reference_lookup(cls, reference_lookup_stage: object) -> AnalysisApi:
        """Assemble the real lookup use case without claiming content readiness."""

        if not isinstance(reference_lookup_stage, _ReferenceLookupStage):
            raise TypeError("reference_lookup_stage must be a ReferenceLookupStage")
        instance = object.__new__(cls)
        instance._content_service = None
        instance._reference_lookup_stage = reference_lookup_stage
        return instance

    def analyze_content(
        self,
        analysis_input: ContentAnalysisInput,
        *,
        cancel_event: threading.Event | None = None,
    ) -> ContentAnalysisResult:
        """Return one explicit no-content decision or one complete proposal."""

        content_service = self._content_service
        if content_service is None:
            raise RuntimeError("content analysis is not assembled")
        return content_service.analyze(
            analysis_input,
            cancel_event=cancel_event,
        )

    def extract_reference_lookups(
        self,
        reference_texts: tuple[str, ...],
        *,
        cancel_event: threading.Event | None = None,
    ) -> tuple[_ReferenceLookup, ...]:
        """Return temporary source-aligned lookup hints without persistence."""

        return self._reference_lookup_stage.extract(
            reference_texts,
            cancel_event=cancel_event,
        )


__all__ = (
    "AnalysisApi",
    "ContentAnalysisFailure",
    "ContentAnalysisInput",
    "ContentAnalysisResult",
    "ReferenceLookupFailure",
)
