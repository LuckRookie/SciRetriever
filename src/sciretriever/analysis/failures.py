"""Shared stable failures owned by the Analysis operation boundary."""

from __future__ import annotations

from sciretriever.model.report import StableFailure


def analysis_cancelled_failure() -> StableFailure:
    """Return the one cancellation code recognized by Entry orchestration."""

    return StableFailure(
        code="analysis-content-cancelled",
        reason="The content Analysis operation was cancelled.",
        action="Retry the Literature when content Analysis should resume.",
        retryable=True,
    )


def analysis_internal_failure() -> StableFailure:
    """Return a redacted, non-retryable Analysis implementation failure."""

    return StableFailure(
        code="analysis-internal",
        reason="The Analysis implementation encountered an internal error.",
        action="Review the Debug transcript and Analysis implementation.",
        retryable=False,
    )


def normalize_agent_failure(
    failure: StableFailure,
    *,
    cancellation_is_content_interruption: bool,
) -> StableFailure:
    """Preserve the Agent owner unless the content operation was cancelled."""

    if not isinstance(failure, StableFailure):
        raise TypeError("failure must be a StableFailure")
    if failure.code == "agent-cancelled" and cancellation_is_content_interruption:
        return analysis_cancelled_failure()
    return failure


__all__ = (
    "analysis_cancelled_failure",
    "analysis_internal_failure",
    "normalize_agent_failure",
)
