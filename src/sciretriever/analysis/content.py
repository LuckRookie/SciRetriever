"""Path-free contracts for one complete two-stage content Analysis run.

The values in this module retain only the current input identity and bounded
artifact capabilities needed by :mod:`sciretriever.analysis.service`.  Parser
Markdown and final Markdown bytes stay in private, redacted dataclasses; the
public result is the neutral Model proposal.
"""

from __future__ import annotations

from dataclasses import dataclass

from sciretriever.analysis.failures import analysis_cancelled_failure
from sciretriever.analysis.ports import ContentAnalysisInput
from sciretriever.model.report import StableFailure


@dataclass(frozen=True, slots=True)
class ContentAnalysisLimits:
    """Operation-wide input, chunk, request, and output budgets.

    The current service deliberately supports one complete Parser Markdown
    chunk only.  ``max_chunk_count`` still bounds the declared operation and
    lets the service distinguish a budget overflow from an otherwise bounded
    multi-fragment input for which no accepted merge contract exists yet.
    """

    max_input_bytes: int
    max_chunk_bytes: int
    max_chunk_count: int
    max_total_llm_requests: int
    max_total_output_tokens: int

    def __post_init__(self) -> None:
        for name in (
            "max_input_bytes",
            "max_chunk_bytes",
            "max_chunk_count",
            "max_total_llm_requests",
            "max_total_output_tokens",
        ):
            value = getattr(self, name)
            if type(value) is not int or value < 1:
                raise ValueError(f"{name} must be a positive integer")


class ContentAnalysisFailure(RuntimeError):
    """Stable, redacted failure from the complete content Analysis use case."""

    _MESSAGE = "literature content analysis failed"

    def __init__(self, failure: object) -> None:
        if not isinstance(failure, StableFailure):
            raise TypeError("failure must be StableFailure")
        super().__init__(self._MESSAGE)
        self.failure = failure

    def __repr__(self) -> str:
        return "<ContentAnalysisFailure>"


_FAILURE_MESSAGES: dict[str, tuple[str, str, bool]] = {
    "analysis-content-input": (
        "The content Analysis input is incomplete or inconsistent.",
        "Refresh the current Literature inputs before retrying Analysis.",
        False,
    ),
    "analysis-content-budget": (
        "The complete content Analysis input exceeds an operation budget.",
        "Use a bounded supported input or adjust the configured Analysis budget.",
        False,
    ),
    "analysis-content-chunking-unsupported": (
        "The complete Parser Markdown requires multiple Analysis fragments.",
        "Use a supported complete input until a deterministic fragment merge is configured.",
        False,
    ),
    "analysis-content-artifact-read": (
        "The Parser Markdown artifact could not be read and verified.",
        "Check local artifact integrity and retry Analysis.",
        True,
    ),
    "analysis-content-input-check": (
        "The current content Analysis inputs could not be checked safely.",
        "Refresh the Literature and retry the current-input check.",
        True,
    ),
    "analysis-content-input-stale": (
        "The Literature inputs changed during content Analysis.",
        "Refresh the Literature and analyze its current inputs again.",
        False,
    ),
    "analysis-content-draft": (
        "The content language-model result failed the Markdown contract.",
        "Retry Analysis or review the configured content model.",
        False,
    ),
    "analysis-content-render": (
        "The canonical content Markdown could not be rendered safely.",
        "Correct the validated content contract before retrying Analysis.",
        False,
    ),
    "analysis-content-artifact-publication": (
        "The canonical content Markdown could not be published safely.",
        "Check local artifact integrity and retry Analysis.",
        True,
    ),
    "analysis-content-contract": (
        "An Analysis component violated the complete content contract.",
        "Correct the Analysis composition before retrying.",
        False,
    ),
}


def content_analysis_failure(
    code: str,
    *,
    retryable: bool | None = None,
) -> ContentAnalysisFailure:
    """Create one known stable failure without retaining an underlying error."""

    if code == "analysis-content-cancelled":
        failure = analysis_cancelled_failure()
        if retryable is not None:
            failure = failure.model_copy(update={"retryable": retryable})
        return ContentAnalysisFailure(failure)
    try:
        reason, action, default_retryable = _FAILURE_MESSAGES[code]
    except KeyError:
        raise ValueError("unknown content Analysis failure code") from None
    return ContentAnalysisFailure(
        StableFailure(
            code=code,
            reason=reason,
            action=action,
            retryable=default_retryable if retryable is None else retryable,
        )
    )


__all__ = (
    "ContentAnalysisFailure",
    "ContentAnalysisInput",
    "ContentAnalysisLimits",
    "content_analysis_failure",
)
